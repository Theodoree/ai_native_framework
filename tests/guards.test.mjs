import { test, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join, resolve } from "node:path";
import {
  consultTransition,
  loadConfig,
  validateIntent,
} from "../scripts/state-validate.mjs";

// 这里验的是「声明了 guards 就必须带证据」这一条 fail-closed 规则：
// 声明的 guard 名一个都不能少、证据不能是空白；形状不对是 INFRA（没判过），不是拒绝。
// 断言全部落在判定器返回值 / 错误码 / 进程退出码上，不靠人眼看输出。

const CONFIG = ".agents/platform/state-machine.yml";
const cfg = loadConfig(CONFIG);

// in-progress → done 是声明里带 guards 的那条转换。
const mergeIntent = (patch = {}) => ({
  issue: 40,
  to: "done",
  actor: "github-actions",
  actor_role: "ci",
  labels: ["state:in-progress"],
  comment: null,
  ...patch,
});

const failure = (fn) => {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error("期望判定失败，实际通过了");
};

const runValidator = (args, input) =>
  spawnSync(process.execPath, ["scripts/state-validate.mjs", ...args], {
    encoding: "utf8",
    input,
  });

// 将来新增的 guard 也必须走同一条规则：用一个临时声明证明判定器不认死 merge-gate。
const tempConfig = (text) => {
  const dir = mkdtempSync(join(tmpdir(), "guards-test-"));
  const path = join(dir, "state-machine.yml");
  writeFileSync(path, text, "utf8");
  return path;
};

const TWO_GUARDS = `version: 1
label_prefix: "state:"
policy: { default_flow: auto }
states:
  in-progress: { terminal: false }
  done: { terminal: true }
  cancelled: { terminal: true }
roles:
  ci: "workflow"
  owner: "owner"
transitions:
  - { from: none, to: in-progress, by: ci }
  - {
      from: in-progress,
      to: done,
      by: ci,
      event: "pull_request.closed(merged)",
      guards: [audit-contract, ledger-parity],
    }
  - { from: "*", to: cancelled, by: owner, comment_required: true }
`;

test("done 缺证据 → reject E_GUARD_MISSING，message 点名 merge-gate", () => {
  const error = failure(() => validateIntent(cfg, mergeIntent()));
  expect(error.kind).toBe("rejected");
  expect(error.code).toBe("E_GUARD_MISSING");
  expect(error.message).toContain("merge-gate");
  expect(error.message).toContain("in-progress → done");
  expect(error.extra.guards).toEqual(["merge-gate"]);
});

test("证据是空串 / 纯空白 → 同样 reject E_GUARD_MISSING", () => {
  for (const blank of ["", "   ", "\t\n"]) {
    const error = failure(() =>
      validateIntent(cfg, mergeIntent({ guards: { "merge-gate": blank } })),
    );
    expect(error.code).toBe("E_GUARD_MISSING");
    expect(error.message).toContain("merge-gate");
  }
});

test("证据齐全 → allowed，返回值里的证据原样（不 trim 改写）", () => {
  const evidence = "merge-gate PASS 4/4 PR #40";
  const result = validateIntent(
    cfg,
    mergeIntent({ guards: { "merge-gate": evidence } }),
  );
  expect(result.to).toBe("done");
  expect(result.by).toBe("ci");
  expect(result.guards).toEqual({ "merge-gate": evidence });
});

test("只给声明之外的 guard 不算证据 → reject（不能靠无关键蒙过去）", () => {
  const error = failure(() =>
    validateIntent(cfg, mergeIntent({ guards: { "other-gate": "PASS" } })),
  );
  expect(error.code).toBe("E_GUARD_MISSING");
  expect(error.message).toContain("merge-gate");
});

test("未声明 guards 的转换（accepted → rejected）行为不变，返回值不带 guards 字段", () => {
  const result = validateIntent(cfg, {
    issue: 7,
    to: "rejected",
    actor: "owner",
    actor_role: "owner",
    labels: ["state:accepted"],
    comment: "不受理",
  });
  expect(result.to).toBe("rejected");
  expect(result.by).toBe("owner");
  expect(Object.hasOwn(result, "guards")).toBe(false);
});

