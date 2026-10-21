#!/usr/bin/env node
// merge-gate.mjs · 合并资格的机械判定（四条守卫）
//
// 判决与执行分离：本脚本只判定「这一笔能不能合」，不合并 PR、不改 issue 状态、
// 不写门牌。判据全部来自注入的输入 —— 脚本里没有任何网络调用，所以四守卫能被单测，
// 尤其 G3（最容易被「看起来绿」骗过的一条）。
//
// 四条守卫各自独立失败：
//   G1 issue-state     门关联 issue 当前状态，是否允许因「合并」进入 done
//                      —— 状态规则不在本文件：调 state-validate.mjs 的判定函数
//   G2 refs-and-files  PR 正文恰好引用一个 issue，且门牌列的变更文件在 head 上真实存在
//                      —— 引用解析复用 build-intent.mjs 的 resolveIssueRefs，门牌靠 git cat-file 取证
//   G3 checks          PR head 的 check runs 全绿，且没有未结 INFRA
//                      —— 上游 JSON 注入，同名多次运行只看最新一次（旧绿不给新红背书）
//   G4 last-change     门牌写着本 PR 编号 —— 表格格式复用 last-change.mjs 的渲染器
//
// 退出码沿用平台三分（.agents/notes/implemented/platform-design-baseline.md 三）：
//   0 允许合并（四条全过）· 1 拒绝（至少一条失败，stdout 指名是哪条、为什么）
//   3 INFRA（配置或输入不可判定、检查项根本没跑 —— 绝不当通过）
//
// Check 名是 workflow 的 job 名 merge-gate：GitHub 用退出码判红绿，非零即红。
// stdout 每行一个判定（判据本身）；stderr 只放意外错误，不做调试输出。

import { spawnSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolveIssueRefs } from "./build-intent.mjs";
import {
  BLOCK_BEGIN,
  BLOCK_END,
  renderLastChange,
} from "./last-change.mjs";
import { loadConfig, validateIntent } from "./state-validate.mjs";

const CHECK = "merge-gate";
const DEFAULT_CONFIG = ".agents/platform/state-machine.yml";

class Fail extends Error {
  constructor(kind, code, message) {
    super(message);
    this.kind = kind;
    this.code = code;
  }
}
const infra = (code, message) => new Fail("infra", code, message);
const reject = (code, message) => new Fail("rejected", code, message);

const short = (sha) => String(sha ?? "").slice(0, 7);

function arg(argv, name) {
  const at = argv.indexOf(name);
  return at === -1 ? undefined : argv[at + 1];
}

function readText(path, what) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    throw infra("E_INPUT_MISSING", `读不到${what}: ${path}`);
  }
}

function readJson(path, what) {
  if (!path)
    throw infra(
      "E_INPUT_MISSING",
      `没有提供${what}：取不到数就是 INFRA，不当通过`,
    );
  const raw = readText(path, what);
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw infra("E_INPUT_UNPARSABLE", `${what} 不是合法 JSON: ${error.message}`);
  }
}

// PR 引用的 issue：body 优先，body 一个都没写才看 title —— 与 build-intent.mjs 的
// resolvePrIssue、last-change.mjs 的 resolveIssue 同一规则（引用解析只有一个家）。
// 0 个或 ≥2 个都算解不出：不猜（P-04 的口径）。
function resolvePrIssue(pr) {
  const inBody = resolveIssueRefs(pr.body ?? "");
  const refs = inBody.length > 0 ? inBody : resolveIssueRefs(pr.title ?? "");
  if (refs.length !== 1)
    throw reject(
      "E_ISSUE_REFS",
      `PR 必须引用恰好一个 issue（如 Fixes #4），实际 ${refs.length} 个: ${JSON.stringify(refs)}`,
    );
  return refs[0];
}

// ---- 门牌：格式的家是 last-change.mjs 的渲染器，本文件不复制那份格式 ----

// 探针值都带唯一标记，用来在渲染结果里认出「PR 行」「变更文件行」是第几行。
const PROBE = {
  pr: 424242,
  issue: 4,
  title: "t",
  proposer: "p",
  reviewers: [],
  files: ["__probe__.mjs"],
  mergedBy: null,
  mergedAt: null,
};

