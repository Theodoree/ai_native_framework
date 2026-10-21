#!/usr/bin/env node
// kb-export.mjs · 从一次合并的 commit 区间算出「要汇入知识库的记录清单」
//
// 契约在 docs/knowledge-base.md：单向（平台 → 知识库）、按 commit 增量、
// 按 path + sha256 幂等、汇入失败不阻断合并。本脚本只产出清单：
// 不发网络请求，也不知道知识库地址（属凭据，不进仓库）。
//
// sha256 的输入是 **git blob 的字节**（`git cat-file blob <to>:<path>`），
// 不是工作区文件：同一个 commit 在任何机器、任何 checkout 状态都算出同一个值。
//
// 退出码：0 = 清单完整；2 = 用法错误；3 = INFRA（清单已尽力产出，
// 失败项写进 --infra-out；workflow 据此「记 INFRA 但不让 job 变红」）。

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import YAML from "yaml";

const USAGE = `kb-export — 从 commit 区间算出知识库汇入清单

用法：
  node scripts/kb-export.mjs --repo owner/name [--ref main] \\
    (--from <sha> --to <sha> | --range <from>..<to>) [选项]

选项：
  --repo <owner/name>    source_repo（缺省取 GITHUB_REPOSITORY）
  --ref <name>           source_ref（缺省 main）
  --cwd <dir>            跑 git 的仓库根（缺省当前目录）
  --updated-at <ISO8601> 覆盖 updated_at（缺省取 to 的 commit 时间，绝不取 now()）
  --existing <file>      上一次的清单：按 path + sha256 去重
  --retry <file>         上一次的 INFRA 记录：把其中失败的路径按当前快照重算
  --out <file>           清单落盘（缺省 stdout）
  --infra-out <file>     INFRA 记录落盘

退出码：0 完整 / 2 用法 / 3 INFRA
`;

const USAGE_ERROR = 2;
const INFRA = 3;
const MAX_BUFFER = 64 * 1024 * 1024;

