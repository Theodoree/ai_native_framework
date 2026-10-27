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
//                      —— 「判成不合格」与「没有判过」分成两档（见 guardChecks）
//   G4 last-change     门牌写着本 PR 编号 —— 表格格式复用 last-change.mjs 的渲染器
//
// 「拒绝」与「未就绪」是两件事，退出码必须分开（真 PR 上四条同红时读不出根因，就是
// 因为两者被混成一种红）：
//   FAIL    = 这一笔本身不合格（issue 状态不允许、门牌撒谎、检查项 failure/cancelled…）
//   INFRA   = 现在还判不了：门牌的生产者还没写完、别家检查还在跑、输入取不到、
//             审计报 INFRA（action_required）、有未结 INFRA 记录
// 所有「未就绪」的判定一律 exit 3、绝不当通过；stdout 的汇总行把两者分开计数。
// 「没有判过」与「判成不合格」都阻断合并（required check 只有 success/failure 两档，
// 平台没有第三态放行），区别只在责任方向：前者去看管线，后者去改代码。
//
// 门的结论必须建立在「门牌已由生产者写完」之后。生产者的完成信号是它自己的 check run
// （last-change 的 job 名，脚本常量 PRODUCER）：job 完成 ⟹ 写回步骤已经跑完。只在生产者
// 之后的正文上判定 —— 不靠睡一觉碰运气，也绝不把「门牌缺失」判成通过。
// 宿主事件里的 pull_request.body 是事件发生那一刻的快照，生产者写回后不会回填，
// 所以正文另有 --pr 输入（workflow 现场取的最新 PR 现况）；缺了它，等多久都读到旧正文。
//
// 退出码沿用平台三分（.agents/notes/implemented/platform-design-baseline.md 三）：
//   0 允许合并（四条全过）· 1 拒绝（至少一条 FAIL；未就绪的也一并列出）
//   3 INFRA（一条 FAIL 都没有，但还判不了 —— 绝不当通过）
//
// Check 名是 workflow 的 job 名 merge-gate：GitHub 用退出码判红绿，非零即红。
// stdout 每行一个判定（判据本身）；stderr 只放意外错误，不做调试输出。

import { spawnSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolveIssueRefs } from "./build-intent.mjs";
import { BLOCK_BEGIN, BLOCK_END, renderLastChange } from "./last-change.mjs";
import { consultTransition, loadConfig } from "./state-validate.mjs";

const CHECK = "merge-gate";
const DEFAULT_CONFIG = ".agents/platform/state-machine.yml";
// 门牌的生产者 = last-change workflow 的 job 名。它的 check run 完成 ⟹ 写回步骤已跑完，
// 门牌此刻才可信。名字是跨 workflow 的契约：workflow 名不等于 job 名，挂在 check_runs
// 里的是 job 名，所以这里要 job 名；测试钉住它与 last-change.yml 的 job 键一致。
const PRODUCER = "render";
const PENDING_WORD = "未就绪";

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
    throw infra(
      "E_INPUT_UNPARSABLE",
      `${what} 不是合法 JSON: ${error.message}`,
    );
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
  SHAPE = {
    rows: rows.length,
    pr: at("#424242"),
    files: at("`__probe__.mjs`"),
  };
  return SHAPE;
}

