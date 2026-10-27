import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// 阶段 D 对照：审计六件套（audit-collect / audit-review / audit-slot / audit-findings / routing）
// 同一批输入分别喂 scripts/*.mjs 与 .cache 里编出来的 engine，逐字节比
// stdout / stderr / 退出码 / 写出的文件 / 打到上游的请求体。
// gh 与上游都换成沙箱里的替身，谁真调谁就露馅。
// 仓库根与 engine 目录：
const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
// 变异验证时用 PARITY_ENGINE_DIR 指向 /tmp 里改过的引擎副本，仓库本身不动。
const engineDir = process.env.PARITY_ENGINE_DIR || join(repoRoot, "apps/engine");
const goEnv = {
  ...process.env,
  GOPATH: join(repoRoot, ".cache/go"),
  GOCACHE: join(repoRoot, ".cache/go-build"),
  GOFLAGS: "-mod=mod",
};

// ---- 共享夹具数据 ----
const record = (overrides) => ({
  verdict: "needs_revision",
  findings: [
    {
      path: "scripts/x.mjs",
      line: 12,
      severity: "high",
      criterion: "必须校验输入",
      suggestion: "加校验",
    },
  ],
  evidence: {
    executor: "github",
    agent: "review-a",
    model: "deepseek-chat",
    request_id: "req-1",
  },
  ...overrides,
});
const cleanRecord = (agent, executor, model, requestId) => ({
  verdict: "pass",
  findings: [],
  evidence: { executor, agent, model, request_id: requestId },
});
const A_CLEAN = cleanRecord("review-a", "github", "deepseek-chat", "req-1");
const B_CLEAN = cleanRecord("review-b", "sandbox", "deepseek-reasoner", "req-2");
const A_INFRA = {
  verdict: "INFRA",
  findings: [],
  evidence: { executor: "github", agent: "review-a" },
  reason: "没有 DEEPSEEK_API_KEY：判不了，不是通过",
};
const DIFF = [
  "diff --git a/scripts/x.mjs b/scripts/x.mjs",
  "--- a/scripts/x.mjs",
  "+++ b/scripts/x.mjs",
  "@@ -1 +1 @@",
  "-const old = 1;",
  "+const next = 2;",
  "",
].join("\n");
const ROUTING_OK = [
  "version: 1",
  "routes:",
  "  - name: review-a",
  "    provider: deepseek",
  "    model: deepseek-chat",
  "    purpose: A 侧",
  "  - name: review-b",
  "    provider: deepseek",
  "    model: deepseek-reasoner",
  "    purpose: B 侧",
  "",
].join("\n");
const ROUTING_BAD = "version: 1\nroutes: [\n";
const WORKFLOW_CLEAN = [
  "jobs:",
  "  audit:",
  "    steps:",
  "      - run: ./scripts/audit-review.mjs --slot review-a",
  "",
].join("\n");
const WORKFLOW_HARDCODED = [
  "jobs:",
  "  audit:",
  "    steps:",
  "      - run: echo deepseek-chat",
  "",
].join("\n");

const write = (dir, name, text) => {
  const full = join(dir, name);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, text);
};

const setupAuditFiles = (dir) => {
  write(dir, "a.json", JSON.stringify(A_CLEAN));
  write(dir, "b.json", JSON.stringify(B_CLEAN));
  write(dir, "disagree-a.json", JSON.stringify(record()));
  write(dir, "disagree-b.json", JSON.stringify({
    ...record(),
    findings: [
      { path: "scripts/x.mjs", line: 12, severity: "blocker", criterion: "必须校验输入", suggestion: "加校验" },
      { path: "scripts/y.mjs", line: 3, severity: "low", criterion: "命名", suggestion: "改名" },
    ],
    evidence: { executor: "sandbox", agent: "review-b", model: "deepseek-reasoner", request_id: "req-2" },
  }));
  write(dir, "infra.json", JSON.stringify(A_INFRA));
  write(dir, "bad.json", "not json at all\n");
};

const setupRouting = (routing, workflow) => (dir) => {
  if (routing !== null) write(dir, ".agents/platform/routing.yml", routing);
  if (workflow !== null) write(dir, ".github/workflows/audit.yml", workflow);
};

const setupReview = (routing) => (dir) => {
  write(dir, "diff.txt", DIFF);
  mkdirSync(join(dir, "out"), { recursive: true });
  if (routing !== null) write(dir, ".agents/platform/routing.yml", routing);
};

