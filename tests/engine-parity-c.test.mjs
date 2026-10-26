import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderSection } from "../scripts/last-change.mjs";

// 阶段 C 对照：同一批输入分别喂 scripts/merge-gate.mjs 与 go run ./cmd/engine merge-gate，
// 比 stdout / stderr / 退出码。gh 与 git 两侧都被 PATH 上的替身控制，谁真调谁就露馅。

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const engineDir = join(repoRoot, "apps/engine");
const scriptPath = join(repoRoot, "scripts/merge-gate.mjs");
const configPath = join(repoRoot, ".agents/platform/state-machine.yml");
const goEnv = {
  ...process.env,
  GOPATH: join(repoRoot, ".cache/go"),
  GOCACHE: join(repoRoot, ".cache/go-build"),
  GOFLAGS: "-mod=mod",
};

const GOOD = "a".repeat(40);
const OTHER = "b".repeat(40);
const BT = String.fromCharCode(96);

// 假 git：只认 merge-gate 用到的两条 cat-file -e，数据来自沙箱目录里的两个文件。
const FAKE_GIT = [
  "#!/bin/sh",
  'root="$FAKE_GIT_ROOT"',
  '[ "$1" = "cat-file" ] && [ "$2" = "-e" ] || exit 1',
  'spec="$3"',
  'case "$spec" in',
  '  *"{commit}")',
  '    sha=$(printf "%s" "$spec" | sed -e "s/[{]commit[}]$//" -e "s/\\^$//")',
  '    grep -Fxq "$sha" "$root/commits" && exit 0',
  '    exit 1 ;;',
  '  *:*)',
  '    sha=$(printf "%s" "$spec" | sed -e "s/:.*$//")',
  '    path=$(printf "%s" "$spec" | sed -e "s/^[^:]*://")',
  '    grep -Fxq "$sha" "$root/commits" || exit 1',
  '    [ -f "$root/files-$sha" ] || exit 1',
  '    grep -Fxq "$path" "$root/files-$sha" && exit 0',
  '    exit 1 ;;',
  'esac',
  "exit 1",
  "",
].join("\n");

// 假 gh：merge-gate 根本不该调用它，一调用就留痕并失败。
const FAKE_GH = ["#!/bin/sh", 'echo "gh 被调用了：merge-gate 不该走 gh" 1>&2', "exit 127", ""].join("\n");

let workDir;
let engineBin;
let binDir;
let gitlessDir;
let caseIndex = 0;

beforeAll(() => {
  workDir = mkdtempSync(join(tmpdir(), "engine-parity-c-"));
  binDir = join(workDir, "bin");
  gitlessDir = join(workDir, "gitless");
  mkdirSync(binDir, { recursive: true });
  mkdirSync(gitlessDir, { recursive: true });
  writeFileSync(join(binDir, "git"), FAKE_GIT);
  chmodSync(join(binDir, "git"), 0o755);
  writeFileSync(join(binDir, "gh"), FAKE_GH);
  chmodSync(join(binDir, "gh"), 0o755);
  writeFileSync(join(gitlessDir, "gh"), FAKE_GH);
  chmodSync(join(gitlessDir, "gh"), 0o755);
  engineBin = join(workDir, "engine");
  const build = spawnSync("go", ["build", "-o", engineBin, "./cmd/engine"], {
    cwd: engineDir,
    env: goEnv,
    encoding: "utf8",
    timeout: 240000,
  });
  if (build.status !== 0)
    throw new Error("go build 失败: " + (build.stderr || "") + (build.stdout || ""));
}, 300000);

afterAll(() => {
  if (workDir) rmSync(workDir, { recursive: true, force: true });
});

// 标准门牌正文：unless overridden, PR 7 / issue 4 / 一个文件 a.txt。
function section(over) {
  return renderSection({
    pr: 7,
    issue: 4,
    title: "t",
    proposer: "p",
    reviewers: [],
    files: ["a.txt"],
    ...over,
  });
}

