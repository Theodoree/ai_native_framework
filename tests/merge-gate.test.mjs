import { test, expect } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
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
import { renderSection } from "../scripts/last-change.mjs";

// 四守卫的判据是「每条能独立失败」：每个用例只坏一条，另外三条必须仍是 PASS。
// 输入全是文件（脚本里没有网络调用），所以 G3 那种最容易被「看起来绿」骗过的
// 判定能在这里被证明为红。wiring 那条不重写流程：把 YAML 的 run 块原样执行。

const ROOT = process.cwd();
const SCRIPT_DIR = join(ROOT, "scripts");
const SCRIPT = join(SCRIPT_DIR, "merge-gate.mjs");
const WORKFLOW = ".github/workflows/merge-gate.yml";
const CONFIG = ".agents/platform/state-machine.yml";
const FILES = ["src/a.mjs", "docs/b.md"];

function repo(files = { "src/a.mjs": "a\n", "docs/b.md": "b\n" }) {
  const dir = mkdtempSync(join(tmpdir(), "merge-gate-"));
  execFileSync("git", ["init", "-q", "."], { cwd: dir });
  execFileSync("git", ["config", "user.email", "t@example.com"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "t"], { cwd: dir });
  mkdirSync(join(dir, dirname(CONFIG)), { recursive: true });
  cpSync(join(ROOT, CONFIG), join(dir, CONFIG));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(dir, dirname(path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync("git", ["commit", "-q", "-m", "base"], { cwd: dir });
  const head = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: dir,
    encoding: "utf8",
  }).trim();
  // 沙箱里放一份指向真 scripts/ 的链接：YAML 的 run 块写的是仓库相对路径，
  // 原样执行才需要它落在这里。链接在提交之后建，不进门牌证据。
  symlinkSync(SCRIPT_DIR, join(dir, "scripts"), "dir");
  return { dir, head };
}

// 门牌正文由真正的生产者（last-change.mjs 的 renderSection）生成：
// gate 的解析必须经得起真产物，而不是测试里另编一份表。
function body({ pr = 34, issue = 12, files = FILES, refs } = {}) {
  return [
    "## 关联",
    "",
    refs ?? "- Fixes #" + issue,
    "",
    renderSection({
      pr,
      issue,
      title: "feat: gate",
      proposer: "ted",
      reviewers: ["alice"],
      files,
      mergedBy: null,
      mergedAt: null,
    }),
  ].join("\n");
}

// 门牌的生产者（last-change 的 job）自己也挂在同一个 head 的 check_runs 里：
// 门的结论必须站在它之后，所以夹具里它是绿的一条（PRODUCER 名由 wiring 用例钉住）。
const PRODUCER = "render";
const green = (head) =>
  ["check", "audit", PRODUCER, "merge-gate"].map((name, i) => ({
    id: 10 + i,
    name,
    status: "completed",
    conclusion: "success",
    head_sha: head,
  }));
const without = (runs, name) => runs.filter((r) => r.name !== name);
const pendingCheck = (head) =>
  green(head).map((r) =>
    r.name === "audit" ? { ...r, status: "in_progress", conclusion: null } : r,
  );

const guardLine = (out, id) =>
  out.split("\n").find((line) => line.split(" ").includes(id)) ?? "";
const lastLine = (out) => out.trim().split("\n").at(-1) ?? "";

