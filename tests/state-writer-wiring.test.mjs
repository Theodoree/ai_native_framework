import { test, expect } from "vitest";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";

// 专测 wiring：把 state-writer.yml 里的 run 块与 if 条件原样搬到沙箱里执行，
// 让「有没有意图 → 跑哪几步 → 评不评论 / 改不改标签 / 红不红 job」由 YAML 与脚本自己决定，
// 而不是由测试重写一遍流程。(a)(b)(c)(d) 是实跑，(e) 用「被跳过的步骤」证明。

const ROOT = process.cwd();
const WORKFLOW = ".github/workflows/state-writer.yml";

const steps = () =>
  YAML.parse(readFileSync(join(ROOT, WORKFLOW), "utf8")).jobs.write.steps;

// 只实现本 workflow 用到的 if 子集：steps.<id>.outputs.<key> 与 '值' 比 == / !=，用 && 连接。
// 被跳过的步骤没有输出，按 Actions 语义取空字符串。
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

// [object Object] 只做「事件上下文 → 常量」的替换，认不出的表达式直接报错，不静默放过。
function interpolate(text, ctx) {
  return String(text).replace(/\$\{\{\s*(.+?)\s*\}\}/g, (whole, expr) => {
    if (Object.prototype.hasOwnProperty.call(ctx, expr)) return ctx[expr];
    throw new Error("测试未覆盖的表达式: " + whole);
  });
}

function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), "state-writer-"));
  // 复制脚本与配置：node 把入口解析成 realpath，软链会让脚本里 import.meta 的入口判断失效。
  cpSync(join(ROOT, "scripts"), join(dir, "scripts"), { recursive: true });
  cpSync(join(ROOT, ".agents"), join(dir, ".agents"), { recursive: true });
  symlinkSync(join(ROOT, "node_modules"), join(dir, "node_modules"));
  mkdirSync(join(dir, "bin"));
  const log = join(dir, "calls.log");
  const gh = join(dir, "bin", "gh");
  // 假 gh：调用记进 calls.log；api 调用回显 GH_LAST_COMMENT，模拟「上一条评论」。
  writeFileSync(
    gh,
    "#!/bin/sh\n" +
      'printf \'%s\\n\' "$*" >> "' +
      log +
      '"\n' +
      'if [ "$1" = "api" ]; then printf ' +
      "'%s\\n'" +
      ' "$GH_LAST_COMMENT"; fi\n' +
      "exit 0\n",
  );
  chmodSync(gh, 0o755);
  return { dir, log };
}