function lastChange(text) {
  const begin = text.indexOf(BLOCK_BEGIN);
  const end = text.indexOf(BLOCK_END);
  // 门牌缺失不是「这一笔不合格」，是「上游还没写好」：生产者没写、写失败、或者
  // 本进程读到的是旧快照。判成拒绝等于把别人的未完成记在 PR 头上，也让读者去追错方向。
  if (begin === -1 || end < begin)
    throw infra(
      "E_LAST_CHANGE_MISSING",
      "PR 正文没有 LAST-CHANGE 节：门牌还没写完，等 last-change 生产者写回后再判",
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
  const files = [...(cells(rows[s.files])[1] ?? "").matchAll(/`([^`]+)`/g)].map(
    (m) => m[1].replace(/\\\|/g, "|"),
  );
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
  return {
    ok: r.status === 0,
    status: r.status,
    err: String(r.stderr ?? "").trim(),
  };
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

// ---- 上游就绪：判定只能在生产者之后发生 ----

function checkRuns(ctx) {
  const runs = Array.isArray(ctx.checks) ? ctx.checks : ctx.checks?.check_runs;
  if (!Array.isArray(runs))
    throw infra(
      "E_CHECKS_SHAPE",
      "check runs 输入应为数组或 { check_runs: [...] }",
    );
  return runs;
}

// 同名多次运行（重跑 / 重推）只看 id 最大的一次：旧的成功不能替新的失败背书，
// 这正是「看起来绿」的典型形状。
const newest = (list) =>
  list.reduce((a, b) => (Number(b?.id ?? 0) >= Number(a?.id ?? 0) ? b : a));

// 生产者的完成信号就是它自己的 check run（job 完成 ⟹ 写回步骤已经跑过）。
// 没出现 / 还在跑 = 门牌可能是旧的或半截 → 未就绪；生产者自己红了 = 这次没写成。
function assertProducerSettled(ctx) {
  const mine = checkRuns(ctx).filter((r) => r?.name === ctx.producer);
  if (mine.length === 0)
    throw infra(
      "E_LAST_CHANGE_PENDING",
      `生产者 ${ctx.producer} 还没在 ${short(ctx.head)} 上出现：门牌可能还没开始写，不判`,
    );
  const run = newest(mine);
  if (run.status !== "completed")
    throw infra(
      "E_LAST_CHANGE_PENDING",
      `生产者 ${ctx.producer}(id ${run?.id}) 还在 ${run.status}：门牌写到一半不判`,
    );
  if (run.conclusion !== "success")
    throw infra(
      "E_LAST_CHANGE_FAILED",
      `生产者 ${ctx.producer}(id ${run?.id}) ${run.status}/${run.conclusion}：门牌这次没写成，先修生产者再判`,
    );
  return run;
}

// ---- 四条守卫 ----

function guardIssueState(ctx) {
  const cfg = loadConfig(ctx.configPath);
  const labels = (ctx.issue.labels ?? [])
    .map((l) => (typeof l === "string" ? l : l?.name))
    .filter(Boolean);
  // 状态规则不在这里：整条意图交给 state-validate 判定。两处规则就是两个真相源，
  // 改一处另一处就会撒谎。
  // 用咨询入口而不是写入口：门问的是「这条转换被声明了吗」，守卫证据由写者提供；
  // 门自己就是证据的生产者，拿写入口问自己会永远问不出绿。
  const result = consultTransition(cfg, {
    issue: ctx.issue.number,
    to: "done",
    actor_role: "ci",
    labels,
  });
  // 裁决 A：已关闭的单不能再被判成在途。「x → done 被声明了」只回答了「能不能转」，
  // 没回答「还该不该转」：issue 已经关闭（由 PR body 的 Fixes #N 自动关单，或人行关单）
  // 说明这条转换的前提已经不成立，再把标签当在途放过去，就是门给一张已关单的票。
  // 只认字符串 "closed"：输入里没有 state 时不当成已关闭 —— 门不靠猜补输入。
  // 走到这里说明 consultTransition 已经认了这次转换 —— 它拒绝终态起点，
  // 所以「能走到这一步的 from」必然是非终态，不用再判一次终态。
  if (ctx.issue.state === "closed")
    throw reject(
      "E_ISSUE_CLOSED_IN_FLIGHT",
      `issue #${ctx.issue.number} 已经关闭，但状态标签还停在非终态 ${result.from}：已关闭的单不能被判成在途。先让标签落到终态（或重新打开 issue）再合。`,
    );
  return `issue #${ctx.issue.number} ${result.from} → ${result.to}（${result.by}）`;
}