// 一次判定：造沙箱仓库 + 四份输入文件，然后原样调 CLI。
function gate({
  files,
  pr = 34,
  bodyText,
  issue = 12,
  labels = ["state:in-progress"],
  checks,
  infra = [],
  skip = [],
  // 只有「故意造一批指向别的 commit 的检查项」的用例才需要打开它（判 E_CHECK_STALE）。
  allowStrayHeads = false,
} = {}) {
  const { dir, head } = repo(files);
  const at = (name) => join(dir, ".gate", name);
  mkdirSync(join(dir, ".gate"), { recursive: true });
  const text = bodyText ?? body({ pr });
  // checks 可以是 head 的函数：否则「造一批指向别的 commit 的检查项」会自己先变成 stale。
  const runs =
    typeof checks === "function" ? checks(head) : (checks ?? green(head));
  // 夹具必须长在「本次判定真正用的那个 head」上：另开一个 repo() 取 head 会让
  // commit 哈希偶尔与之相同（同内容同秒）、偶尔不同，于是同一个用例在本地绿、CI 红。
  const stray = allowStrayHeads
    ? []
    : runs.filter((r) => r.head_sha && r.head_sha !== head);
  if (stray.length)
    throw new Error(
      `测试夹具缺陷：check runs 指向别的 commit（${stray
        .map((r) => r.name)
        .join(", ")}）。用 checks: (head) => ... 造夹具。`,
    );
  const prView = {
    number: pr,
    title: "feat: gate",
    body: text,
    head: { sha: head },
  };
  const inputs = {
    // 事件里的正文是那一刻的快照；--pr 才是现况（门牌写回后才有表）。
    "event.json": { pull_request: prView },
    "pr.json": prView,
    "issue.json": { number: issue, labels: labels.map((name) => ({ name })) },
    "checks.json": { total_count: runs.length, check_runs: runs },
    "infra.json": infra,
  };
  for (const [name, value] of Object.entries(inputs))
    if (!skip.includes(name)) writeFileSync(at(name), JSON.stringify(value));
  const argv = ["--event", at("event.json")];
  if (!skip.includes("pr.json")) argv.push("--pr", at("pr.json"));
  if (!skip.includes("issue.json")) argv.push("--issue", at("issue.json"));
  if (!skip.includes("checks.json")) argv.push("--checks", at("checks.json"));
  if (!skip.includes("infra.json")) argv.push("--infra", at("infra.json"));
  const r = spawnSync("node", [SCRIPT, "--repo", dir, ...argv], {
    cwd: ROOT,
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
  });
  return {
    dir,
    head,
    status: r.status,
    out: r.stdout,
    err: r.stderr,
    line: (id) => guardLine(r.stdout, id),
    last: lastLine(r.stdout),
  };
}

// ---- (b) 四条全过 ----

