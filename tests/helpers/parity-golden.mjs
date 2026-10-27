import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";

// golden 的读写与比对。本文件不 import vitest：
// 测试（tests/engine-parity*.test.mjs）与冻结脚本（tests/goldens/freeze.mjs）共用它，
// 保证「冻结时怎么比」与「测试时怎么比」是同一份代码。

export const GOLDEN_ROOT = join(process.cwd(), "tests", "goldens");

export const goldenPath = (suite, id) => join(GOLDEN_ROOT, suite, id + ".json");
export const indexPath = () => join(GOLDEN_ROOT, "index.json");

export function readGolden(suite, id) {
  const path = goldenPath(suite, id);
  if (!existsSync(path))
    throw new Error(
      "golden 不存在：" + relative(process.cwd(), path) +
        " —— 期望值已冻结在 tests/goldens/，测试不会自己生成它；" +
        "确需重冻请显式运行 " + "`node tests/goldens/freeze.mjs`" + "。",
    );
  return JSON.parse(readFileSync(path, "utf8"));
}

export function writeGolden(golden) {
  const path = goldenPath(golden.suite, golden.id);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(golden, null, 2) + "\n");
  return path;
}

export function readIndex() {
  if (!existsSync(indexPath()))
    throw new Error("golden 索引不存在：" + relative(process.cwd(), indexPath()));
  return JSON.parse(readFileSync(indexPath(), "utf8"));
}

export function writeIndex(index) {
  writeFileSync(indexPath(), JSON.stringify(index, null, 2) + "\n");
  return indexPath();
}

// golden 是期望值：它必须跟 checkout 位置、跟谁的机器无关。这条是回归闸门 ——
// macOS 上 tmpdir 解析后是 /private/var/...，归一化只吃掉 /var/... 那一段，
// golden 里就会留下 "/private<ROOT>"，Linux CI 上同一条命令是 "<ROOT>"，必红。
export const MACHINE_PATH_PATTERNS = [
  { label: "/private 前缀", pattern: /\/private/ },
  { label: "/var/folders", pattern: /\/var\/folders\// },
  { label: "/Users/", pattern: /\/Users\// },
  { label: "/home/", pattern: /\/home\// },
  { label: "/tmp/", pattern: /\/tmp\// },
  { label: "Windows 用户目录", pattern: /[A-Za-z]:\\+Users\\+/ },
];

export function scanGoldenHygiene(root = GOLDEN_ROOT) {
  const hits = [];
  const visit = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) {
        visit(full);
        continue;
      }
      if (!name.endsWith(".json")) continue;
      const text = readFileSync(full, "utf8");
      for (const { label, pattern } of MACHINE_PATH_PATTERNS) {
        const match = pattern.exec(text);
        if (!match) continue;
        const at = Math.max(0, match.index - 40);
        hits.push({
          file: relative(process.cwd(), full),
          label,
          snippet: text.slice(at, Math.min(text.length, match.index + 40)).replace(/\n/g, "⏎"),
        });
      }
    }
  };
  visit(root);
  return hits;
}

// env 归一后签名：只记本 case 显式追加的变量（不记整份 process.env，否则换台机器就变），
// key 排序 + 值里把沙箱路径换成 <ROOT>，签名取 sha256 前 12 位便于一眼看出漂移。
export function envSignature(env) {
  const text = Object.keys(env ?? {})
    .sort()
    .map((key) => key + "=" + String(env[key]))
    .join("\n");
  return { text, sig: createHash("sha256").update(text).digest("hex").slice(0, 12) };
}

// 文本原样存、二进制标 base64：golden 必须人可读，也必须逐字节可比。
export function encodeContent(buf) {
  const text = buf.toString("utf8");
  if (Buffer.from(text, "utf8").equals(buf)) return { text };
  return { base64: buf.toString("base64"), encoding: "base64" };
}

export const decodeContent = (entry) =>
  entry.base64 === undefined ? Buffer.from(entry.text, "utf8") : Buffer.from(entry.base64, "base64");

function firstDiff(want, got) {
  const a = String(want).split("\n");
  const b = String(got).split("\n");
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    if (a[i] !== b[i]) {
      return "第 " + (i + 1) + " 行起不同\n  期望: " + JSON.stringify(a[i] ?? "<无>") +
        "\n  实际: " + JSON.stringify(b[i] ?? "<无>");
    }
  }
  return "长度相同但内容不同（不应发生）";
}

