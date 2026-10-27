import { execFileSync, spawnSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test, expect } from "vitest";
import YAML from "yaml";
import { engineInto } from "./helpers/engine.mjs";

// 接线判据：钉在 .github/workflows/merge-gate.yml 上，并把 gate 步骤的 run 块原样执行。
// 四守卫的**行为**判据已经搬进 apps/engine/mergegate_cli_test.go（每条能独立打红）；
// 这里只留「流程真的接上了」这一类：判据钉在 YAML 上，脚本形状不参与判定。
// 与 tests/last-change-wiring.test.mjs 同构：不 import scripts/ 里的任何模块。

const ROOT = process.cwd();
// 只为一处形状判据读源码：门的生产者常量与 last-change 的 job 键必须一致。
// 生产者的家已随 P-31 搬进编译产物（引擎常量 MergeGateProducer），这里钉的是 Go 侧声明：
// Node 载体删掉之后，这条判据必须照旧能把「改名」打成红。
const ENGINE_SOURCE = join(ROOT, "apps", "engine", "mergegate.go");
const WORKFLOW = ".github/workflows/merge-gate.yml";
const CONFIG = ".agents/platform/state-machine.yml";
const PRODUCER = "render";

// 门牌表格的固定文本：原用例现场调用 scripts/last-change.mjs 渲染，这里改成固定夹具 ——
// 接线判据只要求「格式合法、能过 G4 的门牌」，不该依赖一个必然要删的脚本。
const SECTION = [
  "## LAST-CHANGE",
  "",
  "<!-- 由 CI 重算，请勿手改 -->",
  "",
  "<!-- LAST-CHANGE:BEGIN -->",
  "| 项       | 值                       |",
  "| -------- | ------------------------ |",
  "| 提议人   | ted                      |",
  "| 审核人   | alice                    |",
  "| issue    | #12                      |",
  "| PR       | #34                      |",
  "| 标题     | feat: gate               |",
  "| 变更文件 | `src/a.mjs`, `docs/b.md` |",
  "| 合并人   | —                        |",
  "| 合并日期 | —                        |",
  "<!-- LAST-CHANGE:END -->",
].join("\n");

