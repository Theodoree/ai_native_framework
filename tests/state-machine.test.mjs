import { test, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { loadConfig, validateIntent } from "../scripts/state-validate.mjs";

const CONFIG = ".agents/platform/state-machine.yml";
const cfg = loadConfig(CONFIG);
const intent = (patch = {}) => ({
  issue: 42,
  to: "accepted",
  actor: "someone",
  actor_role: "owner",
  labels: ["state:analyzing", "type:proposed"],
  comment: "同意，按最小实现做",
  ...patch,
});
const failure = (fn) => {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error("期望判定失败，实际通过了");
};

test("正控 1：owner 带评论裁决 accepted 通过", () => {
  const result = validateIntent(cfg, intent());
  expect(result.to).toBe("accepted");
  expect(result.by).toBe("owner");
});

test("正控 2：agent 越权改状态被拒，且理由点名 agent", () => {
  const error = failure(() =>
    validateIntent(cfg, intent({ actor_role: "agent" })),
  );
  expect(error.code).toBe("E_AGENT_CANNOT_WRITE");
  expect(error.kind).toBe("rejected");
});

test("正控 2b：owner 用别人的转换被拒（needs-info 只能 owner，proposer 不行）", () => {
  const error = failure(() =>
    validateIntent(cfg, intent({ to: "needs-info", actor_role: "proposer" })),
  );
  expect(error.code).toBe("E_ROLE_MISMATCH");
});

test("正控 3：目标状态拼错报 INFRA，不是通过也不是拒绝", () => {
  const error = failure(() => validateIntent(cfg, intent({ to: "accpeted" })));
  expect(error.code).toBe("E_UNKNOWN_STATE");
  expect(error.kind).toBe("infra");
});

test("正控 4：两个 state 标签报 INFRA", () => {
  const error = failure(() =>
    validateIntent(
      cfg,
      intent({ labels: ["state:analyzing", "state:accepted"] }),
    ),
  );
  expect(error.code).toBe("E_STATE_LABEL_COUNT");
  expect(error.kind).toBe("infra");
});

test("新 issue 由 none 起点进入 triage", () => {
  const result = validateIntent(cfg, {
    issue: 1,
    to: "triage",
    actor: "ci",
    actor_role: "ci",
    labels: [],
    comment: "",
  });
  expect(result.from).toBe("none");
  expect(result.to).toBe("triage");
});

test("没有 state 标签却想跳到 accepted 被拒（起点只通向 triage）", () => {
  const error = failure(() =>
    validateIntent(cfg, intent({ labels: ["type:proposed"] })),
  );
  expect(error.code).toBe("E_NO_TRANSITION");
});

test("需要评论的转换缺评论被拒", () => {
  const error = failure(() => validateIntent(cfg, intent({ comment: "   " })));
  expect(error.code).toBe("E_COMMENT_REQUIRED");
});

test("终态不能再转换", () => {
  const error = failure(() =>
    validateIntent(cfg, intent({ labels: ["state:done"], to: "cancelled" })),
  );
  expect(error.code).toBe("E_TERMINAL_STATE");
});

test("agent 即便在终态上也被判为越权（先拒绝越权，再谈转换）", () => {
  const error = failure(() =>
    validateIntent(
      cfg,
      intent({ labels: ["state:done"], to: "cancelled", actor_role: "agent" }),
    ),
  );
  expect(error.code).toBe("E_TERMINAL_STATE");
});

test("CI 由 PR 事件把 accepted 推到 in-progress", () => {
  const result = validateIntent(
    cfg,
    intent({
      labels: ["state:accepted"],
      to: "in-progress",
      actor_role: "ci",
      comment: null,
    }),
  );
  expect(result.by).toBe("ci");
});

test("通配转换允许任意非终态 → cancelled", () => {
  const result = validateIntent(
    cfg,
    intent({ labels: ["state:blocked"], to: "cancelled" }),
  );
  expect(result.by).toBe("owner");
});

test("CLI：配置自检退出 0", () => {
  const r = spawnSync(
    process.execPath,
    ["scripts/state-validate.mjs", "--config", CONFIG, "--check-config"],
    { encoding: "utf8" },
  );
  expect(r.stderr).toBe("");
  expect(r.status).toBe(0);
  expect(r.stdout).toContain("OK_CONFIG");
});

test("CLI：配置缺失退出 3（INFRA，绝不当通过）", () => {
  const r = spawnSync(
    process.execPath,
    ["scripts/state-validate.mjs", "--config", "nope.yml", "--check-config"],
    { encoding: "utf8" },
  );
  expect(r.status).toBe(3);
  expect(r.stdout).toContain("E_CONFIG_MISSING");
});

test("CLI：非法意图退出 1", () => {
  const r = spawnSync(
    process.execPath,
    [
      "scripts/state-validate.mjs",
      "--config",
      CONFIG,
      "--intent",
      "/dev/stdin",
    ],
    {
      encoding: "utf8",
      input: JSON.stringify(intent({ actor_role: "agent" })),
    },
  );
  expect(r.status).toBe(1);
  expect(r.stdout).toContain("E_AGENT_CANNOT_WRITE");
});
