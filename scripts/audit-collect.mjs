#!/usr/bin/env node
// audit-collect.mjs · 审计的编排层：一条命令把「发 run -> 等结论 -> 读 Check Run」串起来。
//
// 它不判定。判定只有两个写者：.github/workflows/audit.yml（跑 workflow、回写 Check Run）
// 与 scripts/audit-findings.mjs（schema / 归并 / 比对 / conclusion）。本文件只做机械的三件事：
// 把两份 findings 发成一次 workflow_dispatch、等到那次 run 结束、把这个 sha 上 name=audit
// 的 Check Run 读回来。判据一个都不复制：预检直接 import audit-findings 的 assess，结论直接读
// 平台上那条 Check Run 的 conclusion —— 第二套判据就是第二个结论写者。
//
// 为什么手敲 gh 不够：一次手敲带着一串隐式前提（--ref 真的是 PR head 分支、findings 真过了
// schema、等到的真是本次那次 run、读的真是同一个 sha 上的结论）。漏掉任何一个，拿到的都是
// 一次「看起来成功、其实没判过」的记录。这里把每个前提变成一次显式检查，失败就说清哪一步。
//
// 退出码（与 audit-findings / merge-gate 同一口径）：
//   0 = Check Run 的结论是 success
//   1 = failure（这一笔被判不合格）
//   2 = 用法错误（参数缺失 / 文件不存在）—— 什么都不发就说清楚
//   3 = 判不了 / 没判过：action_required、没有 audit Check Run、认不出的 conclusion、
//       轮询超时、任一步 gh 调用失败、本地预检不合格、PR 不是 OPEN
//
// 认不出的 conclusion 一律 3，不给 0：GitHub 的结论集合里 neutral / skipped 也算「通过」，
// 但合并门只认 success（scripts/merge-gate.mjs 的 G3），把别的读成 0 就是伪造绿。
//
// 两条刻意的边界（都写在对应代码旁）：
//   * 预检只拦「schema 不合格」与「两个槽自报同一执行器」。上游申报 INFRA 是合法输入，
//     它本来就该跑出一次 INFRA —— 拦住它等于拒绝提交这个工具存在的理由。
//   * --dry-run 先做预检、打印后退出 0，不因 PR 不是 OPEN 而失败：它什么都不发，
//     「别往死 PR 上白烧一次 run」这条理由对它不成立；真跑一律在发起前拦住。

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { assess } from "./audit-findings.mjs";

export const EXIT = { PASS: 0, FAIL: 1, USAGE: 2, UNKNOWN: 3 };
export const DEFAULT_TIMEOUT_SEC = 300;
export const POLL_INTERVAL_MS = 10_000;
export const SUMMARY_CHARS = 200;
export const WORKFLOW = "audit.yml";
export const CHECK_NAME = "audit";

const USAGE =
  "用法: node scripts/audit-collect.mjs --pr <数字> --a <findings-a.json> --b <findings-b.json> " +
  "[--ref <分支>] [--dry-run] [--json] [--timeout <秒>]";

const VALUE_FLAGS = {
  "--pr": "pr",
  "--a": "a",
  "--b": "b",
  "--ref": "ref",
  "--timeout": "timeout",
};
const SWITCH_FLAGS = { "--dry-run": "dryRun", "--json": "json" };

// Check Run 的读取投影：--paginate 会把每页的 jq 输出首尾相接，所以先投影成
// 「一行一条 check run」的 NDJSON，再由下面按行解析 —— 直接拼页数组在多加一页时就解析不了。
const CHECK_RUN_PROJECTION =
  ".check_runs[]? | {id: .id, name: .name, conclusion: .conclusion, title: .output.title, summary: .output.summary}";

// 唯一的 gh 出口：默认 spawnSync 调真 gh，参数走数组（不拼 shell 字符串），测试注入假替身。
export const defaultGh = (args) => spawnSync("gh", args, { encoding: "utf8" });

const oneLine = (value) => String(value ?? "").replace(/[\r\n]+/g, " ").trim();
const clip = (value, max) => {
  const text = oneLine(value);
  return text.length <= max ? text : text.slice(0, max) + "…";
};
const summarize = (stderr) => {
  const text = clip(stderr, 400);
  return text === "" ? "（gh 没有给出 stderr）" : text;
};

