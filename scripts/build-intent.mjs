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

  // default_flow=auto：新需求直接受理，actor 是平台自己；缺省仍是入库分发。
  if (eventName === "issues" && action === "opened")
    return defaultFlow === "auto"
      ? make(issue.number ?? null, "accepted", "platform")
      : make(issue.number ?? null, "triage", "ci");
  if (eventName === "issues" && action === "labeled") {
    const label = payload.label?.name ?? "";
    if (!label.startsWith("state:")) return null;
    return make(issue.number ?? null, label.slice("state:".length), actorRole);
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
    // 解不出 issue：原样交出去，由判定器判 INFRA。
    if (resolved.issue === null)
      return make(null, to, "ci", { unresolved: resolved.unresolved });
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
        },
        [],
      );
    return make(resolved.issue, to, "ci", {}, issueLabelsFromHost);
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
