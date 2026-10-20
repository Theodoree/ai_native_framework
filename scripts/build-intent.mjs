#!/usr/bin/env node
// build-intent.mjs · 把宿主事件归一成状态机意图
//
// 只做映射，不做判定：判定全部交给 state-validate.mjs。
// 认不出的事件返回 null（表示「不该动状态」），不是错误。

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
  const number = issue.number ?? pr.number ?? null;

  const make = (to, role) => ({
    issue: number,
    to,
    actor: payload.sender?.login ?? "unknown",
    actor_role: role,
    labels,
    comment,
  });

  // default_flow=auto：新需求直接受理，actor 是平台自己；缺省仍是入库分发。
  if (eventName === "issues" && action === "opened")
    return defaultFlow === "auto"
      ? make("accepted", "platform")
      : make("triage", "ci");
  if (eventName === "issues" && action === "labeled") {
    const label = payload.label?.name ?? "";
    if (!label.startsWith("state:")) return null;
    return make(label.slice("state:".length), actorRole);
  }
  if (eventName === "pull_request" && action === "opened")
    return make("in-progress", "ci");
  if (eventName === "pull_request" && action === "synchronize")
    return make("in-progress", "ci");
  if (eventName === "pull_request" && action === "closed" && pr.merged === true)
    return make("done", "ci");
  return null;
}

// 角色只从宿主的 author_association 推，不读任何自述身份。
export function roleFromAssociation(association) {
  if (association === "OWNER" || association === "MEMBER") return "owner";
  return "proposer";
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
    process.stderr.write(`no-state-change ${eventName}.${action}\n`);
    process.exit(0);
  }
  process.stdout.write(JSON.stringify(intent, null, 2) + "\n");
}

if (import.meta.url === `file://${process.argv[1]}`) main();
