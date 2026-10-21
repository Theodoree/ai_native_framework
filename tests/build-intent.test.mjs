import { test, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildIntent,
  readIssueLabels,
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
    issueLabelsFromHost: ["state:accepted"],
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
      // "-" = stdin。不用 /dev/stdin：Linux（CI）上读管道会失败。
      "--intent",
      "-",
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
function runCli(eventName, event, extraEnv = {}) {
  const dir = mkdtempSync(join(tmpdir(), "build-intent-"));
  const output = join(dir, "gh_output");
  writeFileSync(output, "");
  const env = {
    ...process.env,
    EVENT_NAME: eventName,
    EVENT: JSON.stringify(event),
    GITHUB_OUTPUT: output,
    ...extraEnv,
  };
  if (!("DEFAULT_FLOW" in extraEnv)) delete env.DEFAULT_FLOW;
  const r = spawnSync(process.execPath, ["scripts/build-intent.mjs"], {
    encoding: "utf8",
    env,
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

// 默认流程的唯一真相源是声明，不是 CI 的 env：workflow 没传 DEFAULT_FLOW 时
// 必须仍按 state-machine.yml 的 policy.default_flow 走，否则 M0 判据（新 issue 自动 accepted）就落空。
test("CLI：没有 DEFAULT_FLOW 时按声明走 auto（CI 的真实情形）", () => {
  const r = runCli("issues", {
    action: "opened",
    issue: { number: 101, labels: [], author_association: "OWNER" },
  });
  expect(r.status).toBe(0);
  expect(JSON.parse(r.stdout)).toMatchObject({
    issue: 101,
    to: "accepted",
    actor_role: "platform",
  });
});

test("CLI：DEFAULT_FLOW 仍能覆盖声明（manual → triage）", () => {
  const r = runCli(
    "issues",
    {
      action: "opened",
      issue: { number: 102, labels: [], author_association: "OWNER" },
    },
    { DEFAULT_FLOW: "manual" },
  );
  expect(JSON.parse(r.stdout)).toMatchObject({ issue: 102, to: "triage" });
});

// 真 PR #2 的形状：事件是 PR（number=2），它引用 issue #1，issue #1 的当前状态是
// state:accepted —— 而那些标签只存在于宿主，payload 里没有。
const realPr = (fields = {}) =>
  prWith({ number: 2, body: "Fixes #1", title: "feat: 状态机", ...fields });

const validateStdin = (stdout) =>
  spawnSync(
    process.execPath,
    [
      "scripts/state-validate.mjs",
      "--config",
      CONFIG,
      "--intent",
      "-",
      "--json",
    ],
    { encoding: "utf8", input: stdout },
  );

test("(a) PR 事件：宿主注入 state:accepted → from=accepted、to=in-progress、判定 allowed", () => {
  const out = buildIntent({
    eventName: "pull_request",
    action: "opened",
    payload: realPr(),
    issueLabelsFromHost: ["state:accepted"],
  });
  expect(out).toMatchObject({
    issue: 1,
    to: "in-progress",
    actor_role: "ci",
    labels: ["state:accepted"],
  });
  expect(out.unresolved).toBeUndefined();
  const verdict = validateIntent(loadConfig(CONFIG), out);
  expect(verdict).toMatchObject({
    from: "accepted",
    to: "in-progress",
    by: "ci",
  });
});

test("(b) PR 事件：宿主注入终态 state:done → 拒绝 E_TERMINAL_STATE，意图仍指 issue 1（不是 PR 号 2）", () => {
  // 本地绿、CI 红的教训：from 只能来自宿主取数（ISSUE_STATE_FILE 注入），
  // 不能把 payload 里「没有 issue 标签」读成 none —— 旧实现正是这么判出 E_NO_TRANSITION，
  // 而单元测试伪造的 payload 自带 labels，所以本地看不出来。
  const out = buildIntent({
    eventName: "pull_request",
    action: "opened",
    payload: realPr(),
    issueLabelsFromHost: ["state:done"],
  });
  expect(out.issue).toBe(1);
  expect(out.issue).not.toBe(2);
  let error;
  try {
    validateIntent(loadConfig(CONFIG), out);
  } catch (caught) {
    error = caught;
  }
  expect(error.kind).toBe("rejected");
  expect(error.code).toBe("E_TERMINAL_STATE");
});

test("解出 issue 但宿主没交状态 → 判 INFRA，绝不把缺席读成 none", () => {
  const out = buildIntent({
    eventName: "pull_request",
    action: "opened",
    payload: realPr(),
    issueLabelsFromHost: null,
  });
  expect(out.labels).toEqual([]);
  expect(out.unresolved).toEqual({
    reason: "issue-state-unavailable",
    candidates: [1],
  });
  let error;
  try {
    validateIntent(loadConfig(CONFIG), out);
  } catch (caught) {
    error = caught;
  }
  expect(error.kind).toBe("infra");
  expect(error.code).toBe("E_ISSUE_UNRESOLVED");
});

test("issues.* 事件不用注入：payload 自带标签（回归）", () => {
  const out = buildIntent({
    eventName: "issues",
    action: "labeled",
    payload: issue(["state:accepted"], { label: { name: "state:in-progress" } }),
    actorRole: "owner",
    issueLabelsFromHost: null,
  });
  expect(out.labels).toEqual(["state:accepted"]);
  expect(out.to).toBe("in-progress");
});

test("readIssueLabels：拿不到返回 null，拿到零个标签返回 []（两种事实不能混）", () => {
  const dir = mkdtempSync(join(tmpdir(), "issue-state-"));
  const write = (name, body) => {
    const path = join(dir, name);
    writeFileSync(path, body);
    return path;
  };
  expect(readIssueLabels(undefined)).toBeNull();
  expect(readIssueLabels(join(dir, "missing.json"))).toBeNull();
  expect(readIssueLabels(write("empty.json", ""))).toBeNull();
  expect(readIssueLabels(write("bad.json", "not json"))).toBeNull();
  expect(readIssueLabels(write("shape.json", '{"name":"x"}'))).toBeNull();
  expect(readIssueLabels(write("none.json", '{"labels":[]}'))).toEqual([]);
  expect(
    readIssueLabels(
      write("ok.json", '{"labels":["state:accepted","type:bugfix"]}'),
    ),
  ).toEqual(["state:accepted", "type:bugfix"]);
});

const stateFile = (body) => {
  const path = join(
    mkdtempSync(join(tmpdir(), "issue-state-cli-")),
    "issue-state.json",
  );
  writeFileSync(path, body);
  return path;
};

test("CLI：(a) 注入 accepted → 判定 allowed（exit 0），from 来自注入而不是 payload", () => {
  const r = runCli("pull_request", { ...realPr(), action: "opened" }, {
    ISSUE_STATE_FILE: stateFile('{"labels":["state:accepted"]}'),
  });
  expect(r.status).toBe(0);
  const intent = JSON.parse(r.stdout);
  expect(intent).toMatchObject({
    issue: 1,
    to: "in-progress",
    labels: ["state:accepted"],
  });
  const v = validateStdin(r.stdout);
  expect(v.status).toBe(0);
  expect(JSON.parse(v.stdout)).toMatchObject({
    verdict: "allowed",
    from: "accepted",
    to: "in-progress",
  });
});

test("CLI：(b) 注入终态 done → rejected E_TERMINAL_STATE（exit 1），issue 仍是 1", () => {
  const r = runCli("pull_request", { ...realPr(), action: "opened" }, {
    ISSUE_STATE_FILE: stateFile('{"labels":["state:done"]}'),
  });
  const intent = JSON.parse(r.stdout);
  expect(intent.issue).toBe(1);
  const v = validateStdin(r.stdout);
  expect(v.status).toBe(1);
  expect(JSON.parse(v.stdout)).toMatchObject({
    verdict: "rejected",
    code: "E_TERMINAL_STATE",
    from: "done",
  });
});

test("CLI：(c) 解不出 issue → 仍是 INFRA（exit 3），不回退 PR 号", () => {
  const r = runCli(
    "pull_request",
    {
      ...prWith({ number: 9, body: "随手改点东西", title: "chore: nits" }),
      action: "opened",
    },
    { ISSUE_STATE_FILE: stateFile('{"labels":["state:accepted"]}') },
  );
  expect(r.status).toBe(0);
  const intent = JSON.parse(r.stdout);
  expect(intent.issue).toBeNull();
  expect(intent.unresolved.reason).toBe("no-issue-reference");
  const v = validateStdin(r.stdout);
  expect(v.status).toBe(3);
  expect(JSON.parse(v.stdout).code).toBe("E_ISSUE_UNRESOLVED");
});

test("CLI --resolve-issue：只解析 issue 号，解不出什么都不打印", () => {
  const ok = spawnSync(
    process.execPath,
    ["scripts/build-intent.mjs", "--resolve-issue"],
    {
      encoding: "utf8",
      env: { ...process.env, EVENT: JSON.stringify(realPr()) },
    },
  );
  expect(ok.status).toBe(0);
  expect(ok.stdout).toBe("1\n");
  expect(ok.stderr).toBe("");

  const none = spawnSync(
    process.execPath,
    ["scripts/build-intent.mjs", "--resolve-issue"],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        EVENT: JSON.stringify(prWith({ body: "随手", title: "chore" })),
      },
    },
  );
  expect(none.status).toBe(0);
  expect(none.stdout).toBe("");
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
