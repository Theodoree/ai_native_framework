import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { main, parseArgs, renderCommand } from "../scripts/audit-collect.mjs";

const SHA = "ed47559033ba2d1fe80eecfd14580619474de80e";
const OTHER_SHA = "1111111111111111111111111111111111111111";
// 发起时间与 run 的 createdAt 都从这里派生：测试里的时钟是假的，不用真等。
const START = Date.parse("2024-05-01T00:00:00.000Z");
const iso = (offsetMs) => new Date(START + offsetMs).toISOString();

const finding = (over = {}) => ({
  path: "scripts/merge-gate.mjs",
  line: 325,
  severity: "high",
  criterion: "required check 只认 success",
  suggestion: "把 neutral 也算通过的判断去掉",
  ...over,
});

const slotResult = (executor, agent, over = {}) => ({
  verdict: "needs_revision",
  findings: [finding()],
  evidence: {
    executor,
    agent,
    model: "google/gemini-2.5-pro",
    request_id: "req_0123456789",
  },
  ...over,
});

let ws;
const tempDirs = [];

function writeFile(dir, name, value) {
  const path = join(dir, name);
  writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value, null, 2) + "\n");
  return path;
}

beforeEach(() => {
  ws = { dir: mkdtempSync(join(tmpdir(), "audit-collect-")), a: null, b: null };
  tempDirs.push(ws.dir);
  ws.a = writeFile(ws.dir, "a.json", slotResult("sandbox", "review-a"));
  ws.b = writeFile(ws.dir, "b.json", slotResult("github", "review-b"));
});

afterEach(() => {
  while (tempDirs.length > 0) rmSync(tempDirs.pop(), { recursive: true, force: true });
});

const ok = (stdout = "") => ({ status: 0, stdout, stderr: "" });

// 假替身：逐次记录 args，任何意外的 gh 调用都当场失败（避免「测试通过但其实联网了」）。
function harness(over = {}) {
  const calls = [];
  const clock = { t: START };
  const pr = over.pr ?? { headRefOid: SHA, headRefName: "feat/p14-trust-root", state: "OPEN" };
  const pages = over.pages ?? [[{ databaseId: 900, headSha: SHA, createdAt: iso(5000), status: "completed" }]];
  let pageIndex = 0;
  const apiLines = over.apiLines ?? [
    JSON.stringify({ id: 77, name: "audit", conclusion: "success", title: "audit pass", summary: "agreed=1" }),
  ];

  const gh = (args) => {
    calls.push(args);
    if (over.gh) {
      const forced = over.gh(args);
      if (forced) return forced;
    }
    if (args[0] === "pr" && args[1] === "view") return ok(JSON.stringify(pr));
    if (args[0] === "workflow" && args[1] === "run") return ok("");
    if (args[0] === "run" && args[1] === "list") {
      const page = pages[Math.min(pageIndex, pages.length - 1)];
      pageIndex += 1;
      return typeof page === "function" ? page() : ok(JSON.stringify(page));
    }
    if (args[0] === "api") return ok(apiLines.join("\n") + "\n");
    throw new Error("意外的 gh 调用: " + args.join(" "));
  };

  const out = [];
  const err = [];
  const deps = {
    gh,
    now: () => clock.t,
    sleep: async (ms) => {
      clock.t += ms;
    },
    intervalMs: 1000,
    out: (line) => out.push(line),
    err: (line) => err.push(line),
  };
  const count = (kind, action) =>
    calls.filter((args) => args[0] === kind && (action ? args[1] === action : true)).length;
  return { calls, clock, deps, out, err, count, pr, pages };
}

const base = () => ["--pr", "14", "--a", ws.a, "--b", ws.b];

