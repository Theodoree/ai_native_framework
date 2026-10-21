import { test, expect } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import YAML from "yaml";

// 门牌的判据是幂等：同一份输入重算两次必须逐字相同，否则它不是派生物。
// 下面每条都用真 git 区间 + 真 PR 事件跑脚本，只有 workflow 那条把 YAML 里的
// run 块与 if 条件原样搬进沙箱执行（wiring 断言钉在 YAML 上，不在测试里重写流程）。

const ROOT = process.cwd();
const SCRIPT = join(ROOT, "scripts", "last-change.mjs");
const WORKFLOW = ".github/workflows/last-change.yml";

function tempRepo() {
  const dir = mkdtempSync(join(tmpdir(), "last-change-"));
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

const prEvent = ({
  number = 9,
  title = "feat: 门牌幂等重算",
  body = "Fixes #4",
  login = "ted",
  reviewers = [],
  merged = false,
  mergedBy,
  mergedAt,
} = {}) => ({
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
});

function runCli({
  dir,
  event,
  eventName = "pull_request",
  base,
  head,
  args = [],
}) {
  const r = spawnSync("node", [SCRIPT, ...args], {
    cwd: dir,
    encoding: "utf8",
    env: {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      EVENT: JSON.stringify(event),
      EVENT_NAME: eventName,
      BASE: base ?? "",
      HEAD: head ?? "",
    },
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

// PR 模板本来的样子：LAST-CHANGE 节里是空表。
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

const bodyOf = (dir, name = "body.out.md") =>
  readFileSync(join(dir, name), "utf8");

test("(a) 同一输入重算两次：输出逐字相同，diff 为空", () => {
  const dir = tempRepo();
  const { base, head } = range(dir, {
    "src/a.mjs": "a\nb\n",
    "src/c.mjs": "c\n",
  });
  writeFileSync(join(dir, "body.in.md"), TEMPLATE_BODY);

  const first = runCli({
    dir,
    event: prEvent({ reviewers: ["alice"] }),
    base,
    head,
    args: ["--in", "body.in.md", "--out", "body.1.md"],
  });
  expect(first.status).toBe(0);

  const second = runCli({
    dir,
    event: prEvent({ reviewers: ["alice"] }),
    base,
    head,
    args: ["--in", "body.1.md", "--out", "body.2.md"],
  });
  expect(second.status).toBe(0);

  const a = readFileSync(join(dir, "body.1.md"));
  const b = readFileSync(join(dir, "body.2.md"));
  expect(a.equals(b)).toBe(true);
  const diff = spawnSync("diff", ["body.1.md", "body.2.md"], {
    cwd: dir,
    encoding: "utf8",
  });
  expect(diff.status).toBe(0);
  expect(diff.stdout).toBe("");
});

test("(b) 表里含本 PR 编号、提议人、issue、标题、本次变更涉及的文件", () => {
  const dir = tempRepo();
  const { base, head } = range(dir, {
    "src/a.mjs": "a\nb\n",
    "src/c.mjs": "c\n",
  });
  writeFileSync(join(dir, "body.in.md"), TEMPLATE_BODY);

  const r = runCli({
    dir,
    event: prEvent({
      number: 9,
      title: "feat: 门牌幂等重算",
      reviewers: ["alice"],
    }),
    base,
    head,
    args: ["--in", "body.in.md", "--out", "body.out.md"],
  });
  expect(r.status).toBe(0);
  const body = bodyOf(dir);

  expect(body).toMatch(/^\| PR\s+\| #9\s+\|$/m);
  expect(body).toMatch(/^\| 提议人\s+\| ted\s+\|$/m);
  expect(body).toMatch(/^\| 审核人\s+\| alice\s+\|$/m);
  expect(body).toMatch(/^\| issue\s+\| #4\s+\|$/m);
  expect(body).toMatch(/^\| 标题\s+\| feat: 门牌幂等重算\s+\|$/m);
  expect(body).toContain("`src/a.mjs`");
  expect(body).toContain("`src/c.mjs`");
  // 区间只算这个 PR 自己的改动：base 里的 src/b.mjs 不该出现。
  expect(body).not.toContain("src/b.mjs");
  // 标记只有一份，模板里的空表被整节替换掉。
  expect(body.match(/LAST-CHANGE:BEGIN/g)).toHaveLength(1);
  expect(body).not.toContain("| 修复文件 |");
});

test("(c) 合并后补写合并人与合并日期，已有字段原样保留", () => {
  const dir = tempRepo();
  const { base, head } = range(dir, { "src/a.mjs": "a\nb\n" });
  writeFileSync(join(dir, "body.in.md"), TEMPLATE_BODY);

  const opened = runCli({
    dir,
    event: prEvent(),
    base,
    head,
    args: ["--in", "body.in.md", "--out", "body.out.md"],
  });
  expect(opened.status).toBe(0);

  const merged = runCli({
    dir,
    event: prEvent({
      merged: true,
      mergedBy: "boss",
      mergedAt: "2024-05-06T12:34:56Z",
    }),
    base,
    head,
    args: ["--in", "body.out.md", "--out", "body.out.md"],
  });
  expect(merged.status).toBe(0);
  const body = bodyOf(dir);
  expect(body).toMatch(/^\| 合并人\s+\| boss\s+\|$/m);
  expect(body).toMatch(/^\| 合并日期\s+\| 2024-05-06\s+\|$/m);
  // 补写不是重来：合并前已有的四个字段一个不少。
  expect(body).toMatch(/^\| PR\s+\| #9\s+\|$/m);
  expect(body).toMatch(/^\| 提议人\s+\| ted\s+\|$/m);
  expect(body).toMatch(/^\| issue\s+\| #4\s+\|$/m);
  expect(body).toContain("`src/a.mjs`");
});

test("(c) 补写失败不影响已有字段：合并事件缺 merged_at 时文件一个字节都不动", () => {
  const dir = tempRepo();
  const { base, head } = range(dir, { "src/a.mjs": "a\nb\n" });
  writeFileSync(join(dir, "body.in.md"), TEMPLATE_BODY);
  runCli({
    dir,
    event: prEvent(),
    base,
    head,
    args: ["--in", "body.in.md", "--out", "body.out.md"],
  });
  const before = readFileSync(join(dir, "body.out.md"));

  const r = runCli({
    dir,
    // merged=true 但宿主没给 merged_at：只补一半的合并信息会让门牌自相矛盾。
    event: prEvent({ merged: true, mergedBy: "boss" }),
    base,
    head,
    args: ["--in", "body.out.md", "--out", "body.out.md"],
  });
  expect(r.status).toBe(1);
  expect(r.stderr).toContain("合并");
  expect(r.stdout).toBe("");
  const after = readFileSync(join(dir, "body.out.md"));
  expect(after.equals(before)).toBe(true);
});

test("(d) 两个 PR 先后改同一模块：后合并者的结果胜出，不需要人工合并", () => {
  const dir = tempRepo();
  const first = range(dir, { "src/a.mjs": "a\n1\n" });
  writeFileSync(join(dir, "body.in.md"), TEMPLATE_BODY);

  // PR #9 合并：门牌写进 PR 正文。
  const one = runCli({
    dir,
    event: prEvent({
      number: 9,
      title: "feat: 第一次",
      merged: true,
      mergedBy: "boss",
      mergedAt: "2024-05-06T00:00:00Z",
    }),
    base: first.base,
    head: first.head,
    args: ["--in", "body.in.md", "--out", "body.out.md"],
  });
  expect(one.status).toBe(0);

  // PR #10 后合并，改的是同一模块（src/a.mjs 又被改了）。
  const second = range(dir, { "src/a.mjs": "a\n1\n2\n" });
  const two = runCli({
    dir,
    event: prEvent({
      number: 10,
      title: "feat: 第二次",
      merged: true,
      mergedBy: "boss",
      mergedAt: "2024-05-07T00:00:00Z",
    }),
    base: second.base,
    head: second.head,
    args: ["--in", "body.out.md", "--out", "body.out.md"],
  });
  expect(two.status).toBe(0);

  const body = bodyOf(dir);
  expect(body).toMatch(/^\| PR\s+\| #10\s+\|$/m);
  expect(body).not.toContain("#9");
  expect(body).toMatch(/^\| 合并日期\s+\| 2024-05-07\s+\|$/m);
  expect(body.match(/LAST-CHANGE:BEGIN/g)).toHaveLength(1);
});

test("(d) 节内残留冲突标记时也被一次重算覆盖：不人工合并", () => {
  const dir = tempRepo();
  const { base, head } = range(dir, { "src/a.mjs": "a\nb\n" });
  const conflicted = [
    "## LAST-CHANGE",
    "",
    "<<<<<<< HEAD",
    "| PR | #9 |",
    "=======",
    "| PR | #10 |",
    ">>>>>>> feature/x",
    "",
    "## 其他",
    "",
    "正文保留",
    "",
  ].join("\n");
  writeFileSync(join(dir, "body.in.md"), conflicted);

  const r = runCli({
    dir,
    event: prEvent({ number: 11 }),
    base,
    head,
    args: ["--in", "body.in.md", "--out", "body.out.md"],
  });
  expect(r.status).toBe(0);
  const body = bodyOf(dir);
  expect(body).not.toContain("<<<<<<<");
  expect(body).not.toContain("=======");
  expect(body).not.toContain(">>>>>>>");
  expect(body).toMatch(/^\| PR\s+\| #11\s+\|$/m);
  // 节后面的内容不是门牌的一部分，原样留下。
  expect(body).toContain("## 其他");
  expect(body).toContain("正文保留");
});

test("(e) 重算是覆盖写：跑三次也只有一张表、一行 PR，不追加不重复", () => {
  const dir = tempRepo();
  const { base, head } = range(dir, { "src/a.mjs": "a\nb\n" });
  writeFileSync(join(dir, "body.in.md"), TEMPLATE_BODY);

  let input = "body.in.md";
  for (const out of ["b1.md", "b2.md", "b3.md"]) {
    const r = runCli({
      dir,
      event: prEvent(),
      base,
      head,
      args: ["--in", input, "--out", out],
    });
    expect(r.status).toBe(0);
    input = out;
  }
  const body = readFileSync(join(dir, "b3.md"), "utf8");
  expect(body.match(/LAST-CHANGE:BEGIN/g)).toHaveLength(1);
  expect(body.match(/LAST-CHANGE:END/g)).toHaveLength(1);
  expect(body.match(/^\| PR\s+\|/gm)).toHaveLength(1);
  expect(body.match(/^## LAST-CHANGE$/gm)).toHaveLength(1);
  expect(readFileSync(join(dir, "b1.md"), "utf8")).toBe(body);
});

test("算不出来就报错：区间为空、没引用 issue、事件不是 PR，都退出 1 且不输出表", () => {
  const dir = tempRepo();
  const same = commit(dir, { "src/a.mjs": "a\n" }, "base");
  const r1 = runCli({ dir, event: prEvent(), base: same, head: same });
  expect(r1.status).toBe(1);
  expect(r1.stdout).toBe("");
  expect(r1.stderr).toContain("没有文件变更");

  const { base, head } = range(dir, { "src/a.mjs": "a\nb\n" });
  const r2 = runCli({
    dir,
    event: prEvent({ body: "随手改点东西", title: "chore: nits" }),
    base,
    head,
  });
  expect(r2.status).toBe(1);
  expect(r2.stderr).toContain("恰好一个 issue");

  const r3 = runCli({ dir, eventName: "issues", event: {}, base, head });
  expect(r3.status).toBe(1);
  expect(r3.stderr).toContain("pull_request");
});

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

// 先用脚本算出一份正文：CI 第二次运行时拿到的 body 就是这个。
function runClone({ dir, base, head, event = prEvent() }) {
  writeFileSync(join(dir, "seed.in.md"), TEMPLATE_BODY);
  const r = runCli({
    dir,
    event,
    base,
    head,
    args: ["--in", "seed.in.md", "--out", "seed.out.md"],
  });
  if (r.status !== 0) throw new Error("种子正文生成失败: " + r.stderr);
  return readFileSync(join(dir, "seed.out.md"), "utf8");
}

function runWorkflow({ dir, event, body, base, head }) {
  // 沙箱里要有脚本和依赖：脚本 import 了 yaml，node_modules 用软链（复制太慢，且入口判断靠 realpath）。
  cpSync(join(ROOT, "scripts"), join(dir, "scripts"), { recursive: true });
  if (!existsSync(join(dir, "node_modules")))
    symlinkSync(join(ROOT, "node_modules"), join(dir, "node_modules"));
  mkdirSync(join(dir, "bin"), { recursive: true });
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

test("(f) workflow 真的调用脚本：render 产出表，write 用它的结果改 PR 正文", () => {
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
