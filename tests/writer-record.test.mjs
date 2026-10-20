import { test, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  recordBody,
  recordExitCode,
  recordOutcome,
} from "../scripts/writer-record.mjs";

const allowed = {
  verdict: "allowed",
  code: "OK",
  message: "允许 none → triage（ci）",
  from: "none",
  to: "triage",
  by: "ci",
  flow: null,
  event: null,
};
const rejected = {
  verdict: "rejected",
  code: "E_ROLE_MISMATCH",
  message: "done → cancelled 只能由 owner 触发，实际是 ci",
};
const infra = {
  verdict: "infra",
  code: "E_ISSUE_UNRESOLVED",
  message:
    "意图没有归属的 issue（no-issue-reference）——PR 号不作为 issue 号使用",
  unresolved: { reason: "no-issue-reference", candidates: [] },
};

// 假的 gh：把调用参数追加到 calls.log，退出 0。
function ghStub() {
  const dir = mkdtempSync(join(tmpdir(), "writer-record-"));
  const log = join(dir, "calls.log");
  writeFileSync(
    join(dir, "gh"),
    `#!/bin/sh
printf '%s\\n' "$*" >> "${log}"
exit 0
`,
    { mode: 0o755 },
  );
  return { dir, log };
}

function runCli(verdict, issue = "42") {
  const { dir, log } = ghStub();
  const verdictPath = join(dir, "verdict.json");
  writeFileSync(verdictPath, JSON.stringify(verdict));
  const r = spawnSync(
    process.execPath,
    [
      "scripts/writer-record.mjs",
      "--verdict",
      verdictPath,
      "--issue",
      String(issue),
    ],
    {
      encoding: "utf8",
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
    },
  );
  let calls = [];
  try {
    calls = readFileSync(log, "utf8").trim().split("\n").filter(Boolean);
  } catch {
    calls = [];
  }
  return { status: r.status, stdout: r.stdout, calls };
}

test("allowed：不评论、退出 0", async () => {
  const calls = [];
  const code = await recordOutcome({
    verdict: allowed,
    issue: 7,
    comment: async (...args) => calls.push(args),
  });
  expect(recordBody(allowed)).toBeNull();
  expect(calls).toEqual([]);
  expect(code).toBe(0);
});

test("rejected：评论正文 + 退出 0（拒绝不是故障）", async () => {
  const calls = [];
  const code = await recordOutcome({
    verdict: rejected,
    issue: 42,
    comment: async (issue, body) => calls.push([issue, body]),
  });
  expect(calls).toEqual([
    [
      42,
      "状态未被修改：REJECTED E_ROLE_MISMATCH — done → cancelled 只能由 owner 触发，实际是 ci",
    ],
  ]);
  expect(code).toBe(0);
});

test("infra：评论正文 + 退出 1（没判定成功绝不当通过）", async () => {
  const calls = [];
  const code = await recordOutcome({
    verdict: infra,
    issue: 9,
    comment: async (issue, body) => calls.push([issue, body]),
  });
  expect(calls).toEqual([
    [
      9,
      "状态未被修改：INFRA E_ISSUE_UNRESOLVED — 意图没有归属的 issue（no-issue-reference）——PR 号不作为 issue 号使用",
    ],
  ]);
  expect(recordExitCode(infra)).toBe(1);
  expect(code).toBe(1);
});

test("认不出的判定结果既不算通过也不评论", async () => {
  expect(recordExitCode({ verdict: "weird" })).toBe(1);
  expect(() => recordBody({ verdict: "weird" })).toThrow(/未知判定结果/);
});

test("要留痕却没有 issue 号时拒绝执行，而不是发到 0 号上", async () => {
  await expect(
    recordOutcome({ verdict: rejected, issue: 0, comment: async () => {} }),
  ).rejects.toThrow(/留痕需要一个 issue 号/);
});

test("CLI：allowed 不留痕且退出 0", () => {
  const r = runCli(allowed);
  expect(r.calls).toEqual([]);
  expect(r.status).toBe(0);
});

test("CLI：rejected 留痕到指定 issue 且退出 0", () => {
  const r = runCli(rejected, "42");
  expect(r.calls).toEqual([
    "issue comment 42 --body 状态未被修改：REJECTED E_ROLE_MISMATCH — done → cancelled 只能由 owner 触发，实际是 ci",
  ]);
  expect(r.status).toBe(0);
});

test("CLI：infra 留痕且退出 1（job 红）", () => {
  const r = runCli(infra, "9");
  expect(r.calls.length).toBe(1);
  expect(r.calls[0]).toContain(
    "issue comment 9 --body 状态未被修改：INFRA E_ISSUE_UNRESOLVED",
  );
  expect(r.status).toBe(1);
});

test("CLI：读不到判定结果退出 1（INFRA 语义，绝不当通过）", () => {
  const r = spawnSync(
    process.execPath,
    ["scripts/writer-record.mjs", "--verdict", "nope.json", "--issue", "1"],
    { encoding: "utf8" },
  );
  expect(r.status).toBe(1);
  expect(r.stderr).toContain("读不到判定结果");
});
