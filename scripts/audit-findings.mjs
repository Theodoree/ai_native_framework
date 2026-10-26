#!/usr/bin/env node
// audit-findings.mjs · 审计 findings 的执行层（schema / 归一 / 比对 / Check conclusion）
//
// 只做「拿到 findings 之后」的事：校验固定 schema、合并多个执行器的 verdict、
// 逐条比对两边的结论、把 verdict 翻译成 GitHub 的 Check conclusion。
// 跑模型的那一层（网关 / 沙盒）不在这里 —— 本文件零网络调用，输入全部注入，
// 所以「占位符 evidence 越过门」和「两边结论不一致」都能被单测钉住。
//
// 三条依据（docs/audit-contract.md 二、三）：
//   1. 输出固定 schema：verdict / findings[path,line,severity,criterion,suggestion] /
//      evidence[executor,agent,model,request_id]。evidence 里的 model 或 request_id 是
//      占位符（空串、unknown、todo、n/a、unset 等）一律不合格：占位符越过门，就是把
//      「没跑到」写成「跑到并通过了」，而这种绿比红灯更坏。
//   2. INFRA ≠ FAIL：上游超时 / 额度耗尽 / 模型不可达 -> 整体 INFRA；它不是「代码不合格」，
//      但也绝不给绿 —— 判不了就说判不了，不许静默当通过。
//   3. 两个执行器的结论要能逐条比：path + line + criterion 收敛为同一条，severity 不一致
//      单独列为 severityMismatch。两边不一致本身就是最强信号，所以这里不做多数决、
//      不做同步率门限，只把差异原样摊开。
//
// 退出码沿用平台三分（与 merge-gate / state-validate 同一口径）：
//   0 pass · 1 needs_revision 或 reject · 3 INFRA
//
// —— Check conclusion 为什么 INFRA 用 action_required 而不是 neutral ——
// GitHub 的 required status check 只在三种结论下算通过（docs.github.com：
// "Successful check statuses are success, skipped, and neutral"；
//  "Required status checks must have a successful, skipped, or neutral status"）。
// 所以 neutral 会让 required check 变绿 —— 用它表达 INFRA，等于把「没判」静默记成「通过」，
// 正是本脚本要堵的那个洞。action_required 不在通过集合里（required check 因此不会变绿），
// 语义又是「完成了，但需要人处理 / 重跑」，与 failure（代码被判不合格）区分得开。
// 仓库内既有用法同向：merge-gate 的 G3 只认 conclusion === "success"，
// skipped / neutral 都不给背书（scripts/merge-gate.mjs 的 guardChecks）。

import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

export const VERDICTS = ["pass", "needs_revision", "reject", "INFRA"];
export const SEVERITIES = ["blocker", "high", "medium", "low"];
export const EXECUTORS = ["sandbox", "github"];

// 占位符的口径写成一份表：散在各处判断，就会有一处漏掉，而漏掉的那处就是洞。
const PLACEHOLDER = new Set([
  "",
  "unknown",
  "pending",
  "todo",
  "tbd",
  "n/a",
  "na",
  "unset",
  "none",
  "null",
  "nil",
  "-",
  "?",
  "placeholder",
]);

// 本仓自己声明的占位值写在 .agents/platform/routing.yml：`model: pending-review-a` 之类。
// 该文件的原话是「model 当前是占位值（pending-*），只是把结构声明清楚」——即 pending-*
// 就是「还没接真模型」的标记。不把它算占位符，evidence.model="pending-review-a" 就会让
// 「没跑到」写成「跑到并通过」，而这正是本表存在的唯一理由。
const PLACEHOLDER_PREFIX = "pending-";

const isText = (value) => typeof value === "string" && value.trim() !== "";
const isPlaceholder = (value) => {
  if (!isText(value)) return true;
  const text = value.trim().toLowerCase();
  return PLACEHOLDER.has(text) || text.startsWith(PLACEHOLDER_PREFIX);
};

const show = (value) => JSON.stringify(value === undefined ? null : value);