function cells(line) {
  const parts = String(line).split(/(?<!\\)\|/);
  return parts.slice(1, -1).map((s) => s.trim());
}

let SHAPE;
function shape() {
  if (SHAPE) return SHAPE;
  const rows = renderLastChange(PROBE).split("\n").slice(2); // 表头 + 分隔行之后才是数据行
  const at = (needle) => {
    const i = rows.findIndex((line) => (cells(line)[1] ?? "").includes(needle));
    if (i === -1)
      throw infra(
        "E_LAST_CHANGE_FORMAT",
        `last-change.mjs 的渲染结果里找不到 ${needle}`,
      );
    return i;
  };
  SHAPE = { rows: rows.length, pr: at("#424242"), files: at("`__probe__.mjs`") };
  return SHAPE;
}

function lastChange(text) {
  const begin = text.indexOf(BLOCK_BEGIN);
  const end = text.indexOf(BLOCK_END);
  if (begin === -1 || end < begin)
    throw reject(
      "E_LAST_CHANGE_MISSING",
      "PR 正文没有 LAST-CHANGE 节：门牌缺失，无从判定",
    );
  const lines = text
    .slice(begin + BLOCK_BEGIN.length, end)
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  const s = shape();
  const rows = lines.slice(2);
  if (rows.length !== s.rows)
    throw reject(
      "E_LAST_CHANGE_SHAPE",
      `门牌表格 ${rows.length} 行，last-change.mjs 的模板 ${s.rows} 行：门牌不是派生物`,
    );
  const pr = cells(rows[s.pr])[1] ?? "";
  const files = [
    ...(cells(rows[s.files])[1] ?? "").matchAll(/`([^`]+)`/g),
  ].map((m) => m[1].replace(/\\\|/g, "|"));
  if (files.length === 0)
    throw reject(
      "E_LAST_CHANGE_FILES",
      "门牌没列变更文件：它比实际少，就是在撒谎",
    );
  return { pr, files };
}

// 门牌是派生物：它列的文件必须能被 git 证明存在于 head，否则门牌在撒谎。
// 两次都只看退出码、不解析 git 的文案（文案会跟 locale 变，退出码不会）。
// 先证明 commit 取得到，再问路径在不在：前者失败是 INFRA，后者失败只是「文件不在」。
function gitOk(args, repo) {
  const r = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
  if (r.error)
    throw infra("E_GIT_UNAVAILABLE", `无法执行 git: ${r.error.message}`);
  return { ok: r.status === 0, status: r.status, err: String(r.stderr ?? "").trim() };
}

function existsAt(head, path, repo) {
  const commit = gitOk(["cat-file", "-e", `${head}^{commit}`], repo);
  if (!commit.ok)
    throw infra(
      "E_GIT_FAILED",
      `取不到 commit ${head}（git 退出 ${commit.status}）：${commit.err}`,
    );
  return gitOk(["cat-file", "-e", `${head}:${path}`], repo).ok;
}

// ---- 四条守卫 ----

function guardIssueState(ctx) {
  const cfg = loadConfig(ctx.configPath);
  const labels = (ctx.issue.labels ?? [])
    .map((l) => (typeof l === "string" ? l : l?.name))
    .filter(Boolean);
  // 状态规则不在这里：整条意图交给 state-validate 判定。两处规则就是两个真相源，
  // 改一处另一处就会撒谎。
  const result = validateIntent(cfg, {
    issue: ctx.issue.number,
    to: "done",
    actor_role: "ci",
    labels,
  });
  return `issue #${ctx.issue.number} ${result.from} → ${result.to}（${result.by}）`;
}

function guardIssueAndFiles(ctx) {
  const ref = resolvePrIssue(ctx.pr);
  if (ref !== ctx.issue.number)
    throw reject(
      "E_ISSUE_REF_MISMATCH",
      `PR 引用的是 #${ref}，本次判定的 issue 是 #${ctx.issue.number}：门挂错了 issue`,
    );
  const { files } = lastChange(ctx.body);
  const missing = files.filter((f) => !existsAt(ctx.head, f, ctx.repo));
  if (missing.length)
    throw reject(
      "E_FILE_MISSING",
      `门牌列的 ${missing.length} 个文件在 ${short(ctx.head)} 上不存在: ${missing.join(", ")}`,
    );
  return `issue #${ref}，门牌 ${files.length} 个文件在 ${short(ctx.head)} 上存在`;
}

