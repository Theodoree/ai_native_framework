import { test, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import YAML from "yaml";
import { engineInto } from "./helpers/engine.mjs";

// 专测 kb-sync 的接线：job 红绿由 YAML 的 if 与步骤正文决定。
// 清单契约（六字段 / 幂等 / 排除项 / INFRA 不阻断合并）原先由 scripts/kb-export.mjs 真跑出来断言，
// 该脚本已随 E2 第四批搬进 apps/engine/kbexport.go 并删除，判据钉在 apps/engine/kbexport_test.go；
// 这里只剩两件不属于导出器实现的事：export 失败只记 INFRA 不让 job 变红，YAML 把调用点钉在 Go 引擎上。
const ROOT = process.cwd();
const WORKFLOW = join(ROOT, ".github/workflows/kb-sync.yml");
const REPO = "owner/name";
const AT = "2020-05-06T07:08:09+00:00";

function sh(cwd, args, env = {}) {
  const r = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.com",
      ...env,
    },
  });
  if (r.status !== 0)
    throw new Error("git " + args.join(" ") + "\n" + r.stderr);
  return r.stdout.trim();
}

function newRepo() {
  const dir = mkdtempSync(join(tmpdir(), "kb-export-"));
  sh(dir, ["init", "-q", "-b", "main"]);
  return dir;
}

function put(dir, path, body) {
  const full = join(dir, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, body);
}

function commit(dir, files, { message = "c", date = AT } = {}) {
  for (const [path, body] of Object.entries(files)) put(dir, path, body);
  sh(dir, ["add", "-A"]);
  sh(dir, ["commit", "-q", "-m", message], {
    GIT_AUTHOR_DATE: date,
    GIT_COMMITTER_DATE: date,
  });
  return sh(dir, ["rev-parse", "HEAD"]);
}

function mergedRange() {
  const dir = newRepo();
  const base = commit(
    dir,
    {
      ".agents/notes/implemented/p01-baseline.md": "baseline\n",
      "docs/architecture.md": "arch v1\n",
    },
    { message: "base" },
  );
  const tip = commit(
    dir,
    {
      ".agents/notes/implemented/p02-delta.md": "delta\n",
      "docs/architecture.md": "arch v2\n",
      "docs/postmortem/p01-outage.md": "outage\n",
    },
    { message: "merge" },
  );
  return { dir, base, tip };
}

test("(e/f) workflow：export 非 0 → 只记 INFRA，步骤与 job 都不红", () => {
  const { dir, base } = mergedRange();
  const r = runWorkflow(dir, { before: base, after: "deadbeef" });

  expect(r.outputs.export.exit).toBe("3");
  expect(r.ok("export manifest").status).toBe(0);
  expect(r.evalIf("steps.export.outputs.exit != '0'")).toBe(true);
  expect(r.ok("record infra").status).toBe(0);
  expect(r.ok("record infra").stdout).toContain("::warning");
  expect(r.failed).toEqual([]);
  // 失败也留下了 INFRA 记录，且下一次合并知道该重试什么。
  expect(r.infra.kind).toBe("infra");
  expect(readFileSync(join(dir, ".kb-out/kb-manifest.yml"), "utf8")).toContain(
    "[]",
  );
});

test("(f) wiring 钉在 YAML 上：只在合并后跑、真调脚本、失败走 record infra", () => {
  const doc = YAML.parse(readFileSync(WORKFLOW, "utf8"));
  const steps = doc.jobs.export.steps;
  const byId = (id) => steps.find((s) => s.id === id);
  const byName = (name) => steps.find((s) => s.name === name);

  // 合并已完成才跑：本 workflow 不是合并判定的一环。
  expect(Object.keys(doc.on)).toEqual(["push"]);
  expect(doc.on.push.branches).toContain("main");

  const exportStep = byId("export");
  // 调用点是 Go 引擎（载体在 apps/engine，由 tests/engine-parity-e.test.mjs 逐字节对照），
  // 这里钉的是 workflow 里那行字：退回 node 就等于退回 Node 侧的判据。
  expect(exportStep.run).toContain("./.cache/bin/engine kb-export");
  expect(exportStep.run).not.toContain("node scripts/kb-export.mjs");
  for (const flag of [
    "--repo",
    "--ref",
    "--from",
    "--to",
    "--existing",
    "--retry",
    "--out",
    "--infra-out",
  ])
    expect(exportStep.run).toContain(flag);
  expect(exportStep["continue-on-error"]).toBe(true);

  // 失败果只进 record infra；它自己退 0，且怕的是它顺手把 job 弄红。
  const infraStep = byName("record infra");
  expect(infraStep.if).toBe("steps.export.outputs.exit != '0'");
  expect(infraStep.run).toContain("exit 0");

  // 上一轮的产物名必须和这一轮上传的对得上，否则 --existing/--retry 永远空转。
  const restoreStep = byName("restore previous artifacts");
  expect(restoreStep.run).toContain("--name kb-manifest");
  expect(restoreStep.run).toContain("--name kb-infra");
  // 基准只能来自别的 run：把自己算进来，rerun 时就会从「本 run 自己」取（还没写出来的）产物。
  expect(restoreStep.env.SELF_RUN).toContain("github.run_id");
  expect(restoreStep.run).toContain("select(.databaseId != ");
  expect(restoreStep.run).toContain("base=");
  // 基准缺失的两种情形必须分开：none = 首次汇入（不许要求基准），unknown = 该有却没取到（要求基准 → INFRA）。
  expect(restoreStep.run).toContain("BASE=none");
  expect(restoreStep.run).toContain("BASE=unknown");
  // 基准本该存在时脚本必须记 INFRA 而不是按空清单去重。
  expect(exportStep.env.BASE).toContain("steps.restore.outputs.base");
  expect(exportStep.run).toContain("--require-existing");
  expect(exportStep.run).toContain("${BASE:-none}");
  expect(byName("upload manifest").with.name).toBe("kb-manifest");
  expect(byName("upload infra").with.name).toBe("kb-infra");
});

