import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// 阶段 D2 对照：copy-dist / cli / kb-export 三件套
// 同一批输入分别喂 scripts/*.mjs 与 .cache 里编出来的 engine，逐字节比
// stdout / stderr / 退出码 / 写出的文件 / 打到后端的请求体。
// 后端换成沙箱里的替身（独立进程：spawnSync 期间同线程的 server 拿不到 CPU）。
const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
// 变异验证时用 PARITY_ENGINE_DIR 指向 /tmp 里改过的引擎副本，仓库本身不动。
const engineDir = process.env.PARITY_ENGINE_DIR || join(repoRoot, "apps/engine");
const goEnv = {
  ...process.env,
  GOPATH: join(repoRoot, ".cache/go"),
  GOCACHE: join(repoRoot, ".cache/go-build"),
  GOFLAGS: "-mod=mod",
};

// ---- 后端替身：一个独立进程，按 scenario.json 应答，把收到的请求逐条记账 ----
const SERVER_SOURCE = [
  'import { createServer } from "node:http";',
  'import { appendFileSync, readFileSync, writeFileSync } from "node:fs";',
  'import { join } from "node:path";',
  "const dir = process.env.PARITY_SERVER_DIR;",
  "const server = createServer((req, res) => {",
  "  const chunks = [];",
  '  req.on("data", (chunk) => chunks.push(chunk));',
  '  req.on("end", () => {',
  '    const raw = Buffer.concat(chunks).toString("utf8");',
  '    appendFileSync(join(dir, "requests.jsonl"), JSON.stringify({ method: req.method, url: req.url, body: raw }) + "\\n");',
  "    let scenario = {};",
  "    try {",
  '      scenario = JSON.parse(readFileSync(join(dir, "scenario.json"), "utf8"));',
  "    } catch {",
  "      scenario = {};",
  "    }",
  '    const route = (scenario.routes || {})[req.url] || {};',
  "    const status = route.status === undefined ? 200 : route.status;",
  '    const body = route.body === undefined ? "{}" : route.body;',
  '    res.writeHead(status, { "content-type": route.contentType || "application/json" });',
  '    res.end(typeof body === "string" ? body : JSON.stringify(body));',
  "  });",
  "});",
  'server.listen(0, "127.0.0.1", () => {',
  '  writeFileSync(join(dir, "port.txt"), String(server.address().port));',
  "});",
].join("\n");

let workDir;
let engineBin;
let server;
let serverDir;
let port = 0;
let gitRepo;
let gitFrom;
let gitTo;

const git = (args, cwd) =>
  spawnSync("git", args, { cwd, encoding: "utf8", timeout: 120000, env: process.env });

