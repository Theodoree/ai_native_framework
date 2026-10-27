// 五个 parity suite 的夹具与运行装置。本文件**不 import vitest**：
// 测试文件（tests/engine-parity*.test.mjs）与冻结脚本（tests/goldens/freeze.mjs）
// 共用同一份夹具定义 —— 夹具只有一处，不会两边漂移。
//
// 测试运行时只执行 Go 引擎；Node 侧只在 freeze.mjs 里执行，
// 用来把当前输出冻结成 tests/goldens/<suite>/<case>.json。

import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { encodeContent } from "../helpers/parity-golden.mjs";

export const repoRoot = process.cwd();
export const CONFIG_REL = ".agents/platform/state-machine.yml";

export const mkdirp = (dir) => mkdirSync(dir, { recursive: true });

export const write = (dir, name, text, mode) => {
  const full = join(dir, name);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, text, mode === undefined ? undefined : { mode });
};

const pad = (n) => String(n).padStart(2, "0");
export const assignIds = (list, prefix) => list.map((one, i) => ({ ...one, id: prefix + "-" + pad(i + 1) }));
export const resolve = (value, ctx) => (typeof value === "function" ? value(ctx) : value);

// ---- 快照：只记「这次运行写出来的东西」（运行前的夹具不算产出） ----
export function snapshotTree(root) {
  const files = new Map();
  const visit = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      const full = join(dir, name);
      const stats = lstatSync(full);
      if (stats.isDirectory()) {
        visit(full);
        continue;
      }
      const rel = full.slice(root.length + 1);
      files.set(rel, stats.isSymbolicLink() ? { text: "<symlink>" } : encodeContent(readFileSync(full)));
    }
  };
  visit(root);
  return files;
}

export function diffTree(before, after) {
  const out = [];
  for (const name of [...after.keys()].sort()) {
    if (JSON.stringify(before.get(name)) === JSON.stringify(after.get(name))) continue;
    out.push({ path: name, ...after.get(name) });
  }
  for (const name of [...before.keys()].sort()) if (!after.has(name)) out.push({ path: name, deleted: true });
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

export const normalizeTree = (entries, normalize) =>
  entries.map((entry) => (entry.text === undefined ? entry : { ...entry, text: normalize(entry.text) }));

const POSITION_SUFFIX = / ?\(line \d+ column \d+\)/g;
export const withoutPosition = (text) => String(text).replace(POSITION_SUFFIX, "");

export function normalizePaths(text, dir, label) {
  let out = String(text === undefined || text === null ? "" : text);
  for (const variant of new Set([dir, realpathSync(dir)])) out = out.split(variant).join(label);
  return out;
}

// =====================================================================
// A · validate / consult / ledger
// =====================================================================

const aIntent = (value) => JSON.stringify(value);

const aCases = [
  {
    title: "拒绝：入口转换不属于生效 flow（none → triage 声明的是 manual）",
    cmd: "validate",
    script: "state-validate.mjs",
    args: ["--json", "--intent", "-"],
    stdin: aIntent({ labels: [], to: "triage", actor_role: "ci" }),
  },
  {
    title: "允许：入口转换落到生效 flow（none → accepted 声明的是 auto）",
    cmd: "validate",
    script: "state-validate.mjs",
    args: ["--json", "--intent", "-"],
    stdin: aIntent({ labels: [], to: "accepted", actor_role: "platform" }),
  },
  {
    title: "拒绝：角色不符（triage → analyzing 只能由 ci 触发）",
    cmd: "validate",
    script: "state-validate.mjs",
    args: ["--json", "--intent", "-"],
    stdin: aIntent({ labels: ["state:triage"], to: "analyzing", actor_role: "owner" }),
  },
  {
    title: "拒绝：agent 不能改状态",
    cmd: "validate",
    script: "state-validate.mjs",
    args: ["--json", "--intent", "-"],
    stdin: aIntent({ labels: ["state:triage"], to: "analyzing", actor_role: "agent" }),
  },
  {
    title: "拒绝：没有对应转换",
    cmd: "validate",
    script: "state-validate.mjs",
    args: ["--json", "--intent", "-"],
    stdin: aIntent({ labels: ["state:triage"], to: "done", actor_role: "owner" }),
  },
  {
    title: "拒绝：终态不能再转换",
    cmd: "validate",
    script: "state-validate.mjs",
    args: ["--json", "--intent", "-"],
    stdin: aIntent({ labels: ["state:done"], to: "accepted", actor_role: "owner" }),
  },
  {
    title: "INFRA：未知目标状态",
    cmd: "validate",
    script: "state-validate.mjs",
    args: ["--json", "--intent", "-"],
    stdin: aIntent({ labels: [], to: "zzz", actor_role: "ci" }),
  },
  {
    title: "INFRA：issue 未归属",
    cmd: "validate",
    script: "state-validate.mjs",
    args: ["--json", "--intent", "-"],
    stdin: aIntent({ labels: [], to: "triage", actor_role: "ci", unresolved: { reason: "没有 issue" } }),
  },
  {
    title: "拒绝：多个 state 标签",
    cmd: "validate",
    script: "state-validate.mjs",
    args: ["--json", "--intent", "-"],
    stdin: aIntent({ labels: ["state:triage", "state:accepted"], to: "analyzing", actor_role: "owner" }),
  },
  {
    title: "文本输出：允许一行（不带 --json）",
    cmd: "validate",
    script: "state-validate.mjs",
    args: ["--intent", "-"],
    stdin: aIntent({ labels: [], to: "triage", actor_role: "ci" }),
  },
  {
    title: "文本输出：拒绝一行（不带 --json）",
    cmd: "validate",
    script: "state-validate.mjs",
    args: ["--intent", "-"],
    stdin: aIntent({ labels: ["state:triage"], to: "analyzing", actor_role: "agent" }),
  },
  {
    title: "意图从文件读",
    cmd: "validate",
    script: "state-validate.mjs",
    args: ["--json", "--intent", "intent.json"],
    files: { "intent.json": aIntent({ labels: [], to: "triage", actor_role: "ci" }) },
  },
  { title: "stdin 为空", cmd: "validate", script: "state-validate.mjs", args: ["--json", "--intent", "-"], stdin: "  \n" },
  {
    title: "意图不是合法 JSON",
    cmd: "validate",
    script: "state-validate.mjs",
    args: ["--json", "--intent", "-"],
    stdin: '{"a":}',
  },
  { title: "意图文件不存在", cmd: "validate", script: "state-validate.mjs", args: ["--json", "--intent", "nope.json"] },
  { title: "意图不是对象", cmd: "validate", script: "state-validate.mjs", args: ["--json", "--intent", "-"], stdin: "[1,2]" },
  { title: "--help 输出用法", cmd: "validate", script: "state-validate.mjs", args: ["--help"] },
  {
    title: "缺守卫证据被拒（in-progress → done）",
    cmd: "validate",
    script: "state-validate.mjs",
    args: ["--json", "--intent", "-"],
    stdin: aIntent({ labels: ["state:in-progress"], to: "done", actor_role: "ci" }),
  },
  {
    title: "守卫证据是空白也算缺",
    cmd: "validate",
    script: "state-validate.mjs",
    args: ["--json", "--intent", "-"],
    stdin: aIntent({ labels: ["state:in-progress"], to: "done", actor_role: "ci", guards: { "merge-gate": "   " } }),
  },
  {
    title: "守卫证据齐全时允许",
    cmd: "validate",
    script: "state-validate.mjs",
    args: ["--json", "--intent", "-"],
    stdin: aIntent({ labels: ["state:in-progress"], to: "done", actor_role: "ci", guards: { "merge-gate": "pr#7 merged" } }),
  },
  {
    title: "guards 形状错（数组）先于意图错",
    cmd: "validate",
    script: "state-validate.mjs",
    args: ["--json", "--intent", "-"],
    stdin: aIntent({ to: "done", actor_role: "ci", guards: [] }),
  },
  {
    title: "guards 形状错（值不是字符串）",
    cmd: "validate",
    script: "state-validate.mjs",
    args: ["--json", "--intent", "-"],
    stdin: aIntent({ labels: [], to: "triage", actor_role: "ci", guards: { "merge-gate": 5 } }),
  },
  {
    // 声明两条守卫时必须按声明顺序点名，分隔符是「、」：只测一条的话，拼接逻辑永远不会被执行。
    title: "缺两条证据时按声明顺序点名",
    cmd: "validate",
    script: "state-validate.mjs",
    args: ["--json", "--intent", "-"],
    files: {
      ".agents/platform/state-machine.yml": [
        "version: 1",
        'label_prefix: "state:"',
        "policy:",
        "  default_flow: auto",
        "states:",
        "  triage: { meaning: 待分诊 }",
        "  done: { terminal: true, meaning: 已完成 }",
        "roles:",
        "  ci: {}",
        "transitions:",
        "  - { from: none, to: triage, by: ci }",
        "  - { from: triage, to: done, by: ci, guards: [merge-gate, audit-contract] }",
        "",
      ].join("\n"),
    },
    stdin: aIntent({ labels: ["state:triage"], to: "done", actor_role: "ci" }),
  },
  { title: "默认声明自洽（--json）", cmd: "validate", script: "state-validate.mjs", args: ["--json", "--check-config"] },
  { title: "默认声明自洽（文本）", cmd: "validate", script: "state-validate.mjs", args: ["--check-config"] },
  {
    title: "声明文件不存在",
    cmd: "validate",
    script: "state-validate.mjs",
    args: ["--json", "--check-config", "--config", "nope.yml"],
  },
  { title: "--config 后面没有值", cmd: "validate", script: "state-validate.mjs", args: ["--json", "--config"] },
  {
    // 唯一不必逐字节一致的地方：YAML 解析器的报错文案来自各自的实现（js-yaml vs yaml.v3）。
    // 契约钉住的是「同一份坏文件同样被拒、同一个错误码、同一段前缀与退出码」。
    title: "非法 YAML（解析器文案不同，只钉服务契约）",
    cmd: "validate",
    script: "state-validate.mjs",
    args: ["--json", "--check-config", "--config", "broken.yml"],
    files: { "broken.yml": "states: [\n" },
    assertMode: "contract",
    contract: { exit: 3, fields: ["verdict", "code", "path"], messagePrefix: "状态机配置不是合法 YAML: " },
  },
  {
    title: "缺 states",
    cmd: "validate",
    script: "state-validate.mjs",
    args: ["--json", "--check-config", "--config", "no-states.yml"],
    files: { "no-states.yml": "roles:\n  ci: {}\n" },
  },
  {
    title: "转换引用未定义角色",
    cmd: "validate",
    script: "state-validate.mjs",
    args: ["--json", "--check-config", "--config", "bad-role.yml"],
    files: {
      "bad-role.yml":
        'label_prefix: "state:"\nstates:\n  a: {}\nroles:\n  ci: {}\ntransitions:\n  - { from: none, to: a, by: ghost }\n',
    },
  },
  {
    title: "允许时给出 consult 结论（flow 取转换自己声明的值）",
    cmd: "consult",
    script: "@consult-probe",
    args: ["--intent", "-"],
    stdin: aIntent({ labels: [], to: "triage", actor_role: "ci" }),
  },
  {
    title: "不看守卫证据（in-progress → done 也能咨询）",
    cmd: "consult",
    script: "@consult-probe",
    args: ["--intent", "-"],
    stdin: aIntent({ labels: ["state:in-progress"], to: "done", actor_role: "ci" }),
  },
  {
    title: "没有对应转换时咨询结论是拒绝",
    cmd: "consult",
    script: "@consult-probe",
    args: ["--intent", "-"],
    stdin: aIntent({ labels: ["state:triage"], to: "done", actor_role: "owner" }),
  },
  {
    title: "agent 只能建议：咨询同样拒绝",
    cmd: "consult",
    script: "@consult-probe",
    args: ["--intent", "-"],
    stdin: aIntent({ labels: ["state:triage"], to: "analyzing", actor_role: "agent" }),
  },
  { title: "events", cmd: "ledger", script: "ledger-cli.mjs", args: ["events", "--json"], ledger: true },
  { title: "fold", cmd: "ledger", script: "ledger-cli.mjs", args: ["fold", "--json"], ledger: true },
  { title: "next-id", cmd: "ledger", script: "ledger-cli.mjs", args: ["next-id", "--json"], ledger: true },
  { title: "entry", cmd: "ledger", script: "ledger-cli.mjs", args: ["entry", "--json"], ledger: true },
  { title: "config", cmd: "ledger", script: "ledger-cli.mjs", args: ["config", "--json"], ledger: true },
  { title: "空账本 fold", cmd: "ledger", script: "ledger-cli.mjs", args: ["fold", "--json"] },
  {
    title: "append 回显与落盘字节",
    cmd: "ledger",
    script: "ledger-cli.mjs",
    args: ["append", "--json"],
    stdin: JSON.stringify({
      id: "REQ-9",
      at: "2024-02-01T00:00:00Z",
      from: "none",
      to: "triage",
      by: "ci",
      flow: "manual",
      comment: "",
    }),
  },
  { title: "append 空 stdin", cmd: "ledger", script: "ledger-cli.mjs", args: ["append", "--json"], stdin: "  \n" },
  { title: "append 不是对象", cmd: "ledger", script: "ledger-cli.mjs", args: ["append", "--json"], stdin: "[1]" },
  {
    // 跨 Node 版本只差坐标后缀（比对前两侧都摘掉），Go 侧一律带坐标，这里单独钉住 Go。
    title: "append 不是合法 JSON",
    cmd: "ledger",
    script: "ledger-cli.mjs",
    args: ["append", "--json"],
    stdin: "{oops",
    goStderrContains: ["at position 1 (line 1 column 2)"],
  },
  {
    title: "坏账本拒绝继续",
    cmd: "ledger",
    script: "ledger-cli.mjs",
    args: ["fold", "--json"],
    files: { "ledger.jsonl": '{"id":"REQ-1"}\nnot-json\n' },
  },
  { title: "未知子命令打印用法", cmd: "ledger", script: "ledger-cli.mjs", args: ["nope"] },
];

const aLedgerText = [
  JSON.stringify({
    id: "REQ-1",
    at: "2024-01-01T00:00:00Z",
    title: "甲",
    body: "",
    from: "none",
    to: "triage",
    by: "ci",
    flow: "manual",
    comment: "",
  }),
  JSON.stringify({ id: "REQ-1", at: "2024-01-02T00:00:00Z", from: "triage", to: "analyzing", by: "owner", flow: null, comment: "看" }),
  JSON.stringify({ id: "REQ-2", at: "2024-01-03T00:00:00Z", from: "none", to: "triage", by: "ci", flow: "manual", comment: "" }),
].join("\n") + "\n";

export const suiteA = {
  id: "a",
  title: "engine parity · validate / consult / ledger（对照冻结 golden）",
  cases: assignIds(aCases, "a"),
  async createContext() {
    const workDir = mkdtempSync(join(tmpdir(), "engine-parity-a-"));
    return { workDir };
  },
  async disposeContext(ctx) {
    rmSync(ctx.workDir, { recursive: true, force: true });
  },
  async run(ctx, fixture, invoke) {
    const dir = mkdtempSync(join(ctx.workDir, "case-"));
    mkdirSync(join(dir, ".agents/platform"), { recursive: true });
    copyFileSync(join(repoRoot, CONFIG_REL), join(dir, CONFIG_REL));
    const files = { ...(fixture.ledger ? { "ledger.jsonl": aLedgerText } : {}), ...(fixture.files ?? {}) };
    for (const [name, text] of Object.entries(files)) write(dir, name, text);
    const env = { ...process.env, PLATFORM_LEDGER: join(dir, "ledger.jsonl") };
    const args = fixture.args ?? [];
    const before = snapshotTree(dir);
    const result = spawnSync(invoke.bin, [...invoke.prefix, ...args], {
      cwd: dir,
      env,
      input: fixture.stdin,
    });
    // stack trace 里会带仓库绝对路径：按 repoRoot 归一，golden 才跟 checkout 位置无关。
    const normalize = (text) =>
      withoutPosition(normalizePaths(String(text ?? ""), dir, "<ROOT>"))
        .split(repoRoot)
        .join("<REPO>")
        // 写临时文件失败时 Node 把随机后缀带进文案（.tmp-93329）：golden 里换成占位符。
        .replace(/\.tmp-\d+/g, ".tmp-<N>");
    return {
      exitCode: result.status,
      stdout: normalize(result.stdout.toString()),
      stderr: normalize(result.stderr.toString()),
      // 归一前的 stderr：个别断言（见 goStderrContains）钉的正是被摘掉的坐标后缀。
      rawStderr: String(result.stderr ?? ""),
      files: normalizeTree(diffTree(before, snapshotTree(dir)), normalize),
      requests: [],
      argv: [fixture.cmd, ...args].map((one) => String(one).split(dir).join("<ROOT>")),
      env: { PLATFORM_LEDGER: "<ROOT>/ledger.jsonl" },
    };
  },
  extras: [
    {
      title: "夹具数量足够覆盖 validate / consult / ledger 三条入口",
      run(suite) {
        if (suite.cases.length < 40) throw new Error("夹具少于 40 条：" + suite.cases.length);
      },
    },
  ],
};// =====================================================================
// B · build-intent / last-change / writer-record
// =====================================================================

const issueOpened = JSON.stringify({
  action: "opened",
  issue: { number: 7, labels: [{ name: "bug" }], author_association: "OWNER" },
  sender: { login: "alice" },
});
const issueOpenedStateLabel = JSON.stringify({
  action: "opened",
  issue: { number: 7, labels: ["state:triage"], author_association: "CONTRIBUTOR" },
  sender: { login: "alice" },
});
const issueLabeled = JSON.stringify({
  action: "labeled",
  issue: { number: 7, labels: ["state:triage", "state:accepted"], author_association: "MEMBER" },
  label: { name: "state:done" },
  sender: { login: "bob" },
});
const issueLabeledSame = JSON.stringify({
  action: "labeled",
  issue: { number: 7, labels: ["state:done"] },
  label: { name: "state:done" },
  sender: { login: "bob" },
});
const issueLabeledOther = JSON.stringify({
  action: "labeled",
  issue: { number: 7, labels: ["bug"] },
  label: { name: "needs-design" },
  sender: { login: "bob" },
});
const issueClosed = JSON.stringify({ action: "closed", issue: { number: 7, labels: [] }, sender: { login: "alice" } });
// §九：PR 合并时 GitHub 由 Fixes #N 自动关单，写者拦不住 —— 意图层必须认 issues.closed。
const issueClosedInProgress = JSON.stringify({
  action: "closed",
  issue: { number: 7, labels: ["state:in-progress"], author_association: "OWNER" },
  sender: { login: "alice" },
});
const issueClosedDone = JSON.stringify({
  action: "closed",
  issue: { number: 7, labels: [{ name: "state:done" }] },
  sender: { login: "alice" },
});
const issueClosedAccepted = JSON.stringify({
  action: "closed",
  issue: { number: 7, labels: ["state:accepted"] },
  sender: { login: "alice" },
});
const issueClosedTwoStateLabels = JSON.stringify({
  action: "closed",
  issue: { number: 7, labels: ["state:in-progress", "state:blocked"] },
  sender: { login: "alice" },
});
const prOpened = JSON.stringify({
  action: "opened",
  pull_request: { number: 3, body: "Fixes #12", labels: [{ name: "state:triage" }], author_association: "OWNER" },
  sender: { login: "ci" },
});
const prOpenedMulti = JSON.stringify({
  action: "opened",
  pull_request: { number: 3, body: "closes #12 and fixes #13", title: "resolves #14" },
  sender: { login: "ci" },
});
const prOpenedNoRef = JSON.stringify({
  action: "synchronize",
  pull_request: { number: 3, body: "no reference here" },
  sender: { login: "ci" },
});
const prClosedMerged = JSON.stringify({
  action: "closed",
  pull_request: {
    number: 3,
    body: "Fixes #12",
    labels: [{ name: "state:in-progress" }],
    merged: true,
    author_association: "OWNER",
  },
  sender: { login: "ci" },
});
const prClosedUnmerged = JSON.stringify({
  action: "closed",
  pull_request: { number: 3, body: "Fixes #12", merged: false },
  sender: { login: "ci" },
});

const lcMerged = JSON.stringify({
  pull_request: {
    number: 9,
    title: "加个门牌",
    body: "Fixes #4",
    user: { login: "alice" },
    requested_reviewers: [{ login: "bob" }, "carol"],
    merged: true,
    merged_by: { login: "dan" },
    merged_at: "2024-05-06T07:08:09Z",
  },
});
const lcOpen = JSON.stringify({
  pull_request: {
    number: 9,
    title: "加个门牌",
    body: "Fixes #4",
    user: { login: "alice" },
    requested_reviewers: [],
    merged: false,
  },
});
const lcTitleOnly = JSON.stringify({
  pull_request: { number: 9, title: "Fixes #21 加个门牌", body: "", user: { login: "alice" }, merged: false },
});
const lcMultiRef = JSON.stringify({
  pull_request: { number: 9, title: "x", body: "Fixes #4 and closes #5", user: { login: "alice" }, merged: false },
});
const lcNoRef = JSON.stringify({
  pull_request: { number: 9, title: "x", body: "no refs", user: { login: "alice" }, merged: false },
});
const lcHalfMerge = JSON.stringify({
  pull_request: {
    number: 9,
    title: "x",
    body: "Fixes #4",
    user: { login: "alice" },
    merged: true,
    merged_by: { login: "dan" },
  },
});
const lcBadDate = JSON.stringify({
  pull_request: {
    number: 9,
    title: "x",
    body: "Fixes #4",
    user: { login: "alice" },
    merged: true,
    merged_by: { login: "dan" },
    merged_at: "昨天下午",
  },
});

const existingBlock =
  "前言\n\n## LAST-CHANGE\n\n<!-- 由 CI 重算，请勿手改 -->\n\n" +
  "<!-- LAST-CHANGE:BEGIN -->\n旧表\n<!-- LAST-CHANGE:END -->\n\n## 其它\n尾\n";
const headingOnly = "前言\n\n## LAST-CHANGE\n手写内容\n\n## 其它\n尾\n";
const plainText = "没有任何小节\n";

const ghOk = "#!/bin/sh\nprintf \"gh-args: %s\\n\" \"$*\"\nexit 0\n";
const ghFail = "#!/bin/sh\necho \"gh said no\" >&2\nexit 3\n";

// 模板仓库的 commit 时间固定：否则每次 freeze 出来的 sha 都不同，golden 没法带真 sha。
const GIT_ENV = {
  PATH: process.env.PATH ?? "/usr/bin:/bin",
  HOME: process.env.HOME ?? "/tmp",
  GIT_AUTHOR_DATE: "2024-01-01T00:00:00 +0000",
  GIT_COMMITTER_DATE: "2024-01-01T00:00:00 +0000",
};

// 本 suite 的模板仓库与 case 序号，createContext 里定下来（夹具里的函数读它）。
const B = { workDir: null, templateRepo: null, base: null, head: null, seq: 0 };

function bGit(args, cwd) {
  const result = spawnSync("git", args, { cwd, env: GIT_ENV, encoding: "utf8" });
  if (result.status !== 0) throw new Error("git " + args.join(" ") + " 失败: " + (result.stderr ?? ""));
  return result.stdout.trim();
}

function bSandbox(files) {
  const dir = join(B.workDir, "case-" + ++B.seq);
  mkdirSync(dir, { recursive: true });
  mkdirSync(join(dir, ".agents/platform"), { recursive: true });
  copyFileSync(join(repoRoot, CONFIG_REL), join(dir, CONFIG_REL));
  for (const [name, content] of Object.entries(files ?? {})) write(dir, name, content);
  return dir;
}

function bTemplateRepo() {
  const dir = join(B.workDir, "template-repo");
  mkdirSync(dir, { recursive: true });
  bGit(["init", "-q", "-b", "main", "."], dir);
  bGit(["config", "user.email", "ci@example.com"], dir);
  bGit(["config", "user.name", "CI"], dir);
  write(dir, "a.md", "a\n");
  write(dir, "docs/b.md", "b\n");
  write(dir, "旧名.md", "old\n");
  bGit(["add", "-A"], dir);
  bGit(["commit", "-qm", "one"], dir);
  B.base = bGit(["rev-parse", "HEAD"], dir);
  write(dir, "a.md", "a2\n");
  write(dir, "c.md", "c\n");
  write(dir, "中文 文件.md", "zh\n");
  rmSync(join(dir, "docs/b.md"));
  bGit(["mv", "旧名.md", "新名.md"], dir);
  bGit(["add", "-A"], dir);
  bGit(["commit", "-qm", "two"], dir);
  B.head = bGit(["rev-parse", "HEAD"], dir);
  return dir;
}

const bRepoCopy = () => {
  const dir = join(B.workDir, "repo-" + ++B.seq);
  cpSync(B.templateRepo, dir, { recursive: true });
  return dir;
};

const bEnv = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME ?? "/tmp" };
const lastChangeEnv = (event) => ({ ...bEnv, EVENT_NAME: "pull_request", EVENT: event, BASE: B.base, HEAD: B.head });

