import { describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import {
  assess,
  compareFindings,
  normalizeVerdict,
  run,
  toCheckConclusion,
  validateResult,
  workflowExitFor,
} from "../scripts/audit-findings.mjs";

const ROOT = process.cwd();
const WORKFLOW = ".github/workflows/audit.yml";
const SCRIPT = join(ROOT, "scripts/audit-findings.mjs");

const finding = (over = {}) => ({
  path: "scripts/merge-gate.mjs",
  line: 325,
  severity: "high",
  criterion: "required check 只认 success",
  suggestion: "把 neutral 也算通过的判断去掉",
  ...over,
});

const result = (over = {}) => ({
  verdict: "pass",
  findings: [],
  evidence: {
    executor: "sandbox",
    agent: "review-a",
    model: "vendor/model-1",
    request_id: "req_8f2c1d",
  },
  ...over,
});

describe("validateResult", () => {
  it("接受合法结果", () => {
    const out = validateResult(result({ findings: [finding()] }));
    expect(out.errors).toEqual([]);
    expect(out.ok).toBe(true);
  });

  it("缺字段要点名到 path.field", () => {
    const bad = finding();
    delete bad.suggestion;
    const out = validateResult(result({ findings: [bad] }));
    expect(out.ok).toBe(false);
    expect(out.errors.join("\n")).toContain("findings[0].suggestion");
  });

  it("severity 非法枚举要报出实际值", () => {
    const out = validateResult(
      result({ findings: [finding({ severity: "critical" })] }),
    );
    expect(out.ok).toBe(false);
    expect(out.errors.join("\n")).toContain("findings[0].severity");
    expect(out.errors.join("\n")).toContain("\"critical\"");
  });

  it("line 必须是正整数", () => {
    const out = validateResult(result({ findings: [finding({ line: "325" })] }));
    expect(out.errors.join("\n")).toContain("findings[0].line");
  });

  it("verdict 非法枚举要报错", () => {
    const out = validateResult(result({ verdict: "ok" }));
    expect(out.errors.join("\n")).toContain("verdict");
  });

  it("占位符 model 不算证据", () => {
    // pending-* 是本仓自己承认的占位值（见 .agents/platform/routing.yml），
    // 漏了它，"没跑到" 就能写成 "跑到并通过"。
    for (const model of [
      "",
      "unknown",
      "TODO",
      "n/a",
      "unset",
      "pending",
      "pending-review-a",
      "PENDING-impl",
    ]) {
      const out = validateResult(result({ evidence: { ...result().evidence, model } }));
      expect(out.ok).toBe(false);
      expect(out.errors.join("\n")).toContain("evidence.model");
    }
  });

  it("路由表里声明的 pending-* 一律判不合格（真源：.agents/platform/routing.yml）", () => {
    // 这一条不引用脚本里的常量表：它读的是仓库声明的占位值本身。
    // 表只覆盖「你想得到的那几个词」，真源覆盖「仓库实际在用的那几个」。
    const routes = YAML.parse(readFileSync(join(ROOT, ".agents/platform/routing.yml"), "utf8")).routes;
    const pending = routes
      .map((route) => route.model)
      .filter((model) => typeof model === "string" && /^pending-/i.test(model));
    expect(pending.length).toBeGreaterThan(0);
    for (const model of pending) {
      const declared = result({ evidence: { ...result().evidence, model } });
      const out = validateResult(declared);
      expect(out.ok, model).toBe(false);
      expect(out.errors.join("\n")).toContain("evidence.model");
      // 口径是「没判过」，不是「判成不合格」。
      expect(assess({ a: declared }).conclusion).toBe("action_required");
    }
  });

  it("占位符 request_id 不算证据", () => {
    for (const requestId of ["", "unknown", "todo", "n/a", "unset"]) {
      const out = validateResult(
        result({ evidence: { ...result().evidence, request_id: requestId } }),
      );
      expect(out.ok).toBe(false);
      expect(out.errors.join("\n")).toContain("evidence.request_id");
    }
  });
});

describe("normalizeVerdict", () => {
  it("全 pass -> pass", () => {
    expect(normalizeVerdict([result(), result()])).toBe("pass");
  });
  it("任一 needs_revision -> needs_revision", () => {
    expect(
      normalizeVerdict([result(), result({ verdict: "needs_revision" })]),
    ).toBe("needs_revision");
  });
  it("任一 reject -> reject（压过 needs_revision）", () => {
    expect(
      normalizeVerdict([
        result(),
        result({ verdict: "needs_revision" }),
        result({ verdict: "reject" }),
      ]),
    ).toBe("reject");
  });
  it("任一 INFRA -> INFRA（压过 reject）", () => {
    expect(
      normalizeVerdict([result({ verdict: "reject" }), result({ verdict: "INFRA" })]),
    ).toBe("INFRA");
  });
  it("schema 不合格按 INFRA 计，绝不按 pass", () => {
    const broken = result({ findings: [finding({ severity: "critical" })] });
    expect(normalizeVerdict([broken, result()])).toBe("INFRA");
  });
  it("没有结果也是 INFRA（空集合不读成通过）", () => {
    expect(normalizeVerdict([])).toBe("INFRA");
  });
});

describe("compareFindings", () => {
  const shared = finding();
  const onlyA = finding({ path: "scripts/a.mjs", line: 7, criterion: "只有 A 看见" });
  const onlyB = finding({ path: "scripts/b.mjs", line: 9, criterion: "只有 B 看见" });
  const out = compareFindings(
    { findings: [shared, onlyA, finding({ path: "scripts/c.mjs", line: 3, criterion: "严重度不一致", severity: "low" })] },
    { findings: [shared, onlyB, finding({ path: "scripts/c.mjs", line: 3, criterion: "严重度不一致", severity: "blocker" })] },
  );

  it("agreed：path+line+criterion 相同且 severity 相同", () => {
    expect(out.agreed).toHaveLength(1);
    expect(out.agreed[0].criterion).toBe("required check 只认 success");
  });
  it("onlyA / onlyB 各归一边", () => {
    expect(out.onlyA.map((f) => f.criterion)).toEqual(["只有 A 看见"]);
    expect(out.onlyB.map((f) => f.criterion)).toEqual(["只有 B 看见"]);
  });
  it("severityMismatch 单独列出且两边严重度都可见", () => {
    expect(out.severityMismatch).toHaveLength(1);
    expect(out.severityMismatch[0]).toMatchObject({
      path: "scripts/c.mjs",
      line: 3,
      severityA: "low",
      severityB: "blocker",
    });
  });
  it("计数与同步率自洽", () => {
    expect(out.counts).toEqual({ agreed: 1, onlyA: 1, onlyB: 1, severityMismatch: 1 });
    expect(out.agreementRate).toBeCloseTo(0.25);
  });
  it("接受裸 findings 数组", () => {
    expect(compareFindings([shared], [shared]).agreed).toHaveLength(1);
  });
  it("非对象元素不参与比对：null/字符串/数组不是一条缺陷，也不许被解引用", () => {
    const out = compareFindings({ findings: [shared, null, "x", ["y"]] }, { findings: [shared] });
    expect(out.agreed).toHaveLength(1);
    expect(out.counts).toEqual({ agreed: 1, onlyA: 0, onlyB: 0, severityMismatch: 0 });
  });
});

describe("toCheckConclusion", () => {
  // GitHub 只把 success / skipped / neutral 算通过；
  // neutral 会放行 required check，所以 INFRA 不能用它。
  const PASSING = ["success", "skipped", "neutral"];

  it("pass -> success", () => {
    expect(toCheckConclusion("pass")).toBe("success");
  });
  it("needs_revision / reject -> failure", () => {
    expect(toCheckConclusion("needs_revision")).toBe("failure");
    expect(toCheckConclusion("reject")).toBe("failure");
  });
  it("INFRA 的 conclusion 不在通过集合里", () => {
    const conclusion = toCheckConclusion("INFRA");
    expect(conclusion).toBe("action_required");
    expect(PASSING).not.toContain(conclusion);
  });
  it("认不出的 verdict 也不给绿", () => {
    expect(PASSING).not.toContain(toCheckConclusion("whatever"));
  });
});

describe("退出码", () => {
  const run = (a, b) => {
    const dir = mkdtempSync(join(tmpdir(), "audit-exit-"));
    const write = (name, body) => {
      const path = join(dir, name);
      writeFileSync(path, JSON.stringify(body));
      return path;
    };
    // 两个槽各写一个执行器：同一份证据填两槽是跨槽不变式要判 INFRA 的情形，
    // 而这里测的是 verdict -> 退出码，不是槽位身份。
    const seat = (body, executor, agent) => ({
      ...body,
      evidence: { ...body.evidence, executor, agent },
    });
    const args = [SCRIPT, "--a", write("a.json", seat(a, "sandbox", "review-a"))];
    if (b) args.push("--b", write("b.json", seat(b, "github", "review-b")));
    const out = join(dir, "result.json");
    args.push("--out", out);
    const spawned = spawnSync(process.execPath, args, { encoding: "utf8" });
    return { code: spawned.status, stdout: spawned.stdout, result: JSON.parse(readFileSync(out, "utf8")) };
  };

  it("pass -> 0", () => {
    const { code, result: parsed, stdout } = run(result(), result());
    expect(code).toBe(0);
    expect(parsed.verdict).toBe("pass");
    expect(parsed.conclusion).toBe("success");
    expect(stdout).toContain("audit-findings compare agreed=0");
  });
  it("needs_revision -> 1", () => {
    const { code, result: parsed } = run(result(), result({ verdict: "needs_revision" }));
    expect(code).toBe(1);
    expect(parsed.conclusion).toBe("failure");
  });
  it("reject -> 1", () => {
    const { code, result: parsed } = run(result({ verdict: "reject" }), result());
    expect(code).toBe(1);
    expect(parsed.verdict).toBe("reject");
  });
  it("INFRA -> 3 且 conclusion 不给绿", () => {
    const { code, result: parsed } = run(result({ verdict: "INFRA" }), result());
    expect(code).toBe(3);
    expect(parsed.conclusion).toBe("action_required");
  });
  it("单执行器时跳过比对", () => {
    const { code, stdout } = run(result());
    expect(code).toBe(0);
    expect(stdout).toContain("compare skipped");
  });
  it("读不到的输入按 INFRA 记", () => {
    const dir = mkdtempSync(join(tmpdir(), "audit-missing-"));
    const spawned = spawnSync(
      process.execPath,
      [SCRIPT, "--a", join(dir, "nope.json")],
      { encoding: "utf8" },
    );
    expect(spawned.status).toBe(3);
    expect(spawned.stdout).toContain("读不到输入");
  });

  // 下面三条各自钉一件事：不崩、不伪造注解、两个退出码不混。
  // 三条都走真进程（spawn 脚本），而不是调一个「测试专用入口」：
  // 崩溃与输出面是入口 + main 的产物，只测内部函数就等于没测。
  const seatFor = (body, executor, agent) => ({
    ...body,
    evidence: { ...body.evidence, executor, agent },
  });
  const runSeats = (a, b) => {
    const dir = mkdtempSync(join(tmpdir(), "audit-cli-"));
    const write = (name, body) => {
      const path = join(dir, name);
      writeFileSync(path, JSON.stringify(body));
      return path;
    };
    const out = join(dir, "result.json");
    const spawned = spawnSync(
      process.execPath,
      [SCRIPT, "--a", write("a.json", a), "--b", write("b.json", b), "--out", out],
      { encoding: "utf8" },
    );
    return { spawned, out, dir, read: () => JSON.parse(readFileSync(out, "utf8")) };
  };

  it("findings 里有 null 元素：不崩，schema 不合格落 INFRA，且照样写出 result.json", () => {
    // 崩掉的代价不是「少打一行」：没有 result.json，workflow 既写不出 Check Run
    // 也没有 INFRA 留痕，上一个 sha 上的 success 会原样留着 —— 一次失败变成一次假绿。
    const { spawned, read } = runSeats(
      seatFor({ ...result(), findings: [finding(), null] }, "sandbox", "review-a"),
      seatFor({ ...result(), findings: [finding()] }, "github", "review-b"),
    );
    expect(spawned.stderr).not.toContain("TypeError");
    expect(spawned.status).toBe(3);
    const parsed = read();
    expect(parsed.conclusion).toBe("action_required");
    expect(spawned.stdout).toContain("findings[1]: 必须是对象");
    // 两个码的读者不同：脚本自己 3（INFRA），job 级读到的 exit 是 0（红由 Check Run 承载）。
    expect(parsed.exit_code).toBe(3);
    expect(parsed.exit).toBe(0);
  });

  it("来自输入的换行不许变成第二行，更不许凭空长出一条 :: 注解", () => {
    const forged =
      "看着像一条判据\n::error title=forged annotation::pwned\r\n::warning::also forged";
    const { spawned } = runSeats(
      seatFor({ ...result(), findings: [finding({ criterion: forged })] }, "sandbox", "review-a"),
      seatFor(result(), "github", "review-b\n::error::from-agent"),
    );
    const lines = spawned.stdout.split("\n");
    // 一行都不是注解：注解是 stdout 每一行的前缀，一行由输入构造，就是一条伪造注解。
    expect(lines.filter((line) => line.startsWith("::"))).toEqual([]);
    // 修法不是把证据丢掉：文本还在，只是被压成一行。
    const carried = lines.find((line) => line.includes("forged annotation"));
    expect(carried).toBeDefined();
    expect(carried).toContain("看着像一条判据");
    expect(carried).toContain("pwned");
    expect(carried).toContain("also forged");
    expect(lines.some((line) => line.includes("from-agent"))).toBe(true);
  });

  it("两个退出码不混：只有 failure 让 job 红，action_required 不染 job", () => {
    // job 级 check 不是第二个结论写者：它的红会把「未判过」说成「代码不合格」。
    expect(workflowExitFor("success")).toBe(0);
    expect(workflowExitFor("action_required")).toBe(0);
    expect(workflowExitFor("failure")).toBe(1);
  });
});

describe("崩溃兜底", () => {
  it("任何未预期异常也必须产出 result.json：宁可写一条 INFRA，也不许留空", () => {
    // 崩溃面最容易被忽略的一处：结论已经算出来了，死在把它写出去的路上。
    // 用「stdout 写第一行就抛」来注入一个未预期异常，走到的是真入口函数 run()。
    const dir = mkdtempSync(join(tmpdir(), "audit-crash-"));
    const a = join(dir, "a.json");
    writeFileSync(a, JSON.stringify(result()));
    const out = join(dir, "result.json");
    const write = vi
      .spyOn(process.stdout, "write")
      .mockImplementationOnce(() => {
        throw new Error("stdout 挂了");
      });
    let code;
    try {
      code = run(["--a", a, "--out", out]);
    } finally {
      write.mockRestore();
    }
    expect(code).toBe(3);
    const parsed = JSON.parse(readFileSync(out, "utf8"));
    expect(parsed.conclusion).toBe("action_required");
    expect(parsed.exit_code).toBe(3);
    expect(parsed.exit).toBe(0);
    expect(String(parsed.reason)).toContain("口径层崩溃");
    expect(String(parsed.reason)).toContain("stdout 挂了");
  });
});

describe("跨槽不变式", () => {
  it("两个槽自报同一个执行器 -> INFRA（一份意见不许记成两票）", () => {
    const same = result({
      evidence: { ...result().evidence, executor: "github", agent: "review-b" },
    });
    const out = assess({ a: same, b: same });
    expect(out.verdict).toBe("INFRA");
    expect(out.conclusion).toBe("action_required");
    expect(out.executors.map((e) => e.reason).join("\n")).toContain("同一个执行器");
  });

  it("两个槽不同执行器时不受影响", () => {
    const other = result({ evidence: { ...result().evidence, executor: "github", agent: "review-b" } });
    expect(assess({ a: result(), b: other }).verdict).toBe("pass");
  });
});

describe("wiring: .github/workflows/audit.yml", () => {
  // 路由不进 CI：真实模型名一旦出现在 workflow，两个执行器就退化成同一家模型，
  // 而「两边结论不一致」这个信号也就没了。这里把这条钉死。
  const VENDOR = /\b(gpt|o1|o3|claude|sonnet|opus|haiku|gemini|deepseek|qwen|llama|mistral|grok|kimi|glm)\b/i;
  const doc = YAML.parse(readFileSync(join(ROOT, WORKFLOW), "utf8"));
  const job = doc.jobs["audit-runner"];
  const steps = job.steps;

  it("判定结论只有一条 Check Run 承载：job 不叫 audit", () => {
    // 同名会让同一事实有两个写者：job 的 failure 与 POST 的 action_required 抢同一个名字，
    // 按 name 取 latest 时 INFRA 会被读成 FAIL，读者就分不清「判不了」和「真没过」。
    expect(Object.keys(doc.jobs)).toEqual(["audit-runner"]);
    expect(job.name).toBe("audit-runner");
    const posted = steps.filter((s) => s.run?.includes("--input .audit/check-run.json"));
    expect(posted).toHaveLength(2);
    // payload 的写者可以多于一处（判定 / 兜底 / 判不了），但每一处写的名字都必须是 audit：
    // 名字一旦换成 job 名（audit-runner），job 的红与结论的红就抢同一个名字。
    const writers = steps.filter(
      (s) => s.run?.includes("check-run.json") && s.run.includes('name: "audit"'),
    );
    expect(writers.length).toBeGreaterThanOrEqual(2);
    for (const step of steps) {
      expect(String(step.run ?? ""), step.name).not.toContain('name: "audit-runner"');
    }
  });

  it("权限最小：只开错误里用到的那几项，且 checks: write 是硬的", () => {
    expect(doc.permissions).toEqual({
      contents: "read",
      checks: "write",
      "pull-requests": "read",
    });
  });

  it("触发面只有手动：注入源就绪前不挂 PR（否则只会 action_required 把每次合并挡死）", () => {
    // 理由：merge-gate G3 要求非自身 check 全部 success，而本 job 在注入源就绪前只能产
    // action_required。挂上 pull_request 等于让仓库进入「每次合并都被自己挡」的结构性死锁。
    expect(Object.keys(doc.on)).toEqual(["workflow_dispatch"]);
  });

  it("真的回写 Check Run（不是只发评论）", () => {
    const calls = steps.filter((s) => typeof s.run === "string");
    const checkRun = calls.filter((s) => s.run.includes("repos/$GITHUB_REPOSITORY/check-runs"));
    expect(checkRun).toHaveLength(2);
    for (const step of checkRun) expect(step.run).toContain("--method POST");
    expect(checkRun[0].run).toContain("--input .audit/check-run.json");
    // 评论不算门：本文件不该出现 PR 评论调用。
    expect(calls.filter((s) => s.run.includes("pulls/") && s.run.includes("comments"))).toHaveLength(0);
  });

  it("用逻辑名，且 YAML 里没有真实模型名", () => {
    const text = readFileSync(join(ROOT, WORKFLOW), "utf8");
    expect(text).toContain("review-a");
    expect(text).toContain("review-b");
    expect(text).not.toMatch(VENDOR);
  });

  it("INFRA 显式留痕落在 workflow 摘要里", () => {
    const trace = steps.filter((s) => s.id === "infra" || String(s.name).includes("INFRA"));
    expect(trace).toHaveLength(2);
    expect(trace[0].run).toContain("$GITHUB_STEP_SUMMARY");
    expect(trace[0].if).toContain("action_required");
  });

  it("判定步骤把结论交给 Check Run，并保留脚本退出码", () => {
    const decide = steps.find((s) => s.id === "decide");
    expect(decide.run).toContain("scripts/audit-findings.mjs --a .audit/review-a.json --b .audit/review-b.json");
    expect(decide.run).toContain("check-run.json");
    const gate = steps.find((s) => s.name === "判定");
    expect(gate.run).toContain("steps.decide.outputs.exit");

    // findings 只经 env 进入脚本：内联进 run 就是一次 shell 拼接，
    // 上游 JSON 里一个引号或 $( ) 就能改写这条命令。
    for (const [name, key] of [
      ["落盘 review-a", "AUDIT_FINDINGS_A"],
      ["落盘 review-b", "AUDIT_FINDINGS_B"],
    ]) {
      const step = steps.find((s) => s.name === name);
      expect(step.env[key]).toContain("inputs.findings_" + (name.endsWith("a") ? "a" : "b"));
    }
    // 不逐个点名 key：手写清单只会覆盖你想到的那几个槽。任何 step 的 run 块里
    // 出现 inputs. 就是一次 shell 拼接，一律算违规。
    for (const step of steps) {
      if (!step.run) continue;
      expect(step.run, step.name).not.toContain("inputs.");
    }
    const ctxStep = steps.find((s) => s.name === "解析 PR 上下文");
    expect(ctxStep.env.PR_INPUT).toContain("inputs.pr");
  });

  it("写回与兜底都是 always()：前置步骤红了也必须把结论写到 sha 上", () => {
    // 少了 always()，一步红就把 Check Run 的写回跳过去，这次「判不了」退化成「沿用上一轮的绿」。
    // 这一半语义沙箱模拟不了（它不因上一步非 0 而跳过后续步骤），只能按形状钉死。
    for (const name of ["结论兜底", "回写 Check Run", "判不了：回写 INFRA"]) {
      const step = steps.find((s) => s.name === name);
      expect(step, name).toBeDefined();
      expect(String(step.if), name).toContain("always()");
    }
    // 兜底夹在判定与写回之间：在判定之前看不到「缺结论」，在写回之后改不动 payload。
    const order = steps.map((s) => s.name);
    expect(order.indexOf("结论兜底")).toBeGreaterThan(order.indexOf("口径层判定"));
    expect(order.indexOf("结论兜底")).toBeLessThan(order.indexOf("回写 Check Run"));
  });

  it("判定步骤没拿到退出码时退 3：没拿到不等于通过", () => {
    const gate = steps.find((s) => s.name === "判定");
    expect(gate.run).toContain("exit 3");
  });
});

describe("wiring: 真跑 YAML 的 run 块", () => {
  // 照 tests/state-writer-wiring.test.mjs 的办法：假 gh 记账到 calls.log，
  // 于是「到底调了哪个 API、payload 里 conclusion 是什么」是实测而不是读字面。
  const doc = YAML.parse(readFileSync(join(ROOT, WORKFLOW), "utf8"));
  const steps = doc.jobs["audit-runner"].steps;

  function sandbox() {
    const dir = mkdtempSync(join(tmpdir(), "audit-wf-"));
    cpSync(join(ROOT, "scripts"), join(dir, "scripts"), { recursive: true });
    symlinkSync(join(ROOT, "node_modules"), join(dir, "node_modules"));
    mkdirSync(join(dir, ".audit"), { recursive: true });
    const bin = join(dir, "bin");
    mkdirSync(bin, { recursive: true });
    const gh = [
      "#!/usr/bin/env bash",
      "echo \"$*\" >> \"$PWD/calls.log\"",
      "if [[ \"$*\" == *\"pr view\"* && \"$*\" == *\"headRefOid\"* ]]; then",
      "  printf 'cafebabe\\n'",
      "  exit 0",
      "fi",
      "if [[ \"$*\" == *\"pr view\"* ]]; then",
      "  printf 'scripts/merge-gate.mjs\\nscripts/audit-findings.mjs\\n'",
      "  exit 0",
      "fi",
      "if [[ \"$*\" == *\"check-runs\"* ]]; then",
      "  if [[ -n \"$FAKE_GH_POST_FAILS\" ]]; then echo 'gh: 422' >&2; exit 1; fi",
      "  while [[ $# -gt 0 ]]; do",
      "    if [[ \"$1\" == \"--input\" ]]; then cp \"$2\" \"$PWD/payload.json\"; fi",
      "    shift",
      "  done",
      "  echo 4242",
      "  exit 0",
      "fi",
      "exit 0",
    ].join("\n");
    writeFileSync(join(bin, "gh"), gh);
    chmodSync(join(bin, "gh"), 0o755);
    return { dir, bin };
  }

  const interpolate = (text, ctx, outputs) =>
    text.replace(/\$\{\{([^}]*)\}\}/g, (_, expr) => {
      const key = expr.trim();
      const fromStep = /^steps\.(\w+)\.outputs\.(\w+)$/.exec(key);
      if (fromStep) return String(outputs[fromStep[1]]?.[fromStep[2]] ?? "");
      if (!(key in ctx)) throw new Error("无法解析的 workflow 表达式: " + key);
      return String(ctx[key]);
    });

  // if: 只支持两种成分：always() 与 steps.<id>.outputs.<key> (==|!=) 'v'，用 && 连起来。
  // 注意本 runner 测不到 always() 的那一半语义（它不模拟「前一步红了就跳过后续步骤」）：
  // 「前一步红了仍然照写」这件事由 YAML 形状断言兜住，见 wiring 形状那条用例。
  const ifMatches = (expr, outputs) =>
    String(expr)
      .trim()
      .split("&&")
      .map((term) => term.trim())
      .every((term) => {
        if (term === "always()") return true;
        const m = /^steps\.(\w+)\.outputs\.(\w+)\s*(==|!=)\s*'([^']*)'$/.exec(term);
        if (!m) throw new Error("本 runner 只认 always() 与 steps.<id>.outputs.<key> 'v' 的 && 组合: " + expr);
        const actual = outputs[m[1]]?.[m[2]];
        return m[3] === "==" ? actual === m[4] : actual !== m[4];
      });

  // 槽位身份是真判据（一个执行器不许占两个槽），所以夹具必须像真执行器那样
  // 各自自报所在槽；要测「冒充」的用例用 raw:true 显式绕过这层改写。
  const patchEvidence = (json, executor, agent) => {
    if (typeof json !== "string" || json.trim() === "") return "";
    try {
      const parsed = JSON.parse(json);
      parsed.evidence = { ...parsed.evidence, executor, agent };
      return JSON.stringify(parsed);
    } catch {
      return json;
    }
  };

  // mutate：让用例在「YAML 已经跑起来之前」动一下沙箱，用来喂真故障
  // （比如把口径层脚本换成一个什么都不写的空壳，模拟崩溃）。
  function runWorkflow(findings, ctxOverride = {}, mutate) {
    const { dir, bin } = sandbox();
    if (mutate) mutate(dir);
    const ctx = {
      "github.event.pull_request.number": "2",
      // 事件 sha 故意与假 gh 返回的 headRefOid 不同：两个值相同的话，
      // 「head_sha 来自 gh 而不是事件」这条断言就证明了任何东西。
      "github.event.pull_request.head.sha": "deadbeef",
      "secrets.GITHUB_TOKEN": "fake-token",
      // 手动触发走这条：PR 号与 findings 都从 inputs 来，事件里没有 PR 上下文。
      inputs: "",
      "inputs.pr": "2",
      "inputs.findings_a": findings.raw
        ? (findings.AUDIT_FINDINGS_A ?? "")
        : patchEvidence(findings.AUDIT_FINDINGS_A, "sandbox", "review-a"),
      "inputs.findings_b": findings.raw
        ? (findings.AUDIT_FINDINGS_B ?? "")
        : patchEvidence(findings.AUDIT_FINDINGS_B, "github", "review-b"),
      ...ctxOverride,
    };
    const env = {
      PATH: bin + ":" + process.env.PATH,
      HOME: dir,
      GH_TOKEN: "fake-token",
      GITHUB_OUTPUT: join(dir, "output.env"),
      GITHUB_STEP_SUMMARY: join(dir, "summary.md"),
      // 与假 gh 返回的 headRefOid（cafebabe）故意不同：这样「落点来自 gh 还是来自 dispatch 提交」
      // 是能被断言区分的，而不是两边恰好相等、怎么改都绿。
      GITHUB_SHA: "f00dfeed",
      GITHUB_REPOSITORY: "o/r",
      CI: "true",
      ...findings,
    };
    writeFileSync(env.GITHUB_OUTPUT, "");
    writeFileSync(env.GITHUB_STEP_SUMMARY, "");
    const outputs = {};
    const ran = [];
    for (const step of steps) {
      if (!step.run || !step.name) continue;
      if (step.if && !ifMatches(step.if, outputs)) continue;
      writeFileSync(env.GITHUB_OUTPUT, "");
      const stepEnv = { ...env };
      for (const [key, value] of Object.entries(step.env ?? {}))
        stepEnv[key] = interpolate(String(value), ctx, outputs);
      const body = interpolate(step.run, ctx, outputs);
      // Actions 用的是 bash -e：不带 -e 的沙箱会把「中间命令失败、步骤照样继续」
      // 当成常态，于是真 CI 会红的分支在这里被记成 status 0。
      const spawned = spawnSync("bash", ["--noprofile", "--norc", "-eo", "pipefail", "-c", body], {
        cwd: dir,
        env: stepEnv,
        encoding: "utf8",
      });
      if (step.id) {
        const captured = {};
        for (const line of readFileSync(env.GITHUB_OUTPUT, "utf8").split("\n")) {
          const at = line.indexOf("=");
          if (at > 0) captured[line.slice(0, at)] = line.slice(at + 1);
        }
        outputs[step.id] = captured;
      }
      ran.push({
        key: step.id ?? step.name,
        name: step.name,
        status: spawned.status,
        stdout: spawned.stdout,
        stderr: spawned.stderr,
      });
    }
    return {
      dir,
      ran,
      outputs,
      calls: readFileSync(join(dir, "calls.log"), "utf8").split("\n").filter(Boolean),
      summary: readFileSync(join(dir, "summary.md"), "utf8"),
      payload: (() => {
        try {
          return JSON.parse(readFileSync(join(dir, "payload.json"), "utf8"));
        } catch {
          return null;
        }
      })(),
    };
  }

  const pass = JSON.stringify(result());
  const infra = JSON.stringify(result({ verdict: "INFRA" }));

  it("全 pass：POST check-runs，conclusion=success，判定步骤退出 0", () => {
    const out = runWorkflow({ AUDIT_FINDINGS_A: pass, AUDIT_FINDINGS_B: pass });
    expect(out.calls.filter((c) => c.includes("check-runs"))).toHaveLength(1);
    expect(out.calls.filter((c) => c.includes("--method POST"))).toHaveLength(1);
    expect(out.payload).toMatchObject({ name: "audit", status: "completed", conclusion: "success" });
    expect(out.payload.head_sha).toBe("cafebabe");
    expect(out.calls.filter((c) => c.includes("headRefOid"))).toHaveLength(1);
    expect(out.outputs.decide.exit).toBe("0");
    expect(out.ran.at(-1).status).toBe(0);
    expect(out.summary).toBe("");
  });

  it("needs_revision：conclusion=failure，判定步骤退出 1", () => {
    const out = runWorkflow({
      AUDIT_FINDINGS_A: pass,
      AUDIT_FINDINGS_B: JSON.stringify(result({ verdict: "needs_revision" })),
    });
    expect(out.payload.conclusion).toBe("failure");
    expect(out.outputs.decide.exit).toBe("1");
    expect(out.ran.at(-1).status).toBe(1);
  });

  it("INFRA：Check Run 落 action_required（required check 不会变绿），job 级不染红", () => {
    const out = runWorkflow({ AUDIT_FINDINGS_A: infra, AUDIT_FINDINGS_B: pass });
    expect(out.payload.conclusion).toBe("action_required");
    expect(out.payload.conclusion).not.toBe("neutral");
    // job 级 check 只回答「这个 job 有没有跑错」：INFRA 是「判不了」，不是「代码不合格」。
    // 让它也红，merge-gate 的 G3 就会把一个未判过读成一次不合格。
    expect(out.outputs.decide.exit).toBe("0");
    expect(out.ran.at(-1).status).toBe(0);
    expect(out.summary).toContain("INFRA");
    // 方向决策：INFRA ≠ 不合格，但「未判过」照样挡合并。
    expect(out.summary).toContain("未判过");
    expect(out.summary).toContain("不放行合并");
    expect(out.summary).toContain("不许把它读成「代码不合格」");
  });

  it("注入不被求值：findings 里的 $( ) 原样进 payload，不在 CI 里执行", () => {
    // 输入走 env 而不是内联进 run 块，所以它只能作为字符串到达脚本。
    // 这条用例真喂一个命令替换进去，看它在沙箱里有没有被执行。
    const angry = JSON.stringify({
      ...result({ verdict: "needs_revision" }),
      findings: [
        {
          path: "scripts/audit-findings.mjs",
          line: 1,
          severity: "low",
          criterion: "注入面",
          suggestion: "$(touch pwned-by-audit-input)",
        },
      ],
    });
    const out = runWorkflow({ AUDIT_FINDINGS_A: angry, AUDIT_FINDINGS_B: angry });
    expect(existsSync(join(out.dir, "pwned-by-audit-input"))).toBe(false);
    expect(out.payload.conclusion).toBe("failure");
  });

  it("一个执行器不能占两个槽：同一份证据填进两个 input 只算一份，另一槽记 INFRA", () => {
    const forged = JSON.stringify(result({ evidence: { ...result().evidence, executor: "github", agent: "review-b" } }));
    const out = runWorkflow({ AUDIT_FINDINGS_A: forged, AUDIT_FINDINGS_B: forged, raw: true });
    expect(out.outputs.decide.verdict).toBe("INFRA");
    expect(out.payload.conclusion).toBe("action_required");
    const a = readFileSync(join(out.dir, ".audit/review-a.json"), "utf8");
    expect(a).toContain("一个执行器不能占两个槽");
  });

  it("判不了也要回写：取不到 PR head sha 时落 action_required，不是沿用上一轮的绿", () => {
    const out = runWorkflow(
      { AUDIT_FINDINGS_A: pass, AUDIT_FINDINGS_B: pass },
      { "inputs.pr": "" },
    );
    expect(out.outputs.ctx.ok).toBe("0");
    expect(out.payload).toMatchObject({ name: "audit", conclusion: "action_required" });
    // 落点必须是一个真 sha：空 head_sha 会被 GitHub 422 拒，一个 Check Run 都写不出去。
    expect(out.payload.head_sha).toBe("f00dfeed");
    expect(out.calls.some((c) => c.includes("repos/o/r/check-runs"))).toBe(true);
    // 落点不等于 PR head 这件事要喊出来，不能只写在注释里。
    expect(String(out.payload.output.title)).toContain("f00dfeed");
    expect(String(out.payload.output.title)).toContain("不是 PR head");
    expect(out.ran.some((s) => String(s.stdout).includes("::error"))).toBe(true);
    expect(out.summary).toContain("落点不一定是 PR head");
    // 结论的红由 POST 出去的 Check Run 承载，job 级 check 不重复染红。
    expect(out.ran.at(-1).status).toBe(0);
  });

  it("-e 作用：留痕回写失败必须让步骤红，不许被后面的 echo 盖成绿", () => {
    const out = runWorkflow(
      { AUDIT_FINDINGS_A: "", AUDIT_FINDINGS_B: "", FAKE_GH_POST_FAILS: "1" },
      { "inputs.pr": "" },
    );
    const step = out.ran.find((s) => s.name === "判不了：回写 INFRA");
    expect(step.status).not.toBe(0);
  });

  it("口径层崩溃、result.json 没落地：兜底照样 POST 一条 action_required，job 不染红", () => {
    // 「崩溃也必须显式留痕」的落地点。把沙箱里的口径层脚本换成一个什么都不写就死的空壳：
    // 这条不测脚本自己（脚本的兜底另有单元用例），测的是 workflow 在「脚本什么都没留下」时的行为。
    const out = runWorkflow(
      { AUDIT_FINDINGS_A: pass, AUDIT_FINDINGS_B: pass },
      {},
      (dir) => writeFileSync(join(dir, "scripts/audit-findings.mjs"), "process.exit(70);\n"),
    );
    expect(out.payload).toMatchObject({ name: "audit", conclusion: "action_required" });
    expect(String(out.payload.output.summary)).toContain("口径层没有产出结论");
    const repaired = JSON.parse(readFileSync(join(out.dir, ".audit/result.json"), "utf8"));
    expect(repaired.conclusion).toBe("action_required");
    expect(String(repaired.reason)).toContain("口径层没有产出结论");
    // 留痕要读得懂：摘要点名「别读成通过」，并打出一条 error 注解。
    expect(out.summary).toContain("口径层没有产出结论");
    expect(out.summary).toContain("别把它读成通过");
    expect(out.ran.some((s) => String(s.stdout).includes("::error title=audit INFRA::"))).toBe(true);
    // 兜底补的是同一条结论（action_required），job 级 check 仍然不染红。
    expect(out.outputs.fallback.exit).toBe("0");
    expect(out.ran.at(-1).status).toBe(0);
  });

  it("POST 失败必须让回写步骤红：留痕没留成就是一次真故障，不许被吞", () => {
    const out = runWorkflow({
      AUDIT_FINDINGS_A: pass,
      AUDIT_FINDINGS_B: pass,
      FAKE_GH_POST_FAILS: "1",
    });
    const step = out.ran.find((s) => s.name === "回写 Check Run");
    expect(step.status).not.toBe(0);
  });

  it("上游没注入 findings：不写 pass，落成 INFRA", () => {
    const out = runWorkflow({ AUDIT_FINDINGS_A: "", AUDIT_FINDINGS_B: "" });
    expect(out.payload.conclusion).toBe("action_required");
    expect(out.outputs.decide.verdict).toBe("INFRA");
    expect(out.summary).toContain("INFRA");
  });
});