test("未声明 guards 的转换带上无关 guards 也不额外要求、不回显", () => {
  const result = validateIntent(cfg, {
    issue: 7,
    to: "rejected",
    actor: "owner",
    actor_role: "owner",
    labels: ["state:accepted"],
    comment: "不受理",
    guards: { "merge-gate": "随便写的" },
  });
  expect(Object.hasOwn(result, "guards")).toBe(false);
});

test("intent.guards 是数组 → INFRA E_GUARD_SHAPE（形状不对不叫拒绝）", () => {
  const error = failure(() =>
    validateIntent(cfg, mergeIntent({ guards: ["merge-gate PASS"] })),
  );
  expect(error.kind).toBe("infra");
  expect(error.code).toBe("E_GUARD_SHAPE");
});

test("intent.guards 的值不是字符串 → INFRA E_GUARD_SHAPE", () => {
  for (const bad of [1, null, true, { ok: true }, ["PASS"]]) {
    const error = failure(() =>
      validateIntent(cfg, mergeIntent({ guards: { "merge-gate": bad } })),
    );
    expect(error.kind).toBe("infra");
    expect(error.code).toBe("E_GUARD_SHAPE");
  }
});

test("规则不认死名字：新声明的两个 guard 都得给，缺的用「、」并列", () => {
  const custom = loadConfig(tempConfig(TWO_GUARDS));
  const intentFor = (guards) => ({
    issue: 1,
    to: "done",
    actor: "ci",
    actor_role: "ci",
    labels: ["state:in-progress"],
    comment: null,
    ...(guards === undefined ? {} : { guards }),
  });

  const error = failure(() => validateIntent(custom, intentFor()));
  expect(error.code).toBe("E_GUARD_MISSING");
  expect(error.message).toBe(
    "in-progress → done 需要守卫证据：audit-contract、ledger-parity",
  );

  const partial = failure(() =>
    validateIntent(custom, intentFor({ "audit-contract": "PASS" })),
  );
  expect(partial.message).toBe(
    "in-progress → done 需要守卫证据：ledger-parity",
  );

  const ok = validateIntent(
    custom,
    intentFor({ "audit-contract": "PASS", "ledger-parity": "24/24" }),
  );
  expect(ok.guards).toEqual({
    "audit-contract": "PASS",
    "ledger-parity": "24/24",
  });
});

test("CLI：--json 里能看到被接受的守卫证据", () => {
  const evidence = "merge-gate PASS 4/4 PR #40";
  const r = runValidator(
    ["--config", CONFIG, "--intent", "-", "--json"],
    JSON.stringify(mergeIntent({ guards: { "merge-gate": evidence } })),
  );
  expect(r.status).toBe(0);
  const payload = JSON.parse(r.stdout);
  expect(payload.verdict).toBe("allowed");
  expect(payload.guards).toEqual({ "merge-gate": evidence });
});

test("CLI：done 缺证据退出 1，stdout 点名 E_GUARD_MISSING 与 merge-gate", () => {
  const r = runValidator(
    ["--config", CONFIG, "--intent", "-"],
    JSON.stringify(mergeIntent()),
  );
  expect(r.status).toBe(1);
  expect(r.stdout).toContain("E_GUARD_MISSING");
  expect(r.stdout).toContain("merge-gate");
});

test("CLI：guards 形状不对退出 3（INFRA 绝不当通过）", () => {
  const r = runValidator(
    ["--config", CONFIG, "--intent", "-", "--json"],
    JSON.stringify(mergeIntent({ guards: ["merge-gate PASS"] })),
  );
  expect(r.status).toBe(3);
  expect(JSON.parse(r.stdout).code).toBe("E_GUARD_SHAPE");
});

