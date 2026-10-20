#!/usr/bin/env node
// state-validate.mjs · issue 状态转换的机械判定
//
// 单一写者：所有事件先归一成意图对象 {issue, to, actor, actor_role, labels, comment}，
// 交给本脚本判定；合法才允许写 label，非法必须回滚并说明。
//
// 退出码：0 允许 · 1 拒绝 · 3 INFRA（配置或输入不可判定 —— 绝不当通过）

import { readFileSync } from "node:fs";
import YAML from "yaml";

const NONE = "none"; // 「还没有 state 标签」，只作起点

class Fail extends Error {
  constructor(kind, code, message, extra = {}) {
    super(message);
    this.kind = kind;
    this.code = code;
    this.extra = extra;
  }
}
const infra = (code, message, extra) => new Fail("infra", code, message, extra);
const reject = (code, message, extra) =>
  new Fail("rejected", code, message, extra);

export function loadConfig(path) {
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    throw infra("E_CONFIG_MISSING", `读不到状态机配置: ${path}`);
  }
  let cfg;
  try {
    cfg = YAML.parse(raw);
  } catch (error) {
    throw infra(
      "E_CONFIG_UNPARSABLE",
      `状态机配置不是合法 YAML: ${error.message}`,
    );
  }
  if (!cfg || typeof cfg !== "object")
    throw infra("E_CONFIG_EMPTY", "状态机配置为空");
  const { states, transitions, roles, label_prefix: prefix } = cfg;
  if (
    !states ||
    typeof states !== "object" ||
    Object.keys(states).length === 0
  ) {
    throw infra("E_CONFIG_STATES", "配置缺少 states");
  }
  if (NONE in states)
    throw infra("E_CONFIG_STATES", `${NONE} 是保留起点，不能定义成状态`);
  if (!roles || typeof roles !== "object" || Object.keys(roles).length === 0) {
    throw infra("E_CONFIG_ROLES", "配置缺少 roles");
  }
  if (!Array.isArray(transitions))
    throw infra("E_CONFIG_TRANSITIONS", "配置缺少 transitions 数组");
  if (typeof prefix !== "string" || prefix.length === 0) {
    throw infra("E_CONFIG_PREFIX", "配置缺少 label_prefix");
  }
  const defaultFlow = cfg.policy?.default_flow;
  if (defaultFlow !== undefined && typeof defaultFlow !== "string") {
    throw infra("E_CONFIG_POLICY", "policy.default_flow 必须是字符串");
  }
  for (const t of transitions) {
    if (t?.flow !== undefined && typeof t.flow !== "string") {
      throw infra(
        "E_CONFIG_TRANSITION_SHAPE",
        `转换的 flow 必须是字符串: ${JSON.stringify(t)}`,
      );
    }
    for (const key of ["from", "to", "by"]) {
      if (typeof t?.[key] !== "string") {
        throw infra(
          "E_CONFIG_TRANSITION_SHAPE",
          `转换缺少 ${key}: ${JSON.stringify(t)}`,
        );
      }
    }
    if (t.from !== "*" && t.from !== NONE && !(t.from in states)) {
      throw infra("E_CONFIG_UNKNOWN_STATE", `转换引用了未定义状态: ${t.from}`);
    }
    if (!(t.to in states))
      throw infra("E_CONFIG_UNKNOWN_STATE", `转换引用了未定义状态: ${t.to}`);
    if (!(t.by in roles))
      throw infra("E_CONFIG_UNKNOWN_ROLE", `转换引用了未定义角色: ${t.by}`);
    if (t.from !== "*" && t.from !== NONE && states[t.from].terminal) {
      throw infra("E_CONFIG_TERMINAL_SOURCE", `终态不能作为起点: ${t.from}`);
    }
    if (t.from === "*" && !states[t.to].terminal) {
      throw infra("E_CONFIG_WILDCARD_TARGET", `通配转换只能落到终态: ${t.to}`);
    }
  }
  return cfg;
}

// 入口转换同样只在声明里：from=none 的适用转换必须恰好一条。
// 这样「新需求落到哪、由谁触发」改声明即可，代码不用动。
export function resolveEntry(cfg, flow) {
  const effective = flow ?? cfg.policy?.default_flow ?? null;
  const candidates = (cfg.transitions ?? []).filter(
    (t) =>
      t.from === NONE && ((t.flow ?? null) === null || t.flow === effective),
  );
  if (candidates.length !== 1) {
    throw infra(
      "E_ENTRY_AMBIGUOUS",
      `flow=${effective} 下入口转换命中 ${candidates.length} 条，必须恰好一条`,
      { flow: effective, matched: candidates.length },
    );
  }
  return { ...candidates[0], flow: effective };
}

