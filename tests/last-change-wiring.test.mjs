import { test, expect } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import YAML from "yaml";
import { engineInto } from "./helpers/engine.mjs";

// 接线判据的对象是 .github/workflows/last-change.yml，不是任何 scripts/ 里的实现：
// 这个文件把 YAML 的 run 块与 if 条件原样搬进沙箱执行，断言只落在「YAML 真的调了谁、
// 用谁的结果、什么时候跳过」上。所以它刻意不 import 任何 scripts/*.mjs ——
// 门牌的正文一律由 Go 引擎（.cache/bin/engine）现算，期望值用下面的冻结模板。

const ROOT = process.cwd();
const WORKFLOW = ".github/workflows/last-change.yml";

function tempRepo() {
  const dir = mkdtempSync(join(tmpdir(), "last-change-wiring-"));
  execFileSync("git", ["init", "-q", "."], { cwd: dir });
  execFileSync("git", ["config", "user.email", "t@example.com"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "t"], { cwd: dir });
  return dir;
}

// files: 路径 → 内容；内容为 null 表示删掉。返回这一笔的 sha。
function commit(dir, files, message) {
  for (const [path, text] of Object.entries(files)) {
    const full = join(dir, path);
    if (text === null) execFileSync("git", ["rm", "-q", path], { cwd: dir });
    else {
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, text);
    }
  }
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync("git", ["commit", "-q", "--allow-empty", "-m", message], {
    cwd: dir,
  });
  return execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: dir,
    encoding: "utf8",
  }).trim();
}

// 一个 PR 的区间：base 是分叉点，head 是这个 PR 的改动。
function range(dir, patch) {
  const base = commit(dir, { "src/a.mjs": "a\n" }, "base");
  const head = commit(dir, patch, "pr");
  return { base, head };
}

function prEvent({
  number = 9,
  title = "feat: 门牌幂等重算",
  body = "Fixes #4",
  login = "ted",
  reviewers = [],
  merged = false,
  mergedBy,
  mergedAt,
} = {}) {
  return {
    action: merged ? "closed" : "opened",
    pull_request: {
      number,
      title,
      body,
      merged,
      user: { login },
      requested_reviewers: reviewers.map((name) => ({ login: name })),
      ...(mergedBy ? { merged_by: { login: mergedBy } } : {}),
      ...(mergedAt ? { merged_at: mergedAt } : {}),
    },
  };
}

// PR 模板本来的样子：LAST-CHANGE 节里是空表（冻结字面量，不现算）。
const TEMPLATE_BODY = [
  "## 关联",
  "",
  "- 关联 issue：Fixes #4",
  "",
  "## LAST-CHANGE",
  "",
  "<!-- 由 CI 填写，请勿手改 -->",
  "",
  "| 项       | 值  |",
  "| -------- | --- |",
  "| 提议人   |     |",
  "| 审核人   |     |",
  "| issue    |     |",
  "| PR       |     |",
  "| 标题     |     |",
  "| 修复文件 |     |",
  "| 合并人   |     |",
  "| 合并日期 |     |",
  "",
].join("\n");

// ---- wiring：把 YAML 的 run 块与 if 条件原样搬到沙箱里跑 ----

const steps = () =>
  YAML.parse(readFileSync(join(ROOT, WORKFLOW), "utf8")).jobs.render.steps;

// 只实现本 workflow 用到的 if 子集：steps.<id>.outputs.<key> == / != '值'，用 && 连接。
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

function interpolate(text, ctx) {
  return String(text).replace(/\$\{\{\s*(.+?)\s*\}\}/g, (whole, expr) => {
    if (Object.prototype.hasOwnProperty.call(ctx, expr)) return ctx[expr];
    throw new Error("测试未覆盖的表达式: " + whole);
  });
}

// 先用引擎算出一份正文：CI 第二次运行时拿到的 body 就是这个。
function runClone({ dir, base, head, event = prEvent() }) {
  engineInto(dir);
  writeFileSync(join(dir, "seed.in.md"), TEMPLATE_BODY);
  const r = spawnSync(
    join(dir, ".cache", "bin", "engine"),
    ["last-change", "--in", "seed.in.md", "--out", "seed.out.md"],
    {
      cwd: dir,
      encoding: "utf8",
      env: {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "",
        EVENT: JSON.stringify(event),
        EVENT_NAME: "pull_request",
        BASE: base,
        HEAD: head,
      },
    },
  );
  if (r.status !== 0) throw new Error("种子正文生成失败: " + r.stderr);
  return readFileSync(join(dir, "seed.out.md"), "utf8");
}

