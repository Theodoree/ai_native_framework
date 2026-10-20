import { test, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildIntent,
  resolveIssueRefs,
  roleFromAssociation,
} from "../scripts/build-intent.mjs";
import { loadConfig, validateIntent } from "../scripts/state-validate.mjs";

const CONFIG = ".agents/platform/state-machine.yml";

const issue = (labels = [], extra = {}) => ({
  issue: {
    number: 7,
    labels: labels.map((name) => ({ name })),
    author_association: "OWNER",
  },
  sender: { login: "ted" },
  ...extra,
});
const pr = (patch = {}) => ({
  pull_request: {
    number: 9,
    merged: false,
    labels: [],
    body: "Fixes #7",
    title: "feat: 收口状态机",
    author_association: "CONTRIBUTOR",
  },
  sender: { login: "agent" },
  ...patch,
});
const prWith = (fields) =>
  pr({ pull_request: { ...pr().pull_request, ...fields } });

test("issues.opened → triage，由 ci 触发", () => {
  const out = buildIntent({
    eventName: "issues",
    action: "opened",
    payload: issue(),
  });
  expect(out).toMatchObject({ issue: 7, to: "triage", actor_role: "ci" });
});

test("issues.labeled 取 state: 后面的名字作为目标，角色来自 association", () => {
  const payload = issue(["state:analyzing"], {
    label: { name: "state:accepted" },
  });
  const out = buildIntent({
    eventName: "issues",
    action: "labeled",
    payload,
    comment: "同意",
    actorRole: "owner",
  });
  expect(out.to).toBe("accepted");
  expect(out.actor_role).toBe("owner");
  expect(out.labels).toEqual(["state:analyzing"]);
});

test("非 state 标签的 labeled 事件不动状态", () => {
  const payload = issue(["state:triage"], { label: { name: "type:bugfix" } });
  expect(
    buildIntent({
      eventName: "issues",
      action: "labeled",
      payload,
      actorRole: "owner",
    }),
  ).toBeNull();
});

test("pull_request.opened → in-progress，归属它引用的 issue", () => {
  const out = buildIntent({
    eventName: "pull_request",
    action: "opened",
    payload: pr(),
  });
  expect(out).toMatchObject({ issue: 7, to: "in-progress", actor_role: "ci" });
});

test("(a) body 含 Fixes #12 → issue 是 12，不是 PR 号", () => {
  const out = buildIntent({
    eventName: "pull_request",
    action: "opened",
    payload: prWith({ number: 9, body: "这个补丁 Fixes #12" }),
  });
  expect(out.issue).toBe(12);
  expect(out.unresolved).toBeUndefined();
});

test("(b) body 无引用 → issue 为空并带 unresolved，绝不退回 PR 号", () => {
  const out = buildIntent({
    eventName: "pull_request",
    action: "opened",
    payload: prWith({ number: 9, body: "随手改点东西", title: "chore: nits" }),
  });
  expect(out.issue).toBeNull();
  expect(out.issue).not.toBe(9);
  expect(out.to).toBe("in-progress");
  expect(out.unresolved).toEqual({
    reason: "no-issue-reference",
    candidates: [],
  });
});

test("(b) 上链路：无引用的 PR 事件被判定器判 INFRA，CLI 退出码 3", () => {
  const out = buildIntent({
    eventName: "pull_request",
    action: "opened",
    payload: prWith({ body: "随手改点东西", title: "chore: nits" }),
  });
  let error;
  try {
    validateIntent(loadConfig(CONFIG), out);
  } catch (caught) {
    error = caught;
  }
  expect(error.kind).toBe("infra");
  expect(error.code).toBe("E_ISSUE_UNRESOLVED");

  const r = spawnSync(
    process.execPath,
    [
      "scripts/state-validate.mjs",
      "--config",
      CONFIG,
      "--intent",
      "/dev/stdin",
    ],
    { encoding: "utf8", input: JSON.stringify(out) },
  );
  expect(r.status).toBe(3);
  expect(r.stdout).toContain("E_ISSUE_UNRESOLVED");
});

test("(c) body 含 Fixes #12, closes #13 → 判不了，交出去（不猜）", () => {
  const out = buildIntent({
    eventName: "pull_request",
    action: "synchronize",
    payload: prWith({ body: "Fixes #12, closes #13" }),
  });
  expect(out.issue).toBeNull();
  expect(out.unresolved).toEqual({
    reason: "multiple-issue-references",
    candidates: [12, 13],
  });
});

