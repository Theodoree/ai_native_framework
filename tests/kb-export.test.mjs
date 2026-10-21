import { test, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import YAML from "yaml";
import { deniedReason, isKbPath } from "../scripts/kb-export.mjs";

// 专测 kb-export 与 kb-sync 的接线：清单由脚本真跑出来，job 红绿由 YAML 的 if 与步骤正文决定。
// 契约（六字段 / 幂等 / 排除项 / INFRA 不阻断合并）都落成可执行的断言，不靠读代码确认。

const ROOT = process.cwd();
const SCRIPT = join(ROOT, "scripts/kb-export.mjs");
const WORKFLOW = join(ROOT, ".github/workflows/kb-sync.yml");
const REPO = "owner/name";
const AT = "2020-05-06T07:08:09+00:00";
const FIELDS = [
  "source_repo",
  "source_ref",
  "commit",
  "path",
  "sha256",
  "updated_at",
];

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

// 一次「合并到 main」的形状：base 是合并前，tip 是合并后。
function run(dir, args, env = {}) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: dir,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

// 只让「读 commit 时间」那一条 git 命令失败，diff / cat-file 照常：
// 这样 records 仍会产出，updated_at 的形状才真的被断言到。
function shimBrokenCommitDate(dir) {
  const shim = join(dir, "shim");
  mkdirSync(shim, { recursive: true });
  writeFileSync(
    join(shim, "git"),
    [
      "#!/bin/sh",
      'case "$*" in',
      '  *"--format=%cI"*) exit 128 ;;',
      "esac",
      'exec env PATH="${PATH#*:}" git "$@"',
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  return `${shim}:${process.env.PATH}`;
}

function exportManifest(dir, args) {
  const out = join(dir, "kb-manifest.yml");
  const infra = join(dir, "kb-infra.yml");
  const r = run(dir, [
    "--repo",
    REPO,
    "--from",
    args.from,
    "--to",
    args.to,
    "--out",
    out,
    "--infra-out",
    infra,
    ...(args.extra || []),
  ]);
  return {
    ...r,
    text: readFileSync(out, "utf8"),
    records: YAML.parse(readFileSync(out, "utf8")) ?? [],
    infra: YAML.parse(readFileSync(infra, "utf8")),
    outPath: out,
  };
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

const sha256 = (text) => createHash("sha256").update(text).digest("hex");

test("(a) 一次合并区间 → 每条记录就是六个固定字段，YAML 数组可直接写库", () => {
  const { dir, base, tip } = mergedRange();
  const m = exportManifest(dir, { from: base, to: tip });

  expect(m.status).toBe(0);
  expect(m.records.map((r) => r.path)).toEqual([
    ".agents/notes/implemented/p02-delta.md",
    "docs/architecture.md",
    "docs/postmortem/p01-outage.md",
  ]);
  for (const record of m.records) expect(Object.keys(record)).toEqual(FIELDS);

  const arch = m.records.find((r) => r.path === "docs/architecture.md");
  expect(arch).toEqual({
    source_repo: REPO,
    source_ref: "main",
    commit: tip,
    path: "docs/architecture.md",
    // 摘要算的是 commit 里的字节：换机器、换 checkout 都不变。
    sha256: sha256("arch v2\n"),
    updated_at: "2020-05-06T07:08:09Z",
  });
});

test("(a) commit 取区间内最后改到该路径的那次：按它复算得到同一份字节", () => {
  const dir = newRepo();
  const base = commit(
    dir,
    { "docs/architecture.md": "v1\n" },
    { message: "b" },
  );
  const mid = commit(
    dir,
    { "docs/architecture.md": "v2\n" },
    { message: "mid" },
  );
  const tip = commit(
    dir,
    { "docs/postmortem/p01-outage.md": "boom\n" },
    { message: "tip" },
  );

  const m = exportManifest(dir, { from: base, to: tip });
  const arch = m.records.find((r) => r.path === "docs/architecture.md");

  expect(arch.commit).toBe(mid);
  expect(sh(dir, ["show", mid + ":docs/architecture.md"])).toBe("v2");
  expect(arch.sha256).toBe(sha256("v2\n"));
});

test("(a) sha256 取 git blob 不是工作区：改了没提交，摘要不动", () => {
  const { dir, base, tip } = mergedRange();
  const before = exportManifest(dir, { from: base, to: tip });
  put(dir, "docs/architecture.md", "写坏的工作区\n");
  const after = exportManifest(dir, { from: base, to: tip });

  expect(after.records).toEqual(before.records);
  const arch = after.records.find((r) => r.path === "docs/architecture.md");
  expect(arch.sha256).toBe(sha256("arch v2\n"));
});

test("(b) 同一区间算两次字节一致；updated_at 取 commit 时间而不是 now()", () => {
  const { dir, base, tip } = mergedRange();
  const first = exportManifest(dir, { from: base, to: tip });
  const second = exportManifest(dir, { from: base, to: tip });

  expect(second.text).toBe(first.text);
  expect(new Set(first.records.map((r) => r.updated_at))).toEqual(
    new Set(["2020-05-06T07:08:09Z"]),
  );
  expect(first.records.every((r) => r.updated_at.startsWith("2020-"))).toBe(
    true,
  );
});

test("(b) updated_at 可注入：注入值覆盖 commit 时间，清单里不留 now()", () => {
  const { dir, base, tip } = mergedRange();
  const injected = "2030-12-31T00:00:00Z";
  const m = exportManifest(dir, {
    from: base,
    to: tip,
    extra: ["--updated-at", injected],
  });

  expect(new Set(m.records.map((r) => r.updated_at))).toEqual(
    new Set([injected]),
  );
});

test("(b) commit 时间读不出就是 null：退出 3、不拿 now() 补位、两次字节一致", () => {
  const { dir, base, tip } = mergedRange();
  const env = { PATH: shimBrokenCommitDate(dir) };
  const outA = join(dir, "a.yml");
  const outB = join(dir, "b.yml");
  const infraPath = join(dir, "kb-infra.yml");
  const go = (out) =>
    run(
      dir,
      [
        "--repo",
        REPO,
        "--from",
        base,
        "--to",
        tip,
        "--out",
        out,
        "--infra-out",
        infraPath,
      ],
      env,
    );

  const first = go(outA);
  const second = go(outB);
  const bytesA = readFileSync(outA);
  const bytesB = readFileSync(outB);
  const records = YAML.parse(bytesA.toString("utf8"));

  // (i) 读不到时间仍是 INFRA：缺陷不会把退出码洗成 0。
  expect(first.status).toBe(3);
  expect(second.status).toBe(3);
  // (ii) 六字段结构照旧，updated_at 就是 null——不删字段，也不编一个时间串。
  expect(records).toHaveLength(3);
  for (const record of records) expect(Object.keys(record)).toEqual(FIELDS);
  expect(records.every((r) => r.updated_at === null)).toBe(true);
  const year = String(new Date().getFullYear());
  expect(
    records.filter(
      (r) => typeof r.updated_at === "string" && r.updated_at.includes(year),
    ),
  ).toEqual([]);
  expect(bytesA.toString("utf8")).toContain("updated_at: null");
  // (iii) 同一区间算两次：字节完全一致。幂等由代码形状保证，不靠上游恰好不产出记录。
  expect(bytesA.equals(bytesB)).toBe(true);
  // 失败原因点名写进 INFRA，下一次合并知道为什么清单里没有时间。
  expect(YAML.parse(readFileSync(infraPath, "utf8")).failures).toContainEqual({
    path: null,
    reason: "commit-date-unreadable",
  });
});

test("(c) 把产物喂两遍（模拟下一次合并重试）：按 path + sha256 去重后为零", () => {
  const { dir, base, tip } = mergedRange();
  const first = exportManifest(dir, { from: base, to: tip });
  expect(first.records).toHaveLength(3);

  const second = exportManifest(dir, {
    from: base,
    to: tip,
    extra: ["--existing", first.outPath],
  });

  expect(second.status).toBe(0);
  expect(second.records).toEqual([]);
  expect(second.stderr).toContain("duplicates=3");
  // 两份产物合起来仍无重复：幂等键是 path + sha256。
  const keys = [...first.records, ...second.records].map(
    (r) => r.path + "|" + r.sha256,
  );
  expect(new Set(keys).size).toBe(keys.length);
});

test("(c) 内容变了就是新记录：同路径不同 sha256 不会被去重掉", () => {
  const { dir, base, tip } = mergedRange();
  const first = exportManifest(dir, { from: base, to: tip });
  const next = commit(
    dir,
    { "docs/architecture.md": "arch v3\n" },
    { message: "m2" },
  );

  const second = exportManifest(dir, {
    from: tip,
    to: next,
    extra: ["--existing", first.outPath],
  });

  expect(second.records.map((r) => r.path)).toEqual(["docs/architecture.md"]);
  expect(second.records[0].sha256).toBe(sha256("arch v3\n"));
});

test("(d) .env / secrets / 构建产物即使出现在 diff 里也不进清单（反向用例）", () => {
  const dir = newRepo();
  const base = commit(
    dir,
    { "docs/architecture.md": "arch\n" },
    { message: "b" },
  );
  const tip = commit(
    dir,
    {
      ".env.local": "TOKEN=1\n",
      ".env.production": "TOKEN=2\n",
      ".agents/notes/implemented/leaked-credentials.md": "creds\n",
      "docs/postmortem/leaked-api-key.md": "key\n",
      "node_modules/pkg/README.md": "dep readme\n",
      "dist/README.md": "built readme\n",
      "coverage/README.md": "cov readme\n",
      "src/mod/README.md": "mod contract\n",
    },
    { message: "merge" },
  );

  const m = exportManifest(dir, { from: base, to: tip });

  // 正控：同一个 diff 里合法的模块 README 必须留下——否则「全被挡住」也能让本条变绿。
  expect(m.records.map((r) => r.path)).toEqual(["src/mod/README.md"]);
  for (const path of [
    ".env.local",
    ".env.production",
    ".agents/notes/implemented/leaked-credentials.md",
    "docs/postmortem/leaked-api-key.md",
    "node_modules/pkg/README.md",
    "dist/README.md",
    "coverage/README.md",
  ]) {
    expect(m.records.some((r) => r.path === path)).toBe(false);
  }
  // 挡住的原因要能读出来，不是静默丢。
  expect(m.stderr).toContain(
    "denied node_modules/pkg/README.md (build-artifact-dir:node_modules)",
  );
  expect(m.stderr).toContain("denied .env.local (secret-or-env:.env.local)");
  // 顺序钉住：这几个路径同时满足 allow 规则，只有 deny 先跑才挡得住。
  expect(isKbPath("node_modules/pkg/README.md")).toBe(true);
  expect(deniedReason("node_modules/pkg/README.md")).toBe(
    "build-artifact-dir:node_modules",
  );
});

test("(e) 汇入失败 = INFRA：退出 3、清单照样落盘、失败路径留给下次重试", () => {
  const dir = newRepo();
  const base = commit(
    dir,
    { "docs/architecture.md": "arch\n" },
    { message: "b" },
  );
  const tip = commit(
    dir,
    { "docs/permissions.md": "perm\n" },
    { message: "m" },
  );
  // 下次重试的快照已经不存在（路径在这次合并里被删了）：cat-file 拿不到 blob。
  sh(dir, ["rm", "-q", "docs/architecture.md"]);
  sh(dir, ["commit", "-q", "-m", "drop"], {
    GIT_AUTHOR_DATE: AT,
    GIT_COMMITTER_DATE: AT,
  });
  const dropped = sh(dir, ["rev-parse", "HEAD"]);
  const retryFile = join(dir, "prev-infra.yml");
  writeFileSync(
    retryFile,
    YAML.stringify({
      kind: "infra",
      retry_paths: ["docs/architecture.md"],
    }),
  );

  const m = exportManifest(dir, {
    from: base,
    to: dropped,
    extra: ["--retry", retryFile],
  });

  expect(m.status).toBe(3);
  expect(m.records.map((r) => r.path)).toEqual(["docs/permissions.md"]);
  expect(m.infra.kind).toBe("infra");
  expect(m.infra.retry_paths).toEqual(["docs/architecture.md"]);
  expect(m.infra.failures).toEqual([
    {
      path: "docs/architecture.md",
      reason: expect.stringContaining("blob-unreadable"),
    },
  ]);
});

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
  expect(exportStep.run).toContain("node scripts/kb-export.mjs");
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
  expect(byName("restore previous artifacts").run).toContain(
    "--name kb-manifest",
  );
  expect(byName("restore previous artifacts").run).toContain("--name kb-infra");
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
  // 沙箱里要有被调用的脚本与它的依赖：YAML 写的是仓库相对路径 scripts/kb-export.mjs。
  cpSync(join(ROOT, "scripts"), join(dir, "scripts"), { recursive: true });
  symlinkSync(join(ROOT, "node_modules"), join(dir, "node_modules"));
  const ctx = {
    "github.repository": repository,
    "github.ref_name": refName,
    "github.event.before": before,
    "github.event.after": after,
    "secrets.GITHUB_TOKEN": "stub-token",
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
