#!/usr/bin/env node
// ledger-cli.mjs · Go 后端唯一能碰账本与声明的机器接口。
//
// 为什么要有这一层：状态机判定与账本折叠只允许有 Node 这一份实现。Go 侧用
// os/exec 调这里拿结果，「谁算状态」就永远只有一个答案。因此本文件只做三件事：
// 读参数、调 ledger.mjs / state-validate.mjs、输出 JSON —— 不新增判断，不改写返回值。
import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { appendEvent, fold, nextId, readEvents } from "./ledger.mjs";
import { loadConfig, resolveEntry } from "./state-validate.mjs";

// 声明真源的位置与判定器默认值一致：相对当前工作目录（Go 侧固定为仓库根）。
const CONFIG_PATH = ".agents/platform/state-machine.yml";

const readStdinEvent = () => {
  let raw;
  try {
    raw = readFileSync(0, "utf8");
  } catch (error) {
    throw Object.assign(new Error("读不到 stdin: " + error.message), {
      code: "E_STDIN_UNREADABLE",
    });
  }
  if (!raw.trim()) {
    throw Object.assign(new Error("stdin 为空：需要一个事件对象"), {
      code: "E_STDIN_EMPTY",
    });
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw Object.assign(new Error("stdin 不是合法 JSON: " + error.message), {
      code: "E_EVENT_UNPARSABLE",
    });
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw Object.assign(new Error("stdin 不是事件对象"), {
      code: "E_EVENT_SHAPE",
    });
  }
  return parsed;
};

const COMMANDS = {
  fold: () => fold(readEvents()),
  events: () => readEvents(),
  "next-id": () => ({ id: nextId(readEvents()) }),
  append: () => appendEvent(readStdinEvent()),
  // 入口落点只在声明里：这里只搬 resolveEntry 的结果，不做任何推演。
  entry: () => {
    const picked = resolveEntry(loadConfig(CONFIG_PATH));
    return { to: picked.to, by: picked.by };
  },
  // board.config 的形状只能由 loadConfig 产生：Go 去解析 YAML 就是第二份真源。
  config: () => {
    const cfg = loadConfig(CONFIG_PATH);
    return {
      defaultFlow: cfg.policy?.default_flow ?? null,
      labelPrefix: cfg.label_prefix,
      states: Object.entries(cfg.states).map(([name, meta]) => ({
        name,
        terminal: Boolean(meta?.terminal),
        meaning: meta?.meaning ?? "",
      })),
      transitions: cfg.transitions,
    };
  },
};

function main(argv) {
  const command = argv.find((argument) => !argument.startsWith("--"));
  const handler = COMMANDS[command];
  if (!handler) {
    process.stderr.write(
      "用法: ledger-cli.mjs fold|events|next-id|append|entry|config [--json]\n",
    );
    return 3;
  }
  try {
    // 输出恒为一行 JSON：--json 是给调用方看的显式声明，不改变输出形状。
    process.stdout.write(JSON.stringify(handler()) + "\n");
    return 0;
  } catch (error) {
    const kind = typeof error?.kind === "string" ? error.kind : "infra";
    const code = typeof error?.code === "string" ? error.code : "E_CLI_FAILED";
    const payload = {
      kind,
      code,
      message: error?.message ?? String(error),
      extra: error?.extra ?? {},
    };
    process.stderr.write(JSON.stringify(payload) + "\n");
    return 3;
  }
}

// 入口判定走 realpath（与 audit-slot.mjs 同一条规矩）：worktree / 软链下 argv[1]
// 与 import.meta.url 不是同一条字面路径。判不中不是报错而是静默退出 0 ——
// 调用方看到的是绿，而该做的读写一次都没发生。
const invoked = process.argv[1] ? realpathSync(process.argv[1]) : undefined;
if (invoked === realpathSync(fileURLToPath(import.meta.url))) {
  process.exit(main(process.argv.slice(2)));
}