function greenChecks(head) {
  return [
    { id: 1, name: "check", status: "completed", conclusion: "success", head_sha: head },
    { id: 2, name: "render", status: "completed", conclusion: "success", head_sha: head },
  ];
}

// 每个 case 自己准备沙箱：commits / files-<sha> 决定假 git 的答案，json 决定输入。
function prepare(spec) {
  caseIndex += 1;
  const dir = join(workDir, "case-" + String(caseIndex));
  const repo = join(dir, "repo");
  mkdirSync(repo, { recursive: true });
  const head = spec.head ?? GOOD;
  writeFileSync(join(repo, "commits"), [GOOD, OTHER].join("\n") + "\n");
  writeFileSync(join(repo, "files-" + head), (spec.present ?? ["a.txt"]).join("\n") + "\n");
  const pr = spec.pr ?? 7;
  const issue = spec.issueNumber ?? 4;
  const body =
    spec.body !== undefined
      ? spec.body
      : (spec.lead !== undefined ? spec.lead : "Fixes #4") + "\n\n" + section();
  const event = spec.event ?? {
    pull_request: { number: pr, body: "事件快照里的旧正文", title: "t", head: { sha: head } },
  };
  const files = {
    event: JSON.stringify(event),
    pr: JSON.stringify({ number: pr, body, title: spec.prTitle ?? "t", ...(spec.omitPrHead ? {} : { head: { sha: head } }) }),
    issue: JSON.stringify(spec.issue ?? { number: issue, labels: spec.labels ?? ["state:in-progress"] }),
    checks: JSON.stringify(spec.checks ?? greenChecks(head)),
    infra: JSON.stringify(spec.infra ?? []),
  };
  for (const [name, text] of Object.entries(files))
    writeFileSync(join(dir, name + ".json"), spec.raw?.[name] ?? text);
  const omit = new Set(spec.omit ?? []);
  const argv = ["--repo", repo];
  for (const flag of ["--event", "--pr", "--issue", "--checks", "--infra"]) {
    if (omit.has(flag)) continue;
    argv.push(flag, join(dir, flag.slice(2) + ".json"));
  }
  argv.push("--config", spec.config ?? configPath);
  for (const extra of spec.extraArgs ?? []) argv.push(extra);
  const env = {
    PATH: spec.gitless ? gitlessDir : binDir + ":/usr/bin:/bin",
    HOME: "/tmp",
    FAKE_GIT_ROOT: repo,
    ...spec.env,
  };
  return { dir, repo, argv, env };
}

function runBoth(spec) {
  const built = prepare(spec);
  const js = spawnSync(process.execPath, [scriptPath, ...built.argv], {
    encoding: "utf8",
    env: built.env,
    timeout: 60000,
  });
  const go = spawnSync(engineBin, ["merge-gate", ...built.argv], {
    encoding: "utf8",
    env: built.env,
    timeout: 60000,
  });
  if (js.status === null || go.status === null)
    throw new Error("子进程没跑起来: js=" + js.signal + " go=" + go.signal + " " + (js.stderr || ""));
  return { js, go, argv: built.argv };
}

// 别名：让下面的用例表读起来就是「输入 → 判定」。
const CASES = [];
function gate(spec) {
  CASES.push(spec);
}