describe("参数与用法（退出 2，什么都不发）", () => {
  it("缺 --pr 回 2 并点名参数，且一次 gh 都没调", async () => {
    const h = harness();
    const code = await main(["--a", ws.a, "--b", ws.b], h.deps);
    expect(code).toBe(2);
    expect(h.err.join("\n")).toContain("--pr");
    expect(h.calls).toHaveLength(0);
  });

  it("缺 --b 回 2 并点名 --b", async () => {
    const h = harness();
    const code = await main(["--pr", "14", "--a", ws.a], h.deps);
    expect(code).toBe(2);
    expect(h.err.join("\n")).toContain("--b");
    expect(h.calls).toHaveLength(0);
  });

  it("findings 文件不存在回 2 并点名 --a 与路径", async () => {
    const h = harness();
    const missing = join(ws.dir, "nope.json");
    const code = await main(["--pr", "14", "--a", missing, "--b", ws.b], h.deps);
    expect(code).toBe(2);
    const stderr = h.err.join("\n");
    expect(stderr).toContain("--a");
    expect(stderr).toContain(missing);
    expect(h.calls).toHaveLength(0);
  });

  it("--pr 不是正整数回 2", () => {
    expect(parseArgs(["--pr", "0", "--a", "x", "--b", "y"]).ok).toBe(false);
    expect(parseArgs(["--pr", "abc", "--a", "x", "--b", "y"]).ok).toBe(false);
  });

  it("--timeout 非正整数回 2", () => {
    const parsed = parseArgs(["--pr", "14", "--a", ws.a, "--b", ws.b, "--timeout", "0"]);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain("--timeout");
  });
});

describe("PR 状态与本地预检（退出 3，绝不发 workflow）", () => {
  it("PR 不是 OPEN 回 3，且没有 workflow run", async () => {
    const h = harness({ pr: { headRefOid: SHA, headRefName: "feat/x", state: "MERGED" } });
    const code = await main(base(), h.deps);
    expect(code).toBe(3);
    expect(h.count("workflow", "run")).toBe(0);
    expect(h.out[0]).toContain("不是 OPEN");
  });

  it("预检不合格（占位符 model）回 3 且绝不发 workflow，原因原样打印", async () => {
    const a = writeFile(ws.dir, "bad-a.json", slotResult("sandbox", "review-a", {
      evidence: { executor: "sandbox", agent: "review-a", model: "pending-review-a", request_id: "req_1" },
    }));
    const h = harness();
    const code = await main(["--pr", "14", "--a", a, "--b", ws.b], h.deps);
    expect(code).toBe(3);
    expect(h.count("workflow", "run")).toBe(0);
    const stdout = h.out.join("\n");
    expect(stdout).toContain("evidence.model: 占位符");
    expect(stdout).toContain("本地预检不合格");
  });

  it("两个槽自报同一执行器回 3（双执行器前提消失），且没有 workflow run", async () => {
    const b = writeFile(ws.dir, "dup-b.json", slotResult("sandbox", "review-a"));
    const h = harness();
    const code = await main(["--pr", "14", "--a", ws.a, "--b", b], h.deps);
    expect(code).toBe(3);
    expect(h.count("workflow", "run")).toBe(0);
    expect(h.out.join("\n")).toContain("两个槽自报同一个执行器");
  });

  it("findings 不是合法 JSON 回 3 且没有 workflow run", async () => {
    const a = writeFile(ws.dir, "broken.json", "{ not json");
    const h = harness();
    const code = await main(["--pr", "14", "--a", a, "--b", ws.b], h.deps);
    expect(code).toBe(3);
    expect(h.count("workflow", "run")).toBe(0);
    expect(h.out.join("\n")).toContain("不是合法 JSON");
  });
});