// ---- 输出面：stdout 就是 Actions 的注解面 ----
// GitHub Actions 把每一行以 "::" 开头的输出当成 workflow command（::error:: / ::warning:: …）。
// report() 打的每个字段都来自上游输入，所以「一句判据」里塞一个换行就能伪造一条 ::error::。
// 中和放在唯一的写出口上，而不是散在 N 个字段上：漏掉哪个字段，哪个字段就是注入面。
// 只中和**来自输入的文本**；本文件自己不发注解（::warning:: 由 workflow 的 run 块发）。
const LINE_BREAK = /[\r\n\u2028\u2029]/g;
const oneLine = (value) => String(value).replace(LINE_BREAK, " ");
const outLine = (line) => {
  const safe = oneLine(line);
  // 换行已经压掉，正常到不了这里；到了就是别处漏了，也不许让这一行变成注解。
  return safe.startsWith("::") ? "audit-findings " + safe : safe;
};

export function validateResult(input) {
  const errors = [];
  if (!input || typeof input !== "object" || Array.isArray(input))
    return {
      ok: false,
      errors: ["结果必须是对象 {verdict, findings, evidence}"],
    };
  if (!VERDICTS.includes(input.verdict))
    errors.push(
      "verdict: 非法枚举 " +
        show(input.verdict) +
        "（允许 " +
        VERDICTS.join("|") +
        "）",
    );
  if (!Array.isArray(input.findings))
    errors.push(
      "findings: 必须是数组（实际 " +
        (input.findings === null ? "null" : typeof input.findings) +
        "）",
    );
  else
    input.findings.forEach((finding, index) => {
      const at = "findings[" + index + "]";
      if (!finding || typeof finding !== "object" || Array.isArray(finding)) {
        errors.push(at + ": 必须是对象");
        return;
      }
      if (!isText(finding.path)) errors.push(at + ".path: 必须是非空字符串");
      if (!Number.isInteger(finding.line) || finding.line < 1)
        errors.push(at + ".line: 必须是 ≥1 的整数（实际 " + show(finding.line) + "）");
      if (!SEVERITIES.includes(finding.severity))
        errors.push(
          at +
            ".severity: 非法枚举 " +
            show(finding.severity) +
            "（允许 " +
            SEVERITIES.join("|") +
            "）",
        );
      if (!isText(finding.criterion))
        errors.push(at + ".criterion: 必须是非空字符串");
      if (!isText(finding.suggestion))
        errors.push(at + ".suggestion: 必须是非空字符串");
    });
  const evidence = input.evidence;
  if (!evidence || typeof evidence !== "object" || Array.isArray(evidence))
    errors.push("evidence: 缺失或不是对象");
  else {
    if (!EXECUTORS.includes(evidence.executor))
      errors.push(
        "evidence.executor: 非法枚举 " +
          show(evidence.executor) +
          "（允许 " +
          EXECUTORS.join("|") +
          "）",
      );
    if (!isText(evidence.agent))
      errors.push("evidence.agent: 必须是非空字符串（逻辑名 review-a / review-b）");
    // 这两个字段是「真跑过」的唯一证据：放过占位符，门就再也分不清跑没跑。
    if (isPlaceholder(evidence.model))
      errors.push(
        "evidence.model: 占位符 " +
          show(evidence.model) +
          " 不算证据 —— 没跑到不能写成跑到并通过",
      );
    if (isPlaceholder(evidence.request_id))
      errors.push(
        "evidence.request_id: 占位符 " +
          show(evidence.request_id) +
          " 不算证据 —— 没有上游 request_id 就无法追溯",
      );
  }
  return { ok: errors.length === 0, errors };
}

// 归一：先把每个执行器的「申报值」变成可信值 —— schema 不合格的一律按 INFRA 处理。
// 不合格的结果不能被信任，而唯一安全的默认是「判不了」；把不合格读成 pass 就是伪造通过。
export const effectiveVerdict = (result) =>
  validateResult(result).ok ? result.verdict : "INFRA";

const declared = (result) => {
  if (VERDICTS.includes(result)) return result;
  return effectiveVerdict(result);
};

// 合并顺序即优先级：INFRA > reject > needs_revision > pass。
// INFRA 优先于 reject 不是偏袒：有一个执行器没给出结论时，整体就不是一个可用的判定。
// 空输入也是 INFRA —— 一条结果都没有时，「全 pass」的空集合不该被读成通过。
export function normalizeVerdict(results) {
  const list = Array.isArray(results) ? results : [results];
  if (list.length === 0) return "INFRA";
  const verdicts = list.map(declared);
  if (verdicts.includes("INFRA")) return "INFRA";
  if (verdicts.includes("reject")) return "reject";
  if (verdicts.includes("needs_revision")) return "needs_revision";
  return "pass";
}

