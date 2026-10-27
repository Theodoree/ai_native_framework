import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { defineParitySuite } from "./helpers/parity-suite.mjs";
import { suiteE } from "./goldens/parity-cases.mjs";

// P-31 迁移的验收闸门：**只跑 Go 引擎**，与 tests/goldens/ 里冻结的期望值逐字节比。
// 期望值来自 scripts/*.mjs 曾经的输出，冻结后就是数据 —— 本文件不执行任何 Node 侧脚本，
// 所以删掉 scripts/ 不再是这条闸门的障碍物。
// 重新冻结是显式动作：node tests/goldens/freeze.mjs e
defineParitySuite(suiteE);

// 这两条不比对输出，钉的是「调用点已经切到引擎、不许回退」的接线事实：
// 引擎再对，只要还有人从 package.json / CI 走 node scripts/*.mjs，迁移就没有发生。
const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

describe("调用点已切到引擎（钉住，不许回退）", () => {
  const packageText = readFileSync(join(repoRoot, "package.json"), "utf8");
  const packageJson = JSON.parse(packageText);
  const kbSync = readFileSync(join(repoRoot, ".github", "workflows", "kb-sync.yml"), "utf8");

  it("package.json 不再用 node 跑 cli.mjs 与 copy-dist.mjs", () => {
    expect(packageText).not.toContain("node " + "scripts/cli.mjs");
    expect(packageText).not.toContain("node " + "scripts/copy-dist.mjs");
    expect(packageJson.scripts.cli).toContain("engine cli");
    expect(packageJson.scripts["web:dist"]).toContain("engine copy-dist");
    expect(packageJson.scripts["check:web"]).toContain("engine copy-dist");
  });

  it("kb-sync.yml 不再用 node 跑 kb-export.mjs", () => {
    expect(kbSync).not.toContain("node " + "scripts/kb-export.mjs");
    expect(kbSync).toContain("engine kb-export");
  });
});