const bCases = [
  // ---------- build-intent ----------
  {
    title: "build-intent · issues.opened 未给 DEFAULT_FLOW → 走声明里的 auto",
    cmd: "build-intent",
    script: "build-intent.mjs",
    env: { EVENT_NAME: "issues", EVENT: issueOpened },
    githubOutput: true,
    stdoutContains: ["\"to\": \"accepted\"", "\"actor_role\": \"platform\""],
  },
  {
    title: "build-intent · issues.opened + DEFAULT_FLOW=triage 强行压回 triage",
    cmd: "build-intent",
    script: "build-intent.mjs",
    env: { EVENT_NAME: "issues", EVENT: issueOpened, DEFAULT_FLOW: "triage" },
    githubOutput: true,
    stdoutContains: ["\"to\": \"triage\"", "\"actor_role\": \"ci\"", "\"actor\": \"alice\""],
  },
  {
    title: "build-intent · issues.opened + DEFAULT_FLOW=auto 直接 accepted",
    cmd: "build-intent",
    script: "build-intent.mjs",
    env: { EVENT_NAME: "issues", EVENT: issueOpened, DEFAULT_FLOW: "auto", LAST_COMMENT: "同意" },
    githubOutput: true,
    stdoutContains: ["\"to\": \"accepted\"", "\"actor_role\": \"platform\"", "\"comment\": \"同意\""],
  },
  {
    title: "build-intent · issues.opened 已带 state 标签 → 无意图",
    cmd: "build-intent",
    script: "build-intent.mjs",
    env: { EVENT_NAME: "issues", EVENT: issueOpenedStateLabel },
    githubOutput: true,
    expectFiles: { "gh.txt": "has_intent=0\n" },
  },
  {
    title: "build-intent · issues.labeled state:done",
    cmd: "build-intent",
    script: "build-intent.mjs",
    env: { EVENT_NAME: "issues", EVENT: issueLabeled },
    githubOutput: true,
  },
  {
    title: "build-intent · issues.labeled 本次加的就是唯一 state 标签 → 无意图",
    cmd: "build-intent",
    script: "build-intent.mjs",
    env: { EVENT_NAME: "issues", EVENT: issueLabeledSame },
    githubOutput: true,
  },
  {
    title: "build-intent · issues.labeled 非 state 标签 → 无意图",
    cmd: "build-intent",
    script: "build-intent.mjs",
    env: { EVENT_NAME: "issues", EVENT: issueLabeledOther },
    githubOutput: true,
  },
  {
    title: "build-intent · issues.closed → 无意图",
    cmd: "build-intent",
    script: "build-intent.mjs",
    env: { EVENT_NAME: "issues", EVENT: issueClosed },
    githubOutput: true,
  },
  {
    title: "build-intent · issues.closed + state:in-progress → 目标 done（ci），缺守卫证据交给判定器",
    cmd: "build-intent",
    script: "build-intent.mjs",
    env: { EVENT_NAME: "issues", EVENT: issueClosedInProgress },
    githubOutput: true,
    stdoutContains: ["\"to\": \"done\"", "\"actor_role\": \"ci\"", "\"labels\": [\n    \"state:in-progress\"\n  ]"],
  },
  {
    title: "build-intent · issues.closed 已在终态 state:done → 无意图",
    cmd: "build-intent",
    script: "build-intent.mjs",
    env: { EVENT_NAME: "issues", EVENT: issueClosedDone },
    githubOutput: true,
    expectFiles: { "gh.txt": "has_intent=0\n" },
  },
  {
    title: "build-intent · issues.closed + state:accepted → 无意图（终态要 owner 裁决，不由关单自动落）",
    cmd: "build-intent",
    script: "build-intent.mjs",
    env: { EVENT_NAME: "issues", EVENT: issueClosedAccepted },
    githubOutput: true,
    expectFiles: { "gh.txt": "has_intent=0\n" },
  },
  {
    title: "build-intent · pull_request opened 无宿主标签 → issue-state-unavailable",
    cmd: "build-intent",
    script: "build-intent.mjs",
    env: { EVENT_NAME: "pull_request", EVENT: prOpened },
    githubOutput: true,
  },
  {
    title: "build-intent · pull_request synchronize 多个引用 → unresolved",
    cmd: "build-intent",
    script: "build-intent.mjs",
    env: { EVENT_NAME: "pull_request", EVENT: prOpenedMulti },
    githubOutput: true,
  },
  {
    title: "build-intent · pull_request synchronize 零引用 → no-issue-reference",
    cmd: "build-intent",
    script: "build-intent.mjs",
    env: { EVENT_NAME: "pull_request", EVENT: prOpenedNoRef },
    githubOutput: true,
  },
  {
    title: "build-intent · pull_request closed 合并 + 宿主标签 + 守卫证据",
    cmd: "build-intent",
    script: "build-intent.mjs",
    stdoutContains: ["\"to\": \"done\"", "\"guards\"", "\"tests\": \"ci/test: success\"", "\"state:done\""],
    env: {
      EVENT_NAME: "pull_request",
      EVENT: prClosedMerged,
      ISSUE_STATE_FILE: "issue-state.json",
      GUARD_EVIDENCE_FILE: "guards.json",
    },
    files: {
      "issue-state.json": JSON.stringify({ labels: ["state:in-progress", "state:done", { name: "bug" }] }),
      "guards.json": JSON.stringify({ tests: "ci/test: success", review: "approved" }),
    },
    githubOutput: true,
  },
  {
    title: "build-intent · pull_request closed 未合并 → 无意图",
    cmd: "build-intent",
    script: "build-intent.mjs",
    env: { EVENT_NAME: "pull_request", EVENT: prClosedUnmerged },
    githubOutput: true,
  },
  {
    title: "build-intent · 认不出的事件 → 无意图",
    cmd: "build-intent",
    script: "build-intent.mjs",
    env: { EVENT_NAME: "push", EVENT: JSON.stringify({ ref: "refs/heads/main" }) },
    githubOutput: true,
  },
  {
    title: "build-intent · EVENT 缺省 → 无意图",
    cmd: "build-intent",
    script: "build-intent.mjs",
    env: { EVENT_NAME: "issues" },
    githubOutput: true,
  },
  {
    title: "build-intent · ISSUE_STATE_FILE 不是合法 JSON → 当作拿不到",
    cmd: "build-intent",
    script: "build-intent.mjs",
    env: { EVENT_NAME: "pull_request", EVENT: prOpened, ISSUE_STATE_FILE: "broken.json" },
    files: { "broken.json": "not json" },
    githubOutput: true,
  },
  {
    title: "build-intent · GUARD_EVIDENCE_FILE 有空值 → 整份丢弃",
    cmd: "build-intent",
    script: "build-intent.mjs",
    env: { EVENT_NAME: "pull_request", EVENT: prOpened, GUARD_EVIDENCE_FILE: "guards.json" },
    files: { "guards.json": JSON.stringify({ tests: " ", review: "approved" }) },
    githubOutput: true,
  },
  {
    title: "build-intent · --resolve-issue 解出 issue 号",
    cmd: "build-intent",
    script: "build-intent.mjs",
    env: { EVENT: prOpened },
    args: ["--resolve-issue"],
  },
  {
    title: "build-intent · --resolve-issue 没有 pull_request → 空输出",
    cmd: "build-intent",
    script: "build-intent.mjs",
    env: { EVENT: issueOpened },
    args: ["--resolve-issue"],
  },
  {
    title: "build-intent · --resolve-issue 多个引用 → 空输出",
    cmd: "build-intent",
    script: "build-intent.mjs",
    env: { EVENT: prOpenedMulti },
    args: ["--resolve-issue"],
  },

  // ---------- last-change ----------
  {
    title: "last-change · 合并 PR 全字段",
    cmd: "last-change",
    script: "last-change.mjs",
    env: () => lastChangeEnv(lcMerged),
    repo: true,
    githubOutput: true,
    expectFiles: { "gh.txt": "changed=1\n" },
    // git 默认 core.quotePath=true，非 ASCII 路径在 diff 输出里是八进制转义：这里把两条真实路径钉死
    stdoutContains: ["## LAST-CHANGE", "| 合并人", "| dan", "2024-05-06", "#4", "\\346\\226\\260\\345\\220\\215.md", "\u0060a.md\u0060"],
    stdoutExcludes: ["\\346\\227\\247\\345\\220\\215.md", "docs/b.md"],
  },
  {
    title: "last-change · 未合并 PR 无审核人",
    cmd: "last-change",
    script: "last-change.mjs",
    env: () => lastChangeEnv(lcOpen),
    repo: true,
    githubOutput: true,
    stdoutContains: ["| 审核人", "| 合并日期", "| 提议人", "alice"],
    stdoutExcludes: ["| dan", "2024-"],
  },
  {
    title: "last-change · body 无引用改看 title",
    cmd: "last-change",
    script: "last-change.mjs",
    env: () => lastChangeEnv(lcTitleOnly),
    repo: true,
    stdoutContains: ["#21"],
  },
  {
    title: "last-change · 覆盖已有标记区间",
    cmd: "last-change",
    script: "last-change.mjs",
    env: () => lastChangeEnv(lcMerged),
    repo: true,
    files: { "in.md": existingBlock },
    args: ["--in", "in.md"],
    githubOutput: true,
  },
  {
    title: "last-change · 已有标题无标记 → 整节替换并保留后续小节",
    cmd: "last-change",
    script: "last-change.mjs",
    env: () => lastChangeEnv(lcMerged),
    repo: true,
    files: { "in.md": headingOnly },
    args: ["--in", "in.md"],
  },
  {
    title: "last-change · 纯文本 → 追加小节",
    cmd: "last-change",
    script: "last-change.mjs",
    env: () => lastChangeEnv(lcMerged),
    repo: true,
    files: { "in.md": plainText },
    args: ["--in", "in.md"],
  },
  {
    title: "last-change · --out 落盘且不写 stdout",
    cmd: "last-change",
    script: "last-change.mjs",
    env: () => lastChangeEnv(lcMerged),
    repo: true,
    args: ["--out", "out.md"],
    githubOutput: true,
  },
  {
    // 先让这一侧自己算出一份门牌，再拿它当输入重算：结果必须原样不变。
    title: "last-change · 幂等：--in 已是同一份内容 → changed=0",
    cmd: "last-change",
    script: "last-change.mjs",
    env: () => lastChangeEnv(lcMerged),
    repo: true,
    args: ["--in", "pre.md"],
    seed: { out: "pre.md" },
    githubOutput: true,
    // 预置那一次也会往 GITHUB_OUTPUT 追加一行（changed=1），再被主运行追加 changed=0：
    // 原实现比的是整棵树，所以这里钉的是两行，不是最后一行。
    expectFiles: { "gh.txt": "changed=1\nchanged=0\n" },
  },
  {
    title: "last-change · 多引用 → 报错",
    cmd: "last-change",
    script: "last-change.mjs",
    env: () => lastChangeEnv(lcMultiRef),
    repo: true,
  },
  {
    title: "last-change · 零引用 → 报错",
    cmd: "last-change",
    script: "last-change.mjs",
    env: () => lastChangeEnv(lcNoRef),
    repo: true,
  },
  {
    title: "last-change · 缺 BASE → 报错",
    cmd: "last-change",
    script: "last-change.mjs",
    env: () => ({ ...lastChangeEnv(lcMerged), BASE: undefined }),
    repo: true,
  },
  {
    title: "last-change · 缺 HEAD → 报错",
    cmd: "last-change",
    script: "last-change.mjs",
    env: () => ({ ...lastChangeEnv(lcMerged), HEAD: undefined }),
    repo: true,
  },
  {
    title: "last-change · BASE=HEAD 无文件变更 → 报错",
    cmd: "last-change",
    script: "last-change.mjs",
    env: () => ({ ...lastChangeEnv(lcMerged), HEAD: B.base }),
    repo: true,
  },
  {
    title: "last-change · 非 pull_request 事件 → 报错",
    cmd: "last-change",
    script: "last-change.mjs",
    env: () => ({ ...lastChangeEnv(lcMerged), EVENT_NAME: "push" }),
    repo: true,
  },
  {
    title: "last-change · 合并信息只补一半 → 报错",
    cmd: "last-change",
    script: "last-change.mjs",
    env: () => lastChangeEnv(lcHalfMerge),
    repo: true,
  },
  {
    title: "last-change · 合并日期不是 ISO → 报错",
    cmd: "last-change",
    script: "last-change.mjs",
    env: () => lastChangeEnv(lcBadDate),
    repo: true,
  },
  {
    title: "last-change · EVENT 非法 JSON → 报错",
    cmd: "last-change",
    script: "last-change.mjs",
    env: () => ({ ...lastChangeEnv(lcMerged), EVENT: "{oops}" }),
    repo: true,
  },
  {
    title: "last-change · --in 文件不存在 → 报错",
    cmd: "last-change",
    script: "last-change.mjs",
    env: () => lastChangeEnv(lcMerged),
    repo: true,
    args: ["--in", "nope.md"],
  },

  // ---------- writer-record ----------
  {
    title: "writer-record · allowed 不留痕",
    cmd: "writer-record",
    script: "writer-record.mjs",
    verdict: { verdict: "allowed", code: "OK", message: "允许 x → y" },
    args: ["--issue", "7"],
  },
  {
    title: "writer-record · rejected 留痕且退出 0",
    cmd: "writer-record",
    script: "writer-record.mjs",
    verdict: { verdict: "rejected", code: "E_GUARD", message: "守卫缺失" },
    args: ["--issue", "7"],
    stdoutContains: ["gh-args: issue comment 7 --body 状态未被修改：REJECTED E_GUARD — 守卫缺失"],
  },
  {
    title: "writer-record · infra 留痕且退出 1",
    cmd: "writer-record",
    script: "writer-record.mjs",
    verdict: { verdict: "infra", code: "INFRA_X", message: "读不到状态" },
    args: ["--issue", "7"],
    stdoutContains: ["gh-args: issue comment 7 --body 状态未被修改：INFRA INFRA_X — 读不到状态"],
  },
  {
    title: "writer-record · 未知判定结果 → 报错",
    cmd: "writer-record",
    script: "writer-record.mjs",
    verdict: { verdict: "weird", code: "c" },
    args: ["--issue", "7"],
  },
  {
    title: "writer-record · 判定文件不存在 → 报错",
    cmd: "writer-record",
    script: "writer-record.mjs",
    verdict: null,
    args: ["--verdict", "nope.json", "--issue", "7"],
  },
  { title: "writer-record · --verdict 缺值 → 报错", cmd: "writer-record", script: "writer-record.mjs", verdict: null, args: ["--verdict"] },
  {
    title: "writer-record · 判定文件不是 JSON → 报错",
    cmd: "writer-record",
    script: "writer-record.mjs",
    verdict: "not json",
    args: ["--verdict", "verdict.json", "--issue", "7"],
  },
  {
    title: "writer-record · 判定是 null → 未知判定结果",
    cmd: "writer-record",
    script: "writer-record.mjs",
    verdict: null,
    args: ["--verdict", "null.json", "--issue", "7"],
  },
  {
    title: "writer-record · rejected 但 issue 号是 0 → 报错",
    cmd: "writer-record",
    script: "writer-record.mjs",
    verdict: { verdict: "rejected", code: "E_GUARD", message: "m" },
    args: ["--verdict", "verdict.json", "--issue", "0"],
  },
  {
    title: "writer-record · rejected 且没给 --issue → 报错",
    cmd: "writer-record",
    script: "writer-record.mjs",
    verdict: { verdict: "rejected", code: "E_GUARD", message: "m" },
    args: ["--verdict", "verdict.json"],
  },
  {
    title: "writer-record · gh 退非零 → 报错",
    cmd: "writer-record",
    script: "writer-record.mjs",
    verdict: { verdict: "rejected", code: "E_GUARD", message: "m" },
    args: ["--verdict", "verdict.json", "--issue", "42"],
    gh: ghFail,
  },
  {
    title: "writer-record · gh 不在 PATH → 报错",
    cmd: "writer-record",
    script: "writer-record.mjs",
    verdict: { verdict: "rejected", code: "E_GUARD", message: "m" },
    args: ["--verdict", "verdict.json", "--issue", "42"],
    noGh: true,
  },
  {
    title: "writer-record · 不给 --verdict 时用默认 verdict.json",
    cmd: "writer-record",
    script: "writer-record.mjs",
    verdict: { verdict: "rejected", code: "E_GUARD", message: "m" },
    args: ["--issue", "5"],
  },

  // ---------- 已登记例外（逐字节无意义，只钉前缀 + 退出码） ----------
  {
    title: "已登记例外 · build-intent：EVENT 不是合法 JSON",
    cmd: "build-intent",
    script: "build-intent.mjs",
    env: { EVENT_NAME: "issues", EVENT: "not json" },
    assertMode: "pattern",
    pattern: { exit: 1, stdout: "", stderrPrefix: "build-intent 失败: EVENT 不是合法 JSON:", nodeStderrContains: "SyntaxError" },
    reason: "Node 抛未捕获 SyntaxError 并打整段 stack trace，Go 给一行可读错误；退出码一致。",
  },
  {
    title: "已登记例外 · build-intent：EVENT 是 null",
    cmd: "build-intent",
    script: "build-intent.mjs",
    env: { EVENT_NAME: "issues", EVENT: "null" },
    assertMode: "pattern",
    pattern: { exit: 1, stdout: "", stderrPrefix: "build-intent 失败: EVENT 是 null", nodeStderrContains: "TypeError" },
    reason: "payload.action 在 null 上取属性抛 TypeError + stack trace；Go 一行错误；退出码一致。",
  },
  {
    title: "已登记例外 · build-intent：labels 不是数组",
    cmd: "build-intent",
    script: "build-intent.mjs",
    env: { EVENT_NAME: "issues", EVENT: JSON.stringify({ action: "opened", issue: { number: 1, labels: "x" } }) },
    assertMode: "pattern",
    pattern: {
      exit: 1,
      stdout: "",
      stderrPrefix: "build-intent 失败: 意图无法归一：labels 必须是数组",
      nodeStderrContains: "TypeError",
    },
    reason: ".map is not a function 的 TypeError + stack trace；Go 一行错误；退出码一致。",
  },
  {
    // 关单上两个 state 标签是形状坏掉了：两侧都 fail-closed，但 Node 抛未捕获 Error 打 stack trace，
    // Go 只给一行可读错误 —— 与上面三条同类，只钉前缀 + 退出码。
    title: "已登记例外 · build-intent：关单上两个 state 标签",
    cmd: "build-intent",
    script: "build-intent.mjs",
    env: { EVENT_NAME: "issues", EVENT: issueClosedTwoStateLabels },
    assertMode: "pattern",
    pattern: {
      exit: 1,
      stdout: "",
      stderrPrefix: "build-intent 失败: 意图无法归一：关单事件上 issue 有 2 个 state 标签",
      nodeStderrContains: "意图无法归一：关单事件上 issue 有 2 个 state 标签",
    },
    reason: "Node 抛未捕获 Error 并打整段 stack trace，Go 给一行可读错误；退出码一致。",
  },
  {
    title: "已登记例外 · last-change：--out 目录不存在",
    cmd: "last-change",
    script: "last-change.mjs",
    env: () => lastChangeEnv(lcMerged),
    args: ["--out", "nodir/out.md"],
    repo: true,
    assertMode: "pattern",
    pattern: {
      exit: 1,
      stdout: "",
      // Node 的临时文件名带 process.pid，两侧 pid 必然不同，只能前缀 + 退出码对齐。
      stderrPrefix: "门牌重算失败：ENOENT: no such file or directory, open",
      nodeStderrContains: "ENOENT",
    },
    reason: "Node 的临时文件名带 process.pid，两侧 pid 必然不同，只能前缀 + 退出码对齐。",
  },
];