beforeAll(async () => {
  // realpath 一次：macOS 的 /var 是指向 /private/var 的软链，Node 的 ESM loader 会
  // 把 import.meta.url 解成真实路径，而 spawn 传的 argv[1] 是原样路径 —— 两者不等时
  // 脚本的「直接执行才跑」判定会静默不执行，对照会变成「两边都没输出」的假绿。
  workDir = realpathSync(mkdtempSync(join(tmpdir(), "engine-parity-e-")));
  engineBin = join(workDir, "engine");
  const build = spawnSync("go", ["build", "-o", engineBin, "./cmd/engine"], {
    cwd: engineDir,
    env: goEnv,
    encoding: "utf8",
    timeout: 240000,
  });
  if (build.status !== 0)
    throw new Error("go build 失败: " + (build.stderr || "") + (build.stdout || ""));

  // 一个带两个 commit 的临时仓库：kb-export 只读它，两个载体跑的是同一份 git 历史。
  gitRepo = join(workDir, "gitrepo");
  mkdirSync(join(gitRepo, "docs", "postmortem"), { recursive: true });
  mkdirSync(join(gitRepo, ".agents", "notes", "implemented"), { recursive: true });
  mkdirSync(join(gitRepo, "node_modules", "pkg"), { recursive: true });
  mkdirSync(join(gitRepo, "apps", "web-vue"), { recursive: true });
  writeFileSync(join(gitRepo, "docs", "architecture.md"), "arch v1\n");
  writeFileSync(join(gitRepo, "README.md"), "# top readme\n");
  writeFileSync(join(gitRepo, ".agents", "notes", "implemented", "n1.md"), "note one\n");
  writeFileSync(join(gitRepo, ".env"), "SECRET=1\n");
  writeFileSync(join(gitRepo, "node_modules", "pkg", "README.md"), "x\n");
  writeFileSync(join(gitRepo, "apps", "web-vue", "keep.txt"), "k\n");
  git(["init", "-q", "-b", "main", "."], gitRepo);
  git(["config", "user.email", "t@example.com"], gitRepo);
  git(["config", "user.name", "t"], gitRepo);
  git(["add", "-A"], gitRepo);
  git(["commit", "-qm", "c1"], gitRepo);
  gitFrom = git(["rev-parse", "HEAD"], gitRepo).stdout.trim();
  writeFileSync(join(gitRepo, "docs", "architecture.md"), "arch v2\n");
  writeFileSync(join(gitRepo, ".agents", "notes", "implemented", "n1.md"), "note two\n");
  writeFileSync(join(gitRepo, "docs", "postmortem", "p1.md"), "p1\n");
  writeFileSync(join(gitRepo, "node_modules", "pkg", "README.md"), "y\n");
  git(["add", "-A"], gitRepo);
  git(["commit", "-qm", "c2"], gitRepo);
  gitTo = git(["rev-parse", "HEAD"], gitRepo).stdout.trim();

  serverDir = join(workDir, "server");
  mkdirSync(serverDir, { recursive: true });
  const serverScript = join(workDir, "backend.mjs");
  writeFileSync(serverScript, SERVER_SOURCE);
  server = spawn(process.execPath, [serverScript], {
    env: { ...process.env, PARITY_SERVER_DIR: serverDir },
    stdio: "ignore",
  });
  const portFile = join(serverDir, "port.txt");
  for (let attempt = 0; attempt < 200; attempt += 1) {
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
  if (!port) throw new Error("后端替身没有起来（没读到端口）");
}, 300000);

afterAll(() => {
  if (server) server.kill();
  if (workDir) rmSync(workDir, { recursive: true, force: true });
});

// ---- 对照装置 ----
const walkTree = (root) => {
  const files = new Map();
  const visit = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      const full = join(dir, name);
      const stats = statSync(full);
      if (stats.isDirectory()) {
        visit(full);
        continue;
      }
      if (stats.isSymbolicLink()) {
        files.set(full.slice(root.length + 1), "<symlink>");
        continue;
      }
      files.set(full.slice(root.length + 1), readFileSync(full, "utf8"));
    }
  };
  visit(root);
  return files;
};

const normalizePaths = (text, dir) => {
  let out = String(text === undefined || text === null ? "" : text);
  for (const variant of new Set([dir, realpathSync(dir)])) out = out.split(variant).join("<DIR>");
  return out;
};

// 只登记两条例外文案（与 README 的迁移注记同源）：
// 网络栈文案（Node 走 uv/undici，Go 走 net）——
// 引擎的头是固定的，差异全部落在"连不上后端 <origin>: "之后，从那里截断。
const NET_MARK = "连不上后端 ";
const normalizeText = (text, dir) => {
  const normalized = normalizePaths(text, dir);
  const at = normalized.indexOf(NET_MARK);
  if (at === -1) return normalized;
  const lineEnd = normalized.indexOf("\n", at);
  const head = normalized.slice(at, normalized.indexOf(": ", at) + 2);
  return normalized.slice(0, at) + head + "<DETAIL>" + normalized.slice(lineEnd === -1 ? normalized.length : lineEnd);
};

