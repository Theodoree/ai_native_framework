import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ENGINE, ensureEngine } from "../helpers/engine.mjs";
import { checkFixture, checkGolden, envSignature, writeGolden, writeIndex } from "../helpers/parity-golden.mjs";
import { repoRoot, suites } from "./parity-cases.mjs";

// 冻结入口（显式命令，默认测试路径永远走不到这里）：
//   node tests/goldens/freeze.mjs           全量
//   node tests/goldens/freeze.mjs c e       只重冻指定 suite
//
// 这是全仓唯一还知道 scripts/*.mjs 在哪的地方 —— 也是它必须显式的原因：
// 期望值一旦入库就是真值，会不会重冻必须由人决定。
//
// 每一次冻结在**同一次运行**里完成两件事：
//   1. 跑 Node 侧（scripts/*.mjs），把它的输出写成 golden；
//   2. 用同一批夹具跑 Go 侧（.cache/bin/engine），与刚写下的 golden 逐字节比。
// 第 2 步不绿就整体失败：冻结出来的参照物必须是被测实现当时就对得上的那一份。

const SCRIPTS = join(repoRoot, "scripts");
const scriptOf = (name) => join(SCRIPTS, name);

// A 套的 consult 过去没有独立脚本：靠临时探针调 state-validate.mjs 的导出录制。
// P-31 阶段 D2 把该脚本删了，探针也随之消失 —— A 套因此不再可重冻，
// 判定落在 missingReferences 里 "@consult-probe" → state-validate.mjs 的映射上。

// 宿主机器的指纹（PATH / HOME / tmpdir）不能进 golden：它是期望值，必须与 checkout 位置、
// 谁的机器无关。env 只按 key 集合参与比较，值在这里换成稳定的占位符。
const MACHINE_MARKERS = [
  [process.env.PATH, "<PATH>"],
  [process.env.HOME, "<HOME>"],
  [realpathSync(tmpdir()), "<TMP>"],
  [tmpdir(), "<TMP>"],
].filter(([value]) => typeof value === "string" && value.length > 1);

function sanitizeEnv(env) {
  const out = {};
  for (const [key, value] of Object.entries(env ?? {})) {
    let text = String(value);
    for (const [marker, label] of MACHINE_MARKERS) text = text.split(marker).join(label);
    out[key] = text;
  }
  return out;
}

// Node 侧的命令行形状：脚本名就是命令。
// suite a（state-validate）与 suite c（merge-gate）的参照物已在 P-31 阶段 D2 删除：
// 它们没有 Node 侧可重跑的来源，assertRefreezePossible 会在任何写入之前中止 ——
// 这里的 nodeInvoke 不再为它们保留分支，免得多出一条「还能跑」的假象。
function nodeInvoke(suite, fixture) {
  if (suite.id === "e")
    return {
      bin: process.execPath,
      // copy-dist 原来跑的是沙箱里的副本：脚本按 cwd 找 dist，跑仓库里那份等于让 Node 侧写进真仓库。
      prefix: (dir) => [fixture.sandboxScript ? join(dir, "scripts", fixture.script) : scriptOf(fixture.script)],
      prepareRun: (dir) => {
        if (!fixture.sandboxScript) return;
        mkdirSync(join(dir, "scripts"), { recursive: true });
        copyFileSync(scriptOf(fixture.script), join(dir, "scripts", fixture.script));
      },
    };
  return { bin: process.execPath, prefix: [scriptOf(fixture.script)] };
}

