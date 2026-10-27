#!/usr/bin/env node
// build-intent.mjs · 把宿主事件归一成状态机意图
//
// 只做映射，不做判定：判定全部交给 state-validate.mjs。
// 认不出的事件返回 null（表示「不该动状态」），不是错误。
//
// PR 事件必须解析出它引用的 issue：PR 号不是 issue 号。
// 解析不出（0 个或 ≥2 个引用）就把事实如实交出去（issue=null + unresolved），
// 由判定器判 INFRA —— 这里不做裁决，也不静默退回用 PR 号。
//
// pull_request.* 事件的 payload 里没有被引用 issue 的标签（那里只有 PR 自己的），
// issue 的当前状态必须由宿主取数后注入（ISSUE_STATE_FILE）。本脚本不联网：
// 它只消费注入的事实，注入缺失就如实报「状态未知」，绝不把缺席读成 none。
//
// 守卫证据同理（GUARD_EVIDENCE_FILE）：merge-gate 的结论只存在于宿主的 check run 上，
// 意图产地没有资格替它作证，所以这里只做透传 —— 不判断证据真假，也不认识任何具体守卫名。

import { appendFileSync, readFileSync } from "node:fs";
import YAML from "yaml";

// 默认流程的唯一真相源是声明（.agents/platform/state-machine.yml 的 policy.default_flow）。
// 环境变量只是覆盖：CI 若没传，就按声明走，不允许在这里再留一份默认值。
const DECLARATION = ".agents/platform/state-machine.yml";

export function defaultFlowFromDeclaration(path = DECLARATION) {
  try {
    const cfg = YAML.parse(readFileSync(path, "utf8"));
    return cfg?.policy?.default_flow ?? null;
  } catch {
    return null;
  }
}

// GitHub 认的 close 类关键字：close/closes/closed、fix/fixes/fixed、resolve/resolves/resolved。
// 只认「关键字 + #N」的显式引用：链接、正文里的裸数字都不猜。
const CLOSE_REF =
  /\b(?:close[sd]?|fix(?:es|ed)?|resolve[sd]?)\b[ \t]*:?[ \t]*#(\d+)\b/gi;

// 返回被引用的 issue 号（去重、保序）：同一个号写两次不算两个引用。
export function resolveIssueRefs(text) {
  const found = new Set();
  for (const m of String(text ?? "").matchAll(CLOSE_REF))
    found.add(Number(m[1]));
  return [...found];
}

// 关单事件能落到哪些终态：`{ "in-progress": ["done"] }`。
// 规则一条都不在这里另写状态名，全部从声明推出来（与 Go 侧 Config.ClosedTerminalTargets 同源）：
// 只认 by === "ci" 的转换 —— 关单是宿主事实驱动的写入，身份就是 ci；owner 裁决出来的终态
// （cancelled、rejected）不在这里自动落：放弃要有人的评论，不能因为「PR 合并顺手关了个单」
// 就替 owner 取消（那会把已合并的 issue 记成取消）；通配（from: "*"）不参与；目标是终态才算数。
// 读不到声明时返回空映射（= 没有可落的终态）：声明缺失是 check-config 的地盘，这里不另造失败面。
export function closedTerminalTargets(path = DECLARATION) {
  let cfg;
  try {
    cfg = YAML.parse(readFileSync(path, "utf8"));
  } catch {
    return {};
  }
  const states = cfg?.states ?? {};
  const transitions = Array.isArray(cfg?.transitions) ? cfg.transitions : [];
  const targets = {};
  for (const t of transitions) {
    const from = t?.from;
    const to = t?.to;
    if (typeof from !== "string" || typeof to !== "string") continue;
    if (from === "*" || from === "none" || t?.by !== "ci") continue;
    if (!states?.[to]?.terminal) continue;
    targets[from] = targets[from] ?? [];
    if (!targets[from].includes(to)) targets[from].push(to);
  }
  return targets;
}

// 宿主的取数结果：`{"labels":["state:accepted"]}`。
// 返回 null 表示「拿不到」（没注入 / 读了不是形状 / 空文件），返回 [] 表示
// 「拿到且确实是零个标签」—— 这两种事实必须分得开：后者是真实的 none 起点，
// 前者只能判 INFRA。
export function readIssueLabels(path) {
  if (!path) return null;
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  if (!String(raw).trim()) return null;
  let labels;
  try {
    labels = JSON.parse(raw)?.labels;
  } catch {
    return null;
  }
  if (!Array.isArray(labels)) return null;
  return labels
    .map((l) => (typeof l === "string" ? l : l?.name))
    .filter((name) => typeof name === "string" && name.length > 0);
}

