import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { deniedReason, isKbPath } from "../scripts/kb-export.mjs";

// 「汇什么」在仓库里只能有一个家：导出器的 ALLOWED/DENY_* 是真源，Go 侧 kb.go 是第二份实现。
// 这个测试读两份源码逐字比对，任何一边改了而另一边没跟，立刻红 —— 没有 Go 进程、不联网。
const KB_GO = readFileSync(fileURLToPath(new URL("../apps/api-go/kb.go", import.meta.url)), "utf8");
const KB_EXPORT = readFileSync(
  fileURLToPath(new URL("../scripts/kb-export.mjs", import.meta.url)),
  "utf8",
);

const GO_ANCHORS = {
  allow: ["var kbAllowRules", "// group 的固定顺序"],
  denyDirs: ["var kbDenyDirs", "var kbSkipDirs"],
  denyNames: ["var kbDenyNames", "var kbGroupRank"],
};

const JS_ANCHORS = {
  allow: ["const ALLOWED = [", "const DENY_DIRS"],
  denyDirs: ["const DENY_DIRS = new Set([", "const DENY_NAMES"],
  denyNames: ["const DENY_NAMES = [", "export function deniedReason"],
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

// kb.go 用反引号原始字符串：regexp.MustCompile(\`...\`)
function goRegexLiterals(anchorPair) {
  const body = region(KB_GO, "apps/api-go/kb.go", anchorPair);
  const found = [...body.matchAll(/regexp\.MustCompile\(`([^`]+)`\)/g)].map((match) => match[1]);
  if (found.length === 0) {
    throw new Error(`kb.go 的区间里没有 regexp.MustCompile 字面量：${anchorPair.join(" → ")}`);
  }
  return found;
}

function goDenyDirs() {
  const body = region(KB_GO, "apps/api-go/kb.go", GO_ANCHORS.denyDirs);
  const found = [...body.matchAll(/^\s*"([^"]+)":\s*true,/gm)].map((match) => match[1]);
  if (found.length === 0) {
    throw new Error(`kb.go 的 kbDenyDirs 区间里没有目录名：${GO_ANCHORS.denyDirs.join(" → ")}`);
  }
  return found;
}

// 从 JS 源码里扫出正则字面量（/…/flags）：`\` 是转义、[…] 里的 / 不需要转义。
// 只认「整行就是一个字面量」的行 —— 两份清单都是一行一条；注释行含 / 但不是规则。
function jsRegexLiterals(anchorPair) {
  const body = region(KB_EXPORT, "scripts/kb-export.mjs", anchorPair);
  const literals = [];
  for (const rawLine of body.split("\n")) {
    const line = rawLine.trim();
    if (!line.startsWith("/") || line.startsWith("//") || line.startsWith("/*")) continue;
    let cursor = 1;
    let inClass = false;
    let closed = false;
    while (cursor < line.length) {
      const char = line[cursor];
      if (char === "\\") {
        cursor += 2;
        continue;
      }
      if (char === "[") {
        inClass = true;
      } else if (char === "]") {
        inClass = false;
      } else if (char === "/" && !inClass) {
        closed = true;
        break;
      }
      cursor += 1;
    }
    if (!closed) {
      throw new Error(`导出器的这一行不是完整的正则字面量：${line}`);
    }
    let flagsEnd = cursor + 1;
    while (flagsEnd < line.length && /[a-z]/.test(line[flagsEnd])) flagsEnd += 1;
    literals.push({ source: line.slice(1, cursor), flags: line.slice(cursor + 1, flagsEnd) });
  }
  if (literals.length === 0) {
    throw new Error(`导出器的区间里没有正则字面量：${anchorPair.join(" → ")}`);
  }
  return literals;
}

function jsDenyDirs() {
  const body = region(KB_EXPORT, "scripts/kb-export.mjs", JS_ANCHORS.denyDirs);
  const found = [...body.matchAll(/"([^"]+)"/g)].map((match) => match[1]);
  if (found.length === 0) {
    throw new Error(`导出器的 DENY_DIRS 区间里没有目录名：${JS_ANCHORS.denyDirs.join(" → ")}`);
  }
  return found;
}

// Go 的 (?i) 等行内标志要与 JS 的 i 标志对上：抽成 flags，再从源码里剥掉。
function normalizeGo(literal) {
  const flags = new Set();
  let source = literal;
  for (const match of literal.matchAll(/\(\?([a-zA-Z]+)\)/g)) {
    for (const flag of match[1]) flags.add(flag);
    source = source.split(match[0]).join("");
  }
  return { source: source.split("\\/").join("/"), flags: [...flags].sort().join("") };
}

function normalizeJs(literal) {
  return { source: literal.source.split("\\/").join("/"), flags: [...literal.flags].sort().join("") };
}

const canonical = (literal) => `/${literal.source}/${literal.flags}`;

const goAllowRules = () => goRegexLiterals(GO_ANCHORS.allow);
const goDenyNameRules = () => goRegexLiterals(GO_ANCHORS.denyNames);

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

describe("知识库白名单：两处同口径（apps/api-go/kb.go ↔ scripts/kb-export.mjs）", () => {
  it("kbAllowRules 与 ALLOWED 是同一个正则集合", () => {
    const fromGo = new Set(goAllowRules().map((literal) => canonical(normalizeGo(literal))));
    const fromJs = new Set(jsRegexLiterals(JS_ANCHORS.allow).map((literal) => canonical(normalizeJs(literal))));
    expect([...fromGo].sort()).toEqual([...fromJs].sort());
  });

  it("kbDenyNames 与 DENY_NAMES 是同一个正则集合", () => {
    const fromGo = new Set(goDenyNameRules().map((literal) => canonical(normalizeGo(literal))));
    const fromJs = new Set(
      jsRegexLiterals(JS_ANCHORS.denyNames).map((literal) => canonical(normalizeJs(literal))),
    );
    expect([...fromGo].sort()).toEqual([...fromJs].sort());
  });

  it("kbDenyDirs 与 DENY_DIRS 是同一个目录集合", () => {
    expect([...new Set(goDenyDirs())].sort()).toEqual([...new Set(jsDenyDirs())].sort());
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
    const exportersAnswer = deniedReason(target) === null && isKbPath(target);
    expect(goAccepts(target)).toBe(exportersAnswer);
    expect(exportersAnswer).toBe(expected);
  });
});
