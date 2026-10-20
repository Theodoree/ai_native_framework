import { afterEach, describe, expect, test } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../.agents/skills/verify-change/scripts/verify.sh",
);

const made = [];
const fixture = (files) => {
  const dir = mkdtempSync(join(tmpdir(), "verify-script-"));
  made.push(dir);
  for (const [name, body] of Object.entries(files)) {
    writeFileSync(join(dir, name), body);
  }
  return dir;
};
const pkg = (testScript) =>
  JSON.stringify({ name: "fixture", version: "0.0.0", scripts: { test: testScript } });
const run = (cwd, args = []) => {
  const r = spawnSync("bash", [SCRIPT, ...args], { cwd, encoding: "utf8" });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
};

afterEach(() => {
  while (made.length) rmSync(made.pop(), { recursive: true, force: true });
});

describe("verify.sh 抓得住失败", () => {
  test("(a) 测试脚本通过：汇总 PASS=1 FAIL=0 SKIP=0 且 exit 0", () => {
    const r = run(fixture({ "package.json": pkg("echo tests-ran-ok") }));
    expect(r.out).toContain("=== 汇总: PASS=1 FAIL=0 SKIP=0 ===");
    expect(r.code).toBe(0);
  });

  test("(b) 测试脚本失败：FAIL=1、打印输出尾部、exit 1", () => {
    const r = run(fixture({ "package.json": pkg("echo boom-marker && exit 1") }));
    expect(r.out).toContain("=== 汇总: PASS=0 FAIL=1 SKIP=0 ===");
    expect(r.out).toContain("FAIL  npm test（exit 1");
    expect(r.out).toContain("输出尾部");
    expect(r.out).toContain("boom-marker");
    expect(r.code).toBe(1);
  });

  test("(c) 空目录：打印 SKIP、exit 0，并明确「不等于验证通过」", () => {
    const r = run(fixture({}));
    expect(r.out).toContain("SKIP");
    expect(r.out).toContain("不等于验证通过");
    expect(r.out).toContain("=== 汇总: PASS=0 FAIL=0 SKIP=1 ===");
    expect(r.code).toBe(0);
  });

  test("前导空白的复合命令不被降级成 SKIP，失败照报 FAIL", () => {
    const r = run(fixture({}), ["--run", "  exit 7"]);
    expect(r.out).toContain("=== 汇总: PASS=0 FAIL=1 SKIP=0 ===");
    expect(r.code).toBe(1);
  });

  test("赋值前缀的复合命令不被降级成 SKIP，失败照报 FAIL", () => {
    const r = run(fixture({}), ["--run", "FOO=1 exit 8"]);
    expect(r.out).toContain("=== 汇总: PASS=0 FAIL=1 SKIP=0 ===");
    expect(r.code).toBe(1);
  });

  test("本机没有的裸程序名记 SKIP（不是 PASS）且不失败", () => {
    const r = run(fixture({}), ["--run", "definitely-not-a-cmd-xyz --flag"]);
    expect(r.out).toContain("SKIP  run-1（本机没有 definitely-not-a-cmd-xyz");
    expect(r.out).toContain("=== 汇总: PASS=0 FAIL=0 SKIP=1 ===");
    expect(r.code).toBe(0);
  });

  test("--dry-run 只打印计划，不执行", () => {
    const dir = fixture({ "package.json": pkg("touch ran.marker") });
    const r = run(dir, ["--dry-run"]);
    expect(r.out).toContain("计划（--dry-run：只打印，不执行）:");
    expect(r.out).toContain("run  npm test");
    expect(existsSync(join(dir, "ran.marker"))).toBe(false);
    expect(r.code).toBe(0);
  });

  test("--help 打印用法并 exit 0", () => {
    const r = run(fixture({}), ["--help"]);
    expect(r.out).toContain("用法: verify.sh");
    expect(r.code).toBe(0);
  });
});