// ---- G1 issue-state ----
gate({ name: "G1 通过：state:in-progress", exit: 0, code: "PASS 4/4" });
gate({
  name: "G1 通过：标签是对象形状",
  exit: 0,
  code: "PASS 4/4",
  labels: [{ name: "state:in-progress" }],
});
gate({ name: "G1 真失败：没有状态标签", exit: 1, code: "E_NO_TRANSITION", labels: [] });
gate({ name: "G1 真失败：已经是终态 done", exit: 1, code: "E_TERMINAL_STATE", labels: ["state:done"] });
gate({ name: "G1 无法判定：未知状态", exit: 3, code: "E_UNKNOWN_STATE", labels: ["state:bogus"] });
gate({
  name: "G1 无法判定：两个状态标签",
  exit: 3,
  code: "E_STATE_LABEL_COUNT",
  labels: ["state:in-progress", "state:blocked"],
});
gate({
  name: "G1 无法判定：配置路径不存在",
  exit: 3,
  code: "E_CONFIG_MISSING",
  config: join(tmpdir(), "definitely-not-here-state-machine.yml"),
});
gate({ name: "输入形状：issue 缺 number", exit: 3, code: "E_ISSUE_SHAPE", issue: { labels: ["state:in-progress"] } });
gate({
  name: "未捕获异常：labels 不是数组（两侧都不许吐半份报告）",
  exit: 1,
  code: "",
  crash: true,
  labels: "state:in-progress",
});

// ---- G2 refs-and-files ----
gate({ name: "G2 真失败：PR 未引用 issue", exit: 1, code: "E_ISSUE_REFS", lead: "这次改动没有写引用" });
gate({ name: "G2 真失败：引用多个 issue", exit: 1, code: "E_ISSUE_REFS", lead: "Fixes #4\nCloses #5" });
gate({
  name: "G2 通过：引用写在标题里（body 没有才看 title）",
  exit: 0,
  code: "PASS 4/4",
  lead: "标题里才有引用",
  prTitle: "Fixes #4",
});
gate({ name: "G2 真失败：引用的不是本次 issue", exit: 1, code: "E_ISSUE_REF_MISMATCH", lead: "Fixes #5" });
gate({
  name: "G2 真失败：门牌列的文件在 head 上不存在",
  exit: 1,
  code: "E_FILE_MISSING",
  present: ["other.txt"],
});
gate({
  name: "G2 无法判定：正文没有门牌节",
  exit: 3,
  code: "E_LAST_CHANGE_MISSING",
  body: "Fixes #4\n\n只有正文，没有门牌\n",
});
gate({
  name: "G2 真失败：门牌行数与模板不一致",
  exit: 1,
  code: "E_LAST_CHANGE_SHAPE",
  body: "Fixes #4\n\n" +
    section()
      .split("\n")
      .filter((line) => !line.includes("标题"))
      .join("\n"),
});
gate({
  name: "G2 真失败：门牌没列变更文件",
  exit: 1,
  code: "E_LAST_CHANGE_FILES",
  body: "Fixes #4\n\n" + section().split(BT + "a.txt" + BT).join("—"),
});
gate({
  name: "G2 无法判定：生产者 render 还没出现",
  exit: 3,
  code: "E_LAST_CHANGE_PENDING",
  checks: [{ id: 1, name: "merge-gate", status: "completed", conclusion: "success", head_sha: GOOD }],
});
gate({
  name: "G2 无法判定：生产者还在跑",
  exit: 3,
  code: "E_LAST_CHANGE_PENDING",
  checks: [
    { id: 1, name: "check", status: "completed", conclusion: "success", head_sha: GOOD },
    { id: 2, name: "render", status: "in_progress", conclusion: null, head_sha: GOOD },
  ],
});
gate({
  name: "G2 无法判定：生产者这次没写成（G3 也会因它变红）",
  exit: 1,
  code: "E_LAST_CHANGE_FAILED",
  alsoCodes: ["E_CHECK_NOT_GREEN"],
  checks: [
    { id: 1, name: "check", status: "completed", conclusion: "success", head_sha: GOOD },
    { id: 2, name: "render", status: "completed", conclusion: "failure", head_sha: GOOD },
  ],
});
gate({
  name: "G2 无法判定：同名生产者 id 相同时取后出现的那条（重跑也算）",
  exit: 3,
  code: "E_LAST_CHANGE_PENDING",
  checks: [
    { id: 1, name: "check", status: "completed", conclusion: "success", head_sha: GOOD },
    { id: 2, name: "render", status: "completed", conclusion: "success", head_sha: GOOD },
    { id: 2, name: "render", status: "in_progress", conclusion: null, head_sha: GOOD },
  ],
});
gate({ name: "G2 无法判定：head commit 取不到", exit: 3, code: "E_GIT_FAILED", head: "c".repeat(40) });
gate({
  name: "G2 无法判定：PATH 上没有 git",
  exit: 3,
  code: "E_GIT_UNAVAILABLE",
  gitless: true,
});
gate({ name: "出口：--print-issue 打印解析出的 issue 号", exit: 0, code: "4", extraArgs: ["--print-issue"] });
gate({
  name: "出口：--print-issue 解不出就拒绝",
  exit: 1,
  code: "E_ISSUE_REFS",
  lead: "没有引用",
  extraArgs: ["--print-issue"],
});