const PR_VIEW = JSON.stringify({ headRefOid: "abc123", headRefName: "feat/x", state: "OPEN" });
const RUN_LIST = JSON.stringify([
  { databaseId: 77, headSha: "abc123", createdAt: "2099-01-01T00:00:00.000Z", status: "completed" },
]);
const CHECKS_OK = [
  JSON.stringify({ id: 11, name: "build", conclusion: "success", title: "构建", summary: "" }),
  JSON.stringify({ id: 12, name: "audit", conclusion: "success", title: "审计通过", summary: "结论 success" }),
  "",
].join("\n");
const CHECKS_FAIL = [
  JSON.stringify({ id: 12, name: "audit", conclusion: "failure", title: "审计不合格", summary: "有 blocker" }),
  "",
].join("\n");
const CHECKS_ACTREQ = [
  JSON.stringify({ id: 12, name: "audit", conclusion: "action_required", title: "判不了", summary: "" }),
  "",
].join("\n");

const setupCollect = (checks) => (dir) => {
  write(dir, "pr_view.json", PR_VIEW);
  write(dir, "run_list.json", RUN_LIST);
  write(dir, "check_runs.ndjson", checks);
  write(dir, "a.json", JSON.stringify(A_CLEAN));
  write(dir, "b.json", JSON.stringify(B_CLEAN));
};

// 假 gh：只认 audit-collect 真正用到的四个查询，数据来自沙箱目录；FAKE_FAIL 用来指定哪一步失败。
const FAKE_GH = [
  "#!/bin/sh",
  'D="$FAKE_DIR"',
  'step=""',
  'if [ "$1" = "pr" ] && [ "$2" = "view" ]; then step=pr',
  'elif [ "$1" = "workflow" ]; then step=workflow',
  'elif [ "$1" = "run" ]; then step=run',
  'elif [ "$1" = "api" ]; then step=api',
  "fi",
  'if [ "$FAKE_FAIL" = "$step" ]; then',
  '  echo "gh: $step 故意失败" >&2',
  "  exit 1",
  "fi",
  'case "$step" in',
  '  pr) cat "$D/pr_view.json" ;;',
  "  workflow) : ;;",
  '  run) cat "$D/run_list.json" ;;',
  '  api) cat "$D/check_runs.ndjson" ;;',
  '  *) echo "unexpected gh args: $*" >&2; exit 12 ;;',
  "esac",
  "exit 0",
  "",
].join("\n");
// ---- 运行时 ----
let workDir;
let engineBin;
let fakeBin;
let server;
let bodyDir;
let port = 0;

const CHAT_EMPTY = JSON.stringify({ findings: [] });
const CHAT_BLOCKER = JSON.stringify({
  findings: [
    {
      path: "scripts/x.mjs",
      line: 12,
      severity: "blocker",
      criterion: "必须校验输入",
      suggestion: "加校验",
    },
  ],
});
const CHAT_HIGH = JSON.stringify({
  findings: [
    {
      path: "scripts/x.mjs",
      line: 3,
      severity: "high",
      criterion: "必须校验输入",
      suggestion: "加校验",
    },
  ],
});
const CHAT_BAD_SCHEMA = JSON.stringify({
  findings: [
    { path: "scripts/x.mjs", line: 0, severity: "high", criterion: "", suggestion: "加校验" },
  ],
});

const chatReply = (mode) => {
  const wrap = (id, content) => [200, JSON.stringify({ id, choices: [{ message: { content } }] })];
  const FENCE = String.fromCharCode(96, 96, 96);
  switch (mode) {
    case "ok":
      return wrap("req-1", CHAT_EMPTY);
    case "blocker":
      return wrap("req-2", CHAT_BLOCKER);
    case "high":
      return wrap("req-3", CHAT_HIGH);
    case "fence":
      return wrap("req-4", FENCE + "json\n" + CHAT_HIGH + "\n" + FENCE);
    case "badjson":
      return wrap("req-5", "not json at all");
    case "nofindings":
      return wrap("req-6", JSON.stringify({ other: 1 }));
    case "badschema":
      return wrap("req-7", CHAT_BAD_SCHEMA);
    case "noid":
      return [200, JSON.stringify({ choices: [{ message: { content: CHAT_EMPTY } }] })];
    case "nocontent":
      return [200, JSON.stringify({ id: "req-9", choices: [{ message: { role: "assistant" } }] })];
    case "http500":
      return [500, "boom " + "x".repeat(300)];
    case "notjson":
      return [200, "<html>oops</html>"];
    default:
      return wrap("req-0", CHAT_EMPTY);
  }
};