test("body 没写引用时用 title 兜底", () => {
  const out = buildIntent({
    eventName: "pull_request",
    action: "opened",
    payload: prWith({ body: "", title: "Close #21" }),
  });
  expect(out.issue).toBe(21);
});

test("同一个 issue 写两次不算两个引用", () => {
  const out = buildIntent({
    eventName: "pull_request",
    action: "opened",
    payload: prWith({ body: "Fixes #12, closes #12" }),
  });
  expect(out.issue).toBe(12);
});

test("close 类关键字大小写不敏感，冒号可有可无", () => {
  expect(resolveIssueRefs("RESOLVED: #31")).toEqual([31]);
  expect(resolveIssueRefs("Closes #32 and fixes #33")).toEqual([32, 33]);
  expect(resolveIssueRefs("no close keywords here #34")).toEqual([]);
});

test("pull_request.closed 未合并 → 不动状态（取消由 owner 裁决）", () => {
  expect(
    buildIntent({ eventName: "pull_request", action: "closed", payload: pr() }),
  ).toBeNull();
});

test("pull_request.closed 已合并 → done", () => {
  const payload = prWith({ merged: true, author_association: "OWNER" });
  expect(
    buildIntent({ eventName: "pull_request", action: "closed", payload }).to,
  ).toBe("done");
});

test("认不出的事件返回 null 而不是猜", () => {
  expect(
    buildIntent({ eventName: "push", action: "", payload: {} }),
  ).toBeNull();
});

test("角色只认 author_association：OWNER/MEMBER 是 owner，其余是 proposer", () => {
  expect(roleFromAssociation("OWNER")).toBe("owner");
  expect(roleFromAssociation("MEMBER")).toBe("owner");
  expect(roleFromAssociation("CONTRIBUTOR")).toBe("proposer");
  expect(roleFromAssociation(undefined)).toBe("proposer");
});

// CLI 契约：这次事件有没有意图，由 build-intent 自己公布（它是意图的产地），
// 调用方不该拿 intent.json 的大小去猜 —— 猜错就会把空文件送进判定与留痕。
function runCli(eventName, event) {
  const dir = mkdtempSync(join(tmpdir(), "build-intent-"));
  const output = join(dir, "gh_output");
  writeFileSync(output, "");
  const r = spawnSync(process.execPath, ["scripts/build-intent.mjs"], {
    encoding: "utf8",
    env: {
      ...process.env,
      EVENT_NAME: eventName,
      EVENT: JSON.stringify(event),
      GITHUB_OUTPUT: output,
    },
  });
  return { ...r, output: readFileSync(output, "utf8") };
}

test("CLI：没有意图时 has_intent=0，日志留一行可读说明而不是静默消失", () => {
  const r = runCli("issues", { action: "closed", issue: { number: 7 } });
  expect(r.status).toBe(0);
  expect(r.stdout).toBe("");
  expect(r.stderr).toContain("no-state-change issues.closed");
  expect(r.stderr).toContain("跳过判定与留痕");
  expect(r.output).toBe("has_intent=0\n");
});

test("CLI：有意图时 has_intent=1，并照旧输出意图 JSON", () => {
  const r = runCli("issues", {
    action: "labeled",
    issue: { number: 7, labels: [{ name: "state:analyzing" }] },
    label: { name: "state:accepted" },
  });
  expect(r.status).toBe(0);
  expect(r.output).toBe("has_intent=1\n");
  expect(JSON.parse(r.stdout)).toMatchObject({ issue: 7, to: "accepted" });
});

test("wiring：apply 用意图解析出的 issue，record 只调用 writer-record", () => {
  const yml = readFileSync(".github/workflows/state-writer.yml", "utf8");
  expect(yml).toContain("require('./intent.json').issue");
  expect(yml).toContain(
    "node scripts/writer-record.mjs --verdict verdict.json",
  );
  expect(yml).not.toContain("状态未被修改");
});

// 无意图事件的三个下游步骤都必须被 has_intent 挡住：
// 否则 validate 拿到空文件判 INFRA、record 贴一条「状态未被修改」并让 job 变红。
test("wiring：validate/apply/record 都以 has_intent 为闸门", () => {
  const yml = readFileSync(".github/workflows/state-writer.yml", "utf8");
  expect(yml).toContain("id: intent");
  expect(yml).toContain("if: steps.intent.outputs.has_intent == '1'\n");
  expect(yml).toContain(
    "steps.intent.outputs.has_intent == '1' && steps.validate.outputs.exit == '0'",
  );
  expect(yml).toContain(
    "steps.intent.outputs.has_intent == '1' && steps.validate.outputs.exit != '0'",
  );
  expect(yml).not.toContain("no state change");
});