// 宿主的守卫证据：`{"merge-gate":"check run 890 merge-gate success on <sha>（PR #42 已合并）"}`。
// 返回 null 表示「没有可用证据」：文件不存在 / 空 / 不是 JSON 对象 / 值不是非空字符串。
// 为什么整份丢弃而不是只删坏的那个键：判定器要求每个声明的守卫都有证据，半份证据在它
// 眼里与没有证据等价；而按某个具体守卫名裁剪，等于在脚本里又抄了一份声明。
// 合法对象原样透传：内容真假归判定器，归陈述的那一方，不归归一化这一步。
export function readGuardEvidence(path) {
  if (!path) return null;
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  if (!String(raw).trim()) return null;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    return null;
  const entries = Object.entries(parsed);
  if (entries.length === 0) return null;
  if (entries.some(([, v]) => typeof v !== "string" || !v.trim())) return null;
  return parsed;
}

// body 优先；body 一个都没写才看 title（title 兜底），不把两处结果相加。
function resolvePrIssue(pr) {
  const inBody = resolveIssueRefs(pr.body);
  const refs = inBody.length > 0 ? inBody : resolveIssueRefs(pr.title);
  if (refs.length === 1) return { issue: refs[0], unresolved: null };
  return {
    issue: null,
    unresolved: {
      reason:
        refs.length === 0 ? "no-issue-reference" : "multiple-issue-references",
      candidates: refs,
    },
  };
}

export function buildIntent({
  eventName,
  action,
  payload,
  comment = "",
  actorRole,
  defaultFlow,
  issueLabelsFromHost = null,
  guardEvidence = null,
  closedTargets = {},
}) {
  const issue = payload.issue ?? {};
  const pr = payload.pull_request ?? {};
  // issues.* 事件的 payload 自带被改动 issue 的标签，可以直接用；
  // pull_request.* 事件没有这个字段（payload 里的 pr.labels 是 PR 自己的），
  // 所以 PR 分支一律用宿主注入的 issueLabelsFromHost，不用这里的兜底值。
  const eventLabels = (issue.labels ?? pr.labels ?? []).map((l) =>
    typeof l === "string" ? l : l.name,
  );

  const make = (number, to, role, extra = {}, labels = eventLabels) => ({
    issue: number,
    to,
    actor: payload.sender?.login ?? "unknown",
    actor_role: role,
    labels,
    comment,
    ...extra,
  });

  // issues.* 事件的 payload 自带被改动 issue 的完整标签集，它就是宿主事实；
  // 注入文件（ISSUE_STATE_FILE）只在 PR 事件上取得到 —— 实测 issues.labeled 上
  // 那一步是 skipped，拿文件当唯一依据等于永远拿不到（事件照旧判一次、照旧留痕）。
  // 两个来源都没有（payload 没这个字段且注入缺失）时不做无操作判断：事实缺失
  // 交给判定器判 INFRA，不当成「什么都不用做」。
  const hostLabels = Array.isArray(issue.labels)
    ? eventLabels
    : issueLabelsFromHost;
  const stateLabels = Array.isArray(hostLabels)
    ? hostLabels.filter((name) => String(name).startsWith("state:"))
    : null;

  // default_flow=auto：新需求直接受理，actor 是平台自己；缺省仍是入库分发。
  // 但建单时就带 state 标签的（状态已经是它了），打开事件不该再改一次状态。
  if (eventName === "issues" && action === "opened") {
    if (stateLabels && stateLabels.length > 0) return null;
    return defaultFlow === "auto"
      ? make(issue.number ?? null, "accepted", "platform")
      : make(issue.number ?? null, "triage", "ci");
  }
  if (eventName === "issues" && action === "labeled") {
    const label = payload.label?.name ?? "";
    if (!label.startsWith("state:")) return null;
    // 状态就是标签本身：除这次加上的这个标签以外再没有别的 state 标签，
    // 说明状态已经是它了 —— 这不是一次转换。写者自己打标签会引发一串标签事件，
    // 不在这里拦住，每个事件都会去判定一次并留下一条「没有从 X 到 X 的转换」。
    if (stateLabels && stateLabels.length === 1 && stateLabels[0] === label)
      return null;
    return make(issue.number ?? null, label.slice("state:".length), actorRole);
  }

  // 关单：PR 合并时 GitHub 由 PR body 的 Fixes #N 自动关单，这条路径写者拦不住也测不到，
  // 只能在这里认下来（否则标签会停在 in-progress，而门还当它「能带到 done」）。
  // 目标问声明，不写死状态名：只接受由 ci 驱动、且唯一的终态后继。
  // 关单拿不到守卫证据（守卫证据属于 PR 事件的 check run），所以带守卫的终态在这里一定判不成 ——
  // 那不是漏，是如实交出去，让写者留一条痕（「关单了但状态没动，缺什么」）。
  if (eventName === "issues" && action === "closed") {
    // 拿不到标签、或一个 state 标签都没有：机器没管过这个 issue，不能凭空造一个起点。
    if (!stateLabels || stateLabels.length === 0) return null;
    // 两个 state 标签是形状坏掉了（判定器会判 E_STATE_LABEL_COUNT），但意图得先选一个起点，
    // 选哪个都是替人猜：fail-closed，别把一条错的状态写进留痕。
    if (stateLabels.length > 1)
      throw new Error(
        `意图无法归一：关单事件上 issue 有 ${stateLabels.length} 个 state 标签（${JSON.stringify(stateLabels)}），无法确定起点状态`,
      );
    const from = String(stateLabels[0]).slice("state:".length);
    const candidates = closedTargets[from] ?? [];
    // 这个状态没有「关单即可落到的终态」（例如 triage 只有通向 analyzing 的路）：
    // 关单在这里不代表任何一次转换 —— 留空，交给「放弃要由 owner 带评论裁决」那条路。
    if (candidates.length === 0) return null;
    if (candidates.length > 1)
      throw new Error(
        `意图无法归一：关单事件从 ${from} 出发有多个 ci 终态（${JSON.stringify(candidates)}），无法唯一确定目标`,
      );
    return make(issue.number ?? null, candidates[0], "ci", {}, hostLabels);
  }

  if (eventName === "pull_request") {
    const to =
      action === "opened" || action === "synchronize"
        ? "in-progress"
        : action === "closed" && pr.merged === true
          ? "done"
          : null;
    if (!to) return null; // 关而未合并：不动状态（取消由 owner 裁决）
    const resolved = resolvePrIssue(pr);
    // 守卫证据只属于 PR 事件：它描述的是「这条 PR 的合并被守卫放行」，
    // 一个 issues.* 事件既没有对应的事实，形状也必须与改动前一致（不带 guards 键）。
    const guard = guardEvidence ? { guards: guardEvidence } : {};
    // 解不出 issue：原样交出去，由判定器判 INFRA。
    if (resolved.issue === null)
      return make(null, to, "ci", {
        unresolved: resolved.unresolved,
        ...guard,
      });
    // 解出了 issue 但宿主没交来它的当前状态：这不是 shape 错误，是「事实缺失」。
    // 交出去判 INFRA，绝不退回 payload 里的 PR 标签或 none。
    if (issueLabelsFromHost === null)
      return make(
        resolved.issue,
        to,
        "ci",
        {
          unresolved: {
            reason: "issue-state-unavailable",
            candidates: [resolved.issue],
          },
          ...guard,
        },
        [],
      );
    return make(resolved.issue, to, "ci", guard, issueLabelsFromHost);
  }
  return null;
}

