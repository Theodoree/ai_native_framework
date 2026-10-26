import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

// 引擎构建只有一个入口（npm run build:engine），三个 workflow 与 npm 脚本都靠它。
// 这里盯的是「谁建、在哪建、建完谁用」这条链本身：
// 迁移的目的就是让判据与门不再依赖 Node，所以 check:state 退回 node、
// workflow 漏掉构建步、或把构建放到 setup-go 之前，都必须在这里红。
// 这些形态在运行时只会表现成 127 或悄悄退回 Node，没有一条会让别的用例变红。

const ROOT = process.cwd();
const WORKFLOW_DIR = join(ROOT, ".github", "workflows");
const ENGINE_BIN = "./.cache/bin/engine";
const BUILD_RUN = "npm run build:engine";

const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));

const workflows = Object.fromEntries(
  readdirSync(WORKFLOW_DIR)
    .filter((name) => /\.ya?ml$/.test(name))
    .map((name) => [name, parse(readFileSync(join(WORKFLOW_DIR, name), "utf8"))]),
);

const runOf = (step) => (typeof step.run === "string" ? step.run : "");

function jobSteps(doc, jobId) {
  return (doc.jobs?.[jobId]?.steps ?? []).map((step, index) => ({ index, step }));
}

// 每个 workflow 里「真正调用引擎」的 job：只在这些 job 上要求构建前置，
// 免得把同文件里别的 job（例如纯 Node 的审计）当成本 job 的前置。
const engineJobs = Object.entries(workflows).flatMap(([name, doc]) =>
  Object.keys(doc.jobs ?? {})
    .map((jobId) => ({
      name,
      jobId,
      steps: jobSteps(doc, jobId),
    }))
    .filter((job) => job.steps.some(({ step }) => runOf(step).includes(ENGINE_BIN))),
);

const where = (job) => job.name + " / " + job.jobId;

describe("引擎构建入口：谁建、在哪建、建完谁用", () => {
  it("build:engine 是唯一构建入口，产物落在被忽略的 .cache/bin", () => {
    const build = pkg.scripts["build:engine"];
    expect(build).toBeTypeOf("string");
    expect(build).toContain("apps/engine");
    expect(build).toContain("./cmd/engine");
    expect(build).toContain("../../.cache/bin/engine");
    expect(build).toContain(".cache/go");
  });

  it("check:state 走引擎不走 node（迁移的退出路径守卫）", () => {
    const script = pkg.scripts["check:state"];
    expect(script).toContain(ENGINE_BIN + " check-config");
    expect(script).not.toMatch(/(^|[\s;&|(])node\b/);
    expect(pkg.scripts.check).toContain("check:state");
    expect(pkg.scripts.check).toContain("check:engine");
  });

  it("扫描面非空，且恰好是三家调用引擎的 workflow（扫描落空也要红）", () => {
    expect([...new Set(engineJobs.map((job) => job.name))].sort()).toEqual([
      "last-change.yml",
      "merge-gate.yml",
      "state-writer.yml",
    ]);
  });

  const named = engineJobs.map((job) => [where(job), job]);
  it.each(named)("%s：先 setup-go，再一次构建，然后才调用引擎", (_label, job) => {
    const buildIndices = job.steps
      .filter(({ step }) => runOf(step).includes(BUILD_RUN))
      .map(({ index }) => index);
    expect(buildIndices).toHaveLength(1);

    const goIndices = job.steps
      .filter(({ step }) => String(step.uses ?? "").startsWith("actions/setup-go"))
      .map(({ index }) => index);
    expect(goIndices.length).toBeGreaterThan(0);

    const engineIndices = job.steps
      .filter(({ step }) => runOf(step).includes(ENGINE_BIN))
      .map(({ index }) => index);
    expect(engineIndices.length).toBeGreaterThan(0);

    const build = buildIndices[0];
    expect(Math.max(...goIndices)).toBeLessThan(build);
    expect(build).toBeLessThan(Math.min(...engineIndices));
  });

  it("也没有谁偷偷把调用点换回 node scripts/*.mjs", () => {
    const offenders = engineJobs.flatMap((job) =>
      job.steps
        .filter(({ step }) => /node\s+scripts\/(merge-gate|state-validate|build-intent|last-change|writer-record)\.mjs/.test(runOf(step)))
        .map(({ index, step }) => where(job) + " #" + index + ": " + runOf(step).trim()),
    );
    expect(offenders).toEqual([]);
  });

  it("构建失败即红：构建步没有被 continue-on-error 放过", () => {
    const lenient = engineJobs.flatMap((job) =>
      job.steps
        .filter(({ step }) => runOf(step).includes(BUILD_RUN) && step["continue-on-error"])
        .map(({ index }) => where(job) + " #" + index),
    );
    expect(lenient).toEqual([]);
  });
  
  it("setup-go 不只是摆设：版本钉在 1.22", () => {
    const versions = engineJobs.flatMap((job) =>
      job.steps
        .filter(({ step }) => String(step.uses ?? "").startsWith("actions/setup-go"))
        .map(({ step }) => String(step.with?.["go-version"] ?? "")),
    );
    expect(versions.length).toBeGreaterThan(0);
    for (const version of versions) expect(version).toBe("1.22");
  });
});