function normalizeInfra(input) {
  const list = Array.isArray(input) ? input : input?.unresolved;
  if (!Array.isArray(list))
    throw infra("E_INFRA_SHAPE", "INFRA 输入应为数组或 { unresolved: [...] }");
  return list;
}

function guardChecks(ctx) {
  const runs = Array.isArray(ctx.checks) ? ctx.checks : ctx.checks?.check_runs;
  if (!Array.isArray(runs))
    throw infra(
      "E_CHECKS_SHAPE",
      "check runs 输入应为数组或 { check_runs: [...] }",
    );
  // 检查没跑 ≠ 绿：没有检查项就判不出资格，走 INFRA 而不是放行。
  if (runs.length === 0)
    throw infra(
      "E_CHECKS_EMPTY",
      `上游没有为 ${short(ctx.head)} 报告任何 check run：检查没跑不等于绿`,
    );
  // 同名多次运行（重跑 / 重推）只看最新一次（id 递增）：
  // 旧的成功不能替新的失败背书，这正是「看起来绿」的典型形状。
  const latest = new Map();
  for (const run of runs) {
    const prev = latest.get(run?.name);
    if (!prev || Number(run?.id ?? 0) >= Number(prev?.id ?? 0))
      latest.set(run?.name, run);
  }
  const all = [...latest.values()];
  const stale = all.filter((r) => r.head_sha && r.head_sha !== ctx.head);
  if (stale.length)
    throw reject(
      "E_CHECK_STALE",
      `这些检查项不是 ${short(ctx.head)} 的: ${stale.map((r) => r.name).join(", ")}`,
    );
  const bad = all.filter(
    (r) => !(r.status === "completed" && r.conclusion === "success"),
  );
  if (bad.length)
    throw reject(
      "E_CHECK_NOT_GREEN",
      `不是绿的 ${bad.length} 项: ${bad
        .map((r) => `${r.name}(id ${r.id}) ${r.status}/${r.conclusion}`)
        .join(", ")}`,
    );
  const open = normalizeInfra(ctx.infra);
  if (open.length)
    throw reject(
      "E_INFRA_OPEN",
      `还有 ${open.length} 条未结 INFRA: ${open
        .map((i) => i?.id ?? JSON.stringify(i))
        .join(", ")}`,
    );
  return `${all.length} 项全绿（同名取最新），无未结 INFRA`;
}

function guardLastChangePr(ctx) {
  const { pr } = lastChange(ctx.body);
  const m = /^#(\d+)$/.exec(pr);
  if (!m)
    throw reject(
      "E_LAST_CHANGE_PR",
      `门牌的 PR 格是 ${JSON.stringify(pr)}，不是 #<号>`,
    );
  if (Number(m[1]) !== ctx.pr.number)
    throw reject(
      "E_PR_MISMATCH",
      `门牌写的 PR 是 #${m[1]}，本 PR 是 #${ctx.pr.number}：门牌不是这次变更的`,
    );
  return `门牌 PR #${m[1]} = 本 PR #${ctx.pr.number}`;
}

// 判定器的 Fail 与这里的是两个类（各在各的文件里，互不依赖）：
// 按形状认它 —— kind 决定 verdict、code 与 message 直接进报告。
const isVerdict = (error) =>
  Boolean(error) &&
  (error.kind === "infra" || error.kind === "rejected") &&
  typeof error.code === "string";

// 一条守卫抛 Fail 只让自己红：别的守卫照跑，输出能一次说清坏了几条。
function runGuard(id, title, body) {
  try {
    return { id, title, verdict: "PASS", code: "OK", detail: body() };
  } catch (error) {
    if (!isVerdict(error)) throw error;
    return {
      id,
      title,
      verdict: error.kind === "infra" ? "INFRA" : "FAIL",
      code: error.code,
      detail: error.message,
    };
  }
}