// 上游替身必须跑在独立进程里：被测进程是 spawnSync 起的，同一线程里的 http server
// 在 spawnSync 期间根本拿不到 CPU，会和孩子互等到超时。请求体由替身落盘，主进程回读。
const buildServerSource = () =>
  [
    'import { createServer } from "node:http";',
    'import { mkdirSync, writeFileSync } from "node:fs";',
    'import { join } from "node:path";',
    "const CHAT_EMPTY = " + JSON.stringify(CHAT_EMPTY) + ";",
    "const CHAT_BLOCKER = " + JSON.stringify(CHAT_BLOCKER) + ";",
    "const CHAT_HIGH = " + JSON.stringify(CHAT_HIGH) + ";",
    "const CHAT_BAD_SCHEMA = " + JSON.stringify(CHAT_BAD_SCHEMA) + ";",
    "const chatReply = " + chatReply.toString() + ";",
    "const dir = process.env.PARITY_BODY_DIR;",
    "mkdirSync(dir, { recursive: true });",
    "let seq = 0;",
    "const server = createServer((request, response) => {",
    '  let raw = "";',
    '  request.setEncoding("utf8");',
    '  request.on("data", (chunk) => { raw += chunk; });',
    '  request.on("end", () => {',
    "    seq += 1;",
    '    const name = "req-" + String(seq).padStart(4, "0") + ".json";',
    "    writeFileSync(join(dir, name), JSON.stringify({ url: request.url, body: raw }));",
    '    const mode = String(request.url).split("/").filter(Boolean)[0] || "ok";',
    "    const reply = chatReply(mode);",
    '    response.writeHead(reply[0], { "content-type": "application/json" });',
    "    response.end(reply[1]);",
    "  });",
    "});",
    'server.listen(0, "127.0.0.1", () => {',
    '  writeFileSync(join(dir, "port.txt"), String(server.address().port));',
    "});",
    "",
  ].join("\n");

const readBodies = () => {
  const names = readdirSync(bodyDir)
    .filter((name) => name.startsWith("req-"))
    .sort();
  return names.map((name) => readFileSync(join(bodyDir, name), "utf8"));
};

beforeAll(async () => {
  workDir = mkdtempSync(join(tmpdir(), "engine-parity-d-"));
  bodyDir = join(workDir, "bodies");
  mkdirSync(bodyDir, { recursive: true });
  fakeBin = join(workDir, "bin");
  mkdirSync(fakeBin, { recursive: true });
  writeFileSync(join(fakeBin, "gh"), FAKE_GH);
  chmodSync(join(fakeBin, "gh"), 0o755);
  engineBin = join(workDir, "engine");
  const build = spawnSync("go", ["build", "-o", engineBin, "./cmd/engine"], {
    cwd: engineDir,
    env: goEnv,
    encoding: "utf8",
    timeout: 240000,
  });
  if (build.status !== 0)
    throw new Error("go build 失败: " + (build.stderr || "") + (build.stdout || ""));
  const serverScript = join(workDir, "chat-server.mjs");
  writeFileSync(serverScript, buildServerSource());
  const { spawn } = await import("node:child_process");
  server = spawn(process.execPath, [serverScript], {
    env: { ...process.env, PARITY_BODY_DIR: bodyDir },
    stdio: "ignore",
  });
  const portFile = join(bodyDir, "port.txt");
  for (let i = 0; i < 200; i += 1) {
    try {
      const text = readFileSync(portFile, "utf8").trim();
      if (text) {
        port = Number(text);
        break;
      }
    } catch {
      // 还没写好，继续等
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  if (!port) throw new Error("上游替身没有起来（没读到端口）");
}, 300000);

afterAll(() => {
  if (server) server.kill();
  if (workDir) rmSync(workDir, { recursive: true, force: true });
});

const walkTree = (root) => {
  const files = new Map();
  const visit = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) {
        visit(full);
        continue;
      }
      files.set(full.slice(root.length + 1), readFileSync(full, "utf8"));
    }
  };
  visit(root);
  return files;
};

