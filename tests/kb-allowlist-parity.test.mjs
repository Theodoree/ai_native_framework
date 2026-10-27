import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// 「汇什么」在仓库里有两份实现：api-go 的 kb.go（HTTP 侧的汇入索引）与 engine 的
// kbexport.go（CI 侧算清单）。这个测试读这两份源码逐字比对，任何一处改了而别处没跟，
// 立刻红 —— 没有 Go 进程、不联网，不依赖任何 executable。
//
// 第三份真源 scripts/kb-export.mjs（JS 导出器）已在 E2 第四批随判据一起搬进
// apps/engine/kbexport.go 并删除，因此原先的 JS ↔ Go 两组比对、以及判定表里拿 JS 实现
// 当答案的那一路一并下线；判定表的期望值改为直接钉在表里。「拒绝原因怎么算」的行为判据
// 现在钉在 apps/engine/kbexport_test.go 的 TestKbExportDeniesSecretsAndBuildDirs
// （deny 目录 / deny 名字 / deny 先于 allow / denied 文案）。
//
// 归一（只此几条，其余一律算漂移）：
//   - Go 的 (?i) 行内标志剥成 flags 再比（两份 Go 实现写字方式不同）；
//   - 捕获组 (…) 与非捕获组 (?:…) 视为同一个规则：两个 Go 侧风格不同，
//     对 MatchString 的结论没有差别；
//   - 源码里的 \/ 与 / 归一（都是两个字符，剥掉转义后按正则原文比）。
// 不算差异的：清单顺序（两者顺序各不相同，比的是集合）、注释、变量名。
const KB_GO = readFileSync(fileURLToPath(new URL("../apps/api-go/kb.go", import.meta.url)), "utf8");
const ENGINE_GO = readFileSync(
  fileURLToPath(new URL("../apps/engine/kbexport.go", import.meta.url)),
  "utf8",
);

const GO_ANCHORS = {
  allow: ["var kbAllowRules", "// group 的固定顺序"],
  denyDirs: ["var kbDenyDirs", "var kbSkipDirs"],
  denyNames: ["var kbDenyNames", "var kbGroupRank"],
};

// 引擎侧的真源在 kbexport.go，变量名不同（kbAllowed / kbDenyDirs / kbDenyNames），
// 且正则用双引号串而不是反引号串 —— 抽取器两种都要认。
const ENGINE_ANCHORS = {
  allow: ["var kbAllowed = []*regexp.Regexp{", "// kbDenyDirs"],
  denyDirs: ["var kbDenyDirs = map[string]bool{", "// kbDenyNames"],
  denyNames: ["var kbDenyNames = []*regexp.Regexp{", "var kbShaPattern"],
};

function region(text, label, [startAnchor, endAnchor]) {
  const start = text.indexOf(startAnchor);
  const end = text.indexOf(endAnchor);
  if (start < 0 || end < 0 || end <= start) {
    throw new Error(
      `${label} 里找不到锚点：${startAnchor} → ${endAnchor}（抽取失败必须中断，不能退化成空集合）`,
    );
  }
  return text.slice(start, end);
}