const readRequests = () => {
  const file = join(serverDir, "requests.jsonl");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line));
};
const clearRequests = () => rmSync(join(serverDir, "requests.jsonl"), { force: true });
const writeScenario = (scenario) =>
  writeFileSync(join(serverDir, "scenario.json"), JSON.stringify(scenario));

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
  if (fixture.scenario !== undefined) writeScenario(fixture.scenario);

  const runOne = (bin, argv, dir) => {
    if (fixture.scenario !== undefined) clearRequests();
    const result = spawnSync(bin, argv, {
      cwd: dir,
      env: { ...process.env, ...resolveEnv(fixture.env, dir) },
      encoding: "utf8",
      timeout: 120000,
    });
    return { result, requests: fixture.scenario === undefined ? [] : readRequests() };
  };

  const jsArgv = fixture.sandboxScript
    ? [join(jsRoot, "scripts", fixture.script), ...args]
    : [join(repoRoot, "scripts", fixture.script), ...args];
  const js = runOne(process.execPath, jsArgv, jsRoot);
  const go = runOne(engineBin, [fixture.cmd, ...args], goRoot);

  const normalizeFiles = (map, dir) => {
    const out = new Map();
    for (const [name, text] of map) out.set(name, normalizeText(text, dir));
    return out;
  };
  return {
    js: js.result,
    go: go.result,
    jsStdout: normalizeText(js.result.stdout, jsRoot),
    goStdout: normalizeText(go.result.stdout, goRoot),
    jsStderr: normalizeText(js.result.stderr, jsRoot),
    goStderr: normalizeText(go.result.stderr, goRoot),
    jsFiles: normalizeFiles(walkTree(jsRoot), jsRoot),
    goFiles: normalizeFiles(walkTree(goRoot), goRoot),
    jsRequests: js.requests,
    goRequests: go.requests,
  };
};

// ---- 夹具 ----
const DIST_TREE = (dir) => {
  mkdirSync(join(dir, "apps", "web-vue", "dist", "assets"), { recursive: true });
  writeFileSync(join(dir, "apps", "web-vue", "dist", "index.html"), "<html>hi</html>\n");
  writeFileSync(join(dir, "apps", "web-vue", "dist", "assets", "app.js"), "console.log(1)\n");
  writeFileSync(join(dir, "apps", "web-vue", "dist", "assets", "app.css"), "body{}\n");
};
const TARGET_TREE = (dir, { stale }) => {
  mkdirSync(join(dir, "apps", "api-go", "dist"), { recursive: true });
  writeFileSync(join(dir, "apps", "api-go", "dist", "README.md"), "# placeholder\n");
  writeFileSync(join(dir, "apps", "api-go", "dist", ".gitkeep"), "");
  if (stale) {
    writeFileSync(join(dir, "apps", "api-go", "dist", "stale.txt"), "stale\n");
    mkdirSync(join(dir, "apps", "api-go", "dist", "old"), { recursive: true });
    writeFileSync(join(dir, "apps", "api-go", "dist", "old", "gone.js"), "x\n");
  }
};
const withDistScript = (dir) => {
  mkdirSync(join(dir, "scripts"), { recursive: true });
  copyFileSync(
    join(repoRoot, "scripts", "copy-dist.mjs"),
    join(dir, "scripts", "copy-dist.mjs"),
  );
};

const BOARD_ITEMS = {
  items: [
    { id: "issue-1", state: "todo", title: "甲", divergence: true },
    { id: "issue-2", state: null, title: "" },
    { id: "issue-3", state: "verify", title: "乙 issue" },
  ],
};
const VERDICT_OK = { id: "issue-1", from: "todo", to: "in_progress", by: "owner" };
const OUTBOX_OK = {
  entries: [
    {
      attemptId: "attempt-1",
      item: "issue-1",
      from: "todo",
      to: "in_progress",
      status: "running",
      attempts: 2,
    },
    {
      attemptId: "attempt-2",
      item: "issue-2",
      from: "verify",
      to: "done",
      status: "queued",
      attempts: 1,
    },
  ],
  nextCheckAt: "2026-10-27T00:00:00Z",
};
const VERIFY_RED = {
  exitCode: 1,
  output: Array.from({ length: 25 }, (_, index) => "line-" + String(index + 1)).join("\n"),
};

const EXISTING_MANIFEST = [
  "# 知识库汇入清单 · source_repo=owner/name source_ref=main range=aaa..bbb",
  "# 累积清单：本次区间新增 1 条、继承 0 条、共 1 条",
  "# 每条固定头见 docs/knowledge-base.md；sha256 取 git blob（commit 内的内容字节），不是工作区。",
  "- source_repo: owner/name",
  "  source_ref: main",
  "  commit: " + "0".repeat(40),
  "  path: docs/permissions.md",
  "  sha256: " + "1".repeat(64),
  "  updated_at: 2026-01-01T00:00:00+08:00",
  "",
].join("\n");

