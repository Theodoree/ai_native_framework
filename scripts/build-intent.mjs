#!/usr/bin/env node
// build-intent.mjs · 把宿主事件归一成状态机意图
//
// 只做映射，不做判定：判定全部交给 state-validate.mjs。
// 认不出的事件返回 null（表示「不该动状态」），不是错误。
//
// PR 事件必须解析出它引用的 issue：PR 号不是 issue 号。
// 解析不出（0 个或 ≥2 个引用）就把事实如实交出去（issue=null + unresolved），
// 由判定器判 INFRA —— 这里不做裁决，也不静默退回用 PR 号。

import { appendFileSync } from "node:fs";

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
}) {
  const issue = payload.issue ?? {};
  const pr = payload.pull_request ?? {};
  const labels = (issue.labels ?? pr.labels ?? []).map((l) =>
    typeof l === "string" ? l : l.name,
  );

  const make = (number, to, role, extra = {}) => ({
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
    return make(
      resolved.issue,
      to,
      "ci",
      resolved.unresolved ? { unresolved: resolved.unresolved } : {},
    );
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

function main() {
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
    defaultFlow: process.env.DEFAULT_FLOW,
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