export function validateIntent(cfg, intent) {
  const { states, transitions, roles, label_prefix: prefix } = cfg;
  if (!intent || typeof intent !== "object")
    throw infra("E_INTENT_SHAPE", "意图不是对象");
  if (!Array.isArray(intent.labels))
    throw infra("E_INTENT_SHAPE", "意图缺少 labels 数组");
  if (typeof intent.to !== "string")
    throw infra("E_INTENT_SHAPE", "意图缺少目标状态 to");
  if (!(intent.actor_role in roles)) {
    throw infra(
      "E_INTENT_SHAPE",
      `未知角色: ${intent.actor_role}（合法: ${Object.keys(roles).join(" / ")}）`,
    );
  }

  const stateLabels = intent.labels.filter(
    (l) => typeof l === "string" && l.startsWith(prefix),
  );
  if (stateLabels.length > 1) {
    throw infra(
      "E_STATE_LABEL_COUNT",
      `issue 上最多只能有一个 ${prefix}* 标签，实际 ${stateLabels.length} 个`,
      { labels: stateLabels },
    );
  }
  const from =
    stateLabels.length === 1 ? stateLabels[0].slice(prefix.length) : NONE;
  if (from !== NONE && !(from in states))
    throw infra("E_UNKNOWN_STATE", `当前状态未定义: ${from}`);
  if (!(intent.to in states))
    throw infra("E_UNKNOWN_STATE", `目标状态未定义: ${intent.to}`);
  if (states[from]?.terminal) {
    throw reject("E_TERMINAL_STATE", `终态 ${from} 不能再转换`, {
      from,
      to: intent.to,
    });
  }
  if (intent.actor_role === "agent") {
    throw reject("E_AGENT_CANNOT_WRITE", "agent 只能评论并建议，不能改状态", {
      from,
      to: intent.to,
    });
  }

  // flow 缺省时不猜默认值：只匹配通用转换，flow 专属转换一律不命中。
  const flow = intent.flow ?? cfg.policy?.default_flow ?? null;
  const candidates = transitions.filter(
    (t) => t.to === intent.to && (t.from === from || t.from === "*"),
  );
  const applicable = candidates.filter(
    (t) => (t.flow ?? null) === null || t.flow === flow,
  );
  if (applicable.length > 1) {
    throw infra(
      "E_TRANSITION_AMBIGUOUS",
      `${from} → ${intent.to} 在 flow=${flow} 下命中 ${applicable.length} 条转换，必须恰好一条`,
      { from, to: intent.to, flow, matched: applicable.length },
    );
  }
  const transition = applicable[0];
  if (!transition) {
    throw reject("E_NO_TRANSITION", `没有从 ${from} 到 ${intent.to} 的转换`, {
      from,
      to: intent.to,
      flow,
    });
  }
  if (transition.by !== intent.actor_role) {
    throw reject(
      "E_ROLE_MISMATCH",
      `${from} → ${intent.to} 只能由 ${transition.by} 触发，实际是 ${intent.actor_role}`,
      { from, to: intent.to, required_role: transition.by },
    );
  }
  if (transition.comment_required && !String(intent.comment ?? "").trim()) {
    throw reject(
      "E_COMMENT_REQUIRED",
      `${from} → ${intent.to} 必须带一条说明性评论`,
      {
        from,
        to: intent.to,
      },
    );
  }
  return {
    from,
    to: intent.to,
    by: transition.by,
    flow: transition.flow ?? null,
    event: transition.event ?? null,
  };
}

function main(argv) {
  const flag = (name, fallback) => {
    const at = argv.indexOf(name);
    return at === -1 ? fallback : argv[at + 1];
  };
  const configPath = flag("--config", ".agents/platform/state-machine.yml");
  const checkOnly = argv.includes("--check-config");
  const asJson = argv.includes("--json");

  const emit = (verdict, code, message, extra = {}) => {
    const line = asJson
      ? JSON.stringify({ verdict, code, message, ...extra })
      : `${verdict.toUpperCase()} ${code} ${message}`;
    process.stdout.write(line + "\n");
    process.exit(verdict === "allowed" ? 0 : verdict === "rejected" ? 1 : 3);
  };

  let cfg;
  try {
    cfg = loadConfig(configPath);
  } catch (error) {
    if (error instanceof Fail)
      emit("infra", error.code, error.message, { path: configPath });
    throw error;
  }

  if (checkOnly) {
    emit(
      "allowed",
      "OK_CONFIG",
      `配置自洽: ${Object.keys(cfg.states).length} 个状态 / ${cfg.transitions.length} 条转换`,
    );
  }

  const intentPath = flag("--intent", null);
  let intentRaw;
  try {
    intentRaw = intentPath
      ? readFileSync(intentPath, "utf8")
      : readFileSync(0, "utf8");
  } catch {
    emit(
      "infra",
      "E_INTENT_MISSING",
      "读不到意图输入（--intent <file> 或 stdin）",
    );
  }
  if (!String(intentRaw).trim())
    emit("infra", "E_INTENT_EMPTY", "意图输入为空");

  let intent;
  try {
    intent = JSON.parse(intentRaw);
  } catch (error) {
    emit("infra", "E_INTENT_UNPARSABLE", `意图不是合法 JSON: ${error.message}`);
  }

  try {
    const result = validateIntent(cfg, intent);
    emit(
      "allowed",
      "OK",
      `允许 ${result.from} → ${result.to}（${result.by}）`,
      result,
    );
  } catch (error) {
    if (error instanceof Fail)
      emit(error.kind, error.code, error.message, error.extra);
    throw error;
  }
}

if (import.meta.url === `file://${process.argv[1]}`)
  main(process.argv.slice(2));
