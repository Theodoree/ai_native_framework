import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ENGINE, ensureEngine } from "../helpers/engine.mjs";
import { checkFixture, checkGolden, envSignature, writeGolden, writeIndex } from "../helpers/parity-golden.mjs";
import { CONFIG_REL, repoRoot, suites } from "./parity-cases.mjs";

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

// A 的 consult 没有独立脚本：原测试是临时写一个探针再调 state-validate.mjs 的导出。
const CONSULT_PROBE_SOURCE = [
  "import { readFileSync } from 'node:fs';",
  "const mod = await import(process.argv[2]);",
  "const cfg = mod.loadConfig(process.argv[3]);",
  'const intent = JSON.parse(readFileSync(0, "utf8"));',
  "try {",
  "  const result = mod.consultTransition(cfg, intent);",
  "  console.log(JSON.stringify({ consult: true, from: result.from, to: result.to, by: result.by, flow: result.flow }));",
  "} catch (error) {",
  '  console.log(JSON.stringify({ consult: false, kind: error.kind ?? "infra", code: error.code ?? "E_CLI_FAILED", message: error.message, extra: error.extra ?? {} }));',
  '  process.exit(error.kind === "rejected" ? 1 : 3);',
  "}",
].join("\n");

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

const workDir = realpathSync(tmpdir());
const probePath = join(workDir, "engine-golden-consult-probe.mjs");
const validatorPath = join(SCRIPTS, "state-validate.mjs");

// Node 侧的命令行形状：脚本名就是命令。C 的 argv 里不含子命令，mapArgs 摘掉它。
function nodeInvoke(suite, fixture) {
  if (fixture.script === "@consult-probe")
    return { bin: process.execPath, prefix: [probePath, validatorPath, CONFIG_REL] };
  if (suite.id === "c")
    return { bin: process.execPath, prefix: [scriptOf("merge-gate.mjs")], mapArgs: (argv) => argv.slice(1) };
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

  ensureEngine();
  writeFileSync(probePath, CONSULT_PROBE_SOURCE);

  const indexFile = join(repoRoot, "tests", "goldens", "index.json");
  const previous = existsSync(indexFile) ? JSON.parse(readFileSync(indexFile, "utf8")).suites ?? {} : {};
  const entries = { ...previous };
  for (const suite of chosen) entries[suite.id] = { title: suite.title, count: 0, cases: [] };
  try {
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
  } finally {
    rmSync(probePath, { force: true });
  }
}

main().catch((error) => {
  console.error(String(error && error.stack ? error.stack : error));
  process.exit(1);
});