const normalizePaths = (text, root) => {
  let out = String(text === undefined || text === null ? "" : text);
  for (const variant of new Set([root, realpathSync(root)]))
    out = out.split(variant).join("<ROOT>");
  return out;
};

const YAML_MARK = "路由声明不是合法 YAML: .agents/platform/routing.yml: ";
const NET_MARK = "调用上游失败（没拿到响应）：";
const normalizeDetail = (text, mode) => {
  const mark = mode === "yaml" ? YAML_MARK : mode === "net" ? NET_MARK : null;
  if (!mark) return text;
  const at = text.indexOf(mark);
  return at === -1 ? text : text.slice(0, at + mark.length) + "<DETAIL>";
};
const normalizeText = (text, root, mode) => normalizeDetail(normalizePaths(text, root), mode);

const resolveArgs = (value) => (typeof value === "function" ? value() : value);
const resolveEnv = (value, dir) => (typeof value === "function" ? value(dir) : value || {});

const runPair = (fixture) => {
  const root = join(workDir, "case-" + fixture.id);
  const jsRoot = join(root, "js");
  const goRoot = join(root, "go");
  for (const dir of [jsRoot, goRoot]) {
    mkdirSync(dir, { recursive: true });
    if (fixture.setup) fixture.setup(dir);
  }
  const args = resolveArgs(fixture.args);
  const runOne = (bin, argv, dir) => {
    const before = readBodies().length;
    const result = spawnSync(bin, argv, {
      cwd: dir,
      env: { ...process.env, ...resolveEnv(fixture.env, dir) },
      encoding: "utf8",
      timeout: 120000,
    });
    return { result, bodies: readBodies().slice(before) };
  };
  const js = runOne(process.execPath, [join(repoRoot, "scripts", fixture.script), ...args], jsRoot);
  const go = runOne(engineBin, [fixture.cmd, ...args], goRoot);
  const mode = fixture.normalize || "none";
  const normalizeFiles = (map, dir) => {
    const out = new Map();
    for (const [name, text] of map) out.set(name, normalizeText(text, dir, mode));
    return out;
  };
  return {
    js: js.result,
    go: go.result,
    jsStdout: normalizeText(js.result.stdout, jsRoot, mode),
    goStdout: normalizeText(go.result.stdout, goRoot, mode),
    jsStderr: normalizeText(js.result.stderr, jsRoot, mode),
    goStderr: normalizeText(go.result.stderr, goRoot, mode),
    jsFiles: normalizeFiles(walkTree(jsRoot), jsRoot),
    goFiles: normalizeFiles(walkTree(goRoot), goRoot),
    jsBodies: js.bodies,
    goBodies: go.bodies,
  };
};

const checkFixture = (fixture) => {
  const outcome = runPair(fixture);
  expect(outcome.js.status, "JS 退出码 " + fixture.id).toBe(fixture.expectExit);
  expect(outcome.go.status, "Go 退出码 " + fixture.id).toBe(fixture.expectExit);
  expect(outcome.goStdout, "stdout " + fixture.id).toBe(outcome.jsStdout);
  expect(outcome.goStderr, "stderr " + fixture.id).toBe(outcome.jsStderr);
  expect([...outcome.goFiles.keys()], "写出的文件清单 " + fixture.id).toEqual([
    ...outcome.jsFiles.keys(),
  ]);
  for (const [name, text] of outcome.jsFiles)
    expect(outcome.goFiles.get(name), "文件内容 " + name).toBe(text);
  expect(outcome.goBodies, "上游请求体 " + fixture.id).toEqual(outcome.jsBodies);
};
// ---- 夹具 ----
const reviewBase = (mode) => () => ["--api-base", "http://127.0.0.1:" + port + "/" + mode];
const reviewArgs = (mode, slot) => () => [
  "--slot", slot || "review-a",
  "--diff", "diff.txt",
  "--out", "out/record.json",
  "--api-base", "http://127.0.0.1:" + port + "/" + mode,
];