test("(b) 四条全过：每行 PASS，退出 0", () => {
  const g = gate();
  expect(g.err).toBe("");
  expect(g.status).toBe(0);
  for (const id of ["G1", "G2", "G3", "G4"])
    expect(g.line(id)).toContain("PASS OK");
  expect(g.line("G1")).toContain("in-progress → done");
  expect(g.last).toBe("merge-gate PASS 4/4");
  // Check 名与输出前缀一致：GitHub 上 required status check 就取这个名。
  expect(g.out.split("\n")[0]).toMatch(/^merge-gate PR #34 @ [0-9a-f]{7}$/);
});

// ---- (a) 四条各自被单独打红 ----

test("(a1) 只坏 G1：issue 已在终态，status=1，G2/G3/G4 仍 PASS", () => {
  const g = gate({ labels: ["state:done"] });
  expect(g.status).toBe(1);
  expect(g.line("G1")).toContain("FAIL E_TERMINAL_STATE");
  for (const id of ["G2", "G3", "G4"]) expect(g.line(id)).toContain("PASS OK");
  expect(g.last).toBe("merge-gate FAIL 1/4 真失败=1(G1) 未就绪=0");
});

test("(a1) 只坏 G1：accepted 没有到 done 的转换（规则来自状态机声明，不是 gate 里另写的）", () => {
  const g = gate({ labels: ["state:accepted"] });
  expect(g.status).toBe(1);
  expect(g.line("G1")).toContain("FAIL E_NO_TRANSITION");
  expect(g.line("G2")).toContain("PASS OK");
});

test("(a2) 只坏 G2：门牌列的变更文件在 head 上不存在", () => {
  const g = gate({ bodyText: body({ files: [...FILES, "src/ghost.mjs"] }) });
  expect(g.status).toBe(1);
  expect(g.line("G2")).toContain("FAIL E_FILE_MISSING");
  expect(g.line("G2")).toContain("src/ghost.mjs");
  for (const id of ["G1", "G3", "G4"]) expect(g.line(id)).toContain("PASS OK");
  expect(g.last).toBe("merge-gate FAIL 1/4 真失败=1(G2) 未就绪=0");
});

test("(a2) 只坏 G2：PR 一条 issue 引用都没有 → 不猜", () => {
  const g = gate({ bodyText: body({ refs: "- 关联 issue 写在别处" }) });
  expect(g.status).toBe(1);
  expect(g.line("G2")).toContain("FAIL E_ISSUE_REFS");
  expect(g.line("G2")).toContain("实际 0 个");
  expect(g.line("G4")).toContain("PASS OK");
});

test("(a2) 只坏 G2：引用了两个 issue → 不猜", () => {
  const g = gate({ bodyText: body({ refs: "- Fixes #12\n- Closes #13" }) });
  expect(g.status).toBe(1);
  expect(g.line("G2")).toContain("FAIL E_ISSUE_REFS");
  expect(g.line("G2")).toContain("实际 2 个");
});

test("(a2) 只坏 G2：PR 引用的 issue 与门挂的 issue 不是同一个", () => {
  const g = gate({ bodyText: body({ refs: "- Fixes #13" }) });
  expect(g.status).toBe(1);
  expect(g.line("G2")).toContain("FAIL E_ISSUE_REF_MISMATCH");
});

test("(a2) 门牌缺失：G2 与 G4 同报一件事，但归「未就绪」而不是「拒绝」", () => {
  // 生产者绿了、正文里却没有表 —— 这是「门牌还没写完 / 写到了别处」，
  // 不是 PR 本身不合格：判拒绝会让读者去追两个不存在的缺陷。
  const g = gate({ bodyText: "## 关联\n\n- Fixes #12\n" });
  expect(g.status).toBe(3);
  expect(g.line("G2")).toContain("INFRA E_LAST_CHANGE_MISSING");
  expect(g.line("G4")).toContain("INFRA E_LAST_CHANGE_MISSING");
  expect(g.line("G2")).toContain("未就绪");
  // 两条说的是同一件事：汇总行只报「未就绪 2 条」，不报「四条全错」。
  expect(g.last).toBe("merge-gate INFRA 2/4 真失败=0 未就绪=2(G2,G4)");
});

test("(a4) 只坏 G4：门牌写的 PR 不是本 PR", () => {
  const g = gate({ bodyText: body({ pr: 35 }) });
  expect(g.status).toBe(1);
  expect(g.line("G4")).toContain("FAIL E_PR_MISMATCH");
  expect(g.line("G4")).toContain("#35");
  for (const id of ["G1", "G2", "G3"]) expect(g.line(id)).toContain("PASS OK");
  expect(g.last).toBe("merge-gate FAIL 1/4 真失败=1(G4) 未就绪=0");
});

test("(a4) 门牌表格被手改（少了一行）：G4 判它不是派生物", () => {
  const lines = body().split("\n");
  const at = lines.findIndex((line) => line.includes("| 审核人"));
  lines.splice(at, 1);
  const g = gate({ bodyText: lines.join("\n") });
  expect(g.status).toBe(1);
  expect(g.line("G4")).toContain("FAIL E_LAST_CHANGE_SHAPE");
});

// ---- (a3)(e) 守卫 3：看起来绿 ----

test("(a3) 只坏 G3：全绿里混着一条 failure", () => {
  const g = gate({
    checks: (head) =>
      green(head).map((r) =>
        r.name === "audit" ? { ...r, conclusion: "failure" } : r,
      ),
  });
  expect(g.status).toBe(1);
  expect(g.line("G3")).toContain("FAIL E_CHECK_NOT_GREEN");
  expect(g.line("G3")).toContain("audit(id 11) completed/failure");
  for (const id of ["G1", "G2", "G4"]) expect(g.line(id)).toContain("PASS OK");
  expect(g.last).toBe("merge-gate FAIL 1/4 真失败=1(G3) 未就绪=0");
});

test("(e) 看起来绿：同名先绿后红，只看最新一次（旧绿不给新红背书）", () => {
  const g = gate({
    checks: (head) => [
      ...green(head),
      {
        id: 99,
        name: "audit",
        status: "completed",
        conclusion: "failure",
        head_sha: head,
      },
    ],
  });
  expect(g.status).toBe(1);
  expect(g.line("G3")).toContain("E_CHECK_NOT_GREEN");
  expect(g.line("G3")).toContain("audit(id 99) completed/failure");
});

test("(e) 同名先红后绿：最新的成功说了算，不拿旧红否决重跑", () => {
  const g = gate({
    checks: (head) => [
      {
        id: 11,
        name: "audit",
        status: "completed",
        conclusion: "failure",
        head_sha: head,
      },
      ...green(head),
      {
        id: 99,
        name: "audit",
        status: "completed",
        conclusion: "success",
        head_sha: head,
      },
    ],
  });
  // 失败时把门的原话带出来：CI 上「本地绿、那里红」不能只留一个数字。
  expect(g.status, `${g.out}\n${g.err}`).toBe(0);
  expect(g.line("G3")).toContain("PASS OK");
});

test("(c) 还在跑 ≠ 不合格：in_progress/queued 归未就绪（exit 3）", () => {
  const running = (head) =>
    green(head).map((r) =>
      r.name === "audit"
        ? { ...r, status: "in_progress", conclusion: null }
        : r,
    );
  const queued = (head) =>
    green(head).map((r) =>
      r.name === "audit"
        ? { ...r, id: 88, status: "queued", conclusion: null }
        : r,
    );
  const g = gate({ checks: running });
  expect(g.status).toBe(3);
  expect(g.line("G3")).toContain("INFRA E_CHECK_PENDING");
  expect(g.line("G3")).toContain("audit(id 11) in_progress/null");
  expect(g.line("G3")).toContain("未就绪");
  expect(g.line("G1")).toContain("PASS OK");
  expect(g.last).toBe("merge-gate INFRA 1/4 真失败=0 未就绪=1(G3)");
  const q = gate({ checks: queued });
  expect(q.status).toBe(3);
  expect(q.line("G3")).toContain("audit(id 88) queued/null");
});

test("(c) 跑完是红的才是真失败：skipped/neutral/cancelled 都不给背书（exit 1）", () => {
  const withConclusion = (conclusion) => (head) =>
    green(head).map((r) => (r.name === "audit" ? { ...r, conclusion } : r));
  for (const conclusion of [
    "skipped",
    "neutral",
    "cancelled",
    "timed_out",
    "failure",
  ]) {
    const g = gate({ checks: withConclusion(conclusion) });
    expect(g.status).toBe(1);
    expect(g.line("G3")).toContain("FAIL E_CHECK_NOT_GREEN");
    expect(g.line("G3")).toContain("audit(id 11) completed/" + conclusion);
  }
});

test("(e) 检查项属于另一个 commit：绿也不算数", () => {
  const g = gate({ checks: green("0".repeat(40)), allowStrayHeads: true });
  expect(g.status).toBe(1);
  expect(g.line("G3")).toContain("FAIL E_CHECK_STALE");
});

test("(e) 检查项根本没跑：INFRA 退出 3，绝不当通过", () => {
  const g = gate({ checks: [] });
  expect(g.status).toBe(3);
  expect(g.line("G3")).toContain("INFRA E_CHECKS_EMPTY");
  // 一条别人的检查都没有，生产者也就没露面：G2/G4 同样判不了。
  expect(g.last).toBe("merge-gate INFRA 3/4 真失败=0 未就绪=3(G2,G3,G4)");
});

test("(a3) 只坏 G3：还有未结 INFRA 记录", () => {
  const g = gate({ infra: [{ id: "infra#7", title: "kb export 失败" }] });
  expect(g.status).toBe(1);
  expect(g.line("G3")).toContain("FAIL E_INFRA_OPEN");
  expect(g.line("G3")).toContain("infra#7");
  expect(g.line("G4")).toContain("PASS OK");
});

test("缺输入（没给 --infra）：INFRA 退出 3，不当通过", () => {
  const g = gate({ skip: ["infra.json"] });
  expect(g.status).toBe(3);
  expect(g.out).toContain("E_INPUT_MISSING");
});

test("--print-issue：只公布脚本自己解析出的 issue 号，解不出就非零", () => {
  const { dir, head } = repo();
  mkdirSync(join(dir, ".gate"), { recursive: true });
  const ev = (text) =>
    writeFileSync(
      join(dir, ".gate", "e.json"),
      JSON.stringify({
        pull_request: {
          number: 34,
          title: "t",
          body: text,
          head: { sha: head },
        },
      }),
    );
  const run = () =>
    spawnSync(
      "node",
      [SCRIPT, "--event", join(dir, ".gate", "e.json"), "--print-issue"],
      {
        cwd: ROOT,
        encoding: "utf8",
        env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
      },
    );
  ev(body());
  expect(run().stdout.trim()).toBe("12");
  ev(body({ refs: "- Fixes #12\n- Fixes #13" }));
  const bad = run();
  expect(bad.status).toBe(1);
  expect(bad.stdout).toContain("E_ISSUE_REFS");
});

// ---- (a) 与门牌生产者赛跑：判定只能发生在生产者之后 ----

test("(a) 生产者还没露面：门牌可能还没写 → 未就绪（INFRA 3），绝不当通过也不判拒绝", () => {
  const g = gate({ checks: (head) => without(green(head), PRODUCER) });
  expect(g.status).toBe(3);
  expect(g.line("G2")).toContain("INFRA E_LAST_CHANGE_PENDING");
  expect(g.line("G2")).toContain("还没在");
  expect(g.line("G4")).toContain("INFRA E_LAST_CHANGE_PENDING");
  // 门牌缺失的两条一起退成「未就绪」，别让读者以为坏了两处。
  expect(g.last).toBe("merge-gate INFRA 2/4 真失败=0 未就绪=2(G2,G4)");
});

test("(a) 生产者还在写（in_progress）：门牌可能是半截 → 未就绪", () => {
  const writing = (head) =>
    green(head).map((r) =>
      r.name === PRODUCER
        ? { ...r, status: "in_progress", conclusion: null }
        : r,
    );
  const g = gate({ checks: writing });
  expect(g.status).toBe(3);
  expect(g.line("G2")).toContain("INFRA E_LAST_CHANGE_PENDING");
  expect(g.line("G2")).toContain("写到一半");
  expect(g.line("G1")).toContain("PASS OK");
});

test("(a) 生产者自己红了：门牌这次没写成 → 未就绪（不是 PR 不合格）", () => {
  const failed = (head) =>
    green(head).map((r) =>
      r.name === PRODUCER ? { ...r, conclusion: "failure" } : r,
    );
  const g = gate({ checks: failed });
  // 根因只有一条：生产者红了（G3 判真失败）；G2/G4 说「等它先修好」——
  // 汇总行因此读成「真失败 1 条（G3），未就绪 2 条（G2,G4）」，而不是「三条全错」。
  expect(g.status).toBe(1);
  expect(g.line("G3")).toContain("FAIL E_CHECK_NOT_GREEN");
  expect(g.line("G3")).toContain("render(id 12) completed/failure");
  expect(g.line("G2")).toContain("INFRA E_LAST_CHANGE_FAILED");
  expect(g.line("G4")).toContain("INFRA E_LAST_CHANGE_FAILED");
  expect(g.line("G2")).toContain("先修生产者");
  expect(g.last).toBe("merge-gate FAIL 3/4 真失败=1(G3) 未就绪=2(G2,G4)");
});

test("(a) 生产者已写完：判定回到正文本身（红的是门牌，不是竞态）", () => {
  const g = gate({ bodyText: body({ files: [...FILES, "src/ghost.mjs"] }) });
  expect(g.status).toBe(1);
  expect(g.line("G2")).toContain("FAIL E_FILE_MISSING");
});

// ---- (b) 自排除：一个 check 不能给自己背书 ----

test("(b) 自己还在 in_progress 不算不绿：G3 不看自己那一条", () => {
  const self = (head) =>
    green(head).map((r) =>
      r.name === "merge-gate"
        ? { ...r, status: "in_progress", conclusion: null }
        : r,
    );
  const g = gate({ checks: self });
  expect(g.status).toBe(0);
  expect(g.line("G3")).toContain("PASS OK");
  expect(g.line("G3")).toContain("自己不算");
  expect(g.last).toBe("merge-gate PASS 4/4");
});

test("(b) 反向：别人还在跑就必须是未就绪，不是通过（自排除不放松别人那几条）", () => {
  const g = gate({ checks: pendingCheck });
  expect(g.status).toBe(3);
  expect(g.line("G3")).toContain("INFRA E_CHECK_PENDING");
  expect(g.line("G3")).toContain("audit(id 11) in_progress/null");
});

test("(b) 只剩自己那条：别人的检查根本没跑 → 未就绪，不因自排除而变绿", () => {
  // 少一个别人的检查（audit）照样能判：门只要求「有的都绿」。
  expect(gate({ checks: (head) => without(green(head), "audit") }).status).toBe(
    0,
  );
  // 只剩自己：排除自己之后一条别人的都没有 —— 检查没跑不等于绿。
  const g = gate({
    checks: (head) => green(head).filter((r) => r.name === "merge-gate"),
  });
  expect(g.status).toBe(3);
  expect(g.line("G3")).toContain("INFRA E_CHECKS_EMPTY");
  expect(g.last).toBe("merge-gate INFRA 3/4 真失败=0 未就绪=3(G2,G3,G4)");
});

// ---- (d) 汇总行：真失败与未就绪分得开 ----

test("(d) 四种组合的汇总行：真失败 k 条 / 未就绪 n 条", () => {
  const combos = [
    ["全过", gate(), 0, "merge-gate PASS 4/4"],
    [
      "只有真失败",
      gate({ labels: ["state:accepted"] }),
      1,
      "merge-gate FAIL 1/4 真失败=1(G1) 未就绪=0",
    ],
    [
      "只有未就绪",
      gate({ checks: pendingCheck }),
      3,
      "merge-gate INFRA 1/4 真失败=0 未就绪=1(G3)",
    ],
    [
      "两者都有",
      gate({ labels: ["state:accepted"], checks: pendingCheck }),
      1,
      "merge-gate FAIL 2/4 真失败=1(G1) 未就绪=1(G3)",
    ],
  ];
  for (const [, g, status, last] of combos) {
    expect(g.status).toBe(status);
    expect(g.last).toBe(last);
  }
});

// ---- (c)(e) 出口形态与取数方式 ----

test("(c) 退出码就是结论：0 全过 / 1 拒绝 / 3 INFRA，逐行点名哪条守卫", () => {
  const cases = [
    { g: gate(), status: 0, verdict: "PASS" },
    { g: gate({ labels: ["state:done"] }), status: 1, verdict: "FAIL" },
    { g: gate({ checks: [] }), status: 3, verdict: "INFRA" },
  ];
  for (const { g, status, verdict } of cases) {
    expect(g.status).toBe(status);
    expect(g.last).toMatch(new RegExp("^merge-gate " + verdict));
    // 每一行都带 Check 名 + 守卫编号：CI 日志里一眼看出是哪个门、哪条守卫。
    for (const id of ["G1", "G2", "G3", "G4"])
      expect(g.line(id)).toMatch(
        /^merge-gate G[1-4] [a-z-]+ (PASS|FAIL|INFRA) [A-Z_]+ /,
      );
  }
});

test("(e) 守卫 3 的取数唯一方式是注入：脚本里没有任何网络调用", () => {
  const source = readFileSync(SCRIPT, "utf8");
  for (const pattern of [
    /\bfetch\s*\(/,
    /node:https?/,
    /node:net/,
    /node:dns/,
    /undici/,
    /XMLHttpRequest/,
    /require\(["']https?["']\)/,
  ])
    expect(source).not.toMatch(pattern);
  // 只允许 node 内置与同目录脚本两种 import。
  const imports = [...source.matchAll(/^import[\s\S]*?from "([^"]+)";/gm)].map(
    (m) => m[1],
  );
  expect(imports.length).toBeGreaterThan(0);
  for (const spec of imports)
    expect(spec.startsWith("node:") || spec.startsWith("./")).toBe(true);
});

// ---- (d) wiring：断言钉在 YAML 上，并把 run 块原样执行 ----

const workflow = () => YAML.parse(readFileSync(join(ROOT, WORKFLOW), "utf8"));
const stepsOf = () => workflow().jobs["merge-gate"].steps;
const stepNamed = (name) => stepsOf().find((s) => s.name === name);

test("(d) workflow 真的调用脚本：job 名＝required check 名，取数步骤产出四份输入", () => {
  const wf = workflow();
  expect(Object.keys(wf.jobs)).toEqual(["merge-gate"]);
  const collect = stepNamed("collect inputs");
  for (const name of [
    "event.json",
    "pr.json",
    "issue.json",
    "checks.json",
    "infra.json",
  ])
    expect(collect.run).toContain(".gate/" + name);
  expect(collect.run).toContain(
    "node scripts/merge-gate.mjs --event .gate/event.json --pr .gate/pr.json --print-issue",
  );
  expect(stepNamed("gate").run).toBe(
    "node scripts/merge-gate.mjs --event .gate/event.json --pr .gate/pr.json --issue .gate/issue.json --checks .gate/checks.json --infra .gate/infra.json",
  );
  // 取数要的权限与 PR head 检出：门牌文件靠 git cat-file 取证，check runs 靠 checks: read。
  expect(wf.permissions).toMatchObject({
    contents: "read",
    issues: "read",
    checks: "read",
  });
  expect(stepsOf()[0].with.ref).toBe(
    "${{ github.event.pull_request.head.sha }}",
  );
  // 门要跟着评论/审查变化重算，否则红绿会停在旧结论上。
  expect(JSON.stringify(wf.on)).toContain("pull_request_review");
});

test("(e) 等上游：触发点、排除自己、取数顺序都钉在 YAML 上", () => {
  const wf = workflow();
  const names = stepsOf().map((s) => s.name);
  const wait = stepNamed("wait for upstream to settle");
  // 等的是别人的最终结论：自己（SELF）必须排除，否则自己 in_progress 就死等。
  expect(wait.env.SELF).toBe("merge-gate");
  expect(wait.run).toContain("process.env.SELF");
  expect(wait.run).toContain("/check-runs");
  expect(wait.run).toContain('x.status !== "completed"');
  // 有上限，且超时只 warn 不判红：结论仍由门给（未就绪），不靠睡够碰运气。
  expect(Number(wait.env.DEADLINE_SECONDS)).toBeGreaterThan(0);
  expect(wait.run).toContain("::warning::");
  expect(wait.run).not.toMatch(/exit 1/);
  // 等待必须排在取数之前：取的是终态，不是起跑时的半截。
  expect(names.indexOf("wait for upstream to settle")).toBeLessThan(
    names.indexOf("collect inputs"),
  );
  // 正文取现况（pulls/N），不是事件里的快照 —— 否则等到天亮也读到旧正文。
  expect(stepNamed("collect inputs").run).toContain("/pulls/$NUMBER");
  // 生产者名只有一个家（脚本常量），这里钉住它与 last-change 的 job 键一致。
  expect(readFileSync(SCRIPT, "utf8")).toContain('const PRODUCER = "render";');
  const producer = YAML.parse(
    readFileSync(join(ROOT, ".github/workflows/last-change.yml"), "utf8"),
  );
  expect(Object.keys(producer.jobs)).toEqual(["render"]);
  // 人工编辑仍会重跑（自动写回不会：GITHUB_TOKEN 的改动不触发 workflow）。
  expect(wf.on.pull_request.types).toContain("edited");
});

test("(d) 把 YAML 的 gate 步骤原样跑起来：它真的连着四守卫", () => {
  const run = stepNamed("gate").run;
  expect(run).not.toMatch(/\$\{\{/); // 没有插值才能原样执行
  const g = gate();
  const exec = () =>
    spawnSync("bash", ["-c", run], {
      cwd: g.dir,
      encoding: "utf8",
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
    });
  const pass = exec();
  expect(pass.status).toBe(0);
  expect(lastLine(pass.stdout)).toBe("merge-gate PASS 4/4");
  // 同一段 YAML，只把 checks 输入改成一条 failure：步骤必须变红。
  writeFileSync(
    join(g.dir, ".gate", "checks.json"),
    JSON.stringify({
      total_count: 4,
      check_runs: [
        ...green(g.head),
        {
          id: 99,
          name: "audit",
          status: "completed",
          conclusion: "failure",
          head_sha: g.head,
        },
      ],
    }),
  );
  const red = exec();
  expect(red.status).toBe(1);
  expect(red.stdout).toContain("FAIL E_CHECK_NOT_GREEN");
});
