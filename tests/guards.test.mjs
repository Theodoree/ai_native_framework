import { test, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { extname, join, resolve } from "node:path";

// 这个文件只剩「源码形状」类判据 —— 它们证明「静态上也没有第二条路」，
// 行为判据证不了这一点，所以留在这里（Go 侧同样没有等价物，门现在唯一的家是 apps/engine/mergegate.go）。
//
// 原来 :75-:252 那 15 条钉 scripts/state-validate.mjs 守卫判据的用例已搬进
// apps/engine/guards_validator_test.go（引擎才是 CI 真正跑的那条路），逐条对应见
// /tmp/p31d2e-t18-report.md；Node 侧因此不再 import scripts/state-validate.mjs。

// ---- 形状判据：门的实现只经咨询入口问状态 ----------------
// 行为那一半（同一个 intent：咨询入口放行、写入口 reject E_GUARD_MISSING；
// 未声明的开关不改结论）已经搬进 apps/engine/mergegate_cli_test.go，
// 因为引擎才是 CI 真正跑的那条路，判据该长在实现上。
// 留下这一条是因为它没有行为等价物：行为只能证明「这一次走的是咨询入口」，
// 证不了「静态上也没有第二条路」—— 所以这里改读 Go 实现（门现在唯一的家），
// 而不是过渡期的 scripts/merge-gate.mjs。
const ROOT = resolve(import.meta.dirname, "..");
const GATE_SOURCE = readFileSync(join(ROOT, "apps/engine/mergegate.go"), "utf8");
const WRITE_ENTRY = "Validate" + "Intent";
const SKIP_PARAMS = ["require", "skip", "bypass"].map((p) => p + "Guards");

test("门的实现只通过咨询入口问状态：调用点集合恰好 {ConsultTransition}", () => {
  expect(GATE_SOURCE).not.toContain(WRITE_ENTRY);
  // 调用点集合恰好是 {ConsultTransition}：多出任何第二个入口都要人重新想一遍。
  const calls = [
    ...GATE_SOURCE.matchAll(/\b([Cc]onsult[A-Z]\w*|[Vv]alidate[A-Z]\w*)\s*\(/g),
  ].map((m) => m[1]);
  expect([...new Set(calls)]).toEqual(["ConsultTransition"]);
  // 「跳过守卫」的参数名不在这里单独查：全仓零命中那条（下面）已经覆盖 .go。
});

// 「跳过参数」只可能以参数形式出现在可执行载体里；.md 是可引用的历史（决策记录会写
// 「放弃了一个叫某名的开关」），把它算进命中会让笔记没法写清被否掉的方案。
const CODE_EXT = new Set([
  ".mjs",
  ".cjs",
  ".js",
  ".ts",
  ".vue",
  ".go",
  ".yml",
  ".yaml",
  ".json",
]);

// 扫描面 = 「会被提交的文件」（git ls-files --cached --others --exclude-standard），
// 不是磁盘上的全部文件。
// 「为什么」：这条断言说的是「仓库源码里没有这个词」，而运行态目录（.agent-teams/
// 下由 AgentTeams 运行时写出的 team.json，见 .gitignore:50）的内容会随任务描述、
// 谁在跑、跑到哪一步变化 —— 把它扫进来，判据就被本地可变、不受版本控制的文件
// 左右：同一个人不同时刻跑出不同结果，别人 clone 下来又是第三种结果。
// t20 那条假红就是这么来的：三条命中全在 .agent-teams/p31-d2-parallel/team.json。
// 走 git 的好处是「排除」由 .gitignore 定义，不再靠一份手写的跳过目录名单 ——
// node_modules/、.cache/、coverage/、dist/、.agent-teams/ 一律命中 ignore。
// --others 是为了不留覆盖缺口：队友刚写好、还没 git add 的新文件也是要被提交的源码；
// 只取 --cached 会让这类文件「旧 walk 扫得到、新实现扫不到」。
function versionedFiles() {
  // 不经过 shell；用 -z 分隔，路径里有空格或非 ASCII 也不会被拆错。
  const out = execFileSync(
    "git",
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    { cwd: ROOT, encoding: "utf8" },
  );
  return (
    out
      .split("\0")
      .filter((path) => path !== "")
      // 索引里可能还留着「已删除但未提交」的路径（工作树里没有这个文件），
      // 它没有内容可扫；跳过它是为了跟上工作树的真实状态，不是放宽判据。
      .filter((path) => existsSync(join(ROOT, path)))
  );
}

test("全仓没有「跳过守卫」的参数名：requireGuards / skipGuards / bypassGuards 零命中", () => {
  const self = import.meta.filename;
  const hits = [];
  const scanned = versionedFiles()
    .map((path) => join(ROOT, path))
    .filter((file) => file !== self && CODE_EXT.has(extname(file)));
  // 扫到的文件太少说明过滤器本身坏了（ROOT 变了、扩展名列错了、git 返回了空列表），
  // 那会让这条断言在「零命中」的假象下永远绿。
  expect(scanned.length).toBeGreaterThan(50);
  for (const file of scanned) {
    const text = readFileSync(file, "utf8");
    for (const name of SKIP_PARAMS) if (text.includes(name)) hits.push(`${file}: ${name}`);
  }
  expect(hits).toEqual([]);
});