// ---- G3 checks ----
gate({
  name: "G3 无法判定：只有自己的 check run",
  exit: 3,
  code: "E_CHECKS_EMPTY",
  checks: [{ id: 1, name: "merge-gate", status: "completed", conclusion: "success", head_sha: GOOD }],
});
gate({
  name: "G3 真失败：检查项不是本 head 的",
  exit: 1,
  code: "E_CHECK_STALE",
  checks: [
    { id: 1, name: "check", status: "completed", conclusion: "success", head_sha: GOOD },
    { id: 2, name: "render", status: "completed", conclusion: "success", head_sha: GOOD },
    { id: 3, name: "audit", status: "completed", conclusion: "success", head_sha: OTHER },
  ],
});
gate({
  name: "G3 无法判定：检查项还没跑完",
  exit: 3,
  code: "E_CHECK_PENDING",
  checks: [
    { id: 1, name: "check", status: "in_progress", conclusion: null, head_sha: GOOD },
    { id: 2, name: "render", status: "completed", conclusion: "success", head_sha: GOOD },
  ],
});
gate({
  name: "G3 真失败：检查项失败",
  exit: 1,
  code: "E_CHECK_NOT_GREEN",
  checks: [
    { id: 1, name: "check", status: "completed", conclusion: "failure", head_sha: GOOD },
    { id: 2, name: "render", status: "completed", conclusion: "success", head_sha: GOOD },
  ],
});
gate({
  name: "G3 无法判定：检查项没判过（neutral）",
  exit: 3,
  code: "E_CHECK_NOT_JUDGED",
  checks: [
    { id: 1, name: "check", status: "completed", conclusion: "neutral", head_sha: GOOD },
    { id: 2, name: "render", status: "completed", conclusion: "success", head_sha: GOOD },
  ],
});
gate({
  name: "G3 真失败：失败与未判过并存时先报失败",
  exit: 1,
  code: "E_CHECK_NOT_GREEN",
  checks: [
    { id: 1, name: "check", status: "completed", conclusion: "failure", head_sha: GOOD },
    { id: 2, name: "render", status: "completed", conclusion: "success", head_sha: GOOD },
    { id: 3, name: "lint", status: "completed", conclusion: "skipped", head_sha: GOOD },
  ],
});
gate({
  name: "G3 同名 check 取最新：新的失败",
  exit: 1,
  code: "E_CHECK_NOT_GREEN",
  checks: [
    { id: 10, name: "audit", status: "completed", conclusion: "success", head_sha: GOOD },
    { id: 2, name: "render", status: "completed", conclusion: "success", head_sha: GOOD },
    { id: 20, name: "audit", status: "completed", conclusion: "failure", head_sha: GOOD },
  ],
});
gate({
  name: "G3 同名 check 取最新：新的通过（旧失败不算）",
  exit: 0,
  code: "PASS 4/4",
  checks: [
    { id: 10, name: "audit", status: "completed", conclusion: "failure", head_sha: GOOD },
    { id: 2, name: "render", status: "completed", conclusion: "success", head_sha: GOOD },
    { id: 20, name: "audit", status: "completed", conclusion: "success", head_sha: GOOD },
  ],
});
gate({
  name: "G3 同名 check 取最新：与数组顺序无关",
  exit: 0,
  code: "PASS 4/4",
  checks: [
    { id: 20, name: "audit", status: "completed", conclusion: "success", head_sha: GOOD },
    { id: 2, name: "render", status: "completed", conclusion: "success", head_sha: GOOD },
    { id: 10, name: "audit", status: "completed", conclusion: "failure", head_sha: GOOD },
  ],
});
gate({
  name: "G3 无法判定：还有未结 INFRA",
  exit: 3,
  code: "E_INFRA_OPEN",
  infra: [{ id: "INFRA-1" }, { id: "INFRA-2" }],
});
gate({
  name: "G3 无法判定：未结 INFRA 用 unresolved 形状",
  exit: 3,
  code: "E_INFRA_OPEN",
  infra: { unresolved: [{ id: "INFRA-9" }] },
});
gate({ name: "G3 无法判定：INFRA 形状不对", exit: 3, code: "E_INFRA_SHAPE", infra: {} });
gate({ name: "G3 无法判定：check runs 形状不对", exit: 3, code: "E_CHECKS_SHAPE", checks: "nope" });