// 参数是输入面：每个都要点名，因为「少一个参数」和「文件找错了」的后果不一样，
// 而两者都不该走到发 workflow 那一步。
export function parseArgs(argv) {
  const opts = {
    pr: null,
    a: null,
    b: null,
    ref: null,
    timeout: DEFAULT_TIMEOUT_SEC,
    dryRun: false,
    json: false,
  };
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (Object.hasOwn(SWITCH_FLAGS, token)) {
      if (seen.has(token)) return { ok: false, error: token + " 重复给出" };
      seen.add(token);
      opts[SWITCH_FLAGS[token]] = true;
      continue;
    }
    if (Object.hasOwn(VALUE_FLAGS, token)) {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--"))
        return { ok: false, error: token + " 缺少取值" };
      if (seen.has(token)) return { ok: false, error: token + " 重复给出" };
      seen.add(token);
      opts[VALUE_FLAGS[token]] = value;
      index += 1;
      continue;
    }
    return { ok: false, error: "认不出的参数 " + JSON.stringify(token) };
  }
  if (opts.pr === null) return { ok: false, error: "--pr 必填（要审计的 PR 号）" };
  if (!/^[1-9][0-9]*$/.test(opts.pr))
    return { ok: false, error: "--pr 必须是正整数，收到 " + JSON.stringify(opts.pr) };
  opts.pr = Number(opts.pr);
  for (const key of ["a", "b"]) {
    const path = opts[key];
    if (path === null) return { ok: false, error: "--" + key + " 必填（该槽的 findings JSON 文件）" };
    if (!existsSync(path)) return { ok: false, error: "--" + key + " 文件不存在：" + path };
    if (!statSync(path).isFile()) return { ok: false, error: "--" + key + " 不是文件：" + path };
  }
  if (opts.ref !== null && opts.ref.trim() === "")
    return { ok: false, error: "--ref 不能是空串" };
  if (typeof opts.timeout === "string") {
    if (!/^[1-9][0-9]*$/.test(opts.timeout))
      return { ok: false, error: "--timeout 必须是正整数（秒），收到 " + JSON.stringify(opts.timeout) };
    opts.timeout = Number(opts.timeout);
  }
  return { ok: true, opts };
}

// 打印用的命令渲染：-f 的取值是文件原文（可能带换行），照原样贴会糊成多行，
// 所以只在取值真的含换行时才用 JSON 转义形态展示。这是展示层，发出去的永远是 args 数组。
export function renderCommand(args) {
  const shown = args.map((arg) => (/[\r\n]/.test(arg) ? JSON.stringify(arg) : arg));
  const parts = [];
  for (let index = 0; index < shown.length; index += 1) {
    if (shown[index] === "-f" && shown[index + 1] !== undefined) {
      parts.push("-f " + shown[index + 1]);
      index += 1;
      continue;
    }
    parts.push(shown[index]);
  }
  return "gh " + parts.join(" ");
}

