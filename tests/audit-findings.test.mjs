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
import { join, posix } from "node:path";
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
  const job = doc.jobs["audit-runner"];
  const steps = job.steps;
  // job 级载体（job.env.* / defaults.run.shell / 顶层 env）对每个 step 都生效，是同一个执行面，
  // 不是扫描面之外的包装器；真仓库上它同样必须零读者。
  const carrierPayloads = jobPayloads(job, doc);

  function sandbox() {
    const dir = mkdtempSync(join(tmpdir(), "audit-wf-"));
    cpSync(join(ROOT, "scripts"), join(dir, "scripts"), { recursive: true });
    symlinkSync(join(ROOT, "node_modules"), join(dir, "node_modules"));
    mkdirSync(join(dir, ".audit"), { recursive: true });
    const bin = join(dir, "bin");
    mkdirSync(bin, { recursive: true });
    // 账本与 payload 的路径在**生成时**就写死成绝对路径，不看 $PWD：
    // 某个 step 先 `cd sub` 再调 gh 时，`$PWD/calls.log` 会把条目写进子目录，
    // 根账本于是「存在但 0 行」—— 「账本在、0 行 = 零调用」这条担保被空过。
    const LEDGER = join(dir, "calls.log");
    const PAYLOAD = join(dir, "payload.json");
    const gh = [
      "#!/usr/bin/env bash",
      // 账本**无条件创建**：这样「账本不存在」就只有一个来历 —— 假 gh 压根没跑起来
      // （PATH / shebang / 权限 / 记账被改坏），而不是「零次调用」的正常形态。
      // 否则读不到账本返回的 [] 与真的零调用是同一个值，一批 toHaveLength(0) 的断言
      // 会因为 harness 断开而空过。
      `touch "${LEDGER}"`,
      // harness 自检探针：跑得起来就说明账本路径与 PATH 是通的，但它自己不进账本。
      "if [[ \"$1\" == \"--audit-harness-canary\" ]]; then exit 0; fi",
      `echo "$*" >> "${LEDGER}"`,
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
      `    if [[ "$1" == "--input" ]]; then cp "$2" "${PAYLOAD}"; fi`,
      "    shift",
      "  done",
      "  echo 4242",
      "  exit 0",
      "fi",
      "exit 0",
    ].join("\n");
    writeFileSync(join(bin, "gh"), gh);
    chmodSync(join(bin, "gh"), 0o755);
    // harness 自检：账本由假 gh 自己创建，所以先证明它真的跑得起来。
    // 少了这一步，「账本不在」既可能是 harness 坏了、也可能是这一步合法地一次没调 ——
    // 而这两种情况的正确反应完全相反。
    const probe = spawnSync(join(bin, "gh"), ["--audit-harness-canary"], { cwd: dir, encoding: "utf8" });
    if (probe.status !== 0) {
      throw new Error("假 gh 跑不起来（harness 自检失败）：" + String(probe.stderr ?? probe.error ?? ""));
    }
    return { dir, bin };
  }

  // 「零次调用」是「账本在、0 行」；「账本不在」只有一个来历：假 gh 一次都没跑起来。
  // 把它读成 [] 就等于让 harness 故障伪装成一次合法的零调用。
  function readGhLedger(dir) {
    const ledger = join(dir, "calls.log");
    if (!existsSync(ledger)) {
      throw new Error(
        "假 gh 的调用账本不存在（" + ledger + "）：这是 harness 故障，不是「零次调用」。零调用 = 账本在、0 行。",
      );
    }
    return readFileSync(ledger, "utf8").split("\n").filter(Boolean);
  }

  // 「一次都没调」必须同时断言账本存在：否则「读不到账本」与「零次调用」又合流了。
  function expectNoGhCalls(out, needle = "") {
    expect(existsSync(join(out.dir, "calls.log")), "调用账本必须存在").toBe(true);
    expect(out.calls.filter((call) => call.includes(needle))).toHaveLength(0);
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
  // options.skip：按 step 名字模拟「这一步被跳过」（前置步骤红了时 Actions 的行为），
  // 于是依赖它 outputs 的后续步骤真的读到空串 —— 这正是 checkout / node 挂掉后的形状。
  function runWorkflow(findings, ctxOverride = {}, mutate, options = {}) {
    const { dir, bin } = sandbox();
    if (mutate) mutate(dir);
    const skip = new Set(options.skip ?? []);
    const ctx = {
      "github.event.pull_request.number": "2",
      // 事件 sha 故意与假 gh 返回的 headRefOid 不同：两个值相同的话，
      // 「head_sha 来自 gh 而不是事件」这条断言就证明了任何东西。
      "github.event.pull_request.head.sha": "deadbeef",
      // 本次 workflow 运行的提交（= env GITHUB_SHA）：ctx 被跳过时「判不了」的兜底落点。
      "github.sha": "f00dfeed",
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
    const raw = {};
    const ran = [];
    for (const step of steps) {
      if (!step.run || !step.name) continue;
      if (skip.has(step.name)) continue;
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
        const written = readFileSync(env.GITHUB_OUTPUT, "utf8");
        raw[step.id] = written;
        const captured = {};
        for (const line of written.split("\n")) {
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
      // 每个带 id 的步骤写进 $GITHUB_OUTPUT 的原文：注解注入面看的是这些行本身。
      raw,
      // 一次 gh 都没调是完全合法的状态（比如落点为空、步骤红在调用之前），
      // 但那时**账本仍然在**：它的存在由 fake gh 自己担保，它的 0 行才是「零次调用」。
      calls: readGhLedger(dir),
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

  it("行为兜底：全 pass 时 check-run.json 的 summary 同时含「申报=」与「agreed=」", () => {
    // 形状判据只能证明「文本里有一处解引用形态」；把真解引用换成
    // lines.push("r.executors .comparison .counts") 之后解引用没了，这两行就从 summary 里
    // 永久消失，而全仓没有任何断言在看 summary。这条补的是后果：读者可以丢，丢了的后果必须可见。
    const out = runWorkflow({ AUDIT_FINDINGS_A: pass, AUDIT_FINDINGS_B: pass });
    expect(out.payload).toMatchObject({ name: "audit", conclusion: "success" });
    const written = JSON.parse(readFileSync(join(out.dir, ".audit/check-run.json"), "utf8"));
    const summary = String(written.output.summary);
    // 两个槽都自报「申报」：只含一处的话，「申报=」可能来自一条无关行。
    expect(summary).toContain("a: 申报=");
    expect(summary).toContain("b: 申报=");
    // 对照一轮的四个计数必须在 summary 里：这是 comparison.counts 这条路唯一的可观测后果。
    expect(summary).toContain("agreed=");
    expect(summary).toContain("onlyA=");
    expect(summary).toContain("severityMismatch=");
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

  // 摘要围栏宽度本身是判据：固定 3 个反引号时，一个 findings[].path 就能提前闭合围栏，
  // 后面的「## audit: pass（伪造）」与 ![](http://evil/x.png) 落到围栏外被当 Markdown 渲染。
  // 这里按 Markdown 的规则读摘要：开围栏 = 第一条 ≥3 个纯反引号的行，它有 W 个；
  // 之后出现 ≥W 个反引号的行才算闭合。
  function parseSummaryFences(markdown) {
    const lines = markdown.split("\n");
    const openAt = lines.findIndex((line) => /^`{3,}$/.test(line));
    if (openAt < 0) return { width: 0, closed: false, inside: [], outside: lines };
    const width = lines[openAt].length;
    const closeAt = lines.findIndex((line, i) => i > openAt && /^`{3,}$/.test(line) && line.length >= width);
    return {
      width,
      closed: closeAt >= 0,
      inside: lines.slice(openAt + 1, closeAt < 0 ? undefined : closeAt),
      outside: [...lines.slice(0, openAt), ...(closeAt < 0 ? [] : lines.slice(closeAt + 1))],
    };
  }

  it("摘要围栏按内容算：path 里的三反引号关不掉围栏，伪造结论与外部图片出不来", () => {
    const forged = "```\n## audit: pass（伪造）\n![](http://evil/beacon.png)";
    const poisoned = JSON.stringify(result({ verdict: "INFRA", findings: [finding({ path: forged })] }));
    const out = runWorkflow({ AUDIT_FINDINGS_A: poisoned, AUDIT_FINDINGS_B: pass });
    // 证据确实落进了 result.json —— 否则下面只是「内容里没有反引号」的空转。
    expect(readFileSync(join(out.dir, ".audit/result.json"), "utf8")).toContain("## audit: pass");
    const fenced = parseSummaryFences(out.summary);
    expect(fenced.closed).toBe(true);
    // 不变式：围栏必须**严格长于**内容里最长的连续反引号串。
    // 相等（固定 3 个 = 内容里的 ```）就是可闭合；Markdown 允许更长的围栏，
    // 所以「按内容算」既不改写证据，也不需要转义。
    const longestInside = Math.max(
      0,
      ...fenced.inside.flatMap((line) => (line.match(/`+/g) ?? []).map((run) => run.length)),
    );
    expect(longestInside).toBeGreaterThanOrEqual(3);
    expect(fenced.width).toBeGreaterThan(longestInside);
    const outside = fenced.outside.join("\n");
    expect(outside).not.toContain("## audit: pass");
    expect(outside).not.toContain("evil");
    // 内容一字不改：伪造串原样留在围栏里，中和靠围栏、不靠改写证据。
    expect(fenced.inside.join("\n")).toContain("## audit: pass（伪造）");
  });

  it("摘要围栏挡得住「行首就是三反引号」的内容：Markdown 只看行首，固定 3 个会被闭合", () => {
    // 上一条走的是真写者：JSON.stringify 把 path 里的 \n 转义成 \\n，行首反引号进不了摘要。
    // 但「围栏能不能被内容闭合」是摘要这一步自己的不变式，与写者怎么序列化无关 ——
    // 这里直接喂一份行首就是 ``` 的 result.json，把这条不变式钉死。
    const { dir } = sandbox();
    writeFileSync(
      join(dir, ".audit/result.json"),
      ['{', '  "note": [', "```", "## audit: pass（伪造）", "![](http://evil/beacon.png)", "  ]", "}", ""].join("\n"),
    );
    const infraStep = steps.find((s) => s.name === "INFRA 留痕");
    const summaryPath = join(dir, "summary.md");
    writeFileSync(summaryPath, "");
    const spawned = spawnSync("bash", ["--noprofile", "--norc", "-eo", "pipefail", "-c", infraStep.run], {
      cwd: dir,
      env: {
        PATH: join(dir, "bin") + ":" + process.env.PATH,
        HOME: dir,
        GITHUB_STEP_SUMMARY: summaryPath,
        GITHUB_REPOSITORY: "o/r",
      },
      encoding: "utf8",
    });
    expect(spawned.status).toBe(0);
    const fenced = parseSummaryFences(readFileSync(summaryPath, "utf8"));
    // 先看后果：伪造结论与外部图片一个字都不许落到围栏外（渲染面）。
    const outside = fenced.outside.join("\n");
    expect(outside).not.toContain("## audit: pass");
    expect(outside).not.toContain("evil");
    // 再看成因：围栏严格长于内容里最长的连续反引号串，所以内容闭合不了它。
    expect(fenced.closed).toBe(true);
    const longestInside = Math.max(
      0,
      ...fenced.inside.flatMap((line) => (line.match(/`+/g) ?? []).map((run) => run.length)),
    );
    expect(longestInside).toBeGreaterThanOrEqual(3);
    expect(fenced.width).toBeGreaterThan(longestInside);
  });

  // 判据是**字段名**，不是某一种拼写：r.executors / .["executors"] /
  // `jq -r '.["executors"] | length'` 都是同一个字段的同一种读法。
  // 扫描面是 run 块（YAML 注释、name、env 都不在里面，run 块内的 shell 注释行不算读）
  // **加上 run 块里被执行到的脚本文件**：一个 step 的 run 只有 `node scripts/x.mjs` 一行时，
  // 字段名在文件里、不在 run 文本里 —— 只扫 run 就等于给读者留了一整类绕道。
  //
  // 剔除注释是**引号感知**的：只有引号外的 `#`（行首或紧邻空白）才是注释起点。
  // 旧实现直接正则找 `#`，于是 `printf '%s' ' # '; node scripts/probe-read.mjs` 整条命令
  // 被当成注释切掉 —— 命令整个消失比「读不到字段名」严重：那一步在判据里根本不存在。
  // 一行内引号不配对时整行保留（宁可漏判注释，也不许把真命令当注释删掉）。
  // `\#` / `$#` / `${#x}` / `foo#bar` 仍然不切。
  const SHELL_QUOTES = ["'", '"'];
  function stripShellComment(line) {
    let quote = null;
    for (let i = 0; i < line.length; i += 1) {
      const ch = line[i];
      if (quote) {
        if (ch === "\\" && quote === '"') {
          i += 1;
          continue;
        }
        if (ch === quote) quote = null;
        continue;
      }
      if (ch === "\\") {
        i += 1;
        continue;
      }
      if (SHELL_QUOTES.includes(ch)) {
        quote = ch;
        continue;
      }
      if (ch === "#" && (i === 0 || /\s/.test(line[i - 1]))) return line.slice(0, i);
    }
    return line;
  }

  const RESULT_FIELDS = ["executors", "comparison", "counts"];
  // 标识符边界：前后都不能紧邻 [A-Za-z0-9_]。所以 `executors_count` 不是 `executors` 的读，
  // 判据是「是不是这个字段的读者」，不是「这行出现过这串字」。
  const FIELD_READERS = RESULT_FIELDS.map((field) => ({
    field,
    re: new RegExp(`(?<![A-Za-z0-9_])${field.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![A-Za-z0-9_])`),
  }));

  // 续行：shell 把「反斜杠 + 换行」原样删除，**不换成空格**。
  // `node scripts/\` + 换行 + `probe-read.mjs` 必须折成 `scripts/probe-read.mjs`；
  // 换成空格会把路径切成两个词，那正是这个写法该红的写法逃掉的方式。
  function foldContinuations(runText) {
    return String(runText).replace(/\\\r?\n/g, "");
  }

  // 两侧引号都剥。审查实测：只剥前引号时 `node "scripts/x.mjs"` 与 `node 'scripts/x.mjs'`
  // 既不出 violation、也不进 missing —— 于是「引用解析不到就红」那条断言照样绿。
  function unquote(token) {
    return String(token).replace(/^["']/, "").replace(/["']$/, "");
  }

  const SCRIPT_EXT = /\.(?:mjs|cjs|js)$/;

  // ---- shell 词法：只够用来找「被执行的脚本」，不做展开 ----
  // 引号内整体成词、引号外按空白切、`;&|()<>` 一律当命令分隔。
  // 把标点当**分隔**而不是当词尾字符，是 `node scripts/x.mjs;`、`node scripts/x.mjs)` 这类
  // 行尾标点不再被吃进脚本路径的唯一原因（旧实现 (\S+) 把标点一起当路径，整条命令解析不到）。
  const SHELL_SEPARATORS = new Set([";", "&", "|", "(", ")", "<", ">"]);

  function shellWords(line) {
    const words = [];
    let cur = null;
    const flush = () => {
      if (cur !== null) words.push(cur);
      cur = null;
    };
    for (let i = 0; i < line.length; ) {
      const ch = line[i];
      if (ch === "'" || ch === '"') {
        const quote = ch;
        let value = "";
        let j = i + 1;
        while (j < line.length && line[j] !== quote) {
          if (quote === '"' && line[j] === "\\") {
            value += line[j + 1] ?? "";
            j += 2;
            continue;
          }
          value += line[j];
          j += 1;
        }
        // 引号不配对：剩下的整段当一个词（宁可留一个解析不到的候选，也不静默丢词）。
        cur = (cur ?? "") + value;
        i = j + 1;
        continue;
      }
      if (ch === "\\") {
        cur = (cur ?? "") + (line[i + 1] ?? "");
        i += 2;
        continue;
      }
      if (/\s/.test(ch)) {
        flush();
        i += 1;
        continue;
      }
      if (SHELL_SEPARATORS.has(ch)) {
        flush();
        words.push(ch);
        i += 1;
        continue;
      }
      cur = (cur ?? "") + ch;
      i += 1;
    }
    flush();
    return words;
  }

  function shellCommands(runText) {
    const commands = [];
    for (const line of foldContinuations(runText).split("\n").map(stripShellComment)) {
      let cur = [];
      for (const word of shellWords(line)) {
        if (SHELL_SEPARATORS.has(word)) {
          if (cur.length) commands.push(cur);
          cur = [];
          continue;
        }
        cur.push(word);
      }
      if (cur.length) commands.push(cur);
    }
    return commands;
  }

  // ---- node 的参数分三类 ----
  // 1) 不带取值的 flag；2) 带取值的 flag —— **取值本身也是 node 执行的模块**
  //    （--require/--import/--loader 正是读者藏身的地方，必须一起进扫描面）；3) 脚本路径。
  // 不认识的 flag 绝不猜「它没有取值」：那正是上一轮让 --require 把真脚本吃掉的老路。
  const NODE_VALUE_FLAGS = new Set([
    "-r",
    "--require",
    "--import",
    "--loader",
    "--experimental-loader",
    "--experimental-policy",
    "--env-file",
    "--env-file-if-exists",
    "-C",
    "--conditions",
    "--title",
    "--input-type",
    "--icu-data-dir",
    "--openssl-config",
    "--diagnostic-dir",
    "--report-dir",
    "--report-filename",
    "--security-revert",
    "--watch-path",
    "--stack-trace-limit",
    "--max-http-header-size",
    "--dns-result-order",
    "--disable-warning",
    "--allow-fs-read",
    "--allow-fs-write",
    "--allow-addons",
  ]);
  const NODE_CODE_FLAGS = new Set(["-e", "--eval", "-p", "--print"]);
  // 认得的「不带取值」flag：写出来只是为了让它们不落进 unfollowable。
  const NODE_PLAIN_FLAGS = new Set([
    "-v",
    "-h",
    "-c",
    "--version",
    "--help",
    "--check",
    "--no-warnings",
    "--no-deprecation",
    "--no-addons",
    "--trace-warnings",
    "--trace-deprecation",
    "--throw-deprecation",
    "--pending-deprecation",
    "--enable-source-maps",
    "--preserve-symlinks",
    "--preserve-symlinks-main",
    "--frozen-intrinsics",
    "--watch",
    "--watch-preserve-output",
    "--test",
    "--test-only",
    "--inspect",
    "--inspect-brk",
    "--inspect-wait",
    "--experimental-vm-modules",
    "--experimental-detect-module",
    "--experimental-require-module",
    "--no-experimental-require-module",
    "--experimental-global-webcrypto",
    "--experimental-import-meta-resolve",
  ]);
  const NODE_WORD = /(?:^|\/)node$/;
  // 变量当命令头：`$NODE_BIN scripts/x.mjs`、`${NODE} ...`。
  const DYNAMIC_NODE_WORD = /^\$\{?[A-Za-z_][A-Za-z0-9_]*(?:[:-][^}]*)?\}?$/;
  const SHELL_C = /^(?:ba|z|da|k)?sh$/;

  function parseNodeCommand(words) {
    const scripts = [];
    const unfollowable = [];
    const at = words.findIndex((word) => NODE_WORD.test(word));
    if (at === -1) return { scripts, unfollowable };
    let seenScript = false;
    let i = at + 1;
    while (i < words.length) {
      const token = words[i];
      // 脚本路径之后的 token 是脚本自己的参数，不是 node 的 flag。
      if (seenScript) {
        i += 1;
        continue;
      }
      if (token === "--") {
        i += 1;
        continue;
      }
      if (token === "-") {
        unfollowable.push({ kind: "node-stdin", detail: token });
        i += 1;
        continue;
      }
      if (token.startsWith("-")) {
        const eq = token.indexOf("=");
        const name = eq === -1 ? token : token.slice(0, eq);
        const attached = eq === -1 ? null : token.slice(eq + 1);
        if (NODE_CODE_FLAGS.has(name)) {
          // 内联代码就在 run 文本里（含多行 -e 块），字段名由 run 文本扫描面负责。
          i += attached === null ? 2 : 1;
          continue;
        }
        if (NODE_VALUE_FLAGS.has(name)) {
          if (attached !== null) {
            scripts.push(attached);
            i += 1;
            continue;
          }
          const value = words[i + 1];
          if (value === undefined) {
            unfollowable.push({ kind: "node-flag-value", detail: token });
            i += 1;
            continue;
          }
          scripts.push(value);
          i += 2;
          continue;
        }
        if (attached !== null || NODE_PLAIN_FLAGS.has(name)) {
          i += 1;
          continue;
        }
        // 认不出的 flag：它可能吃掉下一个 token（那正是真脚本）。
        unfollowable.push({ kind: "node-flag", detail: token });
        i += 1;
        continue;
      }
      if (!seenScript) {
        scripts.push(token);
        seenScript = true;
      }
      i += 1;
    }
    return { scripts, unfollowable };
  }

  // 引用解析：带扩展名直接用；无扩展名（node 照跑的 CJS）按 .mjs/.cjs/.js 补全探测；
  // 探测不到**也保留名字进 missing** —— 静默丢弃正是这一批绕过面的共同根因。
  function resolveScriptRef(root, raw) {
    const rel = unquote(raw).replace(/^\.\//, "");
    if (!rel || rel.startsWith("-")) return null;
    if (SCRIPT_EXT.test(rel)) return rel;
    const abs = scriptPath(root, rel);
    if (abs && existsSync(abs)) return rel;
    for (const ext of SCRIPT_EXTS) {
      const candidate = rel + ext;
      const absCandidate = scriptPath(root, candidate);
      if (absCandidate && existsSync(absCandidate)) return candidate;
    }
    return rel;
  }

  // run 块里被执行到的脚本：node 命令行（含 --require/--import 的取值）+ shebang 直执行的 ./ 形态。
  // 跟不下去的形态（未知 flag、sh -c 又包一层、变量当 node）进 unfollowable，由形状用例判红。
  function scanScriptRefs(runText, options = {}) {
    const root = options.root ?? ROOT;
    const refs = [];
    const unfollowable = [];
    const add = (raw) => {
      const rel = resolveScriptRef(root, raw);
      if (rel && !refs.includes(rel)) refs.push(rel);
    };
    for (const words of shellCommands(runText)) {
      const head = words[0] ?? "";
      if (SHELL_C.test(head) && /^-{1,2}c$/.test(words[1] ?? "")) {
        const body = words.slice(2).join(" ");
        // 只处理「看得出在跑 node」的 body：把 bash 跑的任何东西都当 node，判据就变成噪声。
        if (/(?:^|[\s;"'])(?:\S*\/)?node(?:[\s;"']|$)/.test(body)) unfollowable.push({ kind: "shell-c", detail: body });
        continue;
      }
      const parsed = parseNodeCommand(words);
      for (const script of parsed.scripts) add(script);
      unfollowable.push(...parsed.unfollowable);
      // 变量当命令头（$NODE_BIN scripts/x.mjs）：认得出在跑 node，可执行文件路径静态不可解。
      if (parsed.scripts.length === 0 && DYNAMIC_NODE_WORD.test(head) && /NODE/i.test(head)) {
        unfollowable.push({ kind: "dynamic-node", detail: words.join(" ") });
      }
      for (const word of words) if (word.startsWith("./")) add(word);
    }
    return { refs, unfollowable };
  }

  function scriptRefs(runText, options = {}) {
    return scanScriptRefs(runText, options).refs;
  }

  // GitHub 的 custom shell 形如 `command [options] {0}`：{0} 处换成脚本文件路径，命令本身由
  // **这个字段**携带。它不写在 run 里，所以只认 run 的扫描面连看都没看它 —— 而它真执行。
  // 按「命令 + {0} 占位」解出 node 脚本；解析不下去就落 unfollowable，不静默跳过。
  function scanShellField(shellText, options = {}) {
    const root = options.root ?? ROOT;
    const refs = [];
    const unfollowable = [];
    const add = (raw) => {
      const rel = resolveScriptRef(root, raw);
      if (rel && !refs.includes(rel)) refs.push(rel);
    };
    const visit = (body, depth) => {
      for (const words of shellCommands(body)) {
        const head = words[0] ?? "";
        if (SHELL_C.test(head) && /^-{1,2}[a-z]*c$/.test(words[1] ?? "")) {
          // bash -c '...' 的 body 才是真命令：往里走一层，走不动了才记 unfollowable。
          if (depth >= 2) {
            unfollowable.push({ kind: "shell-c", detail: body });
            continue;
          }
          visit(words.slice(2).join(" "), depth + 1);
          continue;
        }
        const parsed = parseNodeCommand(words);
        for (const script of parsed.scripts) add(script);
        unfollowable.push(...parsed.unfollowable);
        if (parsed.scripts.length === 0 && DYNAMIC_NODE_WORD.test(head) && /NODE/i.test(head)) {
          unfollowable.push({ kind: "dynamic-node", detail: words.join(" ") });
        }
        for (const word of words) if (word.startsWith("./")) add(word);
      }
    };
    // {0} 是占位符不是命令词：留着会在 token 流里冒充参数。
    visit(String(shellText).replace(/\{0\}/g, " "), 0);
    return { refs, unfollowable };
  }

  function scriptPath(root, rel) {
    return rel.startsWith("..") || rel.startsWith("/") ? null : join(root, rel);
  }

  // ---- 载体：step 的**一切**可执行载荷 ----
  // 旧扫描面只认 step.run。可 run 不是唯一的执行面，于是读者坐在别的字段里就全绿：
  //   * uses + with：github-script 的 `script` 就是一段照跑的内联 JS；
  //   * uses: ./.github/actions/x：composite，内部还有 run；
  //   * env 的值：NODE_OPTIONS 的 --require/-r/--import <path> 是 node 启动前就执行的模块。
  // 载体认不全时，「没有别的读者」会退化成「没扫到」——那正是这一批绕过的共同形状。
  function payloadLeaves(value, path = []) {
    if (typeof value === "string") return [{ path: path.join("."), text: value }];
    if (Array.isArray(value)) return value.flatMap((item, i) => payloadLeaves(item, [...path, String(i)]));
    if (value && typeof value === "object") {
      return Object.entries(value).flatMap(([key, inner]) => payloadLeaves(inner, [...path, key]));
    }
    return [];
  }

  function stepPayloads(step) {
    const payloads = [];
    if (typeof step.run === "string") payloads.push({ carrier: "run", text: step.run });
    // shell 也是执行面：custom shell 形如 `command [options] {0}`，命令由这个字段携带。
    // 它零扫描时，读者挂在它上面既不出违规、也不进 unfollowable —— 那是静默放行。
    if (typeof step.shell === "string") payloads.push({ carrier: "shell", text: step.shell });
    for (const field of ["with", "env"]) {
      for (const leaf of payloadLeaves(step[field], [field])) payloads.push({ carrier: leaf.path, text: leaf.text });
    }
    return payloads;
  }

  // ---- job 级载体 ----
  // 语法位置不同不等于执行面不同：job.env 对 job 内每次 node 启动都生效（--require 的模块
  // 在 node 起来之前就跑），defaults.run.shell 决定每个 step 的 run 怎么被解释。
  // 二者缺席时，读者只要从 step 搬到 job 上就全绿（实测 87 条），而它在 GitHub 里一字不差地执行。
  function jobPayloads(job, doc = {}) {
    const payloads = [];
    for (const leaf of payloadLeaves(job?.env, ["job", "env"])) payloads.push({ carrier: leaf.path, text: leaf.text });
    // 容器上的环境变量与 job.env 同一机制：GitHub 里 container.env 对 job 内全部 step 生效，
    // 位置换了、执行面没换。它零扫描时，读者只要从 job.env 搬到 container.env 就全绿（实测）。
    for (const leaf of payloadLeaves(job?.container?.env, ["job", "container", "env"])) {
      payloads.push({ carrier: leaf.path, text: leaf.text });
    }
    // container.options 是交给 docker create 的参数表：--env NODE_OPTIONS=--require x 与
    // container.env 同族可执行。但它只是**一段参数文本**，--entrypoint / --env-file / -v 挂载
    // 这类形态由 docker 解释，判不出来（见测试里的诚实残余）；只有字面出现的 loader 取值进扫描面。
    for (const leaf of payloadLeaves(job?.container?.options, ["job", "container", "options"])) {
      payloads.push({ carrier: leaf.path, text: leaf.text });
    }
    for (const leaf of payloadLeaves(doc?.env, ["env"])) payloads.push({ carrier: leaf.path, text: leaf.text });
    for (const [carrier, shell] of [
      ["defaults.run.shell", job?.defaults?.run?.shell],
      ["defaults.run.shell", doc?.defaults?.run?.shell],
    ]) {
      if (typeof shell === "string") payloads.push({ carrier, text: shell });
    }
    return payloads;
  }

  // 一份载荷被执行到的脚本引用：shell 字段按 custom shell 命令解，其余按 shell 词法 + loader 取值。
  function payloadScriptRefs(payload, options = {}) {
    const scanned =
      payload.carrier === "shell" || payload.carrier === "defaults.run.shell"
        ? scanShellField(payload.text, options)
        : scanScriptRefs(payload.text, options);
    // 词法结果与 loader 取值可能指向同一个文件（--require ./x.cjs 两路都认得出）：
    // 不合并就会让同一个文件被算成两处引用，下游按文件均摊判据时变成两条违规。
    // loader 取值对**每一类载体**都成立（shell 字段与 env 一样能带 NODE_OPTIONS），
    // 取不到 / 拼出来的取值进 unfollowable，不许静默跳过。
    const loaded = loaderValueRefs(payload.text, options);
    const refs = [];
    for (const rel of [...scanned.refs, ...loaded.refs]) {
      if (!refs.includes(rel)) refs.push(rel);
    }
    return { refs, unfollowable: [...scanned.unfollowable, ...loaded.unfollowable] };
  }

  // NODE_OPTIONS / node 参数里的「模块取值」：--require x、-r x、--import=x、--loader x。
  // 取值本身在 node 启动前就被加载（它本身就是扫描面），所以不是「看不出来的 flag」。
  // 前缀只要求「不是词字符、也不是连字符」：空格、引号、等号、$ 都算起点。
  // 旧写法要求 flag 前面是行首/空白/引号，于是 NODE_OPTIONS=--require=./x.cjs 整个不在扫描面 ——
  // 红绿只差一个等号，而它在 node 里一字不差地先跑模块（本机 node 实测：先跑 REQUIRED 再跑 main）。
  const LOADER_FLAG_VALUE =
    /(?<![\w-])(?:--require|--import|-r|--loader|--experimental-loader)(?:=|\s+|$)([^\s"';|&]*)/g;
  // 变量/通配拼出来的取值静态不可解：落 unfollowable（不许猜它拼出了什么）。
  const LOADER_DYNAMIC_VALUE = /[$*?{\u0060]/;

  function loaderValueRefs(text, options = {}) {
    const root = options.root ?? ROOT;
    const refs = [];
    const unfollowable = [];
    for (const match of String(text).matchAll(LOADER_FLAG_VALUE)) {
      const value = match[1];
      // 取不到取值（flag 收在文本末尾）：不猜，记 unfollowable。
      if (!value) {
        unfollowable.push({ kind: "loader-no-value", detail: match[0].trim() });
        continue;
      }
      if (LOADER_DYNAMIC_VALUE.test(value)) {
        unfollowable.push({ kind: "loader-dynamic", detail: match[0].trim() });
        continue;
      }
      const rel = resolveScriptRef(root, value);
      if (rel && !refs.includes(rel)) refs.push(rel);
    }
    return { refs, unfollowable };
  }

  // 一个 step 被执行到的脚本引用：所有载荷的 shell 词法结果 + loader 取值。
  function stepScriptRefs(step, options = {}) {
    const refs = [];
    for (const payload of stepPayloads(step)) {
      for (const rel of payloadScriptRefs(payload, options).refs) {
        if (!refs.includes(rel)) refs.push(rel);
      }
    }
    return refs;
  }

  // uses 白名单只装「本仓真正在用、且不执行仓库内容」的官方 action：它们的行为与仓库里的
  // 文件无关，跟不下去也不构成盲区。其余一律记 unfollowable —— 不去解析 composite 的实现，
  // 认不出的载体必须响，让它变成一条红断言，而不是一条静默跳过的 continue。
  const ALLOWED_USES = [/^actions\/checkout(?:@|$)/, /^actions\/setup-node(?:@|$)/];

  // result.json 的**写者**：run 块里同一行既用 node 启动某个脚本、又写 `--out .audit/result.json`。
  // 生产者必然同时出现这些字段名（它要造出这些字段），把它算成「读者」只会逼出一份手写豁免名单 ——
  // 判据变成名单的一刻就不再是判据。所以从 run 文本里推导，且这条推导本身被断言钉住。
  const RESULT_OUT_FLAG = "--out .audit/result.json";
  function resultWriters(stepList, options = {}) {
    const writers = [];
    for (const step of stepList) {
      for (const payload of stepPayloads(step)) {
        for (const line of payload.text.split("\n").map(stripShellComment)) {
          if (!line.includes(RESULT_OUT_FLAG)) continue;
          for (const rel of scriptRefs(line, options)) if (!writers.includes(rel)) writers.push(rel);
        }
      }
    }
    return writers;
  }

  // 静态、相对路径的 import / require：`import ... from "./x"` / `import "./x"` / `require("./x")`。
  // 口径层一被拆成两个文件，读者就坐在下一跳 —— 不跟这一跳，形状用例会静默失效。
  // 只认「静态 + 相对路径」这一格：裸模块名与动态拼出来的路径不在扫描面上（已知漏判，另记）。
  const IMPORT_SPEC = /(?:\bfrom\s*|\brequire\s*\(\s*|\bimport\s*\(?\s*)["'](\.{1,2}\/[^"']+)["']/g;
  const MAX_IMPORT_DEPTH = 3;
  const SCRIPT_EXTS = [".mjs", ".cjs", ".js"];

  function resolveImport(root, fromRel, spec) {
    // 用 posix 拼接再归一化：`../x` 与 `./a/../b` 要落到同一个 rel。
    const base = posix.normalize(posix.join(posix.dirname(fromRel), spec));
    const candidates = [
      base,
      ...SCRIPT_EXTS.map((ext) => base + ext),
      ...SCRIPT_EXTS.map((ext) => posix.join(base, "index" + ext)),
    ];
    for (const rel of candidates) {
      const abs = scriptPath(root, rel);
      if (abs && existsSync(abs)) return rel;
    }
    return null;
  }

  // 从 run 引用的脚本出发递归跟随 import/require：深度上限 3、防环（seen）。
  // 解析不到的进 missing —— 扫描面漏一格必须显式喊出来，不许在这里静默吞掉。
  function scriptTree(root, entry) {
    const files = [];
    const missing = [];
    const seen = new Set();
    const queue = [{ rel: entry, depth: 0 }];
    while (queue.length) {
      const { rel, depth } = queue.shift();
      if (seen.has(rel)) continue;
      seen.add(rel);
      const abs = scriptPath(root, rel);
      if (!abs || !existsSync(abs)) {
        missing.push(rel);
        continue;
      }
      files.push(rel);
      if (depth >= MAX_IMPORT_DEPTH) continue;
      const text = readFileSync(abs, "utf8");
      for (const match of text.matchAll(IMPORT_SPEC)) {
        const next = resolveImport(root, rel, match[1]);
        if (next) queue.push({ rel: next, depth: depth + 1 });
        else missing.push(match[1]);
      }
    }
    return { files, missing };
  }

  // 「跟不下去」的脚本形态：一律记 unfollowable，由形状用例断言为空 —— 看见就喊，不猜。
  // 1) 进程派生（child_process / spawn / exec / execFile / fork）：node 走了另一条进程，
  //    静态 import 图上没有这条边，光跟 import 就等于没有读者。
  // 2) 拼出来的键（[...].join(...)、["a" + "b"]、String.fromCharCode、模板串当键）：
  //    不做静态求值 —— 猜它拼出了什么，猜错一次绕过面就回来了。
  const CHILD_PROCESS = /child_process/;
  const CHILD_PROCESS_CALL = /(?<![.\w])(?:spawn|spawnSync|exec|execSync|execFile|execFileSync|fork)\s*\(/;
  const DYNAMIC_KEYS = [
    /\[\s*(?:["'][^"']*["']\s*,\s*)+["'][^"']*["']\s*\]\s*\.\s*join\s*\(/,
    // 方括号取键才可能是「拼出来的键」：左侧必须是标识符 / ] / )，
    // 否则数组字面量里的字符串拼接（`["x" + y]`）会变成误报。
    /[A-Za-z0-9_\])]\s*\[\s*["'][^"']*["']\s*\+/,
    /String\.fromCharCode/,
    /\[\s*`/,
  ];

  function unfollowableShapes(text) {
    const found = [];
    for (const line of text.split("\n")) {
      let kind = null;
      if (CHILD_PROCESS.test(line) || CHILD_PROCESS_CALL.test(line)) kind = "child-process";
      else if (DYNAMIC_KEYS.some((re) => re.test(line))) kind = "dynamic-key";
      if (kind && !found.some((entry) => entry.kind === kind)) found.push({ kind, excerpt: line.trim() });
    }
    return found;
  }

  // 扫描面覆盖到的脚本文件（含 import 跟随后的下一跳，含解析不到的）：
  // 解析不到就是扫描面漏了一格，这件事由形状用例显式断言，不在这里静默吞掉。
  // 跟不下去的形态同样显式记下来（进 unfollowable），并带上引用它的 step。
  function referencedScripts(stepList, options = {}) {
    const root = options.root ?? ROOT;
    const files = [];
    const missing = [];
    const unfollowable = [];
    const note = (entry) => {
      const clash = unfollowable.some((u) => u.step === entry.step && u.file === entry.file && u.kind === entry.kind);
      if (!clash) unfollowable.push(entry);
    };
    const follow = (payload, source) => {
      const { refs, unfollowable: shapes } = payloadScriptRefs(payload, { root });
      for (const shape of shapes) note({ step: source, file: null, ...shape });
      for (const rel of refs) {
        const tree = scriptTree(root, rel);
        for (const file of tree.files) if (!files.includes(file)) files.push(file);
        for (const gone of tree.missing) if (!missing.includes(gone)) missing.push(gone);
        for (const file of tree.files) {
          const abs = scriptPath(root, file);
          for (const shape of unfollowableShapes(readFileSync(abs, "utf8"))) note({ step: source, file, ...shape });
        }
      }
    };
    for (const step of stepList) {
      const stepId = step.id ?? step.name;
      for (const payload of stepPayloads(step)) follow(payload, stepId);
      // uses 是 run 之外的第二类载体：认不出的 action 会执行仓库外（或 composite 里）
      // 的代码，静态跟不下去 —— 记 unfollowable，让真 YAML 用例当场红。
      if (typeof step.uses === "string" && !ALLOWED_USES.some((re) => re.test(step.uses))) {
        note({ step: stepId, file: null, kind: "uses", detail: step.uses });
      }
    }
    // job 级载体与 step 载荷是同一个执行面：它们的脚本不进扫描面时，
    // 「没有别的读者」会退化成「这一个位置没扫到」。
    for (const payload of options.jobPayloads ?? []) follow(payload, payload.carrier);
    return { files, missing, unfollowable };
  }

  // JS 注释刻意**不剥离**（取舍）：要分清 `"http://x"` 里的 // 与注释起点，得上真的 JS 词法器；
  // 用正则会把它当注释起点，把同一行后面真正的解引用一起切掉 —— 欠判的方向正是担保失效的方向。
  // 所以宁可误报（注释里出现字段名也记一条，改注释即可），不许漏读。
  function fieldReadViolations(stepList, options = {}) {
    const root = options.root ?? ROOT;
    const writers = resultWriters(stepList, { root });
    const violations = [];
    for (const step of stepList) {
      const source = step.id ?? step.name;
      // 字段名判据看「被执行到的文本」：run 与被 with 带进来的内联脚本。
      // env 的值不是脚本本身（它由 --require/--import 带进来的**文件**负责，下面跟随），
      // 所以 env 只当载体，不在这里展开字段名。
      for (const payload of stepPayloads(step)) {
        if (payload.carrier !== "run" && !payload.carrier.startsWith("with")) continue;
        const lines = payload.text.split("\n").map(stripShellComment);
        for (const { field, re } of FIELD_READERS) {
          const hit = lines.find((line) => re.test(line));
          if (hit) violations.push({ step: source, field, excerpt: hit.trim() });
        }
      }
      // 跟随 import：读者可能坐在引用的脚本的下一跳（契约层拆文件就靠这条）。
      for (const entry of stepScriptRefs(step, { root })) {
        if (writers.includes(entry)) continue;
        for (const rel of scriptTree(root, entry).files) {
          const text = readFileSync(scriptPath(root, rel), "utf8");
          for (const { field, re } of FIELD_READERS) {
            const hit = text.split("\n").find((line) => re.test(line));
            if (hit) violations.push({ file: rel, field, excerpt: hit.trim() });
          }
        }
      }
    }
    // job 级载体（job.env.* / defaults.run.shell / 顶层 env）执行到的脚本同样进这一格：
    // 读者搬到 job 上，字段名判据也得跟得上，否则它只是换了个字段名判据看不见的位置。
    for (const payload of options.jobPayloads ?? []) {
      for (const entry of payloadScriptRefs(payload, { root }).refs) {
        if (writers.includes(entry)) continue;
        for (const rel of scriptTree(root, entry).files) {
          const text = readFileSync(scriptPath(root, rel), "utf8");
          for (const { field, re } of FIELD_READERS) {
            const hit = text.split("\n").find((line) => re.test(line));
            if (hit) violations.push({ file: rel, field, excerpt: hit.trim() });
          }
        }
      }
    }
    return violations;
  }

  // ---- 行为判据：不看字段名，看「谁碰了 result.json 的数据」 ----
  // 字段名判据的盲区实测过：JSON.parse 之后 Object.entries 遍历，一个字段名都不写，
  // 照样把 executors / comparison.counts 打印出来，83 条全绿。
  //
  // **判据的默认方向决定它拦不拦得住人，枚举决定它多久被绕过一次。**
  // 旧写法是「枚举读的拼写」：readFileSync( / 标识符紧邻 ( / jq。于是等价拼写全部 0 红：
  //   fs["readFileSync"](...)          计算属性
  //   fs.readFileSync.call(null, ...)  .call 包裹
  //   const rf = fs.readFileSync      别名
  //   读者整个搬进被引用的 .cjs，step 只写 node x.cjs
  // 每补一种拼写，等于把「还差哪几种」的清单交给对手。所以方向倒过来：
  //   **非写者步里只要引用了 result.json，默认就是违规**；
  // 放行只剩两条显式白名单 —— 写意图（resultJsonWriteIntent）与纯文本倒出（RESULT_DUMP_*），
  // 而且倒出只放行「原样输出、不带数据加工」的形态。
  const RESULT_JSON = /result\.json/;
  // 目录通配也是引用：.audit/*.json 把 result.json 一起读走，路径里却没有 result.json 这串字。
  const RESULT_JSON_GLOB = /\.audit\/[^\s"';|&)]*\*/;
  // 字符串字面量**本身就是这个路径**才算引用；字面量里顺嘴提到（人话消息、注释）不算 ——
  // 一句 echo 里的说明文字把整步染红，判据就会被人当噪音关掉。
  const RESULT_PATH_LITERAL = /^[^\s"'\x60]*result\.json$/;
  // 整行注释不参与判定（JS 的 // 注释里写着 result.json 是给人看的说明，不是引用）。
  // 只剔整行注释，行尾注释仍留在判据里：尾注释可以藏一句话，不能藏一次读。
  const COMMENT_ONLY_LINE = /^\s*(?:\/\/|\/\*|\*)/;
  // 没有显式读调用、但把整份内容当数据过一遍的兜底形态（JSON.parse / Object.entries）。
  // 只在**这一行数不到任何读调用**时才记一次：否则 JSON.parse(fs.readFileSync(...)) 会被数成两次读。
  const RESULT_JSON_PARSE_SHAPES = [/JSON\.parse/, /Object\.(?:entries|keys|values)\s*\(/];
  // 读的计价单位是**调用**，不是行：一行里两次 readFileSync 就是两次读。
  // 旧判据是「这一行里有没有写的样子」-> 整行 continue，于是写行里顺带的那次真读
  // 既不进 reads、也不占「一次读」的额度（实测：--out 行尾追加一次整体打印，92 条全绿）。
  const RESULT_JSON_READ_FILE_CALLS = [/\breadFileSync\s*\(/g, /\breadFile\s*\(/g, /\bcreateReadStream\s*\(/g];
  const RESULT_JSON_JQ = /\bjq\b/g;
  // 把 result.json 路径当参数交给一个函数，也是在把它当数据取用 —— 哪怕解析动作藏在
  // 包装函数里（兜底步的 read(p) 就是这种形状：那一行只有 JSON.parse 在函数定义处）。
  const RESULT_JSON_PATH_CALL = /([A-Za-z_$][\w$]*)\s*\(\s*["'][^"']*result\.json["']/g;
  // 已在别处计过的名字（读函数本身、写函数）：同一次调用不许算两遍，写调用更不是读。
  const RESULT_JSON_COUNTED_NAMES = [
    "readFileSync",
    "readFile",
    "createReadStream",
    "writeFileSync",
    "writeFile",
    "appendFileSync",
    "appendFile",
    "createWriteStream",
  ];
  // 「这一行是不是把文件当数据取用」的形状集合。它只用于**判定一次读**（写者步的一次额度），
  // 不用于决定红绿 —— 红绿由「引用 + 不在白名单」决定，所以这里认不全也不改变拦截方向。
  // 计算属性 fs["readFileSync"] 的名字会被掩码吃掉，故同时看方括号取键的结果。
  const RESULT_JSON_READ_SHAPES = [
    /\breadFileSync\b/,
    /\breadFile\b/,
    /\bcreateReadStream\b/,
    /\bjq\b/,
    /JSON\.parse/,
    /Object\.(?:entries|keys|values)\s*\(/,
  ];
  const RESULT_JSON_READ_KEYS = ["readFileSync", "readFile", "createReadStream"];

  function resultJsonReadCalls(line) {
    let count = 0;
    for (const re of RESULT_JSON_READ_FILE_CALLS) count += [...line.matchAll(re)].length;
    count += [...line.matchAll(RESULT_JSON_JQ)].length;
    for (const match of line.matchAll(RESULT_JSON_PATH_CALL)) {
      if (!RESULT_JSON_COUNTED_NAMES.includes(match[1])) count += 1;
    }
    if (count === 0 && RESULT_JSON_PARSE_SHAPES.some((re) => re.test(line))) return 1;
    return count;
  }

  // 写意图：默认拒绝里唯一的「我是写者」出口。判在**代码区**（掩掉字符串字面量之后）——
  // 于是 echo "--out .audit/result.json" 造不出伪写者步：字符串里写着 --out 曾经能
  // 换到「一次读」的额度（实测只靠别处断言才挡住）。写 API 的名字被方括号取用时也会
  // 被掩掉，所以同时看方括号取键的结果；.call 包裹不改名字，照旧命中。
  // 允许计算属性与 .call 是结构要求，不是功能列表。
  // 写意图不是某一种拼写：名字出现就算（调用 / .call / .apply / .bind / 取引用同族），
  // 计算属性形态（fs["writeFileSync"]）被掩码吃掉，由 RESULT_WRITE_COMPUTED 按原文再认一次。
  const RESULT_WRITE_NAMES = /\b(?:writeFileSync|writeFile|appendFileSync|appendFile|createWriteStream)\b/;
  const RESULT_WRITE_KEYS = ["writeFileSync", "writeFile", "appendFileSync", "appendFile", "createWriteStream"];

  // node -e '...' / python -c '...'：引号里装的是**程序**，不是数据 —— 把它当字符串掩掉，
  // 等于给「单行解释器写法」开一条免费通道（实测：单行 node -e 里按字段取，掩码后 0 红）。
  // 多行写法（node -e ' 换行 ... 换行 '）本来就落在未配对的引号里，两种写法行为一致。
  const INLINE_PROGRAM = /(?<![\w-])(?:node|deno|python3?|ruby|perl|bash|sh)\b[^\n]*?\s(?:-e|--eval|-c)(?:\s|=)/;
  // 计算属性取函数名：掩码会把键吃掉，所以按原文再认一次（结构要求，不是功能列表）。
  const RESULT_READ_COMPUTED = /\[\s*["'](?:readFileSync|readFile|createReadStream)["']\s*\]/;
  const RESULT_WRITE_COMPUTED = /\[\s*["'](?:writeFileSync|writeFile|appendFileSync|appendFile|createWriteStream)["']\s*\]/;

  function resultJsonLineInfo(rawLine) {
    const info = maskStringLiterals(rawLine);
    // 引号里是程序时，代码区就是这段程序本身 —— 只掩「数据」，不掩「被执行到的代码」。
    const code = INLINE_PROGRAM.test(rawLine) ? rawLine : info.masked;
    const literals = info.literals.map((value) => value.trim());
    const literalPaths = literals.filter((value) => RESULT_PATH_LITERAL.test(value));
    const globbed = RESULT_JSON_GLOB.test(code) || literals.some((value) => RESULT_JSON_GLOB.test(value));
    const referenced = RESULT_JSON.test(code) || literalPaths.length > 0 || globbed;
    return {
      raw: rawLine,
      masked: code,
      bracketKeys: info.bracketKeys,
      literals: info.literals,
      literalPaths,
      globbed,
      referenced,
    };
  }

  function resultJsonWriteIntent(info) {
    if (RESULT_WRITE_NAMES.test(info.masked)) return true;
    if (info.bracketKeys.some((key) => RESULT_WRITE_KEYS.includes(key))) return true;
    if (RESULT_WRITE_COMPUTED.test(info.raw)) return true;
    // 口径层的落盘形态：--out 必须是代码区里真的有一个参数。
    if (/--out(?:\s+|=)/.test(info.masked)) return true;
    // shell 重定向写同一份文件：node x.mjs > .audit/result.json / ... > ".audit/result.json"
    if (/>>?\s*[^\s;&|)]*result\.json/.test(info.masked)) return true;
    if (info.literalPaths.length > 0 && />>?\s*$/.test(info.masked.trimEnd())) return true;
    return false;
  }

  // 白名单「纯文本倒出」：真实 workflow 的「INFRA 留痕」步要把 result.json 原文塞进围栏 ——
  //   body=$(cat .audit/result.json 2>/dev/null || true)
  //   while [[ "$body" == *"$fence"* ]]; do fence=...; done
  //   printf '%s\n' "$body"
  // 放行单位是**行**，形态只有三种，且都不带数据加工：
  //   1) cat 直接把这一份文件倒出（可带 2>/dev/null、|| true、或赋值给一个文本变量）；
  //   2) echo / printf 只输出**上面倒出来的那个文本变量**（原样，不加管道）；
  //   3) [[ ]] / test 只做比较（围栏那一步要判断内容里有没有更长的反引号串）。
  // 出现 jq / JSON.parse / .字段 / Object.keys|entries|values / 写文件 / node|python|perl
  // / sed|awk|cut|grep|tee|dd|base64 / 管道到别的命令 -> 不是倒出而是取数据，立刻违规。
  const RESULT_DUMP_CAT_PATH = /^(?:\.{0,2}\/)*(?:[^\s"'\x60]+\/)?result\.json$/;
  const RESULT_DUMP_CAT =
    /^\s*(?:([A-Za-z_]\w*)\s*=\s*\$\(\s*)?cat\s+(?:-{1,2}[A-Za-z]+\s+)*(?:"([^"]*)"|'([^']*)'|([^\s;&|)]+))((?:\s+2?>\s*\/dev\/null)*)(?:\s*\|\|\s*true)?\s*\)?\s*$/;
  const RESULT_DUMP_OUT = /^\s*(?:echo|printf)\b/;
  const RESULT_DUMP_TEST = /^\s*(?:(?:while|if|elif|until|for)\s+)*(?:\[\[|\[|test)\s/;
  const RESULT_DUMP_FORBIDDEN =
    /(?:\bjq\b|JSON\.parse|Object\.(?:entries|keys|values)|\bnode\b|\bpython3?\b|\bperl\b|\bruby\b|\bsed\b|\bawk\b|\bcut\b|\btee\b|\bdd\b|\bgrep\b|\bhead\b|\btail\b|\bxargs\b|\bexec\b|\beval\b|\bsource\b|base64|openssl|\bcurl\b|\bwget\b|\bnc\b)/;
  const RESULT_DUMP_ALIAS_USE = /\$(?:\{([A-Za-z_]\w*)\}|([A-Za-z_]\w*))/g;
  // 真正的管道才 forbid：|| true 里第二个竖线前面也是竖线，只看后面会把 || 当管道。
  const PIPE_TO_OTHER = /(?<!\|)\|(?!\|)/;

  // 一段被执行到的文本 -> 逐行的引用分类。默认拒绝就在这个循环里：
  // 只要这一行引用了 result.json，除非它命中「写意图」或「纯文本倒出」，其余一律是违规。
  // 别名（body=$(cat ...) 之后原样输出）按**文本内**作用域跟踪：
  // 跨文本继承别名等于让另一个 step 借前一步的变量，那不是同一条命令。
  function scanResultJsonText(text) {
    const aliases = new Set();
    const entries = [];
    for (const rawLine of String(text).split("\n")) {
      const line = stripShellComment(rawLine);
      if (!line.trim() || COMMENT_ONLY_LINE.test(line)) continue;
      const info = resultJsonLineInfo(line);
      const aliasUse = [...line.matchAll(RESULT_DUMP_ALIAS_USE)]
        .map((match) => match[1] ?? match[2])
        .filter((name) => aliases.has(name));
      if (!info.referenced && aliasUse.length === 0) continue;
      // 1) 纯文本倒出：cat 整份文件倒出来，可赋值给变量供后面原样输出。
      if (info.referenced) {
        const dump = RESULT_DUMP_CAT.exec(line);
        if (dump) {
          const operand = (dump[2] ?? dump[3] ?? dump[4] ?? "").trim();
          if (RESULT_DUMP_CAT_PATH.test(operand) && !RESULT_DUMP_FORBIDDEN.test(line) && !PIPE_TO_OTHER.test(line)) {
            if (dump[1]) aliases.add(dump[1]);
            entries.push({ excerpt: line.trim(), dump: true, write: false, calls: 0 });
            continue;
          }
        }
      }
      // 2) 倒出来的文本变量：只许原样输出 / 比较，一经加工就是取数据。
      if (aliasUse.length > 0) {
        const allowed =
          (RESULT_DUMP_OUT.test(line) || RESULT_DUMP_TEST.test(line)) &&
          !RESULT_DUMP_FORBIDDEN.test(line) &&
          !PIPE_TO_OTHER.test(line);
        entries.push({ excerpt: line.trim(), dump: allowed, write: false, calls: 0 });
        continue;
      }
      // 3) 其余引用：写意图 -> 写者步；读形态 -> 一次读（写者步有一次额度）；
      //    两者都不是 -> 就是默认拒绝要抓的那一类（换什么拼写都不影响）。
      const write = resultJsonWriteIntent(info);
      const calls = resultJsonReadCalls(line);
      const readShape =
        calls > 0 ||
        RESULT_JSON_READ_SHAPES.some((re) => re.test(info.masked)) ||
        RESULT_READ_COMPUTED.test(info.raw) ||
        info.bracketKeys.some((key) => RESULT_JSON_READ_KEYS.includes(key));
      entries.push({ excerpt: line.trim(), dump: false, write, calls: Math.max(calls, readShape ? 1 : 0) });
    }
    return entries;
  }
  // 写者步的识别同样默认拒绝：不再要求 --out 这串字，只要「引用 result.json + 有写意图」
  // 就是写者 —— 计算属性 fs["writeFileSync"]、.call 包裹、shell 重定向都算。
  // 这条识别被断言钉住（真 workflow 的写者集合是 ["decide","fallback"]）：写侧认不出，
  // 写者步就退化成读者步，「一次读」的额度与「谁在产出」两件事同时失真。
  // 注释不提供写意图：判定前先剥 shell 注释（尾注里写一句 --out 曾经能把整步洗成写者）。
  function hasResultJsonWrite(text) {
    return scanResultJsonText(text).some((entry) => entry.write);
  }
  function stepTexts(step, options = {}) {
    const root = options.root ?? ROOT;
    const texts = stepPayloads(step).map((payload) => ({ where: payload.carrier, text: payload.text }));
    for (const rel of stepScriptRefs(step, { root })) {
      for (const file of scriptTree(root, rel).files) {
        const abs = scriptPath(root, file);
        if (abs && existsSync(abs)) texts.push({ where: file, text: readFileSync(abs, "utf8") });
      }
    }
    return texts;
  }

  // 写 result.json 的步（口径层与兜底）：这就是「按步放行」的那个步集合，从文本里推出来，
  // 不是手写名单 —— 补一个写者、删一个写者，这里立刻跟着变。
  function resultJsonWriterSteps(stepList, options = {}) {
    const root = options.root ?? ROOT;
    return stepList
      .filter((step) => stepTexts(step, { root }).some(({ text }) => hasResultJsonWrite(text)))
      .map((step) => step.id ?? step.name);
  }

  // 一次「数据读」= 引用 result.json 且这一行有读形态。
  // 判读/判写都在**剥掉 shell 注释之后**的行上做：注释里写一句 --out 不能让整行读洗白。
  // onWriteLine 只影响豁免资格（写者步只有**一次**纯读行的额度），不改变计数。
  function resultJsonReads(text) {
    const reads = [];
    for (const entry of scanResultJsonText(text)) {
      if (entry.dump) continue;
      for (let i = 0; i < entry.calls; i += 1) reads.push({ excerpt: entry.excerpt, onWriteLine: entry.write });
    }
    return reads;
  }

  // 默认拒绝的正身：引用了 result.json、既不是白名单倒出、也没有写意图、也不是一次读形态 ——
  // 一律违规。旧判据要「先认出一次读调用」才计数，于是计算属性 / .call / 别名 /
  // 把读者整个搬进被引用的 .cjs 全都 0 红。这条不看拼写，所以没有「还差哪几种」可以补。
  function resultJsonReferenceViolations(text) {
    return scanResultJsonText(text)
      .filter((entry) => !entry.dump && !entry.write && entry.calls === 0)
      .map((entry) => ({ excerpt: entry.excerpt }));
  }
  // 「整体枚举整份 result」：把 result.json 解析成对象之后整份过一遍。
  // 识别对象必须与「解析 result.json 的那个变量」绑定 —— 写者也会 JSON.stringify 自己拼的
  // payload，那不是这条的形状。口径层只按字段取用，出现一次就说明它在搬数据而不是产出数据。
  const RESULT_VAR_DECL = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=[^\n]*result\.json/g;
  const WHOLE_ENUM_CALL = /(?:Object\.(?:entries|keys|values)|JSON\.stringify)\s*\(\s*([A-Za-z_$][\w$]*)/g;
  // 整体 dump 同一性质：console.log(整份对象) 一次就把 verdict / conclusion / executors /
  // comparison 全写进公开 run log。只认「整个变量」——console.log(r.verdict) 是按字段取用。
  const WHOLE_DUMP_CALL =
    /(?:console\.(?:log|info|debug|warn|dir|table)|process\.stdout\.write)\s*\(\s*([A-Za-z_$][\w$]*)(?![.\w$?[\]])/g;

  function wholeResultEnumerations(text) {
    const source = String(text);
    const resultVars = [...source.matchAll(RESULT_VAR_DECL)].map((match) => match[1]);
    if (resultVars.length === 0) return [];
    const found = [];
    for (const line of source.split("\n").map(stripShellComment)) {
      for (const re of [WHOLE_ENUM_CALL, WHOLE_DUMP_CALL]) {
        for (const match of line.matchAll(re)) {
          if (resultVars.includes(match[1]) && !found.includes(line.trim())) found.push(line.trim());
        }
      }
    }
    return found;
  }

  // job 级载体被执行到的文本（含跟随到的脚本文件）：来源名指在 job 上（job.env.NODE_OPTIONS /
  // defaults.run.shell / env.KEY），where 指真正坐着那行代码的位置。
  function jobPayloadTexts(jobPayloadList, options = {}) {
    const root = options.root ?? ROOT;
    const texts = [];
    for (const payload of jobPayloadList) {
      texts.push({ source: payload.carrier, where: payload.carrier, text: payload.text });
      for (const rel of payloadScriptRefs(payload, { root }).refs) {
        for (const file of scriptTree(root, rel).files) {
          const abs = scriptPath(root, file);
          if (abs && existsSync(abs)) texts.push({ source: payload.carrier, where: file, text: readFileSync(abs, "utf8") });
        }
      }
    }
    return texts;
  }

  // 行为判据的违规：碰了 result.json 的数据、却不是**那一次**合法的读。
  // 报错带上载体（run / shell / with.script / env.NODE_OPTIONS / 脚本文件），不是一个布尔。
  //
  // 写者步的放行从「整步」收到「一次读」：写者步只保留与写同源的那一次，
  // 多出来的每一次都是读者；再额外禁止把整份 result 整体枚举。
  // 整步放行等于「这一步只要写得了，挂什么读者都行」—— 兜底步里再挂一处 Object.entries dump
  // 实测 87 条全绿，就是把豁免单位错设成步的结果。
  //
  // job 级载体对每个 step 都生效，没有「写它的那一步」可以豁免，所以整份都是读者候选。
  // 被引用的脚本文件（stepTexts 已经跟进去）走的是同一套分类：把读者写进一个 .cjs、
  // step 只写 node x.cjs，曾经是一条永久免费通道。
  function resultJsonReaderViolations(stepList, options = {}) {
    const root = options.root ?? ROOT;
    const producers = resultWriters(stepList, { root });
    const violations = [];
    for (const { source, where, text } of jobPayloadTexts(options.jobPayloads ?? [], { root })) {
      for (const read of resultJsonReads(text)) violations.push({ step: source, where, excerpt: read.excerpt });
      for (const bad of resultJsonReferenceViolations(text)) {
        violations.push({ step: source, where, excerpt: bad.excerpt });
      }
      for (const excerpt of wholeResultEnumerations(text)) violations.push({ step: source, where, excerpt });
    }
    for (const step of stepList) {
      const source = step.id ?? step.name;
      const texts = stepTexts(step, { root });
      const writes = texts.some(({ text }) => hasResultJsonWrite(text));
      const reads = texts.flatMap(({ where, text }) => resultJsonReads(text).map((read) => ({ where, ...read })));
      if (!writes) {
        for (const read of reads) violations.push({ step: source, where: read.where, excerpt: read.excerpt });
        // 默认拒绝在这里生效：非写者步里**任何**对 result.json 的引用都是违规，
        // 不要求先认出一次读调用 —— 白名单以外的写法一律落在这条上。
        for (const { where, text } of texts) {
          for (const bad of resultJsonReferenceViolations(text)) {
            violations.push({ step: source, where, excerpt: bad.excerpt });
          }
          // 整体枚举对**所有**步生效：不写 result.json 的步同样能把整份数据 dump 进日志，
          // 把它放在写者分支里，这道第二防线在非写者步上就是死代码。
          for (const excerpt of wholeResultEnumerations(text)) violations.push({ step: source, where, excerpt });
        }
        continue;
      }
      // 与写同源的那一次放行：**只在纯读行上**放行一次。挂在写行上的读不享豁免 ——
      // 写行是产出那一行，往它后面挂一次 readFileSync + dump 就是把产物整份搬进 run log。
      const exempt = reads.findIndex((read) => !read.onWriteLine);
      reads.forEach((read, index) => {
        if (index === exempt) return;
        violations.push({ step: source, where: read.where, excerpt: read.excerpt });
      });
      for (const { where, text } of texts) {
        // 写者步里白名单以外的引用同样是违规：写一次 + grep/jq 取字段不是「顺带读一次」。
        for (const bad of resultJsonReferenceViolations(text)) {
          violations.push({ step: source, where, excerpt: bad.excerpt });
        }
        // 整体枚举一条也不放行。写者自己的脚本文件（texts 里 where 就是生产者本身）除外：
        // 那份文件就是「与写同源」的那一份，它的按字段取用不该被当成搬运。
        if (producers.includes(where)) continue;
        for (const excerpt of wholeResultEnumerations(text)) violations.push({ step: source, where, excerpt });
      }
    }
    return violations;
  }
  // 「解引用形态」：.field 或 ["field"]（含 [ 'field' ]），都只在剥掉字符串字面量之后判。
  // 不剥字符串时，把真解引用换成 lines.push("r.executors .comparison .counts") 就能冒充：
  // 字段名还在、读没了，按字面看的对照照样绿（实测那种写法 71 条全绿）。而这时口径层
  // 已经不再读这三个字段 —— summary 里的「申报=」「agreed=」永久消失，全仓没有断言在看它。
  //
  // 方括号取字段必须带引号，剥完就看不见了，所以扫描时顺手记下来（bracketKeys）。
  // 逐行扫而不是整段：decide 的 JS 写在 shell 单引号里（node -e ' 那一行引号不配对），
  // 整段扫会把 shell 的开引号当成 JS 串首、把后面整段代码一起吃掉。
  // 一行内引号不配对时该行原样保留：宁可漏判形态，也不许把真解引用当文本删掉。
  const QUOTE_CHARS = ['"', "'", String.fromCharCode(96)];

  function maskStringLiterals(text) {
    let masked = "";
    const bracketKeys = [];
    const literals = [];
    for (const line of String(text).split("\n")) {
      let out = "";
      const keys = [];
      const values = [];
      let i = 0;
      let closed = true;
      while (i < line.length) {
        const quote = line[i];
        if (!QUOTE_CHARS.includes(quote)) {
          out += quote;
          i += 1;
          continue;
        }
        let j = i + 1;
        let value = "";
        while (j < line.length && line[j] !== quote) {
          if (line[j] === "\\") {
            value += line[j + 1] ?? "";
            j += 2;
            continue;
          }
          value += line[j];
          j += 1;
        }
        if (j >= line.length) {
          closed = false;
          break;
        }
        // 回看「[ + 引号串 + ]」—— 这是 obj["field"] 的形态。
        if (out.trimEnd().endsWith("[") && line.slice(j + 1).trimStart().startsWith("]")) keys.push(value);
        values.push(value);
        out += " ".repeat(j - i + 1);
        i = j + 1;
      }
      masked += closed ? out : line;
      if (closed) {
        bracketKeys.push(...keys);
        literals.push(...values);
      }
      masked += "\n";
    }
    return { masked, bracketKeys, literals };
  }

  const FIELD_DEREFERENCES = RESULT_FIELDS.map((field) => ({
    field,
    re: new RegExp("\\." + field + "(?![A-Za-z0-9_])"),
  }));

  function fieldDereferences(runText) {
    const text = String(runText)
      .split("\n")
      .map(stripShellComment)
      .join("\n");
    const { masked, bracketKeys } = maskStringLiterals(text);
    return FIELD_DEREFERENCES.filter(({ field, re }) => re.test(masked) || bracketKeys.includes(field)).map(
      ({ field }) => field,
    );
  }

  it("兜底补的结果不是第二份口径层：解引用 result.json 字段的读者只有口径层，且排在兜底之前", () => {
    const decideIndex = steps.findIndex((s) => s.id === "decide");
    const fallbackIndex = steps.findIndex((s) => s.id === "fallback");
    expect(decideIndex).toBeGreaterThan(-1);
    expect(fallbackIndex).toBeGreaterThan(decideIndex);
    // 兜底补出来的 {verdict,conclusion,exit,reason} 缺 executors / comparison；
    // 只要解引用这两个字段的读者只有口径层（在本步之前、只跑一次），它就不是活路径。
    // 报错要能直接看出「哪个 step、匹配到哪一行、哪个字段」，不是一个布尔。
    const violations = fieldReadViolations(steps, { jobPayloads: carrierPayloads });
    // 来源可以是 run 块（step）也可以是 run 块里被执行的脚本（file）：两者都算读者。
    const readers = [...new Set(violations.map((v) => v.step ?? v.file))];
    expect(readers, JSON.stringify(violations, null, 2)).toEqual(["decide"]);
    // 扫描面确实覆盖到了 run 块里被执行的脚本：引用解析不到就是扫描面漏了一格，
    // 那时「没有别的读者」会退化成「没扫到」，必须当成 harness 的错。
    const scripts = referencedScripts(steps, { jobPayloads: carrierPayloads });
    expect(scripts.missing, JSON.stringify(scripts.missing)).toEqual([]);
    // 跟不下去的形态同样必须为零：未知写法被静默跳过，正是这一批绕过面的共同根因。
    // 口径层与落盘槽都不派生进程、不拼键，这条断言在真仓库上不该有任何豁免。
    expect(scripts.unfollowable, JSON.stringify(scripts.unfollowable)).toEqual([]);
    expect(scripts.files).toContain("scripts/audit-findings.mjs");
    // 唯一的豁免是 result.json 的生产者，且它必须是从 run 文本里推出来的那一个。
    expect(resultWriters(steps)).toEqual(["scripts/audit-findings.mjs"]);
    // 行为判据（不认字段名）：任何碰 result.json 数据的步，都必须是写它的那一步。
    // 只写 Object.entries 枚举、不写任何字段名的读者，在这里没有藏身处。
    const behaviorReaders = resultJsonReaderViolations(steps, { jobPayloads: carrierPayloads });
    expect(behaviorReaders, JSON.stringify(behaviorReaders, null, 2)).toEqual([]);
    // 正向对照：确实有步在写 result.json。少了这条，上面那条会退化成「谁都没碰这个文件」。
    expect(resultJsonWriterSteps(steps)).toEqual(["decide", "fallback"]);
    // 正向对照：口径层确实**解引用**了这几个字段（`.<field>` / `["<field>"]`），
    // 不是「这行出现过这串字」。少了它，正则哪天扫不中任何东西时，
    // 「没有别的读者」会退化成「什么都没扫到」而照样绿。
    expect(fieldDereferences(steps.find((s) => s.id === "decide").run)).toEqual(RESULT_FIELDS);
  });

  it("形状判据认字段名不认拼写：jq 的 .[\"executors\"] 也是读者（逃得过旧正则，逃不过这条）", () => {
    // 旧写法 /r\.executors|comparison\.counts/ 只钉字面：同一语义换个拼写就能全绿通过。
    const escape = {
      id: "writeback",
      name: "回写 Check Run",
      run: "gh api repos/$GITHUB_REPOSITORY/check-runs --jq '.[\"executors\"] | length'\n",
    };
    expect(/r\.executors|comparison\.counts/.test(escape.run)).toBe(false);
    expect(fieldReadViolations([escape])).toEqual([
      { step: "writeback", field: "executors", excerpt: escape.run.trim() },
    ]);
  });

  it("扫描面只有 run 块：name / env / run 块里的 shell 注释都不算读者", () => {
    // audit.yml 在「结论兜底」上方有一句提到 executors 的注释，在 run 块外：误伤它就是假阳性。
    const outsideRun = [
      { id: "a", name: "executors 说明", env: { NOTE: "r.executors / comparison.counts" } },
      { id: "b", run: "# 只有口径层读 r.executors 与 comparison.counts\necho ok\n" },
    ];
    expect(fieldReadViolations(outsideRun)).toEqual([]);
    // 反面：run 块里真出现字段名（哪怕只是 echo 出来）就算读者 —— 判据不许有第二套。
    expect(fieldReadViolations([{ id: "c", run: "echo executors\n" }])).toEqual([
      { step: "c", field: "executors", excerpt: "echo executors" },
    ]);
  });

  it("判据是字段名不是子串：executors_count 只是前缀一样，不是 executors 的读者", () => {
    // 审查实测的误报形态：run 块里出现 executors_count（另一个名字）曾被判成 executors 的读者。
    expect(fieldReadViolations([{ id: "count", run: "echo executors_count\n" }])).toEqual([]);
    // 反向对照：同一个字段换个边界照样抓得住，边界不是「怎么都不算」。
    expect(fieldReadViolations([{ id: "count", run: "echo $((executors_count + executors))\n" }])).toEqual([
      { step: "count", field: "executors", excerpt: "echo $((executors_count + executors))" },
    ]);
  });

  it("行尾注释不是读：# 之后的字段名不算读者（整行注释与行尾注释同一判据）", () => {
    expect(fieldReadViolations([{ id: "c", run: "echo ok   # executors\n" }])).toEqual([]);
    expect(fieldReadViolations([{ id: "c", run: "echo ok; # r.executors 只在口径层读\n" }])).toEqual([]);
    // 剔除注释不许把真正的读一起切掉：代码在 # 之前，仍然算读者。
    expect(fieldReadViolations([{ id: "c", run: "jq -r '.[\"executors\"]' x.json   # 取执行器\n" }])).toEqual([
      { step: "c", field: "executors", excerpt: "jq -r '.[\"executors\"]' x.json" },
    ]);
    // 近似边界的一面：# 前面不是空白就不当注释起点（$# / ${#x} / foo#bar 都不切）。
    expect(fieldReadViolations([{ id: "c", run: "echo $# ${#x} executors\n" }])).toEqual([
      { step: "c", field: "executors", excerpt: "echo $# ${#x} executors" },
    ]);
    // 引号内的 # 不是注释起点（引号感知）：'echo "a # executors"' 是真会打印出字段名的行，
    // 旧实现把它当注释整段切掉 —— 读者没被看见，就被当成没有读者。
    expect(fieldReadViolations([{ id: "c", run: 'echo "a # executors"\n' }])).toEqual([
      { step: "c", field: "executors", excerpt: 'echo "a # executors"' },
    ]);
    // 反面：引号外的 # 仍然是注释起点，不许为这一条把整行注释也读成读者。
    expect(fieldReadViolations([{ id: "c", run: 'echo "a"; # executors\n' }])).toEqual([]);
  });

  it("真读者照样红：r.executors / .[\"executors\"] / 动态键 r[k] 都是同一字段的读法", () => {
    const readers = [
      { id: "dot", run: "for (const e of r.executors) keep(e)\n" },
      { id: "bracket", run: "jq -r '.[\"executors\"] | length'\n" },
      { id: "dynkey", run: 'const k = "executors"; r[k]\n' },
    ];
    expect(fieldReadViolations(readers)).toEqual([
      { step: "dot", field: "executors", excerpt: "for (const e of r.executors) keep(e)" },
      { step: "bracket", field: "executors", excerpt: "jq -r '.[\"executors\"] | length'" },
      { step: "dynkey", field: "executors", excerpt: 'const k = "executors"; r[k]' },
    ]);
  });


  it("扫描面含 run 块里被执行的脚本：加一个 scripts/probe-read.mjs 读 r.executors 必须红", () => {
    // 审查实测的绕过：读者写在脚本文件里，run 块只有一行 `node scripts/probe-read.mjs`。
    // 只扫 run 文本时这条 step 一无所获 —— 那种绿是扫描面缺失，不是判据合格。
    const probeStep = { id: "probe", name: "探针", run: "node scripts/probe-read.mjs\n" };
    // run 文本里一个字段名都没有：只扫 run 时这条 step 见不到任何读者。
    expect(probeStep.run).not.toMatch(/executors|comparison|counts/);
    // 沙箱里放一个真读者，再把它加进同一条 workflow 的 step 清单。
    const dir = mkdtempSync(join(tmpdir(), "audit-probe-"));
    mkdirSync(join(dir, "scripts"), { recursive: true });
    writeFileSync(
      join(dir, "scripts/probe-read.mjs"),
      'const r = JSON.parse(readFileSync(".audit/result.json", "utf8"));\nconsole.log(r.executors.length, r.comparison.counts.agreed);\n',
    );
    const violations = fieldReadViolations([...steps, probeStep], { root: dir });
    const excerpt = "console.log(r.executors.length, r.comparison.counts.agreed);";
    expect(violations.filter((v) => v.file === "scripts/probe-read.mjs")).toEqual([
      { file: "scripts/probe-read.mjs", field: "executors", excerpt },
      { file: "scripts/probe-read.mjs", field: "comparison", excerpt },
      { file: "scripts/probe-read.mjs", field: "counts", excerpt },
    ]);
    // 形状判据整体必须红：读者集合不再只有口径层。
    const readers = [...new Set(violations.map((v) => v.step ?? v.file))];
    expect(readers).toContain("scripts/probe-read.mjs");
    expect(readers).not.toEqual(["decide"]);
  });

  it("引号与续行不是绕道：双引号 / 单引号 / 反斜杠续行 / --flag / shebang 直执行都算被执行到的脚本", () => {
    // 缺陷形态：只剥前引号时，下面这几种写法既不出 violation、也不进 missing，
    // 于是「引用解析不到就红」那条断言在它们上面照样绿。
    const dir = mkdtempSync(join(tmpdir(), "audit-quote-"));
    mkdirSync(join(dir, "scripts"), { recursive: true });
    writeFileSync(
      join(dir, "scripts/probe-read.mjs"),
      'const r = JSON.parse(readFileSync(".audit/result.json", "utf8"));\nconsole.log(r.executors.length);\n',
    );
    const forms = [
      'node "scripts/probe-read.mjs"',
      "node 'scripts/probe-read.mjs'",
      // 续行：shell 删除「反斜杠 + 换行」（不换成空格），所以这仍是同一个路径。
      "node scripts/\\\nprobe-read.mjs",
      "node --experimental-vm-modules scripts/probe-read.mjs",
      "./scripts/probe-read.mjs --dry-run",
    ];
    for (const run of forms) {
      // 先证明形态真的落地：run 文本里一个字段名都没有，红只能来自被执行的脚本文件。
      expect(run, run).not.toMatch(/executors|comparison|counts/);
      // 解析得到的引用必须是同一个文件 —— 这是每条红证据的同一根。
      expect(scriptRefs(run), run).toEqual(["scripts/probe-read.mjs"]);
      expect(fieldReadViolations([{ id: "probe", run }], { root: dir }), run).toEqual([
        { file: "scripts/probe-read.mjs", field: "executors", excerpt: "console.log(r.executors.length);" },
      ]);
      // 引用解析得到：不许掉进 missing（掉进去就是扫描面又漏了一格）。
      expect(referencedScripts([{ id: "probe", run }], { root: dir }).missing, run).toEqual([]);
    }
  });

  it("扫描面跟随 import：wrapper 只写 import、读者在下一跳文件里，必须红", () => {
    // 缺陷形态：只扫 run 引用的那个文件本身。口径层一被拆成两个文件，
    // wrapper 里只有 `import "./probe-read.mjs"`，读者坐在下一跳 —— 形状用例静默失效。
    const dir = mkdtempSync(join(tmpdir(), "audit-import-"));
    mkdirSync(join(dir, "scripts"), { recursive: true });
    writeFileSync(join(dir, "scripts/wrapper.mjs"), 'import "./probe-read.mjs";\n');
    writeFileSync(
      join(dir, "scripts/probe-read.mjs"),
      'const r = JSON.parse(readFileSync(".audit/result.json", "utf8"));\nconsole.log(r.executors.length);\n',
    );
    const probeStep = { id: "probe", name: "探针", run: "node scripts/wrapper.mjs\n" };
    // 先证明「只扫 run / 只扫 wrapper」都会空过：两处文本里都没有字段名。
    expect(probeStep.run).not.toMatch(/executors|comparison|counts/);
    expect(readFileSync(join(dir, "scripts/wrapper.mjs"), "utf8")).not.toMatch(/executors/);
    expect(referencedScripts([probeStep], { root: dir })).toEqual({
      files: ["scripts/wrapper.mjs", "scripts/probe-read.mjs"],
      missing: [],
      unfollowable: [],
    });
    const violations = fieldReadViolations([probeStep], { root: dir });
    expect(violations).toEqual([
      { file: "scripts/probe-read.mjs", field: "executors", excerpt: "console.log(r.executors.length);" },
    ]);
    // 形状判据整体红：读者集合不再只有口径层。
    expect([...new Set(violations.map((v) => v.step ?? v.file))]).toEqual(["scripts/probe-read.mjs"]);
  });

  it("import 跟随：三种静态写法都跟得到，裸模块名不跟，深度上限 3，环不炸，解析不到进 missing", () => {
    const dir = mkdtempSync(join(tmpdir(), "audit-import-shapes-"));
    mkdirSync(join(dir, "scripts"), { recursive: true });
    const put = (rel, text) => writeFileSync(join(dir, rel), text);
    put("scripts/from.mjs", 'import { a } from "./hop-from.mjs";\n');
    put("scripts/hop-from.mjs", "export const a = 1;\n");
    put("scripts/bare.mjs", 'import "./hop-bare.mjs";\n');
    put("scripts/hop-bare.mjs", "export const b = 1;\n");
    put("scripts/req.mjs", 'const c = require("./hop-req.cjs");\n');
    put("scripts/hop-req.cjs", "module.exports = {};\n");
    // 链 d0 -> d1 -> d2 -> d3 -> d4：走到深度 3 为止，第 4 跳不跟。
    put("scripts/d0.mjs", 'import "./d1.mjs";\n');
    put("scripts/d1.mjs", 'import "./d2.mjs";\n');
    put("scripts/d2.mjs", 'import "./d3.mjs";\n');
    put("scripts/d3.mjs", 'import "./d4.mjs";\n');
    put("scripts/d4.mjs", "export const d = 1;\n");
    // 环：x <-> y 必须终止，且各自只出现一次。
    put("scripts/x.mjs", 'import "./y.mjs";\n');
    put("scripts/y.mjs", 'import "./x.mjs";\n');
    // 解析不到进 missing；裸模块名不在扫描面上、也不进 missing。
    put("scripts/gone.mjs", 'import "./nope.mjs";\nimport "yaml";\n');

    expect(scriptTree(dir, "scripts/from.mjs").files).toEqual(["scripts/from.mjs", "scripts/hop-from.mjs"]);
    expect(scriptTree(dir, "scripts/bare.mjs").files).toEqual(["scripts/bare.mjs", "scripts/hop-bare.mjs"]);
    expect(scriptTree(dir, "scripts/req.mjs").files).toEqual(["scripts/req.mjs", "scripts/hop-req.cjs"]);
    expect(scriptTree(dir, "scripts/d0.mjs").files).toEqual([
      "scripts/d0.mjs",
      "scripts/d1.mjs",
      "scripts/d2.mjs",
      "scripts/d3.mjs",
    ]);
    expect(scriptTree(dir, "scripts/x.mjs").files).toEqual(["scripts/x.mjs", "scripts/y.mjs"]);
    expect(scriptTree(dir, "scripts/gone.mjs")).toEqual({
      files: ["scripts/gone.mjs"],
      missing: ["./nope.mjs"],
    });
  });

  it("node 参数三类：带取值的 flag 不吃掉真脚本，--require/--import 的取值本身就是扫描面", () => {
    // 缺陷形态：node 之后只把「flag 段之后的第一个 token」当脚本，于是
    // node --require ./scripts/preload.cjs scripts/probe-read.mjs 里真脚本被 flag 的取值吃掉。
    const dir = mkdtempSync(join(tmpdir(), "audit-node-flags-"));
    mkdirSync(join(dir, "scripts"), { recursive: true });
    writeFileSync(
      join(dir, "scripts/probe-read.mjs"),
      'const r = JSON.parse(readFileSync(".audit/result.json", "utf8"));\nconsole.log(r.executors.length);\n',
    );
    writeFileSync(
      join(dir, "scripts/preload.cjs"),
      'const r = require("fs").readFileSync(".audit/result.json");\nconsole.log(r.executors);\n',
    );
    writeFileSync(join(dir, "scripts/ok.mjs"), "console.log(1);\n");

    const forms = [
      "node --require ./scripts/preload.cjs scripts/probe-read.mjs",
      "node --import ./scripts/preload.cjs scripts/probe-read.mjs",
      "node -r ./scripts/preload.cjs scripts/probe-read.mjs",
      "node --require=./scripts/preload.cjs scripts/probe-read.mjs",
    ];
    for (const run of forms) {
      // 取值本身也是 node 执行的模块：两个文件都在扫描面上，顺序就是 node 的执行顺序。
      expect(scriptRefs(run, { root: dir }), run).toEqual(["scripts/preload.cjs", "scripts/probe-read.mjs"]);
      expect(referencedScripts([{ id: "probe", run }], { root: dir }).missing, run).toEqual([]);
      expect(referencedScripts([{ id: "probe", run }], { root: dir }).unfollowable, run).toEqual([]);
      // 两个文件都读了字段：preload 与 probe 各一条，红只能来自被执行的脚本。
      expect(run).not.toMatch(/executors|comparison|counts/);
      expect(
        fieldReadViolations([{ id: "probe", run }], { root: dir }).map((v) => v.file),
        run,
      ).toEqual(["scripts/preload.cjs", "scripts/probe-read.mjs"]);
    }

    // 反例：不带取值的 flag / 内联代码 / 普通调用都不许判红。
    expect(scriptRefs("node --experimental-vm-modules scripts/ok.mjs", { root: dir })).toEqual(["scripts/ok.mjs"]);
    expect(scriptRefs("node -e 'console.log(1)'", { root: dir })).toEqual([]);
    expect(scriptRefs("node scripts/ok.mjs", { root: dir })).toEqual(["scripts/ok.mjs"]);
    for (const run of [
      "node --experimental-vm-modules scripts/ok.mjs",
      "node -e 'console.log(1)'",
      "node scripts/ok.mjs",
    ]) {
      expect(referencedScripts([{ id: "ok", run }], { root: dir }).unfollowable, run).toEqual([]);
      expect(fieldReadViolations([{ id: "ok", run }], { root: dir }), run).toEqual([]);
    }

    // 认不出的 flag 不许猜「它没有取值」：它可能吃掉下一个 token，那正是真脚本。
    const unknown = referencedScripts([{ id: "u", run: "node --unsafe-unknown-flag scripts/ok.mjs" }], { root: dir });
    expect(unknown.unfollowable).toEqual([
      { step: "u", file: null, kind: "node-flag", detail: "--unsafe-unknown-flag" },
    ]);
    expect(unknown.files).toEqual(["scripts/ok.mjs"]);
  });

  it("无扩展名脚本不静默丢：按 .mjs/.cjs/.js 补全探测，探测不到进 missing", () => {
    const dir = mkdtempSync(join(tmpdir(), "audit-noext-"));
    mkdirSync(join(dir, "scripts"), { recursive: true });
    // node 照跑无扩展名文件（CJS）：它是真读者，旧实现只看扩展名，在解析前就把它丢了。
    writeFileSync(
      join(dir, "scripts/probe-bare"),
      'const r = JSON.parse(require("fs").readFileSync(".audit/result.json", "utf8"));\nconsole.log(r.executors.length);\n',
    );
    writeFileSync(join(dir, "scripts/ok-bare"), "console.log(1);\n");
    writeFileSync(join(dir, "scripts/lib.mjs"), "console.log(2);\n");
    const bare = { id: "probe", run: "node scripts/probe-bare\n" };
    expect(bare.run).not.toMatch(/executors|comparison|counts/);
    expect(scriptRefs(bare.run, { root: dir })).toEqual(["scripts/probe-bare"]);
    expect(fieldReadViolations([bare], { root: dir })).toEqual([
      { file: "scripts/probe-bare", field: "executors", excerpt: "console.log(r.executors.length);" },
    ]);
    expect(referencedScripts([bare], { root: dir })).toEqual({
      files: ["scripts/probe-bare"],
      missing: [],
      unfollowable: [],
    });
    // 补全探测：node scripts/lib 落到 scripts/lib.mjs 上。
    expect(scriptRefs("node scripts/lib", { root: dir })).toEqual(["scripts/lib.mjs"]);
    // 反例：探测不到的名字不再静默丢，而是进 missing（扫描面漏一格必须喊出来）。
    expect(referencedScripts([{ id: "gone", run: "node scripts/nowhere\n" }], { root: dir })).toEqual({
      files: [],
      missing: ["scripts/nowhere"],
      unfollowable: [],
    });
    // 反例：带扩展名的正常路径仍走同一格，没被新逻辑搅坏。
    expect(referencedScripts([{ id: "ok", run: "node scripts/lib.mjs\n" }], { root: dir })).toEqual({
      files: ["scripts/lib.mjs"],
      missing: [],
      unfollowable: [],
    });
  });

  it("进程派生不静默：脚本里出现 child_process / spawn 就进 unfollowable，并带上引用它的 step", () => {
    const dir = mkdtempSync(join(tmpdir(), "audit-spawn-"));
    mkdirSync(join(dir, "scripts"), { recursive: true });
    writeFileSync(
      join(dir, "scripts/probe-read.mjs"),
      'const r = JSON.parse(readFileSync(".audit/result.json", "utf8"));\nconsole.log(r.executors.length);\n',
    );
    // node 走了另一条进程：静态 import 图上没有这条边，只跟 import 就等于没有读者。
    writeFileSync(
      join(dir, "scripts/wrapper.cjs"),
      'const { spawnSync } = require("node:child_process");\nspawnSync(process.execPath, ["scripts/probe-read.mjs"], { stdio: "inherit" });\n',
    );
    const wrapper = { id: "probe", run: "node scripts/wrapper.cjs\n" };
    expect(wrapper.run).not.toMatch(/executors|comparison|counts/);
    // 旧口径下的绿：wrapper 里没有字段名，probe-read 根本没被扫到。
    expect(fieldReadViolations([wrapper], { root: dir })).toEqual([]);
    expect(referencedScripts([wrapper], { root: dir }).files).toEqual(["scripts/wrapper.cjs"]);
    expect(referencedScripts([wrapper], { root: dir }).unfollowable).toEqual([
      {
        step: "probe",
        file: "scripts/wrapper.cjs",
        kind: "child-process",
        excerpt: 'const { spawnSync } = require("node:child_process");',
      },
    ]);
    // 反例：正则的 .exec( 不是进程派生，不许被判红。
    writeFileSync(
      join(dir, "scripts/regex-exec.mjs"),
      'const m = /x/.exec("x");\nconst s = "a".exec;\nconsole.log(m, s);\n',
    );
    expect(referencedScripts([{ id: "ok", run: "node scripts/regex-exec.mjs" }], { root: dir })).toEqual({
      files: ["scripts/regex-exec.mjs"],
      missing: [],
      unfollowable: [],
    });
  });

  it("行尾标点不吃路径：node scripts/x.mjs 后面的 ; ) && & | > 都只是分隔", () => {
    const dir = mkdtempSync(join(tmpdir(), "audit-punct-"));
    mkdirSync(join(dir, "scripts"), { recursive: true });
    writeFileSync(
      join(dir, "scripts/probe-read.mjs"),
      'const r = JSON.parse(readFileSync(".audit/result.json", "utf8"));\nconsole.log(r.executors.length);\n',
    );
    const forms = [
      "node scripts/probe-read.mjs;",
      "node scripts/probe-read.mjs)",
      "node scripts/probe-read.mjs && exit 0",
      "node scripts/probe-read.mjs &",
      "node scripts/probe-read.mjs | tee /dev/null",
      "node scripts/probe-read.mjs > /dev/null",
    ];
    for (const run of forms) {
      expect(scriptRefs(run, { root: dir }), run).toEqual(["scripts/probe-read.mjs"]);
      expect(referencedScripts([{ id: "probe", run }], { root: dir }).missing, run).toEqual([]);
      expect(fieldReadViolations([{ id: "probe", run }], { root: dir }), run).toEqual([
        { file: "scripts/probe-read.mjs", field: "executors", excerpt: "console.log(r.executors.length);" },
      ]);
    }
    // 反例：同一脚本跑两次只算一个引用，标点不会造出幽灵引用。
    expect(scriptRefs("node scripts/ok.mjs; node scripts/ok.mjs;", { root: dir })).toEqual(["scripts/ok.mjs"]);
  });

  it("node 只在裸词位置才算跟得上：bash -c / 变量 / 绝对路径不许静默跳过", () => {
    const dir = mkdtempSync(join(tmpdir(), "audit-node-shapes-"));
    mkdirSync(join(dir, "scripts"), { recursive: true });
    writeFileSync(
      join(dir, "scripts/probe-read.mjs"),
      'const r = JSON.parse(readFileSync(".audit/result.json", "utf8"));\nconsole.log(r.executors.length);\n',
    );
    // 绝对路径调 node：静态可解，照样跟得到 —— 真读者必须红。
    expect(scriptRefs("/usr/bin/node scripts/probe-read.mjs", { root: dir })).toEqual(["scripts/probe-read.mjs"]);
    expect(fieldReadViolations([{ id: "abs", run: "/usr/bin/node scripts/probe-read.mjs" }], { root: dir })).toEqual([
      { file: "scripts/probe-read.mjs", field: "executors", excerpt: "console.log(r.executors.length);" },
    ]);
    // bash -c 里再包一层 shell：静态跟不了，但必须响（旧实现连「看见」都没有）。
    const shellC = { id: "shellc", run: 'bash -c "node scripts/probe-read.mjs"\n' };
    expect(shellC.run).not.toMatch(/executors|comparison|counts/);
    expect(fieldReadViolations([shellC], { root: dir })).toEqual([]);
    expect(referencedScripts([shellC], { root: dir }).unfollowable).toEqual([
      { step: "shellc", file: null, kind: "shell-c", detail: "node scripts/probe-read.mjs" },
    ]);
    // 变量当命令头：认得出在跑 node，可执行文件路径静态不可解。
    const dynamic = { id: "dyn", run: "$NODE_BIN scripts/probe-read.mjs\n" };
    expect(referencedScripts([dynamic], { root: dir }).unfollowable).toEqual([
      { step: "dyn", file: null, kind: "dynamic-node", detail: "$NODE_BIN scripts/probe-read.mjs" },
    ]);
    // 反例：bash 跑的不是 node 就不响（否则这条判据会被噪声埋掉）。
    expect(referencedScripts([{ id: "npm", run: 'bash -c "npm run check"\n' }], { root: dir }).unfollowable).toEqual(
      [],
    );
    // 反例：裸词 node 的正常写法没有任何 unfollowable。
    expect(referencedScripts([{ id: "ok", run: "node scripts/probe-read.mjs\n" }], { root: dir }).unfollowable).toEqual(
      [],
    );
  });

  it("拼出来的键不静默：字面量数组 .join / 字符串相加 / fromCharCode 进 unfollowable，正常 join 不算", () => {
    const dir = mkdtempSync(join(tmpdir(), "audit-dynkey-"));
    mkdirSync(join(dir, "scripts"), { recursive: true });
    const shapes = [
      [
        "scripts/split-key.mjs",
        'const key = ["execu", "tors"].join("");\nconst r = JSON.parse(readFileSync(".audit/result.json", "utf8"));\nconsole.log(r[key]);\n',
        'const key = ["execu", "tors"].join("");',
      ],
      [
        "scripts/concat-key.mjs",
        'const r = JSON.parse(readFileSync(".audit/result.json", "utf8"));\nconsole.log(r["execu" + "tors"]);\n',
        'console.log(r["execu" + "tors"]);',
      ],
      [
        "scripts/char-key.cjs",
        "const k = String.fromCharCode(101, 120);\nconsole.log(r[k]);\n",
        "const k = String.fromCharCode(101, 120);",
      ],
    ];
    for (const [rel, text, excerpt] of shapes) {
      writeFileSync(join(dir, rel), text);
      const run = "node " + rel;
      // 先证明字段名判据在这三行上什么也看不见：拆词/拼接正是它看不见的形态。
      expect(fieldReadViolations([{ id: "probe", run }], { root: dir }), rel).toEqual([]);
      expect(referencedScripts([{ id: "probe", run }], { root: dir }).unfollowable, rel).toEqual([
        { step: "probe", file: rel, kind: "dynamic-key", excerpt },
      ]);
    }
    // 反例：正常 join（数组元素不是字面量、键不是拼出来的）不许判红。
    writeFileSync(join(dir, "scripts/ok.mjs"), 'const lines = [];\nconst s = lines.join("\\n");\nconsole.log(s);\n');
    expect(referencedScripts([{ id: "ok", run: "node scripts/ok.mjs" }], { root: dir })).toEqual({
      files: ["scripts/ok.mjs"],
      missing: [],
      unfollowable: [],
    });
  });

  it("正向对照必须是解引用：把口径层真读那两行换成纯字面量拼接，对照必须红", () => {
    // 审查实测的蒙法：字段名还在，读没了。按字面看的对照照样绿。
    const decide = steps.find((s) => s.id === "decide");
    const mutated = decide.run
      .split("\n")
      .map((line) =>
        line.includes("r.executors") || line.includes("r.comparison.counts")
          ? 'lines.push("executors comparison counts");'
          : line,
      )
      .join("\n");
    // 先证明变异真的落地：那两处解引用不在文本里了。
    expect(mutated).not.toContain("r.executors");
    expect(mutated).not.toContain("r.comparison.counts");
    // 字段名还在，所以「有没有读者」照样命中 —— 这正是旧对照空过的方式。
    expect(fieldReadViolations([{ id: "decide", run: mutated }]).map((v) => v.field)).toEqual(RESULT_FIELDS);
    // 但它不是解引用形态，正向对照必须红。
    expect(fieldDereferences(mutated)).toEqual([]);
  });

  it("正向对照不认引号里的文本：lines.push(\"r.executors .comparison .counts\") 不是解引用", () => {
    // 审查实测：把 decide 的两行真解引用换成下面这一行，71 条全绿 —— 字段名还在、读没了，
    // 而按字面看的正向对照照样通过。剥掉字符串字面量之后这行不再算解引用。
    const forged = 'lines.push("r.executors .comparison .counts");\n';
    // 先证明这行确实含三个字段名：旧对照就是被这一串字母骗过的。
    expect(RESULT_FIELDS.every((field) => forged.includes(field))).toBe(true);
    expect(fieldDereferences(forged)).toEqual([]);
    // 真解引用两种写法仍然认得（剥字符串不许把 `.field` 与 obj["field"] 一起删掉）。
    expect(fieldDereferences('for (const e of r.executors) keep(e);\n')).toEqual(["executors"]);
    expect(fieldDereferences('const c = r["comparison"].counts;\n')).toEqual(["comparison", "counts"]);
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

  it("PR_INPUT 里的换行不许注进 $GITHUB_OUTPUT：恶意串被收窄成「没给 PR 号」", () => {
    // pr 既要进 $GITHUB_OUTPUT 也要进注解文本，所以它本身就是注解注入面：
    // 一个换行就能让 GITHUB_OUTPUT 多出一行 "::error title=forged::pwned"。
    // 守卫是「整串必须全是数字」，不是「截到第一行」。
    const forged = "2\n::error title=forged::pwned";
    const out = runWorkflow(
      { AUDIT_FINDINGS_A: pass, AUDIT_FINDINGS_B: pass },
      { "inputs.pr": forged },
    );
    expect(out.outputs.ctx.pr).toBe("");
    expect(out.outputs.ctx.ok).toBe("0");
    // 值面：$GITHUB_OUTPUT 的原文件里任何一行都不许以 :: 开头 —— 那就是一条注解。
    expect(out.raw.ctx.split("\n").filter((line) => line.startsWith("::"))).toEqual([]);
    expect(out.raw.ctx).not.toContain("pwned");
    // 恶意串没有被当成 PR 号去查：一次 headRefOid 都没调（账本在、这一项 0 条）。
    expectNoGhCalls(out, "headRefOid");
    // ctx 自己那条 warning 也不许被注入拆成第二行注解。
    const ctxStdout = out.ran.find((s) => s.name === "解析 PR 上下文").stdout;
    expect(ctxStdout.split("\n").filter((line) => line.startsWith("::"))).toEqual([
      "::warning::取不到 PR #? 的 head sha：本次判不了，按 INFRA 回写",
    ]);
    // 退化路径必须与「没给 PR 号」逐字段一致：ctx 的 outputs 与 POST 出去的 payload 都一样。
    const blank = runWorkflow(
      { AUDIT_FINDINGS_A: pass, AUDIT_FINDINGS_B: pass },
      { "inputs.pr": "" },
    );
    expect(out.outputs.ctx).toEqual(blank.outputs.ctx);
    expect(out.payload).toEqual(blank.payload);
  });

  it("正例：PR_INPUT=2 收窄后仍是 2，head sha 来自 gh 的 headRefOid", () => {
    // 没有这条，上一条可以被「把 ctx 写死成 ok=0」满足 —— 守卫等于被删掉也不见红。
    const out = runWorkflow({ AUDIT_FINDINGS_A: pass, AUDIT_FINDINGS_B: pass });
    expect(out.outputs.ctx).toMatchObject({ pr: "2", sha: "cafebabe", ok: "1" });
    expect(out.payload.head_sha).toBe("cafebabe");
  });

  it("ctx 步从未运行（checkout 先挂了）：判不了 仍然 POST，落点退到 github.sha 且非空", () => {
    // 真形状：ctx 被跳过，于是它的 outputs 一个都没有（ok 是空串，不是 "0"）。
    // 沙箱不模拟「前一步红了就跳过后续步骤」，这里用 skip 把 ctx 整个拿掉，
    // 效果等价（后续步骤读到的就是「这一步从没写过 outputs」）。
    const out = runWorkflow(
      { AUDIT_FINDINGS_A: pass, AUDIT_FINDINGS_B: pass },
      {},
      undefined,
      { skip: ["解析 PR 上下文"] },
    );
    expect(out.outputs.ctx).toBeUndefined();
    expect(out.ran.some((s) => s.name === "解析 PR 上下文")).toBe(false);
    // 只 POST 一次，且 head_sha 非空：空 sha 会被 GitHub 拒收，那时服务器上
    // 一条 Check Run 都没有 —— 「一定有一条 audit Check Run」当场不成立。
    expect(out.calls.filter((c) => c.includes("check-runs"))).toHaveLength(1);
    expect(out.calls.filter((c) => c.includes("--method POST"))).toHaveLength(1);
    expect(out.payload).toMatchObject({ name: "audit", conclusion: "action_required" });
    expect(out.payload.head_sha).toBe("f00dfeed");
    // 这一种「判不了」是管线自己坏了，不是 PR 的问题：标题与摘要都要这么写。
    expect(String(out.payload.output.title)).toContain("管线没跑起来");
    expect(String(out.payload.output.title)).toContain("不是 PR head");
    expect(String(out.payload.output.summary)).toContain("管线");
    expect(out.summary).toContain("管线");
    expect(out.summary).toContain("不是这个 PR 的问题");
    // 另外两条写 payload 的路径只在 ok=1 时才跑，这一路径上不该抢写。
    expect(out.ran.some((s) => s.name === "结论兜底")).toBe(false);
    expect(out.ran.some((s) => s.name === "回写 Check Run")).toBe(false);
    // 结论的红由 POST 出去的 Check Run 承载，job 级 check 不重复染红。
    expect(out.ran.at(-1).status).toBe(0);
  });

  it("两种「判不了」分得开：ctx 跑过解不出 ≠ ctx 没跑（后者是管线故障）", () => {
    const pass2 = { AUDIT_FINDINGS_A: pass, AUDIT_FINDINGS_B: pass };
    const noSha = runWorkflow(pass2, { "inputs.pr": "" });
    const noCtx = runWorkflow(pass2, {}, undefined, { skip: ["解析 PR 上下文"] });
    expect(String(noSha.payload.output.title)).toContain("PR 上下文解不出");
    expect(String(noSha.payload.output.title)).not.toContain("管线");
    expect(String(noCtx.payload.output.title)).toContain("管线没跑起来");
    expect(noSha.summary).not.toContain("管线");
    expect(noCtx.summary).toContain("管线");
    // 两种都落在同一个非空 sha 上：这条不变式不分来历。
    expect(noSha.payload.head_sha).toBe("f00dfeed");
    expect(noCtx.payload.head_sha).toBe("f00dfeed");
  });

  it("判不了也要有个落点：ctx 与 github.sha 都空时这一步必须红，且一份 payload 都不许写", () => {
    // 这条守住「落点非空」这条硬断言本身：ctx 整步被跳过（outputs 全空，ok 是空串），
    // 连 github.sha 也空 —— 落点的两个来源同时没有来源。
    // 把 if (!sha) throw 改成 if (false) throw，这里立刻变成 status 0 + 文件存在：
    // 于是「一定会写出一条 Check Run」的担保会在一个空 head_sha 上悄悄失真。
    const out = runWorkflow(
      { AUDIT_FINDINGS_A: pass, AUDIT_FINDINGS_B: pass },
      { "github.sha": "" },
      undefined,
      { skip: ["解析 PR 上下文"] },
    );
    // 这几条是同一个不变式的几面（红了 / 喊出原因 / 没有半份 payload 落地），
    // 用 soft 让变异实验一次看到全部后果，而不是只看到第一条。
    expect.soft(out.outputs.ctx).toBeUndefined();
    const step = out.ran.find((s) => s.name === "判不了：回写 INFRA");
    expect.soft(step).toBeDefined();
    // 红，而且红在「落点非空」这条断言上（不是别的错误恰好在同一行附近）。
    expect.soft(step?.status).not.toBe(0);
    // 只断言「喊了」，不断言喊的措辞：文案可以改（改成「没有落点」也算），行为不变就不该红。
    expect.soft(String(step?.stderr ?? "").trim().length).toBeGreaterThan(0);
    // 硬断言与落盘是二选一：它响了，就不许有半份 head_sha 为空的 payload 落地。
    expect.soft(existsSync(join(out.dir, ".audit/check-run.json"))).toBe(false);
    expect.soft(existsSync(join(out.dir, ".audit/payload.json"))).toBe(false);
    expect.soft(out.payload).toBeNull();
    // 「零次调用」的显式形态：账本在（假 gh 跑得起来）、行数是 0（一次都没调）。
    expect.soft(existsSync(join(out.dir, "calls.log"))).toBe(true);
    expect.soft(out.calls).toHaveLength(0);
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

  it("账本是假 gh 建的而不是「读不到就当空」：ENOENT 抛错，零调用是账本在、0 行", () => {
    // 缺陷形态：`existsSync ? readFileSync : []` 让「harness 断了」与「一次没调」同值，
    // 于是所有 toHaveLength(0) 的断言在假 gh 不记账时照样绿。
    const dir = mkdtempSync(join(tmpdir(), "audit-ledger-"));
    expect(() => readGhLedger(dir)).toThrow(/账本不存在/);
    writeFileSync(join(dir, "calls.log"), "");
    expect(readGhLedger(dir)).toEqual([]);
    writeFileSync(join(dir, "calls.log"), "gh pr view 2 --json headRefOid\n");
    expect(readGhLedger(dir)).toEqual(["gh pr view 2 --json headRefOid"]);

    // 真跑一条合法零调用的路径（管线在调 gh 之前就红了）：账本在、0 行。
    const zero = runWorkflow(
      { AUDIT_FINDINGS_A: pass, AUDIT_FINDINGS_B: pass },
      { "github.sha": "" },
      undefined,
      { skip: ["解析 PR 上下文"] },
    );
    expect(existsSync(join(zero.dir, "calls.log"))).toBe(true);
    expect(zero.calls).toHaveLength(0);

    // 反向对照：同一条 harness 路径上真调用一次，账本恰好长一行。
    // 把假 gh 的记账行换成 `true`（审查者的变异），这里立刻 0 行 → 红。
    const one = runWorkflow(
      { AUDIT_FINDINGS_A: pass, AUDIT_FINDINGS_B: pass },
      { "inputs.pr": "" },
    );
    expect(existsSync(join(one.dir, "calls.log"))).toBe(true);
    expect(one.calls).toHaveLength(1);
    expect(one.calls[0]).toContain("check-runs");
  });

  it("先 cd 到子目录再调 gh：条目照样落在根账本（账本路径在生成时写死，不看 $PWD）", () => {
    // 缺陷形态：记账写 "$PWD/calls.log"。某个 step 先 cd sub 再调 gh 时，条目进子目录，
    // 根账本**存在但 0 行** —— 「账本在、0 行 = 零调用」这条担保被空过。
    const { dir, bin } = sandbox();
    mkdirSync(join(dir, "sub"), { recursive: true });
    expect(readGhLedger(dir)).toEqual([]);
    const spawned = spawnSync(
      "bash",
      ["--noprofile", "--norc", "-eo", "pipefail", "-c", "cd sub && gh api repos/o/r/check-runs --method POST"],
      { cwd: dir, env: { PATH: bin + ":" + process.env.PATH, HOME: dir }, encoding: "utf8" },
    );
    expect(spawned.status, String(spawned.stderr)).toBe(0);
    // 根账本必须至少 1 行：0 行就是「零调用」，也正是 cd 记账被空过时的样子。
    const calls = readGhLedger(dir);
    expect(calls.filter((call) => call.includes("check-runs"))).toHaveLength(1);
    // 子目录里不许有第二本账：那本账的 0 行正是「根账本 0 行」的来历。
    expect(existsSync(join(dir, "sub/calls.log"))).toBe(false);
  });

  it("上游没注入 findings：不写 pass，落成 INFRA", () => {
    const out = runWorkflow({ AUDIT_FINDINGS_A: "", AUDIT_FINDINGS_B: "" });
    expect(out.payload.conclusion).toBe("action_required");
    expect(out.outputs.decide.verdict).toBe("INFRA");
    expect(out.summary).toContain("INFRA");
  });

  it("载体不是只有 run：github-script 的 with 脚本 / composite 的 uses / NODE_OPTIONS 的 --require 都上门", () => {
    const dir = mkdtempSync(join(tmpdir(), "audit-carrier-"));
    mkdirSync(join(dir, "scripts"), { recursive: true });
    // 读者不写字段名（Object.entries 枚举），字段名判据在它上面什么也看不见。
    const readerBody =
      'const r = JSON.parse(readFileSync(".audit/result.json", "utf8"));\nfor (const [k, v] of Object.entries(r)) console.log(k, v);\n';
    writeFileSync(join(dir, "scripts/probe-env.cjs"), readerBody);

    // 1) github-script：执行面在 with.script，旧扫描面（只认 run）连看都没看它。
    const githubScript = { id: "gs", name: "摘要", uses: "actions/github-script@v7", with: { script: readerBody } };
    expect(githubScript.with.script).not.toMatch(/executors|comparison|counts/);
    expect(fieldReadViolations([githubScript], { root: dir })).toEqual([]);
    expect(resultJsonReaderViolations([githubScript], { root: dir })).toEqual([
      {
        step: "gs",
        where: "with.script",
        excerpt: 'const r = JSON.parse(readFileSync(".audit/result.json", "utf8"));',
      },
      // 第二道防线（整体枚举）对**所有**载体生效，不只对写者步：不写 result.json 的载体
      // 同样能把整份数据 dump 进日志。把它关在写者分支里，那道判据就是死代码。
      {
        step: "gs",
        where: "with.script",
        excerpt: "for (const [k, v] of Object.entries(r)) console.log(k, v);",
      },
    ]);
    // 认不出的 action 也不许静默跳过：它执行的是仓库外的实现。
    expect(referencedScripts([githubScript], { root: dir }).unfollowable).toEqual([
      { step: "gs", file: null, kind: "uses", detail: "actions/github-script@v7" },
    ]);

    // 2) composite action：内部 run 照跑，静态跟不下去 —— 必须响，不去猜它的实现。
    const composite = { id: "comp", name: "复合", uses: "./.github/actions/summarize" };
    expect(referencedScripts([composite], { root: dir }).unfollowable).toEqual([
      { step: "comp", file: null, kind: "uses", detail: "./.github/actions/summarize" },
    ]);

    // 3) NODE_OPTIONS 的 --require：模块在 node 启动前就执行，读者坐在 env 里、run 里一个字段名都没有。
    const envStep = {
      id: "env",
      name: "带前置模块",
      env: { NODE_OPTIONS: "--require ./scripts/probe-env.cjs" },
      run: 'node -e "console.log(1)"\n',
    };
    expect(envStep.run).not.toMatch(/executors|comparison|counts/);
    expect(fieldReadViolations([envStep], { root: dir })).toEqual([]);
    const envScanned = referencedScripts([envStep], { root: dir });
    expect(envScanned.files).toEqual(["scripts/probe-env.cjs"]);
    expect(envScanned.missing).toEqual([]);
    expect(envScanned.unfollowable).toEqual([]);
    expect(resultJsonReaderViolations([envStep], { root: dir })).toEqual([
      {
        step: "env",
        where: "scripts/probe-env.cjs",
        excerpt: 'const r = JSON.parse(readFileSync(".audit/result.json", "utf8"));',
      },
      // env 载体上第二道防线同样生效：整份枚举不看载体，只看「碰没碰这份数据」。
      {
        step: "env",
        where: "scripts/probe-env.cjs",
        excerpt: "for (const [k, v] of Object.entries(r)) console.log(k, v);",
      },
    ]);

    // 反例：本仓真在用的官方 action 不是未知载体，不含读 result.json 的普通 step 也不许红。
    const allowed = [
      { name: "checkout", uses: "actions/checkout@v4" },
      { name: "node", uses: "actions/setup-node@v4", with: { "node-version": 20 } },
      { id: "ok", run: "echo ok\n" },
    ];
    expect(referencedScripts(allowed, { root: dir })).toEqual({ files: [], missing: [], unfollowable: [] });
    expect(resultJsonReaderViolations(allowed, { root: dir })).toEqual([]);
    expect(fieldReadViolations(allowed, { root: dir })).toEqual([]);
  });

  it("行为判据不认字段名：JSON.parse 之后 Object.entries 枚举也算读者", () => {
    const dir = mkdtempSync(join(tmpdir(), "audit-behavior-"));
    mkdirSync(join(dir, "scripts"), { recursive: true });
    // 审查实测的绕过：一个字段名都不写，照样把 executors / comparison.counts 打印出来。
    const body =
      'const r = JSON.parse(readFileSync(".audit/result.json", "utf8"));\nfor (const [k, v] of Object.entries(r)) console.log(k, JSON.stringify(v));\n';
    writeFileSync(join(dir, "scripts/probe-pos.mjs"), body);
    const probe = { id: "probe", run: "node scripts/probe-pos.mjs\n" };
    expect(probe.run).not.toMatch(/executors|comparison|counts/);
    expect(body).not.toMatch(/executors|comparison|counts/);
    // 字段名判据在这条上完全是绿的 —— 这正是它被绕过的方式。
    expect(fieldReadViolations([probe], { root: dir })).toEqual([]);
    expect(resultJsonReaderViolations([probe], { root: dir })).toEqual([
      {
        step: "probe",
        where: "scripts/probe-pos.mjs",
        excerpt: 'const r = JSON.parse(readFileSync(".audit/result.json", "utf8"));',
      },
      // 同上：整体枚举对非写者步同样生效，一次 Object.entries 就把整份数据搬走。
      {
        step: "probe",
        where: "scripts/probe-pos.mjs",
        excerpt: "for (const [k, v] of Object.entries(r)) console.log(k, JSON.stringify(v));",
      },
    ]);
    // 反例：解析的是别的文件，不算 result.json 的读者。
    writeFileSync(
      join(dir, "scripts/other.mjs"),
      'const p = JSON.parse(readFileSync(".audit/review-a.json", "utf8"));\nconsole.log(Object.keys(p));\n',
    );
    expect(resultJsonReaderViolations([{ id: "other", run: "node scripts/other.mjs" }], { root: dir })).toEqual([]);
    // 反例：只把文本倒进摘要（CI 里就是 cat/printf 进围栏），不解析成数据，不算数据读者。
    // 这条不是放宽：字段名判据仍然覆盖 cat ... | jq '.["executors"]' 这类真取字段的写法。
    expect(resultJsonReaderViolations([{ id: "text", run: "cat .audit/result.json\n" }], { root: dir })).toEqual([]);
  });

  it("放行单位是步不是文件：另一步再引用口径层脚本去读 result.json，照样是读者", () => {
    const dir = mkdtempSync(join(tmpdir(), "audit-step-allow-"));
    mkdirSync(join(dir, "scripts"), { recursive: true });
    writeFileSync(
      join(dir, "scripts/audit-findings.mjs"),
      'const r = JSON.parse(readFileSync(".audit/result.json", "utf8"));\nconsole.log(Object.entries(r).length);\n',
    );
    const writer = { id: "decide", run: "node scripts/audit-findings.mjs --out .audit/result.json\n" };
    const thief = { id: "thief", run: "node scripts/audit-findings.mjs --out /tmp/elsewhere.json\n" };
    // 同一个文件被两步引用：写 result.json 的那一步放行，另一个不是。
    expect(resultJsonWriterSteps([writer, thief])).toEqual(["decide"]);
    // 两处：一次按数据读，一次整份枚举（第二道防线对非写者步同样生效）。
    expect(resultJsonReaderViolations([writer, thief], { root: dir }).map((v) => v.step)).toEqual([
      "thief",
      "thief",
    ]);
  });

  it("env 里的模块取值不靠 ./ 前缀才认：--require / -r / --import= / --loader 的取值都是扫描面", () => {
    const dir = mkdtempSync(join(tmpdir(), "audit-loader-env-"));
    mkdirSync(join(dir, "scripts"), { recursive: true });
    writeFileSync(
      join(dir, "scripts/probe-env.cjs"),
      'const r = JSON.parse(readFileSync(".audit/result.json", "utf8"));\nconsole.log(Object.entries(r).length);\n',
    );
    const forms = [
      "--require scripts/probe-env.cjs",
      "-r scripts/probe-env.cjs",
      "--import=scripts/probe-env.cjs",
      "--loader scripts/probe-env.cjs",
    ];
    for (const value of forms) {
      // 注意这里**没有 ./ 前缀**：只靠「整词以 ./ 开头」的旧规则认不出它。
      const step = { id: "env", env: { NODE_OPTIONS: value }, run: 'node -e "console.log(1)"\n' };
      expect(stepScriptRefs(step, { root: dir }), value).toEqual(["scripts/probe-env.cjs"]);
      expect(referencedScripts([step], { root: dir }).missing, value).toEqual([]);
      // 同一条文本报两处：一次按数据读、一次整份枚举 —— 第二道防线不因为载体不是 run 就缺席。
      expect(resultJsonReaderViolations([step], { root: dir }).map((v) => v.where), value).toEqual([
        "scripts/probe-env.cjs",
        "scripts/probe-env.cjs",
      ]);
    }
    // 反例：env 里没有模块取值的普通字符串不造引用，也不进 unfollowable。
    expect(referencedScripts([{ id: "e", env: { NOTE: "hello" }, run: "echo ok\n" }], { root: dir })).toEqual({
      files: [],
      missing: [],
      unfollowable: [],
    });
  });

describe("wiring: 扫描面放行过宽（豁免单位 / 载体缺位）", () => {
  it("缺陷1：豁免单位是一次读不是一整步 —— 兜底步里再挂第二处读必须红", () => {
    const dir = mkdtempSync(join(tmpdir(), "audit-read-budget-"));
    // 与真 workflow 同形：读**一次** result.json 取结论，再写回同一份 —— 那一次读与写同源。
    const legal = [
      "node -e '",
      'const r = JSON.parse(fs.readFileSync(".audit/result.json", "utf8"));',
      'fs.writeFileSync(".audit/result.json", JSON.stringify({ verdict: r.conclusion ?? "INFRA" }));',
      "'",
      "echo done",
    ].join("\n");
    const fallback = { id: "fallback", run: legal };
    expect(resultJsonWriterSteps([fallback])).toEqual(["fallback"]);
    expect(resultJsonReaderViolations([fallback], { root: dir })).toEqual([]);

    // 审查实测的变异：在同一个兜底步末尾再挂一处读，零字段名地打印 key/value。
    // 旧判据（整步豁免）在这里 87 条全绿 —— 红绿只差「醒不醒豁免」，不是差有没有读到。
    const second = 'const also = JSON.parse(fs.readFileSync(".audit/result.json", "utf8"));';
    const mutated = { id: "fallback", run: [legal, second, "console.log(also.conclusion);"].join("\n") };
    // 它仍然写 result.json：不是靠「不写了」把豁免躲掉的。
    expect(resultJsonWriterSteps([mutated])).toEqual(["fallback"]);
    expect(resultJsonReaderViolations([mutated], { root: dir })).toEqual([
      { step: "fallback", where: "run", excerpt: second },
    ]);
  });

  it("缺陷1：writer 步把整份 result 整体枚举 / 整体 dump 必须红（一个字段名都不写）", () => {
    const dir = mkdtempSync(join(tmpdir(), "audit-enum-ban-"));
    const build = (extra) =>
      [
        "node -e '",
        'const r = JSON.parse(fs.readFileSync(".audit/result.json", "utf8"));',
        'fs.writeFileSync(".audit/result.json", JSON.stringify({ verdict: r.conclusion ?? "INFRA" }));',
        extra,
        "'",
      ].join("\n");
    for (const extra of [
      "for (const [k, v] of Object.entries(r)) console.log(k, v);",
      "console.log(Object.keys(r).length, Object.values(r).length);",
      "console.log(JSON.stringify(r));",
    ]) {
      const step = { id: "fallback", run: build(extra) };
      // 一个字段名都没有：字段名判据在这条上完全是绿的，红的是「整份搬走」本身。
      expect(step.run).not.toMatch(/executors|comparison|counts/);
      expect(resultJsonReaderViolations([step], { root: dir }), extra).toEqual([
        { step: "fallback", where: "run", excerpt: extra },
      ]);
    }
    // 排除写法本身：整体枚举的对象不是从 result.json 解出来的，不算这条。
    const other = { id: "fallback", run: build('console.log(JSON.stringify({ verdict: "INFRA" }));') };
    expect(resultJsonReaderViolations([other], { root: dir })).toEqual([]);
  });

  it("缺陷2：job 级 env 是同一个执行面 —— --require 进来的模块读 result.json 必须红", () => {
    const dir = mkdtempSync(join(tmpdir(), "audit-job-env-"));
    mkdirSync(join(dir, "scripts"), { recursive: true });
    const reader = 'const r = JSON.parse(readFileSync(".audit/result.json", "utf8"));\nconsole.log(r.verdict, r.executors.length);\n';
    writeFileSync(join(dir, "scripts/probe-jobenv.cjs"), reader);
    const job = {
      env: { GH_TOKEN: "${{ secrets.GITHUB_TOKEN }}", NODE_OPTIONS: "--require ./scripts/probe-jobenv.cjs" },
      steps: [{ id: "ok", run: "echo ok\n" }],
    };
    const carriers = jobPayloads(job, { jobs: { "audit-runner": job } });
    expect(carriers.map((payload) => payload.carrier)).toEqual(["job.env.GH_TOKEN", "job.env.NODE_OPTIONS"]);
    // 跟得下去、不缺失、不当成跟不下去的形态 —— 它是载体，不是盲区。
    expect(referencedScripts(job.steps, { root: dir, jobPayloads: carriers })).toEqual({
      files: ["scripts/probe-jobenv.cjs"],
      missing: [],
      unfollowable: [],
    });
    // 两道判据都要在 job 载体上生效：字段名判据 + 行为判据。
    expect(fieldReadViolations([], { root: dir, jobPayloads: carriers }).map((v) => v.file)).toEqual([
      "scripts/probe-jobenv.cjs",
    ]);
    expect(resultJsonReaderViolations([], { root: dir, jobPayloads: carriers })).toEqual([
      {
        step: "job.env.NODE_OPTIONS",
        where: "scripts/probe-jobenv.cjs",
        excerpt: 'const r = JSON.parse(readFileSync(".audit/result.json", "utf8"));',
      },
    ]);
    // 反例：job env 里只有凭据，不造引用也不出违规。
    const plain = jobPayloads({ env: { GH_TOKEN: "x" }, steps: [] }, {});
    expect(plain.map((payload) => payload.carrier)).toEqual(["job.env.GH_TOKEN"]);
    expect(referencedScripts([], { root: dir, jobPayloads: plain })).toEqual({
      files: [],
      missing: [],
      unfollowable: [],
    });
    expect(resultJsonReaderViolations([], { root: dir, jobPayloads: plain })).toEqual([]);
    expect(jobPayloads({ steps: [] }, { jobs: {} })).toEqual([]);
  });

  it("缺陷2b：step 的 shell: 字段本身携带命令，里面的 node 脚本必须进扫描面", () => {
    const dir = mkdtempSync(join(tmpdir(), "audit-step-shell-"));
    mkdirSync(join(dir, "scripts"), { recursive: true });
    const body = 'const r = JSON.parse(readFileSync(".audit/result.json", "utf8"));\nconsole.log(r.verdict, r.executors.length);\n';
    writeFileSync(join(dir, "scripts/probe-read.mjs"), body);
    const step = { id: "read", shell: "bash -c 'node scripts/probe-read.mjs' {0}", run: "echo done\n" };
    // shell 是**执行面**不是说明文字：载体必须收它，且排在 run 之后。
    expect(stepPayloads(step).map((payload) => payload.carrier)).toEqual(["run", "shell"]);
    expect(stepScriptRefs(step, { root: dir })).toEqual(["scripts/probe-read.mjs"]);
    expect(referencedScripts([step], { root: dir })).toEqual({
      files: ["scripts/probe-read.mjs"],
      missing: [],
      unfollowable: [],
    });
    expect(fieldReadViolations([step], { root: dir }).map((v) => v.file)).toEqual(["scripts/probe-read.mjs"]);
    expect(resultJsonReaderViolations([step], { root: dir })).toEqual([
      {
        step: "read",
        where: "scripts/probe-read.mjs",
        excerpt: 'const r = JSON.parse(readFileSync(".audit/result.json", "utf8"));',
      },
    ]);
    // 引用解析不到也留在 missing 里：静默丢弃正是这一批绕过的共同根因。
    const gone = { id: "gone", shell: "bash -c 'node scripts/gone.mjs' {0}", run: "echo ok\n" };
    expect(referencedScripts([gone], { root: dir }).missing).toEqual(["scripts/gone.mjs"]);
    // 反例：shell 里跑的不是 node、也没有 ./ 形态的脚本，不造引用。
    expect(referencedScripts([{ id: "plain", shell: "bash -e {0}", run: "echo ok\n" }], { root: dir })).toEqual({
      files: [],
      missing: [],
      unfollowable: [],
    });
    // 真 workflow 的 step 都不带 shell：这一格只能是新增，不能把既有面染红。
    const doc = YAML.parse(readFileSync(join(ROOT, WORKFLOW), "utf8"));
    const realSteps = doc.jobs["audit-runner"].steps;
    expect(realSteps.filter((s) => typeof s.shell === "string")).toEqual([]);
  });

  it("缺陷2c：job 的 defaults.run.shell 与 workflow 级 env 同样进扫描面", () => {
    const dir = mkdtempSync(join(tmpdir(), "audit-job-defaults-"));
    mkdirSync(join(dir, "scripts"), { recursive: true });
    const body = 'const r = JSON.parse(readFileSync(".audit/result.json", "utf8"));\nconsole.log(r.verdict, r.executors.length);\n';
    writeFileSync(join(dir, "scripts/probe-read.mjs"), body);
    writeFileSync(join(dir, "scripts/probe-jobenv.cjs"), body);
    const job = {
      defaults: { run: { shell: "bash -c 'node scripts/probe-read.mjs' {0}" } },
      steps: [{ id: "ok", run: "echo ok\n" }],
    };
    const carriers = jobPayloads(job, {});
    expect(carriers.map((payload) => payload.carrier)).toEqual(["defaults.run.shell"]);
    expect(referencedScripts(job.steps, { root: dir, jobPayloads: carriers }).files).toEqual([
      "scripts/probe-read.mjs",
    ]);
    expect(resultJsonReaderViolations(job.steps, { root: dir, jobPayloads: carriers })).toEqual([
      {
        step: "defaults.run.shell",
        where: "scripts/probe-read.mjs",
        excerpt: 'const r = JSON.parse(readFileSync(".audit/result.json", "utf8"));',
      },
    ]);
    // workflow 顶层 env 与 job env 同族：位置更高不等于执行面更远。
    const docEnv = jobPayloads({}, { env: { NODE_OPTIONS: "--require ./scripts/probe-jobenv.cjs" } });
    expect(docEnv.map((payload) => payload.carrier)).toEqual(["env.NODE_OPTIONS"]);
    expect(resultJsonReaderViolations([], { root: dir, jobPayloads: docEnv }).map((v) => v.step)).toEqual([
      "env.NODE_OPTIONS",
    ]);
    // 真 workflow 的 job 级载体只有一行凭据，且不派生任何脚本引用。
    const realDoc = YAML.parse(readFileSync(join(ROOT, WORKFLOW), "utf8"));
    const realCarriers = jobPayloads(realDoc.jobs["audit-runner"], realDoc);
    expect(realCarriers.map((payload) => payload.carrier)).toEqual(["job.env.GH_TOKEN"]);
    expect(referencedScripts(realDoc.jobs["audit-runner"].steps, { jobPayloads: realCarriers }).unfollowable).toEqual(
      [],
    );
    expect(resultJsonReaderViolations(realDoc.jobs["audit-runner"].steps, { jobPayloads: realCarriers })).toEqual([]);
  });

  function mutatedWorkflow(mutate) {
    const doc = YAML.parse(readFileSync(join(ROOT, WORKFLOW), "utf8"));
    mutate(doc);
    return YAML.parse(YAML.stringify(doc));
  }

  it("缺陷1d：写行里追加一次真读 —— 整行不再被写形态吞掉", () => {
    const dir = mkdtempSync(join(tmpdir(), "audit-write-line-read-"));
    const write = "node scripts/audit-findings.mjs --a .audit/review-a.json --b .audit/review-b.json --out .audit/result.json";
    const legal = [
      "set +e",
      write,
      "set -e",
      "node -e '",
      'const r = JSON.parse(fs.readFileSync(".audit/result.json", "utf8"));',
      "const lines = [];",
      "for (const e of r.executors) lines.push(e.slot + ': ' + e.declared);",
      "'",
      "exit 0",
    ].join("\n");
    const step = { id: "decide", run: legal };
    expect(resultJsonWriterSteps([step])).toEqual(["decide"]);
    // 合法：写一次、读一次（纯读行），两次都不在同一行上 —— 绿。
    expect(resultJsonReaderViolations([step], { root: dir })).toEqual([]);

    // 审查实测的变异：写那一行的行尾再挂一次真读 + 整体打印。旧判据看「行内有写样」就整行跳过。
    const appended =
      write + " ; node -e 'console.log(JSON.parse(require(\"node:fs\").readFileSync(\".audit/result.json\",\"utf8\")))'";
    const mutated = { id: "decide", run: legal.split(write).join(appended) };
    const violations = resultJsonReaderViolations([mutated], { root: dir });
    expect(violations.map((v) => v.step)).toEqual(["decide"]);
    expect(violations[0].excerpt).toContain('readFileSync(".audit/result.json","utf8")');
    // 合法的纯读行仍然豁免：写者步的「一次读」额度还在，只是不许被写行搭车。
    expect(violations.some((v) => v.excerpt.includes("const r = JSON.parse"))).toBe(false);
  });

  it("缺陷1e：写形态不许由注释提供 —— 尾注释洗白读行必须红", () => {
    const dir = mkdtempSync(join(tmpdir(), "audit-comment-write-"));
    const commented = {
      id: "reader",
      run: [
        "node -e '",
        'const r = JSON.parse(fs.readFileSync(".audit/result.json", "utf8")); # 上游写者：--out .audit/result.json',
        "'",
      ].join("\n"),
    };
    // 注释里那句 --out 不是写：这一步不写 result.json，就不配拿「一次读」的额度。
    expect(resultJsonWriterSteps([commented])).toEqual([]);
    expect(resultJsonReaderViolations([commented], { root: dir })).toEqual([
      {
        step: "reader",
        where: "run",
        excerpt: 'const r = JSON.parse(fs.readFileSync(".audit/result.json", "utf8"));',
      },
    ]);
    // 真 workflow 的写者步判定不受影响：--out 与 writeFileSync 都是认真实代码行。
    const doc = YAML.parse(readFileSync(join(ROOT, WORKFLOW), "utf8"));
    expect(resultJsonWriterSteps(doc.jobs["audit-runner"].steps)).toEqual(["decide", "fallback"]);
  });

  it("缺陷1f：兜底步读两次 + 写一次 + 整体打印 —— 只有一次读算合法", () => {
    const dir = mkdtempSync(join(tmpdir(), "audit-fallback-reads-"));
    const base = [
      "node -e '",
      'const fs = require("node:fs");',
      'const read = (p) => JSON.parse(fs.readFileSync(p, "utf8"));',
      'const r = read(".audit/result.json");',
      'const c = read(".audit/check-run.json");',
      'if (!r.verdict) fs.writeFileSync(".audit/result.json", JSON.stringify({ verdict: "INFRA" }));',
      "console.log(r);",
      "'",
    ];
    const step = { id: "fallback", run: base.join("\n") };
    expect(resultJsonWriterSteps([step])).toEqual(["fallback"]);
    // 一次真读（纯读行）拿额度；console.log(整个对象) 是第二道防线接住的整体枚举。
    const violations = resultJsonReaderViolations([step], { root: dir });
    expect(violations.map((v) => v.excerpt)).toEqual(["console.log(r);"]);

    // 变异：把第二次读塞进写那一行 —— 写行不再让这行免检，读照样计数、照样上报。
    const mutated = base
      .join("\n")
      .split('if (!r.verdict) fs.writeFileSync(".audit/result.json", JSON.stringify({ verdict: "INFRA" }));')
      .join(
        'if (!r.verdict) fs.writeFileSync(".audit/result.json", JSON.stringify({ verdict: "INFRA", peek: String(fs.readFileSync(".audit/result.json", "utf8")) }));',
      );
    const after = resultJsonReaderViolations([{ id: "fallback", run: mutated }], { root: dir });
    expect(after.map((v) => v.excerpt.includes("peek"))).toEqual([true, false]);
    expect(after.map((v) => v.excerpt)).toContain("console.log(r);");
  });

  it("缺陷2e：container.env 与 container.options 同样是 job 级执行面", () => {
    const dir = mkdtempSync(join(tmpdir(), "audit-container-env-"));
    mkdirSync(join(dir, "scripts"), { recursive: true });
    writeFileSync(
      join(dir, "scripts/probe-read.mjs"),
      'const r = JSON.parse(readFileSync(".audit/result.json", "utf8"));\nconsole.log(r.verdict);\n',
    );
    const job = {
      container: {
        image: "node:20",
        env: { NODE_OPTIONS: "--require ./scripts/probe-read.mjs" },
        options: "--require ./scripts/probe-read.mjs",
      },
      steps: [{ id: "ok", run: "echo ok\n" }],
    };
    const carriers = jobPayloads(job, {});
    expect(carriers.map((payload) => payload.carrier)).toEqual([
      "job.container.env.NODE_OPTIONS",
      "job.container.options",
    ]);
    // container 的注入面对 job 内全部 step 生效，与 job.env 同机制：引用解析得到、读者报得出。
    expect(referencedScripts(job.steps, { root: dir, jobPayloads: carriers }).files).toEqual([
      "scripts/probe-read.mjs",
    ]);
    const steps = resultJsonReaderViolations(job.steps, { root: dir, jobPayloads: carriers }).map((v) => v.step);
    expect(steps).toEqual(["job.container.env.NODE_OPTIONS", "job.container.options"]);

    // 变异落在真 workflow 上：给 audit-runner 加一层 container.env 读者，同一根探针必须红。
    const mutated = mutatedWorkflow((doc) => {
      doc.jobs["audit-runner"].container = {
        image: "node:20",
        env: { NODE_OPTIONS: "--require ./scripts/probe-read.mjs" },
      };
    });
    const mutatedJob = mutated.jobs["audit-runner"];
    const mutatedCarriers = jobPayloads(mutatedJob, mutated);
    expect(mutatedCarriers.map((payload) => payload.carrier)).toContain("job.container.env.NODE_OPTIONS");
    expect(
      resultJsonReaderViolations(mutatedJob.steps, { root: dir, jobPayloads: mutatedCarriers }).map((v) => v.step),
    ).toContain("job.container.env.NODE_OPTIONS");
  });

  it("缺陷3b：--require=./x.cjs 等号形态与空格形态同等对待", () => {
    const dir = mkdtempSync(join(tmpdir(), "audit-loader-equals-"));
    mkdirSync(join(dir, "scripts"), { recursive: true });
    writeFileSync(join(dir, "scripts/probe-env.cjs"), 'const r = JSON.parse(readFileSync(".audit/result.json", "utf8"));\n');
    const run = "node -e 'console.log(1)'\n";
    for (const flags of [
      "--require=./scripts/probe-env.cjs",
      "--require ./scripts/probe-env.cjs",
      "-r=./scripts/probe-env.cjs",
      "--import=./scripts/probe-env.cjs",
    ]) {
      const step = { id: "eq", env: { NODE_OPTIONS: flags }, run };
      expect(referencedScripts([step], { root: dir }).files, flags).toEqual(["scripts/probe-env.cjs"]);
      expect(resultJsonReaderViolations([step], { root: dir }).map((v) => v.where), flags).toEqual([
        "scripts/probe-env.cjs",
      ]);
    }
    // 取不到具体值时不许静默：落 unfollowable，写进报告而不是假装覆盖。
    const dyn = referencedScripts([{ id: "dyn", env: { NODE_OPTIONS: "--require=$PRELOAD" }, run }], { root: dir });
    expect(dyn.files).toEqual([]);
    expect(dyn.unfollowable.map((item) => item.kind)).toEqual(["loader-dynamic"]);
    const bare = referencedScripts([{ id: "bare", env: { NODE_OPTIONS: "--require" }, run }], { root: dir });
    expect(bare.unfollowable.map((item) => item.kind)).toEqual(["loader-no-value"]);
  });

  it("反例：真 workflow 的两处合法读各算一次，不因为修边界被染红", () => {
    const doc = YAML.parse(readFileSync(join(ROOT, WORKFLOW), "utf8"));
    const steps = doc.jobs["audit-runner"].steps;
    const pick = (id) => steps.find((step) => step.id === id);
    for (const id of ["decide", "fallback"]) {
      const reads = resultJsonReads(pick(id).run);
      expect(reads.length, id).toBe(1);
      expect(reads[0].onWriteLine, id).toBe(false);
    }
    expect(resultJsonWriterSteps(steps)).toEqual(["decide", "fallback"]);
    expect(resultJsonReaderViolations(steps, { root: ROOT })).toEqual([]);
  });

  it("默认拒绝：把读换成等价拼写（计算属性 / .call / 别名 / 不落变量）照样红", () => {
    const dir = mkdtempSync(join(tmpdir(), "audit-deny-spelling-"));
    // 判据的默认方向决定它拦不拦得住人：只要「引用 result.json」就是违规，
    // 换拼写只是换一种碰法，不再需要判据先认出「这是一次读调用」。
    const cases = [
      [
        "计算属性",
        'const r = JSON.parse(fs["readFileSync"](".audit/result.json", "utf8"));\nconsole.log(r.verdict);\n',
      ],
      [
        ".call 包裹",
        'const r = JSON.parse(fs.readFileSync.call(null, ".audit/result.json", "utf8"));\nconsole.log(r.verdict);\n',
      ],
      [
        "别名",
        'const rf = fs.readFileSync;\nconst r = JSON.parse(rf(".audit/result.json", "utf8"));\nconsole.log(r.verdict);\n',
      ],
      ["不落变量", 'console.log(Object.keys(JSON.parse(fs.readFileSync(".audit/result.json", "utf8"))));\n'],
      [
        "node -e 里按字段取",
        'node -e \'console.log(JSON.parse(require("node:fs")["readFileSync"](".audit/result.json","utf8")).executors.length)\'\n',
      ],
    ];
    for (const [label, run] of cases) {
      const violations = resultJsonReaderViolations([{ id: "probe", run }], { root: dir });
      expect(violations.length, label).toBeGreaterThan(0);
      expect(
        violations.every((violation) => violation.step === "probe" && violation.excerpt.length > 0),
        label,
      ).toBe(true);
    }
  });

  it("默认拒绝也作用在被引用的脚本文件上：step 只写 node x.cjs 不是免费通道", () => {
    const dir = mkdtempSync(join(tmpdir(), "audit-script-deny-"));
    mkdirSync(join(dir, "scripts"), { recursive: true });
    // 审查实测的通道：读者写进一个 .cjs，读出来只做分支判断（既不 dump 也不 parse），
    // step 里只有 node scripts/xxx.cjs 一行 —— 字段名判据与「认读调用」的判据都看不见它。
    writeFileSync(
      join(dir, "scripts/probe-branch.cjs"),
      'const fs = require("node:fs");\nconst raw = fs["readFileSync"](".audit/result.json", "utf8");\nmodule.exports = { hot: raw.includes("verdict") };\n',
    );
    const step = { id: "probe", run: "node scripts/probe-branch.cjs\n" };
    expect(fieldReadViolations([step], { root: dir })).toEqual([]);
    expect(resultJsonReaderViolations([step], { root: dir })).toEqual([
      {
        step: "probe",
        where: "scripts/probe-branch.cjs",
        excerpt: 'const raw = fs["readFileSync"](".audit/result.json", "utf8");',
      },
    ]);
  });

  it("写意图只认代码区：字符串里写着 --out 造不出伪写者步", () => {
    const dir = mkdtempSync(join(tmpdir(), "audit-fake-writer-"));
    // 旧判据按文本匹配 --out，于是把 --out 写进字符串就能换到写者步的「一次读」额度。
    const fake = { id: "fake", run: 'echo "--out .audit/result.json" >/dev/null\n' };
    expect(resultJsonWriterSteps([fake])).toEqual([]);
    expect(resultJsonReaderViolations([fake], { root: dir })).toEqual([]);
    // 正向对照：同一个 --out 落在代码区就是真写者。少了这条，上面那条会退化成「谁都不是写者」。
    const real = { id: "real", run: "node scripts/audit-findings.mjs --out .audit/result.json\n" };
    expect(resultJsonWriterSteps([real])).toEqual(["real"]);
  });

  it("白名单只有「原样倒出」：cat / 赋值后原样输出放行，一旦带加工就是取数据", () => {
    const dir = mkdtempSync(join(tmpdir(), "audit-dump-allow-"));
    // 真实 workflow 的「INFRA 留痕」步就是这个形态：cat 进变量，围栏先比一次，再原样 printf。
    const allowed = [
      "cat .audit/result.json\n",
      'body=$(cat .audit/result.json 2>/dev/null || true)\nprintf \'%s\\n\' "$body"\n',
      'body=$(cat .audit/result.json)\nwhile [[ "$body" == *"$fence"* ]]; do fence="$fence"; done\necho "$body"\n',
    ];
    for (const run of allowed) {
      expect(resultJsonReaderViolations([{ id: "dump", run }], { root: dir }), run).toEqual([]);
    }
    // 白名单以外的每一条都是新的绕过面：这里逐条钉住「带加工就不是倒出」。
    const forbidden = [
      ["jq 取字段", "cat .audit/result.json | jq .executors\n"],
      ["别名洗数据", 'body=$(cat .audit/result.json)\necho "$body" | jq -c .\n'],
      ["sed 切片", "sed -n '1,20p' .audit/result.json\n"],
      ["目录通配", "cat .audit/*.json\n"],
      ["tee 转走", "cat .audit/result.json | tee /tmp/leak.json\n"],
      ["dd 抽内容", "dd if=.audit/result.json bs=1 count=200 2>/dev/null\n"],
      ["while read 打", 'while read -r line; do echo "$line"; done < .audit/result.json\n'],
      [
        "解释器取用",
        'node -e \'console.log(JSON.parse(require("node:fs").readFileSync(".audit/result.json","utf8")))\'\n',
      ],
    ];
    for (const [label, run] of forbidden) {
      const violations = resultJsonReaderViolations([{ id: "leak", run }], { root: dir });
      expect(violations.length, label).toBeGreaterThan(0);
      expect(
        violations.every((violation) => violation.step === "leak"),
        label,
      ).toBe(true);
    }
  });

  it("写侧同样默认拒绝：计算属性写也算写者，改写结论因此藏不进「不是写者」", () => {
    const dir = mkdtempSync(join(tmpdir(), "audit-write-deny-"));
    // 旧写形态只认 writeFileSync( 这串字：换一种写法的改写者既不是写者、也不触发写形态，
    // 它在判据里根本不存在。现在按「引用 + 写意图」认，计算属性与 .call 同族。
    const rewrite = {
      id: "rewrite",
      run: 'node -e \'require("node:fs")["writeFileSync"](".audit/result.json", JSON.stringify({ verdict: "PASS" }));\'\n',
    };
    expect(resultJsonWriterSteps([rewrite])).toEqual(["rewrite"]);
    const called = {
      id: "called",
      run: 'node -e \'const fs = require("node:fs"); fs.writeFileSync.call(fs, ".audit/result.json", "{}");\'\n',
    };
    expect(resultJsonWriterSteps([called])).toEqual(["called"]);
    // 写者步仍然只有「一次纯读」的额度：写一次之后再挂第二处等价拼写的读，照样红。
    const peek = {
      id: "peek",
      run: [
        "node -e '",
        'const fs = require("node:fs");',
        'fs["appendFileSync"](".audit/result.json", " ");',
        'const a = JSON.parse(fs["readFileSync"](".audit/result.json", "utf8"));',
        'const b = JSON.parse(fs.readFileSync.call(fs, ".audit/result.json", "utf8"));',
        "console.log(b.conclusion);",
        "'",
      ].join("\n"),
    };
    expect(resultJsonWriterSteps([peek])).toEqual(["peek"]);
    expect(resultJsonReaderViolations([peek], { root: dir })).toEqual([
      {
        step: "peek",
        where: "run",
        excerpt: 'const b = JSON.parse(fs.readFileSync.call(fs, ".audit/result.json", "utf8"));',
      },
    ]);
    // 真 workflow 上加一个「计算属性写者」：写者集合的等值断言因此必须变（这里断言它真的变了）。
    const mutated = mutatedWorkflow((doc) => {
      doc.jobs["audit-runner"].steps.push({
        name: "改写结论",
        run: 'node -e \'require("node:fs")["writeFileSync"](".audit/result.json", "{}")\'\n',
      });
    });
    expect(resultJsonWriterSteps(mutated.jobs["audit-runner"].steps)).toEqual(["decide", "fallback", "改写结论"]);
  });
});

});
