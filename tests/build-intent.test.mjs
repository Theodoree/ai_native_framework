import { test, expect } from "vitest";
import { buildIntent, roleFromAssociation } from "../scripts/build-intent.mjs";

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
    author_association: "CONTRIBUTOR",
  },
  sender: { login: "agent" },
  ...patch,
});

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

test("pull_request.opened → in-progress", () => {
  const out = buildIntent({
    eventName: "pull_request",
    action: "opened",
    payload: pr(),
  });
  expect(out).toMatchObject({ issue: 9, to: "in-progress", actor_role: "ci" });
});

test("pull_request.closed 未合并 → 不动状态（取消由 owner 裁决）", () => {
  expect(
    buildIntent({ eventName: "pull_request", action: "closed", payload: pr() }),
  ).toBeNull();
});

test("pull_request.closed 已合并 → done", () => {
  const payload = pr({
    pull_request: {
      number: 9,
      merged: true,
      labels: [],
      author_association: "OWNER",
    },
  });
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
