import { execFileSync } from "node:child_process";
import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";

// 引擎构建只有一个入口（npm run build:engine），CI 与测试共用它：
// 两边各写一份构建命令，就会有一边悄悄偏离 check:engine 的口径。
// 产物是 .cache/bin/engine（.cache/ 已忽略，不进仓库）。

const ROOT = process.cwd();
const SRC = join(ROOT, "apps", "engine");
const BIN_DIR = join(ROOT, ".cache", "bin");
const LOCK = join(BIN_DIR, "engine.lock");
export const ENGINE = join(BIN_DIR, "engine");

const isSource = (path) =>
  path.endsWith(".go") || path.endsWith("go.mod") || path.endsWith("go.sum");

function sources(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sources(path));
    else if (isSource(path)) out.push(path);
  }
  return out;
}

// 新鲜 = 二进制存在且不旧于任何源文件：改了一行 Go 却跑旧二进制，测试会绿得没道理。
function fresh() {
  if (!existsSync(ENGINE)) return false;
  const built = statSync(ENGINE).mtimeMs;
  return sources(SRC).every((path) => statSync(path).mtimeMs <= built);
}

function build() {
  try {
    execFileSync("npm", ["run", "--silent", "build:engine"], {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    throw new Error(
      "引擎没构建：`npm run build:engine` 失败。被测的接线是 Go 引擎，" +
        "没有二进制就没有接线可测（不是跳过，是红）：\n" +
        String(err.stdout ?? "") +
        String(err.stderr ?? ""),
    );
  }
  if (!existsSync(ENGINE))
    throw new Error(
      "引擎没构建：`npm run build:engine` 退出 0 却没有产物 " + ENGINE,
    );
}

// 同一台机器上多个测试进程会同时要二进制：让一个建，其余等它建完。
// 各自 go build 同一路径会互相覆盖出半个可执行文件，红得莫名其妙。
export function ensureEngine() {
  if (fresh()) return ENGINE;
  mkdirSync(BIN_DIR, { recursive: true });
  const deadline = Date.now() + 300_000;
  let held = false;
  while (!held) {
    try {
      closeSync(openSync(LOCK, "wx"));
      held = true;
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
      // 锁比五分钟还旧：建它的进程已经不在了，别等一个不会来的结果。
      if (Date.now() - statSync(LOCK).mtimeMs > 300_000) unlinkSync(LOCK);
      else if (Date.now() > deadline)
        throw new Error("等引擎构建锁超时：" + LOCK);
      else if (fresh()) return ENGINE;
      else Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
  }
  try {
    if (!fresh()) build();
  } finally {
    try {
      unlinkSync(LOCK);
    } catch {
      // 别人已经收走锁，不影响结论。
    }
  }
  return ENGINE;
}

// 沙箱里用**复制**而不是指绝对路径：CI 里调的正是 cwd 相对的 ./.cache/bin/engine，
// 换成绝对路径，写错的相对路径也会绿 —— 那测的就不是同一条接线了。
export function engineInto(dir) {
  ensureEngine();
  mkdirSync(join(dir, ".cache", "bin"), { recursive: true });
  const path = join(dir, ".cache", "bin", "engine");
  copyFileSync(ENGINE, path);
  chmodSync(path, 0o755);
  return path;
}