// ---- 输入与出口 ----

function collect(argv) {
  const eventPath = arg(argv, "--event");
  const raw = eventPath
    ? readText(eventPath, "事件输入（--event）")
    : (process.env.EVENT ?? "");
  if (!String(raw).trim())
    throw infra("E_EVENT_MISSING", "没有事件输入：--event <file> 或 EVENT 环境变量");
  let event;
  try {
    event = JSON.parse(raw);
  } catch (error) {
    throw infra("E_EVENT_UNPARSABLE", `事件不是合法 JSON: ${error.message}`);
  }
  const pr = event?.pull_request;
  if (!pr || typeof pr !== "object" || typeof pr.number !== "number")
    throw infra(
      "E_EVENT_SHAPE",
      "事件里没有 pull_request.number：gate 只判 PR 的合并资格",
    );
  const head = arg(argv, "--head") ?? pr.head?.sha ?? "";
  if (!head)
    throw infra(
      "E_HEAD_MISSING",
      "事件里没有 pull_request.head.sha，--head 也没给：无从判定文件在哪个 commit 上",
    );
  return {
    pr,
    body: String(pr.body ?? ""),
    head,
    repo: arg(argv, "--repo") ?? process.cwd(),
    configPath: arg(argv, "--config") ?? DEFAULT_CONFIG,
  };
}

function report(ctx, results) {
  const out = (line) => process.stdout.write(line + "\n");
  out(`${CHECK} PR #${ctx.pr.number} @ ${short(ctx.head)}`);
  for (const r of results)
    out(`${CHECK} ${r.id} ${r.title} ${r.verdict} ${r.code} ${r.detail}`);
  const bad = results.filter((r) => r.verdict !== "PASS");
  if (bad.length === 0) {
    out(`${CHECK} PASS ${results.length}/${results.length}`);
    process.exit(0);
  }
  const infraHit = bad.some((r) => r.verdict === "INFRA");
  out(
    `${CHECK} ${infraHit ? "INFRA" : "FAIL"} ${bad.length}/${results.length} ${bad
      .map((r) => r.id)
      .join(",")}`,
  );
  process.exit(infraHit ? 3 : 1);
}

function main(argv) {
  try {
    const ctx = collect(argv);
    // 取数分两段：workflow 要先知道 issue 号才取得到 issue 的 label。
    // 这里只公布脚本自己解析出来的事实，不让 YAML 再写一遍引用正则。
    if (argv.includes("--print-issue")) {
      process.stdout.write(`${resolvePrIssue(ctx.pr)}\n`);
      process.exit(0);
    }
    ctx.issue = readJson(arg(argv, "--issue"), "issue 输入（--issue）");
    ctx.checks = readJson(arg(argv, "--checks"), "check runs 输入（--checks）");
    ctx.infra = readJson(arg(argv, "--infra"), "INFRA 记录（--infra）");
    if (typeof ctx.issue?.number !== "number")
      throw infra("E_ISSUE_SHAPE", "issue 输入缺少 number");
    report(ctx, [
      runGuard("G1", "issue-state", () => guardIssueState(ctx)),
      runGuard("G2", "refs-and-files", () => guardIssueAndFiles(ctx)),
      runGuard("G3", "checks", () => guardChecks(ctx)),
      runGuard("G4", "last-change", () => guardLastChangePr(ctx)),
    ]);
  } catch (error) {
    if (!isVerdict(error)) throw error;
    process.stdout.write(`${CHECK} ${error.code} ${error.message}\n`);
    process.exit(error.kind === "infra" ? 3 : 1);
  }
}

// 入口判定走 realpath：检出目录可能是符号链接（worktree、npm link、CI 的挂载点），
// 那时 argv[1] 与 import.meta.url 不是同一条字面路径。判不中不是报错而是静默不判定、
// 退出 0 —— 对门来说这是最坏的失败形态（看起来绿），所以这里必须认得出自己。
const invoked = process.argv[1]
  ? realpathSync(process.argv[1])
  : undefined;
if (invoked === realpathSync(fileURLToPath(import.meta.url))) main(process.argv.slice(2));