// 一次判定的沙箱：真 git 仓（G2 靠 git cat-file 取证）+ 一份真状态机声明
// + 一份构建好的引擎（YAML 步骤调的是 cwd 相对的 ./.cache/bin/engine）。
function gate() {
  const dir = mkdtempSync(join(tmpdir(), "merge-gate-"));
  execFileSync("git", ["init", "-q", "."], { cwd: dir });
  execFileSync("git", ["config", "user.email", "t@example.com"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "t"], { cwd: dir });
  mkdirSync(join(dir, dirname(CONFIG)), { recursive: true });
  cpSync(join(ROOT, CONFIG), join(dir, CONFIG));
  for (const [path, text] of Object.entries({
    "src/a.mjs": "a\n",
    "docs/b.md": "b\n",
  })) {
    mkdirSync(join(dir, dirname(path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync("git", ["commit", "-q", "-m", "base"], { cwd: dir });
  const head = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: dir,
    encoding: "utf8",
  }).trim();
  engineInto(dir);

  const prView = {
    number: 34,
    title: "feat: gate",
    body: "## 关联\n\n- Fixes #12\n\n" + SECTION,
    head: { sha: head },
  };
  const runs = ["check", "audit", PRODUCER, "merge-gate"].map((name, i) => ({
    id: 10 + i,
    name,
    status: "completed",
    conclusion: "success",
    head_sha: head,
  }));
  const inputs = {
    "event.json": { pull_request: prView },
    "pr.json": prView,
    "issue.json": { number: 12, labels: [{ name: "state:in-progress" }] },
    "checks.json": { total_count: runs.length, check_runs: runs },
    "infra.json": [],
  };
  mkdirSync(join(dir, ".gate"), { recursive: true });
  for (const [name, value] of Object.entries(inputs))
    writeFileSync(join(dir, ".gate", name), JSON.stringify(value));
  return { dir, head, runs };
}

const lastLine = (out) => out.trim().split("\n").at(-1) ?? "";

// ---- (d) wiring：断言钉在 YAML 上，并把 run 块原样执行 ----

const workflow = () => YAML.parse(readFileSync(join(ROOT, WORKFLOW), "utf8"));
const stepsOf = () => workflow().jobs["merge-gate"].steps;
const stepNamed = (name) => stepsOf().find((s) => s.name === name);

test("(d) workflow 真的调用脚本：job 名＝required check 名，取数步骤产出四份输入", () => {
  const wf = workflow();
  expect(Object.keys(wf.jobs)).toEqual(["merge-gate"]);
  const collect = stepNamed("collect inputs");
  for (const name of [
    "event.json",
    "pr.json",
    "issue.json",
    "checks.json",
    "infra.json",
  ])
    expect(collect.run).toContain(".gate/" + name);
  // 判据只在 Go 引擎里：这里钉的是那条 cwd 相对的命令，换回 node 脚本立刻红。
  expect(collect.run).toContain(
    "./.cache/bin/engine merge-gate --event .gate/event.json --pr .gate/pr.json --print-issue",
  );
  expect(stepNamed("gate").run).toBe(
    "./.cache/bin/engine merge-gate --event .gate/event.json --pr .gate/pr.json --issue .gate/issue.json --checks .gate/checks.json --infra .gate/infra.json",
  );
  // 取数要的权限与 PR head 检出：门牌文件靠 git cat-file 取证，check runs 靠 checks: read。
  expect(wf.permissions).toMatchObject({
    contents: "read",
    issues: "read",
    checks: "read",
  });
  expect(stepsOf()[0].with.ref).toBe(
    "${{ github.event.pull_request.head.sha }}",
  );
  // 门要跟着评论/审查变化重算，否则红绿会停在旧结论上。
  expect(JSON.stringify(wf.on)).toContain("pull_request_review");
});

test("(e) 等上游：触发点、排除自己、取数顺序都钉在 YAML 上", () => {
  const wf = workflow();
  const names = stepsOf().map((s) => s.name);
  const wait = stepNamed("wait for upstream to settle");
  // 等的是别人的最终结论：自己（SELF）必须排除，否则自己 in_progress 就死等。
  expect(wait.env.SELF).toBe("merge-gate");
  expect(wait.run).toContain("process.env.SELF");
  expect(wait.run).toContain("/check-runs");
  expect(wait.run).toContain('x.status !== "completed"');
  // 有上限，且超时只 warn 不判红：结论仍由门给（未就绪），不靠睡够碰运气。
  expect(Number(wait.env.DEADLINE_SECONDS)).toBeGreaterThan(0);
  expect(wait.run).toContain("::warning::");
  expect(wait.run).not.toMatch(/exit 1/);
  // 等待必须排在取数之前：取的是终态，不是起跑时的半截。
  expect(names.indexOf("wait for upstream to settle")).toBeLessThan(
    names.indexOf("collect inputs"),
  );
  // 正文取现况（pulls/N），不是事件里的快照 —— 否则等到天亮也读到旧正文。
  expect(stepNamed("collect inputs").run).toContain("/pulls/$NUMBER");
  // 生产者名只有一个家（引擎常量），这里钉住它与 last-change 的 job 键一致。
  // check_runs 里挂的是 job 名：门等上游时按这个名字排自己以外的结论，改名两侧都得同时改。
  expect(readFileSync(ENGINE_SOURCE, "utf8")).toContain('MergeGateProducer = "render"');
  const producer = YAML.parse(
    readFileSync(join(ROOT, ".github/workflows/last-change.yml"), "utf8"),
  );
  expect(Object.keys(producer.jobs)).toEqual(["render"]);
  // 人工编辑仍会重跑（自动写回不会：GITHUB_TOKEN 的改动不触发 workflow）。
  expect(wf.on.pull_request.types).toContain("edited");
});

test("(d) 把 YAML 的 gate 步骤原样跑起来：它真的连着四守卫", () => {
  const run = stepNamed("gate").run;
  expect(run).not.toMatch(/\$\{\{/); // 没有插值才能原样执行
  const g = gate();
  const exec = () =>
    spawnSync("bash", ["-c", run], {
      cwd: g.dir,
      encoding: "utf8",
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
    });
  const pass = exec();
  expect(pass.status).toBe(0);
  expect(lastLine(pass.stdout)).toBe("merge-gate PASS 4/4");
  // 同一段 YAML，只把 checks 输入改成一条 failure：步骤必须变红。
  writeFileSync(
    join(g.dir, ".gate", "checks.json"),
    JSON.stringify({
      total_count: 4,
      check_runs: [
        ...g.runs,
        {
          id: 99,
          name: "audit",
          status: "completed",
          conclusion: "failure",
          head_sha: g.head,
        },
      ],
    }),
  );
  const red = exec();
  expect(red.status).toBe(1);
  expect(red.stdout).toContain("FAIL E_CHECK_NOT_GREEN");
});