// 参照物（scripts/*.mjs）被删掉的模块不再可重冻：冻结要先跑 Node 侧把它的输出写成 golden，
// 没有脚本就没有「旧实现重算一遍」这条来源。名单不写死 —— 按 scripts/ 里文件是否存在判定，
// 免得清单和磁盘各说一套。命中就中止，且在任何写入之前中止：半冻一半的索引比不冻更糟。
// 目前已有实例：scripts/writer-record.mjs 随 P-31 收尾删除，suite b 的 13 条 writer-record 夹具
// 因此不可重冻（判据已等价搬进 apps/engine/writer_test.go，golden 不动）。
// 参照物名：夹具的 script 字段就是 scripts/ 下的文件名，两处例外都在 suite 级：
//   · A 套的 consult 探针（script = "@consult-probe"）没有独立脚本，过去靠临时探针调 state-validate.mjs；
//   · C 套（merge-gate）的夹具不带 script 字段 —— 它的 Node 侧命令行形状由 nodeInvoke 单独拼。
// P-31 阶段 D2 把这几套的载体都删了，映射留着是为了让中止信息点到名，而不是漏成「没有参照物」：
// 夹具自带 script 时就按夹具走，只有 C 套（以及将来任何不带 script 的夹具）靠这张表兜底。
const SUITE_SCRIPT = {
  a: "state-validate.mjs",
  b: "build-intent.mjs",
  c: "merge-gate.mjs",
};
const referenceOf = (suite, fixture) => {
  if (fixture.script === "@consult-probe") return "state-validate.mjs";
  return fixture.script ?? SUITE_SCRIPT[suite.id];
};

function missingReferences(chosen) {
  const found = [];
  for (const suite of chosen) {
    for (const fixture of suite.cases) {
      const script = referenceOf(suite, fixture);
      if (!script) continue;
      if (!existsSync(scriptOf(script))) found.push({ suite, fixture, script });
    }
  }
  return found;
}

function assertRefreezePossible(chosen) {
  const missing = missingReferences(chosen);
  if (!missing.length) return;
  const byScript = new Map();
  for (const { suite, fixture, script } of missing) {
    if (!byScript.has(script)) byScript.set(script, []);
    byScript.get(script).push({ suite, fixture });
  }
  const lines = ["冻结中止：参照物已删除，这些夹具没有可重冻的来源。", ""];
  for (const [script, items] of byScript) {
    lines.push("  scripts/" + script + " 不存在 —— " + items.length + " 条夹具已不再可重冻：");
    for (const { suite, fixture } of items) lines.push("    - suite " + suite.id + " · " + fixture.id + " " + fixture.title);
    lines.push("");
  }
  lines.push("为什么：该模块已迁进 Go（apps/engine/），迁移前的 Node 实现被删除；见 tests/goldens/parity-cases.mjs 里对应 suite 的说明。");
  lines.push("这不影响默认测试路径：tests/engine-parity*.test.mjs 只跑 Go 引擎，与已入库的 golden 逐字节比，参照物不存在也能过。");
  lines.push("要重冻这些夹具，先把被删的 scripts/*.mjs 参照物恢复回来。");
  throw new Error(lines.join("\n"));
}

function patternOf(pattern) {
  const out = { exit: pattern.exit, stdout: pattern.stdout };
  if (pattern.stderrPrefix !== undefined) out.stderrPrefix = pattern.stderrPrefix;
  if (pattern.stderrMatch !== undefined) out.stderrMatch = pattern.stderrMatch;
  return out;
}

function buildGolden(suite, fixture, actual) {
  const golden = {
    // 来源：这一份期望值是 2024 年入库那天从 Node 侧的真实输出里冻下来的。
    suite: suite.id,
    id: fixture.id,
    title: fixture.title,
    argv: actual.argv,
    env: sanitizeEnv(actual.env),
    envSig: envSignature(sanitizeEnv(actual.env)),
    assertMode: fixture.assertMode ?? "bytes",
    exitCode: actual.exitCode,
    stdout: actual.stdout,
    stderr: actual.stderr,
    files: actual.files,
    requests: actual.requests,
  };
  if (fixture.assertMode === "contract") {
    const parsed = JSON.parse(actual.stdout);
    golden.contract = {
      exit: fixture.contract.exit,
      json: Object.fromEntries(fixture.contract.fields.map((key) => [key, parsed[key]])),
      ...(fixture.contract.messagePrefix === undefined ? {} : { messagePrefix: fixture.contract.messagePrefix }),
    };
  }
  if (fixture.assertMode === "pattern") golden.pattern = patternOf(fixture.pattern);
  return golden;
}