// ---- 输入层 ----
gate({ name: "输入：没有事件输入", exit: 3, code: "E_EVENT_MISSING", omit: ["--event"] });
gate({ name: "输入：事件不是合法 JSON", exit: 3, code: "E_EVENT_UNPARSABLE", raw: { event: "{ 坏掉的" } });
gate({ name: "输入：事件里没有 pull_request", exit: 3, code: "E_EVENT_SHAPE", event: { number: 7 } });
gate({
  name: "输入：事件里没有 head.sha 也没给 --head",
  exit: 3,
  code: "E_HEAD_MISSING",
  event: { pull_request: { number: 7, body: "旧正文", title: "t" } },
  omitPrHead: true,
});
gate({
  name: "输入：head 由 --head 兜底",
  exit: 0,
  code: "PASS 4/4",
  event: { pull_request: { number: 7, body: "旧正文", title: "t" } },
  extraArgs: ["--head", GOOD],
});
gate({ name: "输入：没有给 --checks", exit: 3, code: "E_INPUT_MISSING", omit: ["--checks"] });
gate({
  name: "输入：--checks 指向不存在的文件",
  exit: 3,
  code: "E_INPUT_MISSING",
  omit: ["--checks"],
  extraArgs: ["--checks", join(tmpdir(), "nope-checks.json")],
});
gate({ name: "输入：checks 不是合法 JSON", exit: 3, code: "E_INPUT_UNPARSABLE", raw: { checks: "{ bad" } });

describe("engine merge-gate 与 scripts/merge-gate.mjs 逐字一致", () => {
  it("夹具数量足够覆盖四道守卫的三态", () => {
    expect(CASES.length).toBeGreaterThanOrEqual(25);
  });

  for (const spec of CASES) {
    it(spec.name, () => {
      const { js, go, argv } = runBoth(spec);
      expect(argv[0]).toBe("--repo");
      // 先验夹具本身真的打中它声称的分支，再验两侧一致。
      expect(js.status).toBe(spec.exit);
      if (spec.code) expect(js.stdout).toContain(spec.code);
      for (const extra of spec.alsoCodes ?? []) expect(js.stdout).toContain(extra);
      expect(go.status).toBe(js.status);
      expect(go.stdout).toBe(js.stdout);
      if (spec.crash) {
        expect(js.stdout).toBe("");
        expect(go.stdout).toBe("");
        expect(js.stderr).toMatch(/TypeError/);
        expect(go.stderr).toMatch(/TypeError/);
      } else {
        expect(go.stderr).toBe(js.stderr);
        expect(go.stderr).toBe("");
      }
      expect(js.stdout).not.toContain("gh 被调用了");
    });
  }
});