// ---- workflow 沙箱：只跑具名 run 步骤，if 用 Actions 语义求值 ----

function workflowDoc() {
  return YAML.parse(readFileSync(WORKFLOW, "utf8"));
}

function interpolate(text, ctx) {
  return String(text).replace(/\$\{\{\s*(.+?)\s*\}\}/g, (whole, expr) => {
    if (Object.prototype.hasOwnProperty.call(ctx, expr)) return ctx[expr];
    throw new Error("测试未覆盖的表达式: " + whole);
  });
}

function evalIf(expr, outputs) {
  return expr
    .split("&&")
    .map((atom) => atom.trim())
    .every((atom) => {
      const m =
        /^steps\.([\w-]+)\.outputs\.([\w-]+)\s*(==|!=)\s*'([^']*)'$/.exec(atom);
      if (!m) throw new Error("if 超出本测试支持范围: " + atom);
      const got = outputs[m[1]] && outputs[m[1]][m[2]];
      const actual = got ? got : "";
      return m[3] === "==" ? actual === m[4] : actual !== m[4];
    });
}

function runWorkflow(
  dir,
  { repository = REPO, before, after, refName = "main" },
) {
  // 沙箱里要真有被调用的东西：YAML 写的是仓库相对路径 ./.cache/bin/engine，
  // 所以把构建好的引擎按同一相对路径复制进去 —— 缺了就该红在 127，不是静默跳过。
  engineInto(dir);
  const ctx = {
    "github.repository": repository,
    "github.ref_name": refName,
    "github.event.before": before,
    "github.event.after": after,
    "secrets.GITHUB_TOKEN": "stub-token",
    // restore 步骤在沙箱里被跳过（要联网拉上一轮产物），所以基准就是「首次汇入」。
    "steps.restore.outputs.base": "none",
  };
  const ghOutput = join(dir, "gh_output");
  writeFileSync(ghOutput, "");
  const outputs = {};
  const ran = [];

  for (const step of workflowDoc().jobs.export.steps) {
    // restore 要联网拉上一轮的产物，不属于被测 wiring；其余具名 run 步骤照 YAML 原样执行。
    if (step.name === "restore previous artifacts") continue;
    // 只跑具名步骤：checkout / setup-node / npm install 不属于被测 wiring，
    // 而且 npm install 会把沙箱里的 node_modules 换掉。
    if (!step.run || !step.name) continue;
    const key = step.name;
    if (step.if && !evalIf(interpolate(step.if, ctx), outputs)) {
      ran.push({ key, skipped: true });
      continue;
    }
    const env = {
      PATH: process.env.PATH,
      HOME: process.env.HOME || "",
      GITHUB_OUTPUT: ghOutput,
    };
    for (const [k, v] of Object.entries(step.env || {}))
      env[k] = interpolate(v, ctx);
    const beforeBytes = readFileSync(ghOutput, "utf8");
    const r = spawnSync(
      "bash",
      ["-eo", "pipefail", "-c", interpolate(step.run, ctx)],
      { cwd: dir, env, encoding: "utf8" },
    );
    const added = readFileSync(ghOutput, "utf8").slice(beforeBytes.length);
    const id = step.id || key;
    outputs[id] = Object.fromEntries(
      added
        .split("\n")
        .filter(Boolean)
        .map((line) => [
          line.slice(0, line.indexOf("=")),
          line.slice(line.indexOf("=") + 1),
        ]),
    );
    ran.push({ key, status: r.status, stdout: r.stdout, stderr: r.stderr });
  }

  const infraPath = join(dir, ".kb-out/kb-infra.yml");
  const exists = (() => {
    try {
      return readFileSync(infraPath, "utf8");
    } catch {
      return null;
    }
  })();
  return {
    outputs,
    ran,
    evalIf: (expr) => evalIf(expr, outputs),
    ok: (key) => ran.find((s) => s.key === key),
    failed: ran.filter((s) => s.skipped !== true && s.status !== 0),
    infra: exists ? YAML.parse(exists) : null,
  };
}