function runWorkflow({ eventName, event, number, lastComment = "" }) {
  const { dir, log } = sandbox();
  const ghOutput = join(dir, "gh_output");
  writeFileSync(ghOutput, "");
  const env = {
    PATH: join(dir, "bin") + ":" + (process.env.PATH || ""),
    HOME: process.env.HOME || "",
    GH_LOG: log,
    GH_LAST_COMMENT: lastComment,
    GH_TOKEN: "stub-token",
    GITHUB_OUTPUT: ghOutput,
  };
  const ctx = {
    "toJSON(github.event)": JSON.stringify(event),
    "github.event_name": eventName,
    "github.event.issue.number || github.event.pull_request.number":
      String(number),
    "github.repository": "owner/repo",
    "secrets.GITHUB_TOKEN": "stub-token",
  };

  const outputs = {};
  const ran = [];
  for (const step of steps()) {
    // 只跑具名步骤：checkout / setup-node / npm install 不属于被测 wiring，
    // 而且 npm install 会替换掉沙箱里的 node_modules。
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

  let calls = [];
  try {
    calls = readFileSync(log, "utf8").trim().split("\n").filter(Boolean);
  } catch {
    calls = [];
  }
  const intentPath = join(dir, "intent.json");
  return {
    outputs,
    ran,
    ok: (key) => ran.find((s) => s.key === key),
    calls,
    comments: calls.filter((c) => c.startsWith("issue comment")),
    edits: calls.filter((c) => c.startsWith("issue edit")),
    // job 红 = 任何一步非 0 退出（被跳过的步骤不参与）。
    failed: ran.filter((s) => s.skipped !== true && s.status !== 0),
    intentBytes: existsSync(intentPath) ? statSync(intentPath).size : null,
    verdictExists: existsSync(join(dir, "verdict.json")),
  };
}

const issueEvent = (
  action,
  { labels = [], label, number = 7, association = "OWNER" } = {},
) => ({
  action,
  issue: {
    number,
    labels: labels.map((name) => ({ name })),
    author_association: association,
  },
  ...(label ? { label: { name: label } } : {}),
  sender: { login: "ted" },
});

const prEvent = (action, { number = 9, body = "", title = "" } = {}) => ({
  action,
  pull_request: {
    number,
    merged: false,
    labels: [],
    body,
    title,
    author_association: "CONTRIBUTOR",
  },
  sender: { login: "agent" },
});

test("(a) 无意图（issues.closed）：不评论、不改标签、job 不红，日志留一行说明", () => {
  const r = runWorkflow({
    eventName: "issues",
    event: issueEvent("closed", { labels: ["state:accepted"] }),
    number: 7,
  });
  const build = r.ok("intent");
  expect(build.status).toBe(0);
  expect(r.intentBytes).toBe(0);
  expect(build.stderr).toContain("no-state-change issues.closed");
  expect(build.stderr).toContain("跳过判定与留痕");
  expect(r.outputs.intent.has_intent).toBe("0");
  expect(r.ok("validate").skipped).toBe(true);
  expect(r.ok("apply").skipped).toBe(true);
  expect(r.ok("record").skipped).toBe(true);
  expect(r.comments).toEqual([]);
  expect(r.edits).toEqual([]);
  expect(r.failed).toEqual([]);
});

test("(e) 空 intent 文件进不了 record：validate 被跳过，verdict.json 根本没生成", () => {
  const r = runWorkflow({
    eventName: "issues",
    event: issueEvent("closed", { labels: ["state:accepted"] }),
    number: 7,
  });
  expect(r.outputs.validate).toBeUndefined();
  expect(r.verdictExists).toBe(false);
  // 漏洞的形状：只看 exit != '0' 时，被跳过的 validate 会让 gate 成立（空文件曾被送进 record）。
  expect(evalIf("steps.validate.outputs.exit != '0'", r.outputs)).toBe(true);
  // has_intent 把这个洞堵住。
  expect(
    evalIf(
      "steps.intent.outputs.has_intent == '1' && steps.validate.outputs.exit != '0'",
      r.outputs,
    ),
  ).toBe(false);
  expect(r.comments).toEqual([]);
  expect(r.failed).toEqual([]);
});

test("(b) 有意图且合法（analyzing → accepted）：apply 用 intent 的 issue 改标签", () => {
  const r = runWorkflow({
    eventName: "issues",
    event: issueEvent("labeled", {
      labels: ["state:analyzing"],
      label: "state:accepted",
    }),
    number: 7,
    lastComment: "同意受理",
  });
  expect(r.outputs.intent.has_intent).toBe("1");
  expect(r.outputs.validate.exit).toBe("0");
  expect(r.ok("record").skipped).toBe(true);
  expect(r.edits).toEqual([
    "issue edit 7 --remove-label state:analyzing",
    "issue edit 7 --add-label state:accepted",
  ]);
  expect(r.comments).toEqual([]);
  expect(r.failed).toEqual([]);
});

test("(c) 有意图但非法（analyzing → done）：record 贴 rejected 评论，job 绿", () => {
  const r = runWorkflow({
    eventName: "issues",
    event: issueEvent("labeled", {
      labels: ["state:analyzing"],
      label: "state:done",
    }),
    number: 7,
    lastComment: "直接完成",
  });
  expect(r.outputs.validate.exit).toBe("1");
  expect(r.ok("apply").skipped).toBe(true);
  expect(r.comments).toHaveLength(1);
  expect(r.comments[0]).toContain(
    "issue comment 7 --body 状态未被修改：REJECTED E_NO_TRANSITION",
  );
  expect(r.ok("record").status).toBe(0);
  expect(r.edits).toEqual([]);
  expect(r.failed).toEqual([]);
});

test("(d) 有意图但 INFRA（PR 无引用 issue）：record 贴 INFRA 评论，job 红", () => {
  const r = runWorkflow({
    eventName: "pull_request",
    event: prEvent("opened", { body: "随手改点东西", title: "chore: nits" }),
    number: 9,
  });
  expect(r.outputs.intent.has_intent).toBe("1");
  expect(r.outputs.validate.exit).toBe("3");
  expect(r.ok("apply").skipped).toBe(true);
  expect(r.comments).toHaveLength(1);
  expect(r.comments[0]).toContain(
    "issue comment 9 --body 状态未被修改：INFRA E_ISSUE_UNRESOLVED",
  );
  expect(r.ok("record").status).toBe(1);
  expect(r.failed.map((s) => s.key)).toEqual(["record"]);
});
