import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { slotRecord } from "../scripts/audit-slot.mjs";

const ok = (evidence) => JSON.stringify({ verdict: "pass", findings: [], evidence });

describe("audit-slot：槽位身份", () => {
  it("自报身份与槽位一致：原样透传", () => {
    const raw = ok({ executor: "sandbox", agent: "review-a", model: "m", request_id: "r" });
    expect(slotRecord({ slot: "review-a", executor: "sandbox", input: raw })).toBe(raw);
  });

  it("一个执行器不许占两个槽：身份不符记 INFRA 并点名两边", () => {
    const raw = ok({ executor: "github", agent: "review-b", model: "m", request_id: "r" });
    const out = JSON.parse(slotRecord({ slot: "review-a", executor: "sandbox", input: raw }));
    expect(out.verdict).toBe("INFRA");
    expect(out.reason).toContain("一个执行器不能占两个槽");
    expect(out.evidence).toEqual({ executor: "sandbox", agent: "review-a" });
  });

  it("没注入就是 INFRA，不是空 findings 的 pass", () => {
    for (const input of ["", "   ", undefined]) {
      const out = JSON.parse(slotRecord({ slot: "review-b", executor: "github", input }));
      expect(out.verdict).toBe("INFRA");
      expect(out.findings).toEqual([]);
    }
  });

  it("坏 JSON 原样交出去：让口径层点名坏字段，而不是在这里改写成 pass", () => {
    expect(slotRecord({ slot: "review-a", executor: "sandbox", input: "{not json" })).toBe("{not json");
  });

  it("evidence 缺失也算身份不符（没有自报身份就等于无法证明是谁）", () => {
    const out = JSON.parse(
      slotRecord({ slot: "review-a", executor: "sandbox", input: JSON.stringify({ verdict: "pass", findings: [] }) }),
    );
    expect(out.verdict).toBe("INFRA");
  });
});

// 入口判定必须是 realpath 而不是字面比较：检出目录常年是软链（worktree、npm link、
// CI 挂载点、macOS 的 /tmp -> /private/tmp）。字面比较在那种环境下判不中，
// 于是既不执行 main 也不报错，exit 0 而 --out 根本没写 —— 对门来说这是最坏的失败形态：
// 「没跑到」长得跟「跑到并通过」一模一样。
const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "audit-slot.mjs");

describe("audit-slot：入口经软链调用", () => {
  it("软链路径调用也真跑（写出 --out），不是静默 exit 0 的假绿", () => {
    const root = mkdtempSync(join(tmpdir(), "audit-slot-link-"));
    try {
      const linkDir = join(root, "linked");
      mkdirSync(linkDir);
      const shim = join(linkDir, "audit-slot.mjs");
      symlinkSync(SCRIPT, shim);
      // 前提自检：这确实是一条与真身不同的字面路径，且指向同一个文件。
      expect(shim).not.toBe(SCRIPT);
      expect(realpathSync(shim)).toBe(realpathSync(SCRIPT));
      const out = join(root, ".audit", "review-a.json");
      const r = spawnSync(
        "node",
        [shim, "--slot", "review-a", "--executor", "sandbox", "--out", out],
        {
          encoding: "utf8",
          env: {
            PATH: process.env.PATH ?? "",
            HOME: process.env.HOME ?? "",
            AUDIT_INPUT: ok({ executor: "sandbox", agent: "review-a", model: "m", request_id: "r" }),
          },
        },
      );
      expect(r.stderr).toBe("");
      expect(r.status, r.stderr).toBe(0);
      // 字面路径比较时这条是红的：exit 0 但文件不存在。
      expect(existsSync(out)).toBe(true);
      expect(JSON.parse(readFileSync(out, "utf8")).verdict).toBe("pass");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