const fixtures = [
  // copy-dist：三个（含"没有 dist"的占位分支与"清掉上一轮产物"）
  {
    id: "copy-dist-ok",
    cmd: "copy-dist",
    script: "copy-dist.mjs",
    sandboxScript: true,
    setup: (dir) => {
      withDistScript(dir);
      DIST_TREE(dir);
      TARGET_TREE(dir, { stale: false });
    },
    args: [],
  },
  {
    id: "copy-dist-stale",
    cmd: "copy-dist",
    script: "copy-dist.mjs",
    sandboxScript: true,
    setup: (dir) => {
      withDistScript(dir);
      DIST_TREE(dir);
      TARGET_TREE(dir, { stale: true });
    },
    args: [],
  },
  {
    id: "copy-dist-nodist",
    cmd: "copy-dist",
    script: "copy-dist.mjs",
    sandboxScript: true,
    setup: (dir) => {
      withDistScript(dir);
      TARGET_TREE(dir, { stale: true });
    },
    args: [],
  },

  // kb-export：成功路径 + 累积/重试 + 五种失败路径
  {
    id: "kb-ok",
    cmd: "kb-export",
    script: "kb-export.mjs",
    args: ["--cwd", "__REPO__", "--repo", "owner/name", "--from", "__FROM__", "--to", "__TO__", "--out", "manifest.yml", "--infra-out", "infra.yml"],
  },
  {
    id: "kb-range",
    cmd: "kb-export",
    script: "kb-export.mjs",
    args: ["--cwd", "__REPO__", "--repo", "owner/name", "--range", "__FROM__..__TO__", "--ref", "develop"],
  },
  {
    id: "kb-help",
    cmd: "kb-export",
    script: "kb-export.mjs",
    args: ["--help"],
  },
  {
    id: "kb-no-repo",
    cmd: "kb-export",
    script: "kb-export.mjs",
    env: { GITHUB_REPOSITORY: "" },
    args: ["--cwd", "__REPO__", "--from", "__FROM__", "--to", "__TO__"],
  },
  {
    id: "kb-bad-range",
    cmd: "kb-export",
    script: "kb-export.mjs",
    args: ["--cwd", "__REPO__", "--repo", "owner/name", "--range", "abc"],
  },
  {
    id: "kb-stray",
    cmd: "kb-export",
    script: "kb-export.mjs",
    args: ["--cwd", "__REPO__", "--repo", "owner/name", "--from", "__FROM__", "--to", "__TO__", "stray"],
  },
  {
    id: "kb-missing-value",
    cmd: "kb-export",
    script: "kb-export.mjs",
    args: ["--cwd", "__REPO__", "--repo"],
  },
  {
    id: "kb-existing",
    cmd: "kb-export",
    script: "kb-export.mjs",
    setup: (dir) => writeFileSync(join(dir, "existing.yml"), EXISTING_MANIFEST),
    args: ["--cwd", "__REPO__", "--repo", "owner/name", "--from", "__FROM__", "--to", "__TO__", "--existing", "existing.yml", "--out", "manifest.yml", "--infra-out", "infra.yml"],
  },
  {
    id: "kb-require-missing",
    cmd: "kb-export",
    script: "kb-export.mjs",
    args: ["--cwd", "__REPO__", "--repo", "owner/name", "--from", "__FROM__", "--to", "__TO__", "--existing", "nope.yml", "--require-existing", "--out", "manifest.yml", "--infra-out", "infra.yml"],
  },
  {
    id: "kb-retry",
    cmd: "kb-export",
    script: "kb-export.mjs",
    setup: (dir) =>
      writeFileSync(
        join(dir, "retry.yml"),
        ["kind: infra", "retry_paths:", "  - docs/architecture.md", "  - docs/postmortem/p1.md", "failures: []", ""].join("\n"),
      ),
    args: ["--cwd", "__REPO__", "--repo", "owner/name", "--from", "__FROM__", "--to", "__TO__", "--retry", "retry.yml", "--out", "manifest.yml", "--infra-out", "infra.yml"],
  },

  // cli：五个命令 + 后端错误面 + 用法错误面
  {
    id: "cli-help",
    cmd: "cli",
    script: "cli.mjs",
    args: ["--help"],
  },
  {
    id: "cli-board",
    cmd: "cli",
    script: "cli.mjs",
    scenario: { routes: { "/api/board": { body: BOARD_ITEMS } } },
    args: () => ["board", "--api", "http://127.0.0.1:" + String(port)],
  },
  {
    id: "cli-board-json",
    cmd: "cli",
    script: "cli.mjs",
    scenario: { routes: { "/api/board": { body: BOARD_ITEMS } } },
    args: () => ["board", "--json", "--api", "http://127.0.0.1:" + String(port)],
  },
  {
    id: "cli-board-no-items",
    cmd: "cli",
    script: "cli.mjs",
    scenario: { routes: { "/api/board": { body: {} } } },
    args: () => ["board", "--api", "http://127.0.0.1:" + String(port)],
  },
  {
    id: "cli-new",
    cmd: "cli",
    script: "cli.mjs",
    scenario: { routes: { "/api/item": { body: { id: "issue-9", to: "todo" } } } },
    args: () => ["new", "标题 甲", "--body", "正文", "--api", "http://127.0.0.1:" + String(port)],
  },
  {
    id: "cli-verdict-guard",
    cmd: "cli",
    script: "cli.mjs",
    scenario: { routes: { "/api/verdict": { body: VERDICT_OK } } },
    args: () => [
      "verdict",
      "--id", "issue-1",
      "--to", "in_progress",
      "--guard", "review=PR#12 approved",
      "--guard", "tests=vitest 全绿",
      "--comment", "开始做",
      "--api", "http://127.0.0.1:" + String(port),
    ],
  },
  {
    id: "cli-verdict-missing-to",
    cmd: "cli",
    script: "cli.mjs",
    args: ["verdict", "--id", "issue-1"],
  },
  {
    id: "cli-verdict-bad-guard",
    cmd: "cli",
    script: "cli.mjs",
    args: ["verdict", "--id", "issue-1", "--to", "done", "--guard", "nope"],
  },
  {
    id: "cli-unknown-option",
    cmd: "cli",
    script: "cli.mjs",
    args: ["board", "--nope", "x"],
  },
  {
    id: "cli-new-two-titles",
    cmd: "cli",
    script: "cli.mjs",
    args: ["new", "甲", "乙"],
  },
  {
    id: "cli-verify-red",
    cmd: "cli",
    script: "cli.mjs",
    scenario: { routes: { "/api/verify": { body: VERIFY_RED } } },
    args: () => ["verify", "--api", "http://127.0.0.1:" + String(port)],
  },
  {
    id: "cli-verify-bad-code",
    cmd: "cli",
    script: "cli.mjs",
    scenario: { routes: { "/api/verify": { body: { exitCode: "1" } } } },
    args: () => ["verify", "--api", "http://127.0.0.1:" + String(port)],
  },
  {
    id: "cli-outbox",
    cmd: "cli",
    script: "cli.mjs",
    scenario: { routes: { "/api/outbox": { body: OUTBOX_OK } } },
    args: () => ["outbox", "--api", "http://127.0.0.1:" + String(port)],
  },
  {
    id: "cli-outbox-empty",
    cmd: "cli",
    script: "cli.mjs",
    scenario: { routes: { "/api/outbox": { body: { entries: [], nextCheckAt: null } } } },
    args: () => ["outbox", "--api", "http://127.0.0.1:" + String(port)],
  },
  {
    id: "cli-backend-rejected",
    cmd: "cli",
    script: "cli.mjs",
    scenario: {
      routes: {
        "/api/verdict": {
          status: 400,
          body: { kind: "rejected", code: "ILLEGAL_TRANSITION", message: "这条转换不允许" },
        },
      },
    },
    args: () => ["verdict", "--id", "issue-1", "--to", "done", "--api", "http://127.0.0.1:" + String(port)],
  },
  {
    id: "cli-backend-infra",
    cmd: "cli",
    script: "cli.mjs",
    scenario: { routes: { "/api/board": { status: 500, body: { message: "账本读不动" } } } },
    args: () => ["board", "--api", "http://127.0.0.1:" + String(port)],
  },
  {
    id: "cli-not-json",
    cmd: "cli",
    script: "cli.mjs",
    scenario: { routes: { "/api/board": { body: "不是 JSON" } } },
    args: () => ["board", "--api", "http://127.0.0.1:" + String(port)],
  },
  {
    id: "cli-net-down",
    cmd: "cli",
    script: "cli.mjs",
    // 一个肯定没人听的端口：网络栈文案随实现而变，是登记在案的例外。
    args: ["board", "--api", "http://127.0.0.1:1"],
  },
  {
    id: "cli-bad-api",
    cmd: "cli",
    script: "cli.mjs",
    args: ["board", "--api", "ftp://example.com"],
  },
];