// Go 侧的正则字面量两种写法都要认：kb.go 用反引号原始串，kbexport.go 用双引号串。
// 双引号串按 Go 的转义还原（这两张表里只有反斜杠转义）；出现本测试不认识的转义就抛 ——
// 抽取失败必须中断，不能退化成「少比一条规则」。
const GO_RX_RAW = /regexp\.MustCompile\(`([^`]+)`\)/g;
const GO_RX_DOUBLE = /regexp\.MustCompile\("((?:[^"\\]|\\.)*)"\)/g;

function goUnquote(literal, label) {
  try {
    return JSON.parse('"' + literal + '"');
  } catch {
    throw new Error(`${label} 的正则字面量里有本测试不认识的转义：${literal}`);
  }
}

function goRegexLiteralsIn(text, label, anchorPair) {
  const body = region(text, label, anchorPair);
  const found = [];
  for (const match of body.matchAll(GO_RX_RAW)) found.push(match[1]);
  for (const match of body.matchAll(GO_RX_DOUBLE)) found.push(goUnquote(match[1], label));
  const declared = [...body.matchAll(/regexp\.MustCompile\(/g)].length;
  if (found.length === 0) {
    throw new Error(`${label} 的区间里没有 regexp.MustCompile 字面量：${anchorPair.join(" → ")}`);
  }
  if (found.length !== declared) {
    throw new Error(
      `${label} 的区间里有 ${declared} 个 regexp.MustCompile，只认出 ${found.length} 个 —— 抽取器没跟上写法`,
    );
  }
  return found;
}

function goDenyDirsIn(text, label, anchorPair) {
  const body = region(text, label, anchorPair);
  const found = [...body.matchAll(/^\s*"([^"]+)":\s*true,/gm)].map((match) => match[1]);
  if (found.length === 0) {
    throw new Error(`${label} 的 kbDenyDirs 区间里没有目录名：${anchorPair.join(" → ")}`);
  }
  return found;
}

function goDenyDirs() {
  return goDenyDirsIn(KB_GO, "apps/api-go/kb.go", GO_ANCHORS.denyDirs);
}

function engineDenyDirs() {
  return goDenyDirsIn(ENGINE_GO, "apps/engine/kbexport.go", ENGINE_ANCHORS.denyDirs);
}

// Go 的 (?i) 等行内标志抽成 flags 再从源码里剥掉：两份实现的写法不同，规则必须一样。
function normalizeGo(literal) {
  const flags = new Set();
  let source = literal;
  for (const match of literal.matchAll(/\(\?([a-zA-Z]+)\)/g)) {
    for (const flag of match[1]) flags.add(flag);
    source = source.split(match[0]).join("");
  }
  // 捕获组 (…) 与非捕获组 (?:…) 对 MatchString 的结论没有差别：
  // kb.go 写 (?:…) 而 kbexport.go 写 (…)，归一到同一条规则再比。
  source = source.split("(" + "?" + ":").join("(");
  return { source: source.split("\\/").join("/"), flags: [...flags].sort().join("") };
}

const canonical = (literal) => `/${literal.source}/${literal.flags}`;

const goAllowRules = () => goRegexLiteralsIn(KB_GO, "apps/api-go/kb.go", GO_ANCHORS.allow);
const goDenyNameRules = () => goRegexLiteralsIn(KB_GO, "apps/api-go/kb.go", GO_ANCHORS.denyNames);
// 引擎侧同三张表（apps/engine/kbexport.go）：变量名不同、正则写法不同，规则集必须一样。
const engineAllowRules = () =>
  goRegexLiteralsIn(ENGINE_GO, "apps/engine/kbexport.go", ENGINE_ANCHORS.allow);
const engineDenyNameRules = () =>
  goRegexLiteralsIn(ENGINE_GO, "apps/engine/kbexport.go", ENGINE_ANCHORS.denyNames);

const asRegexes = (literals) =>
  literals.map((literal) => {
    const normalized = normalizeGo(literal);
    return new RegExp(normalized.source, normalized.flags);
  });

// 与 kb.go 的 kbDeniedReason/kbGroupOf 同语义：先判目录与名字，再看白名单。
function goDeniedReason(target) {
  const segments = String(target).split("/");
  const name = segments[segments.length - 1];
  const denyDirs = new Set(goDenyDirs());
  const dir = segments.slice(0, -1).find((segment) => denyDirs.has(segment));
  if (dir) return `build-artifact-dir:${dir}`;
  const hit = asRegexes(goDenyNameRules()).find((re) => re.test(name));
  return hit ? `secret-or-env:${name}` : null;
}

function goAccepts(target) {
  if (goDeniedReason(target)) return false;
  return asRegexes(goAllowRules()).some((re) => re.test(target));
}

// 引擎侧（apps/engine/kbexport.go 的 KbDeniedReason/KbIsKbPath）同语义：先判 deny 再判 allow。
function engineDeniedReason(target) {
  const segments = String(target).split("/");
  const name = segments[segments.length - 1];
  const denyDirs = new Set(engineDenyDirs());
  const dir = segments.slice(0, -1).find((segment) => denyDirs.has(segment));
  if (dir) return `build-artifact-dir:${dir}`;
  const hit = asRegexes(engineDenyNameRules()).find((re) => re.test(name));
  return hit ? `secret-or-env:${name}` : null;
}

function engineAccepts(target) {
  if (engineDeniedReason(target)) return false;
  return asRegexes(engineAllowRules()).some((re) => re.test(target));
}

describe("知识库白名单：两处同口径（apps/api-go/kb.go ↔ apps/engine/kbexport.go）", () => {
  it("两边的白名单正则是同一个集合", () => {
    const asSet = (literals) => [...new Set(literals.map((literal) => canonical(normalizeGo(literal))))].sort();
    expect(asSet(engineAllowRules())).toEqual(asSet(goAllowRules()));
  });

  it("两边的 DENY_NAMES 正则是同一个集合", () => {
    const asSet = (literals) => [...new Set(literals.map((literal) => canonical(normalizeGo(literal))))].sort();
    expect(asSet(engineDenyNameRules())).toEqual(asSet(goDenyNameRules()));
  });

  it("两边的 DENY 目录是同一个目录集合", () => {
    expect([...new Set(engineDenyDirs())].sort()).toEqual([...new Set(goDenyDirs())].sort());
  });
});

describe("知识库白名单：判定表两边结论一致", () => {
  const TABLE = [
    [".agents/notes/implemented/a.md", true],
    [".agents/notes/implemented/nested/b.md", false],
    ["README.md", true],
    ["apps/api-go/README.md", true],
    ["docs/postmortem/README.md", true],
    ["docs/postmortem/p1.md", true],
    ["docs/architecture.md", true],
    ["docs/permissions.md", true],
    ["docs/audit-contract.md", true],
    ["docs/notes.md", false],
    ["node_modules/x/README.md", false],
    ["apps/api-go/dist/README.md", false],
    ["tmp/README.md", false],
    [".env", false],
    [".agents/notes/implemented/.env", false],
    ["id_rsa", false],
    [".agents/notes/implemented/id_ed25519", false],
    ["docs/postmortem/api-key.md", false],
    ["docs/postmortem/SECRET-decision.md", false],
    ["docs/postmortem/x.token", false],
    ["scripts/build-intent.mjs", false],
    ["random/whatever.txt", false],
  ];

  it.each(TABLE)("%s → 放行=%s", (target, expected) => {
    expect(goAccepts(target)).toBe(expected);
    expect(engineAccepts(target)).toBe(expected);
  });
});