const findingsOf = (value) => {
  if (Array.isArray(value)) return value;
  if (value && Array.isArray(value.findings)) return value.findings;
  return [];
};

// findings 是上游给的 JSON，不保证元素是对象（null / 字符串 / 数组都见过）。
// 非对象元素不是「一条缺陷」，没有 path/line/criterion 可比，硬解引用就是整脚本崩。
// 它们的信息不该在这里丢：validateResult 会把 findings[i]: 必须是对象 报到 schema 错误里，
// 该槽照样落 INFRA。这里只负责让比对不崩。
const isFindingObject = (value) =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const keyOf = (finding) =>
  [finding?.path, finding?.line, finding?.criterion].join("\u0000");

// 逐条比对：同一条 = path + line + criterion 三者相同。
// severity 只影响「算不算一致」，不参与「是不是同一条」—— 否则同一个缺陷会因为两边
// 严重度不同就变成两条不同的缺陷，不一致反而被藏起来。
export function compareFindings(a, b) {
  const slots = new Map();
  for (const finding of findingsOf(a)) {
    if (!isFindingObject(finding)) continue;
    const key = keyOf(finding);
    slots.set(key, { ...slots.get(key), a: finding });
  }
  for (const finding of findingsOf(b)) {
    if (!isFindingObject(finding)) continue;
    const key = keyOf(finding);
    slots.set(key, { ...slots.get(key), b: finding });
  }
  const agreed = [];
  const onlyA = [];
  const onlyB = [];
  const severityMismatch = [];
  for (const { a: left, b: right } of slots.values()) {
    if (left && right) {
      if (left.severity === right.severity) agreed.push(left);
      else
        severityMismatch.push({
          path: left.path,
          line: left.line,
          criterion: left.criterion,
          severityA: left.severity,
          severityB: right.severity,
        });
    } else if (left) onlyA.push(left);
    else onlyB.push(right);
  }
  const counts = {
    agreed: agreed.length,
    onlyA: onlyA.length,
    onlyB: onlyB.length,
    severityMismatch: severityMismatch.length,
  };
  const total =
    counts.agreed + counts.onlyA + counts.onlyB + counts.severityMismatch;
  return {
    agreed,
    onlyA,
    onlyB,
    severityMismatch,
    counts,
    // 同步率只是观测值，不做门限：现在的样本量是 0，任何门限都是编的
    // （.agents/notes/proposed/p13-audit-findings-contract.md 五）。
    agreementRate: total === 0 ? null : counts.agreed / total,
  };
}

// GitHub 只接受 success/failure/neutral/cancelled/action_required/timed_out/skipped。
// action_required 的理由见文件头：neutral 会让 required check 变绿，所以 INFRA 不能用它。
// 认不出的 verdict 一律落到 action_required：绝不给绿。
export function toCheckConclusion(verdict) {
  if (verdict === "pass") return "success";
  if (verdict === "needs_revision" || verdict === "reject") return "failure";
  return "action_required";
}

export const exitCodeFor = (verdict) => {
  if (verdict === "pass") return 0;
  if (verdict === "INFRA") return 3;
  return 1;
};

// ---- 输入与出口 ----

function arg(argv, name) {
  const at = argv.indexOf(name);
  return at === -1 ? undefined : argv[at + 1];
}

function loadResult(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    // 读不到 / 解析不了都是「没拿到结论」，不是「这一笔不合格」：按 INFRA 记。
    return { __readError: path + ": " + (error.code ?? error.message) };
  }
}

// 一个执行器的账面：申报了什么、schema 过没过、按什么算、为什么没结论。
function accountFor(slot, raw) {
  if (raw && typeof raw === "object" && typeof raw.__readError === "string")
    return {
      slot,
      declared: null,
      effective: "INFRA",
      valid: false,
      errors: ["读不到输入：" + raw.__readError],
      reason: null,
      evidence: null,
      findings: [],
    };
  const validation = validateResult(raw);
  return {
    slot,
    declared: raw && typeof raw === "object" ? (raw.verdict ?? null) : null,
    effective: validation.ok ? raw.verdict : "INFRA",
    valid: validation.ok,
    errors: validation.errors,
    reason: raw && typeof raw.reason === "string" ? raw.reason : null,
    evidence: raw && typeof raw.evidence === "object" ? raw.evidence : null,
    findings: findingsOf(raw),
  };
}