test("CLI：--help 提到 guards", () => {
  const r = spawnSync(process.execPath, ["scripts/state-validate.mjs", "--help"], {
    encoding: "utf8",
  });
  expect(r.status).toBe(0);
  expect(r.stdout).toContain("guards");
});

// ---- 两个入口：写入口严，咨询入口只读 ----------------
// 咨询入口是给「门」用的：门问的是「这条转换被声明了吗」，它自己就是证据的生产者，
// 用写入口问自己会永远问不出绿。但写入口不能因此松掉 —— 所以两条断言写在一起。

test("同一个 intent：咨询入口 allowed、写入口 reject E_GUARD_MISSING", () => {
  const bare = mergeIntent({ comment: "合并 #40" });

  const consult = consultTransition(cfg, bare);
  expect(consult.consult).toBe(true);
  expect(consult.from).toBe("in-progress");
  expect(consult.to).toBe("done");
  // 咨询结论不得带上写路径才需要的东西：不评估 guards，也不报 event。
  expect(Object.hasOwn(consult, "guards")).toBe(false);
  expect(Object.hasOwn(consult, "event")).toBe(false);

  const error = failure(() => validateIntent(cfg, bare));
  expect(error.kind).toBe("rejected");
  expect(error.code).toBe("E_GUARD_MISSING");
});

test("咨询入口不看 guards 的形状，写入口看", () => {
  const bad = mergeIntent({ guards: ["merge-gate"] });
  expect(consultTransition(cfg, bad).to).toBe("done");
  expect(failure(() => validateIntent(cfg, bad)).code).toBe("E_GUARD_SHAPE");
});

// ---- 形状判据：门只能走咨询入口 ----------------
const ROOT = resolve(import.meta.dirname, "..");
const gateSource = readFileSync(join(ROOT, "scripts/merge-gate.mjs"), "utf8");
const WRITE_ENTRY = "validate" + "Intent";
const SKIP_PARAMS = ["require", "skip", "bypass"].map((p) => p + "Guards");

test("门只通过咨询入口问状态，不碰写入口、也没有跳过参数", () => {
  expect(gateSource).toContain(
    'import { consultTransition, loadConfig } from "./state-validate.mjs";',
  );
  expect(gateSource).not.toContain(WRITE_ENTRY);
  // 调用点集合恰好是 {consultTransition}：多出任何第二个入口都要人重新想一遍。
  const calls = [...gateSource.matchAll(/\b(consult[A-Z]\w*|validate[A-Z]\w*)\s*\(/g)].map(
    (m) => m[1],
  );
  expect([...new Set(calls)]).toEqual(["consultTransition"]);
  for (const name of SKIP_PARAMS) expect(gateSource).not.toContain(name);
});

const SKIP_DIRS = new Set(["node_modules", "dist", "coverage", ".cache", ".git"]);
// 「跳过参数」只可能以参数形式出现在可执行载体里；.md 是可引用的历史（决策记录会写
// 「放弃了一个叫某名的开关」），把它算进命中会让笔记没法写清被否掉的方案。
const CODE_EXT = new Set([
  ".mjs",
  ".cjs",
  ".js",
  ".ts",
  ".vue",
  ".go",
  ".yml",
  ".yaml",
  ".json",
]);

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

test("全仓没有「跳过守卫」的参数名：requireGuards / skipGuards / bypassGuards 零命中", () => {
  const self = import.meta.filename;
  const hits = [];
  const scanned = walk(ROOT).filter(
    (file) => file !== self && CODE_EXT.has(extname(file)),
  );
  // 扫到的文件太少说明过滤器本身坏了（ROOT 变了、扩展名列错了），
  // 那会让这条断言在「零命中」的假象下永远绿。
  expect(scanned.length).toBeGreaterThan(50);
  for (const file of scanned) {
    const text = readFileSync(file, "utf8");
    for (const name of SKIP_PARAMS) if (text.includes(name)) hits.push(`${file}: ${name}`);
  }
  expect(hits).toEqual([]);
});