function callGh(gh, args) {
  let result;
  try {
    result = gh(args);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { ok: false, stdout: "", stderr: "gh 无法启动：" + detail };
  }
  if (!result || typeof result !== "object")
    return { ok: false, stdout: "", stderr: "gh runner 没有返回结果" };
  if (result.error) {
    const detail = result.error.message ?? String(result.error);
    return { ok: false, stdout: result.stdout ?? "", stderr: "gh 无法启动：" + detail };
  }
  return { ok: result.status === 0, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function parseJson(text) {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function loadInput(path) {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    const detail = error instanceof Error ? (error.code ?? error.message) : String(error);
    return { ok: false, reason: "读不出 " + path + "：" + detail };
  }
  const parsed = parseJson(text);
  if (!parsed.ok) return { ok: false, reason: path + " 不是合法 JSON：" + parsed.error };
  return { ok: true, text, value: parsed.value };
}

const idRank = (id) =>
  String(id ?? "").match(/^[0-9]+$/) ? Number(id) : Number.POSITIVE_INFINITY;

export async function main(argv, deps = {}) {
  const gh = deps.gh ?? defaultGh;
  const now = deps.now ?? (() => Date.now());
  const sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const intervalMs = deps.intervalMs ?? POLL_INTERVAL_MS;
  const out = deps.out ?? ((line) => process.stdout.write(line + "\n"));
  const err = deps.err ?? ((line) => process.stderr.write(line + "\n"));

  const parsed = parseArgs(argv);
  if (!parsed.ok) {
    // 用法错误走 stderr：stdout 在 --json 下必须只有一行 JSON，而这时还认不出有没有 --json。
    err("audit-collect " + parsed.error);
    err(USAGE);
    return EXIT.USAGE;
  }
  const opts = parsed.opts;
  const state = {
    pr: opts.pr,
    sha: null,
    ref: opts.ref,
    runId: null,
    checkRunId: null,
    conclusion: null,
    title: null,
  };
  const details = [];

  // 给人看的输出「先一行结论，再细节」：结论在 emit 里统一写，细节先攒着。
  const emit = (code, summary) => {
    if (opts.json) {
      out(
        JSON.stringify({
          pr: state.pr,
          sha: state.sha,
          ref: state.ref,
          runId: state.runId,
          checkRunId: state.checkRunId,
          conclusion: state.conclusion,
          title: state.title,
          exitCode: code,
        }),
      );
      return code;
    }
    out(summary);
    for (const line of details) out(line);
    return code;
  };
  const fail = (code, title, detail) => {
    state.title = title;
    if (detail !== undefined) details.push(detail);
    return emit(code, "audit-collect " + title);
  };

  // ---- 1. PR 的 head sha 与 ref ----
  const view = callGh(gh, ["pr", "view", String(opts.pr), "--json", "headRefOid,headRefName,state"]);
  if (!view.ok)
    return fail(EXIT.UNKNOWN, "第 1 步 gh pr view #" + opts.pr + " 失败", "stderr: " + summarize(view.stderr));
  const viewJson = parseJson(view.stdout);
  if (!viewJson.ok)
    return fail(
      EXIT.UNKNOWN,
      "第 1 步 gh pr view #" + opts.pr + " 的输出不是 JSON",
      "stdout: " + clip(view.stdout, 200),
    );
  const headSha = viewJson.value?.headRefOid;
  const headRef = viewJson.value?.headRefName;
  const prState = viewJson.value?.state;
  if (typeof headSha !== "string" || headSha === "")
    return fail(
      EXIT.UNKNOWN,
      "第 1 步 拿不到 PR #" + opts.pr + " 的 head sha（没有 sha 就没有比对对象）",
      "gh pr view 回了 " + clip(view.stdout, 200),
    );
  state.sha = headSha;
  state.ref = opts.ref ?? headRef;
  if (typeof state.ref !== "string" || state.ref === "")
    return fail(
      EXIT.UNKNOWN,
      "第 1 步 拿不到 PR #" + opts.pr + " 的 head 分支（也没给 --ref）",
      "gh pr view 回了 " + clip(view.stdout, 200),
    );
  const isOpen = prState === "OPEN";
  details.push("PR #" + opts.pr + " sha=" + state.sha + " ref=" + state.ref + " state=" + JSON.stringify(prState ?? null));

  // ---- 2. 本地预检：判据在 audit-findings.mjs，这里只请它判一次 ----
  // 理由：注定判 INFRA 的输入发出去只是白烧一次 run，而且会在这个 sha 上留一条
  // action_required —— 一条什么都证明不了的记录。
  const inputs = { a: loadInput(opts.a), b: loadInput(opts.b) };
  for (const key of ["a", "b"]) {
    if (!inputs[key].ok)
      return fail(EXIT.UNKNOWN, "第 2 步 本地预检不合格（未发起 workflow）：--" + key, inputs[key].reason);
  }
  const verdict = assess({ a: inputs.a.value, b: inputs.b.value });
  const problems = [];
  for (const executor of verdict.executors) {
    if (!executor.valid) problems.push(executor.slot + " schema 不合格：" + executor.errors.join("；"));
    // 两个槽自报同一执行器：双执行器独立比对的前提消失，跑出来的只能是 INFRA。
    if (executor.reason) problems.push(executor.slot + "：" + executor.reason);
  }
  if (problems.length > 0) {
    for (const problem of problems) details.push(problem);
    return fail(
      EXIT.UNKNOWN,
      "第 2 步 本地预检不合格（未发起 workflow）：" + problems.length + " 处",
      "--a " + opts.a + " / --b " + opts.b + " 过不了 audit-findings 的 schema 校验，发出去只会判 INFRA",
    );
  }
  details.push(
    "预检通过：" +
      verdict.executors.map((executor) => executor.slot + "=" + executor.effective).join(" ") +
      "（结论仍由 workflow 产出）",
  );

  // ---- 3. 发起 workflow_dispatch ----
  const runArgs = [
    "workflow",
    "run",
    WORKFLOW,
    "--ref",
    state.ref,
    "-f",
    "pr=" + opts.pr,
    "-f",
    "findings_a=" + inputs.a.text,
    "-f",
    "findings_b=" + inputs.b.text,
  ];

  if (opts.dryRun) {
    details.push("目标 sha: " + state.sha);
    details.push("将执行（未发送）: " + renderCommand(runArgs));
    if (runArgs.some((arg) => /[\r\n]/.test(arg)))
      details.push("说明：含换行的取值按 JSON 转义展示，实际传给 gh 的是文件原文。");
    if (!isOpen)
      details.push(
        "注意：PR 状态是 " + JSON.stringify(prState ?? null) + "，不是 OPEN —— 真跑会在发起前被拒绝（退出码 3）。",
      );
    return emit(EXIT.PASS, "[dry-run] 只打印，未发起 workflow：PR #" + opts.pr + " sha=" + state.sha);
  }

  if (!isOpen)
    return fail(
      EXIT.UNKNOWN,
      "PR #" + opts.pr + " 的状态是 " + JSON.stringify(prState ?? null) + "，不是 OPEN —— 没有发起 workflow",
      "不在非 OPEN 的 PR 上留结论：那条记录会被读成「这一笔判过了」。",
    );

  // 发起时间在 dispatch 之前取：轮询用它把「本次这次 run」和同 sha 上的旧 run 分开。
  const startedAt = new Date(now()).toISOString();
  const dispatched = callGh(gh, runArgs);
  if (!dispatched.ok)
    return fail(EXIT.UNKNOWN, "第 3 步 gh workflow run 失败（workflow_dispatch 没发出去）", "stderr: " + summarize(dispatched.stderr));
  details.push("已发起 workflow_dispatch（ref=" + state.ref + " startedAt=" + startedAt + "）");

  // ---- 4. 轮询：只认 headSha 相同、createdAt 不早于本次发起时间的 run ----
  const deadline = now() + opts.timeout * 1000;
  const startedAtMs = Date.parse(startedAt);
  let run = null;
  for (;;) {
    const listed = callGh(gh, [
      "run",
      "list",
      "--workflow=" + WORKFLOW,
      "--limit",
      "20",
      "--json",
      "databaseId,headSha,createdAt,status",
    ]);
    if (!listed.ok)
      return fail(EXIT.UNKNOWN, "第 4 步 gh run list 失败", "stderr: " + summarize(listed.stderr));
    const page = parseJson(listed.stdout);
    if (!page.ok)
      return fail(EXIT.UNKNOWN, "第 4 步 gh run list 的输出不是 JSON", "stdout: " + clip(listed.stdout, 200));
    const runs = Array.isArray(page.value) ? page.value : [];
    const matches = runs.filter((entry) => {
      if (!entry || entry.headSha !== state.sha) return false;
      const createdAt = Date.parse(entry.createdAt);
      return Number.isFinite(createdAt) && createdAt >= startedAtMs;
    });
    // 同一 sha 上可能有多条（并发 dispatch / rerun）：取 createdAt 最新的一条，
    // 与合并门读同名结论的口径一致（scripts/merge-gate.mjs 取 id 最大者）。
    const candidate = matches.reduce(
      (best, entry) =>
        best === null || Date.parse(entry.createdAt) > Date.parse(best.createdAt) ? entry : best,
      null,
    );
    if (candidate) {
      state.runId = candidate.databaseId ?? null;
      if (candidate.status === "completed") {
        run = candidate;
        break;
      }
    }
    if (now() >= deadline)
      return fail(
        EXIT.UNKNOWN,
        "第 4 步 轮询超时（" + opts.timeout + " 秒）：没有等到 sha=" + state.sha + " 上本次发起的 run 结束",
        candidate
          ? "最后一次看到的 run id=" + state.runId + " status=" + candidate.status
          : "这段时间内没有出现 headSha=" + state.sha + " 且 createdAt >= " + startedAt + " 的 run",
      );
    await sleep(intervalMs);
  }
  details.push("run id=" + state.runId + " createdAt=" + run.createdAt + " status=" + run.status);

  // ---- 5. 读这个 sha 上的 Check Run（结论的唯一载体）----
  // 端点只认 commits/<ref>/check-runs；{owner}/{repo} 是 gh 的占位符，不必另查仓库名。
  const checks = callGh(gh, [
    "api",
    "repos/{owner}/{repo}/commits/" + state.sha + "/check-runs?filter=latest&per_page=100",
    "--paginate",
    "--jq",
    CHECK_RUN_PROJECTION,
  ]);
  if (!checks.ok)
    return fail(EXIT.UNKNOWN, "第 5 步 gh api 读 check runs 失败", "stderr: " + summarize(checks.stderr));
  const entries = [];
  for (const line of checks.stdout.split(/\r?\n/)) {
    if (line.trim() === "") continue;
    const parsedLine = parseJson(line);
    if (parsedLine.ok && parsedLine.value && typeof parsedLine.value === "object")
      entries.push(parsedLine.value);
  }
  const named = entries.filter((entry) => entry.name === CHECK_NAME);
  if (named.length === 0)
    return fail(
      EXIT.UNKNOWN,
      "第 5 步 本 sha 上没有 name=" + CHECK_NAME + " 的 check run —— 没判过不等于通过",
      "回读到 " + entries.length + " 条 check run，名字分别是：" +
        (entries.length === 0 ? "（无）" : entries.map((entry) => String(entry.name)).join("、")),
    );
  const checkRun = named.reduce(
    (best, entry) => (best === null || idRank(entry.id) > idRank(best.id) ? entry : best),
    null,
  );
  state.checkRunId = checkRun.id ?? null;
  state.conclusion = typeof checkRun.conclusion === "string" ? checkRun.conclusion : null;
  state.title = checkRun.title ?? null;
  details.push("check run id=" + state.checkRunId + " name=" + CHECK_NAME + " conclusion=" + state.conclusion);
  if (state.title) details.push("title: " + oneLine(state.title));
  const summary = clip(checkRun.summary ?? "", SUMMARY_CHARS);
  details.push("summary（前 " + SUMMARY_CHARS + " 字）: " + (summary === "" ? "（空）" : summary));

  // 只有 success 给 0：neutral / skipped 在 GitHub 那边算「通过」，在审计门这边不算。
  const code = Object.hasOwn(EXIT_BY_CONCLUSION, state.conclusion) ? EXIT_BY_CONCLUSION[state.conclusion] : EXIT.UNKNOWN;
  const note = code === EXIT.PASS ? "通过" : code === EXIT.FAIL ? "判不合格" : "判不了 / 没判过";
  return emit(
    code,
    "audit-collect PR #" + opts.pr + " sha=" + state.sha + " conclusion=" + String(state.conclusion) +
      " exit=" + code + "（" + note + "）",
  );
}

// conclusion -> 退出码。认不出的一律落到 3（fail-closed）：见文件头。
const EXIT_BY_CONCLUSION = { success: EXIT.PASS, failure: EXIT.FAIL, action_required: EXIT.UNKNOWN };

// 入口判定走 realpath（与 scripts/audit-findings.mjs 同一条规矩）：worktree / 软链下
// argv[1] 与 import.meta.url 不是同一条字面路径，认不出自己就会静默退出 0 —— 对门来说
// 那是最坏的失败形态（看起来绿）。
const invoked = process.argv[1] ? realpathSync(process.argv[1]) : undefined;
if (invoked === realpathSync(fileURLToPath(import.meta.url))) {
  // 崩了也不给 0：没有结论就是 3，别让栈退出码变成一个「成功」。
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      process.stderr.write("audit-collect 崩溃: " + (error?.stack ?? error) + "\n");
      process.exitCode = EXIT.UNKNOWN;
    },
  );
}