// 返回失败说明数组：空数组 = 与 golden 逐字节一致。
export function checkGolden(golden, actual) {
  const failures = [];
  const mode = golden.assertMode ?? "bytes";

  if (mode === "bytes") {
    if (actual.exitCode !== golden.exitCode)
      failures.push("退出码：golden " + golden.exitCode + "，实际 " + actual.exitCode);
    if (actual.stdout !== golden.stdout)
      failures.push("stdout 与 golden 不同：" + firstDiff(golden.stdout, actual.stdout));
    if (actual.stderr !== golden.stderr)
      failures.push("stderr 与 golden 不同：" + firstDiff(golden.stderr, actual.stderr));
  } else if (mode === "contract") {
    // 解析器文案来自各自实现（js-yaml vs yaml.v3），逐字节无意义：
    // 钉住的是「同一份坏输入同样被拒、同一个错误码、同一段前缀、同一个退出码」。
    const c = golden.contract;
    if (actual.exitCode !== c.exit)
      failures.push("退出码：golden " + c.exit + "，实际 " + actual.exitCode);
    let parsed;
    try {
      parsed = JSON.parse(actual.stdout);
    } catch {
      failures.push("stdout 不是 JSON：" + JSON.stringify(actual.stdout.slice(0, 200)));
    }
    if (parsed) {
      for (const key of Object.keys(c.json))
        if (JSON.stringify(parsed[key]) !== JSON.stringify(c.json[key]))
          failures.push("字段 " + key + "：golden " + JSON.stringify(c.json[key]) + "，实际 " + JSON.stringify(parsed[key]));
      if (c.messagePrefix && !String(parsed.message ?? "").startsWith(c.messagePrefix))
        failures.push("message 前缀不是 " + JSON.stringify(c.messagePrefix) + "：" + JSON.stringify(String(parsed.message ?? "").slice(0, 120)));
    }
  } else if (mode === "pattern") {
    // 已登记例外：Node 抛未捕获异常打整段 stack trace / 临时文件名带 pid，逐字节无意义。
    const p = golden.pattern;
    if (actual.exitCode !== p.exit)
      failures.push("退出码：golden " + p.exit + "，实际 " + actual.exitCode);
    if (actual.stdout !== p.stdout)
      failures.push("stdout 应为 " + JSON.stringify(p.stdout) + "，实际 " + JSON.stringify(actual.stdout.slice(0, 200)));
    // 两种例外口径：stderrPrefix（前缀固定、尾部随运行时变）与 stderrMatch（整段文案随运行时变，只钉关键词）。
    if (p.stderrPrefix !== undefined && !actual.stderr.startsWith(p.stderrPrefix))
      failures.push("stderr 不是以 " + JSON.stringify(p.stderrPrefix) + " 开头：" + JSON.stringify(actual.stderr.slice(0, 200)));
    if (p.stderrMatch !== undefined && !actual.stderr.includes(p.stderrMatch))
      failures.push("stderr 不含 " + JSON.stringify(p.stderrMatch) + "：" + JSON.stringify(actual.stderr.slice(0, 200)));
  } else {
    failures.push("未知 assertMode：" + mode);
  }

  const want = golden.files ?? [];
  const got = actual.files ?? [];
  const wantPaths = want.map((one) => one.path);
  const gotPaths = got.map((one) => one.path);
  if (wantPaths.join("\n") !== gotPaths.join("\n"))
    failures.push("写出的文件清单不同：golden [" + wantPaths.join(", ") + "]，实际 [" + gotPaths.join(", ") + "]");
  else
    for (const entry of want) {
      const other = got[wantPaths.indexOf(entry.path)];
      if (JSON.stringify(entry) !== JSON.stringify(other))
        failures.push("文件内容不同：" + entry.path);
    }

  const wantBodies = JSON.stringify(golden.requests ?? []);
  const gotBodies = JSON.stringify(actual.requests ?? []);
  if (wantBodies !== gotBodies)
    failures.push("打到上游的请求不同：" + firstDiff(wantBodies, gotBodies));

  return failures;
}

// 夹具自己声明的期望（「这条 case 真的打中了它声称的分支」）。
// 冻结时对 Node 侧跑一遍（确认参照物真的是这个结论），测试时对 Go 侧跑一遍（强度不低于改前）。
export function checkFixture(fixture, actual) {
  const failures = [];
  const out = String(actual.stdout ?? "");
  // 归一化会摘掉解析器的坐标后缀，而 goStderrContains 钉的正是它：优先用未归一的 stderr。
  const err = String(actual.rawStderr ?? actual.stderr ?? "");
  if (fixture.expectExit !== undefined && actual.exitCode !== fixture.expectExit)
    failures.push("退出码应为 " + fixture.expectExit + "，实际 " + actual.exitCode);
  const wants = [fixture.code, ...(fixture.alsoCodes ?? [])].filter((one) => one !== undefined && one !== "");
  for (const want of wants) if (!out.includes(want)) failures.push("stdout 不含 " + JSON.stringify(want));
  for (const want of fixture.stdoutContains ?? []) if (!out.includes(want)) failures.push("stdout 不含 " + JSON.stringify(want));
  for (const bad of fixture.stdoutExcludes ?? []) if (out.includes(bad)) failures.push("stdout 不应含 " + JSON.stringify(bad));
  for (const want of fixture.goStderrContains ?? []) if (!err.includes(want)) failures.push("stderr 不含 " + JSON.stringify(want));
  const files = new Map((actual.files ?? []).map((one) => [one.path, one.text]));
  for (const [path, want] of Object.entries(fixture.expectFiles ?? {})) {
    if (!files.has(path)) {
      failures.push("没有写出 " + path);
      continue;
    }
    if (want !== undefined && files.get(path) !== want)
      failures.push(path + " 内容应为 " + JSON.stringify(want) + "，实际 " + JSON.stringify(files.get(path)));
  }
  return failures;
}