function git(cwd, args, { raw = false } = {}) {
  return execFileSync("git", args, {
    cwd,
    maxBuffer: MAX_BUFFER,
    encoding: raw ? null : "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

// 汇什么：docs/knowledge-base.md 第二节那张表。
// 根目录与任意层级的 README.md 都放行——每个目录的 README 就是那个模块的契约，
// 例外（哪个不算模块）要由文档否决，不在这里猜。
const ALLOWED = [
  /^\.agents\/notes\/implemented\/[^/]+\.md$/,
  /(?:^|\/)README\.md$/,
  /^docs\/postmortem\/[^/]+\.md$/,
  /^docs\/(?:architecture|permissions|audit-contract)\.md$/,
];

const DENY_DIRS = new Set([
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".next",
  "out",
  "tmp",
  "vendor",
]);

// 词表与 .gitignore 的「密钥与本地配置 / 令牌与密钥」对齐：宁可少汇，不可泄漏。
const DENY_NAMES = [
  /^\.env(?:\.|$)/,
  /\.(?:pem|key|p12|pfx|jks|keystore)$/,
  /^id_(?:rsa|ed25519|ecdsa)/,
  /^\.(?:npmrc|netrc)$/,
  /secret/i,
  /credential/i,
  /api[_-]?key/i,
  /api[_-]?token/i,
  /authtoken/i,
  /\.token$/,
];

// 先判 deny 再判 allow：顺序反了，node_modules/x/README.md 会被「模块 README」放进来。
export function deniedReason(path) {
  const segments = String(path).split("/");
  const name = segments[segments.length - 1];
  const dir = segments.slice(0, -1).find((s) => DENY_DIRS.has(s));
  if (dir) return `build-artifact-dir:${dir}`;
  const hit = DENY_NAMES.find((re) => re.test(name));
  return hit ? `secret-or-env:${name}` : null;
}

export function isKbPath(path) {
  return ALLOWED.some((re) => re.test(path));
}

export function sha256Hex(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

// 幂等键就是契约说的那条：path + sha256。两个字段用 NUL 拼接，避免路径里带分隔符时串味。
export function recordKey(record) {
  return `${record.path}\u0000${record.sha256}`;
}

function oneLine(error) {
  const raw = (error && (error.stderr || error.message)) || String(error);
  return String(raw).trim().split("\n")[0];
}

// A 新增 / M 修改才算「这次合并要让知识库跟上」；删除不进清单（库里不做编辑，删除由库侧清理）。
function listChanged(cwd, from, to) {
  const out = git(cwd, [
    "diff",
    "--name-only",
    "--no-renames",
    "--diff-filter=AM",
    from,
    to,
  ]);
  return out
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
}

// 区间内最后一次改到这个路径的 commit：按它复算 `git show <commit>:<path>` 得到的字节，
// 与 <to>:<path> 一致（之后再没人改过它）。不在区间里的重试路径退回 to。
function lastCommit(cwd, from, to, path) {
  try {
    const sha = git(cwd, [
      "log",
      "-1",
      "--format=%H",
      `${from}..${to}`,
      "--",
      path,
    ]).trim();
    return /^[0-9a-f]{40}$/.test(sha) ? sha : to;
  } catch {
    return to;
  }
}

function commitDate(cwd, to) {
  try {
    return git(cwd, ["show", "-s", "--format=%cI", to]).trim() || null;
  } catch {
    return null;
  }
}

export function buildManifest({
  cwd,
  repo,
  ref,
  from,
  to,
  updatedAt,
  existing = [],
  retryPaths = [],
}) {
  const failures = [];
  const denied = [];
  const records = [];
  const seen = new Set(existing.map(recordKey));
  let duplicates = 0;

  const candidates = new Set(retryPaths);
  try {
    for (const path of listChanged(cwd, from, to)) candidates.add(path);
  } catch (e) {
    failures.push({ path: null, reason: `diff-failed: ${oneLine(e)}` });
  }

  for (const path of [...candidates].sort()) {
    const why = deniedReason(path);
    if (why) {
      denied.push({ path, reason: why });
      continue;
    }
    if (!isKbPath(path)) continue;

    let bytes;
    try {
      bytes = git(cwd, ["cat-file", "blob", `${to}:${path}`], { raw: true });
    } catch (e) {
      failures.push({ path, reason: `blob-unreadable: ${oneLine(e)}` });
      continue;
    }

    const record = {
      source_repo: repo,
      source_ref: ref,
      commit: lastCommit(cwd, from, to, path),
      path,
      sha256: sha256Hex(bytes),
      updated_at: updatedAt,
    };
    if (seen.has(recordKey(record))) {
      duplicates += 1;
      continue;
    }
    seen.add(recordKey(record));
    records.push(record);
  }

  return { records, denied, duplicates, failures };
}

export function renderManifest(records, { repo, ref, from, to }) {
  const header =
    `# 知识库汇入清单 · source_repo=${repo} source_ref=${ref} range=${from}..${to}\n` +
    "# 每条固定头见 docs/knowledge-base.md；sha256 取 git blob（commit 内的内容字节），不是工作区。\n";
  const body =
    records.length === 0 ? "[]\n" : YAML.stringify(records, { lineWidth: 0 });
  return header + body;
}

export function renderInfra({ repo, ref, from, to, failures }) {
  return YAML.stringify(
    {
      kind: failures.length === 0 ? "ok" : "infra",
      source_repo: repo,
      source_ref: ref,
      range: `${from}..${to}`,
      // 下次合并按这些路径重算「当前快照」：失败的文件多半不在下一次 diff 里。
      retry_paths: [
        ...new Set(failures.map((f) => f.path).filter(Boolean)),
      ].sort(),
      failures: failures.map((f) => ({
        path: f.path ?? null,
        reason: f.reason,
      })),
    },
    { lineWidth: 0 },
  );
}

function loadExisting(file, warn) {
  if (!file) return { records: [], failures: [] };
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch (e) {
    if (e.code === "ENOENT") {
      warn(`--existing 不在（首次汇入）：按空清单去重 ${file}`);
      return { records: [], failures: [] };
    }
    return {
      records: [],
      failures: [{ path: null, reason: `existing-unreadable: ${oneLine(e)}` }],
    };
  }
  try {
    const parsed = YAML.parse(text);
    if (parsed == null) return { records: [], failures: [] };
    if (!Array.isArray(parsed))
      return {
        records: [],
        failures: [{ path: null, reason: "existing-not-a-sequence" }],
      };
    const records = parsed.filter(
      (r) => r && typeof r.path === "string" && typeof r.sha256 === "string",
    );
    if (records.length !== parsed.length)
      warn(
        `--existing 有 ${parsed.length - records.length} 条缺 path/sha256，已忽略`,
      );
    return { records, failures: [] };
  } catch (e) {
    return {
      records: [],
      failures: [{ path: null, reason: `existing-unparseable: ${oneLine(e)}` }],
    };
  }
}

function loadRetry(file, warn) {
  if (!file) return [];
  let doc;
  try {
    doc = YAML.parse(readFileSync(file, "utf8"));
  } catch (e) {
    if (e.code !== "ENOENT") warn(`--retry 读不动，按空集重试: ${oneLine(e)}`);
    return [];
  }
  const listed = Array.isArray(doc?.retry_paths)
    ? doc.retry_paths
    : (doc?.failures ?? []).map((f) => f?.path);
  return listed.filter((p) => typeof p === "string" && p.length > 0);
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) throw new Error(`多余的参数: ${arg}`);
    const key = arg.slice(2);
    if (key === "help") {
      out.help = true;
      continue;
    }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--"))
      throw new Error(`--${key} 缺值`);
    out[key] = value;
    i += 1;
  }
  return out;
}

function resolveRange(args) {
  if (args.range) {
    const m = /^(.+?)\.\.(.+)$/.exec(args.range);
    if (!m) throw new Error(`--range 要写成 A..B，收到 ${args.range}`);
    return { from: m[1], to: m[2] };
  }
  if (!args.from || !args.to)
    throw new Error("缺区间：--from A --to B 或 --range A..B");
  return { from: args.from, to: args.to };
}

function writeOut(target, text) {
  if (!target) {
    process.stdout.write(text);
    return;
  }
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, text);
}

function main() {
  const warn = (msg) => process.stderr.write(`kb-export: ${msg}\n`);

  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    process.stderr.write(`kb-export: ${e.message}\n`);
    return USAGE_ERROR;
  }
  if (args.help) {
    process.stdout.write(USAGE);
    return 0;
  }

  const cwd = args.cwd ?? process.cwd();
  const repo = args.repo ?? process.env.GITHUB_REPOSITORY ?? "";
  const ref = args.ref ?? "main";
  if (!repo) {
    process.stderr.write(
      "kb-export: 缺 source_repo：给 --repo 或设 GITHUB_REPOSITORY\n",
    );
    return USAGE_ERROR;
  }
  let from;
  let to;
  try {
    ({ from, to } = resolveRange(args));
  } catch (e) {
    process.stderr.write(`kb-export: ${e.message}\n`);
    return USAGE_ERROR;
  }

  const existing = loadExisting(args.existing, warn);
  const retryPaths = loadRetry(args.retry, warn);

  const failures = [...existing.failures];
  // updated_at 只认注入值与 commit 时间：now() 会让「同一区间算两次」不一致。
  // 两者都取不到就写 null（六字段结构不变）：幂等由这里的不回退保证，
  // 不靠「上游恰好不产出任何记录」兜着。
  const committedAt = commitDate(cwd, to);
  const updatedAt = args["updated-at"] ?? committedAt ?? null;
  if (!args["updated-at"] && !committedAt)
    failures.push({ path: null, reason: "commit-date-unreadable" });

  const built = buildManifest({
    cwd,
    repo,
    ref,
    from,
    to,
    updatedAt,
    existing: existing.records,
    retryPaths,
  });
  failures.push(...built.failures);

  for (const d of built.denied) warn(`denied ${d.path} (${d.reason})`);

  writeOut(args.out, renderManifest(built.records, { repo, ref, from, to }));
  if (args["infra-out"])
    writeOut(args["infra-out"], renderInfra({ repo, ref, from, to, failures }));

  warn(
    `included=${built.records.length} duplicates=${built.duplicates} ` +
      `denied=${built.denied.length} infra=${failures.length}`,
  );
  return failures.length > 0 ? INFRA : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  process.exitCode = main();