// 角色只从宿主的 author_association 推，不读任何自述身份。
export function roleFromAssociation(association) {
  if (association === "OWNER" || association === "MEMBER") return "owner";
  return "proposer";
}

// 「这次事件有没有意图」只有本脚本知道（它是意图的产地），
// 所以由它自己公布这个事实，别让调用方拿 intent.json 的大小去猜。
// 只写进 Actions 的 $GITHUB_OUTPUT；本地直接跑时该变量不存在，什么也不做。
function publishHasIntent(hasIntent) {
  const path = process.env.GITHUB_OUTPUT;
  if (!path) return;
  appendFileSync(path, `has_intent=${hasIntent ? 1 : 0}\n`);
}

// 「先解析出 issue、再去取它的状态」需要一个只做解析的入口：
// workflow 用它把顺序写成显式的两步（解析 → 取数 → 建意图），
// 而不是在 YAML 里拼一行字符串把顺序藏起来。解析规则仍只有这一份。
// 只打印 issue 号；解不出就什么都不打印（判定仍归 state-validate）。
function resolveOnly() {
  const pr = JSON.parse(process.env.EVENT ?? "{}").pull_request;
  if (!pr) return;
  const resolved = resolvePrIssue(pr);
  if (resolved.issue === null) return;
  process.stdout.write(`${resolved.issue}\n`);
}

function main() {
  if (process.argv.includes("--resolve-issue")) return resolveOnly();

  const eventName = process.env.EVENT_NAME ?? "";
  const payload = JSON.parse(process.env.EVENT ?? "{}");
  const action = payload.action ?? "";
  const association =
    payload.issue?.author_association ??
    payload.pull_request?.author_association ??
    "NONE";
  const comment = process.env.LAST_COMMENT ?? "";

  const intent = buildIntent({
    eventName,
    action,
    payload,
    comment,
    actorRole: roleFromAssociation(association),
    defaultFlow: process.env.DEFAULT_FLOW ?? defaultFlowFromDeclaration(),
    issueLabelsFromHost: readIssueLabels(process.env.ISSUE_STATE_FILE),
    guardEvidence: readGuardEvidence(process.env.GUARD_EVIDENCE_FILE),
    closedTargets: closedTerminalTargets(),
  });
  if (!intent) {
    publishHasIntent(false);
    process.stderr.write(
      `no-state-change ${eventName}.${action} — 该事件不需要改动 issue 状态，跳过判定与留痕\n`,
    );
    process.exit(0);
  }
  publishHasIntent(true);
  if (intent.unresolved)
    process.stderr.write(
      `issue-unresolved ${intent.unresolved.reason} ${JSON.stringify(
        intent.unresolved.candidates,
      )}\n`,
    );
  process.stdout.write(JSON.stringify(intent, null, 2) + "\n");
}

if (import.meta.url === `file://${process.argv[1]}`) main();