function guardIssueAndFiles(ctx) {
  assertProducerSettled(ctx);
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

// 「还没跑完」「没有判过」「判成不合格」是三种结论，不能混成一档：
//   未完成（queued/in_progress/…）→ 未就绪，exit 3：别家检查在跑不是不合格，是还判不了
//   completed 且结论可归因于代码 → 真失败，exit 1：这一笔的问题，去改代码
//   completed 但结论说不清代码好还是坏（audit 的 INFRA / neutral / skipped / …）
//     → 没有判过，exit 3：同样阻断合并（平台没有第三态放行），但不许被说成「代码不合格」
// 「未判过也阻断」不是保守，是 contract：把没判过读成通过，等于让「没跑到」冒充「跑到并通过」。
const CHECK_FAILED = ["failure", "timed_out", "startup_failure", "cancelled"];
// action_required 是 audit 的 INFRA 结论（见 scripts/audit-findings.mjs 的文件头）；
// neutral / skipped 在平台的 required check 语义里被视为通过 —— 门不信这一套：
// 它们都只是「没有给出结论」，不是「给了一个通过的结论」。
const CHECK_NOT_JUDGED = ["action_required", "neutral", "skipped", "stale"];
// 分档的唯一家：枚举外的结论一律落到「未判过」（认不出 ≠ 通过，也不等于不合格）。
const VERDICT_OF = new Map([
  ["success", "pass"],
  ...CHECK_FAILED.map((c) => [c, "failed"]),
  ...CHECK_NOT_JUDGED.map((c) => [c, "not-judged"]),
]);
// 自己不能给自己背书：check 名就是我们自己（CHECK）的那条一律不看 —— 要求「自己已经绿」
// 是逻辑死结（本 job 此刻必然 in_progress），把它算进去就等于永远红。
function guardChecks(ctx) {
  const all = checkRuns(ctx);
  // 同名多次运行（重跑 / 重推）只看最新一次，再剔除自己。
  const latest = new Map();
  for (const run of all) {
    const prev = latest.get(run?.name);
    if (!prev || Number(run?.id ?? 0) >= Number(prev?.id ?? 0))
      latest.set(run?.name, run);
  }
  const others = [...latest.values()].filter((r) => r?.name !== CHECK);
  // 检查没跑 ≠ 绿：没有别的检查项就判不出资格，走 INFRA 而不是放行。
  if (others.length === 0)
    throw infra(
      "E_CHECKS_EMPTY",
      `上游没有为 ${short(ctx.head)} 报告任何别人的 check run：检查没跑不等于绿`,
    );
  const stale = others.filter((r) => r.head_sha && r.head_sha !== ctx.head);
  if (stale.length)
    throw reject(
      "E_CHECK_STALE",
      `这些检查项不是 ${short(ctx.head)} 的: ${stale
        .map((r) => r.name)
        .join(", ")}`,
    );
  const label = (r) =>
    `${r.name}(id ${r.id}) ${r.status}/${r.conclusion ?? "null"}`;
  const pending = others.filter((r) => r.status !== "completed");
  if (pending.length)
    throw infra(
      "E_CHECK_PENDING",
      `${pending.length} 项还没跑完: ${pending.map(label).join(", ")} —— 等它们出结论再算`,
    );
  // 枚举以外的 completed 结论也归「未判过」：门只对枚举得出的失败下判断，
  // 认不出的结论不许被读成通过，也不许被说成「代码不合格」。
  const verdictOf = (r) => VERDICT_OF.get(String(r.conclusion)) ?? "not-judged";
  const failed = others.filter((r) => verdictOf(r) === "failed");
  const unjudged = others.filter((r) => verdictOf(r) === "not-judged");
  const unjudgedWord = (list) =>
    `${list.length} 项没有判过（不是判成不合格，但未判过不允许合并）: ${list
      .map(label)
      .join(", ")}`;
  // 两类同时存在时真失败优先（可动手的部分已经明确，exit 1），
  // 但两类必须分开数：混成一句「不是绿的 N 项」会让读者去查不存在的缺陷。
  if (failed.length)
    throw reject(
      "E_CHECK_NOT_GREEN",
      `不是绿的 ${failed.length} 项: ${failed.map(label).join(", ")}` +
        (unjudged.length ? `；另有 ${unjudgedWord(unjudged)}` : ""),
    );
  if (unjudged.length) throw infra("E_CHECK_NOT_JUDGED", unjudgedWord(unjudged));
  const open = normalizeInfra(ctx.infra);
  // 未结 INFRA 记录属于「某件事还没判过」，不是「代码不合格」：它照样阻断合并，
  // 归 INFRA 而不是 FAIL —— 区别只在责任方向（去修 PR 还是去看管线）。
  if (open.length)
    throw infra(
      "E_INFRA_OPEN",
      `还有 ${open.length} 条未结 INFRA: ${open
        .map((i) => i?.id ?? JSON.stringify(i))
        .join(", ")}`,
    );
  return `${others.length} 项别人家的检查全绿（同名取最新，自己不算），无未结 INFRA`;
}

function guardLastChangePr(ctx) {
  assertProducerSettled(ctx);
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
    const notReady = error.kind === "infra";
    return {
      id,
      title,
      verdict: notReady ? "INFRA" : "FAIL",
      code: error.code,
      // 逐行也要能读出「这是等上游」而不是「这一笔不合格」：
      // 真 PR 上四条同红时，读者靠这个词判断该去修 PR 还是去看生产者。
      detail: notReady ? `${PENDING_WORD}：${error.message}` : error.message,
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
    throw infra(
      "E_EVENT_MISSING",
      "没有事件输入：--event <file> 或 EVENT 环境变量",
    );
  let event;
  try {
    event = JSON.parse(raw);
  } catch (error) {
    throw infra("E_EVENT_UNPARSABLE", `事件不是合法 JSON: ${error.message}`);
  }
  const eventPr = event?.pull_request;
  if (
    !eventPr ||
    typeof eventPr !== "object" ||
    typeof eventPr.number !== "number"
  )
    throw infra(
      "E_EVENT_SHAPE",
      "事件里没有 pull_request.number：gate 只判 PR 的合并资格",
    );
  // 事件里的正文是「事件发生那一刻」的快照。门牌由 last-change 之后写回，写回不会
  // 回填这份快照 —— 所以正文另取最新的 PR 现况（--pr），否则等到天亮也读到旧正文。
  const prPath = arg(argv, "--pr");
  const live = prPath ? readJson(prPath, "PR 现况（--pr）") : null;
  const pr = live && typeof live.number === "number" ? live : eventPr;
  // 判的是这次运行的 head（事件里的），不是现况里可能已经又推一版的 head。
  const head = arg(argv, "--head") ?? eventPr.head?.sha ?? pr.head?.sha ?? "";
  if (!head)
    throw infra(
      "E_HEAD_MISSING",
      "事件里没有 pull_request.head.sha，--head 也没给：无从判定文件在哪个 commit 上",
    );
  return {
    pr,
    body: String(pr.body ?? ""),
    head,
    producer: PRODUCER,
    repo: arg(argv, "--repo") ?? process.cwd(),
    configPath: arg(argv, "--config") ?? DEFAULT_CONFIG,
  };
}

function report(ctx, results) {
  const out = (line) => process.stdout.write(line + "\n");
  out(`${CHECK} PR #${ctx.pr.number} @ ${short(ctx.head)}`);
  for (const r of results)
    out(`${CHECK} ${r.id} ${r.title} ${r.verdict} ${r.code} ${r.detail}`);
  // 汇总行必须把「真失败」与「未就绪」分开数：G2/G4 在门牌缺失时说的是同一件事，
  // 混成「k 条全错」会让读者去查两个不存在的缺陷。
  const rejected = results.filter((r) => r.verdict === "FAIL");
  const pending = results.filter((r) => r.verdict === "INFRA");
  if (rejected.length === 0 && pending.length === 0) {
    out(`${CHECK} PASS ${results.length}/${results.length}`);
    process.exit(0);
  }
  const ids = (list) =>
    list.length ? `(${list.map((r) => r.id).join(",")})` : "";
  out(
    `${CHECK} ${rejected.length ? "FAIL" : "INFRA"} ${rejected.length + pending.length}/${results.length} 真失败=${rejected.length}${ids(rejected)} 未就绪=${pending.length}${ids(pending)}`,
  );
  // 有真失败就是拒绝（可动手的部分已经明确）；一条真失败都没有才是 INFRA。
  process.exit(rejected.length ? 1 : 3);
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
const invoked = process.argv[1] ? realpathSync(process.argv[1]) : undefined;
if (invoked === realpathSync(fileURLToPath(import.meta.url)))
  main(process.argv.slice(2));