describe("--dry-run", () => {
  it("回 0、不发 workflow、打印含 -f pr= 与 --ref 与目标 sha", async () => {
    const h = harness();
    const code = await main([...base(), "--dry-run"], h.deps);
    expect(code).toBe(0);
    expect(h.count("workflow", "run")).toBe(0);
    expect(h.count("run", "list")).toBe(0);
    const stdout = h.out.join("\n");
    expect(stdout).toContain("-f pr=14");
    expect(stdout).toContain("--ref feat/p14-trust-root");
    expect(stdout).toContain(SHA);
    // 取值含换行时按 JSON 转义展示（否则一行命令会被贴成几十行），-f 与名字仍在。
    expect(stdout).toMatch(/-f "?findings_a=/);
    expect(stdout).toMatch(/-f "?findings_b=/);
  });

  it("显式 --ref 覆盖 headRefName，且打印里出现给了的那个分支", async () => {
    const h = harness();
    const code = await main([...base(), "--dry-run", "--ref", "develop"], h.deps);
    expect(code).toBe(0);
    expect(h.out.join("\n")).toContain("--ref develop");
  });

  it("--dry-run 在 PR 非 OPEN 时仍只打印并发 0（它什么都不发）", async () => {
    const h = harness({ pr: { headRefOid: SHA, headRefName: "feat/x", state: "CLOSED" } });
    const code = await main([...base(), "--dry-run"], h.deps);
    expect(code).toBe(0);
    expect(h.count("workflow", "run")).toBe(0);
    expect(h.out.join("\n")).toContain("不是 OPEN");
  });

  it("renderCommand 把 -f 与取值渲染成一段，换行取值用 JSON 形态展示", () => {
    expect(renderCommand(["workflow", "run", "audit.yml", "-f", "pr=14"])).toBe(
      "gh workflow run audit.yml -f pr=14",
    );
    const rendered = renderCommand(["-f", 'a={\n"x":1}']);
    expect(rendered.includes("\n")).toBe(false);
    expect(rendered).toContain("a=");
  });
});

describe("发起与轮询", () => {
  it("workflow run 失败回 3，并摘要原始 stderr", async () => {
    const h = harness({
      gh: (args) =>
        args[0] === "workflow" && args[1] === "run"
          ? { status: 1, stdout: "", stderr: "HTTP 422: Workflow does not have 'workflow_dispatch'" }
          : null,
    });
    const code = await main(base(), h.deps);
    expect(code).toBe(3);
    expect(h.out.join("\n")).toContain("第 3 步");
    expect(h.out.join("\n")).toContain("HTTP 422");
  });

  it("发起参数是 args 数组：-f 与取值分开，findings 是文件原文", async () => {
    const h = harness();
    await main(base(), h.deps);
    const sent = h.calls.find((args) => args[0] === "workflow" && args[1] === "run");
    expect(sent.slice(0, 5)).toEqual(["workflow", "run", "audit.yml", "--ref", "feat/p14-trust-root"]);
    expect(sent).toContain("pr=14");
    const findingsA = sent.find((arg) => arg.startsWith("findings_a="));
    expect(findingsA.startsWith("findings_a={")).toBe(true);
    expect(findingsA).toContain('"executor": "sandbox"');
    expect(sent.some((arg) => arg.includes("&&") || arg.includes("|"))).toBe(false);
  });

  it("命中同 sha 的 run 并读到结论", async () => {
    const h = harness();
    const code = await main(base(), h.deps);
    expect(code).toBe(0);
    expect(h.count("run", "list")).toBe(1);
  });

  it("不受同 sha 上旧 run（createdAt 早于发起时间）影响：超时回 3", async () => {
    const h = harness({
      pages: [
        [{ databaseId: 1, headSha: SHA, createdAt: iso(-60_000), status: "completed" }],
      ],
    });
    const code = await main([...base(), "--timeout", "3"], h.deps);
    expect(code).toBe(3);
    expect(h.out.join("\n")).toContain("轮询超时");
  });

  it("不比对 sha 就会错认：别的 sha 的 completed run 不算命中（超时回 3）", async () => {
    const h = harness({ pages: [[{ databaseId: 2, headSha: OTHER_SHA, createdAt: iso(5000), status: "completed" }]] });
    const code = await main([...base(), "--timeout", "3"], h.deps);
    expect(code).toBe(3);
    expect(h.out.join("\n")).toContain("轮询超时");
    expect(h.count("run", "list")).toBeGreaterThan(1);
  });

  it("还在跑的 run 会继续轮询，结束后再读结论", async () => {
    const h = harness({
      pages: [
        [{ databaseId: 900, headSha: SHA, createdAt: iso(1000), status: "in_progress" }],
        [{ databaseId: 900, headSha: SHA, createdAt: iso(1000), status: "in_progress" }],
        [{ databaseId: 900, headSha: SHA, createdAt: iso(1000), status: "completed" }],
      ],
    });
    const code = await main(base(), h.deps);
    expect(code).toBe(0);
    expect(h.count("run", "list")).toBe(3);
  });

  it("轮询超时回 3", async () => {
    const h = harness({ pages: [[]] });
    const code = await main([...base(), "--timeout", "3"], h.deps);
    expect(code).toBe(3);
    expect(h.out.join("\n")).toContain("第 4 步 轮询超时");
    expect(h.count("run", "list")).toBeGreaterThan(1);
    expect(h.count("api")).toBe(0);
  });
});

describe("Check Run 与结论映射", () => {
  const withConclusion = (conclusion, name = "audit") => ({
    apiLines: [JSON.stringify({ id: 77, name, conclusion, title: "audit " + conclusion, summary: "x".repeat(300) })],
  });

  it("success 回 0", async () => {
    const h = harness(withConclusion("success"));
    expect(await main(base(), h.deps)).toBe(0);
  });

  it("failure 回 1", async () => {
    const h = harness(withConclusion("failure"));
    expect(await main(base(), h.deps)).toBe(1);
  });

  it("action_required 回 3（判不了 / INFRA 不给绿）", async () => {
    const h = harness(withConclusion("action_required"));
    expect(await main(base(), h.deps)).toBe(3);
  });

  it("认不出的 conclusion（neutral / skipped / cancelled）一律回 3", async () => {
    for (const conclusion of ["neutral", "skipped", "cancelled", "timed_out"]) {
      const h = harness(withConclusion(conclusion));
      expect(await main(base(), h.deps)).toBe(3);
    }
  });

  it("没有 audit check run 回 3，并点名读到了哪些名字", async () => {
    const h = harness({
      apiLines: [JSON.stringify({ id: 5, name: "audit-runner", conclusion: "success", title: "job", summary: "" })],
    });
    const code = await main(base(), h.deps);
    expect(code).toBe(3);
    const stdout = h.out.join("\n");
    expect(stdout).toContain("没有 name=audit 的 check run");
    expect(stdout).toContain("audit-runner");
  });

  it("同名多条取 id 最大者（与 merge-gate 读结论的口径一致）", async () => {
    const h = harness({
      apiLines: [
        JSON.stringify({ id: 10, name: "audit", conclusion: "failure", title: "旧", summary: "" }),
        JSON.stringify({ id: 11, name: "audit", conclusion: "success", title: "新", summary: "" }),
      ],
    });
    expect(await main(base(), h.deps)).toBe(0);
  });

  it("输出先给一行结论，summary 截到 200 字", async () => {
    const h = harness(withConclusion("success"));
    await main(base(), h.deps);
    expect(h.out[0]).toContain("conclusion=success");
    expect(h.out[0]).toContain("exit=0");
    const summaryLine = h.out.find((line) => line.startsWith("summary"));
    expect(summaryLine).toContain("x".repeat(200));
    expect(summaryLine).not.toContain("x".repeat(201));
  });
});

describe("--json", () => {
  it("只有一行 JSON，字段齐全", async () => {
    const h = harness();
    const code = await main([...base(), "--json"], h.deps);
    expect(code).toBe(0);
    expect(h.out).toHaveLength(1);
    const payload = JSON.parse(h.out[0]);
    expect(Object.keys(payload).sort()).toEqual(
      ["checkRunId", "conclusion", "exitCode", "pr", "ref", "runId", "sha", "title"].sort(),
    );
    expect(payload).toMatchObject({
      pr: 14,
      sha: SHA,
      ref: "feat/p14-trust-root",
      runId: 900,
      checkRunId: 77,
      conclusion: "success",
      title: "audit pass",
      exitCode: 0,
    });
  });

  it("失败路径也只有一行 JSON（action_required）", async () => {
    const h = harness({
      apiLines: [JSON.stringify({ id: 8, name: "audit", conclusion: "action_required", title: "audit INFRA", summary: "" })],
    });
    const code = await main([...base(), "--json"], h.deps);
    expect(code).toBe(3);
    expect(h.out).toHaveLength(1);
    expect(JSON.parse(h.out[0])).toMatchObject({ conclusion: "action_required", exitCode: 3, checkRunId: 8 });
  });

  it("没有 check run 时也只有一行 JSON，conclusion 为 null", async () => {
    const h = harness({ apiLines: [] });
    const code = await main([...base(), "--json"], h.deps);
    expect(code).toBe(3);
    expect(h.out).toHaveLength(1);
    const payload = JSON.parse(h.out[0]);
    expect(payload.conclusion).toBe(null);
    expect(payload.checkRunId).toBe(null);
    expect(payload.exitCode).toBe(3);
  });
});

// 入口判定必须走 realpath：worktree / 软链下 argv[1] 与 import.meta.url 不是同一条字面路径，
// 认不出自己就会静默退出 0 —— 对门来说那是最坏的失败形态（看起来绿）。
describe("入口判定（软链下也必须真的跑起来）", () => {
  it("从软链路径执行时仍然进入 main，而不是静默 exit 0", () => {
    const dir = mkdtempSync(join(tmpdir(), "audit-collect-entry-"));
    const link = join(dir, "audit-collect.mjs");
    symlinkSync(fileURLToPath(new URL("../scripts/audit-collect.mjs", import.meta.url)), link);
    const run = spawnSync(process.execPath, [link], { encoding: "utf8" });
    // 无参数就是用法错误：2 且 stderr 说清楚。静默 exit 0 会让调用方以为「判过了」。
    expect(run.status).toBe(2);
    expect(run.stderr).toContain("用法");
    rmSync(dir, { recursive: true, force: true });
  });
});