export function assess({ a, b } = {}) {
  const inputs = [
    ["a", a],
    ["b", b],
  ].filter(([, raw]) => raw !== undefined);
  const executors = inputs.map(([slot, raw]) => accountFor(slot, raw));
  // 槽内已经校验「自报的执行器 == 所在槽」，但槽间没有人管：两个槽都自报同一个执行器时，
  // 双执行器独立比对的前提就没了 —— 一份意见会被记成两票，比对永远是 agreed。
  // 这条不变式原先只写在 audit-slot.mjs 的注释里，注释拦不住一次配置改动，所以这里也判一次。
  //
  // 身份是「执行器 + 模型」，不是执行器：两位审查者都跑在 GitHub Actions 里，执行器必然都是
  // github —— 只认执行器就等于宣布「自动产出 findings」永远判 INFRA。用两个不同模型跑出两份
  // 独立意见时独立性成立；同执行器同模型才是同一份意见被记成两票。
  const claimants = executors
    .map((e) => {
      const evidence = e.evidence ?? {};
      const executor = typeof evidence.executor === "string" ? evidence.executor : null;
      const model = typeof evidence.model === "string" ? evidence.model : null;
      return executor && model ? executor + "\u0000" + model : null;
    })
    .filter((x) => x !== null);
  const duplicated = claimants.find((x, i) => claimants.indexOf(x) !== i) ?? null;
  if (duplicated) {
    const [executor, model] = duplicated.split("\u0000");
    for (const e of executors) {
      e.effective = "INFRA";
      e.reason =
        "两个槽自报同一个执行器 " +
        executor +
        " 与同一个模型 " +
        model +
        "：双执行器独立比对的前提消失";
    }
  }
  const verdict = normalizeVerdict(executors.map((e) => e.effective));
  const comparison =
    a !== undefined && b !== undefined ? compareFindings(a, b) : null;
  return {
    verdict,
    conclusion: toCheckConclusion(verdict),
    exitCode: exitCodeFor(verdict),
    executors,
    comparison,
  };
}

// 渲染一条 finding。字段可能缺（非对象元素已在 compareFindings 里跳过，这里只是不信任形状），
// 有值就必须是一行：换行/行首 :: 的中和在 out() 上，这里不重复做。
const findingLine = (finding, middle = "") =>
  [
    finding?.path ?? "?",
    ":" + (finding?.line ?? "?"),
    String(finding?.severity ?? "?"),
    middle,
    String(finding?.criterion ?? "?"),
  ]
    .filter((part) => part !== "")
    .join(" ");

function report(paths, result) {
  // 唯一的写出口：所有来自输入的字段都从这里出去，中和一次就够（见 outLine）。
  const out = (line) => process.stdout.write(outLine(line) + "\n");
  out("audit-findings a=" + (paths.a ?? "-") + " b=" + (paths.b ?? "-"));
  // 兜底结论自带 reason：那是唯一一处「为什么判成 INFRA」的人话，不能只留在 result.json 里。
  if (result.reason) out("audit-findings reason - " + result.reason);
  for (const executor of result.executors) {
    const evidence = executor.evidence;
    const who = evidence
      ? [
          evidence.executor,
          evidence.agent,
          show(evidence.model),
          show(evidence.request_id),
        ].join("/")
      : "无 evidence";
    out(
      "audit-findings executor " +
        executor.slot +
        " 申报=" +
        show(executor.declared) +
        " 计入=" +
        executor.effective +
        " schema=" +
        (executor.valid ? "ok" : "不合格") +
        " findings=" +
        executor.findings.length +
        " evidence=" +
        who,
    );
    // 不合格的点名：占位符、缺字段各自报出字段路径，别让人去猜为什么红。
    for (const error of executor.errors)
      out("audit-findings schema " + executor.slot + " " + error);
    if (executor.reason)
      out("audit-findings reason " + executor.slot + " " + executor.reason);
  }
  if (result.comparison) {
    const c = result.comparison.counts;
    out(
      "audit-findings compare agreed=" +
        c.agreed +
        " onlyA=" +
        c.onlyA +
        " onlyB=" +
        c.onlyB +
        " severityMismatch=" +
        c.severityMismatch +
        " 同步率=" +
        (result.comparison.agreementRate === null
          ? "n/a"
          : result.comparison.agreementRate.toFixed(2)),
    );
    // 不一致本身就是信号：逐条摊开，不做多数决。
    for (const finding of result.comparison.onlyA)
      out("audit-findings onlyA " + findingLine(finding));
    for (const finding of result.comparison.onlyB)
      out("audit-findings onlyB " + findingLine(finding));
    for (const finding of result.comparison.severityMismatch)
      out(
        "audit-findings severityMismatch " +
          findingLine(finding, "a=" + finding?.severityA + " b=" + finding?.severityB),
      );
  } else out("audit-findings compare skipped（只跑了一个执行器）");
  out(
    "audit-findings verdict=" +
      result.verdict +
      " conclusion=" +
      result.conclusion +
      " exit=" +
      result.exitCode,
  );
}