export const suiteB = {
  id: "b",
  title: "engine parity · build-intent / last-change / writer-record（对照冻结 golden）",
  cases: assignIds(bCases, "b"),
  async createContext() {
    B.workDir = mkdtempSync(join(tmpdir(), "engine-parity-b-"));
    B.templateRepo = bTemplateRepo();
    return { workDir: B.workDir };
  },
  async disposeContext(ctx) {
    rmSync(ctx.workDir, { recursive: true, force: true });
  },
  async run(ctx, fixture, invoke) {
    const dir = fixture.repo ? bRepoCopy() : bSandbox(fixture.files);
    if (fixture.verdict !== undefined) {
      const files = {};
      if (fixture.verdict !== null)
        files["verdict.json"] = typeof fixture.verdict === "string" ? fixture.verdict : JSON.stringify(fixture.verdict);
      files["null.json"] = "null";
      for (const [name, text] of Object.entries(files)) write(dir, name, text);
    }
    // 每个沙箱都放一个假 gh（原实现如此）：writer-record 的留痕路径要能跑通，
    // 必然失败的那两条用 fixture.gh / noGh 覆盖掉它。
    mkdirSync(join(dir, "bin"), { recursive: true });
    write(dir, "bin/gh", fixture.gh ?? ghOk, 0o755);
    const extraEnv = resolve(fixture.env, ctx) ?? {};
    const env = { ...bEnv, ...Object.fromEntries(Object.entries(extraEnv).filter(([, value]) => value !== undefined)) };
    if (fixture.githubOutput) env.GITHUB_OUTPUT = join(dir, "gh.txt");
    env.PATH = fixture.noGh ? "/nonexistent" : join(dir, "bin") + ":" + bEnv.PATH;
    const args = fixture.args ?? [];
    if (fixture.seed) {
      const seed = spawnSync(invoke.bin, invoke.prefix, { cwd: dir, env, input: "" });
      if (seed.status !== 0) throw new Error("预置门牌必须成功：" + seed.stderr.toString());
      write(dir, fixture.seed.out, seed.stdout.toString());
    }
    const before = snapshotTree(dir);
    const result = spawnSync(invoke.bin, [...invoke.prefix, ...args], {
      cwd: dir,
      env,
      input: "",
    });
    // stack trace 里会带仓库绝对路径：按 repoRoot 归一，golden 才跟 checkout 位置无关。
    const normalize = (text) =>
      withoutPosition(normalizePaths(String(text ?? ""), dir, "<ROOT>"))
        .split(repoRoot)
        .join("<REPO>")
        // 写临时文件失败时 Node 把随机后缀带进文案（.tmp-93329）：golden 里换成占位符。
        .replace(/\.tmp-\d+/g, ".tmp-<N>");
    // undefined 的变量等于没有这个变量（JSON 也存不住它）：meta 里一并滤掉。
    const envMeta = Object.fromEntries(Object.entries(extraEnv).filter(([, value]) => value !== undefined));
    if (fixture.githubOutput) envMeta.GITHUB_OUTPUT = "<ROOT>/gh.txt";
    envMeta.PATH = fixture.noGh ? "/nonexistent" : "<ROOT>/bin:" + bEnv.PATH;
    return {
      exitCode: result.status,
      stdout: normalize(result.stdout.toString()),
      stderr: normalize(result.stderr.toString()),
      // 归一前的 stderr：个别断言（见 goStderrContains）钉的正是被摘掉的坐标后缀。
      rawStderr: String(result.stderr ?? ""),
      files: normalizeTree(diffTree(before, snapshotTree(dir)), normalize),
      requests: [],
      argv: [fixture.cmd, ...args].map((one) => String(one).split(dir).join("<ROOT>")),
      env: envMeta,
    };
  },
};