function nodeSelfCheck(fixture, actual) {
  // goStderrContains 是 Go 侧的断言：Node 的解析器文案不同，不能拿它检定参照物。
  const failures = checkFixture({ ...fixture, goStderrContains: [] }, actual);
  // 「已登记例外」里 Node 独有的那条：确认参照物真的是它声称的抛异常分支。
  const want = fixture.pattern?.nodeStderrContains;
  if (want !== undefined && !String(actual.stderr).includes(want))
    failures.push("Node 侧 stderr 不含 " + JSON.stringify(want) + "（夹具没打中它声称的分支）");
  return failures;
}

async function freezeSuite(suite) {
  const ctx = await suite.createContext();
  const ids = [];
  try {
    for (const fixture of suite.cases) {
      const nodeActual = await suite.run(ctx, fixture, nodeInvoke(suite, fixture));
      const nodeProblems = nodeSelfCheck(fixture, nodeActual);
      if (nodeProblems.length)
        throw new Error("冻结失败（Node 侧）：" + fixture.id + " " + fixture.title + "\n  - " + nodeProblems.join("\n  - "));

      const golden = buildGolden(suite, fixture, nodeActual);
      writeGolden(golden);
      ids.push(fixture.id);

      const goActual = await suite.run(ctx, fixture, { bin: ENGINE, prefix: [fixture.cmd ?? suite.cmd] });
      const goProblems = [...checkFixture(fixture, goActual), ...checkGolden(golden, goActual)];
      if (goProblems.length)
        throw new Error(
          "冻结失败（Go 侧与刚冻下的 golden 不一致）：" + fixture.id + " " + fixture.title + "\n  - " + goProblems.join("\n  - "),
        );
      process.stdout.write(".");
    }
    process.stdout.write(" " + suite.id + " " + ids.length + " 条\n");
  } finally {
    await suite.disposeContext(ctx);
  }
  return ids;
}

async function main() {
  if (!existsSync(join(repoRoot, "tests", "goldens", "freeze.mjs")))
    throw new Error("请在仓库根目录运行：node tests/goldens/freeze.mjs");
  const wanted = process.argv.slice(2);
  const chosen = wanted.length ? wanted.map((id) => {
    const suite = suites[id];
    if (!suite) throw new Error("没有这个 suite：" + id);
    return suite;
  }) : Object.values(suites);

  assertRefreezePossible(chosen);
  ensureEngine();

  const indexFile = join(repoRoot, "tests", "goldens", "index.json");
  const previous = existsSync(indexFile) ? JSON.parse(readFileSync(indexFile, "utf8")).suites ?? {} : {};
  const entries = { ...previous };
  for (const suite of chosen) entries[suite.id] = { title: suite.title, count: 0, cases: [] };
  let total = 0;
  for (const suite of chosen) {
    const ids = await freezeSuite(suite);
    entries[suite.id] = { title: suite.title, count: ids.length, cases: ids };
    total += ids.length;
  }
  const ordered = Object.fromEntries(Object.keys(suites).filter((id) => entries[id]).map((id) => [id, entries[id]]));
  const totalAll = Object.values(ordered).reduce((sum, one) => sum + one.count, 0);
  // 索引是受版本控制的数据：不写时间戳，重冻同一批 Node 输出必须是逐字节同样的一份。
  writeIndex({ source: "scripts/*.mjs 的旧输出（P-31 迁移前冻结）；本目录的 golden 即期望值", total: totalAll, suites: ordered });
  console.log("冻结完成：" + total + " 条（index 共 " + totalAll + " 条）");
}

main().catch((error) => {
  console.error(String(error && error.stack ? error.stack : error));
  process.exit(1);
});