// __REPO__/__FROM__/__TO__ 是占位：仓库路径与 sha 在 beforeAll 里才定下来。
const expand = (value) =>
  value
    .split("__REPO__").join(gitRepo)
    .split("__FROM__").join(gitFrom)
    .split("__TO__").join(gitTo);
const expandedFixtures = fixtures.map((fixture) => ({
  ...fixture,
  args: () => resolveArgs(fixture.args).map(expand),
}));

const expectPair = (pair) => {
  expect(pair.go.result).toBeUndefined();
  expect(pair.goStdout).toBe(pair.jsStdout);
  expect(pair.goStderr).toBe(pair.jsStderr);
  expect(pair.go.status).toBe(pair.js.status);
  expect([...pair.goFiles.keys()].sort()).toEqual([...pair.jsFiles.keys()].sort());
  for (const [name, text] of pair.jsFiles) expect(pair.goFiles.get(name)).toBe(text);
  expect(pair.goRequests).toEqual(pair.jsRequests);
};

describe("engine parity · copy-dist / cli / kb-export", () => {
  for (const fixture of expandedFixtures) {
    it(fixture.id, () => {
      const pair = runPair(fixture);
      expectPair(pair);
    });
  }
});

describe("引擎都是真跑出来的结论（防止空对照）", () => {
  it("kb-export 真的产出了清单与记录", () => {
    const pair = runPair(expandedFixtures.find((fixture) => fixture.id === "kb-ok"));
    const manifest = pair.goFiles.get("manifest.yml");
    expect(manifest).toContain("path: docs/architecture.md");
    expect(manifest).toContain("path: docs/postmortem/p1.md");
    expect(pair.goFiles.get("infra.yml")).toContain("kind: ok");
    expect(pair.js.status).toBe(0);
    expect(pair.go.status).toBe(0);
  });

  it("copy-dist 真的把 dist 铺进了目标目录", () => {
    const pair = runPair(expandedFixtures.find((fixture) => fixture.id === "copy-dist-ok"));
    expect(pair.goFiles.get("apps/api-go/dist/index.html")).toBe("<html>hi</html>\n");
    expect(pair.goFiles.get("apps/api-go/dist/assets/app.css")).toBe("body{}\n");
    expect(pair.goFiles.get("apps/api-go/dist/.gitkeep")).toBe("");
  });

  it("cli 真的发了请求（请求体逐字节一致）", () => {
    const pair = runPair(expandedFixtures.find((fixture) => fixture.id === "cli-verdict-guard"));
    expect(pair.goRequests.length).toBe(1);
    expect(pair.goRequests[0].url).toBe("/api/verdict");
    const body = JSON.parse(pair.goRequests[0].body);
    expect(body.guards).toEqual({ review: "PR#12 approved", tests: "vitest 全绿" });
    expect(body.actor_role).toBe("owner");
  });
});

describe("调用点已切到引擎（钉住，不许回退）", () => {
  const packageText = readFileSync(join(repoRoot, "package.json"), "utf8");
  const packageJson = JSON.parse(packageText);
  const kbSync = readFileSync(join(repoRoot, ".github", "workflows", "kb-sync.yml"), "utf8");

  it("package.json 不再用 node 跑 cli.mjs 与 copy-dist.mjs", () => {
    expect(packageText).not.toContain("node scripts/cli.mjs");
    expect(packageText).not.toContain("node scripts/copy-dist.mjs");
    expect(packageJson.scripts.cli).toContain("engine cli");
    expect(packageJson.scripts["web:dist"]).toContain("engine copy-dist");
    expect(packageJson.scripts["check:web"]).toContain("engine copy-dist");
  });

  it("kb-sync.yml 不再用 node 跑 kb-export.mjs", () => {
    expect(kbSync).not.toContain("node scripts/kb-export.mjs");
    expect(kbSync).toContain("engine kb-export");
  });
});