// =====================================================================
// C · merge-gate
// =====================================================================

const GOOD = "a".repeat(40);
const OTHER = "b".repeat(40);
const BT = String.fromCharCode(96);

// 假 git：只认 merge-gate 用到的两条 cat-file -e，数据来自沙箱目录里的两个文件。
const FAKE_GIT = [
  "#!/bin/sh",
  'root="$FAKE_GIT_ROOT"',
  '[ "$1" = "cat-file" ] && [ "$2" = "-e" ] || exit 1',
  'spec="$3"',
  'case "$spec" in',
  '  *"{commit}")',
  '    sha=$(printf "%s" "$spec" | sed -e "s/[{]commit[}]$//" -e "s/\\^$//")',
  '    grep -Fxq "$sha" "$root/commits" && exit 0',
  "    exit 1 ;;",
  "  *:*)",
  '    sha=$(printf "%s" "$spec" | sed -e "s/:.*$//")',
  '    path=$(printf "%s" "$spec" | sed -e "s/^[^:]*://")',
  '    grep -Fxq "$sha" "$root/commits" || exit 1',
  '    [ -f "$root/files-$sha" ] || exit 1',
  '    grep -Fxq "$path" "$root/files-$sha" && exit 0',
  "    exit 1 ;;",
  "esac",
  "exit 1",
  "",
].join("\n");

// 假 gh：merge-gate 根本不该调用它，一调用就留痕并失败。
const FAKE_GH = ["#!/bin/sh", 'echo "gh 被调用了：merge-gate 不该走 gh" 1>&2', "exit 127", ""].join("\n");

const C = { workDir: null, binDir: null, gitlessDir: null, seq: 0 };

// 门牌正文原先是调 scripts/last-change.mjs 的 renderSection() 现算的。
// 期望值必须能脱离 scripts/ 独立存在（删掉 .mjs 是本次迁移的目的），
// 所以把这份默认门牌逐字节冻在夹具里：它就是 renderSection 在本仓默认输入下的输出。
const SECTION_TEXT = "## LAST-CHANGE\n\n<!-- 由 CI 重算，请勿手改 -->\n\n<!-- LAST-CHANGE:BEGIN -->\n| 项       | 值      |\n| -------- | ------- |\n| 提议人   | p       |\n| 审核人   | —       |\n| issue    | #4      |\n| PR       | #7      |\n| 标题     | t       |\n| 变更文件 | `a.txt` |\n| 合并人   | —       |\n| 合并日期 | —       |\n<!-- LAST-CHANGE:END -->";

const cSection = () => SECTION_TEXT;

function cGreenChecks(head) {
  return [
    { id: 1, name: "check", status: "completed", conclusion: "success", head_sha: head },
    { id: 2, name: "render", status: "completed", conclusion: "success", head_sha: head },
  ];
}

// 每个 case 自己准备沙箱：commits / files-<sha> 决定假 git 的答案，json 决定输入。
function cPrepare(fixture) {
  C.seq += 1;
  const dir = join(C.workDir, "case-" + String(C.seq));
  const repo = join(dir, "repo");
  mkdirSync(repo, { recursive: true });
  const head = fixture.head ?? GOOD;
  writeFileSync(join(repo, "commits"), [GOOD, OTHER].join("\n") + "\n");
  writeFileSync(join(repo, "files-" + head), (fixture.present ?? ["a.txt"]).join("\n") + "\n");
  const pr = fixture.pr ?? 7;
  const issue = fixture.issueNumber ?? 4;
  const body =
    fixture.body !== undefined ? fixture.body : (fixture.lead !== undefined ? fixture.lead : "Fixes #4") + "\n\n" + cSection();
  const event = fixture.event ?? {
    pull_request: { number: pr, body: "事件快照里的旧正文", title: "t", head: { sha: head } },
  };
  const files = {
    event: JSON.stringify(event),
    pr: JSON.stringify({
      number: pr,
      body,
      title: fixture.prTitle ?? "t",
      ...(fixture.omitPrHead ? {} : { head: { sha: head } }),
    }),
    // state 是可选字段：不给就整条不写进 JSON（「缺 state」本身就是要对照的输入形状），
    // 给了就原样写进去 —— G1 用它判「这张单是不是已经关了」。
    issue: JSON.stringify(
      fixture.issue ?? {
        number: issue,
        labels: fixture.labels ?? ["state:in-progress"],
        ...(fixture.state === undefined ? {} : { state: fixture.state }),
      },
    ),
    checks: JSON.stringify(fixture.checks ?? cGreenChecks(head)),
    infra: JSON.stringify(fixture.infra ?? []),
  };
  for (const [name, text] of Object.entries(files))
    writeFileSync(join(dir, name + ".json"), fixture.raw?.[name] ?? text);
  const omit = new Set(fixture.omit ?? []);
  const argv = ["--repo", repo];
  for (const flag of ["--event", "--pr", "--issue", "--checks", "--infra"]) {
    if (omit.has(flag)) continue;
    argv.push(flag, join(dir, flag.slice(2) + ".json"));
  }
  argv.push("--config", fixture.config ?? join(repoRoot, CONFIG_REL));
  for (const extra of fixture.extraArgs ?? []) argv.push(extra);
  const env = {
    PATH: fixture.gitless ? C.gitlessDir : C.binDir + ":/usr/bin:/bin",
    HOME: "/tmp",
    FAKE_GIT_ROOT: repo,
    ...fixture.env,
  };
  return { dir, repo, argv, env };
}

const cCases = [
  // ---- G1 issue-state ----
  { title: "G1 通过：state:in-progress", expectExit: 0, code: "PASS 4/4" },
  { title: "G1 通过：标签是对象形状", expectExit: 0, code: "PASS 4/4", labels: [{ name: "state:in-progress" }] },
  { title: "G1 真失败：没有状态标签", expectExit: 1, code: "E_NO_TRANSITION", labels: [] },
  { title: "G1 真失败：已经是终态 done", expectExit: 1, code: "E_TERMINAL_STATE", labels: ["state:done"] },

  // ---- G1 issue.state：已关闭的单不能被判成在途（裁决 A）----
  // 这组夹具的存在理由：「已关闭就拒」是 Go 与 JS 各写一份的同一判据。
  { title: "G1 真失败：issue 已关闭但标签还停在 in-progress", expectExit: 1, code: "E_ISSUE_CLOSED_IN_FLIGHT", state: "closed" },
  { title: "G1 通过：issue 未关闭 + in-progress（守卫不是恒拒）", expectExit: 0, code: "PASS 4/4", state: "open" },
  { title: "G1 放行：issue 缺 state 字段时当作未关闭", expectExit: 0, code: "PASS 4/4" },
  {
    title: "G1 真失败：issue 已关闭且标签已在终态（终态判定先于关闭判定）",
    expectExit: 1,
    code: "E_TERMINAL_STATE",
    state: "closed",
    labels: ["state:done"],
  },
  { title: "G1 无法判定：未知状态", expectExit: 3, code: "E_UNKNOWN_STATE", labels: ["state:bogus"] },
  {
    title: "G1 无法判定：两个状态标签",
    expectExit: 3,
    code: "E_STATE_LABEL_COUNT",
    labels: ["state:in-progress", "state:blocked"],
  },
  {
    title: "G1 无法判定：配置路径不存在",
    expectExit: 3,
    code: "E_CONFIG_MISSING",
    config: join(tmpdir(), "definitely-not-here-state-machine.yml"),
  },
  { title: "输入形状：issue 缺 number", expectExit: 3, code: "E_ISSUE_SHAPE", issue: { labels: ["state:in-progress"] } },
  {
    // 两侧都 fail-closed，但 Node 抛未捕获 TypeError 打 stack trace，Go 只给可读错误：
    // 已登记例外，只钉「stdout 为空 + stderr 含 TypeError + 退出码 1」。
    title: "未捕获异常：labels 不是数组（两侧都不许吐半份报告）",
    expectExit: 1,
    code: "",
    crash: true,
    labels: "state:in-progress",
    assertMode: "pattern",
    pattern: { exit: 1, stdout: "", stderrMatch: "TypeError" },
  },

  // ---- G2 refs-and-files ----
  { title: "G2 真失败：PR 未引用 issue", expectExit: 1, code: "E_ISSUE_REFS", lead: "这次改动没有写引用" },
  { title: "G2 真失败：引用多个 issue", expectExit: 1, code: "E_ISSUE_REFS", lead: "Fixes #4\nCloses #5" },
  {
    title: "G2 通过：引用写在标题里（body 没有才看 title）",
    expectExit: 0,
    code: "PASS 4/4",
    lead: "标题里才有引用",
    prTitle: "Fixes #4",
  },
  { title: "G2 真失败：引用的不是本次 issue", expectExit: 1, code: "E_ISSUE_REF_MISMATCH", lead: "Fixes #5" },
  { title: "G2 真失败：门牌列的文件在 head 上不存在", expectExit: 1, code: "E_FILE_MISSING", present: ["other.txt"] },
  {
    title: "G2 无法判定：正文没有门牌节",
    expectExit: 3,
    code: "E_LAST_CHANGE_MISSING",
    body: "Fixes #4\n\n只有正文，没有门牌\n",
  },
  {
    title: "G2 真失败：门牌行数与模板不一致",
    expectExit: 1,
    code: "E_LAST_CHANGE_SHAPE",
    body: "Fixes #4\n\n" +
      cSection()
        .split("\n")
        .filter((line) => !line.includes("标题"))
        .join("\n"),
  },
  {
    title: "G2 真失败：门牌没列变更文件",
    expectExit: 1,
    code: "E_LAST_CHANGE_FILES",
    body: "Fixes #4\n\n" + cSection().split(BT + "a.txt" + BT).join("—"),
  },
  {
    title: "G2 无法判定：生产者 render 还没出现",
    expectExit: 3,
    code: "E_LAST_CHANGE_PENDING",
    checks: [{ id: 1, name: "merge-gate", status: "completed", conclusion: "success", head_sha: GOOD }],
  },
  {
    title: "G2 无法判定：生产者还在跑",
    expectExit: 3,
    code: "E_LAST_CHANGE_PENDING",
    checks: [
      { id: 1, name: "check", status: "completed", conclusion: "success", head_sha: GOOD },
      { id: 2, name: "render", status: "in_progress", conclusion: null, head_sha: GOOD },
    ],
  },
  {
    title: "G2 无法判定：生产者这次没写成（G3 也会因它变红）",
    expectExit: 1,
    code: "E_LAST_CHANGE_FAILED",
    alsoCodes: ["E_CHECK_NOT_GREEN"],
    checks: [
      { id: 1, name: "check", status: "completed", conclusion: "success", head_sha: GOOD },
      { id: 2, name: "render", status: "completed", conclusion: "failure", head_sha: GOOD },
    ],
  },
  {
    title: "G2 无法判定：同名生产者 id 相同时取后出现的那条（重跑也算）",
    expectExit: 3,
    code: "E_LAST_CHANGE_PENDING",
    checks: [
      { id: 1, name: "check", status: "completed", conclusion: "success", head_sha: GOOD },
      { id: 2, name: "render", status: "completed", conclusion: "success", head_sha: GOOD },
      { id: 2, name: "render", status: "in_progress", conclusion: null, head_sha: GOOD },
    ],
  },
  { title: "G2 无法判定：head commit 取不到", expectExit: 3, code: "E_GIT_FAILED", head: "c".repeat(40) },
  { title: "G2 无法判定：PATH 上没有 git", expectExit: 3, code: "E_GIT_UNAVAILABLE", gitless: true },
  { title: "出口：--print-issue 打印解析出的 issue 号", expectExit: 0, code: "4", extraArgs: ["--print-issue"] },
  {
    title: "出口：--print-issue 解不出就拒绝",
    expectExit: 1,
    code: "E_ISSUE_REFS",
    lead: "没有引用",
    extraArgs: ["--print-issue"],
  },

  // ---- G3 checks ----
  {
    title: "G3 无法判定：只有自己的 check run",
    expectExit: 3,
    code: "E_CHECKS_EMPTY",
    checks: [{ id: 1, name: "merge-gate", status: "completed", conclusion: "success", head_sha: GOOD }],
  },
  {
    title: "G3 真失败：检查项不是本 head 的",
    expectExit: 1,
    code: "E_CHECK_STALE",
    checks: [
      { id: 1, name: "check", status: "completed", conclusion: "success", head_sha: GOOD },
      { id: 2, name: "render", status: "completed", conclusion: "success", head_sha: GOOD },
      { id: 3, name: "audit", status: "completed", conclusion: "success", head_sha: OTHER },
    ],
  },
  {
    title: "G3 无法判定：检查项还没跑完",
    expectExit: 3,
    code: "E_CHECK_PENDING",
    checks: [
      { id: 1, name: "check", status: "in_progress", conclusion: null, head_sha: GOOD },
      { id: 2, name: "render", status: "completed", conclusion: "success", head_sha: GOOD },
    ],
  },
  {
    title: "G3 真失败：检查项失败",
    expectExit: 1,
    code: "E_CHECK_NOT_GREEN",
    checks: [
      { id: 1, name: "check", status: "completed", conclusion: "failure", head_sha: GOOD },
      { id: 2, name: "render", status: "completed", conclusion: "success", head_sha: GOOD },
    ],
  },
  {
    title: "G3 无法判定：检查项没判过（neutral）",
    expectExit: 3,
    code: "E_CHECK_NOT_JUDGED",
    checks: [
      { id: 1, name: "check", status: "completed", conclusion: "neutral", head_sha: GOOD },
      { id: 2, name: "render", status: "completed", conclusion: "success", head_sha: GOOD },
    ],
  },
  {
    title: "G3 真失败：失败与未判过并存时先报失败",
    expectExit: 1,
    code: "E_CHECK_NOT_GREEN",
    checks: [
      { id: 1, name: "check", status: "completed", conclusion: "failure", head_sha: GOOD },
      { id: 2, name: "render", status: "completed", conclusion: "success", head_sha: GOOD },
      { id: 3, name: "lint", status: "completed", conclusion: "skipped", head_sha: GOOD },
    ],
  },
  {
    title: "G3 同名 check 取最新：新的失败",
    expectExit: 1,
    code: "E_CHECK_NOT_GREEN",
    checks: [
      { id: 10, name: "audit", status: "completed", conclusion: "success", head_sha: GOOD },
      { id: 2, name: "render", status: "completed", conclusion: "success", head_sha: GOOD },
      { id: 20, name: "audit", status: "completed", conclusion: "failure", head_sha: GOOD },
    ],
  },
  {
    title: "G3 同名 check 取最新：新的通过（旧失败不算）",
    expectExit: 0,
    code: "PASS 4/4",
    checks: [
      { id: 10, name: "audit", status: "completed", conclusion: "failure", head_sha: GOOD },
      { id: 2, name: "render", status: "completed", conclusion: "success", head_sha: GOOD },
      { id: 20, name: "audit", status: "completed", conclusion: "success", head_sha: GOOD },
    ],
  },
  {
    title: "G3 同名 check 取最新：与数组顺序无关",
    expectExit: 0,
    code: "PASS 4/4",
    checks: [
      { id: 20, name: "audit", status: "completed", conclusion: "success", head_sha: GOOD },
      { id: 2, name: "render", status: "completed", conclusion: "success", head_sha: GOOD },
      { id: 10, name: "audit", status: "completed", conclusion: "failure", head_sha: GOOD },
    ],
  },
  {
    title: "G3 无法判定：还有未结 INFRA",
    expectExit: 3,
    code: "E_INFRA_OPEN",
    infra: [{ id: "INFRA-1" }, { id: "INFRA-2" }],
  },
  {
    title: "G3 无法判定：未结 INFRA 用 unresolved 形状",
    expectExit: 3,
    code: "E_INFRA_OPEN",
    infra: { unresolved: [{ id: "INFRA-9" }] },
  },
  { title: "G3 无法判定：INFRA 形状不对", expectExit: 3, code: "E_INFRA_SHAPE", infra: {} },
  { title: "G3 无法判定：check runs 形状不对", expectExit: 3, code: "E_CHECKS_SHAPE", checks: "nope" },

  // ---- 输入层 ----
  { title: "输入：没有事件输入", expectExit: 3, code: "E_EVENT_MISSING", omit: ["--event"] },
  { title: "输入：事件不是合法 JSON", expectExit: 3, code: "E_EVENT_UNPARSABLE", raw: { event: "{ 坏掉的" } },
  { title: "输入：事件里没有 pull_request", expectExit: 3, code: "E_EVENT_SHAPE", event: { number: 7 } },
  {
    title: "输入：事件里没有 head.sha 也没给 --head",
    expectExit: 3,
    code: "E_HEAD_MISSING",
    event: { pull_request: { number: 7, body: "旧正文", title: "t" } },
    omitPrHead: true,
  },
  {
    title: "输入：head 由 --head 兜底",
    expectExit: 0,
    code: "PASS 4/4",
    event: { pull_request: { number: 7, body: "旧正文", title: "t" } },
    extraArgs: ["--head", GOOD],
  },
  { title: "输入：没有给 --checks", expectExit: 3, code: "E_INPUT_MISSING", omit: ["--checks"] },
  {
    title: "输入：--checks 指向不存在的文件",
    expectExit: 3,
    code: "E_INPUT_MISSING",
    omit: ["--checks"],
    extraArgs: ["--checks", join(tmpdir(), "nope-checks.json")],
  },
  { title: "输入：checks 不是合法 JSON", expectExit: 3, code: "E_INPUT_UNPARSABLE", raw: { checks: "{ bad" } },
];