function runWorkflow({ dir, event, body, base, head }) {
  mkdirSync(join(dir, "bin"), { recursive: true });
  // 门牌的调用点是 Go 引擎：二进制跟着进沙箱，YAML 里那条 cwd 相对的
  // ./.cache/bin/engine 才能原样执行。沙箱里没有 scripts/，也不需要。
  engineInto(dir);
  const log = join(dir, "gh.log");
  writeFileSync(log, "");
  const gh = join(dir, "bin", "gh");
  writeFileSync(
    gh,
    "#!/bin/sh\n" +
      "printf '%s\\n' \"$*\" >> '" +
      log +
      "'\n" +
      'if [ "$1" = "pr" ] && [ "$2" = "view" ]; then printf \'%s\\n\' "$GH_BODY"; fi\n' +
      "exit 0\n",
  );
  chmodSync(gh, 0o755);

  const ghOutput = join(dir, "gh_output");
  writeFileSync(ghOutput, "");
  const env = {
    PATH: join(dir, "bin") + ":" + (process.env.PATH ?? ""),
    HOME: process.env.HOME ?? "",
    GH_BODY: body,
    GH_TOKEN: "stub-token",
    GITHUB_OUTPUT: ghOutput,
  };
  const pr = event.pull_request;
  const ctx = {
    "toJSON(github.event)": JSON.stringify(event),
    "github.event_name": "pull_request",
    "github.event.pull_request.number": String(pr.number),
    "github.event.pull_request.base.sha": base,
    "github.event.pull_request.head.sha": head,
    "github.event.pull_request.merged && github.event.pull_request.merge_commit_sha || github.event.pull_request.head.sha":
      pr.merged && pr.merge_commit_sha ? pr.merge_commit_sha : head,
    "secrets.GITHUB_TOKEN": "stub-token",
  };

  const outputs = {};
  const ran = [];
  for (const step of steps()) {
    // 只跑具名步骤：checkout / setup-node / npm install 不属于被测 wiring。
    if (!step.run || !step.name) continue;
    const key = step.id || String(step.name);
    if (step.if && !evalIf(interpolate(step.if, ctx), outputs)) {
      ran.push({ key, skipped: true });
      continue;
    }
    const stepEnv = { ...env };
    for (const [k, v] of Object.entries(step.env || {}))
      stepEnv[k] = interpolate(v, ctx);
    const before = readFileSync(ghOutput, "utf8");
    const r = spawnSync("bash", ["-c", interpolate(step.run, ctx)], {
      cwd: dir,
      env: stepEnv,
      encoding: "utf8",
    });
    const added = readFileSync(ghOutput, "utf8").slice(before.length);
    outputs[key] = Object.fromEntries(
      added
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const at = line.indexOf("=");
          return [line.slice(0, at), line.slice(at + 1)];
        }),
    );
    ran.push({ key, status: r.status, stdout: r.stdout, stderr: r.stderr });
  }

  const calls = readFileSync(log, "utf8").trim().split("\n").filter(Boolean);
  return {
    outputs,
    ran,
    ok: (key) => ran.find((s) => s.key === key),
    calls,
    failed: ran.filter((s) => s.skipped !== true && s.status !== 0),
    body: existsSync(join(dir, "body.out.md"))
      ? readFileSync(join(dir, "body.out.md"), "utf8")
      : null,
    edited: calls.filter((c) => c.startsWith("pr edit")),
  };
}

test("(f) workflow 真的调用引擎：render 产出表，write 用它的结果改 PR 正文", () => {
  const dir = tempRepo();
  const { base, head } = range(dir, { "src/a.mjs": "a\nb\n" });
  writeFileSync(join(dir, "body.in.md"), TEMPLATE_BODY);

  const r = runWorkflow({
    dir,
    event: prEvent(),
    body: TEMPLATE_BODY,
    base,
    head,
  });
  expect(r.ok("render").status).toBe(0);
  expect(r.outputs.render.changed).toBe("1");
  expect(r.calls[0]).toBe("pr view 9 --json body --jq .body");
  expect(r.edited).toEqual(["pr edit 9 --body-file body.out.md"]);
  expect(r.body).toMatch(/^\| 项\s+\| 值\s+\|$/m);
  expect(r.body).toMatch(/^\| PR\s+\| #9\s+\|$/m);
  expect(r.failed).toEqual([]);
});

test("(f) body 已经是对的就不再写：changed=0，write 被跳过（幂等的可见后果）", () => {
  const dir = tempRepo();
  const { base, head } = range(dir, { "src/a.mjs": "a\nb\n" });
  const computed = runClone({ base, head, dir });
  const r = runWorkflow({ dir, event: prEvent(), body: computed, base, head });
  expect(r.outputs.render.changed).toBe("0");
  expect(r.ok("write").skipped).toBe(true);
  expect(r.edited).toEqual([]);
  expect(r.failed).toEqual([]);
});

test("(f) 合并事件缺 merged_at：render 红、write 被跳过，PR 正文一个字都没变", () => {
  const dir = tempRepo();
  const { base, head } = range(dir, { "src/a.mjs": "a\nb\n" });
  const before = runClone({ base, head, dir });
  const r = runWorkflow({
    dir,
    event: prEvent({ merged: true, mergedBy: "boss" }),
    body: before,
    base,
    head,
  });
  expect(r.ok("render").status).toBe(1);
  expect(r.outputs.render.changed).toBeUndefined();
  expect(r.ok("write").skipped).toBe(true);
  expect(r.edited).toEqual([]);
  expect(r.failed.map((s) => s.key)).toEqual(["render"]);
});