const FIXTURES = [
  // ---- audit-findings：口径层 ----
  {
    id: "af-pass",
    title: "两槽都干净 -> pass",
    script: "audit-findings.mjs",
    cmd: "audit-findings",
    args: ["--a", "a.json", "--b", "b.json"],
    setup: setupAuditFiles,
    expectExit: 0,
  },
  {
    id: "af-pass-out",
    title: "写出 result.json",
    script: "audit-findings.mjs",
    cmd: "audit-findings",
    args: ["--a", "a.json", "--b", "b.json", "--out", "result.json"],
    setup: setupAuditFiles,
    expectExit: 0,
  },
  {
    id: "af-disagree",
    title: "两侧结论与 severity 不一致",
    script: "audit-findings.mjs",
    cmd: "audit-findings",
    args: ["--a", "disagree-a.json", "--b", "disagree-b.json", "--out", "result.json"],
    setup: setupAuditFiles,
    expectExit: 1,
  },
  {
    id: "af-only-a",
    title: "只有 A 侧输入（缺 B 侧不算拒绝）",
    script: "audit-findings.mjs",
    cmd: "audit-findings",
    args: ["--a", "a.json"],
    setup: setupAuditFiles,
    expectExit: 0,
  },
  {
    id: "af-infra",
    title: "输入申报 INFRA -> 判不了",
    script: "audit-findings.mjs",
    cmd: "audit-findings",
    args: ["--a", "infra.json", "--b", "b.json"],
    setup: setupAuditFiles,
    expectExit: 3,
  },
  {
    id: "af-missing",
    title: "输入文件不存在",
    script: "audit-findings.mjs",
    cmd: "audit-findings",
    args: ["--a", "missing.json", "--b", "b.json"],
    setup: setupAuditFiles,
    expectExit: 3,
  },
  {
    id: "af-bad-json",
    title: "输入不是 JSON",
    script: "audit-findings.mjs",
    cmd: "audit-findings",
    args: ["--a", "bad.json"],
    setup: setupAuditFiles,
    expectExit: 3,
  },
  {
    id: "af-slot-identity",
    title: "B 槽输入自称 review-a",
    script: "audit-findings.mjs",
    cmd: "audit-findings",
    args: ["--a", "a.json", "--b", "a.json"],
    setup: setupAuditFiles,
    expectExit: 3,
  },

  // ---- audit-slot：槽位身份 ----
  {
    id: "as-usage",
    title: "无参 -> 用法错",
    script: "audit-slot.mjs",
    cmd: "audit-slot",
    args: [],
    expectExit: 1,
  },
  {
    id: "as-bad-slot",
    title: "非法槽名",
    script: "audit-slot.mjs",
    cmd: "audit-slot",
    args: ["--slot", "review-c", "--executor", "github", "--out", "o.json"],
    env: { AUDIT_INPUT: "{}" },
    expectExit: 1,
  },
  {
    id: "as-mismatch",
    title: "自报身份与所在槽位不符",
    script: "audit-slot.mjs",
    cmd: "audit-slot",
    args: ["--slot", "review-a", "--executor", "github", "--out", "o.json"],
    env: {
      AUDIT_INPUT: JSON.stringify({ verdict: "pass", evidence: { executor: "github", agent: "review-b" } }),
    },
    expectExit: 0,
  },
  {
    id: "as-empty",
    title: "上游未注入 findings",
    script: "audit-slot.mjs",
    cmd: "audit-slot",
    args: ["--slot", "review-a", "--executor", "github", "--out", "o.json"],
    env: { AUDIT_INPUT: "  " },
    expectExit: 0,
  },
  {
    id: "as-nested-out",
    title: "--out 的父目录不存在时自建",
    script: "audit-slot.mjs",
    cmd: "audit-slot",
    args: ["--slot", "review-a", "--executor", "sandbox", "--out", "deep/dir/o.json"],
    env: {
      AUDIT_INPUT: JSON.stringify({ verdict: "pass", evidence: { executor: "sandbox", agent: "review-a" } }),
    },
    expectExit: 0,
  },
  {
    id: "as-raw",
    title: "输入不是 JSON -> 原样交给口径层",
    script: "audit-slot.mjs",
    cmd: "audit-slot",
    args: ["--slot", "review-b", "--executor", "github", "--out", "o.json"],
    env: { AUDIT_INPUT: "not json at all" },
    expectExit: 0,
  },

  // ---- routing：模型名真源 ----
  {
    id: "rt-ok",
    title: "真源自洽 + workflow 无模型名",
    script: "routing.mjs",
    cmd: "routing",
    args: ["--check"],
    setup: setupRouting(ROUTING_OK, WORKFLOW_CLEAN),
    expectExit: 0,
  },
  {
    id: "rt-usage",
    title: "没有 --check -> 用法错",
    script: "routing.mjs",
    cmd: "routing",
    args: [],
    setup: setupRouting(ROUTING_OK, WORKFLOW_CLEAN),
    expectExit: 2,
  },
  {
    id: "rt-missing",
    title: "真源文件不存在",
    script: "routing.mjs",
    cmd: "routing",
    args: ["--check"],
    expectExit: 1,
  },
  {
    id: "rt-bad-yaml",
    title: "真源不是合法 YAML（解析器文案已登记为例外）",
    script: "routing.mjs",
    cmd: "routing",
    args: ["--check"],
    setup: setupRouting(ROUTING_BAD, WORKFLOW_CLEAN),
    normalize: "yaml",
    expectExit: 1,
  },
  {
    id: "rt-hardcoded",
    title: "workflow 里出现真源模型名",
    script: "routing.mjs",
    cmd: "routing",
    args: ["--check"],
    setup: setupRouting(ROUTING_OK, WORKFLOW_HARDCODED),
    expectExit: 1,
  },
  {
    id: "rt-empty-routes",
    title: "routes 是空数组",
    script: "routing.mjs",
    cmd: "routing",
    args: ["--check"],
    setup: setupRouting("version: 1\nroutes: []\n", WORKFLOW_CLEAN),
    expectExit: 1,
  },

  {
    id: "rt-word-boundary",
    title: "模型名嵌在更长的词里（不算硬编码）",
    script: "routing.mjs",
    cmd: "routing",
    args: ["--check"],
    setup: setupRouting(
      ROUTING_OK,
      [
        "jobs:",
        "  audit:",
        "    steps:",
        "      - run: echo my-deepseek-chat",
        "      - run: echo deepseek-chat-v2",
        "",
      ].join("\n"),
    ),
    expectExit: 0,
  },

  // ---- audit-collect：编排 ----
  {
    id: "ac-usage",
    title: "无参 -> 用法错",
    script: "audit-collect.mjs",
    cmd: "audit-collect",
    args: [],
    expectExit: 2,
  },
  {
    id: "ac-bad-pr",
    title: "--pr 不是正整数",
    script: "audit-collect.mjs",
    cmd: "audit-collect",
    args: ["--pr", "abc", "--a", "a.json", "--b", "b.json"],
    setup: setupCollect(CHECKS_OK),
    env: (dir) => ({ FAKE_DIR: dir, PATH: fakeBin + ":" + process.env.PATH }),
    expectExit: 2,
  },
  {
    id: "ac-dry-run",
    title: "dry-run 只打印命令，不发 run",
    script: "audit-collect.mjs",
    cmd: "audit-collect",
    args: ["--pr", "7", "--a", "a.json", "--b", "b.json", "--dry-run"],
    setup: setupCollect(CHECKS_OK),
    env: (dir) => ({ FAKE_DIR: dir, PATH: fakeBin + ":" + process.env.PATH }),
    expectExit: 0,
  },
  {
    id: "ac-ok-json",
    title: "全 pass -> 结论 success",
    script: "audit-collect.mjs",
    cmd: "audit-collect",
    args: ["--pr", "7", "--a", "a.json", "--b", "b.json", "--json"],
    setup: setupCollect(CHECKS_OK),
    env: (dir) => ({ FAKE_DIR: dir, PATH: fakeBin + ":" + process.env.PATH }),
    expectExit: 0,
  },
  {
    id: "ac-fail-json",
    title: "审计结论 failure -> 拒绝",
    script: "audit-collect.mjs",
    cmd: "audit-collect",
    args: ["--pr", "7", "--a", "a.json", "--b", "b.json", "--json"],
    setup: setupCollect(CHECKS_FAIL),
    env: (dir) => ({ FAKE_DIR: dir, PATH: fakeBin + ":" + process.env.PATH }),
    expectExit: 1,
  },
  {
    id: "ac-actreq-json",
    title: "conclusion 是 action_required -> 判不了",
    script: "audit-collect.mjs",
    cmd: "audit-collect",
    args: ["--pr", "7", "--a", "a.json", "--b", "b.json", "--json"],
    setup: setupCollect(CHECKS_ACTREQ),
    env: (dir) => ({ FAKE_DIR: dir, PATH: fakeBin + ":" + process.env.PATH }),
    expectExit: 3,
  },
  {
    id: "ac-gh-fail",
    title: "gh 查询失败 -> INFRA",
    script: "audit-collect.mjs",
    cmd: "audit-collect",
    args: ["--pr", "7", "--a", "a.json", "--b", "b.json", "--json"],
    setup: setupCollect(CHECKS_OK),
    env: (dir) => ({ FAKE_DIR: dir, PATH: fakeBin + ":" + process.env.PATH, FAKE_FAIL: "pr" }),
    expectExit: 3,
  },

  // ---- audit-review：执行器 ----
  {
    id: "rv-usage",
    title: "无参 -> 用法错",
    script: "audit-review.mjs",
    cmd: "audit-review",
    args: [],
    setup: setupReview(ROUTING_OK),
    expectExit: 2,
  },
  {
    id: "rv-bad-slot",
    title: "非法槽名",
    script: "audit-review.mjs",
    cmd: "audit-review",
    args: ["--slot", "review-c", "--diff", "diff.txt", "--out", "out/record.json"],
    setup: setupReview(ROUTING_OK),
    expectExit: 2,
  },
  {
    id: "rv-no-out-dir",
    title: "--out 的目录不存在（不替调用方创建）",
    script: "audit-review.mjs",
    cmd: "audit-review",
    args: ["--slot", "review-a", "--diff", "diff.txt", "--out", "nodir/record.json"],
    setup: setupReview(ROUTING_OK),
    expectExit: 2,
  },
  {
    id: "rv-missing-diff",
    title: "--diff 文件不存在",
    script: "audit-review.mjs",
    cmd: "audit-review",
    args: ["--slot", "review-a", "--diff", "missing.diff", "--out", "out/record.json"],
    setup: setupReview(ROUTING_OK),
    expectExit: 2,
  },
  {
    id: "rv-unknown-flag",
    title: "认不出的参数（--model 刻意不存在）",
    script: "audit-review.mjs",
    cmd: "audit-review",
    args: ["--slot", "review-a", "--diff", "diff.txt", "--out", "out/record.json", "--model", "x"],
    setup: setupReview(ROUTING_OK),
    expectExit: 2,
  },
  {
    id: "rv-no-key",
    title: "没有 DEEPSEEK_API_KEY -> INFRA",
    script: "audit-review.mjs",
    cmd: "audit-review",
    args: ["--slot", "review-a", "--diff", "diff.txt", "--out", "out/record.json"],
    setup: setupReview(ROUTING_OK),
    env: { DEEPSEEK_API_KEY: "" },
    expectExit: 3,
  },
  {
    id: "rv-no-routing",
    title: "取不到模型真源 -> INFRA",
    script: "audit-review.mjs",
    cmd: "audit-review",
    args: ["--slot", "review-a", "--diff", "diff.txt", "--out", "out/record.json"],
    setup: setupReview(null),
    env: { DEEPSEEK_API_KEY: "stub-key-123" },
    expectExit: 3,
  },
  {
    id: "rv-bad-yaml",
    title: "真源不是合法 YAML（解析器文案已登记为例外）",
    script: "audit-review.mjs",
    cmd: "audit-review",
    args: ["--slot", "review-a", "--diff", "diff.txt", "--out", "out/record.json"],
    setup: setupReview(ROUTING_BAD),
    env: { DEEPSEEK_API_KEY: "stub-key-123" },
    normalize: "yaml",
    expectExit: 3,
  },
  {
    id: "rv-ok",
    title: "模型说没有缺陷 -> pass",
    script: "audit-review.mjs",
    cmd: "audit-review",
    args: reviewArgs("ok"),
    setup: setupReview(ROUTING_OK),
    env: { DEEPSEEK_API_KEY: "stub-key-123" },
    expectExit: 0,
  },
  {
    id: "rv-blocker",
    title: "有 blocker -> reject",
    script: "audit-review.mjs",
    cmd: "audit-review",
    args: reviewArgs("blocker", "review-b"),
    setup: setupReview(ROUTING_OK),
    env: { DEEPSEEK_API_KEY: "stub-key-123" },
    expectExit: 0,
  },
  {
    id: "rv-high",
    title: "只有 high -> needs_revision",
    script: "audit-review.mjs",
    cmd: "audit-review",
    args: reviewArgs("high"),
    setup: setupReview(ROUTING_OK),
    env: { DEEPSEEK_API_KEY: "stub-key-123" },
    expectExit: 0,
  },
  {
    id: "rv-fence",
    title: "模型把 JSON 包在围栏里",
    script: "audit-review.mjs",
    cmd: "audit-review",
    args: reviewArgs("fence"),
    setup: setupReview(ROUTING_OK),
    env: { DEEPSEEK_API_KEY: "stub-key-123" },
    expectExit: 0,
  },
  {
    id: "rv-bad-json",
    title: "模型回复不是 JSON",
    script: "audit-review.mjs",
    cmd: "audit-review",
    args: reviewArgs("badjson"),
    setup: setupReview(ROUTING_OK),
    env: { DEEPSEEK_API_KEY: "stub-key-123" },
    expectExit: 3,
  },
  {
    id: "rv-no-findings",
    title: "模型输出里没有 findings 数组",
    script: "audit-review.mjs",
    cmd: "audit-review",
    args: reviewArgs("nofindings"),
    setup: setupReview(ROUTING_OK),
    env: { DEEPSEEK_API_KEY: "stub-key-123" },
    expectExit: 3,
  },
  {
    id: "rv-bad-schema",
    title: "模型输出不合 schema",
    script: "audit-review.mjs",
    cmd: "audit-review",
    args: reviewArgs("badschema"),
    setup: setupReview(ROUTING_OK),
    env: { DEEPSEEK_API_KEY: "stub-key-123" },
    expectExit: 3,
  },
  {
    id: "rv-no-request-id",
    title: "上游没有回 request_id",
    script: "audit-review.mjs",
    cmd: "audit-review",
    args: reviewArgs("noid"),
    setup: setupReview(ROUTING_OK),
    env: { DEEPSEEK_API_KEY: "stub-key-123" },
    expectExit: 3,
  },
  {
    id: "rv-no-content",
    title: "上游响应缺 choices[0].message.content",
    script: "audit-review.mjs",
    cmd: "audit-review",
    args: reviewArgs("nocontent"),
    setup: setupReview(ROUTING_OK),
    env: { DEEPSEEK_API_KEY: "stub-key-123" },
    expectExit: 3,
  },
  {
    id: "rv-http-500",
    title: "上游 HTTP 500",
    script: "audit-review.mjs",
    cmd: "audit-review",
    args: reviewArgs("http500"),
    setup: setupReview(ROUTING_OK),
    env: { DEEPSEEK_API_KEY: "stub-key-123" },
    expectExit: 3,
  },
  {
    id: "rv-not-json",
    title: "上游响应体不是 JSON",
    script: "audit-review.mjs",
    cmd: "audit-review",
    args: reviewArgs("notjson"),
    setup: setupReview(ROUTING_OK),
    env: { DEEPSEEK_API_KEY: "stub-key-123" },
    expectExit: 3,
  },
  {
    id: "rv-refused",
    title: "连不上上游（网络栈文案已登记为例外）",
    script: "audit-review.mjs",
    cmd: "audit-review",
    args: () => [
      "--slot", "review-a",
      "--diff", "diff.txt",
      "--out", "out/record.json",
      "--api-base", "http://127.0.0.1:9",
    ],
    setup: setupReview(ROUTING_OK),
    env: { DEEPSEEK_API_KEY: "stub-key-123" },
    normalize: "net",
    expectExit: 3,
  },
];

describe("阶段 D：审计六件套 Go 引擎 parity", () => {
  for (const fixture of FIXTURES) {
    it(fixture.id + " · " + fixture.title, () => {
      checkFixture(fixture);
    }, 120000);
  }

  it("覆盖：夹具 ≥24 条 / 失败路径 ≥10 条 / 退出码 0·1·2·3 都有", () => {
    const codes = new Set(FIXTURES.map((one) => one.expectExit));
    expect(FIXTURES.length).toBeGreaterThanOrEqual(24);
    expect(FIXTURES.filter((one) => one.expectExit !== 0).length).toBeGreaterThanOrEqual(10);
    for (const code of [0, 1, 2, 3]) expect(codes.has(code)).toBe(true);
  });

  it("已登记的例外只有两条，且都写成了显式归一", () => {
    const normalized = FIXTURES.filter((one) => one.normalize).map((one) => one.normalize);
    expect(new Set(normalized)).toEqual(new Set(["yaml", "net"]));
  });
});