export const suiteC = {
  id: "c",
  // merge-gate 的夹具没有 cmd 字段：子命令是这条 suite 的常量。
  cmd: "merge-gate",
  title: "engine parity · merge-gate（对照冻结 golden）",
  cases: assignIds(cCases, "c"),
  async createContext() {
    const workDir = mkdtempSync(join(tmpdir(), "engine-parity-c-"));
    C.workDir = workDir;
    C.binDir = join(workDir, "bin");
    C.gitlessDir = join(workDir, "gitless");
    mkdirSync(C.binDir, { recursive: true });
    mkdirSync(C.gitlessDir, { recursive: true });
    writeFileSync(join(C.binDir, "git"), FAKE_GIT);
    chmodSync(join(C.binDir, "git"), 0o755);
    writeFileSync(join(C.binDir, "gh"), FAKE_GH);
    chmodSync(join(C.binDir, "gh"), 0o755);
    writeFileSync(join(C.gitlessDir, "gh"), FAKE_GH);
    chmodSync(join(C.gitlessDir, "gh"), 0o755);
    return { workDir };
  },
  async disposeContext(ctx) {
    rmSync(ctx.workDir, { recursive: true, force: true });
  },
  async run(ctx, fixture, invoke) {
    const prepared = cPrepare(fixture);
    const before = snapshotTree(prepared.dir);
    // Node 侧没有「子命令」这个词（脚本名就是命令）：冻结时用 mapArgs 摘掉 argv[0]，Go 侧原样带子命令。
    const argv = invoke.mapArgs ? invoke.mapArgs(prepared.argv) : prepared.argv;
    const result = spawnSync(invoke.bin, [...invoke.prefix, ...argv], {
      cwd: prepared.dir,
      env: prepared.env,
      timeout: 60000,
    });
    if (result.status === null) throw new Error("子进程没跑起来: " + result.signal);
    const raw = (text) => normalizePaths(String(text ?? ""), prepared.dir, "<ROOT>");
    const normalize = (text) =>
      raw(text).split(repoRoot).join("<REPO_ROOT>").split(tmpdir()).join("<TMP>");
    return {
      exitCode: result.status,
      stdout: withoutPosition(normalize(result.stdout.toString())),
      stderr: normalize(result.stderr.toString()),
      files: normalizeTree(diffTree(before, snapshotTree(prepared.dir)), normalize),
      requests: [],
      argv: [fixture.cmd ?? suiteC.cmd, ...prepared.argv].map((one) => normalize(String(one))),
      env: {
        // PATH 里的 bin 目录在 mkdtemp 下（不在沙箱目录里）：按 workDir 归一，
        // 否则每冻结一次就换一串随机目录名，golden 的 diff 全是噪声。
        PATH: (fixture.gitless ? C.gitlessDir : C.binDir).split(C.workDir).join("<WORK>") + ":/usr/bin:/bin",
        HOME: "/tmp",
        FAKE_GIT_ROOT: prepared.repo.split(prepared.dir).join("<ROOT>"),
      },
    };
  },
  extras: [
    {
      title: "夹具数量足够覆盖四道守卫的三态",
      run(suite) {
        if (suite.cases.length < 25) throw new Error("夹具少于 25 条：" + suite.cases.length);
      },
    },
  ],
};

// =====================================================================
// D · audit-collect / audit-review / audit-slot / audit-findings / routing
// =====================================================================

const dRecord = (overrides) => ({
  verdict: "needs_revision",
  findings: [{ path: "scripts/x.mjs", line: 12, severity: "high", criterion: "必须校验输入", suggestion: "加校验" }],
  evidence: { executor: "github", agent: "review-a", model: "deepseek-chat", request_id: "req-1" },
  ...overrides,
});
const cleanRecord = (agent, executor, model, requestId) => ({
  verdict: "pass",
  findings: [],
  evidence: { executor, agent, model, request_id: requestId },
});
const A_CLEAN = cleanRecord("review-a", "github", "deepseek-chat", "req-1");
const B_CLEAN = cleanRecord("review-b", "sandbox", "deepseek-reasoner", "req-2");
const A_INFRA = {
  verdict: "INFRA",
  findings: [],
  evidence: { executor: "github", agent: "review-a" },
  reason: "没有 DEEPSEEK_API_KEY：判不了，不是通过",
};
const DIFF = [
  "diff --git a/scripts/x.mjs b/scripts/x.mjs",
  "--- a/scripts/x.mjs",
  "+++ b/scripts/x.mjs",
  "@@ -1 +1 @@",
  "-const old = 1;",
  "+const next = 2;",
  "",
].join("\n");
const ROUTING_OK = [
  "version: 1",
  "routes:",
  "  - name: review-a",
  "    provider: deepseek",
  "    model: deepseek-chat",
  "    purpose: A 侧",
  "  - name: review-b",
  "    provider: deepseek",
  "    model: deepseek-reasoner",
  "    purpose: B 侧",
  "",
].join("\n");
const ROUTING_BAD = "version: 1\nroutes: [\n";
const WORKFLOW_CLEAN = ["jobs:", "  audit:", "    steps:", "      - run: ./scripts/audit-review.mjs --slot review-a", ""].join("\n");
const WORKFLOW_HARDCODED = ["jobs:", "  audit:", "    steps:", "      - run: echo deepseek-chat", ""].join("\n");

const dSetupAuditFiles = (dir) => {
  write(dir, "a.json", JSON.stringify(A_CLEAN));
  write(dir, "b.json", JSON.stringify(B_CLEAN));
  write(dir, "disagree-a.json", JSON.stringify(dRecord()));
  write(
    dir,
    "disagree-b.json",
    JSON.stringify({
      ...dRecord(),
      findings: [
        { path: "scripts/x.mjs", line: 12, severity: "blocker", criterion: "必须校验输入", suggestion: "加校验" },
        { path: "scripts/y.mjs", line: 3, severity: "low", criterion: "命名", suggestion: "改名" },
      ],
      evidence: { executor: "sandbox", agent: "review-b", model: "deepseek-reasoner", request_id: "req-2" },
    }),
  );
  write(dir, "infra.json", JSON.stringify(A_INFRA));
  write(dir, "bad.json", "not json at all\n");
};

const dSetupRouting = (routing, workflow) => (dir) => {
  if (routing !== null) write(dir, ".agents/platform/routing.yml", routing);
  if (workflow !== null) write(dir, ".github/workflows/audit.yml", workflow);
};

const dSetupReview = (routing) => (dir) => {
  write(dir, "diff.txt", DIFF);
  mkdirSync(join(dir, "out"), { recursive: true });
  if (routing !== null) write(dir, ".agents/platform/routing.yml", routing);
};

const PR_VIEW = JSON.stringify({ headRefOid: "abc123", headRefName: "feat/x", state: "OPEN" });
const RUN_LIST = JSON.stringify([
  { databaseId: 77, headSha: "abc123", createdAt: "2099-01-01T00:00:00.000Z", status: "completed" },
]);
const CHECKS_OK = [
  JSON.stringify({ id: 11, name: "build", conclusion: "success", title: "构建", summary: "" }),
  JSON.stringify({ id: 12, name: "audit", conclusion: "success", title: "审计通过", summary: "结论 success" }),
  "",
].join("\n");
const CHECKS_FAIL = [JSON.stringify({ id: 12, name: "audit", conclusion: "failure", title: "审计不合格", summary: "有 blocker" }), ""].join("\n");
const CHECKS_ACTREQ = [JSON.stringify({ id: 12, name: "audit", conclusion: "action_required", title: "判不了", summary: "" }), ""].join("\n");

const dSetupCollect = (checks) => (dir) => {
  write(dir, "pr_view.json", PR_VIEW);
  write(dir, "run_list.json", RUN_LIST);
  write(dir, "check_runs.ndjson", checks);
  write(dir, "a.json", JSON.stringify(A_CLEAN));
  write(dir, "b.json", JSON.stringify(B_CLEAN));
};

// 假 gh：只认 audit-collect 真正用到的四个查询，数据来自沙箱目录；FAKE_FAIL 用来指定哪一步失败。
const dFAKE_GH = [
  "#!/bin/sh",
  'D="$FAKE_DIR"',
  'step=""',
  'if [ "$1" = "pr" ] && [ "$2" = "view" ]; then step=pr',
  'elif [ "$1" = "workflow" ]; then step=workflow',
  'elif [ "$1" = "run" ]; then step=run',
  'elif [ "$1" = "api" ]; then step=api',
  "fi",
  'if [ "$FAKE_FAIL" = "$step" ]; then',
  '  echo "gh: $step 故意失败" >&2',
  "  exit 1",
  "fi",
  'case "$step" in',
  '  pr) cat "$D/pr_view.json" ;;',
  "  workflow) : ;;",
  '  run) cat "$D/run_list.json" ;;',
  '  api) cat "$D/check_runs.ndjson" ;;',
  '  *) echo "unexpected gh args: $*" >&2; exit 12 ;;',
  "esac",
  "exit 0",
  "",
].join("\n");

const CHAT_EMPTY = JSON.stringify({ findings: [] });
const CHAT_BLOCKER = JSON.stringify({
  findings: [{ path: "scripts/x.mjs", line: 12, severity: "blocker", criterion: "必须校验输入", suggestion: "加校验" }],
});
const CHAT_HIGH = JSON.stringify({
  findings: [{ path: "scripts/x.mjs", line: 3, severity: "high", criterion: "必须校验输入", suggestion: "加校验" }],
});
const CHAT_BAD_SCHEMA = JSON.stringify({
  findings: [{ path: "scripts/x.mjs", line: 0, severity: "high", criterion: "", suggestion: "加校验" }],
});