// result.json 里有两个码，两个读者，别混：
//   exit_code —— 本进程自己的码，与文件头那张三分表一致（0 pass / 1 判不合格 / 3 INFRA）。
//   exit      —— 给 workflow「判定」步骤读的码。job 级 check 不是第二个结论写者，它只回答
//                「这个 job 有没有跑错」：只有真失败才红（1）。INFRA 是「判不了」，红由 POST
//                出去的 audit Check Run（conclusion=action_required）去红；让 job 也红，
//                merge-gate 就会把一个「未判过」读成「不合格」——两件事被说成一件。
export const workflowExitFor = (conclusion) => (conclusion === "failure" ? 1 : 0);

const CRASH_REASON = "口径层崩溃，没有产出结论";

const crashResult = (error) => ({
  verdict: "INFRA",
  conclusion: "action_required",
  exitCode: 3,
  executors: [],
  comparison: null,
  reason: CRASH_REASON + "：" + (error instanceof Error ? error.message : String(error)),
});

function writeResult(out, result) {
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(
    out,
    JSON.stringify(
      {
        verdict: result.verdict,
        conclusion: result.conclusion,
        exit_code: result.exitCode,
        exit: workflowExitFor(result.conclusion),
        executors: result.executors,
        comparison: result.comparison,
        reason: result.reason ?? null,
      },
      null,
      2,
    ) + "\n",
  );
}

// 崩溃不是可接受的行为。没有 result.json，workflow 既写不出 Check Run 也没有 INFRA 留痕，
// 上一个 sha 上的 success 会原样留着 —— 那一次失败就变成了一次假绿。所以任何未预期异常
// 都要落成「没判过」的结论文件，而不是让 node 带着栈退出。
export function run(argv) {
  const paths = { a: arg(argv, "--a"), b: arg(argv, "--b") };
  const out = arg(argv, "--out");
  let result;
  try {
    const inputs = { a: paths.a ? loadResult(paths.a) : undefined };
    if (paths.b) inputs.b = loadResult(paths.b);
    result = assess(inputs);
    report(paths, result);
  } catch (error) {
    result = crashResult(error);
    process.stderr.write("audit-findings crash: " + (error?.stack ?? error) + "\n");
    try {
      report(paths, result);
    } catch {
      // 报告面再挂一次也不许吃掉结论文件：留痕是次要的，结论是必须的。
    }
  }
  if (out) {
    try {
      writeResult(out, result);
    } catch (error) {
      process.stderr.write("audit-findings 写不出 " + out + "：" + error.message + "\n");
      return 3;
    }
  }
  return result.exitCode;
}

// 入口判定走 realpath：worktree / 软链下 argv[1] 与 import.meta.url 不是同一条字面路径，
// 认不出自己就会静默退出 0 —— 对门来说那是最坏的失败形态（看起来绿）。
const invoked = process.argv[1] ? realpathSync(process.argv[1]) : undefined;
if (invoked === realpathSync(fileURLToPath(import.meta.url)))
  process.exit(run(process.argv.slice(2)));