const chatReply = (mode) => {
  const wrap = (id, content) => [200, JSON.stringify({ id, choices: [{ message: { content } }] })];
  const FENCE = String.fromCharCode(96, 96, 96);
  switch (mode) {
    case "ok":
      return wrap("req-1", CHAT_EMPTY);
    case "blocker":
      return wrap("req-2", CHAT_BLOCKER);
    case "high":
      return wrap("req-3", CHAT_HIGH);
    case "fence":
      return wrap("req-4", FENCE + "json\n" + CHAT_HIGH + "\n" + FENCE);
    case "badjson":
      return wrap("req-5", "not json at all");
    case "nofindings":
      return wrap("req-6", JSON.stringify({ other: 1 }));
    case "badschema":
      return wrap("req-7", CHAT_BAD_SCHEMA);
    case "noid":
      return [200, JSON.stringify({ choices: [{ message: { content: CHAT_EMPTY } }] })];
    case "nocontent":
      return [200, JSON.stringify({ id: "req-9", choices: [{ message: { role: "assistant" } }] })];
    case "http500":
      return [500, "boom " + "x".repeat(300)];
    case "notjson":
      return [200, "<html>oops</html>"];
    default:
      return wrap("req-0", CHAT_EMPTY);
  }
};

// 上游替身必须跑在独立进程里：被测进程是 spawnSync 起的，同一线程里的 http server
// 在 spawnSync 期间根本拿不到 CPU，会和孩子互等到超时。请求体由替身落盘，主进程回读。
const buildServerSource = () =>
  [
    'import { createServer } from "node:http";',
    'import { mkdirSync, writeFileSync } from "node:fs";',
    'import { join } from "node:path";',
    "const CHAT_EMPTY = " + JSON.stringify(CHAT_EMPTY) + ";",
    "const CHAT_BLOCKER = " + JSON.stringify(CHAT_BLOCKER) + ";",
    "const CHAT_HIGH = " + JSON.stringify(CHAT_HIGH) + ";",
    "const CHAT_BAD_SCHEMA = " + JSON.stringify(CHAT_BAD_SCHEMA) + ";",
    "const chatReply = " + chatReply.toString() + ";",
    "const dir = process.env.PARITY_BODY_DIR;",
    "mkdirSync(dir, { recursive: true });",
    "let seq = 0;",
    "const server = createServer((request, response) => {",
    '  let raw = "";',
    '  request.setEncoding("utf8");',
    '  request.on("data", (chunk) => { raw += chunk; });',
    '  request.on("end", () => {',
    "    seq += 1;",
    '    const name = "req-" + String(seq).padStart(4, "0") + ".json";',
    "    writeFileSync(join(dir, name), JSON.stringify({ url: request.url, body: raw }));",
    '    const mode = String(request.url).split("/").filter(Boolean)[0] || "ok";',
    "    const reply = chatReply(mode);",
    '    response.writeHead(reply[0], { "content-type": "application/json" });',
    "    response.end(reply[1]);",
    "  });",
    "});",
    'server.listen(0, "127.0.0.1", () => {',
    '  writeFileSync(join(dir, "port.txt"), String(server.address().port));',
    "});",
    "",
  ].join("\n");

const YAML_MARK = "路由声明不是合法 YAML: .agents/platform/routing.yml: ";
const dNET_MARK = "调用上游失败（没拿到响应）：";
const dNormalizeDetail = (text, mode) => {
  const mark = mode === "yaml" ? YAML_MARK : mode === "net" ? dNET_MARK : null;
  if (!mark) return text;
  const at = text.indexOf(mark);
  return at === -1 ? text : text.slice(0, at + mark.length) + "<DETAIL>";
};

const D = { workDir: null, fakeBin: null, bodyDir: null, port: 0, server: null };

const dReadBodies = () => {
  const names = readdirSync(D.bodyDir)
    .filter((name) => name.startsWith("req-"))
    .sort();
  return names.map((name) => readFileSync(join(D.bodyDir, name), "utf8"));
};

const reviewArgs = (mode, slot) => () => [
  "--slot",
  slot || "review-a",
  "--diff",
  "diff.txt",
  "--out",
  "out/record.json",
  "--api-base",
  "http://127.0.0.1:" + D.port + "/" + mode,
];

const dCases = [
  // ---- audit-findings：口径层 ----
  {
    title: "两槽都干净 -> pass",
    cmd: "audit-findings",
    script: "audit-findings.mjs",
    args: ["--a", "a.json", "--b", "b.json"],
    setup: dSetupAuditFiles,
    expectExit: 0,
  },
  {
    title: "写出 result.json",
    cmd: "audit-findings",
    script: "audit-findings.mjs",
    args: ["--a", "a.json", "--b", "b.json", "--out", "result.json"],
    setup: dSetupAuditFiles,
    expectExit: 0,
  },
  {
    title: "两侧结论与 severity 不一致",
    cmd: "audit-findings",
    script: "audit-findings.mjs",
    args: ["--a", "disagree-a.json", "--b", "disagree-b.json", "--out", "result.json"],
    setup: dSetupAuditFiles,
    expectExit: 1,
  },
  {
    title: "只有 A 侧输入（缺 B 侧不算拒绝）",
    cmd: "audit-findings",
    script: "audit-findings.mjs",
    args: ["--a", "a.json"],
    setup: dSetupAuditFiles,
    expectExit: 0,
  },
  {
    title: "输入申报 INFRA -> 判不了",
    cmd: "audit-findings",
    script: "audit-findings.mjs",
    args: ["--a", "infra.json", "--b", "b.json"],
    setup: dSetupAuditFiles,
    expectExit: 3,
  },
  {
    title: "输入文件不存在",
    cmd: "audit-findings",
    script: "audit-findings.mjs",
    args: ["--a", "missing.json", "--b", "b.json"],
    setup: dSetupAuditFiles,
    expectExit: 3,
  },
  {
    title: "输入不是 JSON",
    cmd: "audit-findings",
    script: "audit-findings.mjs",
    args: ["--a", "bad.json"],
    setup: dSetupAuditFiles,
    expectExit: 3,
  },
  {
    title: "B 槽输入自称 review-a",
    cmd: "audit-findings",
    script: "audit-findings.mjs",
    args: ["--a", "a.json", "--b", "a.json"],
    setup: dSetupAuditFiles,
    expectExit: 3,
  },

  // ---- audit-slot：槽位身份 ----
  { title: "无参 -> 用法错", cmd: "audit-slot", script: "audit-slot.mjs", args: [], expectExit: 1 },
  {
    title: "非法槽名",
    cmd: "audit-slot",
    script: "audit-slot.mjs",
    args: ["--slot", "review-c", "--executor", "github", "--out", "o.json"],
    env: { AUDIT_INPUT: "{}" },
    expectExit: 1,
  },
  {
    title: "自报身份与所在槽位不符",
    cmd: "audit-slot",
    script: "audit-slot.mjs",
    args: ["--slot", "review-a", "--executor", "github", "--out", "o.json"],
    env: { AUDIT_INPUT: JSON.stringify({ verdict: "pass", evidence: { executor: "github", agent: "review-b" } }) },
    expectExit: 0,
  },
  {
    title: "上游未注入 findings",
    cmd: "audit-slot",
    script: "audit-slot.mjs",
    args: ["--slot", "review-a", "--executor", "github", "--out", "o.json"],
    env: { AUDIT_INPUT: "  " },
    expectExit: 0,
  },
  {
    title: "--out 的父目录不存在时自建",
    cmd: "audit-slot",
    script: "audit-slot.mjs",
    args: ["--slot", "review-a", "--executor", "sandbox", "--out", "deep/dir/o.json"],
    env: { AUDIT_INPUT: JSON.stringify({ verdict: "pass", evidence: { executor: "sandbox", agent: "review-a" } }) },
    expectExit: 0,
  },
  {
    title: "输入不是 JSON -> 原样交给口径层",
    cmd: "audit-slot",
    script: "audit-slot.mjs",
    args: ["--slot", "review-b", "--executor", "github", "--out", "o.json"],
    env: { AUDIT_INPUT: "not json at all" },
    expectExit: 0,
  },

  // ---- routing：模型名真源 ----
  {
    title: "真源自洽 + workflow 无模型名",
    cmd: "routing",
    script: "routing.mjs",
    args: ["--check"],
    setup: dSetupRouting(ROUTING_OK, WORKFLOW_CLEAN),
    expectExit: 0,
  },
  {
    title: "没有 --check -> 用法错",
    cmd: "routing",
    script: "routing.mjs",
    args: [],
    setup: dSetupRouting(ROUTING_OK, WORKFLOW_CLEAN),
    expectExit: 2,
  },
  { title: "真源文件不存在", cmd: "routing", script: "routing.mjs", args: ["--check"], expectExit: 1 },
  {
    title: "真源不是合法 YAML（解析器文案已登记为例外）",
    cmd: "routing",
    script: "routing.mjs",
    args: ["--check"],
    setup: dSetupRouting(ROUTING_BAD, WORKFLOW_CLEAN),
    normalize: "yaml",
    expectExit: 1,
  },
  {
    title: "workflow 里出现真源模型名",
    cmd: "routing",
    script: "routing.mjs",
    args: ["--check"],
    setup: dSetupRouting(ROUTING_OK, WORKFLOW_HARDCODED),
    expectExit: 1,
  },
  {
    title: "routes 是空数组",
    cmd: "routing",
    script: "routing.mjs",
    args: ["--check"],
    setup: dSetupRouting("version: 1\nroutes: []\n", WORKFLOW_CLEAN),
    expectExit: 1,
  },
  {
    title: "模型名嵌在更长的词里（不算硬编码）",
    cmd: "routing",
    script: "routing.mjs",
    args: ["--check"],
    setup: dSetupRouting(
      ROUTING_OK,
      ["jobs:", "  audit:", "    steps:", "      - run: echo my-deepseek-chat", "      - run: echo deepseek-chat-v2", ""].join("\n"),
    ),
    expectExit: 0,
  },

  // ---- audit-collect：编排 ----
  { title: "无参 -> 用法错", cmd: "audit-collect", script: "audit-collect.mjs", args: [], expectExit: 2 },
  {
    title: "--pr 不是正整数",
    cmd: "audit-collect",
    script: "audit-collect.mjs",
    args: ["--pr", "abc", "--a", "a.json", "--b", "b.json"],
    setup: dSetupCollect(CHECKS_OK),
    env: (dir) => ({ FAKE_DIR: dir, PATH: D.fakeBin + ":" + process.env.PATH }),
    expectExit: 2,
  },
  {
    title: "dry-run 只打印命令，不发 run",
    cmd: "audit-collect",
    script: "audit-collect.mjs",
    args: ["--pr", "7", "--a", "a.json", "--b", "b.json", "--dry-run"],
    setup: dSetupCollect(CHECKS_OK),
    env: (dir) => ({ FAKE_DIR: dir, PATH: D.fakeBin + ":" + process.env.PATH }),
    expectExit: 0,
  },
  {
    title: "全 pass -> 结论 success",
    cmd: "audit-collect",
    script: "audit-collect.mjs",
    args: ["--pr", "7", "--a", "a.json", "--b", "b.json", "--json"],
    setup: dSetupCollect(CHECKS_OK),
    env: (dir) => ({ FAKE_DIR: dir, PATH: D.fakeBin + ":" + process.env.PATH }),
    expectExit: 0,
  },
  {
    title: "审计结论 failure -> 拒绝",
    cmd: "audit-collect",
    script: "audit-collect.mjs",
    args: ["--pr", "7", "--a", "a.json", "--b", "b.json", "--json"],
    setup: dSetupCollect(CHECKS_FAIL),
    env: (dir) => ({ FAKE_DIR: dir, PATH: D.fakeBin + ":" + process.env.PATH }),
    expectExit: 1,
  },
  {
    title: "conclusion 是 action_required -> 判不了",
    cmd: "audit-collect",
    script: "audit-collect.mjs",
    args: ["--pr", "7", "--a", "a.json", "--b", "b.json", "--json"],
    setup: dSetupCollect(CHECKS_ACTREQ),
    env: (dir) => ({ FAKE_DIR: dir, PATH: D.fakeBin + ":" + process.env.PATH }),
    expectExit: 3,
  },
  {
    title: "gh 查询失败 -> INFRA",
    cmd: "audit-collect",
    script: "audit-collect.mjs",
    args: ["--pr", "7", "--a", "a.json", "--b", "b.json", "--json"],
    setup: dSetupCollect(CHECKS_OK),
    env: (dir) => ({ FAKE_DIR: dir, PATH: D.fakeBin + ":" + process.env.PATH, FAKE_FAIL: "pr" }),
    expectExit: 3,
  },

  // ---- audit-review：执行器 ----
  {
    title: "无参 -> 用法错",
    cmd: "audit-review",
    script: "audit-review.mjs",
    args: [],
    setup: dSetupReview(ROUTING_OK),
    expectExit: 2,
  },
  {
    title: "非法槽名",
    cmd: "audit-review",
    script: "audit-review.mjs",
    args: ["--slot", "review-c", "--diff", "diff.txt", "--out", "out/record.json"],
    setup: dSetupReview(ROUTING_OK),
    expectExit: 2,
  },
  {
    title: "--out 的目录不存在（不替调用方创建）",
    cmd: "audit-review",
    script: "audit-review.mjs",
    args: ["--slot", "review-a", "--diff", "diff.txt", "--out", "nodir/record.json"],
    setup: dSetupReview(ROUTING_OK),
    expectExit: 2,
  },
  {
    title: "--diff 文件不存在",
    cmd: "audit-review",
    script: "audit-review.mjs",
    args: ["--slot", "review-a", "--diff", "missing.diff", "--out", "out/record.json"],
    setup: dSetupReview(ROUTING_OK),
    expectExit: 2,
  },
  {
    title: "认不出的参数（--model 刻意不存在）",
    cmd: "audit-review",
    script: "audit-review.mjs",
    args: ["--slot", "review-a", "--diff", "diff.txt", "--out", "out/record.json", "--model", "x"],
    setup: dSetupReview(ROUTING_OK),
    expectExit: 2,
  },
  {
    title: "没有 DEEPSEEK_API_KEY -> INFRA",
    cmd: "audit-review",
    script: "audit-review.mjs",
    args: ["--slot", "review-a", "--diff", "diff.txt", "--out", "out/record.json"],
    setup: dSetupReview(ROUTING_OK),
    env: { DEEPSEEK_API_KEY: "" },
    expectExit: 3,
  },
  {
    title: "取不到模型真源 -> INFRA",
    cmd: "audit-review",
    script: "audit-review.mjs",
    args: ["--slot", "review-a", "--diff", "diff.txt", "--out", "out/record.json"],
    setup: dSetupReview(null),
    env: { DEEPSEEK_API_KEY: "stub-key-123" },
    expectExit: 3,
  },
  {
    title: "真源不是合法 YAML（解析器文案已登记为例外）",
    cmd: "audit-review",
    script: "audit-review.mjs",
    args: ["--slot", "review-a", "--diff", "diff.txt", "--out", "out/record.json"],
    setup: dSetupReview(ROUTING_BAD),
    env: { DEEPSEEK_API_KEY: "stub-key-123" },
    normalize: "yaml",
    expectExit: 3,
  },
  {
    title: "模型说没有缺陷 -> pass",
    cmd: "audit-review",
    script: "audit-review.mjs",
    args: reviewArgs("ok"),
    setup: dSetupReview(ROUTING_OK),
    env: { DEEPSEEK_API_KEY: "stub-key-123" },
    expectExit: 0,
  },
  {
    title: "有 blocker -> reject",
    cmd: "audit-review",
    script: "audit-review.mjs",
    args: reviewArgs("blocker", "review-b"),
    setup: dSetupReview(ROUTING_OK),
    env: { DEEPSEEK_API_KEY: "stub-key-123" },
    expectExit: 0,
  },
  {
    title: "只有 high -> needs_revision",
    cmd: "audit-review",
    script: "audit-review.mjs",
    args: reviewArgs("high"),
    setup: dSetupReview(ROUTING_OK),
    env: { DEEPSEEK_API_KEY: "stub-key-123" },
    expectExit: 0,
  },
  {
    title: "模型把 JSON 包在围栏里",
    cmd: "audit-review",
    script: "audit-review.mjs",
    args: reviewArgs("fence"),
    setup: dSetupReview(ROUTING_OK),
    env: { DEEPSEEK_API_KEY: "stub-key-123" },
    expectExit: 0,
  },
  {
    title: "模型回复不是 JSON",
    cmd: "audit-review",
    script: "audit-review.mjs",
    args: reviewArgs("badjson"),
    setup: dSetupReview(ROUTING_OK),
    env: { DEEPSEEK_API_KEY: "stub-key-123" },
    expectExit: 3,
  },
  {
    title: "模型输出里没有 findings 数组",
    cmd: "audit-review",
    script: "audit-review.mjs",
    args: reviewArgs("nofindings"),
    setup: dSetupReview(ROUTING_OK),
    env: { DEEPSEEK_API_KEY: "stub-key-123" },
    expectExit: 3,
  },
  {
    title: "模型输出不合 schema",
    cmd: "audit-review",
    script: "audit-review.mjs",
    args: reviewArgs("badschema"),
    setup: dSetupReview(ROUTING_OK),
    env: { DEEPSEEK_API_KEY: "stub-key-123" },
    expectExit: 3,
  },
  {
    title: "上游没有回 request_id",
    cmd: "audit-review",
    script: "audit-review.mjs",
    args: reviewArgs("noid"),
    setup: dSetupReview(ROUTING_OK),
    env: { DEEPSEEK_API_KEY: "stub-key-123" },
    expectExit: 3,
  },
  {
    title: "上游响应缺 choices[0].message.content",
    cmd: "audit-review",
    script: "audit-review.mjs",
    args: reviewArgs("nocontent"),
    setup: dSetupReview(ROUTING_OK),
    env: { DEEPSEEK_API_KEY: "stub-key-123" },
    expectExit: 3,
  },
  {
    title: "上游 HTTP 500",
    cmd: "audit-review",
    script: "audit-review.mjs",
    args: reviewArgs("http500"),
    setup: dSetupReview(ROUTING_OK),
    env: { DEEPSEEK_API_KEY: "stub-key-123" },
    expectExit: 3,
  },
  {
    title: "上游响应体不是 JSON",
    cmd: "audit-review",
    script: "audit-review.mjs",
    args: reviewArgs("notjson"),
    setup: dSetupReview(ROUTING_OK),
    env: { DEEPSEEK_API_KEY: "stub-key-123" },
    expectExit: 3,
  },
  {
    title: "连不上上游（网络栈文案已登记为例外）",
    cmd: "audit-review",
    script: "audit-review.mjs",
    args: () => ["--slot", "review-a", "--diff", "diff.txt", "--out", "out/record.json", "--api-base", "http://127.0.0.1:9"],
    setup: dSetupReview(ROUTING_OK),
    env: { DEEPSEEK_API_KEY: "stub-key-123" },
    normalize: "net",
    expectExit: 3,
  },
];

export const suiteD = {
  id: "d",
  title: "engine parity · 审计六件套（对照冻结 golden）",
  cases: assignIds(dCases, "d"),
  async createContext() {
    D.workDir = mkdtempSync(join(tmpdir(), "engine-parity-d-"));
    D.bodyDir = join(D.workDir, "bodies");
    mkdirSync(D.bodyDir, { recursive: true });
    D.fakeBin = join(D.workDir, "bin");
    mkdirSync(D.fakeBin, { recursive: true });
    writeFileSync(join(D.fakeBin, "gh"), dFAKE_GH);
    chmodSync(join(D.fakeBin, "gh"), 0o755);
    const serverScript = join(D.workDir, "chat-server.mjs");
    writeFileSync(serverScript, buildServerSource());
    const { spawn } = await import("node:child_process");
    D.server = spawn(process.execPath, [serverScript], { env: { ...process.env, PARITY_BODY_DIR: D.bodyDir }, stdio: "ignore" });
    const portFile = join(D.bodyDir, "port.txt");
    for (let i = 0; i < 200; i += 1) {
      try {
        const text = readFileSync(portFile, "utf8").trim();
        if (text) {
          D.port = Number(text);
          break;
        }
      } catch {
        // 还没写好，继续等
      }
      await new Promise((done) => setTimeout(done, 50));
    }
    if (!D.port) throw new Error("上游替身没有起来（没读到端口）");
    return { workDir: D.workDir };
  },
  async disposeContext(ctx) {
    if (D.server) D.server.kill();
    rmSync(ctx.workDir, { recursive: true, force: true });
  },
  async run(ctx, fixture, invoke) {
    const dir = join(D.workDir, "run-" + fixture.id + "-" + Date.now());
    mkdirSync(dir, { recursive: true });
    if (fixture.setup) fixture.setup(dir);
    const args = resolve(fixture.args, ctx) ?? [];
    // env 是 (dir) => {...}：沙箱目录建好之后才能算（值里有 dir 化的 FAKE_DIR / PATH）。
    const extra = typeof fixture.env === "function" ? fixture.env(dir) : (fixture.env ?? {});
    const env = { ...process.env, ...extra };
    const mode = fixture.normalize ?? "none";
    const normalize = (text) =>
      dNormalizeDetail(normalizePaths(String(text ?? ""), dir, "<ROOT>"), mode).split("127.0.0.1:" + D.port).join("127.0.0.1:<PORT>");
    const before = snapshotTree(dir);
    const bodiesBefore = dReadBodies().length;
    const result = spawnSync(invoke.bin, [...invoke.prefix, ...args], { cwd: dir, env, encoding: "utf8", timeout: 120000 });
    const files = normalizeTree(diffTree(before, snapshotTree(dir)), normalize);
    return {
      exitCode: result.status,
      stdout: normalize(result.stdout),
      stderr: normalize(result.stderr),
      files,
      requests: dReadBodies().slice(bodiesBefore),
      argv: [fixture.cmd, ...args].map((one) => normalize(String(one))),
      env: Object.fromEntries(Object.entries(env).filter(([key]) => ["FAKE_DIR", "FAKE_FAIL", "AUDIT_INPUT", "DEEPSEEK_API_KEY"].includes(key)).map(([key, value]) => [key, normalize(String(value))])),
    };
  },
  extras: [
    {
      title: "覆盖：夹具 ≥24 条 / 失败路径 ≥10 条 / 退出码 0·1·2·3 都有",
      run(suite) {
        const codes = new Set(suite.cases.map((one) => one.expectExit));
        if (suite.cases.length < 24) throw new Error("夹具少于 24 条：" + suite.cases.length);
        if (suite.cases.filter((one) => one.expectExit !== 0).length < 10) throw new Error("失败路径少于 10 条");
        for (const code of [0, 1, 2, 3]) if (!codes.has(code)) throw new Error("退出码 " + code + " 没有夹具覆盖");
      },
    },
    {
      title: "已登记的例外只有两条，且都写成了显式归一",
      run(suite) {
        const normalized = [...new Set(suite.cases.filter((one) => one.normalize).map((one) => one.normalize))].sort();
        const want = ["net", "yaml"];
        if (JSON.stringify(normalized) !== JSON.stringify(want))
          throw new Error("例外归一不再是 " + want.join("/") + "：" + normalized.join("/"));
      },
    },
  ],
};

// =====================================================================
// E · copy-dist / cli / kb-export
// =====================================================================

// ---- 后端替身：一个独立进程，按 scenario.json 应答，把收到的请求逐条记账 ----
const SERVER_SOURCE = [
  'import { createServer } from "node:http";',
  'import { appendFileSync, readFileSync, writeFileSync } from "node:fs";',
  'import { join } from "node:path";',
  "const dir = process.env.PARITY_SERVER_DIR;",
  "const server = createServer((req, res) => {",
  "  const chunks = [];",
  '  req.on("data", (chunk) => chunks.push(chunk));',
  '  req.on("end", () => {',
  '    const raw = Buffer.concat(chunks).toString("utf8");',
  '    appendFileSync(join(dir, "requests.jsonl"), JSON.stringify({ method: req.method, url: req.url, body: raw }) + "\\n");',
  "    let scenario = {};",
  "    try {",
  '      scenario = JSON.parse(readFileSync(join(dir, "scenario.json"), "utf8"));',
  "    } catch {",
  "      scenario = {};",
  "    }",
  '    const route = (scenario.routes || {})[req.url] || {};',
  "    const status = route.status === undefined ? 200 : route.status;",
  '    const body = route.body === undefined ? "{}" : route.body;',
  '    res.writeHead(status, { "content-type": route.contentType || "application/json" });',
  '    res.end(typeof body === "string" ? body : JSON.stringify(body));',
  "  });",
  "});",
  'server.listen(0, "127.0.0.1", () => {',
  '  writeFileSync(join(dir, "port.txt"), String(server.address().port));',
  "});",
].join("\n");

const E = { workDir: null, server: null, serverDir: null, port: 0, gitRepo: null, gitFrom: null, gitTo: null, seq: 0 };

const NET_MARK = "连不上后端 ";

const eGit = (args, cwd) =>
  spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    timeout: 120000,
    env: { ...process.env, GIT_AUTHOR_DATE: "2024-01-01T00:00:00 +0000", GIT_COMMITTER_DATE: "2024-01-01T00:00:00 +0000" },
  });

const DIST_TREE = (dir) => {
  mkdirSync(join(dir, "apps", "web-vue", "dist", "assets"), { recursive: true });
  writeFileSync(join(dir, "apps", "web-vue", "dist", "index.html"), "<html>hi</html>\n");
  writeFileSync(join(dir, "apps", "web-vue", "dist", "assets", "app.js"), "console.log(1)\n");
  writeFileSync(join(dir, "apps", "web-vue", "dist", "assets", "app.css"), "body{}\n");
};
const TARGET_TREE = (dir, opts) => {
  mkdirSync(join(dir, "apps", "api-go", "dist"), { recursive: true });
  writeFileSync(join(dir, "apps", "api-go", "dist", "README.md"), "# placeholder\n");
  writeFileSync(join(dir, "apps", "api-go", "dist", ".gitkeep"), "");
  if (opts.stale) {
    writeFileSync(join(dir, "apps", "api-go", "dist", "stale.txt"), "stale\n");
    mkdirSync(join(dir, "apps", "api-go", "dist", "old"), { recursive: true });
    writeFileSync(join(dir, "apps", "api-go", "dist", "old", "gone.js"), "x\n");
  }
};

const BOARD_ITEMS = {
  items: [
    { id: "issue-1", state: "todo", title: "甲", divergence: true },
    { id: "issue-2", state: null, title: "" },
    { id: "issue-3", state: "verify", title: "乙 issue" },
  ],
};
const VERDICT_OK = { id: "issue-1", from: "todo", to: "in_progress", by: "owner" };
const OUTBOX_OK = {
  entries: [
    { attemptId: "attempt-1", item: "issue-1", from: "todo", to: "in_progress", status: "running", attempts: 2 },
    { attemptId: "attempt-2", item: "issue-2", from: "verify", to: "done", status: "queued", attempts: 1 },
  ],
  nextCheckAt: "2026-10-27T00:00:00Z",
};
const VERIFY_RED = {
  exitCode: 1,
  output: Array.from({ length: 25 }, (_, index) => "line-" + String(index + 1)).join("\n"),
};

const EXISTING_MANIFEST = [
  "# 知识库汇入清单 · source_repo=owner/name source_ref=main range=aaa..bbb",
  "# 累积清单：本次区间新增 1 条、继承 0 条、共 1 条",
  "# 每条固定头见 docs/knowledge-base.md；sha256 取 git blob（commit 内的内容字节），不是工作区。",
  "- source_repo: owner/name",
  "  source_ref: main",
  "  commit: " + "0".repeat(40),
  "  path: docs/permissions.md",
  "  sha256: " + "1".repeat(64),
  "  updated_at: 2026-01-01T00:00:00+08:00",
  "",
].join("\n");

const api = () => "http://127.0.0.1:" + String(E.port);

const eCases = [
  // copy-dist：三个（含「没有 dist」的占位分支与「清掉上一轮产物」）
  {
    title: "copy-dist · 把 dist 铺进目标目录",
    cmd: "copy-dist",
    script: "copy-dist.mjs",
    sandboxScript: true,
    setup: (dir) => {
      DIST_TREE(dir);
      TARGET_TREE(dir, { stale: false });
    },
    args: [],
  },
  {
    title: "copy-dist · 清掉上一轮残留产物",
    cmd: "copy-dist",
    script: "copy-dist.mjs",
    sandboxScript: true,
    setup: (dir) => {
      DIST_TREE(dir);
      TARGET_TREE(dir, { stale: true });
    },
    args: [],
  },
  {
    title: "copy-dist · 没有 dist 时走占位分支",
    cmd: "copy-dist",
    script: "copy-dist.mjs",
    sandboxScript: true,
    setup: (dir) => {
      TARGET_TREE(dir, { stale: true });
    },
    args: [],
  },

  // kb-export：成功路径 + 累积/重试 + 五种失败路径
  {
    title: "kb-export · 成功路径写出清单与记录",
    cmd: "kb-export",
    script: "kb-export.mjs",
    args: ["--cwd", "{{REPO}}", "--repo", "owner/name", "--from", "{{FROM}}", "--to", "{{TO}}", "--out", "manifest.yml", "--infra-out", "infra.yml"],
  },
  {
    title: "kb-export · --range 包裹 from..to",
    cmd: "kb-export",
    script: "kb-export.mjs",
    args: ["--cwd", "{{REPO}}", "--repo", "owner/name", "--range", "{{FROM}}..{{TO}}", "--ref", "develop"],
  },
  { title: "kb-export · --help", cmd: "kb-export", script: "kb-export.mjs", args: ["--help"] },
  {
    title: "kb-export · 没有仓库名 -> 报错",
    cmd: "kb-export",
    script: "kb-export.mjs",
    env: { GITHUB_REPOSITORY: "" },
    args: ["--cwd", "{{REPO}}", "--from", "{{FROM}}", "--to", "{{TO}}"],
  },
  {
    title: "kb-export · --range 形状不对 -> 报错",
    cmd: "kb-export",
    script: "kb-export.mjs",
    args: ["--cwd", "{{REPO}}", "--repo", "owner/name", "--range", "abc"],
  },
  {
    title: "kb-export · 多余的位置参数 -> 报错",
    cmd: "kb-export",
    script: "kb-export.mjs",
    args: ["--cwd", "{{REPO}}", "--repo", "owner/name", "--from", "{{FROM}}", "--to", "{{TO}}", "stray"],
  },
  { title: "kb-export · 取值参数缺值 -> 报错", cmd: "kb-export", script: "kb-export.mjs", args: ["--cwd", "{{REPO}}", "--repo"] },
  {
    title: "kb-export · 继承已有清单",
    cmd: "kb-export",
    script: "kb-export.mjs",
    setup: (dir) => writeFileSync(join(dir, "existing.yml"), EXISTING_MANIFEST),
    args: [
      "--cwd", "{{REPO}}", "--repo", "owner/name", "--from", "{{FROM}}", "--to", "{{TO}}",
      "--existing", "existing.yml", "--out", "manifest.yml", "--infra-out", "infra.yml",
    ],
  },
  {
    title: "kb-export · --require-existing 但存档不存在 -> 报错",
    cmd: "kb-export",
    script: "kb-export.mjs",
    args: [
      "--cwd", "{{REPO}}", "--repo", "owner/name", "--from", "{{FROM}}", "--to", "{{TO}}",
      "--existing", "nope.yml", "--require-existing", "--out", "manifest.yml", "--infra-out", "infra.yml",
    ],
  },
  {
    title: "kb-export · --retry 只重跑失败项",
    cmd: "kb-export",
    script: "kb-export.mjs",
    setup: (dir) =>
      writeFileSync(
        join(dir, "retry.yml"),
        ["kind: infra", "retry_paths:", "  - docs/architecture.md", "  - docs/postmortem/p1.md", "failures: []", ""].join("\n"),
      ),
    args: [
      "--cwd", "{{REPO}}", "--repo", "owner/name", "--from", "{{FROM}}", "--to", "{{TO}}",
      "--retry", "retry.yml", "--out", "manifest.yml", "--infra-out", "infra.yml",
    ],
  },

  // cli：五个命令 + 后端错误面 + 用法错误面
  { title: "cli · --help", cmd: "cli", script: "cli.mjs", args: ["--help"] },
  {
    title: "cli · board 渲染看板",
    cmd: "cli",
    script: "cli.mjs",
    scenario: { routes: { "/api/board": { body: BOARD_ITEMS } } },
    args: () => ["board", "--api", api()],
  },
  {
    title: "cli · board --json",
    cmd: "cli",
    script: "cli.mjs",
    scenario: { routes: { "/api/board": { body: BOARD_ITEMS } } },
    args: () => ["board", "--json", "--api", api()],
  },
  {
    title: "cli · board 没有 items 字段",
    cmd: "cli",
    script: "cli.mjs",
    scenario: { routes: { "/api/board": { body: {} } } },
    args: () => ["board", "--api", api()],
  },
  {
    title: "cli · new 建单",
    cmd: "cli",
    script: "cli.mjs",
    scenario: { routes: { "/api/item": { body: { id: "issue-9", to: "todo" } } } },
    args: () => ["new", "标题 甲", "--body", "正文", "--api", api()],
  },
  {
    title: "cli · verdict 带两条守卫",
    cmd: "cli",
    script: "cli.mjs",
    scenario: { routes: { "/api/verdict": { body: VERDICT_OK } } },
    args: () => [
      "verdict", "--id", "issue-1", "--to", "in_progress",
      "--guard", "review=PR#12 approved", "--guard", "tests=vitest 全绿",
      "--comment", "开始做", "--api", api(),
    ],
  },
  {
    title: "cli · verdict 缺 --to -> 用法错",
    cmd: "cli",
    script: "cli.mjs",
    args: ["verdict", "--id", "issue-1"],
  },
  {
    title: "cli · verdict 守卫形状不对 -> 用法错",
    cmd: "cli",
    script: "cli.mjs",
    args: ["verdict", "--id", "issue-1", "--to", "done", "--guard", "nope"],
  },
  { title: "cli · 认不出的选项", cmd: "cli", script: "cli.mjs", args: ["board", "--nope", "x"] },
  { title: "cli · new 给了两个标题", cmd: "cli", script: "cli.mjs", args: ["new", "甲", "乙"] },
  {
    title: "cli · verify 变红",
    cmd: "cli",
    script: "cli.mjs",
    scenario: { routes: { "/api/verify": { body: VERIFY_RED } } },
    args: () => ["verify", "--api", api()],
  },
  {
    title: "cli · verify 的 exitCode 不是数字",
    cmd: "cli",
    script: "cli.mjs",
    scenario: { routes: { "/api/verify": { body: { exitCode: "1" } } } },
    args: () => ["verify", "--api", api()],
  },
  {
    title: "cli · outbox 有积压",
    cmd: "cli",
    script: "cli.mjs",
    scenario: { routes: { "/api/outbox": { body: OUTBOX_OK } } },
    args: () => ["outbox", "--api", api()],
  },
  {
    title: "cli · outbox 空",
    cmd: "cli",
    script: "cli.mjs",
    scenario: { routes: { "/api/outbox": { body: { entries: [], nextCheckAt: null } } } },
    args: () => ["outbox", "--api", api()],
  },
  {
    title: "cli · 后端拒绝（rejected）",
    cmd: "cli",
    script: "cli.mjs",
    scenario: {
      routes: { "/api/verdict": { status: 400, body: { kind: "rejected", code: "ILLEGAL_TRANSITION", message: "这条转换不允许" } } },
    },
    args: () => ["verdict", "--id", "issue-1", "--to", "done", "--api", api()],
  },
  {
    title: "cli · 后端故障（infra）",
    cmd: "cli",
    script: "cli.mjs",
    scenario: { routes: { "/api/board": { status: 500, body: { message: "账本读不动" } } } },
    args: () => ["board", "--api", api()],
  },
  {
    title: "cli · 后端回的不是 JSON",
    cmd: "cli",
    script: "cli.mjs",
    scenario: { routes: { "/api/board": { body: "不是 JSON" } } },
    args: () => ["board", "--api", api()],
  },
  {
    // 一个肯定没人听的端口：网络栈文案随实现而变，是登记在案的例外。
    title: "cli · 连不上后端（网络栈文案已登记为例外）",
    cmd: "cli",
    script: "cli.mjs",
    args: ["board", "--api", "http://127.0.0.1:1"],
  },
  { title: "cli · --api 协议不支持", cmd: "cli", script: "cli.mjs", args: ["board", "--api", "ftp://example.com"] },
];

const expand = (value) =>
  String(value)
    .split("{{REPO}}")
    .join(E.gitRepo)
    .split("{{FROM}}")
    .join(E.gitFrom)
    .split("{{TO}}")
    .join(E.gitTo);

const writeScenario = (scenario) => writeFileSync(join(E.serverDir, "scenario.json"), JSON.stringify(scenario));
const clearRequests = () => rmSync(join(E.serverDir, "requests.jsonl"), { force: true });
const readRequests = () => {
  const file = join(E.serverDir, "requests.jsonl");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line));
};

export const suiteE = {
  id: "e",
  title: "engine parity · copy-dist / cli / kb-export（对照冻结 golden）",
  cases: assignIds(eCases, "e"),
  async createContext() {
    E.workDir = realpathSync(mkdtempSync(join(tmpdir(), "engine-parity-e-")));

    // 一个带两个 commit 的临时仓库：kb-export 只读它。
    // 提交时间固定 —— 否则 SHA 每次不同，golden 带不上真值。
    E.gitRepo = join(E.workDir, "gitrepo");
    mkdirSync(join(E.gitRepo, "docs", "postmortem"), { recursive: true });
    mkdirSync(join(E.gitRepo, ".agents", "notes", "implemented"), { recursive: true });
    mkdirSync(join(E.gitRepo, "node_modules", "pkg"), { recursive: true });
    mkdirSync(join(E.gitRepo, "apps", "web-vue"), { recursive: true });
    writeFileSync(join(E.gitRepo, "docs", "architecture.md"), "arch v1\n");
    writeFileSync(join(E.gitRepo, "README.md"), "# top readme\n");
    writeFileSync(join(E.gitRepo, ".agents", "notes", "implemented", "n1.md"), "note one\n");
    writeFileSync(join(E.gitRepo, ".env"), "SECRET=1\n");
    writeFileSync(join(E.gitRepo, "node_modules", "pkg", "README.md"), "x\n");
    writeFileSync(join(E.gitRepo, "apps", "web-vue", "keep.txt"), "k\n");
    eGit(["init", "-q", "-b", "main", "."], E.gitRepo);
    eGit(["config", "user.email", "t@example.com"], E.gitRepo);
    eGit(["config", "user.name", "t"], E.gitRepo);
    eGit(["add", "-A"], E.gitRepo);
    eGit(["commit", "-qm", "c1"], E.gitRepo);
    E.gitFrom = eGit(["rev-parse", "HEAD"], E.gitRepo).stdout.trim();
    writeFileSync(join(E.gitRepo, "docs", "architecture.md"), "arch v2\n");
    writeFileSync(join(E.gitRepo, ".agents", "notes", "implemented", "n1.md"), "note two\n");
    writeFileSync(join(E.gitRepo, "docs", "postmortem", "p1.md"), "p1\n");
    writeFileSync(join(E.gitRepo, "node_modules", "pkg", "README.md"), "y\n");
    eGit(["add", "-A"], E.gitRepo);
    eGit(["commit", "-qm", "c2"], E.gitRepo);
    E.gitTo = eGit(["rev-parse", "HEAD"], E.gitRepo).stdout.trim();

    E.serverDir = join(E.workDir, "server");
    mkdirSync(E.serverDir, { recursive: true });
    const serverScript = join(E.workDir, "backend.mjs");
    writeFileSync(serverScript, SERVER_SOURCE);
    const { spawn } = await import("node:child_process");
    E.server = spawn(process.execPath, [serverScript], {
      env: { ...process.env, PARITY_SERVER_DIR: E.serverDir },
      stdio: "ignore",
    });
    const portFile = join(E.serverDir, "port.txt");
    for (let attempt = 0; attempt < 200; attempt += 1) {
      try {
        const text = readFileSync(portFile, "utf8").trim();
        if (text) {
          E.port = Number(text);
          break;
        }
      } catch {
        // 还没写好，继续等
      }
      await new Promise((done) => setTimeout(done, 50));
    }
    if (!E.port) throw new Error("后端替身没有起来（没读到端口）");
    return { workDir: E.workDir };
  },
  async disposeContext(ctx) {
    if (E.server) E.server.kill();
    rmSync(ctx.workDir, { recursive: true, force: true });
  },
  async run(ctx, fixture, invoke) {
    E.seq += 1;
    const dir = join(E.workDir, "case-" + fixture.id + "-" + E.seq);
    mkdirSync(dir, { recursive: true });
    if (fixture.setup) fixture.setup(dir);
    if (invoke.prepareRun) invoke.prepareRun(dir);
    if (fixture.scenario !== undefined) writeScenario(fixture.scenario);
    const args = (resolve(fixture.args, ctx) ?? []).map(expand);
    const extra = typeof fixture.env === "function" ? fixture.env(dir) : (fixture.env ?? {});
    const env = { ...process.env, ...extra };
    const normalize = (text) => {
      let out = normalizePaths(String(text === undefined || text === null ? "" : text), dir, "<DIR>");
      out = out.split(E.gitRepo).join("<REPO>").split("127.0.0.1:" + E.port).join("127.0.0.1:<PORT>");
      const at = out.indexOf(NET_MARK);
      if (at === -1) return out;
      const lineEnd = out.indexOf("\n", at);
      const head = out.slice(at, out.indexOf(": ", at) + 2);
      return out.slice(0, at) + head + "<DETAIL>" + out.slice(lineEnd === -1 ? out.length : lineEnd);
    };
    const before = snapshotTree(dir);
    if (fixture.scenario !== undefined) clearRequests();
    const prefix = typeof invoke.prefix === "function" ? invoke.prefix(dir) : invoke.prefix;
    const result = spawnSync(invoke.bin, [...prefix, ...args], { cwd: dir, env, encoding: "utf8", timeout: 120000 });
    return {
      exitCode: result.status,
      stdout: normalize(result.stdout),
      stderr: normalize(result.stderr),
      files: normalizeTree(diffTree(before, snapshotTree(dir)), normalize),
      requests: fixture.scenario === undefined ? [] : readRequests(),
      argv: [fixture.cmd, ...args].map((one) => normalize(String(one))),
      env: Object.fromEntries(Object.entries(extra).map(([key, value]) => [key, normalize(String(value))])),
    };
  },
  extras: [
    {
      // 这三条不比对 golden，而是把「引擎真的干活了」写成对 Go 侧实际产物的断言：
      // 空对照（两边都没跑）也能让逐字节比对全绿，只有这些断言挡得住。
      title: "kb-export 真的产出了清单与记录",
      async run({ runCase, findCase }) {
        const actual = await runCase(findCase("kb-export · 成功路径写出清单与记录"));
        const manifest = actual.files.find((one) => one.path === "manifest.yml");
        const infra = actual.files.find((one) => one.path === "infra.yml");
        if (!manifest || !infra) throw new Error("kb-export 没有写出 manifest.yml / infra.yml");
        for (const want of ["path: docs/architecture.md", "path: docs/postmortem/p1.md"])
          if (!String(manifest.text ?? "").includes(want)) throw new Error("manifest.yml 里没有 " + want);
        if (!String(infra.text ?? "").includes("kind: ok")) throw new Error("infra.yml 里没有 kind: ok");
        if (actual.exitCode !== 0) throw new Error("kb-export 退出码不是 0：" + actual.exitCode);
      },
    },
    {
      title: "copy-dist 真的把 dist 铺进了目标目录",
      async run({ runCase, findCase }) {
        const actual = await runCase(findCase("copy-dist · 把 dist 铺进目标目录"));
        const files = new Map(actual.files.map((one) => [one.path, one.text ?? one.base64]));
        const want = new Map([
          ["apps/api-go/dist/index.html", "<html>hi</html>\n"],
          ["apps/api-go/dist/assets/app.css", "body{}\n"],
        ]);
        // .gitkeep 跑前就在、跑后没变，所以它不进「这次写了什么」的差异清单；
        // 它没被清掉这件事由「一条删除都没有」来钉（删除会以 deleted:true 出现在差异里）。
        const removed = actual.files.filter((one) => one.deleted).map((one) => one.path);
        if (removed.length) throw new Error("copy-dist 删掉了不该删的文件：" + removed.join(", "));
        for (const [path, text] of want) {
          if (!files.has(path)) throw new Error("没有写出 " + path);
          if (files.get(path) !== text) throw new Error(path + " 内容不对：" + JSON.stringify(files.get(path)));
        }
      },
    },
    {
      title: "cli 真的发了请求（请求体里是调用方给的那份守卫证据）",
      async run({ runCase, findCase }) {
        const actual = await runCase(findCase("cli · verdict 带两条守卫"));
        if (actual.requests.length !== 1) throw new Error("请求条数不是 1：" + actual.requests.length);
        if (actual.requests[0].url !== "/api/verdict") throw new Error("请求路径不是 /api/verdict：" + actual.requests[0].url);
        const body = JSON.parse(actual.requests[0].body);
        if (JSON.stringify(body.guards) !== JSON.stringify({ review: "PR#12 approved", tests: "vitest 全绿" }))
          throw new Error("guards 不对：" + JSON.stringify(body.guards));
        if (body.actor_role !== "owner") throw new Error("actor_role 不是 owner：" + String(body.actor_role));
      },
    },
  ],
};

export const suites = { a: suiteA, b: suiteB, c: suiteC, d: suiteD, e: suiteE };
