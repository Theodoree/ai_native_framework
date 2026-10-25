import { describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
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
    // 名单是**精确相等**，不是下限：这是真正的结论载体，多一个写者就多一条产出结论的通道
    // （旧断言只写下限，于是加一个无 name 的步把 check-run.json 改写成 conclusion=success
    // 仍然 103 条全绿 —— 下限断言对「多出来的那个写者」完全无感）。
    const writers = steps
      .filter((s) => String(s.run ?? "").includes("check-run.json") && String(s.run).includes('name: "audit"'))
      .map((s) => s.name);
    expect(writers).toEqual(["口径层判定", "结论兜底", "判不了：回写 INFRA"]);
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
    // 6 处端点用法 = 2 处 --method POST 回写 + 1 处自证步的只读回读；写面只有那两步。
    const checkRun = calls.filter(
      (s) => s.run.includes("repos/$GITHUB_REPOSITORY/check-runs") && s.run.includes("--method POST"),
    );
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
    // 假 gh 是**行为仿真**，不是「已经过滤好的答案」：
    //   * --slurp 与 --jq 同现时真 gh 直接拒绝（请求都不发），假 gh 必须照样拒绝；
    //   * 未登记的 (method, path) 一律 404 + 非 0 —— 端点拼错必须响，不能被 exit 0 吞掉；
    //   * 列表端点回**原始页形状** {total_count, check_runs}，--paginate --slurp 回页数组；
    //     按 name 过滤是步骤自己的事，假 gh 不代劳（否则「过滤条件写错」不可观测）；
    //   * filter 语义照 GitHub：缺省 / filter=latest 是按 name 去重后的视图，只有 filter=all 才全给；
    //   * GET check-runs/<id> 回单条对象（含 app.slug）；PATCH 不登记 —— 那条路本来就该 404。
    // 用 node 实现：沙箱里没有 jq，而 --jq 的表达式必须真的被求值，否则「jq 写错」也不可观测。
    const ghScript = `#!/usr/bin/env node
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const NEWLINE = String.fromCharCode(10);
const TICK = String.fromCharCode(96);
const DIR = ${JSON.stringify(dir)};
const LEDGER = path.join(DIR, "calls.log");
const PAYLOAD = path.join(DIR, "payload.json");
const STATE = path.join(DIR, "runs-state.json");

const argv = process.argv.slice(2);
// 账本**无条件创建**：这样「账本不存在」就只有一个来历 —— 假 gh 压根没跑起来
// （PATH / shebang / 权限 / 记账被改坏），而不是「零次调用」的正常形态。
fs.closeSync(fs.openSync(LEDGER, "a"));
// harness 自检探针：跑得起来就说明账本路径与 PATH 是通的，但它自己不进账本。
if (argv[0] === "--audit-harness-canary") process.exit(0);
fs.appendFileSync(LEDGER, argv.join(" ") + NEWLINE);

const WITH_VALUE = ["--jq", "--method", "-X", "--input", "-f", "-F", "--field", "--raw-field", "--template", "--json"];
const valueOf = (flag) => {
  const at = argv.indexOf(flag);
  return at >= 0 ? argv[at + 1] : undefined;
};
const has = (flag) => argv.includes(flag);
const positional = argv.filter((arg, i) => !arg.startsWith("-") && !WITH_VALUE.includes(argv[i - 1]));
const jq = valueOf("--jq");
const method = String(valueOf("--method") || valueOf("-X") || "GET").toUpperCase();
const stderr = (text) => process.stderr.write(text + NEWLINE);
const stdout = (text) => process.stdout.write(text + NEWLINE);

// 真 gh：--slurp 与 --jq/--template 互斥，请求根本不发。
if (has("--slurp") && jq !== undefined) {
  stderr("the " + TICK + "--slurp" + TICK + " option is not supported with " + TICK + "--jq" + TICK + " or " + TICK + "--template" + TICK);
  process.exit(1);
}

// --jq 只实现最小真集：字符串字面量、.path、(.path // 默认值)，用 + 连接。
// 超出这个集合就报错退出 —— 静默回一个「看着对」的值正是这批漏洞的根因。
const lookup = (object, expr) => {
  let current = object;
  for (const key of String(expr).trim().split(".").filter(Boolean)) {
    if (current === null || current === undefined) return undefined;
    current = current[key];
  }
  return current;
};
const splitTerms = (text) => {
  const terms = [];
  let depth = 0;
  let quote = null;
  let current = "";
  for (const ch of text) {
    if (quote) {
      current += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === "(") depth += 1;
    if (ch === ")") depth -= 1;
    if (ch === "+" && depth === 0) {
      terms.push(current.trim());
      current = "";
      continue;
    }
    current += ch;
  }
  terms.push(current.trim());
  return terms;
};
const jqValue = (object, expr) => {
  const parts = splitTerms(String(expr).trim()).map((term) => {
    if (term.startsWith("(") && term.endsWith(")")) return jqValue(object, term.slice(1, -1));
    if (term.charAt(0) === '"' || term.charAt(0) === "'") return term.slice(1, -1);
    const alternatives = term.split("//");
    const got = lookup(object, alternatives[0]);
    if (alternatives.length > 1) {
      const fallback = alternatives.slice(1).join("//").trim();
      if (got !== undefined && got !== null) return got;
      return fallback.charAt(0) === '"' || fallback.charAt(0) === "'" ? fallback.slice(1, -1) : lookup(object, fallback);
    }
    if (got === undefined || got === null) throw new Error("jq: 取不到字段 " + term);
    return got;
  });
  return parts.join("");
};
const emit = (object) => stdout(jq === undefined ? JSON.stringify(object) : String(jqValue(object, jq)));

const page = () => {
  if (Object.prototype.hasOwnProperty.call(process.env, "FAKE_GH_CHECK_RUNS_JSON")) {
    const parsed = JSON.parse(process.env.FAKE_GH_CHECK_RUNS_JSON);
    if (!parsed || !Array.isArray(parsed.check_runs)) throw new Error("夹具必须是原始页形状 {total_count, check_runs}");
    return parsed;
  }
  if (fs.existsSync(STATE)) return JSON.parse(fs.readFileSync(STATE, "utf8"));
  return { total_count: 0, check_runs: [] };
};
// GitHub 的默认视图是按 name 去重后的最新一条；只有 filter=all 才把同名的都给出来。
const dedupeLatest = (runs) => {
  const latest = new Map();
  for (const run of runs) if (run && run.name) latest.set(run.name, run);
  return runs.filter((run) => run && latest.get(run.name) === run);
};
const notFound = () => {
  stdout(JSON.stringify({ message: "Not Found" }));
  process.exit(1);
};

try {
  if (positional[0] === "pr" && positional[1] === "view") {
    if (has("--json") && String(valueOf("--json")).includes("headRefOid")) {
      stdout("cafebabe");
      process.exit(0);
    }
    stdout(["scripts/merge-gate.mjs", "scripts/audit-findings.mjs"].join(NEWLINE));
    process.exit(0);
  }
  if (positional[0] !== "api") notFound();
  const parts = String(positional[1] || "").split("?");
  const rawPath = parts[0];
  const query = new URLSearchParams(parts[1] || "");
  const POST_RUNS = new RegExp("^repos/[^/]+/[^/]+/check-runs$");
  const LIST_RUNS = new RegExp("^repos/[^/]+/[^/]+/commits/[^/]+/check-runs$");
  const ONE_RUN = new RegExp("^repos/[^/]+/[^/]+/check-runs/([0-9]+)$");

  if (method === "POST" && POST_RUNS.test(rawPath)) {
    if (process.env.FAKE_GH_POST_FAILS) {
      stderr("gh: 422");
      process.exit(1);
    }
    const input = valueOf("--input");
    if (!input) notFound();
    fs.copyFileSync(input, PAYLOAD);
    const payload = JSON.parse(fs.readFileSync(input, "utf8"));
    // id 可覆写：夹具默认 4242 是等长 4 位，同页面里再放一条 4 位 id 时
    // 数值序与字典序碰巧一致 —— 排序写法的两种错法（sort()、取末位）都红不了。
    const rawPostId = Object.prototype.hasOwnProperty.call(process.env, "FAKE_GH_POST_ID")
      ? String(process.env.FAKE_GH_POST_ID)
      : "4242";
    const postId = /^[0-9]+$/.test(rawPostId) ? Number(rawPostId) : rawPostId;
    // 服务端状态由 payload 长出来：app 恒为 github-actions（POST 用的是 GITHUB_TOKEN）。
    const run = {
      id: postId,
      name: payload.name,
      status: payload.status,
      conclusion: payload.conclusion,
      head_sha: payload.head_sha,
      app: { slug: "github-actions" },
    };
    fs.writeFileSync(STATE, JSON.stringify({ total_count: 1, check_runs: [run] }));
    emit({ id: postId });
    process.exit(0);
  }
  if (method === "GET" && LIST_RUNS.test(rawPath)) {
    const runs = page().check_runs || [];
    const filter = query.get("filter") || "latest";
    const kept = filter === "all" ? runs : dedupeLatest(runs);
    // 页数由夹具声明（FAKE_GH_PAGES，默认单页）：只回一页的假 gh 会让
    // 「--paginate --slurp 是页数组 + flatMap 收多页」这套逻辑永远不被两页样本验证 ——
    // 把 flatMap 换成 pages[0].check_runs 照样全绿。真 gh 只有 --paginate 才翻页，
    // --slurp 把翻到的各页套成数组，两者缺一都回单页。
    const declared = Number(process.env.FAKE_GH_PAGES || "1");
    const pageCount = Number.isFinite(declared) && declared > 1 ? Math.floor(declared) : 1;
    const size = Math.ceil(kept.length / pageCount) || 0;
    const pages = [];
    for (let index = 0; index < pageCount; index += 1) {
      pages.push({ total_count: kept.length, check_runs: kept.slice(index * size, (index + 1) * size) });
    }
    const shown = has("--paginate") ? pages : pages.slice(0, 1);
    stdout(has("--slurp") ? JSON.stringify(shown) : shown.map((body) => JSON.stringify(body)).join(NEWLINE));
    process.exit(0);
  }
  const one = ONE_RUN.exec(rawPath);
  if (method === "GET" && one) {
    // 单条回读的独立夹具：列表页与单条回读**不同源**是真实存在的形态
    // （中间层/缓存回旧表示、或者回一个被截断的空 body），内容比对必须自己看得见这件事 ——
    // 两边都取自同一份夹具时，「回读的 name/status 与列表页不一致」根本不可构造。
    if (Object.prototype.hasOwnProperty.call(process.env, "FAKE_GH_ONE_RUN_BODY")) {
      const body = String(process.env.FAKE_GH_ONE_RUN_BODY);
      // 空 body：连 JSON 都解不出来，--jq 也就无从求值（真 gh 同样只回空，exit 0）。
      if (body === "") {
        process.stdout.write(NEWLINE);
        process.exit(0);
      }
      // 非空 body 照样过 --jq：否则「回读的 name/status 与期望不符」根本到不了字段比对。
      emit(JSON.parse(body));
      process.exit(0);
    }
    const wanted = String(one[1]);
    const run = (page().check_runs || []).find((candidate) => String(candidate.id) === wanted);
    if (!run) notFound();
    emit(run);
    process.exit(0);
  }
  notFound();
} catch (error) {
  stderr("gh: " + String((error && error.message) || error));
  process.exit(1);
}
`;
    writeFileSync(join(bin, "gh"), ghScript);
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
  // Actions 里 step 的 name 是**可选**的：无 name 的步照常执行。旧 runner 在循环里
  // `if (!step.run || !step.name) continue;`，于是它对无 name 步整层全盲
  // （实测：一个无 name 的步把 check-run.json 改写成 conclusion=success，照样 103 条全绿）。
  // 行为层一律 fail-closed，并且说清楚是第几个 step —— 「跳过」会把一次管线故障读成绿。
  function requireStepName(stepList) {
    for (const [index, step] of stepList.entries()) {
      if (!step.run) continue;
      if (!step.name) {
        throw new Error(
          "audit.yml 第 " +
            (index + 1) +
            " 个 step 没有 name，行为 runner 拒绝静默跳过：" +
            String(step.run).slice(0, 60),
        );
      }
    }
    return stepList;
  }

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
    requireStepName(steps);
    for (const step of steps) {
      if (!step.run) continue;
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
    // 一次 POST 回写 + 自证的两段只读回读（计数回读 + 内容回读，都不产生结论）。
    expect(out.calls.filter((c) => c.includes("check-runs"))).toHaveLength(3);
    expect(out.calls.filter((c) => c.includes("--method POST"))).toHaveLength(1);
    expect(out.payload).toMatchObject({ name: "audit", status: "completed", conclusion: "success" });
    expect(out.payload.head_sha).toBe("cafebabe");
    expect(out.calls.filter((c) => c.includes("headRefOid"))).toHaveLength(1);
    expect(out.outputs.decide.exit).toBe("0");
    expect(out.ran.at(-1).status).toBe(0);
    expect(out.summary).toBe("");
  });

  it("自证：回读恰好一条且 id 等于 POST 回来的 id —— 自证步退出 0", () => {
    const out = runWorkflow({ AUDIT_FINDINGS_A: pass, AUDIT_FINDINGS_B: pass });
    const self = out.ran.find((step) => step.name === "结论自证：回读 Check Run");
    expect(self).toBeTruthy();
    expect(self.status).toBe(0);
    // 计数回读只认 commits/<sha>/check-runs 形态，且显式带 filter=all&per_page=：
    // 默认 filter=latest 是按 name 去重的视图，「恰好一条」不许建在去重上。
    expect(
      out.calls.filter((call) => call.includes("commits/cafebabe/check-runs?filter=all&per_page=100")),
    ).toHaveLength(1);
    // 内容回读按 id 打单条 —— 这是「写着什么」唯一的观测面。
    expect(out.calls.filter((call) => call.includes("check-runs/4242"))).toHaveLength(1);
    expect(out.summary).toBe("");
  });

  it("自证：同一 sha 上有更旧的第二条 name=audit（id 更小）—— 幂等，退出 0", () => {
    // dispatch / rerun 的**正常留痕**：同一个 commit 上 id 更小的同名结论不该让自证变红。
    // 把它读成「判不了」，一次合法的重跑就会用一条历史记录掩盖正确结论。
    // 夹具是**原始页形状**：按 name 过滤是步骤自己的事，假 gh 不代劳。
    const out = runWorkflow({
      AUDIT_FINDINGS_A: pass,
      AUDIT_FINDINGS_B: pass,
      FAKE_GH_CHECK_RUNS_JSON: JSON.stringify({
        total_count: 2,
        check_runs: [
          { id: 1111, name: "audit", status: "completed", conclusion: "failure", app: { slug: "github-actions" } },
          { id: 4242, name: "audit", status: "completed", conclusion: "success", app: { slug: "github-actions" } },
        ],
      }),
    });
    const self = out.ran.find((step) => step.name === "结论自证：回读 Check Run");
    expect(self.status, String(self.stdout) + String(self.stderr)).toBe(0);
    expect(out.summary).toBe("");
    // 结论本身没被改写。
    expect(out.payload).toMatchObject({ name: "audit", status: "completed", conclusion: "success" });
  });

  it("自证：同一 sha 上有比本次更新的 name=audit（id 更大）—— 非 0 且点名那条 id 与 merge-gate", () => {
    // 会被读到的是 id 最大的那条（merge-gate G3 对同名 check 取 id 最大者），
    // 所以 id 更大的那条一出现，本次结论就已经被盖掉 —— 这才是要红的形态。
    const out = runWorkflow({
      AUDIT_FINDINGS_A: pass,
      AUDIT_FINDINGS_B: pass,
      FAKE_GH_CHECK_RUNS_JSON: JSON.stringify({
        total_count: 2,
        check_runs: [
          { id: 4242, name: "audit", status: "completed", conclusion: "success", app: { slug: "github-actions" } },
          { id: 9999, name: "audit", status: "completed", conclusion: "failure", app: { slug: "github-actions" } },
        ],
      }),
    });
    const self = out.ran.find((step) => step.name === "结论自证：回读 Check Run");
    expect(self.status).not.toBe(0);
    expect(String(self.stdout)).toContain("::error title=audit 自证失败");
    // 断的是**类别标题行**，不是全文：尾段说明把四类名字都列了一遍，
    // 只查子串的话「条数不对」也能满足它（实测）。
    expect(out.summary).toContain("## audit 自证失败：被更新的结论盖过");
    expect(out.summary).toContain("9999");
    expect(out.summary).toContain("merge-gate 会读到 id=9999");
    // 结论本身还是那条 success：红的只有自证步，POST 出去的 payload 没被改写。
    expect(out.payload).toMatchObject({ name: "audit", status: "completed", conclusion: "success" });
  });

  it("自证：本 sha 上有 name=audit，但本次那条不在其中 ——「本次结论不在本 sha 上」", () => {
    const out = runWorkflow({
      AUDIT_FINDINGS_A: pass,
      AUDIT_FINDINGS_B: pass,
      FAKE_GH_CHECK_RUNS_JSON: JSON.stringify({
        total_count: 1,
        check_runs: [
          { id: 1234, name: "audit", status: "completed", conclusion: "success", app: { slug: "github-actions" } },
        ],
      }),
    });
    const self = out.ran.find((step) => step.name === "结论自证：回读 Check Run");
    expect(self.status).not.toBe(0);
    expect(String(self.stdout)).toContain("::error title=audit 自证失败");
    expect(String(self.stdout)).toContain("id=4242");
    // 分类必须点明「本次这条根本没落到平台上」，而不是笼统的「条数不对」：
    // 这两种形态的处置相反（一个是这次没留痕，一个是别人在写结论）。
    expect(out.summary).toContain("## audit 自证失败：本次结论不在本 sha 上");
    expect(out.summary).toContain("1234");
  });

  it("自证：同一个 sha 上还有别名的 Check Run —— 只数 name=audit 的那一条", () => {
    // 假 gh 回的是原始页（不预先筛 name）：过滤条件写坏时，别人那条会被一起数进来。
    const out = runWorkflow({
      AUDIT_FINDINGS_A: pass,
      AUDIT_FINDINGS_B: pass,
      FAKE_GH_CHECK_RUNS_JSON: JSON.stringify({
        total_count: 2,
        check_runs: [
          { id: 8888, name: "render", status: "completed", conclusion: "success", app: { slug: "github-actions" } },
          { id: 4242, name: "audit", status: "completed", conclusion: "success", app: { slug: "github-actions" } },
        ],
      }),
    });
    const self = out.ran.find((step) => step.name === "结论自证：回读 Check Run");
    expect(self.status, String(self.stderr)).toBe(0);
    expect(out.summary).toBe("");
  });

  it("自证：内容被改 —— 单条回读的 conclusion 与本次 payload 不符，非 0 且点名期望/实得", () => {
    // PATCH 改写既有那条：条数不变、id 不变，只有 content 变了。只比「是谁」结构上看不见它。
    const out = runWorkflow({
      AUDIT_FINDINGS_A: pass,
      AUDIT_FINDINGS_B: JSON.stringify(result({ verdict: "needs_revision" })),
      FAKE_GH_CHECK_RUNS_JSON: JSON.stringify({
        total_count: 1,
        check_runs: [
          { id: 4242, name: "audit", status: "completed", conclusion: "success", app: { slug: "github-actions" } },
        ],
      }),
    });
    expect(out.payload.conclusion).toBe("failure");
    const self = out.ran.find((step) => step.name === "结论自证：回读 Check Run");
    expect(self.status).not.toBe(0);
    expect(String(self.stdout)).toContain("::error title=audit 自证失败");
    expect(out.summary).toContain("内容被改");
    expect(out.summary).toContain("failure");
    expect(out.summary).toContain("success");
  });

  it("自证：换了 app 就是别人发的 —— app.slug 不是 github-actions 也进「内容被改」", () => {
    const out = runWorkflow({
      AUDIT_FINDINGS_A: pass,
      AUDIT_FINDINGS_B: pass,
      FAKE_GH_CHECK_RUNS_JSON: JSON.stringify({
        total_count: 1,
        check_runs: [
          { id: 4242, name: "audit", status: "completed", conclusion: "success", app: { slug: "third-party" } },
        ],
      }),
    });
    const self = out.ran.find((step) => step.name === "结论自证：回读 Check Run");
    expect(self.status).not.toBe(0);
    expect(out.summary).toContain("内容被改");
    expect(out.summary).toContain("app.slug");
    expect(out.summary).toContain("third-party");
  });

  // 四字段里 name 与 status 原先只有「文本里出现过字段名」的静态断言：
  // 把期望值换成实得值（["name", got[0], got[0]] / ["status", got[2], got[2]]）恒真，
  // 整仓全绿（实测）。下面的用例把这两列各自钉在**期望常量**上。
  it("自证：回读的 name 不是 audit —— 非 0 且 summary 点名 name 与期望/实得", () => {
    const out = runWorkflow({
      AUDIT_FINDINGS_A: pass,
      AUDIT_FINDINGS_B: pass,
      // 列表页给的是 id=4242 的 audit（id 判据全过），单条回读却不叫 audit：
      // 两个观测面不同源是真实形态，也是唯一能让「内容比对」单独受检的形状。
      FAKE_GH_CHECK_RUNS_JSON: JSON.stringify({
        total_count: 1,
        check_runs: [
          { id: 4242, name: "audit", status: "completed", conclusion: "success", app: { slug: "github-actions" } },
        ],
      }),
      FAKE_GH_ONE_RUN_BODY: JSON.stringify({
        id: 4242,
        name: "render",
        status: "completed",
        conclusion: "success",
        app: { slug: "github-actions" },
      }),
    });
    const self = out.ran.find((step) => step.name === "结论自证：回读 Check Run");
    expect(self.status).not.toBe(0);
    expect(String(self.stdout)).toContain("::error title=audit 自证失败");
    expect(out.summary).toContain("## audit 自证失败：内容被改");
    expect(out.summary).toContain("name 期望 audit、实得 render");
  });

  it("自证：回读的 status 不是 completed —— 非 0 且 summary 点名 status 与期望/实得", () => {
    const out = runWorkflow({
      AUDIT_FINDINGS_A: pass,
      AUDIT_FINDINGS_B: pass,
      FAKE_GH_CHECK_RUNS_JSON: JSON.stringify({
        total_count: 1,
        check_runs: [
          { id: 4242, name: "audit", status: "completed", conclusion: "success", app: { slug: "github-actions" } },
        ],
      }),
      FAKE_GH_ONE_RUN_BODY: JSON.stringify({
        id: 4242,
        name: "audit",
        status: "in_progress",
        conclusion: "success",
        app: { slug: "github-actions" },
      }),
    });
    const self = out.ran.find((step) => step.name === "结论自证：回读 Check Run");
    expect(self.status).not.toBe(0);
    expect(String(self.stdout)).toContain("::error title=audit 自证失败");
    expect(out.summary).toContain("## audit 自证失败：内容被改");
    expect(out.summary).toContain("status 期望 completed、实得 in_progress");
  });

  // 两处 fail-closed 原先零用例：给 CONFIG 补一个默认值（回读为空就地变成「伪造通过」）
  // 或删掉「payload 里没有 conclusion」那条分支，整仓全绿（实测）。这两条把它们钉住。
  it("自证：单条回读成功但 body 为空 ——「内容无从比对」，不许拿空内容当通过", () => {
    const out = runWorkflow({
      AUDIT_FINDINGS_A: pass,
      AUDIT_FINDINGS_B: pass,
      FAKE_GH_CHECK_RUNS_JSON: JSON.stringify({
        total_count: 1,
        check_runs: [
          { id: 4242, name: "audit", status: "completed", conclusion: "success", app: { slug: "github-actions" } },
        ],
      }),
      // exit 0 但什么都不回：CONFIG_OK=1、CONFIG="" —— 给空串补默认值就是伪造通过。
      FAKE_GH_ONE_RUN_BODY: "",
    });
    const self = out.ran.find((step) => step.name === "结论自证：回读 Check Run");
    expect(self.status).not.toBe(0);
    expect(String(self.stdout)).toContain("::error title=audit 自证失败");
    expect(out.summary).toContain("## audit 自证失败：内容无从比对");
    expect(out.summary).toContain("空的");
    // 分类必须分得开：空 body 是「拿不到内容」，不是「有人改写了内容」。
    // 断言的是**标题行**（摘要页的失败类别就是这一行），不是全文：尾部那段说明会把四类名字都列一遍。
    expect(out.summary).not.toContain("## audit 自证失败：内容被改");
  });

  it("自证：payload 里的 conclusion 是空串 ——「内容无从比对」，空期望不许与空实得互证", () => {
    // 结论兜底只补「非字符串」的 payload，空串是唯一能一路穿到自证步的「没有结论」形态；
    // 那时若拿实得内容与空期望比，conclusion 两边都空就「相等」，等于用空内容冒充通过。
    const out = runWorkflow(
      { AUDIT_FINDINGS_A: pass, AUDIT_FINDINGS_B: pass },
      {},
      (dir) => {
        writeFileSync(
          join(dir, "scripts/audit-findings.mjs"),
          [
            // scripts/ 是 ESM（package.json type=module）：require 在这里是 ReferenceError。
            'import fs from "node:fs";',
            'fs.writeFileSync(".audit/result.json", JSON.stringify({',
            '  verdict: "INFRA", conclusion: "", executors: [], comparison: null,',
            '}) + String.fromCharCode(10));',
            "",
          ].join(String.fromCharCode(10)),
        );
      },
    );
    // 载体确实没有可用 conclusion，而 POST 照常发生了 —— 这正是自证步要拦的形态。
    expect(out.payload).toMatchObject({ name: "audit", status: "completed" });
    expect(out.payload.conclusion).toBe("");
    const self = out.ran.find((step) => step.name === "结论自证：回读 Check Run");
    expect(self.status).not.toBe(0);
    expect(String(self.stdout)).toContain("::error title=audit 自证失败");
    expect(out.summary).toContain("内容无从比对");
    expect(out.summary).not.toContain("## audit 自证失败：内容被改");
  });

  it("自证：POST 步没交出 check_run_id —— fail-closed，非 0 且点名缺 expected", () => {
    // expected 落空时，「条数恰好一条」这种巧合不许把它读成通过。
    const out = runWorkflow({ AUDIT_FINDINGS_A: pass, AUDIT_FINDINGS_B: pass }, {}, undefined, {
      skip: ["回写 Check Run"],
    });
    const self = out.ran.find((step) => step.name === "结论自证：回读 Check Run");
    expect(self).toBeTruthy();
    expect(self.status).not.toBe(0);
    expect(String(self.stdout)).toContain("::error title=audit 自证失败");
    expect(out.summary).toContain("POST 步没有交出 check_run_id");
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

  // ---- 命令替换：切词之前先让它「看得见」----
  // shellWords 把整段引号内容并成一个词，于是 `id="$(gh api …)"` 里的 gh 既不是命令头、
  // 里面的分隔符也不是边界 —— 红绿只差一对引号，而那正是 shellcheck 推荐的写法。
  // 所以 `$( … )` 与反引号里的正文**无论在不在引号里**都要递归当命令序列再看一遍：
  // 单引号里的不是替换（shell 不展开），这里跟着不展开；嵌套上限 3 层，超限的落 unfollowable。
  const MAX_SUBSTITUTION_DEPTH = 3;
  const SUBSTITUTION_DEPTH_REASON =
    "命令替换嵌套超过 " + MAX_SUBSTITUTION_DEPTH + " 层：静态层跟不下去，按命令级默认拒绝";

  function substitutionBodies(text) {
    const source = String(text);
    const bodies = [];
    let quote = null;
    for (let i = 0; i < source.length; i += 1) {
      const ch = source[i];
      if (quote === "'") {
        if (ch === "'") quote = null;
        continue;
      }
      if (ch === "\\") {
        i += 1;
        continue;
      }
      if (ch === '"') {
        quote = quote === '"' ? null : '"';
        continue;
      }
      // 双引号里的撇号是字面量（shell 不认它是引号起始）：在这里开单引号会把后面整段
      // 当成不展开的字面量跳过，里面的 `$(gh api …)` 既不进 bodies 也不进 overflow ——
      // 深度闸门于是静默放行（review-a r20-a-1 实测）。
      if (ch === "'") {
        if (quote === '"') continue;
        quote = "'";
        continue;
      }
      if (ch === "\x60") {
        let j = i + 1;
        let value = "";
        while (j < source.length && source[j] !== "\x60") {
          if (source[j] === "\\") {
            value += source[j + 1] ?? "";
            j += 2;
            continue;
          }
          value += source[j];
          j += 1;
        }
        bodies.push(value);
        i = j;
        continue;
      }
      if (ch === "$" && source[i + 1] === "(") {
        // 括号配平要跳过引号里的括号，否则 $(echo ')') 会切错。
        let depth = 0;
        let j = i + 1;
        let inner = null;
        for (; j < source.length; j += 1) {
          const c = source[j];
          if (inner) {
            if (c === "\\") {
              j += 1;
              continue;
            }
            if (c === inner) inner = null;
            continue;
          }
          if (c === "'" || c === '"') {
            inner = c;
            continue;
          }
          if (c === "(") depth += 1;
          else if (c === ")") {
            depth -= 1;
            if (depth === 0) break;
          }
        }
        bodies.push(source.slice(i + 2, j));
        i = j;
        continue;
      }
    }
    return bodies;
  }

  // depth 是这一层正文的嵌套层数（1 起）。超限的正文不静默丢：收进 overflow 让调用方响。
  function collectSubstitutionBodies(text, depth, out) {
    for (const body of substitutionBodies(text)) {
      if (depth > MAX_SUBSTITUTION_DEPTH) {
        out.overflow.push(body);
        continue;
      }
      out.bodies.push(body);
      collectSubstitutionBodies(body, depth + 1, out);
    }
    return out;
  }

  function substitutionExpansion(text) {
    return collectSubstitutionBodies(String(text), 1, { bodies: [], overflow: [] });
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
    // working-directory 不是说明文字：它把这一步里**所有相对路径**重新钉到另一个目录上。
    // 它零扫描时，裸载体名（check-run.json）不写 `.audit/` 也算引用 —— 判据没看这个字段，
    // 红绿只差一个键（实测：插一步 working-directory: .audit + run: jq -r '.conclusion' check-run.json
    // 110 条全绿；同一行改写成 .audit/check-run.json 就红 2 条）。
    if (typeof step["working-directory"] === "string") {
      payloads.push({ carrier: "working-directory", text: step["working-directory"] });
    }
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
    // defaults.run.working-directory 与 step 级同机制：位置换了、执行面没换
    // （它同样把全部 step 的相对路径钉到另一个目录）。doc 级的对全部 job 生效，一并收。
    for (const [carrier, dir] of [
      ["defaults.run.working-directory", job?.defaults?.run?.["working-directory"]],
      ["defaults.run.working-directory", doc?.defaults?.run?.["working-directory"]],
    ]) {
      if (typeof dir === "string") payloads.push({ carrier, text: dir });
    }
    return payloads;
  }

  // 工作目录是**路径**不是命令：它决定相对路径落在哪，本身不执行任何东西。
  const WORK_DIR_CARRIERS = new Set(["working-directory", "defaults.run.working-directory"]);

  // 工作目录的等价类：`.audit` / `./.audit` / `.audit/` / `.audit/.` 钉的是同一个目录，
  // `.` / `./` 是仓库根（归一成空串）。写法不能改变判定，否则换一个斜杠就换一个结论。
  function normalizeWorkingDirectory(value) {
    if (typeof value !== "string") return null;
    const raw = value.trim().replace(/\\/g, "/");
    if (!raw) return null;
    const normalized = posix.normalize(raw).replace(/\/+$/, "");
    return normalized === "." ? "" : normalized;
  }

  // 一份载荷被执行到的脚本引用：shell 字段按 custom shell 命令解，其余按 shell 词法 + loader 取值。
  function payloadScriptRefs(payload, options = {}) {
    // 工作目录进引用判定（`.audit` 就是 `.audit`），但不进脚本跟随：
    // 它是路径不是命令，写着 `./scripts` 也不代表执行了里面的东西 ——
    // 跟着解只会把普通目录记成「跟不下去的脚本」，用噪音盖住真相。
    if (WORK_DIR_CARRIERS.has(payload.carrier)) return { refs: [], unfollowable: [] };
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
    /(?<![\w-])(?:--require|--import|--loader|--experimental-loader)(?:=|\s+|$)([^\s"';|&]*)/g;
  // 短旗标 -r 与 -rq / -rc 这类**别的工具的旗标**同形（grep -r、jq -r、sed -r 都是它）：
  // 只要把它一律当 loader，红的原因就变成「-r 后面取不到值」这种噪音（jq -r 红、grep -rq 绿，
  // 覆盖真相被误报盖住）。正名判据是：-r 的取值**解得出一份真实脚本**才算模块取值；
  // 解不出就说明它不是 loader 旗标（jq / grep / sed 的 -r 后面跟的是模式或目录，不是模块名）。
  const LOADER_FLAG_SHORT = /(?<![\w-])-r(?:=|\s+)([^\s"';|&]*)/g;
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
    // 短旗标不产生 unfollowable：解不出的 -r 不是 loader（见上），它该红的理由是
    // 「非写者步引用了载体」，由引用判据负责，不由「跟不下去」兜。
    for (const match of String(text).matchAll(LOADER_FLAG_SHORT)) {
      const rel = resolveScriptRef(root, match[1]);
      // 门槛就是上面注释说的判据：解出来的路径**真实存在**才算模块取值。
      // resolveScriptRef 对不存在的路径也返回 rel（它只做归一），于是 jq -r .verdict 的
      // `.verdict` 被当成模块名落进 missing —— 红得莫名其妙，用噪音盖住真相。
      if (rel && existsSync(scriptPath(root, rel)) && !refs.includes(rel)) refs.push(rel);
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
  // ---- 载体集合：这套判据不是 result.json 专用的 ----
  // 一个可选 JSON 载体（result.json / check-run.json）的规则是同一套：
  // 「非写者步里任何引用都是违规；放行只留给显式白名单」。
  // 规格集中在这里生成、函数一律带 carrier 参数，缺省是 result.json —— 历史调用点一字不改。
  // 新载体不复制一份判据：复制一份就是两套判据，迟早只维护一套，另一套静默退化。
  function carrierSpec(file) {
    const escaped = file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return {
      file,
      ref: new RegExp(escaped),
      // 目录通配也是引用：.audit/*.json 把两个载体一起读走，路径里却没有文件名这串字。
      glob: /\.audit\/[^\s"';|&)]*\*/,
      // 字符串字面量**本身就是这个路径**才算引用；字面量里顺嘴提到（人话消息、注释）不算 ——
      // 一句 echo 里的说明文字把整步染红，判据就会被人当噪音关掉。
      pathLiteral: new RegExp("^[^\\s\"'\\x60]*" + escaped + "$"),
      // 把载体路径当参数交给一个函数，也是在把它当数据取用（隐藏的解析包装器）。
      pathCall: new RegExp("([A-Za-z_$][\\w$]*)\\s*\\(\\s*[\"'][^\"']*" + escaped + "[\"']", "g"),
      // 「解析这份载体的那个变量」：整体枚举判据要按载体绑定。
      varDecl: new RegExp("(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*=[^\\n]*" + escaped, "g"),
      // shell 重定向写同一份文件。
      redirect: new RegExp(">>?\\s*[^\\s;&|)]*" + escaped),
      // 纯文本倒出的合法操作数：目录层可以是任意前缀，文件名必须就是这份载体。
      dumpPath: new RegExp("^(?:\\.{0,2}/)*(?:[^\\s\"'\\x60]+/)?" + escaped + "$"),
    };
  }
  const CARRIERS = { result: carrierSpec("result.json"), checkRun: carrierSpec("check-run.json") };
  const DEFAULT_CARRIER = CARRIERS.result;
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
  // 把载体路径当参数交给一个函数，也是在把它当数据取用 —— 哪怕解析动作藏在包装函数里
  // （兜底步的 read(p) 就是这种形状：那一行只有 JSON.parse 在函数定义处）。
  // 这份拼写随载体走（carrier.pathCall），所以 check-run.json 不会漏在同一格上。
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

  function resultJsonReadCalls(line, carrier = DEFAULT_CARRIER) {
    let count = 0;
    for (const re of RESULT_JSON_READ_FILE_CALLS) count += [...line.matchAll(re)].length;
    count += [...line.matchAll(RESULT_JSON_JQ)].length;
    for (const match of line.matchAll(carrier.pathCall)) {
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

  function resultJsonLineInfo(rawLine, carrier = DEFAULT_CARRIER) {
    const info = maskStringLiterals(rawLine);
    // 引号里是程序时，代码区就是这段程序本身 —— 只掩「数据」，不掩「被执行到的代码」。
    const code = INLINE_PROGRAM.test(rawLine) ? rawLine : info.masked;
    const literals = info.literals.map((value) => value.trim());
    const literalPaths = literals.filter((value) => carrier.pathLiteral.test(value));
    const globbed = carrier.glob.test(code) || literals.some((value) => carrier.glob.test(value));
    const referenced = carrier.ref.test(code) || literalPaths.length > 0 || globbed;
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

  function resultJsonWriteIntent(info, carrier = DEFAULT_CARRIER) {
    if (RESULT_WRITE_NAMES.test(info.masked)) return true;
    if (info.bracketKeys.some((key) => RESULT_WRITE_KEYS.includes(key))) return true;
    if (RESULT_WRITE_COMPUTED.test(info.raw)) return true;
    // 口径层的落盘形态：--out 必须是代码区里真的有一个参数。
    if (/--out(?:\s+|=)/.test(info.masked)) return true;
    // shell 重定向写同一份文件：node x.mjs > .audit/result.json / ... > ".audit/result.json"
    if (carrier.redirect.test(info.masked)) return true;
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
  //   3) 存在性检查 / 变量对变量比较（见下面 RESULT_DUMP_EXISTENCE 与 RESULT_DUMP_VAR_COMPARE：
  //      只回答「文件在不在」「我放的那段串在不在」，不问内容取值）—— 所以这里不列 [[ ]] / test。
  // 出现 jq / JSON.parse / .字段 / Object.keys|entries|values / 写文件 / node|python|perl
  // / sed|awk|cut|grep|tee|dd|base64 / 管道到别的命令 -> 不是倒出而是取数据，立刻违规。
  const RESULT_DUMP_CAT =
    /^\s*(?:([A-Za-z_]\w*)\s*=\s*\$\(\s*)?cat\s+(?:-{1,2}[A-Za-z]+\s+)*(?:"([^"]*)"|'([^']*)'|([^\s;&|)]+))((?:\s+2?>\s*\/dev\/null)*)(?:\s*\|\|\s*true)?\s*\)?\s*$/;
  const RESULT_DUMP_OUT = /^\s*(?:echo|printf)\b/;
  // 「只做比较」这条放行曾经写成 [[ ]] / test 的**前缀**匹配：于是
  //   [[ "$body" == *needs_revision* ]] && echo hot=1
  // 在非写者步里 103 条全绿 —— 它不是比较，是**按结论内容分支**。
  // 现在只留两种，且都不问「内容是什么」：
  //   1) 存在性检查：[[ -s <path> ]] / [[ -f <path> ]] / test -s|-f <path>；
  //   2) 围栏增长循环：[[ "$body" == *"$fence"* ]] —— 比较对象是**变量**（这一步自己拼的
  //      引号串），它只能回答「倒出来的文本里有没有这段串」，而这段串本来就是它自己放的，
  //      所以分辨不出任何 verdict / conclusion 取值。字面量模式（== *needs_revision*、
  //      =~、通配、grep）一律违规。
  const RESULT_DUMP_EXISTENCE =
    /^\s*(?:(?:while|if|elif|until|for)\s+)*(?:\[\[|\[|test)\s+-[sf]\s+(?:"[^"]*"|'[^']*'|[^\s;&|)\]]+)\s*(?:\]\]|\])?\s*;?\s*$/;
  const RESULT_DUMP_VAR_COMPARE =
    /^\s*(?:(?:while|if|elif|until)\s+)*(?:\[\[|\[)\s*"?\$\{?[A-Za-z_]\w*\}?"?\s*==\s*\*?"\$\{?[A-Za-z_]\w*\}?"\*\s*(?:\]\]|\])\s*(?:;\s*do\b.*)?$/;
  const RESULT_DUMP_FORBIDDEN =
    /(?:\bjq\b|JSON\.parse|Object\.(?:entries|keys|values)|\bnode\b|\bpython3?\b|\bperl\b|\bruby\b|\bsed\b|\bawk\b|\bcut\b|\btee\b|\bdd\b|\bgrep\b|\bhead\b|\btail\b|\bxargs\b|\bexec\b|\beval\b|\bsource\b|base64|openssl|\bcurl\b|\bwget\b|\bnc\b)/;
  const RESULT_DUMP_ALIAS_USE = /\$(?:\{([A-Za-z_]\w*)\}|([A-Za-z_]\w*))/g;
  // 真正的管道才 forbid：|| true 里第二个竖线前面也是竖线，只看后面会把 || 当管道。
  const PIPE_TO_OTHER = /(?<!\|)\|(?!\|)/;

  // 一段被执行到的文本 -> 逐行的引用分类。默认拒绝就在这个循环里：
  // 只要这一行引用了载体，除非它命中白名单（写意图 / 纯文本倒出 / 载体自己的显式放行），其余一律是违规。
  // 别名（body=$(cat ...) 之后原样输出）按**文本内**作用域跟踪：
  // 跨文本继承别名等于让另一个 step 借前一步的变量，那不是同一条命令。
  // options.allowLine：载体自己的白名单（check-run.json 只放行「用 --input POST 它」那一行）。
  // 放行也是一条**行级**判定，并且被跳过的那一行不再算读、不占写者步的额度 ——
  // 否则「放行」会顺手送出一份额度，额度又从另一头漏出去。
  function scanResultJsonText(text, options = {}) {
    const carrier = options.carrier ?? DEFAULT_CARRIER;
    const aliases = new Set();
    const entries = [];
    for (const rawLine of String(text).split("\n")) {
      const line = stripShellComment(rawLine);
      if (!line.trim() || COMMENT_ONLY_LINE.test(line)) continue;
      const info = resultJsonLineInfo(line, carrier);
      const aliasUse = [...line.matchAll(RESULT_DUMP_ALIAS_USE)]
        .map((match) => match[1] ?? match[2])
        .filter((name) => aliases.has(name));
      if (!info.referenced && aliasUse.length === 0) continue;
      if (options.allowLine && options.allowLine(line, info)) {
        entries.push({ excerpt: line.trim(), dump: false, write: false, calls: 0, allowed: true });
        continue;
      }
      // 0) 存在性检查：只回答「文件在不在」，没有被倒出、也没有被解析。
      //    它唯一的用途是「判不了」分支（result.json 没落地 -> 走 INFRA 留痕），
      //    所以放行它对内容没有任何可观测后果；内容匹配不在这一格里（见 RESULT_DUMP_VAR_COMPARE）。
      if (info.referenced && RESULT_DUMP_EXISTENCE.test(line) && !RESULT_DUMP_FORBIDDEN.test(line)) {
        entries.push({ excerpt: line.trim(), dump: true, write: false, calls: 0 });
        continue;
      }
      // 1) 纯文本倒出：cat 整份文件倒出来，可赋值给变量供后面原样输出。
      if (info.referenced) {
        const dump = RESULT_DUMP_CAT.exec(line);
        if (dump) {
          const operand = (dump[2] ?? dump[3] ?? dump[4] ?? "").trim();
          if (carrier.dumpPath.test(operand) && !RESULT_DUMP_FORBIDDEN.test(line) && !PIPE_TO_OTHER.test(line)) {
            if (dump[1]) aliases.add(dump[1]);
            entries.push({ excerpt: line.trim(), dump: true, write: false, calls: 0 });
            continue;
          }
        }
      }
      // 2) 倒出来的文本变量：只许原样输出 / 比较，一经加工就是取数据。
      if (aliasUse.length > 0) {
        const allowed =
          (RESULT_DUMP_OUT.test(line) || RESULT_DUMP_EXISTENCE.test(line) || RESULT_DUMP_VAR_COMPARE.test(line)) &&
          !RESULT_DUMP_FORBIDDEN.test(line) &&
          !PIPE_TO_OTHER.test(line);
        entries.push({ excerpt: line.trim(), dump: allowed, write: false, calls: 0 });
        continue;
      }
      // 3) 其余引用：写意图 -> 写者步；读形态 -> 一次读（写者步有一次额度）；
      //    两者都不是 -> 就是默认拒绝要抓的那一类（换什么拼写都不影响）。
      const write = resultJsonWriteIntent(info, carrier);
      const calls = resultJsonReadCalls(line, carrier);
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
  function hasResultJsonWrite(text, options = {}) {
    return scanResultJsonText(text, options).some((entry) => entry.write);
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
    const scan = { carrier: options.carrier ?? DEFAULT_CARRIER, allowLine: options.allowLine };
    const key = options.key ?? ((step) => step.id ?? step.name);
    return stepList
      .filter((step) => stepTexts(step, { root }).some(({ text }) => hasResultJsonWrite(text, scan)))
      .map((step, index) => key(step, index));
  }

  // 一次「数据读」= 引用 result.json 且这一行有读形态。
  // 判读/判写都在**剥掉 shell 注释之后**的行上做：注释里写一句 --out 不能让整行读洗白。
  // onWriteLine 只影响豁免资格（写者步只有**一次**纯读行的额度），不改变计数。
  function resultJsonReads(text, options = {}) {
    const reads = [];
    for (const entry of scanResultJsonText(text, options)) {
      if (entry.dump || entry.allowed) continue;
      for (let i = 0; i < entry.calls; i += 1) reads.push({ excerpt: entry.excerpt, onWriteLine: entry.write });
    }
    return reads;
  }

  // 默认拒绝的正身：引用了 result.json、既不是白名单倒出、也没有写意图、也不是一次读形态 ——
  // 一律违规。旧判据要「先认出一次读调用」才计数，于是计算属性 / .call / 别名 /
  // 把读者整个搬进被引用的 .cjs 全都 0 红。这条不看拼写，所以没有「还差哪几种」可以补。
  function resultJsonReferenceViolations(text, options = {}) {
    return scanResultJsonText(text, options)
      .filter((entry) => !entry.allowed && !entry.dump && !entry.write && entry.calls === 0)
      .map((entry) => ({ excerpt: entry.excerpt }));
  }
  // 「整体枚举整份 result」：把 result.json 解析成对象之后整份过一遍。
  // 识别对象必须与「解析 result.json 的那个变量」绑定 —— 写者也会 JSON.stringify 自己拼的
  // payload，那不是这条的形状。口径层只按字段取用，出现一次就说明它在搬数据而不是产出数据。
  const WHOLE_ENUM_CALL = /(?:Object\.(?:entries|keys|values)|JSON\.stringify)\s*\(\s*([A-Za-z_$][\w$]*)/g;
  // 整体 dump 同一性质：console.log(整份对象) 一次就把 verdict / conclusion / executors /
  // comparison 全写进公开 run log。只认「整个变量」——console.log(r.verdict) 是按字段取用。
  const WHOLE_DUMP_CALL =
    /(?:console\.(?:log|info|debug|warn|dir|table)|process\.stdout\.write)\s*\(\s*([A-Za-z_$][\w$]*)(?![.\w$?[\]])/g;

  function wholeResultEnumerations(text, carrier = DEFAULT_CARRIER) {
    const source = String(text);
    const resultVars = [...source.matchAll(carrier.varDecl)].map((match) => match[1]);
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
    const carrier = options.carrier ?? DEFAULT_CARRIER;
    const scan = { carrier, allowLine: options.allowLine };
    const producers = resultWriters(stepList, { root });
    const violations = [];
    for (const { source, where, text } of jobPayloadTexts(options.jobPayloads ?? [], { root })) {
      for (const read of resultJsonReads(text, scan)) violations.push({ step: source, where, excerpt: read.excerpt });
      for (const bad of resultJsonReferenceViolations(text, scan)) {
        violations.push({ step: source, where, excerpt: bad.excerpt });
      }
      for (const excerpt of wholeResultEnumerations(text, carrier)) violations.push({ step: source, where, excerpt });
    }
    for (const step of stepList) {
      const source = step.id ?? step.name;
      const texts = stepTexts(step, { root });
      const writes = texts.some(({ text }) => hasResultJsonWrite(text, scan));
      const reads = texts.flatMap(({ where, text }) =>
        resultJsonReads(text, scan).map((read) => ({ where, ...read })),
      );
      if (!writes) {
        for (const read of reads) violations.push({ step: source, where: read.where, excerpt: read.excerpt });
        // 默认拒绝在这里生效：非写者步里**任何**对 result.json 的引用都是违规，
        // 不要求先认出一次读调用 —— 白名单以外的写法一律落在这条上。
        for (const { where, text } of texts) {
          for (const bad of resultJsonReferenceViolations(text, scan)) {
            violations.push({ step: source, where, excerpt: bad.excerpt });
          }
          // 整体枚举对**所有**步生效：不写 result.json 的步同样能把整份数据 dump 进日志，
          // 把它放在写者分支里，这道第二防线在非写者步上就是死代码。
          for (const excerpt of wholeResultEnumerations(text, carrier))
            violations.push({ step: source, where, excerpt });
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
        for (const bad of resultJsonReferenceViolations(text, scan)) {
          violations.push({ step: source, where, excerpt: bad.excerpt });
        }
        // 整体枚举一条也不放行。写者自己的脚本文件（texts 里 where 就是生产者本身）除外：
        // 那份文件就是「与写同源」的那一份，它的按字段取用不该被当成搬运。
        if (producers.includes(where)) continue;
        for (const excerpt of wholeResultEnumerations(text, carrier))
          violations.push({ step: source, where, excerpt });
      }
    }
    return violations;
  }

  // ---- 轮十三：引用定义抬到 .audit 目录级 ----
  // 上面那层把引用认成「相对文件名」：于是按**文件**发生的执行面被按**拼写**认。
  // 实测四种等价写法全绿（review-b 在 /tmp 副本上复现）：
  //   grep -rq needs_revision .audit       父目录：文件名一个字都不写
  //   tar -cf /tmp/x.tar .audit            目录搬运：同上
  //   cat .audit/result.jso?               ? 通配：不是星号，逃过 glob 判据
  //   cp -a .audit /tmp/leakdir            改个名再读：cp 这一步就已经引用
  // 继续补拼写没有意义（每补一种，等于把「还差哪几种」的清单交给对手）。这一层只认一件事：
  // **原始文本里出现 .audit 就算引用**，且刻意**不掩字符串字面量** —— 路径通常就写在引号里。
  // 放行只剩四条显式白名单，全部是行级：
  //   1) mkdir -p .audit 建目录（不读写载体，也不因此把这一步算成写者）；
  //   2) 该路径的写者/消费者精确名单（AUDIT_PATH_ALLOWED_STEPS，断言用 toEqual）；
  //   3) cat 原样倒出 result.json（沿用下层倒出判据，只服务 INFRA 留痕那一步）；
  //   4) 用 --input .audit/check-run.json 的 POST（只有那两步，见 CHECK_RUNS_*）。
  // 其余任何 .audit 路径一律违规 —— 不给「认领不到就放过」。
  const AUDIT_DIR_REF = /\.audit(?![\w.-])/;
  const AUDIT_DIR_TOKEN = /\.audit(?:[/\\][^\s"';|&()<>]*)?/g;
  const AUDIT_DIR_CREATE = /^\s*mkdir\s+(?:-\S+\s+)*(?:"\.audit\/?"|'\.audit\/?'|\.audit\/?)\s*$/;
  const AUDIT_DIR_CREATE_NODE = /\bmkdir(?:Sync)?\s*\(\s*["']\.audit\/?["']/;
  // 允许**引用**该路径的步 = 写者 + 唯一消费者（左半是写者，同样精确，用 toEqual 钉住）。
  // 写者多一个，结论的产出通道就多一条：check-run.json 是真正被 POST 出去的载体，
  // 它的写者只许「口径层判定」「结论兜底」「判不了：回写 INFRA」三步。
  //   review-*.json 只被口径层读来产 result.json；
  //   result.json 被兜底读（缺字段时补写）与 INFRA 留痕原样倒出；
  //   check-run.json 被兜底读，并被那两步用 --input POST。
  const AUDIT_PATH_ALLOWED_STEPS = {
    ".audit/review-a.json": ["落盘 review-a", "口径层判定"],
    ".audit/review-b.json": ["落盘 review-b", "口径层判定"],
    ".audit/result.json": ["口径层判定", "结论兜底", "INFRA 留痕"],
    // 自证步读 check-run.json 是为了「内容比什么」：读的是本次 payload 的 conclusion，只读。
    ".audit/check-run.json": ["口径层判定", "结论兜底", "判不了：回写 INFRA", "回写 Check Run", "结论自证：回读 Check Run"],
  };
  // POST 面收口。check-runs 这个端点在真 workflow 里只有一种合法写法：
  //   gh api repos/$GITHUB_REPOSITORY/check-runs --method POST --input .audit/check-run.json --jq .id
  // 关键在于**绑文件**：只要 POST 的 payload 来自别处（-f name=audit -f conclusion=success
  // 直拼，或把 payload 先写到 .audit/second.json 再 --input 它），判据就不知道那是结论。
  // 只读查询在这个端点上只有一个家：自证步回读自己的那条结论（check-runs?head_sha=…）。
  // 其余任何步读它等于拿到结论的产出面，仍然一并违规。
  // 结论的写面是一条**面**，不是一个端点拼写：REST 的 check-runs 与 GraphQL 的
  // mutation{createCheckRun(...)} 写的是同一条结论。只钉 \bcheck-runs\b 时，
  // GraphQL 那一半零命中（实测：插一条 curl -X POST https://api.github.com/graphql
  // -d '{"query":"mutation{createCheckRun(...conclusion:SUCCESS)}"}' 110 条全绿）。
  // 判据按面判：命中任一面就套同一套 sanctioned 规则。
  const CHECK_RUNS_ENDPOINT = /\bcheck-runs\b|\bcreateCheckRun\b|\/graphql\b/;
  // 方法不在这里枚举（大小写、--method=、-Xpatch 都是同一个方法）：见 ghApiMethod。
  const CHECK_RUNS_INPUT = /--input[=\s]+["']?\.audit\/check-run\.json["']?/;
  const CHECK_RUNS_POST_STEPS = ["回写 Check Run", "判不了：回写 INFRA"];
  // 自证步有**两段**只读回读，两种形态都要认：
  //   1) 计数回读：commits/<ref>/check-runs?filter=all&per_page=… —— 端点只认这一形态
  //      （/check-runs?head_sha= 不存在，实测 404）；filter=all 必须显式写，默认 latest 是去重视图，
  //      「恰好一条」不许建在去重上；
  //   2) 内容回读：check-runs/<id> —— 单条对象，回答「写着什么」（id 只回答「是谁」）。
  const CHECK_RUNS_READ_STEPS = ["结论自证：回读 Check Run"];
  const CHECK_RUNS_READ_LIST = /commits\/[^\s"']+\/check-runs\?[^\s"']*\bfilter=all\b[^\s"']*\bper_page=[0-9]+/;
  const CHECK_RUNS_READ_ONE = /check-runs\/[^\s"'*]{1,}/;

  // ---- 轮十五：run 文本之外的四个面（YAML 的键 / env / 目录 / 命令词）----
  // 上面全部判据都建立在 run 文本上。下面四类东西**不在 run 文本里**，因此全部绿（审查实测）：
  //   1) step 级 continue-on-error: outcome=failure / conclusion=success，job 仍绿；
  //   2) step 级 env: 把 $GITHUB_REPOSITORY 指到别人的仓库，sanctioned 那行一字未改；
  //   3) 同目录另一个 workflow: 第二条同名 Check Run 盖掉真结论；
  //   4) 按目录树寻址的读取 / 包装词之后的写命令 / 解包打补丁。
  // 判据一律按**白名单**收口：多出来的键就是违规。
  const STEP_ALLOWED_KEYS = ["name", "id", "if", "run", "uses", "with", "env", "shell", "working-directory"];
  // job 级 continue-on-error 与 step 级同义（一步红不算 job 红），同样不在白名单里。
  // 键集按 audit.yml 里 job **实有**的键收窄（枚举自 YAML.parse 后的 jobs：name / runs-on / env / steps）：
  // 预放行没人用的键等于给未来的执行面留门（if / permissions / strategy / timeout-minutes / container
  // 每一个都能让 job 在不该绿的时候绿），而轮十五只断言了 continue-on-error 一个。
  const JOB_ALLOWED_KEYS = ["name", "runs-on", "env", "steps"];

  // fail-closed：白名单外的键一律违规，且点名这个键与该 step。
  function unknownKeyViolations(payload, allowed, options = {}) {
    const label = options.label ?? "step";
    const violations = [];
    for (const key of Object.keys(payload ?? {})) {
      if (allowed.includes(key)) continue;
      violations.push({
        step: payload?.name ?? payload?.id ?? options.fallback ?? label,
        where: key,
        excerpt: label + "." + key + ": " + JSON.stringify(payload[key]),
        reason: label + " 键不在白名单：" + key,
      });
    }
    return violations;
  }

  function stepKeyViolations(stepList) {
    const violations = [];
    stepList.forEach((step, index) => {
      violations.push(
        ...unknownKeyViolations(step, STEP_ALLOWED_KEYS, { label: "step", fallback: "第 " + (index + 1) + " 个 step" }),
      );
    });
    return violations;
  }

  function jobKeyViolations(jobPayloadObject, options = {}) {
    return unknownKeyViolations(jobPayloadObject, JOB_ALLOWED_KEYS, {
      label: "job",
      fallback: options.fallback ?? "audit-runner",
    });
  }

  // 结论的落点、凭据、以及三条留痕通道本身：step 级 env 覆写任何一个都等于换了一个执行面。
  const ENV_OVERRIDE_FORBIDDEN = [
    "GITHUB_REPOSITORY",
    "GITHUB_TOKEN",
    "GH_TOKEN",
    "GITHUB_OUTPUT",
    "GITHUB_STEP_SUMMARY",
    "GITHUB_SHA",
  ];

  function stepEnvOverrideViolations(stepList, options = {}) {
    const jobEnv = options.jobEnv ?? {};
    const workflowEnv = options.workflowEnv ?? {};
    const hasKey = (bag, key) => Object.prototype.hasOwnProperty.call(bag ?? {}, key);
    const violations = [];
    for (const step of stepList) {
      const env = step?.env;
      if (!env || typeof env !== "object" || Array.isArray(env)) continue;
      const name = step.name ?? step.id;
      for (const key of Object.keys(env)) {
        let reason = null;
        if (ENV_OVERRIDE_FORBIDDEN.includes(key)) reason = key + " 是禁止覆写的环境变量（step「" + name + "」）";
        else if (hasKey(jobEnv, key)) reason = "step「" + name + "」的 env 覆写了 job 级 env 的 " + key;
        else if (hasKey(workflowEnv, key)) reason = "step「" + name + "」的 env 覆写了 workflow 级 env 的 " + key;
        if (reason) violations.push({ step: name, where: "env", excerpt: key + ": " + env[key], reason });
      }
    }
    return violations;
  }

  // ---- 结论写面跨文件收口 ----
  // 只认**写**：第二条同名 Check Run 必须写出来才会盖掉真结论；读 checks 列表（merge-gate.yml
  // 这类就绪轮询）不产生结论。判据因此是「端点 + 写形态」，不是「端点」。
  const WORKFLOW_DIR = ".github/workflows";
  // 写形态不止 POST：PATCH 改写**既有那条**（checks.update / PATCH check-runs/{id}）不新增记录、
  // 不换 id，条数与 id 都看不出来，但内容变了 —— 它同样是结论写面。
  // 写形态不止 POST：PATCH 改写**既有那条**不新增记录、不换 id，条数与 id 都看不出来，
  // 但内容变了 —— 它同样是结论写面。
  //
  // 这里**默认拒绝**，不枚举写拼写：枚举永远漏得掉下一种（review-b 实测）
  //   * 真 gh 对 `--method patch` / `-Xpatch` / `--method=PATCH` 都真发 PATCH（大小写不敏感）；
  //   * `--raw-field` 与 `-f` / `--field` / `-F` 一样会改内容；
  //   * curl/wget 用 `-d` / `--data-binary` / `-F` 就能在**不写方法**的情况下 POST。
  // 于是判据反过来：端点一旦命中，只有「纯只读」才不是写面 ——
  // 没有方法标志（gh api 默认 GET）且没有任何取值/请求体标志。
  // 方法标志归一化：`--method PATCH` / `--method=PATCH` / `-X PATCH` / `-Xpatch` 一律大写。
  function ghApiMethod(text) {
    const m = /(?:--method|-X)\s*=?\s*([A-Za-z]+)/.exec(String(text));
    return m ? m[1].toUpperCase() : null;
  }

  // 写意图按**命令**判，不按词形枚举，也不看端点拼写：端点可以是变量
  // （ep="repos/o/r/check-runs"; gh api --method POST --input body.json "$ep"），
  // 也可以拆到多行。判据反过来：这个 http 客户端调用**有没有**写意图 ——
  //   * 方法标志不是读方法（gh api 默认 GET）；
  //   * 任何请求体 / 字段 / 输入标志，含短标志的**簇写**（-sSd '…'）与**贴值**
  //     （-d@body.json / -d'{…}' / -Fname=audit）。按 shellWords 切词后看短标志簇里的字母：
  //     继续按词形枚举只会漏掉下一种拼法（实测：这四种写法在旧判据下一条不红）。
  const HTTP_CLIENTS = new Set(["gh", "curl", "wget", "http", "https", "httpie", "xh"]);
  const HTTPIE_CLIENTS = new Set(["http", "https", "httpie", "xh"]);
  const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
  const HTTP_METHOD_VERBS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]);
  // 请求体 / 字段 / 输入：curl 的 -d / -F / -T 与 gh 的 -f / -F。
  // curl 的小写 -f 是 --fail（只读），不在这一族里 —— 否则 `curl -fsSL` 会被读成写。
  const BODY_SHORT_LETTERS = { gh: "fF", curl: "dFT" };
  // 取值字母：短标志簇里遇到它们，它**之后**的部分是取值，不是更多标志字母。
  // 不按 shell 语义停手会两头都错（review-b 实测）：`curl -sX PATCH …` 里 X 没被认成方法（漏）；
  // `curl -sXPATCH …` 命中是因为 PATCH 的 T 撞上了 curl 的体字母 dFT（理由错、机制也错）。
  // curl：d F T X m o H u A e b c；gh：f F X。
  const SHORT_VALUE_LETTERS = { gh: "fFX", curl: "dFTXmoHuAebc" };
  const BODY_LONG_FLAGS = new Set([
    "--data",
    "--data-ascii",
    "--data-binary",
    "--data-raw",
    "--data-urlencode",
    "--form",
    "--form-string",
    "--upload-file",
    "--post-data",
    "--post-file",
    "--body",
    "--body-file",
    "--input",
    "--field",
    "--raw-field",
    "--json",
  ]);

  // `--opt=value` 与 `--opt value` 是同一个选项（大小写不敏感同上）。
  function longFlagName(word) {
    const text = String(word);
    if (!text.startsWith("--")) return null;
    const at = text.indexOf("=");
    return (at >= 0 ? text.slice(0, at) : text).toLowerCase();
  }

  // 短标志簇按 shell 语义扫：-sSd / -d@body.json / -Fname=audit / -Xpatch / -sX PATCH。
  // valueLetter 之前的是标志字母，之后的是**取值**（贴着的，或在下一个词里）。
  function shortFlagWalk(word, valueLetters) {
    const text = String(word);
    if (!/^-[^-]/.test(text)) return null;
    const seen = [];
    let valueLetter = null;
    let value = "";
    for (let i = 1; i < text.length; i += 1) {
      const ch = text[i];
      if (valueLetter !== null) {
        value += ch;
        continue;
      }
      if (valueLetters.includes(ch)) {
        valueLetter = ch;
        continue;
      }
      // 不是字母：簇到此为止（`wget -qO-` 的尾横线不是标志字母）。
      if (!/[A-Za-z]/.test(ch)) break;
      seen.push(ch);
    }
    return { seen, valueLetter, value };
  }

  function isWriteMethod(value) {
    return value !== undefined && !READ_METHODS.has(String(value).toUpperCase());
  }

  // ---- 简单赋值：让 `ep="repos/o/r/check-runs"` 与 `F="-d @body.json"` 也看得见 ----
  // 单趟、不递归、上限 32 个。值里带 `$` 或反引号的（下一跳还要展开）不收：
  // 收下来就是假的可判形态，而这张判据宁可落回「端点不可判 → 默认拒绝」。
  const MAX_ASSIGNMENTS = 32;
  // 赋值前缀不止 export：readonly / declare / typeset / local 是同一个「写进变量」的语义；
  // declare -x / readonly -a 的短标志要跳过去；段首的 `(` 与 `{` 是子 shell / 命令组，剥掉再看。
  const ASSIGNMENT_PREFIX = /^\s*[({]?\s*(?:export|readonly|declare|typeset|local)\s+(?:-[A-Za-z]+\s+)*([A-Za-z_][A-Za-z0-9_]*)=(.*)$/;
  const ASSIGNMENT_PLAIN = /^\s*[({]?\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)$/;
  // `printf -v NAME FORMAT VALUE` 是第三个写变量的门，值取最后一个词。
  const ASSIGNMENT_PRINTF = /^\s*[({]?\s*printf\s+(?:-[A-Za-z]+\s+)*-v\s+([A-Za-z_][A-Za-z0-9_]*)(?:\s|$)/;

  // 同一行里的 `F="-d @body.json"; curl $F …`：shell 语义下未加引号的 `;` 就是命令结尾，
  // 所以赋值的值在第一个裸 `;` 处切断 —— 这既不让值被后半行污染，也不放宽任何东西。
  function cutAtShellSeparator(value) {
    let quote = "";
    for (let index = 0; index < value.length; index += 1) {
      const char = value[index];
      if (quote) {
        if (char === quote) quote = "";
        continue;
      }
      if (char === '"' || char === "'") {
        quote = char;
        continue;
      }
      if (char === ";") return value.slice(0, index);
    }
    return value;
  }

  // 逻辑行里的命令段：shell 语义下未加引号的 `;` / `&&` / `||` 都是命令结尾，
  // 赋值只是**段首**那个词，不是物理行首（review-a r20-a-4 实测：`echo hi; B=…; gh api … $B`）。
  function shellSegments(line) {
    const segments = [];
    let quote = null;
    let current = "";
    for (let i = 0; i < line.length; i += 1) {
      const ch = line[i];
      if (quote) {
        current += ch;
        if (ch === quote) quote = null;
        continue;
      }
      if (ch === "\\") {
        current += ch + (line[i + 1] ?? "");
        i += 1;
        continue;
      }
      if (ch === '"' || ch === "'") {
        quote = ch;
        current += ch;
        continue;
      }
      if (ch === ";" || ((ch === "&" || ch === "|") && line[i + 1] === ch)) {
        segments.push(current);
        current = "";
        if (ch !== ";") i += 1;
        continue;
      }
      current += ch;
    }
    segments.push(current);
    return segments;
  }

  // 一个命令段里的赋值记录：前缀赋值（export/readonly/declare/typeset/local）、裸赋值、
  // 以及 printf -v NAME FMT VALUE。认不出返回 null —— 不猜。
  function assignmentRecord(segment) {
    const prefixed = ASSIGNMENT_PREFIX.exec(segment);
    if (prefixed) return { name: prefixed[1], raw: prefixed[2] };
    const plain = ASSIGNMENT_PLAIN.exec(segment);
    if (plain) return { name: plain[1], raw: plain[2] };
    const printed = ASSIGNMENT_PRINTF.exec(segment);
    if (printed) {
      const words = shellWords(segment);
      return { name: printed[1], raw: words.length > 0 ? String(words[words.length - 1]) : "" };
    }
    return null;
  }

  function simpleAssignments(text) {
    const map = new Map();
    // 表里收不下的名字要**响**，不能当成没有赋值：
    //   - 值只是一个变量引用（`B=$A`）→ 一跳跟过去；跟不动就记 unresolved，引用到它时默认拒绝；
    //   - 值里带命令替换（`F="$(cat body.json)"`）→ 静态层不展开，也不冒充可判形态（不落表）；
    //   - 超过上限 → 记 truncated。
    // 静默丢弃赋值等于静默丢弃写意图（review-a r20-a-2 / r20-a-3 实测全绿）。
    map.unresolved = new Set();
    map.truncated = false;
    for (const raw of foldContinuations(String(text)).split("\n").map(stripShellComment)) {
      for (const segment of shellSegments(raw)) {
        const record = assignmentRecord(segment);
        if (!record) continue;
        const name = record.name;
        // 先定义先赢：同一个名字多处赋值时不猜后一处覆盖了谁（歧义就往「看得见」的那侧留）。
        if (map.has(name) || map.unresolved.has(name)) continue;
        if (map.size >= MAX_ASSIGNMENTS) {
          map.truncated = true;
          continue;
        }
        // 段尾的 `)` / `}` 是命令组的收尾，不是取值的一部分（`( F=… )` 的右括号）。
        const value = unquote(cutAtShellSeparator(record.raw).trim().replace(/[\s)}]+$/, ""));
        if (!value) continue;
        const alias = /^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?$/.exec(value);
        if (alias) {
          if (map.has(alias[1])) map.set(name, map.get(alias[1]));
          else map.unresolved.add(name);
          continue;
        }
        if (/[$\x60]/.test(value)) continue;
        map.set(name, value);
      }
    }
    return map;
  }

  // 外层行的赋值表 + 命令替换正文里自己写的赋值（内层覆盖外层，与 shell 的执行顺序一致）。
  function mergeAssignmentMaps(outer, inner) {
    const map = new Map(outer ?? []);
    map.unresolved = new Set(outer?.unresolved ?? []);
    map.truncated = Boolean(outer?.truncated);
    for (const [name, value] of inner ?? []) map.set(name, value);
    for (const name of inner?.unresolved ?? []) map.unresolved.add(name);
    if (inner?.truncated) map.truncated = true;
    return map;
  }

  function expandAssignments(text, assignments) {
    if (!assignments || assignments.size === 0) return String(text);
    return String(text).replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (whole, braced, plain) => {
      const name = braced ?? plain;
      return assignments.has(name) ? assignments.get(name) : whole;
    });
  }

  // ---- 命令头的动态成分：'gh$E' / '$(echo gh)' / '$GH_CLI' ----
  // 命令头必须是**字面量**才被 HTTP_CLIENTS / SHELL_INTERPRETERS 认出来，于是「把命令头写成
  // 展开结果」这一族整条命令消失（实测：'gh$E api …/check-runs -X PATCH' 173 条全绿，把 gh$E
  // 换成 gh 就红 8 条；shell 里 'E=; printf %s gh$E' 输出的正是 gh）。
  // 静态层解不出展开结果，但没有理由静默跳过：疑似的动态命令头落 overflow（新 kind
  // dynamic-head）—— checkRunWriteSurface 已有「overflow 非空即判写面」的规则，响而不丢。
  const DYNAMIC_PART = /[$\x60]/;
  const WHOLE_DYNAMIC_VAR = /^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?$/;
  // 变量名里的词元：GH_CLI / CURL / GITHUB_API 都是「这个变量装着一个 http 客户端」。
  // 按词元判而不是按整名枚举，是因为拼写会变；'$GITHUB_REPOSITORY' 解释成词元 GITHUB 但
  // 它从不出现在命令头位置，所以这条只在段首收。
  const DYNAMIC_HEAD_NAME_TOKENS = new Set(['GH', 'GITHUB', 'CURL', 'WGET', 'HTTP', 'HTTPS', 'HTTPIE', 'XH', 'CLI']);
  // 调用实参的样子：api / 短长标志 / URL。后面不跟调用实参的动态词不是调用，不在这里响。
  const DYNAMIC_CALL_ARGUMENT = /^(?:api\b|-\S|https?:\/\/|\S*\.github)/;

  // 词里的动态成分全删掉后剩下什么：'gh$E' → 'gh'，'$(echo gh)' → ''，
  // 'repos/$GITHUB_REPOSITORY/check-runs' → 'repos//check-runs'。
  function dynamicHeadSkeleton(word) {
    return String(word)
      .replace(/\x60[^\x60]*\x60/g, "")
      .replace(/\$\([^)]*\)/g, "")
      .replace(/\$\{[^}]*\}/g, "")
      .replace(/\$[A-Za-z_][A-Za-z0-9_]*/g, "");
  }

  // 一个词能不能被认成 names 里的某个客户端（动态成分当通配）：命中返回它，否则 null。
  function dynamicHeadWord(word, next, names, atSegmentStart) {
    const head = String(word).replace(/^.*\//, "");
    if (!DYNAMIC_PART.test(head)) return null;
    const nextText = String(next ?? "");
    if (!DYNAMIC_CALL_ARGUMENT.test(nextText)) return null;
    const skeleton = dynamicHeadSkeleton(head);
    if (names.has(skeleton)) {
      // gh 只有 'gh api' 是 http 调用：动态头同样按这条收，'gh$E pr view' 不是调用。
      if (skeleton !== "gh" || /^api\b/.test(nextText)) return head;
      return null;
    }
    const variable = WHOLE_DYNAMIC_VAR.exec(head);
    if (!variable || !atSegmentStart) return null;
    const tokens = variable[1].toUpperCase().split("_");
    return tokens.some((token) => DYNAMIC_HEAD_NAME_TOKENS.has(token)) ? head : null;
  }

  // 命令头本身是命令替换 / 反引号：'$(echo gh) api …' / '`echo gh` api …'。
  // shellWords 把它切成 '$' '(' … ')' 的碎片，客户端名躺在中间那个词上 —— 只看词序列看不见。
  // 这里在**原文**上认：命令位上的替换，正文里有一个词就是客户端名，后面跟着调用实参。
  const HEAD_SUBSTITUTION = /(?:^|[;&|\n(]\s*)(?:\$\(([^)]*)\)|\x60([^\x60]*)\x60)/g;
  function dynamicSubstitutionHeads(text, names) {
    const hits = [];
    for (const match of String(text).matchAll(HEAD_SUBSTITUTION)) {
      const body = match[1] ?? match[2] ?? "";
      const produced = shellWords(stripShellComment(body)).map((word) => String(word).replace(/^.*\//, ""));
      if (!produced.some((word) => names.has(word))) continue;
      const rest = String(text)
        .slice(match.index + match[0].length)
        .split("\n")[0]
        .replace(/^[\s;&|]+/, "");
      if (!DYNAMIC_CALL_ARGUMENT.test(rest)) continue;
      hits.push(match[0].trim());
    }
    return hits;
  }
  // ---- 解释器包装：`bash -c '…'` 与 `eval '…'` 的实参还是命令序列 ----
  // 整条命令外面套一层引号程序就能把写面藏起来（旧判据只看外层词：裸写 8 红、bash -c 0 红）。
  // 与命令替换正文同一套处理：递归看，深度上限 3，超限的落 overflow —— 响，不静默丢。
  const SHELL_INTERPRETERS = new Set(["bash", "sh", "zsh", "dash", "ksh", "ash"]);
  const SHELL_C_FLAG = /^-[A-Za-z]*c$/;
  // 别的语言的 -c / -e 内联正文：静态层不解别的语言，但「里面提到结论写面」必须响，
  // 不能因为读不懂就当成没写。
  const NON_SHELL_INLINE = new Set(["python", "python2", "python3", "perl", "ruby", "php", "node", "nodejs", "deno"]);
  const NON_SHELL_CODE_FLAGS = new Set(["-c", "-e", "-E", "-r", "-p", "--eval", "--print"]);

  // 命令词序列里的「程序字符串」：eval 的全部实参、shell 解释器 -c 之后的那个词。
  function wrapperCommandBodies(text, overflow) {
    const bodies = [];
    for (const words of shellCommands(text)) {
      for (let i = 0; i < words.length; i += 1) {
        const head = String(words[i] ?? "").replace(/^.*\//, "");
        const rest = words.slice(i + 1);
        if (head === "eval") {
          const body = rest.join(" ").trim();
          if (body) bodies.push(body);
          continue;
        }
        if (!SHELL_INTERPRETERS.has(head)) {
          // 解释器头是动态的（'bash$E -c …'）：head 认不出，整段正文就消失。
          // 正文看得见（-c 后面那个词）且它提到结论写面 → 落 overflow，并且正文照旧按
          // 解释器处理（里面那次调用逐次判，不靠猜拼写）。
          if (dynamicHeadWord(words[i], words[i + 1], SHELL_INTERPRETERS, i === 0) !== null) {
            const atBody = rest.findIndex((word) => SHELL_C_FLAG.test(String(word)));
            const body = atBody === -1 ? "" : rest.slice(atBody + 1).join(" ").trim();
            if (body && CHECK_RUNS_ENDPOINT.test(body)) {
              overflow?.push({ kind: "dynamic-head", text: body });
              bodies.push(body);
            }
          }
          continue;
        }
        const at = rest.findIndex((word) => SHELL_C_FLAG.test(String(word)));
        if (at === -1) continue;
        const body = rest.slice(at + 1).join(" ").trim();
        if (body) bodies.push(body);
      }
    }
    return bodies;
  }

  // 非 shell 解释器的内联正文里出现结论写面字样：读不懂的语言也是写面，落 gap。
  function interpreterGaps(text) {
    const gaps = [];
    for (const words of shellCommands(text)) {
      for (let i = 0; i < words.length; i += 1) {
        const head = String(words[i] ?? "").replace(/^.*\//, "");
        // 解释器头是动态的（'python$E -c …'）时内联程序照样看得见：不静默跳过，
        // kind 点明头是动态的，理由才不会指向「读不懂的语言」。
        const dynamic = dynamicHeadWord(words[i], words[i + 1], NON_SHELL_INLINE, i === 0) !== null;
        if (!dynamic && !NON_SHELL_INLINE.has(head)) continue;
        let at = -1;
        let inline = "";
        for (let k = i + 1; k < words.length; k += 1) {
          const word = String(words[k]);
          const name = word.split("=")[0];
          if (!NON_SHELL_CODE_FLAGS.has(name)) continue;
          at = k;
          inline = word.includes("=") ? word.slice(word.indexOf("=") + 1) : "";
          break;
        }
        if (at === -1) continue;
        const program = [inline, ...words.slice(at + 1)].join(" ").trim();
        if (!CHECK_RUNS_ENDPOINT.test(program)) continue;
        gaps.push({ kind: dynamic ? "dynamic-head" : "non-shell-inline", text: program });
      }
    }
    return gaps;
  }

  // 一次 http 客户端调用：head 是客户端名，words 是（赋值展开后的）词序列，map 是**那一层**
  // 的赋值表。端点判定必须以「这次调用」为单位，否则同行另一个良性 URL 就能把不可判的
  // 端点洗白（review-b 实测：`curl … https://hooks.slack.com/x "$EP"` 全绿）。
  function httpCalls(line, assignments) {
    const outer = assignments ?? new Map();
    const calls = [];
    // 跟不下去的正文（命令替换 / 解释器包装超过深度上限、别的语言里的内联程序）不静默丢。
    calls.overflow = [];
    // 递归：赋值展开后的正文 → 命令替换正文 → 解释器包装正文，三者同一套深度上限。
    const visit = (text, map, depth) => {
      if (depth > MAX_SUBSTITUTION_DEPTH) {
        calls.overflow.push({ kind: "depth", text: String(text) });
        return;
      }
      const expanded = expandAssignments(String(text), map);
      for (const words of shellCommands(expanded)) {
        if (words.length === 0) continue;
        // 客户端不一定在第 0 个词：workflow 里的行常带 YAML 前缀（`- run: gh api …`、
        // `- run: |` 的正文）与赋值前缀（`id=$(gh api …)`）。按词扫，别按位置猜。
        for (let start = 0; start < words.length; start += 1) {
          const head = String(words[start] ?? "").replace(/^.*\//, "");
          if (!HTTP_CLIENTS.has(head)) {
            // 命令头不是字面量（'gh$E api …' / '$GH_CLI api …'）：静态层解不出展开结果，
            // 但也没有理由静默跳过 —— 落 overflow，由写面判据响（F1）。
            if (dynamicHeadWord(words[start], words[start + 1], HTTP_CLIENTS, start === 0) !== null) {
              calls.overflow.push({ kind: "dynamic-head", text: words.join(" ") });
            }
            continue;
          }
          // gh 只有 `gh api` 是 http 调用（gh pr view --json 是读，不在这条面上）。
          if (head === "gh" && String(words[start + 1] ?? "") !== "api") continue;
          calls.push({ head, words, start, map });
        }
      }
      // 命令头本身是命令替换 / 反引号时词序列里只剩碎片，得回原文认（F1 同族）。
      for (const names of [HTTP_CLIENTS, SHELL_INTERPRETERS]) {
        for (const hit of dynamicSubstitutionHeads(expanded, names)) {
          calls.overflow.push({ kind: "dynamic-head", text: hit });
        }
      }
      // 正文里的简单赋值同样要看得见：`x="$( F="…"; gh api … $F )"`（review-a r20-a-4 实测）。
      for (const body of substitutionBodies(expanded)) {
        visit(body, mergeAssignmentMaps(outer, simpleAssignments(body)), depth + 1);
      }
      for (const body of wrapperCommandBodies(expanded, calls.overflow)) {
        visit(body, mergeAssignmentMaps(map, simpleAssignments(body)), depth + 1);
      }
      for (const gap of interpreterGaps(expanded)) calls.overflow.push(gap);
    };
    visit(String(line), outer, 0);
    return calls;
  }

  function httpWriteCalls(line, assignments) {
    return httpCalls(line, assignments).filter((call) => commandWriteIntentAt(call.head, call.words, call.start));
  }

  function commandWriteIntent(line, assignments) {
    return httpWriteCalls(line, assignments).length > 0;
  }

  // httpie 的体是**独立成词的** k=v / k:=v；k==v 是查询参数（读），Header:value 与 URL 里的
  // ?a=1 都不是体。旧判据 `text.includes("=")` 把 `xh get …/health page==1` 读成写（实测 6 红）。
  const HTTPIE_BODY_WORD = /^[A-Za-z0-9_.-]+:?=(?!=)/;

  function commandWriteIntentAt(head, words, start) {
    const valueLetters = SHORT_VALUE_LETTERS[head] ?? "";
    const bodyLetters = BODY_SHORT_LETTERS[head] ?? "";
    let method = null;
    let getFlag = false;
    let hasBody = false;
    for (let i = start + 1; i < words.length; i += 1) {
      const word = String(words[i]);
      const long = longFlagName(word);
      if (long !== null) {
        const at = word.indexOf("=");
        const value = at >= 0 ? word.slice(at + 1) : words[i + 1];
        if (long === "--method" || long === "--request") {
          method = value;
          continue;
        }
        if (long === "--get") {
          getFlag = true;
          continue;
        }
        if (BODY_LONG_FLAGS.has(long)) hasBody = true;
        continue;
      }
      const walk = shortFlagWalk(word, valueLetters);
      if (!walk) continue;
      if (walk.seen.includes("G")) getFlag = true;
      const value = walk.value !== "" ? walk.value : words[i + 1];
      // -X / --request 是方法（curl / gh 的方言）：值可以贴（-Xpatch / -sXPATCH）也可以分开。
      if (walk.valueLetter === "X") {
        method = value;
        continue;
      }
      if (walk.valueLetter !== null && bodyLetters.includes(walk.valueLetter)) hasBody = true;
    }
    // 显式写方法就是写：`-X DELETE` / `--request PATCH` 不靠体标志也成立。
    if (method != null && isWriteMethod(method)) return true;
    // `-G`/`--get` 把 -d 的体翻成查询串：没有写方法时它是只读（`curl -G -d per_page=100`）。
    if (hasBody && !getFlag) return true;
    // httpie：方法词在位置参数里（http POST url name=audit），独立成词的 `k=v` 本身就是体。
    if (HTTPIE_CLIENTS.has(head)) {
      for (const word of words.slice(start + 1)) {
        const text = String(word);
        if (text.startsWith("-")) continue;
        const upper = text.toUpperCase();
        if (READ_METHODS.has(upper)) continue;
        if (HTTP_METHOD_VERBS.has(upper)) return true;
        if (HTTPIE_BODY_WORD.test(text)) return true;
      }
    }
    return false;
  }

  // 只读放行：没有任何写意图。显式只读方法（-X GET / --method GET / -X HEAD）放行 ——
  // 「默认拒绝」拒绝的是写，不是拒绝「写出了方法名」；把纯读读成写会把方向读反。
  function isReadOnlyApiCall(text, assignments) {
    return !commandWriteIntent(text, assignments);
  }

  // REST 的 checks.create（octokit / github-script 的 github.rest.checks.create）与 REST 的
  // createCheckRun 是同一个写面，只是拼写藏在 `with: script:` 里。
  // checks.update / updateCheckRun / PATCH check-runs/{id} 是同一个写面的改写形态。
  const CHECKS_CREATE_CALL =
    /(?:\bchecks\s*\.\s*(?:create|update)|\b(?:create|update)CheckRun\b|\[\s*["']checks["']\s*\]|check-runs\s*\/\s*\{)/;

  // 结论写面违规的三种原因后缀：都以老句子为前缀（既有断言断言这句），后缀负责分辨
  // 「写形态」「写形态但端点不是字面量（命令级默认拒绝）」「不可判形态」——
  // 纯读被拦时文案不能把方向指反（旧文案把 `-X GET` 说成 --input POST 的写面）。
  const CHECK_RUNS_REASON = "check-runs 只能是那两步的 --input POST，或自证步的两次只读回读";
  const CHECK_RUNS_REASON_WRITE = CHECK_RUNS_REASON + "（原因：写形态 —— 方法 / 请求体 / 字段 / 输入）";
  const CHECK_RUNS_REASON_WRITE_BLIND =
    CHECK_RUNS_REASON + "（原因：写形态 —— 方法 / 请求体 / 字段 / 输入；端点不是字面量，按命令级默认拒绝）";
  const CHECK_RUNS_REASON_UNKNOWN =
    CHECK_RUNS_REASON + "（原因：不可判形态 —— 端点不是放行的回读形态，也看不出写意图）";

  function checkRunReason(line, writeIntent) {
    if (!writeIntent) return CHECK_RUNS_REASON_UNKNOWN;
    return CHECK_RUNS_ENDPOINT.test(String(line)) ? CHECK_RUNS_REASON_WRITE : CHECK_RUNS_REASON_WRITE_BLIND;
  }

  // 这一次调用的事实：端点词、解析结果、写意图。写面判据与豁免判据共用一份，
  // 免得「端点在哪」被两处各读一遍、各读出一个答案。
  function callState(call) {
    const words = callEndpointWords(call);
    return {
      call,
      words,
      endpoints: words.map((word) => resolveEndpoint(word, call.head === "gh")),
      writeIntent: commandWriteIntentAt(call.head, call.words, call.start),
    };
  }

  // 端点解析成功且落在结论写面上（字面量、可判的那种）。
  function onCheckRunSurface(endpoint) {
    return endpoint !== null && endpoint.host === GITHUB_API_HOST && CHECK_RUNS_IN_PATH.test(endpoint.path);
  }

  // 这一次调用的端点词本身带着「只读回读」形态（计数回读 / 单条回读）—— 可证明的读。
  function isReadBackWord(word) {
    const text = String(word).replace(/["']/g, "");
    return CHECK_RUNS_READ_LIST.test(text) || CHECK_RUNS_READ_ONE.test(text);
  }

  // 这一次调用摸到结论写面了吗？「端点不可判」也算摸到：不可判是「不能证明它没写」。
  function callOnCheckRunSurface(state) {
    if (state.writeIntent && (state.endpoints.length === 0 || state.endpoints.some((endpoint) => endpoint === null))) {
      return true;
    }
    if (state.endpoints.some(onCheckRunSurface)) return true;
    return state.words.some((word, index) => state.endpoints[index] === null && CHECK_RUNS_ENDPOINT.test(String(word)));
  }

  // 白名单只覆盖**它自己那一次调用**：法方法与载体必须是这一次调用自己带着的。
  function callSanctioned(name, state) {
    const call = state.call;
    const text = call.words.slice(call.start).join(" ");
    // 唯一放行的写形态：POST + --input 载体（那两步）。方法按归一化后判，
    // `--method post` 与 `--method POST` 是同一个方法。
    if (CHECK_RUNS_POST_STEPS.includes(name)) {
      return call.head === "gh" && ghApiMethod(text) === "POST" && CHECK_RUNS_INPUT.test(text);
    }
    if (!CHECK_RUNS_READ_STEPS.includes(name)) return false;
    // 自证步：两个只读回读形态。写形态一律默认拒绝（不枚举拼写）。
    if (state.writeIntent) return false;
    return state.words.some(isReadBackWord);
  }

  // 文本级白名单：没有任何一次 http 调用摸到这个面时（提示文案、说明行）没有「这一次调用」
  // 可以逐次判，沿用老口径 —— 换单位不是把文案行变成违规。
  function sanctionedText(name, text, assignments) {
    if (CHECK_RUNS_POST_STEPS.includes(name)) return ghApiMethod(text) === "POST" && CHECK_RUNS_INPUT.test(text);
    return (
      CHECK_RUNS_READ_STEPS.includes(name) &&
      (CHECK_RUNS_READ_LIST.test(text) || CHECK_RUNS_READ_ONE.test(text)) &&
      isReadOnlyApiCall(text, assignments)
    );
  }

  // check-runs 端点在 audit.yml 内的合法形态只有两种：
  //   1) 那两步的 --input .audit/check-run.json POST；
  //   2) 自证步的 head_sha 回读（只读，不带写形态）。
  // 豁免的判定单位是**这一次调用**：同一行里追一条 check-runs 写不共享前一条的豁免
  // （按整行判时，放行的 POST 后面再追加一条写，detector 0 红）。
  // 「看不见调用，但这段文字自己被判成写面」：states 空不等于没有写面。
  // 白名单步里追加一条 '&& gh$E api …/check-runs -X PATCH -f conclusion=success' 时，
  // shellCommands 看不见这次调用 → states 空 → 老的 sanctionedText 直接放行，于是同一文件
  // 两个判据自相矛盾（auditDirReferenceViolations 0 违规，checkRunWriteSurface 却答 'check-runs'）。
  function textJudgedWriteSurface(text, assignments) {
    if (checkRunWriteSurface(text, assignments) !== null) return true;
    return CHECK_RUNS_ENDPOINT.test(text) && commandWriteIntent(text, assignments);
  }

  function checkRunSanctioned(name, line, assignments) {
    const text = String(line);
    const map = assignments ?? simpleAssignments(text);
    const calls = httpCalls(text, map);
    const states = calls.map((call) => callState(call)).filter((state) => callOnCheckRunSurface(state));
    // 跟不下去的正文（动态命令头 / 深度上限 / 别的语言内联程序）里可能有调用 —— 看不见就不豁免。
    if (calls.overflow.length > 0) return false;
    if (states.length === 0) {
      if (textJudgedWriteSurface(text, map)) return false;
      return sanctionedText(name, text, map);
    }
    return states.every((state) => callSanctioned(name, state));
  }

  // ---- 端点三态：结论写面是「端点 + 写形态」，不是「任意端点上的任意 http 写」 ----
  //   1) 字面量命中 check-runs / graphql → 结论写面；
  //   2) 端点不可判（变量 / 拼接 / 命令替换 / 根本没有端点词）→ 默认拒绝：写意图本身就是响的理由；
  //   3) 端点字面量且明确不是 GitHub 的写面（别的 host，或 gh api 的别条路径）→ 不是结论写面。
  // 旧判据只有 1+2：兄弟 workflow 里 `curl -X POST https://hooks.slack.com/…` 与
  // `gh api repos/o/r/issues/1/comments -f body=hi` 都被读成「第二条 Check Run 会盖掉真结论」（实测 6 红）。
  const GITHUB_API_HOST = "api.github.com";
  const CHECK_RUNS_IN_PATH = /\b(?:check-runs|graphql)\b/;

  // 端点一律从 shellWords 展开后的**词**里取：shell 会把相邻的引号段与裸段拼成一个词，
  // 原始文本正则按引号截断，`"…/check-"runs` 于是只取到 `…/check-`（review-b 实测全绿放行）。
  const URL_WORD = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//;
  const WHOLE_VAR = /^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?$/;
  // gh api 里带取值的标志：它们后面那个词是值，不是端点。
  const GH_VALUE_FLAGS = new Set([
    "--method",
    "-X",
    "--input",
    "-f",
    "-F",
    "--field",
    "--raw-field",
    "--header",
    "-H",
    "--jq",
    "-q",
    "--template",
    "--cache",
    "--hostname",
    "--preview",
    "--json",
  ]);

  // 这一次调用里的端点候选词（未解析）。gh api 取位置参数；其它客户端取 URL 词与整词变量。
  function callEndpointWords(call) {
    const words = call.words;
    const endpoints = [];
    if (call.head !== "gh") {
      for (let i = call.start + 1; i < words.length; i += 1) {
        const word = String(words[i]);
        if (URL_WORD.test(word) || word.includes("://") || WHOLE_VAR.test(word)) endpoints.push(word);
      }
      return endpoints;
    }
    let index = call.start + 2; // 跳过 `gh api`
    while (index < words.length) {
      const word = String(words[index]);
      if (word.startsWith("-")) {
        // 取值标志把它后面那个词吃掉；`--flag=value` 自带值，只前进一个词。
        const name = longFlagName(word) ?? word;
        index += word.includes("=") || !GH_VALUE_FLAGS.has(name.toLowerCase()) ? 1 : 2;
        continue;
      }
      endpoints.push(word);
      index += 1;
    }
    return endpoints;
  }

  // 端点解析：不可判（变量 / 命令替换 / 空 host）返回 null —— null 是「不可判」，不是「不是写面」。
  function resolveEndpoint(word, ghPath) {
    // 相邻的引号段在 shell 里是**一个**词：`"…/check-""runs"` 就是 `…/check-runs`。
    // 端点词里剩下引号时先去掉再判路径 —— 否则端点看得见、判据看不见（reviewer 实测 0 红）。
    const text = String(word).replace(/["']/g, "");
    if (/[$\x60]/.test(text)) return null;
    const at = text.indexOf("://");
    if (at >= 0) {
      const rest = text.slice(at + 3);
      const slash = rest.indexOf("/");
      const host = (slash === -1 ? rest : rest.slice(0, slash)).toLowerCase();
      if (!host) return null;
      return { host, path: slash === -1 ? "" : rest.slice(slash) };
    }
    if (!ghPath) return null;
    return { host: GITHUB_API_HOST, path: text };
  }

  // 实参引用了「跟不下去」的赋值时的默认拒绝理由：赋值表既收不下也丢不得，
  // 静默丢弃等于静默丢弃写意图（review-a r20-a-2 / r20-a-3 实测全绿）。
  const ASSIGNMENT_UNRESOLVED_REASON =
    CHECK_RUNS_REASON + "（原因：赋值跟不下去 —— 值里含变量或命令替换，静态层展开不了，按命令级默认拒绝）";
  const ASSIGNMENT_TRUNCATED_REASON =
    CHECK_RUNS_REASON + "（原因：赋值表已截断，跟不下去 —— 按命令级默认拒绝）";

  function blindAssignmentArg(call) {
    const map = call.map;
    if (!map) return null;
    for (let i = call.start + 1; i < call.words.length; i += 1) {
      const match = WHOLE_VAR.exec(String(call.words[i]));
      if (!match) continue;
      if (map.unresolved?.has(match[1])) return { kind: "unresolved", name: match[1] };
      if (map.truncated && !map.has(match[1])) return { kind: "truncated", name: match[1] };
    }
    return null;
  }

  // 窄化守卫用的同一件事，但跳过重定向目标：`gh api …/check-runs > "$runs_file"` 里的
  // `$runs_file` 是文件，不是实参。
  function blindArgumentWord(call) {
    const map = call.map;
    if (!map) return null;
    let redirect = false;
    for (let i = call.start + 1; i < call.words.length; i += 1) {
      const word = String(call.words[i]);
      if (redirect) {
        redirect = false;
        continue;
      }
      if (/^[0-9]?>>?$/.test(word) || word === "<") {
        redirect = true;
        continue;
      }
      const match = WHOLE_VAR.exec(word);
      if (!match) continue;
      if (map.unresolved?.has(match[1])) return word;
      if (map.truncated && !map.has(match[1])) return word;
    }
    return null;
  }

  function blindAssignmentReason(line, assignments) {
    for (const call of httpCalls(line, assignments ?? simpleAssignments(String(line)))) {
      const blind = blindAssignmentArg(call);
      if (!blind) continue;
      return blind.kind === "truncated" ? ASSIGNMENT_TRUNCATED_REASON : ASSIGNMENT_UNRESOLVED_REASON;
    }
    return null;
  }

  function checkRunWriteSurface(line, assignments) {
    // 端点也按赋值展开后判：没把整份载荷的赋值表传进来时，至少看得见这一行自己写的
    // `U="https://…/x"; curl $U …` —— 否则良性端点会掉进「不可判」那档被误拒。
    const raw = String(line);
    const map = assignments ?? simpleAssignments(raw);
    const text = expandAssignments(raw, map);
    if (CHECKS_CREATE_CALL.test(text)) return "checks.create";
    // gh api graphql 与 https://api.github.com/graphql 是同一个端点，写法不同不改面。
    if (/\bgraphql\b/.test(text)) return "/graphql";
    // 判定单位是**这一次 http 调用**：同行另一个良性 URL 洗不白这次调用的未知端点（review-b 实测）。
    const calls = httpCalls(raw, map);
    // 跟不下去的正文（命令替换 / 解释器包装超过深度上限、别的语言里的内联程序）：响，不静默丢。
    if (calls.overflow.length > 0) return "check-runs";
    for (const call of calls) {
      const state = callState(call);
      if (!state.writeIntent) {
        // 窄化守卫：端点**看得见**并且在写面上，实参里又有跟不下去的赋值 ——
        // 「这一次是只读回读」证明不了，按命令级默认拒绝。
        // 只装在「端点可判 + 落在面上」这一档里，不是装回函数顶部：良性字面量端点
        // （别的 host / 别的路径）与容器里的回读形态都还在放行。
        if (
          state.endpoints.some(onCheckRunSurface) &&
          !state.words.some(isReadBackWord) &&
          blindArgumentWord(call) !== null
        ) {
          return "check-runs";
        }
        continue;
      }
      // 端点不可判（变量 / 拼接 / 命令替换 / 根本没有端点词）→ 默认拒绝。
      if (state.endpoints.length === 0 || state.endpoints.some((endpoint) => endpoint === null)) return "check-runs";
      // 字面量端点且明确不是结论写面（别的 host，或 gh api 的别条路径）→ 这一次调用不是写面。
      if (state.endpoints.some(onCheckRunSurface)) return "check-runs";
    }
    return null;
  }

  function workflowFiles(options = {}) {
    const root = options.root ?? ROOT;
    const dir = join(root, WORKFLOW_DIR);
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((name) => /\.ya?ml$/.test(name))
      .sort();
  }

  // workflow 入口的判定单位是**解析出来的载荷文本**，不是物理行（F2）。
  // 物理行只是排版：YAML 折叠标量 'run: >-' 交给 shell 的是**一条**命令，'|' 块正文的字节
  // 就是脚本，'with'/'env' 的叶子也是执行面。按物理行判时端点行没有写形态、写形态行没有
  // 端点，两半都放过（实测 0 红），而按解析出的 steps 判的 auditDirReferenceViolations 对
  // 同一文件报 1 条 —— 两个入口对同一份文件自相矛盾。
  function workflowPayloadTexts(file, root) {
    const source = readFileSync(join(root, WORKFLOW_DIR, file), "utf8");
    let doc = null;
    try {
      doc = YAML.parse(source);
    } catch {
      doc = null;
    }
    const structured = doc && typeof doc === "object" && doc.jobs && typeof doc.jobs === "object";
    // 解析不了就没有结构可判：回落到整份文本 —— 判不了不等于没有写面。
    if (!structured) return [source];
    const texts = [];
    for (const job of Object.values(doc.jobs)) {
      if (!job || typeof job !== "object") continue;
      const payloads = [...jobPayloads(job, doc)];
      for (const step of Array.isArray(job.steps) ? job.steps : []) payloads.push(...stepPayloads(step));
      for (const payload of payloads) texts.push(payload.text);
    }
    // 一份 workflow 的载荷全空（结构里没有可判文本）时同样回落整份文本，避免「没载荷 = 没写面」。
    return texts.length > 0 ? texts : [source];
  }

  // 载荷文本按行剔掉 shell 注释：'|' 块里的 # 是 shell 注释，YAML 层面的注释解析时已经被 YAML 摘掉了。
  function payloadSurfaceText(text) {
    return foldContinuations(text)
      .split("\n")
      .map((line) => stripShellComment(line))
      .join("\n");
  }

  // 命中结论写面的文件清单（含 audit.yml）。用它断言「只有 audit.yml」。
  function workflowWriteSurfaceFiles(options = {}) {
    const root = options.root ?? ROOT;
    return workflowFiles({ root }).filter((file) => {
      const assignments = simpleAssignments(readFileSync(join(root, WORKFLOW_DIR, file), "utf8"));
      return workflowPayloadTexts(file, root).some(
        (text) => checkRunWriteSurface(payloadSurfaceText(text), assignments) !== null,
      );
    });
  }

  // 除 audit.yml 外任何 workflow 写结论都是违规：scripts/merge-gate.mjs 按 name 取 id 最新，
  // 不钉来源/app，第二条同名结论会盖掉真结论。
  function workflowWriteSurfaceViolations(options = {}) {
    const root = options.root ?? ROOT;
    const files = options.files ?? workflowFiles({ root });
    const violations = [];
    const seen = new Set();
    for (const file of files) {
      if (file === "audit.yml") continue;
      const assignments = simpleAssignments(readFileSync(join(root, WORKFLOW_DIR, file), "utf8"));
      // 逐个载荷判（run / shell / working-directory / with.* / env.* / job 级载体），
      // 与 auditDirReferenceViolations 用同一个单位：解析后的那一份文本。
      for (const text of workflowPayloadTexts(file, root)) {
        const payload = payloadSurfaceText(text);
        for (const rawLine of payload.split("\n")) {
          const line = rawLine;
          const surface = checkRunWriteSurface(line, assignments);
          if (!surface) continue;
          const key = file + "\u0000" + surface + "\u0000" + line.trim();
          if (seen.has(key)) continue;
          seen.add(key);
          violations.push({
            step: file,
            where: surface,
            excerpt: line.trim(),
            reason:
              blindAssignmentReason(line, assignments) ??
              "结论写面只允许 audit.yml：同名的第二条 Check Run 会盖掉真结论（" + file + "）",
          });
        }
      }
    }
    return violations;
  }

  // ---- 按目录树寻址的读取 ----
  // grep -rn needs_revision . 读的是整棵树：字面上既没有 .audit 也没有 result.json，
  // 旧判据全盲。任何非口径层步都能据此分叉，违反「只有口径层能解释结论」。
  const TREE_SEARCH_COMMANDS = new Set(["grep", "egrep", "fgrep", "rg", "ag", "ack", "ack-grep"]);
  // rg/ag/ack 默认递归，grep 系要显式 -r/-R。
  const TREE_RECURSIVE_BY_DEFAULT = new Set(["rg", "ag", "ack", "ack-grep"]);
  const TREE_SEARCH_FLAG = /^-[A-Za-z]*[rR]/;

  function isTreeTarget(token) {
    const value = unquote(String(token ?? ""));
    if (!value) return false;
    // .audit 面已由目录级判据认领，这里只补它看不见的「指到目录」的写法。
    if (value === ".audit" || value.startsWith(".audit/")) return false;
    if (value === "." || value === ".." || value === "/") return true;
    if (value.endsWith("/")) return true;
    if (WILDCARD_CHAR.test(value)) return false;
    // 有扩展名的当文件；没有扩展名的**默认按目录处理**（认不出就判到响的那一侧）。
    return !/\.[A-Za-z0-9]+$/.test(value);
  }

  function treeAddressingReads(line) {
    const hits = [];
    for (const words of shellCommands(line)) {
      const head = (words[0] ?? "").replace(/^.*\//, "");
      const flags = words.slice(1).filter((word) => word.startsWith("-"));
      let command = null;
      let targets = [];
      if (head === "git" && words[1] === "grep") {
        command = "git grep";
        targets = words
          .slice(2)
          .filter((word) => !word.startsWith("-"))
          .slice(1);
      } else if (head === "find") {
        command = "find";
        // find 的操作数是第一个表达式之前的路径，其余是表达式（-name / -exec ...）。
        for (const word of words.slice(1)) {
          if (word.startsWith("-") || word === "(" || word === "!") break;
          targets.push(word);
        }
      } else if (head === "ls") {
        if (!flags.some((word) => /^-[A-Za-z]*R/.test(word) || word === "--recursive")) continue;
        command = "ls -R";
        targets = words.slice(1).filter((word) => !word.startsWith("-"));
      } else if (TREE_SEARCH_COMMANDS.has(head)) {
        if (!TREE_RECURSIVE_BY_DEFAULT.has(head) && !flags.some((word) => TREE_SEARCH_FLAG.test(word))) continue;
        command = head;
        // 第一个非旗标词是 pattern，其后才是路径。
        targets = words
          .slice(1)
          .filter((word) => !word.startsWith("-"))
          .slice(1);
        // rg / ag / ack 不给路径时搜的就是 cwd，等于 "."。
        if (TREE_RECURSIVE_BY_DEFAULT.has(head) && targets.length === 0) targets = ["."];
      } else continue;
      for (const word of targets) {
        if (!isTreeTarget(word)) continue;
        hits.push({ command, target: unquote(word) });
      }
    }
    return hits;
  }

  // ---- 写命令识别要穿透包装词 ----
  // copyWriteTargets 只看每段命令的**首词**：find -exec cp / xargs cp / env cp / sudo cp ...
  // 之下那个 cp 隐形（实测全绿）。包装词之后的那段词同样参与命令词判定。
  const COMMAND_WRAPPERS = new Set(["env", "command", "time", "sudo", "nohup", "nice", "busybox", "xargs", "exec"]);
  const WRAPPER_VALUE_FLAGS = new Set(["-u", "-g", "-n", "-i", "-I", "-L", "-P", "-s", "-d", "-E", "-e", "-a"]);

  function wrappedWriteCommands(line) {
    const found = [];
    for (const words of shellCommands(line)) {
      const head = (words[0] ?? "").replace(/^.*\//, "");
      if (head === "find") {
        const index = words.findIndex((word) => ["-exec", "-execdir", "-ok", "-okdir"].includes(word));
        if (index < 0) continue;
        const nested = words.slice(index + 1);
        found.push({ wrapper: "find -exec", head: (nested[0] ?? "").replace(/^.*\//, ""), words: nested });
        continue;
      }
      if (["bash", "sh", "zsh", "dash"].includes(head)) {
        // 再嵌一层 shell：-c 之后的正文还是命令，穿透一层继续判；穿不透的才轮到 unfollowable。
        const index = words.findIndex((word) => word === "-c");
        if (index >= 0 && words[index + 1])
          for (const nestedWords of shellCommands(words[index + 1]))
            found.push({ wrapper: head + " -c", head: (nestedWords[0] ?? "").replace(/^.*\//, ""), words: nestedWords });
        continue;
      }
      if (!COMMAND_WRAPPERS.has(head)) continue;
      let index = 1;
      while (index < words.length) {
        const word = words[index];
        if (WRAPPER_VALUE_FLAGS.has(word)) {
          index += 2;
          continue;
        }
        if (word.startsWith("-") || /^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) {
          index += 1;
          continue;
        }
        break;
      }
      if (index >= words.length) continue;
      found.push({ wrapper: head, head: (words[index] ?? "").replace(/^.*\//, ""), words: words.slice(index) });
    }
    return found;
  }

  // ---- 按内容落盘 ----
  // tar -xf / unzip -o / cpio -id / patch -i / git apply / git checkout -- <p> / git restore
  // 把包内/补丁里的内容写进工作树，静态层看不出包内有什么（实测把 check-run.json 从
  // conclusion=failure 换成 success 后全绿）。打包（tar -cf）不在此列：它不写工作树。
  function commandWordLists(line) {
    const lists = shellCommands(line);
    for (const nested of wrappedWriteCommands(line)) lists.push(nested.words);
    return lists;
  }

  function contentLandingCommands(line) {
    const hits = [];
    for (const words of commandWordLists(line)) {
      const head = (words[0] ?? "").replace(/^.*\//, "");
      const flags = words.slice(1).filter((word) => word.startsWith("-"));
      const first = words[1] ?? "";
      if (head === "tar") {
        const extracting =
          flags.some((word) => /^-[A-Za-z]*x/.test(word) || word === "--extract" || word === "--get") ||
          (!first.startsWith("-") && /^[A-Za-z]*x[A-Za-z]*$/.test(first));
        if (extracting) hits.push({ command: "tar" });
      } else if (head === "unzip") {
        hits.push({ command: "unzip" });
      } else if (head === "cpio") {
        if (flags.some((word) => /^-[A-Za-z]*i/.test(word))) hits.push({ command: "cpio" });
      } else if (head === "patch") {
        hits.push({ command: "patch" });
      } else if (head === "git") {
        const sub = words[1];
        if (sub === "apply" || sub === "restore") hits.push({ command: "git " + sub });
        else if (sub === "checkout" && words.includes("--")) hits.push({ command: "git checkout --" });
      }
    }
    return hits;
  }

  // 一行文本里出现的 .audit 路径（含父目录、通配、别的文件名）。
  function auditDirPaths(line) {
    const raw = String(line);
    const tokens = [...raw.matchAll(AUDIT_DIR_TOKEN)].map((match) => match[0].replace(/[/\\]+$/, ""));
    if (tokens.length > 0) return tokens;
    return AUDIT_DIR_REF.test(raw) ? [".audit"] : [];
  }

  // 载体的**裸文件名**：只在「这一步的 cwd 就是 .audit」时等价于 .audit/<name>。
  const CARRIER_BARE_NAMES = ["check-run.json", "result.json", "review-a.json", "review-b.json"];

  // 一个 step 实际的工作目录：step 级覆盖 job 级 defaults（job 级覆盖 workflow 级）。
  // 取值从 job 载体里读，与引用判定同一个家，不另开一条通道。
  function stepWorkingDir(step, options = {}) {
    const own = normalizeWorkingDirectory(step?.["working-directory"]);
    if (own !== null) return own;
    return jobWorkingDir(options.jobPayloads ?? []);
  }

  function jobWorkingDir(jobPayloadList) {
    for (const payload of jobPayloadList ?? []) {
      if (payload.carrier !== "defaults.run.working-directory") continue;
      const dir = normalizeWorkingDirectory(payload.text);
      if (dir !== null) return dir;
    }
    return "";
  }

  // cwd 是 .audit 时，run 里的裸载体名就是 .audit/<name>：路径换个写法不该换判定。
  // 前面不能紧邻路径分隔符或词字符 —— `.audit/check-run.json` 已由目录判据认领，
  // 不能因为它同时含裸名而多记一条。
  function bareCarrierPaths(line, cwd) {
    if (cwd !== ".audit") return [];
    const paths = [];
    for (const name of CARRIER_BARE_NAMES) {
      const bare = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      if (new RegExp("(?<![\\w./\\\\-])" + bare).test(line)) paths.push(".audit/" + name);
    }
    return paths;
  }

  // 复制/替换类命令的目标操作数：**另一种写出通道**，不是产出。
  // cp /tmp/pwn.json .audit/check-run.json 与 --out .audit/check-run.json 写的是同一份载体；
  // 只认后者时，写者步里加一行条件分叉 cp（[ "$GITHUB_ACTOR" = attacker ] && cp ...; true）
  // 就绕过了全部载荷断言（实测 110 条全绿）。
  const COPY_WRITE_COMMANDS = new Set(["cp", "mv", "install", "ln", "rsync", "tee"]);

  function copyWriteTargets(line) {
    const targets = [];
    for (const words of shellCommands(line)) {
      const head = (words[0] ?? "").replace(/^.*\//, "");
      if (head === "dd") {
        for (const word of words.slice(1)) if (word.startsWith("of=")) targets.push(unquote(word.slice(3)));
        continue;
      }
      if (!COPY_WRITE_COMMANDS.has(head)) continue;
      const operands = [];
      let dirTarget = null;
      for (let i = 1; i < words.length; i += 1) {
        const word = words[i];
        if (word === "-t" || word === "--target-directory") {
          dirTarget = words[i + 1];
          i += 1;
          continue;
        }
        if (word.startsWith("--target-directory=")) {
          dirTarget = word.slice("--target-directory=".length);
          continue;
        }
        // 旗标与旗标取值不算操作数：cp/mv/install/ln 的目标都是最后一个操作数。
        if (word.startsWith("-") && word !== "-") continue;
        operands.push(unquote(word));
      }
      if (dirTarget) targets.push(unquote(dirTarget));
      else if (operands.length > 0) targets.push(operands[operands.length - 1]);
    }
    return targets;
  }

  // 一个写目标是不是落进 .audit 面（含 cwd=.audit 时的裸载体名）。
  function unclaimedAuditTarget(target, cwd) {
    const value = String(target ?? "").replace(/\/+$/, "");
    if (!value || value.startsWith("/")) return null;
    if (value === ".audit" || value.startsWith(".audit/")) return value;
    if (cwd === ".audit" && CARRIER_BARE_NAMES.includes(value)) return ".audit/" + value;
    return null;
  }

  const WILDCARD_CHAR = /[*?[]/;

  function globSegmentMatches(segment, value) {
    const pattern = segment
      .replace(/[.+^${}()|\\[\]]/g, "\\$&")
      .replace(/\*/g, ".*")
      .replace(/\?/g, ".");
    return new RegExp("^" + pattern + "$").test(value);
  }

  // 通配操作数：把「认不出」判到**响**的那一侧，而不是放过的那一侧。
  // .aud*/res*.json / .aud*/check-run*.json 目录段与文件名同时通配，两层判据都认不出，
  // 而它在 shell 里一字不差地展开成那两份载体（实测全绿；只通配一处 .audit/result.jso?
  // 或 .aud?t/result.json 反而都红）。所以判据不看它「像不像 .audit」：
  // 只要一个通配操作数**可能**命中载体面（以 .json 结尾，或某一段通配后仍能命中 .audit），
  // 就是未认领的 .audit 引用。
  function wildcardAuditRefs(line) {
    const hits = [];
    for (const word of shellWords(line)) {
      if (!WILDCARD_CHAR.test(word)) continue;
      const value = unquote(word);
      if (value.endsWith(".json")) {
        hits.push(value);
        continue;
      }
      const couldHitAudit = value.split("/").some((segment) => {
        if (!WILDCARD_CHAR.test(segment)) return false;
        return globSegmentMatches(segment, ".audit") || segment.includes("audit");
      });
      if (couldHitAudit) hits.push(value);
    }
    return hits;
  }

  // 写意图必须绑到**这条路径上**：口径层那一行同时提到 review-a / review-b / result.json，
  // 只按「这一行有写意图」认，会把三个文件都记到它名下（写者集合因此虚胖）。
  // 写目标是这三种形态里的路径本身：--out <p> / 重定向 > <p> / write*("<p>"。
  const AUDIT_WRITE_TARGET_PATTERNS = [
    /--out(?:=|\s+)("[^"]*"|'[^']*'|[^\s;&|)]+)/g,
    />>?\s*("[^"]*"|'[^']*'|[^\s;&|)]+)/g,
    /\b(?:writeFileSync|writeFile|appendFileSync|appendFile|createWriteStream)\s*\(\s*("[^"]*"|'[^']*'|[^\s,;)]+)/g,
  ];

  function auditDirWriteTargets(line) {
    const targets = [];
    for (const pattern of AUDIT_WRITE_TARGET_PATTERNS) {
      for (const match of String(line).matchAll(pattern)) {
        targets.push(match[1].replace(/^["']|["']$/g, "").replace(/[/\\]+$/, ""));
      }
    }
    // 载体归属不看写法的方言：cp/tee/install/mv/ln/dd of=/rsync 的目标同样是这条路径的写目标。
    // 不合并的话，cp 写进去的那个 step 在写者集合里根本不存在（写者集合是 toEqual 钉住的），
    // 覆盖改动会被「写者集合没变」这条断言反着保住。
    for (const target of copyWriteTargets(line)) targets.push(target.replace(/[/\\]+$/, ""));
    return targets;
  }

  // 某个 .audit 路径的写者集合：从文本推出（不手写名单），断言用 toEqual 钉住。
  function auditDirWriterSteps(stepList, path, options = {}) {
    const root = options.root ?? ROOT;
    return stepList
      .filter((step) =>
        stepTexts(step, { root }).some(({ text }) =>
          String(text)
            .split("\n")
            .map(stripShellComment)
            .some((line) => auditDirWriteTargets(line).includes(path)),
        ),
      )
      .map((step) => step.name ?? step.id);
  }

  // 引用某个 .audit 路径的步集合（写者 + 消费者），按名字精确断言。
  function auditDirReferenceSteps(stepList, path, options = {}) {
    const root = options.root ?? ROOT;
    return stepList
      .filter((step) =>
        stepTexts(step, { root }).some(({ text }) =>
          foldContinuations(String(text))
            .split("\n")
            .map(stripShellComment)
            .some((line) => auditDirPaths(line).includes(path)),
        ),
      )
      .map((step) => step.name ?? step.id);
  }

  // 目录级的默认拒绝：非白名单步引用 .audit 的任何形态都是违规。
  function auditDirReferenceViolations(stepList, options = {}) {
    const root = options.root ?? ROOT;
    const violations = [];
    const texts = [];
    for (const step of stepList) {
      const name = step.name ?? step.id;
      // cwd 随行携带：同一行文本在 cwd=.audit 与在仓库根下指的是两份不同的路径。
      const cwd = stepWorkingDir(step, options);
      for (const { where, text } of stepTexts(step, { root })) texts.push({ name, where, text, cwd });
    }
    const jobCwd = jobWorkingDir(options.jobPayloads ?? []);
    for (const { source, where, text } of jobPayloadTexts(options.jobPayloads ?? [], { root })) {
      texts.push({ name: source, where, text, cwd: jobCwd });
    }
    for (const { name, where, text, cwd } of texts) {
      // 同一份载荷里的简单赋值：`F="-d @body.json"` 下一行的 `$F` 必须看得见。
      const assignments = simpleAssignments(text);
      // 命令替换嵌套超过 3 层的正文跟不下去 —— 响，不静默当无。
      for (const body of substitutionExpansion(String(text)).overflow) {
        violations.push({
          step: name,
          where,
          excerpt: body.trim(),
          reason: SUBSTITUTION_DEPTH_REASON,
        });
      }
      for (const rawLine of foldContinuations(String(text)).split("\n")) {
        const line = stripShellComment(rawLine);
        if (!line.trim() || COMMENT_ONLY_LINE.test(line)) continue;
        // 结论写面先判：命中端点字面量，或**命令级写意图**（端点可以是变量、也可以藏在
        // 命令替换里），就必须是「那两步的 --input POST」或「自证步的回读」。
        // 端点字面量且明确不是 check-runs 面（别的 host / gh api 的别条路径）不产生违规。
        const writeIntent = commandWriteIntent(line, assignments);
        if (
          (CHECK_RUNS_ENDPOINT.test(line) || checkRunWriteSurface(line, assignments) !== null) &&
          !checkRunSanctioned(name, line, assignments)
        ) {
          violations.push({
            step: name,
            where,
            excerpt: line.trim(),
            // 赋值跟不下去时，写意图本身不可判 —— 理由要指向那一层，不能装成「不可判形态」。
            reason: blindAssignmentReason(line, assignments) ?? checkRunReason(line, writeIntent),
          });
        }
        // 复制/替换写载体：写通道只能是产出那一行 —— 写者可以产出，但不能**替换**。
        for (const target of copyWriteTargets(line)) {
          if (!unclaimedAuditTarget(target, cwd)) continue;
          violations.push({
            step: name,
            where,
            excerpt: line.trim(),
            reason: "载体的写通道只能是产出那一行（cp/tee/install 不是产出）",
          });
        }
        // 写命令藏在包装词之后：find -exec / xargs / env / sudo / bash -c … 之下的 cp 不在首词位置。
        for (const nested of wrappedWriteCommands(line)) {
          if (!COPY_WRITE_COMMANDS.has(nested.head)) continue;
          violations.push({
            step: name,
            where,
            excerpt: line.trim(),
            reason: "写命令藏在包装词之后（" + nested.wrapper + " " + nested.head + "）：静态层看不出目标",
          });
        }
        // 按内容落盘：解包 / 打补丁 / 还原文件都能改写被 POST 的载体，包内有什么静态层看不出。
        for (const landing of contentLandingCommands(line)) {
          violations.push({
            step: name,
            where,
            excerpt: line.trim(),
            reason: "按内容落盘（" + landing.command + "）：解包/打补丁能改写被 POST 的载体，只能默认拒绝",
          });
        }
        // 按目录树寻址的读取：操作数指到目录或 . / .. / / 时，读的是整棵树。
        for (const read of treeAddressingReads(line)) {
          violations.push({
            step: name,
            where,
            excerpt: line.trim(),
            reason: "按目录树寻址的读取（" + read.command + " " + read.target + "）",
          });
        }
        // 通配操作数：认不出就必须响。
        if (wildcardAuditRefs(line).length > 0) {
          violations.push({ step: name, where, excerpt: line.trim(), reason: "未认领的 .audit 引用" });
        }
        const paths = auditDirPaths(line);
        // cwd 指到 .audit 时，裸载体名按 cwd 解析回 .audit/<name> 参与判定。
        for (const bare of bareCarrierPaths(line, cwd)) if (!paths.includes(bare)) paths.push(bare);
        if (paths.length === 0) continue;
        // 建目录（shell mkdir / node mkdirSync）只创建目录，不读写任何载体，也不因此算写者。
        if (AUDIT_DIR_CREATE.test(line) || AUDIT_DIR_CREATE_NODE.test(line)) continue;
        // 存在性检查同样不取内容（已被下层同样放行）：只回答「文件在不在」。
        if (RESULT_DUMP_EXISTENCE.test(line) && !RESULT_DUMP_FORBIDDEN.test(line)) continue;
        // 原样倒出（只对 result.json）：沿用下层「cat 整份、不带加工」的判据。
        const dump = RESULT_DUMP_CAT.exec(line);
        if (dump) {
          const operand = (dump[2] ?? dump[3] ?? dump[4] ?? "").trim();
          if (
            CARRIERS.result.dumpPath.test(operand) &&
            !RESULT_DUMP_FORBIDDEN.test(line) &&
            !PIPE_TO_OTHER.test(line)
          )
            continue;
        }
        for (const token of paths) {
          const allowed = AUDIT_PATH_ALLOWED_STEPS[token];
          if (allowed && allowed.includes(name)) continue;
          violations.push({ step: name, where, excerpt: line.trim(), reason: "未认领的 .audit 引用" });
        }
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
      ["--noprofile", "--norc", "-eo", "pipefail", "-c", "cd sub && gh api 'repos/o/r/commits/cafebabe/check-runs?filter=all'"],
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

  it("轮十三-1：audit.yml 每个 step 都有 name（无 name 的步照常执行，行为层不许全盲）", () => {
    // Actions 里 name 是可选的：没有 name 的 step 照常被执行。所以「无 name」不是判据的豁免，
    // 而是一个必须被静态层看见、被行为层明说的形状（失败时打印下标与 run 前 60 字）。
    const nameless = steps
      .map((step, index) => ({ index, step }))
      .filter(({ step }) => !step.name)
      .map(({ index, step }) => index + " / " + String(step.run ?? "").slice(0, 60).replace(/\n/g, " "));
    expect(nameless).toEqual([]);
    expect(requireStepName(steps)).toBe(steps);
  });

  it("轮十三-2：无 name 不影响该步被扫描（判据看内容不看名字），行为层则 fail-closed 并指出第几个", () => {
    const dir = mkdtempSync(join(tmpdir(), "audit-noname-scan-"));
    // 同一段 run，加不加 name 都要同样红：名字不是扫描面的开关。
    const run = 'body=$(cat .audit/result.json)\n[[ "$body" == *needs_revision* ]] && echo hot=1\n';
    expect(resultJsonReaderViolations([{ run }], { root: dir }).map((v) => v.excerpt)).toEqual(
      resultJsonReaderViolations([{ name: "有名字", run }], { root: dir }).map((v) => v.excerpt),
    );
    expect(resultJsonReaderViolations([{ run }], { root: dir }).length).toBeGreaterThan(0);
    // 行为层：不是「跳过」，是明说第几个 step 没有 name。
    expect(() => requireStepName([{ run: "echo 1\n" }])).toThrow(/第 1 个 step 没有 name/);
    expect(() => requireStepName([{ name: "ok", run: "echo 1\n" }, { run: "echo 2\n" }])).toThrow(/第 2 个/);
  });

  it("轮十三-3：check-run.json 是结论载体 —— 写者精确等于三步，非写者引用一律违规", () => {
    const dir = mkdtempSync(join(tmpdir(), "audit-checkrun-carrier-"));
    // 写者精确相等（不是下限）：多一个写者就多一条产出结论的通道。
    expect(resultJsonWriterSteps(steps, { carrier: CARRIERS.checkRun, key: (step) => step.name })).toEqual([
      "口径层判定",
      "结论兜底",
      "判不了：回写 INFRA",
    ]);
    // 每一处写出的 payload 都必须叫 audit：换成 job 名，job 的红就与结论的红抢同一个名字。
    for (const name of ["口径层判定", "结论兜底", "判不了：回写 INFRA"]) {
      const step = steps.find((candidate) => candidate.name === name);
      const text = stepTexts(step, { root: ROOT })
        .map(({ text: value }) => value)
        .join("\n");
      expect(String(step.run), name).toContain('name: "audit"');
      expect(text, name).toContain('name: "audit"');
    }
    // 无 name 的步把结论改写成 success：静态层必须红（旧判据下 103 条全绿）。
    const rewrite = {
      name: "改写结论",
      run: 'node -e \'require("node:fs").writeFileSync(".audit/check-run.json", JSON.stringify({ conclusion: "success" }))\'\n',
    };
    expect(resultJsonWriterSteps([rewrite], { carrier: CARRIERS.checkRun })).toEqual(["改写结论"]);
    expect(auditDirReferenceViolations([rewrite], { root: dir }).map((v) => v.reason)).toEqual(["未认领的 .audit 引用"]);
    // 非写者步只读一个字段同样是违规（载体判据不分读多少）。
    const peek = { name: "旁读", run: "jq -r .conclusion .audit/check-run.json\n" };
    expect(resultJsonReaderViolations([peek], { root: dir, carrier: CARRIERS.checkRun }).length).toBeGreaterThan(0);
    // 载体的判读落在「引用 + 读形态」上；引用计数本身也必须认得 check-run.json。
    expect(resultJsonReads(peek.run, { carrier: CARRIERS.checkRun }).length).toBeGreaterThan(0);
  });

  it("轮十三-4：POST 面收口 —— check-runs 只能是那两步的 --input POST（绑文件，不绑拼写）", () => {
    const dir = mkdtempSync(join(tmpdir(), "audit-post-face-"));
    // 只读只对自证步放行：写面仍然只有那两步。
    const endpoints = steps.filter(
      (step) => String(step.run ?? "").includes("check-runs") && String(step.run ?? "").includes("--method POST"),
    );
    expect(endpoints.map((step) => step.name)).toEqual(["回写 Check Run", "判不了：回写 INFRA"]);
    for (const step of endpoints) {
      expect(String(step.run), step.name).toContain("--method POST");
      expect(String(step.run), step.name).toContain("--input .audit/check-run.json");
    }
    // 缺口 1 的第二种写法：绕开 $GITHUB_REPOSITORY 字面与 --input，用 -f 直拼 payload。
    const direct = {
      name: "旁路",
      run: "gh api repos/o/r/check-runs --method POST -f name=audit -f conclusion=success -f head_sha=deadbeef\n",
    };
    expect(auditDirReferenceViolations([direct], { root: dir }).map((v) => v.reason)).toEqual([
      CHECK_RUNS_REASON_WRITE,
    ]);
    // payload 先落到别的文件名再 --input 它：既碰未认领的 .audit 路径，也没绑 check-run.json。
    const aliased = {
      name: "旁路2",
      run: "gh api repos/$GITHUB_REPOSITORY/check-runs --method POST --input .audit/second.json\n",
    };
    expect(auditDirReferenceViolations([aliased], { root: dir }).map((v) => v.reason)).toEqual([
      CHECK_RUNS_REASON_WRITE,
      "未认领的 .audit 引用",
    ]);
    // 只读查询没有放行条件：这个端点在真 workflow 里只有回写一种用途，读它等于拿到产出面。
    const query = { name: "旁路3", run: 'gh api repos/o/r/check-runs --jq \'.["executors"] | length\'\n' };
    expect(auditDirReferenceViolations([query], { root: dir })).toHaveLength(1);
    // 真 workflow 零违规（POST 面 + 目录引用两面一起过）。
    expect(auditDirReferenceViolations(steps, { root: ROOT, jobPayloads: carrierPayloads })).toEqual([]);
  });

  it("轮十三-5：引用定义抬到 .audit 目录级 —— 父目录 / 搬运 / ? 通配 / 改名 都算引用", () => {
    const dir = mkdtempSync(join(tmpdir(), "audit-dir-ref-"));
    const cases = [
      ["父目录 grep", "grep -rq needs_revision .audit\n"],
      ["目录搬运", "tar -cf /tmp/x.tar .audit\n"],
      ["? 通配", "cat .audit/result.jso?\n"],
      ["改名后再读", "cp -a .audit /tmp/leakdir\n"],
      ["父目录枚举", "ls -R .audit\n"],
    ];
    for (const [label, run] of cases) {
      expect(auditDirReferenceViolations([{ name: "leak", run }], { root: dir }).length, label).toBeGreaterThan(0);
    }
    // mkdir -p .audit 只是建目录：不违规，也不因此算写者。
    const mkdir = { name: "mkdir", run: "mkdir -p .audit\n" };
    expect(auditDirReferenceViolations([mkdir], { root: dir })).toEqual([]);
    expect(auditDirWriterSteps([mkdir], ".audit/result.json")).toEqual([]);
    const nodeMkdir = {
      name: "node-mkdir",
      run: 'node -e \'require("node:fs").mkdirSync(".audit", { recursive: true })\'\n',
    };
    expect(auditDirReferenceViolations([nodeMkdir], { root: dir })).toEqual([]);
    // 真 workflow：写者与引用者精确等于名单，整体零违规。
    expect(auditDirWriterSteps(steps, ".audit/review-a.json", { root: ROOT })).toEqual(["落盘 review-a"]);
    expect(auditDirWriterSteps(steps, ".audit/review-b.json", { root: ROOT })).toEqual(["落盘 review-b"]);
    expect(auditDirWriterSteps(steps, ".audit/result.json", { root: ROOT })).toEqual(["口径层判定", "结论兜底"]);
    expect(auditDirWriterSteps(steps, ".audit/check-run.json", { root: ROOT })).toEqual([
      "口径层判定",
      "结论兜底",
      "判不了：回写 INFRA",
    ]);
    expect(auditDirReferenceSteps(steps, ".audit/check-run.json", { root: ROOT })).toEqual([
      "口径层判定",
      "结论兜底",
      "回写 Check Run",
      // 自证步读它只为「内容比什么」：读的是本次 payload 的 conclusion，只读、不写。
      "结论自证：回读 Check Run",
      "判不了：回写 INFRA",
    ]);
    expect(auditDirReferenceViolations(steps, { root: ROOT, jobPayloads: carrierPayloads })).toEqual([]);
  });

  it("轮十三-6：白名单第 3 条收死 —— 按内容分支（[[ ]] / test / grep）一律违规，只留存在性检查", () => {
    const dir = mkdtempSync(join(tmpdir(), "audit-content-branch-"));
    const forbidden = [
      ["字面量分支", 'body=$(cat .audit/result.json)\n[[ "$body" == *needs_revision* ]] && echo hot=1\n'],
      ["不等分支", 'body=$(cat .audit/result.json)\n[[ "$body" != *pass* ]] && echo hot=1\n'],
      ["正则分支", 'body=$(cat .audit/result.json)\n[[ "$body" =~ needs ]] && echo hot=1\n'],
      ["grep 判定", 'body=$(cat .audit/result.json)\nprintf "%s" "$body" | grep -q needs_revision\n'],
      ["test 通配", 'body=$(cat .audit/result.json)\ntest "$body" = "*needs*" && echo hot=1\n'],
    ];
    for (const [label, run] of forbidden) {
      expect(resultJsonReaderViolations([{ id: "branch", run }], { root: dir }).length, label).toBeGreaterThan(0);
    }
    // 存在性检查是唯一保留的「元数据」放行：只回答文件在不在，不告诉内容是什么。
    for (const run of ["[[ -s .audit/result.json ]]\n", "test -f .audit/result.json\n"]) {
      expect(resultJsonReaderViolations([{ id: "exists", run }], { root: dir }), run).toEqual([]);
      expect(auditDirReferenceViolations([{ name: "exists", run }], { root: dir }), run).toEqual([]);
    }
    // 围栏增长循环放行的理由：比较对象是**变量**（自己拼的引号串），分辨不出任何取值。
    const fence = 'body=$(cat .audit/result.json)\nwhile [[ "$body" == *"$fence"* ]]; do fence="$fence"; done\necho "$body"\n';
    expect(resultJsonReaderViolations([{ id: "fence", run: fence }], { root: dir })).toEqual([]);
  });

  it("轮十三-7：假红噪音修掉 —— jq -r / grep -r 的红来自「未认领的 .audit 引用」", () => {
    const dir = mkdtempSync(join(tmpdir(), "audit-noise-"));
    // 旧判据把 -r 一律当 loader 旗标：jq -r 靠 loader-no-value / missing 落红，-rq / -rc 立刻绿。
    // 那是误报兜住的覆盖真相。现在 -r 只在取值解得出一份真实脚本时才算模块取值。
    const cases = [
      ["jq -r", "jq -r '.executors | length' .audit/result.json\n"],
      ["grep -rq", "grep -rq needs_revision .audit\n"],
      ["grep -rc", "grep -rc needs_revision .audit\n"],
    ];
    for (const [label, run] of cases) {
      const scripts = referencedScripts([{ name: "read", run }], { root: dir });
      expect(scripts.unfollowable, label).toEqual([]);
      expect(scripts.missing, label).toEqual([]);
      expect(auditDirReferenceViolations([{ name: "read", run }], { root: dir }).map((v) => v.reason), label).toEqual([
        "未认领的 .audit 引用",
      ]);
    }
  });

  it("轮十四-1：working-directory 在扫描面 —— cwd 指到 .audit 时裸载体名同样算引用", () => {
    // 字段换了、执行面没换：cwd 决定这一步里**所有相对路径**落在哪。
    expect(stepPayloads({ id: "x", "working-directory": ".audit", run: "true\n" }).map((p) => p.carrier)).toEqual([
      "run",
      "working-directory",
    ]);
    expect(
      jobPayloads({ defaults: { run: { "working-directory": ".audit" } }, steps: [] }, {}).map((p) => p.carrier),
    ).toEqual(["defaults.run.working-directory"]);
    // 等价写法归一：换一个斜杠不该换一个结论。
    expect([".audit", "./.audit", ".audit/", ".audit/.", "./.audit/"].map(normalizeWorkingDirectory)).toEqual([
      ".audit",
      ".audit",
      ".audit",
      ".audit",
      ".audit",
    ]);
    expect([".", "./", ""].map(normalizeWorkingDirectory)).toEqual(["", "", null]);
    // 工作目录不跟脚本：它是路径不是命令（`./scripts` 不该被记成跟不下去的脚本）。
    expect(payloadScriptRefs({ carrier: "working-directory", text: "./scripts" }, { root: ROOT })).toEqual({
      refs: [],
      unfollowable: [],
    });

    const dir = mkdtempSync(join(tmpdir(), "audit-cwd-"));
    const bare = "jq -r '.conclusion' check-run.json\n";
    // 在仓库根下（无 working-directory），裸名不是 .audit 引用。
    expect(auditDirReferenceViolations([{ name: "旁路", run: bare }], { root: dir })).toEqual([]);
    // 同一个 run、只多一个键，裸名就按 cwd 解析回 .audit/check-run.json。
    const withCwd = auditDirReferenceViolations([{ name: "旁路", "working-directory": ".audit", run: bare }], {
      root: dir,
    });
    expect(withCwd.map((v) => v.reason)).toEqual(["未认领的 .audit 引用", "未认领的 .audit 引用"]);
    expect(withCwd.some((v) => v.where === "run")).toBe(true);
    // job 级 defaults.run.working-directory 是同一个机制（同一行 run，靠 job 载体钉 cwd）。
    const jobCwd = auditDirReferenceViolations([{ name: "旁路", run: bare }], {
      root: dir,
      jobPayloads: [{ carrier: "defaults.run.working-directory", text: "./.audit/" }],
    });
    expect(jobCwd.some((v) => v.where === "run")).toBe(true);
    // 真 workflow 两个字段都没有 —— 这条同时是「加了字段也零违规」的正向对照。
    expect(steps.filter((step) => step["working-directory"] !== undefined)).toEqual([]);
    expect(job.defaults?.run?.["working-directory"]).toBeUndefined();
    expect(auditDirReferenceViolations(steps, { root: ROOT, jobPayloads: carrierPayloads })).toEqual([]);
  });

  it("轮十四-2：复制/替换不是产出 —— cp/tee/install/ln/dd of= 的目标不得落进载体面", () => {
    for (const [label, line, expected] of [
      ["cp", "cp /tmp/pwn.json .audit/check-run.json", ".audit/check-run.json"],
      ["cp -a", "cp -a /tmp/pwn.json .audit/result.json", ".audit/result.json"],
      ["tee", "printf '%s' \"$x\" | tee -a .audit/result.json", ".audit/result.json"],
      ["install", "install -m 644 /tmp/x .audit/review-a.json", ".audit/review-a.json"],
      ["mv", "mv /tmp/x .audit/review-b.json", ".audit/review-b.json"],
      ["ln", "ln -sf /tmp/x .audit/check-run.json", ".audit/check-run.json"],
      ["dd of=", "dd if=/tmp/x of=.audit/check-run.json", ".audit/check-run.json"],
      ["rsync", "rsync -a /tmp/x .audit/check-run.json", ".audit/check-run.json"],
      ["--target-directory", "cp /tmp/x --target-directory=.audit", ".audit"],
    ]) {
      expect(auditDirWriteTargets(line), label).toContain(expected);
      expect(copyWriteTargets(line), label).toContain(expected);
    }
    // 写者步里塞一条条件分叉的 cp，同样违规：写者可以产出，但不能**替换**。
    const fallback = steps.find((step) => step.name === "结论兜底");
    expect(fallback).toBeTruthy();
    const planted = {
      ...fallback,
      run: `[ "$GITHUB_ACTOR" = "attacker" ] && cp /tmp/pwn.json .audit/check-run.json; true\n${fallback.run}`,
    };
    expect(auditDirReferenceViolations([planted], { root: ROOT, jobPayloads: carrierPayloads }).map((v) => v.reason)).toEqual([
      "载体的写通道只能是产出那一行（cp/tee/install 不是产出）",
    ]);
    // 正向对照：真 workflow 一条复制/替换写入都没有（判据不会空转，也不会误报）。
    for (const step of steps) {
      for (const { where, text } of stepTexts(step, { root: ROOT })) {
        for (const line of String(text).split("\n")) {
          expect(copyWriteTargets(stripShellComment(line)), step.name + "/" + where).toEqual([]);
        }
      }
    }
  });

  it("轮十四-3：结论写面是一条面 —— GraphQL createCheckRun 与 REST check-runs 同一收口", () => {
    const dir = mkdtempSync(join(tmpdir(), "audit-graphql-"));
    const gql = `curl -sS -X POST https://api.github.com/graphql -d '{"query":"mutation{createCheckRun(input:{conclusion:SUCCESS})}"}'\n`;
    expect(auditDirReferenceViolations([{ name: "插一步", run: gql }], { root: dir }).map((v) => v.reason)).toEqual([
      CHECK_RUNS_REASON_WRITE,
    ]);
    // gh api graphql 的等价写法同样命中：判据不认拼写，认面。
    expect(
      auditDirReferenceViolations([{ name: "插一步", run: "gh api graphql -f query='mutation{createCheckRun}'\n" }], {
        root: dir,
      }).map((v) => v.reason),
    ).toEqual([CHECK_RUNS_REASON_WRITE]);
    // 面收了，sanctioned 规则没变：那两步的 --input POST 仍然放行。
    const sanctioned = steps.find((step) => step.name === "回写 Check Run");
    expect(sanctioned).toBeTruthy();
    expect(
      auditDirReferenceViolations([{ name: "回写 Check Run", run: sanctioned.run }], {
        root: ROOT,
        jobPayloads: carrierPayloads,
      }),
    ).toEqual([]);
    // 全面在真 workflow 里只出现在三步：两个写者，加一个只读自证。
    expect(steps.filter((step) => CHECK_RUNS_ENDPOINT.test(String(step.run ?? ""))).map((step) => step.name)).toEqual([
      "回写 Check Run",
      "结论自证：回读 Check Run",
      "判不了：回写 INFRA",
    ]);
  });

  it("轮十四-4：双层通配认不出也必须响 —— .aud*/res*.json 不是放行", () => {
    const dir = mkdtempSync(join(tmpdir(), "audit-glob-"));
    // 认不出的通配一律判「未认领的 .audit 引用」：目录段与文件名同时通配时，
    // 两层判据都认不出，而它在 shell 里一字不差地展开成那两份载体。
    for (const [label, run, count] of [
      ["目录段+文件名", "jq -r .conclusion .aud*/res*.json\n", 1],
      ["目录段+载体名", "cat .aud*/check-run*.json\n", 1],
      ["只通配目录段", "cat .aud*/result.json\n", 1],
      ["目录名整段通配", "cat *audit*/result.json\n", 1],
      ["只通配文件名", "cat .audit/result*.json\n", 2],
    ]) {
      expect(auditDirReferenceViolations([{ name: "插一步", run }], { root: dir }).map((v) => v.reason), label).toEqual(
        Array(count).fill("未认领的 .audit 引用"),
      );
    }
    // 正向对照：字面路径照旧按白名单判（不是「见 .json 就红」），非载体通配不误报。
    expect(auditDirReferenceViolations([{ name: "口径层判定", run: "cat .audit/result.json\n" }], { root: dir })).toEqual(
      [],
    );
    expect(auditDirReferenceViolations([{ name: "插一步", run: "ls /tmp/*.log\n" }], { root: dir })).toEqual([]);
    // 真 workflow 无载体通配（含 followed 脚本）：新规则不是靠误报兜住的。
    expect(auditDirReferenceViolations(steps, { root: ROOT, jobPayloads: carrierPayloads })).toEqual([]);
  });

  it("轮十四-5：短旗标不吃下一个词 —— jq -r .verdict 不产生模块 ref 与噪音", () => {
    const dir = mkdtempSync(join(tmpdir(), "audit-shortflag-"));
    // 旧判据把 -r 的下一个词一律当模块取值，于是 jq -r .verdict 落 scripts.missing=['.verdict']。
    for (const [label, run] of [
      ["jq -r 裸取值", "jq -r .verdict .audit/result.json\n"],
      ["jq -r 裸取值（结论面）", "jq -r .conclusion .audit/check-run.json\n"],
      ["grep -rq", "grep -rq needs_revision .audit\n"],
      ["sed -r", "sed -r s/a/b/ .audit/result.json\n"],
    ]) {
      const scripts = referencedScripts([{ name: "read", run }], { root: dir });
      expect(scripts.missing, label).toEqual([]);
      expect(scripts.unfollowable, label).toEqual([]);
      expect(scripts.files, label).toEqual([]);
    }
    // 反面对照：真模块取值仍然认得出（否则上面全绿只是把整条通道关掉了）。
    mkdirSync(join(dir, "scripts"), { recursive: true });
    writeFileSync(join(dir, "scripts", "probe.cjs"), "module.exports = 1;\n");
    const real = referencedScripts([{ name: "load", run: "NODE_OPTIONS='-r ./scripts/probe.cjs' jq . x.json\n" }], {
      root: dir,
    });
    expect(real.files).toEqual(["scripts/probe.cjs"]);
    expect(real.missing).toEqual([]);
    // 真 workflow 的 -r 噪音已清零（轮十三-7 的判据在这条规则收紧后仍然成立）。
    expect(referencedScripts(steps, { root: ROOT, jobPayloads: carrierPayloads }).missing).toEqual([]);
  });

  // ---- 轮十五：run 文本之外的面（YAML 键 / env / 目录 / 命令词）----
  // 下面每一组都同时给「真触发」与「不该红」两个方向：只红不绿说明判据在误伤，只绿不红说明它空转。
  const SH = String.fromCharCode(10);
  // -exec 的终止符 \; 在本文件里逐字构造，免得转义在源码里被吃掉一层。
  const SEMI = String.fromCharCode(92) + ";";

  it("轮十五-1：step 键是白名单（fail-closed）—— 白名单外的键一律违规并点名键与 step", () => {
    // continue-on-error 让 outcome=failure / conclusion=success，job 仍是绿的。
    // 行为层跑的是 run 块，永远看不到这个 YAML 键，所以它只能在结构层收口。
    expect(STEP_ALLOWED_KEYS).not.toContain("continue-on-error");
    expect(JOB_ALLOWED_KEYS).not.toContain("continue-on-error");
    const base = { name: "回写 Check Run", if: "steps.ctx.outcome == 'success'", run: "gh api x" + SH };
    expect(stepKeyViolations([base])).toEqual([]);
    expect(unknownKeyViolations(base, STEP_ALLOWED_KEYS)).toEqual([]);
    for (const key of ["continue-on-error", "timeout-minutes", "retries", "concurrency", "permissions"]) {
      const violations = stepKeyViolations([{ ...base, [key]: true }]);
      expect(violations.map((v) => v.where), key).toEqual([key]);
      expect(violations[0].step, key).toBe("回写 Check Run");
      expect(violations[0].reason, key).toContain(key);
    }
    // 一步塞两个未知键要逐一点名，不是只报第一个。
    expect(stepKeyViolations([{ ...base, "continue-on-error": true, retries: 2 }]).map((v) => v.where)).toEqual([
      "continue-on-error",
      "retries",
    ]);
    // 没有 name 的步也要能被点名（下标当身份），否则「无 name」就是白名单的旁路。
    expect(stepKeyViolations([{ run: "true" + SH, "continue-on-error": true }]).map((v) => v.step)).toEqual([
      "第 1 个 step",
    ]);
    // 正向对照：真 workflow 每一个 step 全过白名单。
    expect(stepKeyViolations(steps)).toEqual([]);
  });

  it("轮十五-2：三步各自显式断言没有 continue-on-error，job 键同样按白名单收窄", () => {
    for (const name of ["回写 Check Run", "判定", "判不了：回写 INFRA"]) {
      const step = steps.find((candidate) => candidate.name === name);
      expect(step, name).toBeTruthy();
      expect(step["continue-on-error"], name).toBeUndefined();
    }
    // 这三步就是这个契约的要害：POST、判定、以及判不了时的 INFRA 回写。
    expect(steps.filter((step) => step["continue-on-error"] !== undefined)).toEqual([]);
    // job 级白名单按真文件实有键收窄（name / runs-on / env / steps）。
    expect(jobKeyViolations(job)).toEqual([]);
    expect(Object.keys(job).filter((key) => !JOB_ALLOWED_KEYS.includes(key))).toEqual([]);
    const mutated = { ...job, "continue-on-error": true };
    expect(jobKeyViolations(mutated).map((v) => v.where)).toEqual(["continue-on-error"]);
    expect(jobKeyViolations(mutated)[0].reason).toContain("continue-on-error");
    // 白名单只有 audit.yml 里 job 实有的四个键：job 级 permissions / timeout-minutes / if / strategy /
    // container 一律会被拒（见轮二十二-4），一旦真需要就显式加进 JOB_ALLOWED_KEYS 并在这里同步 ——
    // 于是「加了键」永远是一次可见的改动。
    expect(JOB_ALLOWED_KEYS).not.toContain("continue-on-error");
    expect(JOB_ALLOWED_KEYS).toEqual(["name", "runs-on", "env", "steps"]);
  });

  it("轮十五-3：step 级 env 不许覆写落点与凭据 —— 禁止覆写集合与键交叉都要红", () => {
    expect(ENV_OVERRIDE_FORBIDDEN).toEqual(
      expect.arrayContaining([
        "GITHUB_REPOSITORY",
        "GITHUB_TOKEN",
        "GH_TOKEN",
        "GITHUB_OUTPUT",
        "GITHUB_STEP_SUMMARY",
        "GITHUB_SHA",
      ]),
    );
    // 正向对照：真 workflow 的 step env 全是输入面（PR_INPUT / AUDIT_* / RUN_SHA / CTX_OK）。
    expect(stepEnvOverrideViolations(steps, { jobEnv: job.env, workflowEnv: doc.env })).toEqual([]);
    const base = steps.find((step) => step.name === "回写 Check Run");
    for (const key of ENV_OVERRIDE_FORBIDDEN) {
      const violations = stepEnvOverrideViolations([{ ...base, env: { [key]: "someone/else" } }], {});
      expect(violations.map((v) => v.where), key).toEqual(["env"]);
      expect(violations[0].step, key).toBe("回写 Check Run");
      expect(violations[0].reason, key).toContain(key);
    }
    // 覆写 GITHUB_REPOSITORY 时 sanctioned 那行一字未改 —— 判据必须落在 env，不是 run 文本。
    const rewritten = {
      ...base,
      env: { GITHUB_REPOSITORY: "someone/else" },
    };
    expect(String(rewritten.run)).toBe(String(base.run));
    expect(stepEnvOverrideViolations([rewritten], {}).length).toBeGreaterThan(0);
  });

  it("轮十五-4：step 级 env 与 job 级 / workflow 级同键也算覆写，点名两边；新增键不算", () => {
    const base = steps.find((step) => step.name === "回写 Check Run");
    // 与 job 级同键（GH_TOKEN 本身已在禁止集合里，这里取一个不在集合内的键，单看交叉那一面）。
    const jobLevel = stepEnvOverrideViolations([{ ...base, env: { AUDIT_FIXTURE: "1" } }], {
      jobEnv: { AUDIT_FIXTURE: "0" },
    });
    expect(jobLevel).toHaveLength(1);
    expect(jobLevel[0].reason).toContain("job 级 env 的 AUDIT_FIXTURE");
    expect(jobLevel[0].step).toBe("回写 Check Run");
    const workflowLevel = stepEnvOverrideViolations([{ ...base, env: { CI: "1" } }], { workflowEnv: { CI: "0" } });
    expect(workflowLevel).toHaveLength(1);
    expect(workflowLevel[0].reason).toContain("workflow 级 env 的 CI");
    // 反面对照：新增键不覆写任何东西，不是「有 env 就红」。
    expect(stepEnvOverrideViolations([{ ...base, env: { EXTRA: "1" } }], { jobEnv: job.env, workflowEnv: doc.env })).toEqual(
      [],
    );
    // 没有 env 的步直接跳过 —— 判据看键交叉，不看「有没有 env」。
    expect(stepEnvOverrideViolations(steps.filter((step) => step.env === undefined), {})).toEqual([]);
  });

  it("轮十五-5：结论写面按目录收口 —— 只有 audit.yml 命中，且只有 audit.yml 时判据稳定", () => {
    expect(workflowFiles()).toContain("audit.yml");
    // 正向断言：写面文件清单精确等于 [audit.yml]。
    expect(workflowWriteSurfaceFiles()).toEqual(["audit.yml"]);
    expect(workflowWriteSurfaceViolations()).toEqual([]);
    // merge-gate.yml 只是**读** checks 列表（就绪轮询）：读不产生结论，不是写面。
    const gate = readFileSync(join(ROOT, WORKFLOW_DIR, "merge-gate.yml"), "utf8").split(SH);
    const gateLines = gate.filter((line) => line.includes("check-runs"));
    expect(gateLines.length).toBeGreaterThan(0);
    expect(gateLines.filter((line) => checkRunWriteSurface(stripShellComment(line)))).toEqual([]);
    // 只放一个 audit.yml 的临时目录：判据在真仓库当前形状下稳定（不靠 peer 文件的缺席）。
    const dir = mkdtempSync(join(tmpdir(), "audit-workflow-surface-"));
    mkdirSync(join(dir, WORKFLOW_DIR), { recursive: true });
    writeFileSync(join(dir, WORKFLOW_DIR, "audit.yml"), readFileSync(join(ROOT, WORKFLOW_DIR, "audit.yml"), "utf8"));
    expect(workflowWriteSurfaceFiles({ root: dir })).toEqual(["audit.yml"]);
    expect(workflowWriteSurfaceViolations({ root: dir })).toEqual([]);
    // 非 yml 文件不参与扫描（目录里还有别的垃圾时不误报）。
    writeFileSync(join(dir, WORKFLOW_DIR, "README.md"), "gh api repos/o/r/check-runs --method POST" + SH);
    expect(workflowWriteSurfaceViolations({ root: dir })).toEqual([]);
  });

  it("轮十五-6：同目录第二个 workflow 写结论即违规 —— 同名的第二条 Check Run 会盖掉真结论", () => {
    const dir = mkdtempSync(join(tmpdir(), "audit-workflow-peer-"));
    mkdirSync(join(dir, WORKFLOW_DIR), { recursive: true });
    writeFileSync(join(dir, WORKFLOW_DIR, "audit.yml"), readFileSync(join(ROOT, WORKFLOW_DIR, "audit.yml"), "utf8"));
    const peer = [
      "name: peer",
      "on: pull_request",
      "jobs:",
      "  peer:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - run: |",
      "          gh api repos/$GITHUB_REPOSITORY/check-runs --method POST -f name=audit -f conclusion=success",
      "",
    ].join(SH);
    writeFileSync(join(dir, WORKFLOW_DIR, "peer.yml"), peer);
    const violations = workflowWriteSurfaceViolations({ root: dir });
    expect(violations.map((v) => v.step)).toEqual(["peer.yml"]);
    expect(violations.map((v) => v.where)).toEqual(["check-runs"]);
    expect(violations[0].reason).toContain("结论写面只允许 audit.yml");
    expect(violations[0].reason).toContain("盖掉真结论");
    expect(workflowWriteSurfaceFiles({ root: dir })).toEqual(["audit.yml", "peer.yml"]);
    // 同一个写面的另两种写法（.yaml 后缀也扫）：GraphQL createCheckRun 与 REST -f 直拼。
    writeFileSync(
      join(dir, WORKFLOW_DIR, "peer2.yaml"),
      ["name: peer2", "on: pull_request", "jobs:", "  p:", "    steps:", "      - run: gh api graphql -f query=mutation"].join(SH),
    );
    expect(workflowWriteSurfaceViolations({ root: dir }).map((v) => v.step)).toEqual(["peer.yml", "peer2.yaml"]);
    // 反面对照：只读查询（--jq / 重定向到文件）不是写面，不产生结论。
    writeFileSync(
      join(dir, WORKFLOW_DIR, "gate.yml"),
      ["name: gate", "jobs:", "  g:", "    steps:", "      - run: gh api repos/$GITHUB_REPOSITORY/check-runs --jq .[0]"].join(SH),
    );
    expect(workflowWriteSurfaceViolations({ root: dir }).map((v) => v.step)).toEqual(["peer.yml", "peer2.yaml"]);
    // 真仓库仍然零违规。
    expect(workflowWriteSurfaceViolations()).toEqual([]);
  });

  it("轮十五-6b：github-script 的 with 脚本也是结论写面 —— checks.create 不再零命中", () => {
    const dir = mkdtempSync(join(tmpdir(), "audit-workflow-github-script-"));
    mkdirSync(join(dir, WORKFLOW_DIR), { recursive: true });
    writeFileSync(join(dir, WORKFLOW_DIR, "audit.yml"), readFileSync(join(ROOT, WORKFLOW_DIR, "audit.yml"), "utf8"));
    // 实测形态：actions/github-script@v7 的 with.script 里调 github.rest.checks.create。
    // 命令面判据全盲 —— 没有 gh、没有 check-runs 子串、没有 graphql —— 旧判据 127 条全绿。
    const peer = [
      "name: peer",
      "on: pull_request",
      "jobs:",
      "  peer:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - uses: actions/github-script@v7",
      "        with:",
      "          script: |",
      '            await github.rest.checks.create({ owner: "o", repo: "r", name: "audit", head_sha: "x", status: "completed", conclusion: "success" })',
      "",
    ].join(SH);
    writeFileSync(join(dir, WORKFLOW_DIR, "peer.yml"), peer);
    const violations = workflowWriteSurfaceViolations({ root: dir });
    expect(violations.map((v) => v.step)).toEqual(["peer.yml"]);
    expect(violations.map((v) => v.where)).toEqual(["checks.create"]);
    expect(violations[0].reason).toContain("结论写面只允许 audit.yml");
    expect(workflowWriteSurfaceFiles({ root: dir })).toEqual(["audit.yml", "peer.yml"]);
    // 同一个写面的另三种拼写：octokit 的 checks.create / createCheckRun / ["checks"] 下标。
    for (const [label, script] of [
      ["octokit checks.create", 'await octokit.checks.create({ name: "audit", conclusion: "success" })'],
      ["createCheckRun", 'await createCheckRun({ name: "audit", conclusion: "success" })'],
      ['["checks"] 下标', 'await octokit["checks"].create({ name: "audit", conclusion: "success" })'],
    ]) {
      expect(checkRunWriteSurface(script), label).not.toBeNull();
    }
    // 反面对照 1：真 audit.yml 里没有这些拼写（不是「见 checks 就红」）。
    expect(
      readFileSync(join(ROOT, WORKFLOW_DIR, "audit.yml"), "utf8")
        .split(SH)
        .filter((line) => CHECKS_CREATE_CALL.test(stripShellComment(line))),
    ).toEqual([]);
    // 反面对照 2：merge-gate.yml 的只读 check-runs 轮询继续不红。
    const gate = readFileSync(join(ROOT, WORKFLOW_DIR, "merge-gate.yml"), "utf8").split(SH);
    expect(gate.filter((line) => checkRunWriteSurface(stripShellComment(line)))).toEqual([]);
    // 真仓库仍然零违规。
    expect(workflowWriteSurfaceViolations()).toEqual([]);
  });

  it("轮十七-2：写面判据先折续行 —— 端点与方法被拆到三行仍是同一条命令", () => {
    const dir = mkdtempSync(join(tmpdir(), "audit-fold-cont-"));
    mkdirSync(join(dir, WORKFLOW_DIR), { recursive: true });
    writeFileSync(join(dir, WORKFLOW_DIR, "audit.yml"), readFileSync(join(ROOT, WORKFLOW_DIR, "audit.yml"), "utf8"));
    // shell 把「反斜杠 + 换行」原样删除：这是**一条** PATCH，不是三行各自安全。
    // 逐物理行判时端点行没有写形态、写形态行没有端点，两半都放过（实测 0 红）。
    writeFileSync(
      join(dir, WORKFLOW_DIR, "peer.yml"),
      [
        "name: peer",
        "on: pull_request",
        "jobs:",
        "  p:",
        "    steps:",
        "      - run: |",
        "          gh api repos/$GITHUB_REPOSITORY/check-runs/1 \\",
        "            --method PATCH \\",
        "            -f conclusion=success",
        "",
      ].join(SH),
    );
    expect(workflowWriteSurfaceViolations({ root: dir }).map((v) => v.step)).toEqual(["peer.yml"]);
    expect(workflowWriteSurfaceFiles({ root: dir })).toEqual(["audit.yml", "peer.yml"]);
    // 对照组：同一条命令写成单行一律红 —— 差异只能来自折行，不是「这个写法本来就不红」。
    writeFileSync(
      join(dir, WORKFLOW_DIR, "peer.yml"),
      [
        "name: peer",
        "jobs:",
        "  p:",
        "    steps:",
        "      - run: gh api repos/$GITHUB_REPOSITORY/check-runs/1 --method PATCH -f conclusion=success",
      ].join(SH),
    );
    expect(workflowWriteSurfaceViolations({ root: dir }).map((v) => v.step)).toEqual(["peer.yml"]);
    // 折叠不等于「见续行就红」：拆行的只读回读仍是只读。
    writeFileSync(
      join(dir, WORKFLOW_DIR, "gate.yml"),
      [
        "name: gate",
        "jobs:",
        "  g:",
        "    steps:",
        "      - run: |",
        "          gh api repos/$GITHUB_REPOSITORY/commits/abc/check-runs \\",
        "            --paginate --slurp > runs.json",
        "",
      ].join(SH),
    );
    expect(workflowWriteSurfaceViolations({ root: dir }).map((v) => v.step)).toEqual(["peer.yml"]);
  });

  it("轮十七-3：写形态默认拒绝 —— 方法的大小写/等号形式、--raw-field、curl 的体标志都算写", () => {
    // gh 侧：方法归一化后都是 PATCH（真 gh 实测 --method patch / -Xpatch / --method=PATCH 都真发 PATCH）。
    for (const [label, line] of [
      ["--method patch", "gh api repos/o/r/check-runs/1 --method patch --raw-field conclusion=success"],
      ["--method=PATCH", "gh api repos/o/r/check-runs/1 --method=PATCH --raw-field conclusion=success"],
      ["-Xpatch", "gh api repos/o/r/check-runs/1 -Xpatch --raw-field conclusion=success"],
      ["-XPATCH", "gh api repos/o/r/check-runs/1 -XPATCH --raw-field conclusion=success"],
    ]) {
      expect(ghApiMethod(line), label).not.toBeNull();
      expect(checkRunWriteSurface(line), label).toBe("check-runs");
    }
    // 不带方法也要拦：--raw-field / --field 自己就是写（gh 会把它们当 POST 体）。
    for (const [label, line] of [
      ["--raw-field 单独", "gh api repos/o/r/check-runs/1 --raw-field conclusion=success"],
      ["--field 长选项", "gh api repos/o/r/check-runs/1 --field conclusion=success"],
      ["-f", "gh api repos/o/r/check-runs/1 -f conclusion=success"],
      ["--input 载体", "gh api repos/o/r/check-runs/1 --input .audit/check-run.json"],
    ]) {
      expect(checkRunWriteSurface(line), label).toBe("check-runs");
    }
    // curl 侧：不带方法、只带请求体就是 POST —— 缺口正是这一族（请求体标志本身就是写）。
    for (const [label, line] of [
      [
        "-d",
        `curl -sS -H 'authorization: x' -H 'content-type: application/json' -d '{"name":"audit","status":"completed","conclusion":"success"}' https://api.github.com/repos/o/r/check-runs`,
      ],
      ["--data-binary", "curl -sS --data-binary @body.json https://api.github.com/repos/o/r/check-runs"],
      ["-F", "curl -sS -F name=audit https://api.github.com/repos/o/r/check-runs"],
      ["--post-data", "wget -q --post-data=name=audit https://api.github.com/repos/o/r/check-runs"],
    ]) {
      expect(checkRunWriteSurface(line), label).toBe("check-runs");
    }
    // 反面对照：纯只读调用（默认 GET、没有任何取值/体标志）继续不红 —— 默认拒绝不是「见端点就红」。
    for (const line of [
      "gh api repos/o/r/check-runs --jq .[0]",
      "gh api 'repos/o/r/commits/cafebabe/check-runs?filter=all' --paginate --slurp",
      "curl -sS https://api.github.com/repos/o/r/check-runs",
    ]) {
      expect(checkRunWriteSurface(line), line).toBeNull();
    }
    // 真仓库零违规：默认拒绝不许把既有的只读轮询打成写。
    expect(workflowWriteSurfaceViolations()).toEqual([]);
  });

  it("轮十七-4：步内命令同样先折续行再判 —— 目录级判据不是逐物理行", () => {
    const dir = mkdtempSync(join(tmpdir(), "audit-fold-step-"));
    mkdirSync(join(dir, WORKFLOW_DIR), { recursive: true });
    // 关键是要**穿过放行**：起手行是自证步认得的只读回读形态（READ_ONE），
    // 写形态被拆到后两行 —— 逐物理行判时前半段放行、后半段没有端点，整条命令零违规（实测）。
    const splitWrite = [
      'gh api "repos/$GITHUB_REPOSITORY/check-runs/1" \\',
      "  --method patch \\",
      "  --raw-field conclusion=success",
    ].join(SH);
    expect(
      auditDirReferenceViolations([{ name: "结论自证：回读 Check Run", run: splitWrite }], { root: dir }).map((v) => v.reason),
    ).toContain(CHECK_RUNS_REASON_WRITE);
    // 对照组：同一条命令写成单行同样违规 —— 差异只能来自折行。
    expect(
      auditDirReferenceViolations(
        [
          {
            name: "结论自证：回读 Check Run",
            run: 'gh api "repos/$GITHUB_REPOSITORY/check-runs/1" --method PATCH --raw-field conclusion=success',
          },
        ],
        { root: dir },
      ).map((v) => v.reason),
    ).toContain(CHECK_RUNS_REASON_WRITE);
    // 反面对照：拆行的只读回读在自证步名下不违规（折叠不是「见续行就红」）。
    const splitRead = [
      'gh api "repos/$GITHUB_REPOSITORY/commits/$AUDIT_SHA/check-runs?filter=all&per_page=100" \\',
      '  --paginate --slurp > "$runs_file"',
    ].join(SH);
    expect(auditDirReferenceViolations([{ name: "结论自证：回读 Check Run", run: splitRead }], { root: dir })).toEqual([]);
  });

  it("轮十五-7：按目录树寻址的读取 —— 操作数指到目录或 . / .. / / 就是读整棵树", () => {
    const dir = mkdtempSync(join(tmpdir(), "audit-tree-read-"));
    const mustFire = [
      ["grep -rn .", "grep -rn needs_revision . > /tmp/read.txt || true" + SH],
      ["grep -r 目录", "grep -r pass scripts/" + SH],
      ["rg 无路径（默认 cwd）", "rg needs_revision" + SH],
      ["rg .", "rg -n conclusion ." + SH],
      ["ag", "ag verdict" + SH],
      ["ack", "ack needs_revision" + SH],
      ["git grep", "git grep needs_revision ." + SH],
      ["find 目录", "find scripts -name '*.mjs'" + SH],
      ["find -exec cat", "find . -name result.json -exec cat {} +" + SH],
      ["ls -R .", "ls -R ." + SH],
    ];
    for (const [label, run] of mustFire) {
      expect(treeAddressingReads(run).length, label).toBeGreaterThan(0);
      const violations = auditDirReferenceViolations([{ name: "插一步", run }], { root: dir });
      expect(violations.some((v) => v.reason.includes("按目录树寻址的读取")), label).toBe(true);
    }
    // 点名命令与操作数，不是只喊一句「有读」。
    expect(treeAddressingReads("grep -rn needs_revision ." + SH)).toEqual([{ command: "grep", target: "." }]);
    expect(treeAddressingReads("find scripts -name x" + SH)).toEqual([{ command: "find", target: "scripts" }]);
    expect(treeAddressingReads("ls -R ." + SH)).toEqual([{ command: "ls -R", target: "." }]);
  });

  it("轮十五-8：树内搜索的反面对照 —— 字面载体 / 非递归 / 通配 / 具体文件都不是这条规则", () => {
    const dir = mkdtempSync(join(tmpdir(), "audit-tree-read-neg-"));
    // 已由「未认领的 .audit 引用」接住的写法，不许在这条规则上重复计一次。
    for (const run of ["grep -n needs_revision .audit/result.json" + SH, "grep -rn needs_revision .audit" + SH]) {
      expect(treeAddressingReads(run)).toEqual([]);
    }
    expect(auditDirReferenceViolations([{ name: "插一步", run: "grep -n needs_revision .audit/result.json" + SH }], {
      root: dir,
    }).map((v) => v.reason)).toEqual(["未认领的 .audit 引用"]);
    for (const [label, run] of [
      ["非递归 grep", "grep needs_revision result.json" + SH],
      ["ls 无 -R", "ls -la scripts" + SH],
      ["通配不是目录", "grep -n pass *.json" + SH],
      ["cat 具体文件", "cat scripts/merge-gate.mjs" + SH],
      ["grep 从 stdin", "printf %s \"$body\" | grep -q needs_revision" + SH],
    ]) {
      expect(treeAddressingReads(run), label).toEqual([]);
    }
    // 正向对照：真 workflow 的每一步都没有按目录树寻址的读取。
    for (const step of steps) {
      for (const { where, text } of stepTexts(step, { root: ROOT })) {
        for (const line of String(text).split(SH)) {
          expect(treeAddressingReads(stripShellComment(line)), step.name + "/" + where).toEqual([]);
        }
      }
    }
    expect(auditDirReferenceViolations(steps, { root: ROOT, jobPayloads: carrierPayloads })).toEqual([]);
  });

  it("轮十五-9：写命令识别穿透包装词 —— find -exec / xargs / env / sudo / bash -c 之下的 cp 不隐形", () => {
    const dir = mkdtempSync(join(tmpdir(), "audit-wrapper-"));
    // 行首写法本来就被既有判据接住；这一行只是把同一个 cp 挪到包装词之后。
    const atHead = "cp /tmp/pwn.json .audit/check-run.json" + SH;
    expect(copyWriteTargets(atHead)).toContain(".audit/check-run.json");
    expect(wrappedWriteCommands(atHead)).toEqual([]);
    const canonical = "find . -name check-run.json -exec cp /tmp/pwn.json {} " + SEMI + " ; true" + SH;
    expect(wrappedWriteCommands(canonical).map((n) => n.head)).toEqual(["cp"]);
    expect(copyWriteTargets(canonical)).toEqual([]);
    const cases = [
      ["find -exec", canonical],
      ["xargs", "find . -name check-run.json | xargs cp /tmp/pwn.json" + SH],
      ["env", "env FOO=1 cp /tmp/pwn.json .audit/check-run.json" + SH],
      ["command", "command cp /tmp/pwn.json .audit/check-run.json" + SH],
      ["time", "time cp /tmp/pwn.json .audit/check-run.json" + SH],
      ["sudo", "sudo cp /tmp/pwn.json .audit/check-run.json" + SH],
      ["sudo -u", "sudo -u root cp /tmp/pwn.json .audit/check-run.json" + SH],
      ["nohup", "nohup cp /tmp/pwn.json .audit/check-run.json &" + SH],
      ["bash -c", "bash -c 'cp /tmp/pwn.json .audit/check-run.json'" + SH],
    ];
    for (const [label, run] of cases) {
      expect(wrappedWriteCommands(run).map((n) => n.head), label).toContain("cp");
      const violations = auditDirReferenceViolations([{ name: "插一步", run }], { root: dir });
      expect(violations.some((v) => v.reason.includes("包装词")), label).toBe(true);
    }
  });

  it("轮十五-10：包装词的反面对照 —— 非写命令照旧放行，真 workflow 无包装词承载写命令", () => {
    const dir = mkdtempSync(join(tmpdir(), "audit-wrapper-neg-"));
    expect(wrappedWriteCommands("sudo -u root cat README.md" + SH).map((n) => n.head)).toEqual(["cat"]);
    expect(wrappedWriteCommands("xargs -I {} echo {}" + SH).map((n) => n.head)).toEqual(["echo"]);
    expect(wrappedWriteCommands("find . -name '*.mjs'" + SH)).toEqual([]);
    expect(auditDirReferenceViolations([{ name: "插一步", run: "sudo -u root cat scripts/probe.mjs" + SH }], {
      root: dir,
    })).toEqual([]);
    for (const step of steps) {
      for (const { where, text } of stepTexts(step, { root: ROOT })) {
        for (const line of String(text).split(SH)) {
          expect(wrappedWriteCommands(stripShellComment(line)), step.name + "/" + where).toEqual([]);
        }
      }
    }
  });

  it("轮十五-11：按内容落盘 —— 解包 / 打补丁 / 还原文件都能改写被 POST 的载体", () => {
    const dir = mkdtempSync(join(tmpdir(), "audit-landing-"));
    for (const [label, run] of [
      ["tar -xf", "tar -xf .github/audit-fixture.tar -C ." + SH],
      ["tar xf", "tar xf fixture.tar" + SH],
      ["tar --extract", "tar --extract --file fixture.tar" + SH],
      ["unzip -o", "unzip -o fixture.zip -d ." + SH],
      ["cpio -id", "cpio -id < fixture.cpio" + SH],
      ["patch -p1", "patch -p1 -i fix.diff" + SH],
      ["git apply", "git apply fix.patch" + SH],
      ["git checkout --", "git checkout -- .audit/check-run.json" + SH],
      ["git restore", "git restore .audit/check-run.json" + SH],
    ]) {
      expect(contentLandingCommands(run).length, label).toBeGreaterThan(0);
      const violations = auditDirReferenceViolations([{ name: "插一步", run }], { root: dir });
      expect(violations.some((v) => v.reason.includes("按内容落盘")), label).toBe(true);
      expect(violations.map((v) => v.reason).join("|"), label).toContain("只能默认拒绝");
    }
  });

  it("轮十五-12：按内容落盘的反面对照 —— 打包不是落盘，建分支不是还原", () => {
    const dir = mkdtempSync(join(tmpdir(), "audit-landing-neg-"));
    // 打包把工作树读出去，不写回来：它不是「按内容落盘」，改的也不是载体。
    expect(contentLandingCommands("tar -cf /tmp/x.tar .audit" + SH)).toEqual([]);
    expect(contentLandingCommands("tar -czf out.tgz scripts" + SH)).toEqual([]);
    expect(contentLandingCommands("git checkout -b fix" + SH)).toEqual([]);
    expect(contentLandingCommands("git restore --staged x.json" + SH).length).toBeGreaterThan(0);
    // 打包 .audit 仍然红 —— 但红在「未认领的 .audit 引用」（读面），不是这条新规则。
    expect(auditDirReferenceViolations([{ name: "搬运", run: "tar -cf /tmp/x.tar .audit" + SH }], { root: dir }).map(
      (v) => v.reason,
    )).toEqual(["未认领的 .audit 引用"]);
    // 正向对照：真 workflow 没有一步解包 / 打补丁 / 还原文件。
    for (const step of steps) {
      for (const { where, text } of stepTexts(step, { root: ROOT })) {
        for (const line of String(text).split(SH)) {
          expect(contentLandingCommands(stripShellComment(line)), step.name + "/" + where).toEqual([]);
        }
      }
    }
    expect(auditDirReferenceViolations(steps, { root: ROOT, jobPayloads: carrierPayloads })).toEqual([]);
  });

  it("轮十五-13：结论自证步 —— 只读回读、只在 ok=1 时跑、比的是刚 POST 的 id", () => {
    const self = steps.find((step) => step.name === "结论自证：回读 Check Run");
    expect(self).toBeTruthy();
    // 形状收口：白名单里的键就够，不新增未知键。
    expect(stepKeyViolations([self], { allowed: STEP_ALLOWED_KEYS })).toEqual([]);
    expect(steps.filter((step) => String(step.name ?? "").includes("自证"))).toHaveLength(1);
    // 判不了 / 管线挂了那一轮不许自证：那时没有「本步 POST 出去的那条」可比。
    expect(String(self.if)).toContain("always()");
    expect(String(self.if)).toContain("ok == '1'");
    // 回读的是这个 sha 上的结论（commits/<sha>/check-runs 形态 + 显式 filter=all&per_page=），
    // 比的是刚 POST 出去的 id（不是重新猜一条），再比这一条的内容。
    expect(String(self.run)).toContain('"repos/$GITHUB_REPOSITORY/commits/$AUDIT_SHA/check-runs?filter=all&per_page=100"');
    expect(String(self.run)).toContain("steps.post.outputs.check_run_id");
    expect(String(self.run)).toContain('"repos/$GITHUB_REPOSITORY/check-runs/$expected"');
    expect(String(self.run)).toContain(".app.slug");
    expect(String(self.run)).toContain(".conclusion");
    // POST 步把 id 交出来，自证步才比得动。
    const post = steps.find((step) => step.name === "回写 Check Run");
    expect(post.id).toBe("post");
    expect(String(post.run)).toContain("check_run_id=");
    expect(String(post.run)).toContain("$GITHUB_OUTPUT");
    // 自证步是只读：没有任何写形态，也不碰载体。
    // 判据默认拒绝、按**逻辑命令**判（先折续行再剥 shell 注释）：
    // 只有「不带方法/取值标志的 gh api 回读」才放行 —— 枚举写拼写会漏
    // （--method patch / -Xpatch / --raw-field / curl -d 都漏过，实测）。
    expect(
      foldContinuations(String(self.run))
        .split(SH)
        .map(stripShellComment)
        .filter((line) => /\bcheck-runs\b/.test(line) && !isReadOnlyApiCall(line)),
    ).toEqual([]);
    expect(auditDirReferenceViolations([self], { root: ROOT })).toEqual([]);
    // 反面对照：把同一个 run 换个名字，放行立刻消失 —— 放行绑的是这一步，不是这个端点。
    const renamed = auditDirReferenceViolations([{ ...self, name: "别的步" }], { root: ROOT });
    expect(renamed.length).toBeGreaterThan(0);
    expect(new Set(renamed.map((v) => v.step))).toEqual(new Set(["别的步"]));
  });

  it("轮十六-1：自证回读的形态被钉住 —— commits/<sha>/check-runs?filter=all&per_page= 与 check-runs/<id>", () => {
    const dir = mkdtempSync(join(tmpdir(), "audit-self-shape-"));
    const self = steps.find((step) => step.name === "结论自证：回读 Check Run");
    expect(self).toBeTruthy();
    // 端点写回老形态（/check-runs?head_sha=）：这个端点不存在（实测 404），必须红。
    expect(
      auditDirReferenceViolations(
        [
          {
            name: "结论自证：回读 Check Run",
            run: 'gh api "repos/$GITHUB_REPOSITORY/check-runs?head_sha=$AUDIT_SHA" --paginate --slurp > "$runs_file"\n',
          },
        ],
        { root: dir },
      ).map((v) => v.reason),
    ).toEqual([CHECK_RUNS_REASON_UNKNOWN]);
    // 去掉 filter=all：默认 filter=latest 是按 name 去重的视图，「恰好一条」不许建在去重上。
    expect(
      auditDirReferenceViolations(
        [
          {
            name: "结论自证：回读 Check Run",
            run: 'gh api "repos/$GITHUB_REPOSITORY/commits/$AUDIT_SHA/check-runs?per_page=100" --paginate --slurp > "$runs_file"\n',
          },
        ],
        { root: dir },
      ),
    ).toHaveLength(1);
    // 内容回读仍必须只读：同一个端点带 PATCH 就是改写既有那条，放行立刻消失。
    expect(
      auditDirReferenceViolations(
        [
          {
            name: "结论自证：回读 Check Run",
            run: 'gh api "repos/$GITHUB_REPOSITORY/check-runs/4242" --method PATCH -f conclusion=success\n',
          },
        ],
        { root: dir },
      ),
    ).toHaveLength(1);
    // 正向对照：真实的两次只读回读都在放行里（判据不空转，也不误伤）。
    expect(auditDirReferenceViolations([self], { root: ROOT })).toEqual([]);
  });

  it("轮十七-1：自证的四字段逐列钉住 —— name 与 status 各自比的是期望常量", () => {
    const self = steps.find((step) => step.name === "结论自证：回读 Check Run");
    expect(self).toBeTruthy();
    // 「文本里出现过 name/status」只证明提到了字段：把期望值换成实得值
    // （["name", got[0], got[0]] / ["status", got[2], got[2]]）时恒真，整仓全绿（实测）。
    // 钉的是每一列的**三元组**，期望常量必须在第二格。
    const rows = String(self.run)
      .split(SH)
      .map((line) => line.trim())
      .filter((line) => /^\["[a-z.]+",/.test(line));
    expect(rows).toEqual([
      '["name", "audit", got[0]],',
      '["app.slug", "github-actions", got[1]],',
      '["status", "completed", got[2]],',
      '["conclusion", wantConclusion, got[3]],',
    ]);
    // env 读取不许自带默认值：给它补一个「看起来对」的值（"audit|github-actions|completed|success"），
    // 「回读为空」就地变成「伪造通过」—— 单改这一处时上游的 fail-closed 会先拦住，
    // 所以这条钉的是**表达式本身**（两处一起坏才是可达的伪造）。
    expect(String(self.run)).toContain('String(process.env.CONFIG || "").split("|")');
  });

  it("轮十六-2：PATCH 改写既有那条也是结论写面 —— checks.update 与 PATCH check-runs/{id}", () => {
    const dir = mkdtempSync(join(tmpdir(), "audit-workflow-patch-"));
    mkdirSync(join(dir, WORKFLOW_DIR), { recursive: true });
    writeFileSync(join(dir, WORKFLOW_DIR, "audit.yml"), readFileSync(join(ROOT, WORKFLOW_DIR, "audit.yml"), "utf8"));
    // 实测形态：先 listForRef 拿 id，再 checks.update({conclusion:"success"})。不新增记录、不换 id，
    // 只改既有那条的内容 —— 条数与 id 都看不出来，静态侧必须自己认这个拼写。
    const peer = [
      "name: peer",
      "on: pull_request",
      "jobs:",
      "  peer:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - uses: actions/github-script@v7",
      "        with:",
      "          script: |",
      '            const runs = await github.rest.checks.listForRef({ owner: "o", repo: "r", ref: "x" })',
      '            await github.rest.checks.update({ owner: "o", repo: "r", check_run_id: runs.data.check_runs[0].id, conclusion: "success" })',
      "",
    ].join(SH);
    writeFileSync(join(dir, WORKFLOW_DIR, "peer.yml"), peer);
    const violations = workflowWriteSurfaceViolations({ root: dir });
    expect(violations.map((v) => v.step)).toEqual(["peer.yml"]);
    expect(violations[0].reason).toContain("结论写面只允许 audit.yml");
    expect(workflowWriteSurfaceFiles({ root: dir })).toEqual(["audit.yml", "peer.yml"]);
    // 另外三种拼写：updateCheckRun / PATCH 直写 REST / -X PATCH。
    for (const [label, script] of [
      ["updateCheckRun", 'await updateCheckRun({ check_run_id: 1, conclusion: "success" })'],
      ["PATCH REST", 'await github.request("PATCH /repos/{owner}/{repo}/check-runs/{id}", { conclusion: "success" })'],
      ["-X PATCH", "gh api repos/o/r/check-runs/1 -X PATCH -f conclusion=success"],
    ]) {
      expect(checkRunWriteSurface(script), label).not.toBeNull();
    }
    // 反面对照：只读回读同一端点不红（自证步就是这么用的），真仓库仍然零违规。
    expect(checkRunWriteSurface("gh api repos/o/r/check-runs/4242 --jq .conclusion")).toBeNull();
    expect(checkRunWriteSurface("gh api 'repos/o/r/commits/cafebabe/check-runs?filter=all' --paginate --slurp")).toBeNull();
    expect(workflowWriteSurfaceViolations()).toEqual([]);
  });

  it("轮十八-1：请求体按短标志簇与贴值判 —— -d@body / -d'{…}' / -sSd / -Fname= 一条都不许漏", () => {
    // 旧判据要求 flag 后紧跟空白或 =：「flag 直接贴值」与「短标志簇写」两种拼法全漏（四项全绿，实测）。
    // 现在按命令判：shellWords 切词后看短标志簇里的字母（curl 的体是 d/F/T、gh 的字段是 f/F），
    // 这样 -d@body.json / -d'{...}' / -sSd '...' / -Fname=audit 是同一条判据的四个落点，不是四种词形。
    for (const [label, line] of [
      ["-d 贴文件", "curl -sS -d@body.json https://api.github.com/repos/o/r/check-runs"],
      ["-d 贴体", 'curl -sS -d\'{"name":"audit","conclusion":"success"}\' https://api.github.com/repos/o/r/check-runs'],
      ["-sSd 簇写", 'curl -sSd \'{"name":"audit","conclusion":"success"}\' https://api.github.com/repos/o/r/check-runs'],
      ["-F 贴值", "curl -sS -Fname=audit https://api.github.com/repos/o/r/check-runs"],
      ["-sS -F 分开", "curl -sS -F name=audit https://api.github.com/repos/o/r/check-runs"],
      ["-T 上传", "curl -sS -Tbody.json https://api.github.com/repos/o/r/check-runs"],
      ["gh -f 贴值", "gh api repos/o/r/check-runs --method POST -fname=audit"],
    ]) {
      expect(checkRunWriteSurface(line), label).toBe("check-runs");
    }
    // 反面对照：多一个空格的 -d @body.json 是旧判据已认的形态，必须仍然红（不是「一律红」的噪音）。
    expect(checkRunWriteSurface("curl -sS -d @body.json https://api.github.com/repos/o/r/check-runs")).toBe("check-runs");
    // 只读反例：curl 的小写 -f 是 --fail（不是请求体），-fsSL 不许被读成写。
    for (const line of [
      "curl -fsSL https://api.github.com/repos/o/r/check-runs/1",
      "curl -sS https://api.github.com/repos/o/r/commits/cafebabe/check-runs?filter=all&per_page=100",
      "wget -qO- https://api.github.com/repos/o/r/check-runs/1",
      "gh api repos/o/r/check-runs/4242 --jq .conclusion",
    ]) {
      expect(checkRunWriteSurface(line), line).toBeNull();
    }
  });

  it("轮十八-2：端点用变量时判据仍然命中 —— 写意图是命令级的，端点字面量只用于放行", () => {
    const dir = mkdtempSync(join(tmpdir(), "audit-var-endpoint-"));
    // 实测全绿（两次独立复现）：旧判据要求「端点字面量 + 写形态」同现，端点只有变量时进入条件就不成立。
    expect(
      auditDirReferenceViolations(
        [{ name: "插一步", run: 'gh api --method POST --input body.json "$ep"\n' }],
        { root: dir },
      ).map((v) => v.reason),
    ).toEqual([CHECK_RUNS_REASON_WRITE_BLIND]);
    // 端点定义在上一行也一样：判据看的是这条命令有没有写意图。
    const twoLines = ['ep="repos/o/r/check-runs"', 'gh api --method POST --input body.json "$ep"', ""].join(SH);
    expect(
      auditDirReferenceViolations([{ name: "插一步", run: twoLines }], { root: dir }).map((v) => v.reason),
    ).toContain(CHECK_RUNS_REASON_WRITE_BLIND);
    // 面判据同理：任何 workflow 里的写意图都是违规，不看端点拼写。
    expect(checkRunWriteSurface('gh api --method POST --input body.json "$ep"')).toBe("check-runs");
    // 反面对照：同一个变量端点的**只读**调用不是写面（放行的读形态仍绑在自证步上）。
    expect(checkRunWriteSurface('gh api --jq .id "$ep"')).toBeNull();
  });

  it("轮十八-3：显式只读方法不是写 —— -X GET 放行，-X PATCH 仍红，文案分得清两种原因", () => {
    // 旧判据把「写了方法名」本身当写：给真自证步的回读加 -X GET 会 5 红，且文案指成 --input POST 的写面。
    const selfRead =
      'gh api -X GET "repos/$GITHUB_REPOSITORY/commits/$AUDIT_SHA/check-runs?filter=all&per_page=100" --paginate --slurp > "$runs_file"\n';
    expect(auditDirReferenceViolations([{ name: "结论自证：回读 Check Run", run: selfRead }], { root: ROOT })).toEqual([]);
    // 面判据：纯读带显式方法仍是读。
    expect(checkRunWriteSurface("gh api -X GET repos/o/r/check-runs --jq '.[]'")).toBeNull();
    expect(checkRunWriteSurface("gh api --method GET repos/o/r/check-runs --jq '.[]'")).toBeNull();
    // -X PATCH 仍红。
    expect(checkRunWriteSurface("gh api -X PATCH repos/o/r/check-runs/1 -f conclusion=success")).toBe("check-runs");
    // 文案要能分辨「写形态」与「不可判形态」：纯读在自证步名下被拦时，原因不许说成 --input POST 的写面。
    expect(
      auditDirReferenceViolations(
        [{ name: "结论自证：回读 Check Run", run: "gh api -X GET repos/o/r/check-runs --jq '.[]'\n" }],
        { root: ROOT },
      ).map((v) => v.reason),
    ).toEqual([CHECK_RUNS_REASON_UNKNOWN]);
  });

  it("轮十八-4：自证回读的「id 最大」是数值序 —— 不同位数的 id 不许按字典序或位次", () => {
    // 夹具默认 id 4242 与同页旧 id 都是等长 4 位且升序：数值序与字典序碰巧一致，
    // sort() 与「取末位」两种错法都红不了。这里把最大的 1000 放最前：取末位得到 999（红）；
    // 字典序 sort() 得到 999（红）；只有数值序才通过。
    const out = runWorkflow({
      AUDIT_FINDINGS_A: pass,
      AUDIT_FINDINGS_B: pass,
      FAKE_GH_POST_ID: "1000",
      FAKE_GH_CHECK_RUNS_JSON: JSON.stringify({
        total_count: 2,
        check_runs: [
          { id: 1000, name: "audit", status: "completed", conclusion: "success", app: { slug: "github-actions" } },
          { id: 999, name: "audit", status: "completed", conclusion: "failure", app: { slug: "github-actions" } },
        ],
      }),
    });
    const self = out.ran.find((step) => step.name === "结论自证：回读 Check Run");
    expect(self.status, String(self.stdout) + String(self.stderr)).toBe(0);
    expect(out.summary).toBe("");
  });

  it("轮十八-5：本次 id 不是数值最大时，点名数值更大的那条 —— 999 与 1000", () => {
    const out = runWorkflow({
      AUDIT_FINDINGS_A: pass,
      AUDIT_FINDINGS_B: pass,
      FAKE_GH_POST_ID: "999",
      FAKE_GH_CHECK_RUNS_JSON: JSON.stringify({
        total_count: 2,
        check_runs: [
          { id: 999, name: "audit", status: "completed", conclusion: "success", app: { slug: "github-actions" } },
          { id: 1000, name: "audit", status: "completed", conclusion: "failure", app: { slug: "github-actions" } },
        ],
      }),
    });
    const self = out.ran.find((step) => step.name === "结论自证：回读 Check Run");
    expect(self.status).not.toBe(0);
    // 断类别标题行，不是全文：尾段说明把五类名字都列了一遍，只查子串会互相满足。
    expect(out.summary).toContain("## audit 自证失败：被更新的结论盖过");
    expect(out.summary).toContain("merge-gate 会读到 id=1000");
  });

  it("轮十八-6：非十进制 id 更严不更松 —— 排不进去也不许放过，且点名「id 无法比较」", () => {
    // 把 rank 的非十进制分支从 Infinity 改成 0（排不进去就放过）必须让这条红。
    const out = runWorkflow({
      AUDIT_FINDINGS_A: pass,
      AUDIT_FINDINGS_B: pass,
      FAKE_GH_CHECK_RUNS_JSON: JSON.stringify({
        total_count: 2,
        check_runs: [
          { id: 4242, name: "audit", status: "completed", conclusion: "success", app: { slug: "github-actions" } },
          { id: "abc", name: "audit", status: "completed", conclusion: "failure", app: { slug: "github-actions" } },
        ],
      }),
    });
    const self = out.ran.find((step) => step.name === "结论自证：回读 Check Run");
    expect(self.status).not.toBe(0);
    // 专门分类，不混进「被更新的结论盖过」：处置相同（都红），诊断不同。
    expect(out.summary).toContain("## audit 自证失败：id 无法比较");
    expect(out.summary).toContain("abc");
  });

  it("轮十八-7：反面对照 —— 真 audit.yml 的四步与良性 peer.yml 必须仍被放行", () => {
    // A–E 全是「更严」的方向：这一条钉住没把真 workflow 的合法形态误伤。
    for (const name of ["口径层判定", "结论兜底", "回写 Check Run", "判不了：回写 INFRA", "结论自证：回读 Check Run"]) {
      const step = steps.find((candidate) => candidate.name === name);
      expect(step, name).toBeTruthy();
      expect(
        auditDirReferenceViolations([{ name, run: step.run }], { root: ROOT, jobPayloads: carrierPayloads }),
        name,
      ).toEqual([]);
    }
    const dir = mkdtempSync(join(tmpdir(), "audit-benign-peer-"));
    mkdirSync(join(dir, WORKFLOW_DIR), { recursive: true });
    writeFileSync(join(dir, WORKFLOW_DIR, "audit.yml"), readFileSync(join(ROOT, WORKFLOW_DIR, "audit.yml"), "utf8"));
    writeFileSync(
      join(dir, WORKFLOW_DIR, "peer.yml"),
      ["name: peer", "jobs:", "  p:", "    steps:", "      - run: |", "          echo hi", "          gh api repos/o/r/check-runs/1", ""].join(SH),
    );
    expect(workflowWriteSurfaceViolations({ root: dir })).toEqual([]);
    // 真仓库（audit.yml 自身也在里面）零违规。
    expect(workflowWriteSurfaceViolations()).toEqual([]);
    expect(auditDirReferenceViolations(steps, { root: ROOT, jobPayloads: carrierPayloads })).toEqual([]);
  });

  it("轮十九-1：引号里的命令替换也看得见 —— id=\"$(gh api …)\" 与不加引号是同一条命令", () => {
    // 旧 shellWords 先切引号再切分隔符，整段引号被并成一个词：id="$(…)" 里的 gh api 既不是命令头也不是边界。
    // 红绿只差一对引号，而 id="$(…)" 正是 shellcheck 推荐写法 —— 这两种写法必须同命运。
    const dir = mkdtempSync(join(tmpdir(), "audit-subst-"));
    for (const [label, marker] of [
      ["双引号包住命令替换", 'id="$(gh api --method POST --input body.json "$ep")"'],
      ["不加引号（对照）", "id=$(gh api --method POST --input body.json \"$ep\")"],
    ]) {
      const run = ['ep="repos/o/r/check-runs"', marker, 'echo "$id"', ""].join(SH);
      const got = auditDirReferenceViolations([{ name: "插一步", run }], { root: dir });
      expect(got.some((v) => v.excerpt.includes("gh api --method POST --input body.json")), label).toBe(true);
    }
    // 面判据同样不看引号。
    expect(checkRunWriteSurface('id="$(gh api --method POST --input body.json repos/o/r/check-runs)"')).toBe("check-runs");
    // 反面对照 1：无关的命令替换仍然不是写面（echo "$(date)" 之类）。
    expect(checkRunWriteSurface('echo "$(date)"')).toBeNull();
    expect(auditDirReferenceViolations([{ name: "插一步", run: 'echo "$(date)"' + SH + "echo hi" + SH }], { root: dir })).toEqual(
      [],
    );
    // 反面对照 2：只读回读藏在替换里也仍是只读。
    expect(checkRunWriteSurface('id="$(gh api repos/o/r/check-runs/1 --jq .id)"')).toBeNull();
    // 单引号里的 $() 是字面量（shell 不展开），判据也不展开 —— 不制造假红。
    expect(checkRunWriteSurface("echo '$(gh api --method POST --input body.json repos/o/r/check-runs)'")).toBeNull();
  });

  it("轮十九-2：标志位藏进变量也看得见 —— F=\"-d @body.json\"; curl $F … 与直接写 -d 等价", () => {
    const dir = mkdtempSync(join(tmpdir(), "audit-flag-var-"));
    const run = ['F="-d @body.json"', "curl -sS $F https://api.github.com/repos/o/r/check-runs", ""].join(SH);
    // 端点字面量在，原因只能是「写形态」：全部差异来自 $F 被展开成 -d。
    expect(auditDirReferenceViolations([{ name: "插一步", run }], { root: dir }).map((v) => v.reason)).toEqual([
      CHECK_RUNS_REASON_WRITE,
    ]);
    expect(checkRunWriteSurface('F="-d @body.json"; curl -sS $F https://api.github.com/repos/o/r/check-runs')).toBe(
      "check-runs",
    );
    // 变量也用在端点那侧：良性 URL 由变量给出时照样判成良性写，而不是「不可判」。
    const benignRun = [
      'U="https://hooks.slack.com/services/T/B/X"',
      "curl -sS -X POST \"$U\" -d '{\"text\":\"ok\"}'",
      "",
    ].join(SH);
    expect(auditDirReferenceViolations([{ name: "插一步", run: benignRun }], { root: dir })).toEqual([]);
    // 反面对照：赋值值里带 $( 的不展开（单趟），只读调用不许被撑成写。
    expect(checkRunWriteSurface('F="$(cat body.json)"; curl -sS $F https://api.github.com/repos/o/r/check-runs/1')).toBeNull();
  });

  it("轮十九-3：写面是「端点 + 写形态」—— 兄弟 workflow 的良性写不是第二条 Check Run", () => {
    const dir = mkdtempSync(join(tmpdir(), "audit-benign-write-"));
    mkdirSync(join(dir, WORKFLOW_DIR), { recursive: true });
    writeFileSync(join(dir, WORKFLOW_DIR, "audit.yml"), readFileSync(join(ROOT, WORKFLOW_DIR, "audit.yml"), "utf8"));
    writeFileSync(
      join(dir, WORKFLOW_DIR, "notify.yml"),
      [
        "name: notify",
        "jobs:",
        "  notify:",
        "    steps:",
        "      - run: |",
        "          curl -sS -X POST https://hooks.slack.com/services/T/B/X -d '{\"text\":\"ok\"}'",
        "          gh api repos/o/r/issues/1/comments -f body=hi",
        "",
      ].join(SH),
    );
    // 旧判据把这两行判成「同名的第二条 Check Run」：合法的告警与评论写全被误杀。
    expect(workflowWriteSurfaceViolations({ root: dir })).toEqual([]);
    // 端点不可判仍然默认拒绝（轮十八-2 不许被这次放宽带走）。
    expect(checkRunWriteSurface('gh api --method POST --input body.json "$ep"')).toBe("check-runs");
    expect(checkRunWriteSurface("curl -sS -X POST -d @body.json https://api.github.com/repos/o/r/check-runs")).toBe(
      "check-runs",
    );
    // 真仓库（audit.yml 自身也在里面）零违规。
    expect(workflowWriteSurfaceViolations()).toEqual([]);
    // 已知边界、不是意外：gh api 路径里带变量就不可判 —— $EP 可能就展开成 check-runs，宁可拒绝。
    expect(checkRunWriteSurface("gh api repos/$GITHUB_REPOSITORY/issues/1/comments -f body=hi")).toBe("check-runs");
  });

  it("轮十九-4：httpie 的体是独立成词的 k=v —— 查询参数 k==v 与 URL 里的 ?a=1 不是写", () => {
    // 旧判据 if (text.includes("=")) return true 把整行任意等号当体：URL 自带的 ?a=1 就能把纯读判成写。
    for (const [label, line] of [
      ["xh get page==1", "xh get https://api.github.com/repos/o/r/check-runs page==1"],
      ["http GET ?a=1", "http GET 'https://api.github.com/repos/o/r/check-runs?a=1'"],
      ["httpie GET 带头", "http GET https://api.github.com/repos/o/r/check-runs X-Trace:1"],
    ]) {
      expect(checkRunWriteSurface(line), label).toBeNull();
    }
    // 正面对照：独立成词的 k=v / k:=v 仍算体（httpie 真正发写请求的形态）。
    expect(checkRunWriteSurface("http POST https://api.github.com/repos/o/r/check-runs name=audit")).toBe("check-runs");
    expect(commandWriteIntent("xh post https://example.com/x retries:=3")).toBe(true);
    expect(commandWriteIntent("xh get https://example.com/x per_page==100")).toBe(false);
  });

  it("轮十九-5：curl 的 -G/--get 把体翻成查询串 —— 那是读，不是写", () => {
    // 旧判据只看 -d/--data*：-G 把同一个 -d 变成 URL 查询串，读被认成写。
    for (const [label, line] of [
      ["-G -d", "curl -sS -G -d per_page=100 https://api.github.com/repos/o/r/check-runs"],
      [
        "--get --data-urlencode",
        "curl -sS --get --data-urlencode 'per_page=100' https://api.github.com/repos/o/r/check-runs",
      ],
      ["短标志簇里的 G", "curl -sG -d filter=all https://api.github.com/repos/o/r/check-runs"],
    ]) {
      expect(checkRunWriteSurface(line), label).toBeNull();
    }
    // 对照：没有 -G 的同一个 -d 就是写 —— 差异只能来自 -G。
    expect(checkRunWriteSurface("curl -sS -d per_page=100 https://api.github.com/repos/o/r/check-runs")).toBe("check-runs");
    // -G 不是免死金牌：显式写方法仍然是写。
    expect(
      checkRunWriteSurface("curl -sS -G -X POST -d '{\"name\":\"audit\"}' https://api.github.com/repos/o/r/check-runs"),
    ).toBe("check-runs");
  });

  it("轮十九-6：短标志簇按 shell 语义停在取值字母 —— 方法不许漏，也不许靠字母蒙中", () => {
    // 旧判据把整簇字母当开关扫：-sXPATCH 靠 PATCH 里的 T 命中 curl 的体字母 dFT（理由错），
    // 而 -sX PATCH、--request DELETE 因为 X 不在簇首、长别名没登记，直接漏成 null。
    for (const [label, line] of [
      ["-sX PATCH", "curl -sX PATCH https://api.github.com/repos/o/r/check-runs/1"],
      ["-sXPATCH 贴值", "curl -sXPATCH https://api.github.com/repos/o/r/check-runs/1"],
      ["--request DELETE", "curl --request DELETE https://api.github.com/repos/o/r/check-runs/1"],
      ["gh -Xpatch", "gh api repos/o/r/check-runs/1 -Xpatch -f conclusion=success"],
    ]) {
      expect(checkRunWriteSurface(line), label).toBe("check-runs");
    }
    // 方法就是认出来的那一个，不是「簇里字母恰好含 dFT」：GET 必须放行。
    expect(checkRunWriteSurface("curl -sX GET https://api.github.com/repos/o/r/check-runs/1")).toBeNull();
    expect(checkRunWriteSurface("curl -sXGET https://api.github.com/repos/o/r/check-runs/1")).toBeNull();
    // 反面对照：-f 对 curl 是 --fail（不是体），-fsSL 不是写。
    expect(checkRunWriteSurface("curl -fsSL https://api.github.com/repos/o/r/check-runs/1")).toBeNull();
  });

  it("轮十九-7：命令替换跟不下去就别装没看见 —— 嵌套超过 3 层必须响", () => {
    const dir = mkdtempSync(join(tmpdir(), "audit-subst-depth-"));
    // 写命令在第 4 层：静态层不再展开，但必须落一条「跟不下去」，不许静默当无。
    const deep = 'id="$(printf %s $(printf %s $(printf %s $(gh api --method POST --input body.json))))"' + SH;
    expect(
      auditDirReferenceViolations([{ name: "插一步", run: deep }], { root: dir }).map((v) => v.reason),
    ).toContain(SUBSTITUTION_DEPTH_REASON);
    // 第 3 层仍在射程内：同一条写命令作为命令级写意图被拒（原因走 BLIND：端点不是字面量）。
    const edge = 'id="$(printf %s $(printf %s $(gh api --method POST --input body.json)))"' + SH;
    expect(auditDirReferenceViolations([{ name: "插一步", run: edge }], { root: dir }).map((v) => v.reason)).toEqual([
      CHECK_RUNS_REASON_WRITE_BLIND,
    ]);
  });

  it("轮十九-8：反面对照 —— 只读回读 + echo hi 的 peer.yml 与真 audit.yml 四步仍全绿", () => {
    const dir = mkdtempSync(join(tmpdir(), "audit-benign-peer2-"));
    mkdirSync(join(dir, WORKFLOW_DIR), { recursive: true });
    writeFileSync(join(dir, WORKFLOW_DIR, "audit.yml"), readFileSync(join(ROOT, WORKFLOW_DIR, "audit.yml"), "utf8"));
    writeFileSync(
      join(dir, WORKFLOW_DIR, "peer.yml"),
      [
        "name: peer",
        "jobs:",
        "  p:",
        "    steps:",
        "      - run: |",
        "          echo hi",
        "          gh api repos/o/r/check-runs/1 --jq .conclusion",
        "",
      ].join(SH),
    );
    expect(workflowWriteSurfaceViolations({ root: dir })).toEqual([]);
    for (const name of ["口径层判定", "结论兜底", "回写 Check Run", "判不了：回写 INFRA", "结论自证：回读 Check Run"]) {
      const step = steps.find((candidate) => candidate.name === name);
      expect(step, name).toBeTruthy();
      expect(
        auditDirReferenceViolations([{ name, run: step.run }], { root: ROOT, jobPayloads: carrierPayloads }),
        name,
      ).toEqual([]);
    }
    expect(workflowWriteSurfaceViolations()).toEqual([]);
    expect(auditDirReferenceViolations(steps, { root: ROOT, jobPayloads: carrierPayloads })).toEqual([]);
  });

  // ---- 轮二十：审计闸门自己的六条静态绕过（判据的自我防护） ----
  it("轮二十-1：端点是 shell 拼出来的一个词 —— 引号切开 URL 不许把端点读残", () => {
    // shell 把 "…/check-"runs 拼成一个词；原始文本正则只取到 …/check-，写面整个消失。
    for (const [label, line] of [
      ["gh api 引号拼接", 'gh api "https://api.github.com/repos/o/r/check-"runs -f conclusion=success'],
      ["curl 引号拼接", 'curl -sS -X POST -d @body.json https://api.github.com/repos/o/r/"check-"runs'],
      ["gh api 拼出来的是路径", 'gh api repos/o/r/"check-"runs --method POST --input body.json'],
    ]) {
      expect(checkRunWriteSurface(line), label).toBe("check-runs");
    }
    // 反面对照：同一个写法落在只读方法上仍是读，拼词规则不许把它撑成写。
    expect(checkRunWriteSurface('curl -sS -X GET https://api.github.com/repos/o/r/"check-"runs')).toBeNull();
    expect(checkRunWriteSurface('gh api repos/o/r/"check-"runs --jq .[].id')).toBeNull();
  });

  it("轮二十-2：判定单位是这一次调用的端点 —— 同行另一个良性 URL 洗不白未知端点", () => {
    const dir = mkdtempSync(join(tmpdir(), "audit-endpoint-unit-"));
    const steps = [
      { name: "插一步", run: ['curl -sS -X POST -d @body.json https://hooks.slack.com/x "$EP"', ""].join(SH) },
      {
        name: "带头的插一步",
        run: ['gh api -H "X-Url: https://hooks.slack.com/x" --method POST --input body.json "$EP"', ""].join(SH),
      },
    ];
    for (const step of steps) {
      // 同行那个良性 URL 不能让这次调用的未知端点变成「良性」：理由是写形态，不是「不可判形态」。
      expect(auditDirReferenceViolations([step], { root: dir }).map((v) => v.reason), step.name).toEqual([
        CHECK_RUNS_REASON_WRITE_BLIND,
      ]);
    }
    expect(checkRunWriteSurface('curl -sS -X POST -d @body.json https://hooks.slack.com/x "$EP"')).toBe("check-runs");
    expect(
      checkRunWriteSurface('gh api -H "X-Url: https://hooks.slack.com/x" --method POST --input body.json "$EP"'),
    ).toBe("check-runs");
    // 对照：同行没有良性 URL 的老绕过仍然红（同一套判据，不靠拼写枚举）。
    expect(checkRunWriteSurface('gh api --method POST --input body.json "$EP"')).toBe("check-runs");
    // 反面对照 1：纯非 GitHub 目标 + 写体 —— 端点良性就不红。
    expect(checkRunWriteSurface("curl -sS -X POST https://hooks.slack.com/services/T/B/X -d '{\"text\":\"ok\"}'")).toBeNull();
    // 反面对照 2：gh api 的别条路径（评论）。
    expect(checkRunWriteSurface("gh api repos/o/r/issues/1/comments -f body=hi")).toBeNull();
    // 反面对照 3：httpie 的查询参数是读。
    expect(checkRunWriteSurface("xh get https://status.example.com/api/health page==1")).toBeNull();
    // 反面对照 4：curl -G 把体翻成查询串，也是读。
    expect(checkRunWriteSurface("curl -sS -G -d per_page=100 https://api.github.com/repos/o/r/check-runs")).toBeNull();
  });

  it("轮二十-3：双引号里的撇号是字面量 —— 不许靠它把命令替换挡在深度闸门之外", () => {
    const dir = mkdtempSync(join(tmpdir(), "audit-apostrophe-"));
    const apostrophe = 'id="note: don\'t; $(gh api repos/o/r/check-runs --method POST --input body.json)"';
    expect(substitutionExpansion(apostrophe).bodies.some((body) => body.includes("gh api"))).toBe(true);
    expect(checkRunWriteSurface(apostrophe)).toBe("check-runs");
    expect(
      auditDirReferenceViolations([{ name: "插一步", run: apostrophe + SH }], { root: dir }).map((v) => v.reason),
    ).toEqual([CHECK_RUNS_REASON_WRITE]);
    // 对照：同一行去掉撇号仍红（差异只能来自引号状态机）。
    expect(checkRunWriteSurface('id="note: do not; $(gh api repos/o/r/check-runs --method POST --input body.json)"')).toBe(
      "check-runs",
    );
    // 反面对照：双引号里的撇号不会把只读替换撑成写。
    expect(checkRunWriteSurface('echo "don\'t run $(echo hi)"')).toBeNull();
    // 反面对照：单引号里的 $() 依然是字面量（轮十九-1 已钉，这里守同一件事）。
    expect(checkRunWriteSurface("echo '$(gh api --method POST --input body.json repos/o/r/check-runs)'")).toBeNull();
  });

  it("轮二十-4：赋值一跳跟不动就响 —— 值里含变量的链不许把写意图整个吞掉", () => {
    const dir = mkdtempSync(join(tmpdir(), "audit-alias-chain-"));
    const chain = [
      'A="-X POST -f name=audit -f conclusion=success"',
      "B=$A",
      "gh api repos/o/r/check-runs $B",
      "",
    ].join(SH);
    expect(auditDirReferenceViolations([{ name: "插一步", run: chain }], { root: dir }).map((v) => v.reason)).toEqual([
      CHECK_RUNS_REASON_WRITE,
    ]);
    // 对照：单跳赋值仍然红，理由同为写形态。
    const single = ['B="-X POST -f conclusion=success"', "gh api repos/o/r/check-runs $B", ""].join(SH);
    expect(auditDirReferenceViolations([{ name: "插一步", run: single }], { root: dir }).map((v) => v.reason)).toEqual([
      CHECK_RUNS_REASON_WRITE,
    ]);
    // 跟不动（值来自未定义/环境变量）不许当成「没有赋值」：落命令级默认拒绝，理由指向赋值层。
    const envChain = ["B=$EXTERNAL_FLAGS", "gh api repos/o/r/check-runs $B", ""].join(SH);
    expect(auditDirReferenceViolations([{ name: "插一步", run: envChain }], { root: dir }).map((v) => v.reason)).toEqual([
      ASSIGNMENT_UNRESOLVED_REASON,
    ]);
    // 反面对照：命令替换体的赋值不冒充可判形态（静态层不展开），只读调用不许被撑成写（轮十九-2 已钉）。
    expect(checkRunWriteSurface('F="$(cat body.json)"; curl -sS $F https://api.github.com/repos/o/r/check-runs/1')).toBeNull();
  });

  it("轮二十-5：赋值表超过上限要响 —— 截断不是「没有赋值」", () => {
    const dir = mkdtempSync(join(tmpdir(), "audit-assignment-cap-"));
    const lines = [];
    for (let i = 0; i < 32; i += 1) lines.push("V" + i + "=1");
    lines.push('B="-X POST -f conclusion=success"', "gh api repos/o/r/check-runs $B", "");
    const run = lines.join(SH);
    expect(simpleAssignments(run).truncated).toBe(true);
    expect(auditDirReferenceViolations([{ name: "插一步", run }], { root: dir }).map((v) => v.reason)).toEqual([
      ASSIGNMENT_TRUNCATED_REASON,
    ]);
    // 反面对照：上限以内的同名表照旧跟得住，理由仍是写形态而不是截断。
    const small = ["V0=1", 'B="-X POST -f conclusion=success"', "gh api repos/o/r/check-runs $B", ""].join(SH);
    expect(auditDirReferenceViolations([{ name: "插一步", run: small }], { root: dir }).map((v) => v.reason)).toEqual([
      CHECK_RUNS_REASON_WRITE,
    ]);
  });

  it("轮二十-6：赋值只是段首那个词 —— 分号后、命令替换正文里的赋值同样看得见", () => {
    const dir = mkdtempSync(join(tmpdir(), "audit-segment-assign-"));
    const sameLine = [
      'echo hi; B="-X POST -f name=audit -f conclusion=success"; gh api repos/o/r/check-runs $B',
      "",
    ].join(SH);
    expect(auditDirReferenceViolations([{ name: "插一步", run: sameLine }], { root: dir }).map((v) => v.reason)).toEqual([
      CHECK_RUNS_REASON_WRITE,
    ]);
    const inSubstitution = ['x="$( F="-X POST -f conclusion=success"; gh api repos/o/r/check-runs $F )"', ""].join(SH);
    expect(
      auditDirReferenceViolations([{ name: "插一步", run: inSubstitution }], { root: dir }).map((v) => v.reason),
    ).toEqual([CHECK_RUNS_REASON_WRITE]);
    // 对照：同样内容拆成三行仍然红（差异只能来自「赋值只认行首」）。
    const threeLines = ['B="-X POST -f name=audit -f conclusion=success"', "gh api repos/o/r/check-runs $B", ""].join(SH);
    expect(auditDirReferenceViolations([{ name: "插一步", run: threeLines }], { root: dir }).map((v) => v.reason)).toEqual([
      CHECK_RUNS_REASON_WRITE,
    ]);
    // 反面对照：段内的良性赋值 + 良性写调用不制造假红。
    const benign = [
      "echo hi; U=\"https://hooks.slack.com/services/T/B/X\"; curl -sS -X POST \"$U\" -d '{\"text\":\"ok\"}'",
      "",
    ].join(SH);
    expect(auditDirReferenceViolations([{ name: "告警", run: benign }], { root: dir })).toEqual([]);
  });


  it("轮二十一-1：端点词看得见而实参跟不下去 → 这一次调用不可判，默认拒绝", () => {
    const dir = mkdtempSync(join(tmpdir(), "audit-spliced-endpoint-"));
    // 相邻引号段在 shell 里是**一个**词，端点解析先去掉词里的引号再判路径。
    // （shellWords 已经合并相邻引号段，这是第二道；这里直接把解析出来的路径钉住。）
    expect(resolveEndpoint('repos/o/r/check-"runs', true)).toEqual({ host: "api.github.com", path: "repos/o/r/check-runs" });
    expect(resolveEndpoint("repos/o/r/check-'runs", true).path).toBe("repos/o/r/check-runs");
    // 同一个端点，实参是一层跟不下去的赋值：端点看得见、写意图看不见 → 默认拒绝。
    const spliced = 'EP="repos/o/r/check-""runs"; FLAGS=$GH_FLAGS; gh api "$EP" $FLAGS';
    expect(checkRunWriteSurface(spliced)).toBe("check-runs");
    expect(
      auditDirReferenceViolations([{ name: "插一步", run: spliced + SH }], { root: dir }).map((v) => v.reason),
    ).toEqual([ASSIGNMENT_UNRESOLVED_REASON]);
    // 对照 1：同一个跟不下去的实参挂在别的 GitHub 端点上（不是结论写面）→ 仍然放行。
    // 窄化守卫只装在「端点解析成功且落在写面上」这一档，不是装回函数顶部。
    expect(checkRunWriteSurface("FLAGS=$GH_FLAGS; gh api repos/o/r/issues/1 $FLAGS")).toBeNull();
    // 对照 2：可证明的只读回读（check-runs/<id>）没有盲实参 → 仍然放行。
    expect(checkRunWriteSurface("gh api repos/o/r/check-runs/1 --jq .conclusion")).toBeNull();
    // 对照 3：字面量良性端点上的写调用照旧放行（curl -X POST 打 Slack）。
    expect(checkRunWriteSurface("curl -sS -X POST https://hooks.slack.com/x -d @body.json")).toBeNull();
    // 对照 4：gh api 的别条路径（评论）。
    expect(checkRunWriteSurface("gh api repos/o/r/issues/1/comments -f body=hi")).toBeNull();
  });

  it("轮二十一-2：解释器包装里的程序字符串继续被扫描 —— 套一层引号不算藏起来", () => {
    const dir = mkdtempSync(join(tmpdir(), "audit-interpreter-wrapper-"));
    const program = "gh api repos/o/r/check-runs --method POST -f name=audit -f conclusion=success";
    // 裸写与三种包装必须同红：整条命令外面套一层引号程序不改变它做了什么。
    expect(checkRunWriteSurface(program)).toBe("check-runs");
    for (const wrapped of ["bash -c '" + program + "'", 'sh -c "' + program + '"', 'eval "' + program + '"']) {
      expect(checkRunWriteSurface(wrapped)).toBe("check-runs");
    }
    expect(
      auditDirReferenceViolations([{ name: "插一步", run: "bash -c '" + program + "'" + SH }], { root: dir }).map(
        (v) => v.reason,
      ),
    ).toEqual([CHECK_RUNS_REASON_WRITE]);
    // 包装叠到深度上限之外：落 overflow —— 响，不许静默丢。
    let deep = "gh api repos/o/r/check-runs --method POST -f conclusion=success";
    for (let i = 0; i < 4; i += 1) deep = "bash -c " + JSON.stringify(deep);
    expect(httpCalls(deep).overflow.map((gap) => gap.kind)).toContain("depth");
    expect(checkRunWriteSurface(deep)).toBe("check-runs");
    // 非 shell 解释器的内联程序：读不懂别的语言，但正文提到结论写面就必须响。
    const python =
      "python3 -c \"import requests; requests.post('https://api.github.com/repos/o/r/check-runs', json={})\"";
    expect(httpCalls(python).overflow.map((gap) => gap.kind)).toContain("non-shell-inline");
    expect(checkRunWriteSurface(python)).toBe("check-runs");
    // 反面对照 1：包装里的良性程序。
    expect(checkRunWriteSurface('bash -c "echo hi"')).toBeNull();
    expect(checkRunWriteSurface('eval "echo hi"')).toBeNull();
    // 反面对照 2：别的语言里没有结论写面字样，不制造假红（audit.yml 自己有 4 处 node -e）。
    expect(checkRunWriteSurface('node -e "console.log(1)"')).toBeNull();
    expect(checkRunWriteSurface('python3 -c "print(1)"')).toBeNull();
    // 反面对照 3：包装里的只读回读同样放行。
    expect(checkRunWriteSurface("bash -c 'gh api repos/o/r/check-runs/1 --jq .conclusion'")).toBeNull();
  });

  it("轮二十一-3：豁免只覆盖它自己那一次调用 —— 同一行追第二条 check-runs 写就是违规", () => {
    const dir = mkdtempSync(join(tmpdir(), "audit-sanction-unit-"));
    const postStep = "回写 Check Run";
    const post = "gh api repos/o/r/check-runs --method POST --input .audit/check-run.json --jq '.id'";
    // 既有形状：这一步的那一条 POST 调用 → 放行（整行判与逐次判在这里同答案）。
    expect(checkRunSanctioned(postStep, post, simpleAssignments(post))).toBe(true);
    // 同一行追第二条 check-runs 写：整行看仍「有 POST + 有 --input」，逐次调用看第二条不在白名单里。
    const doubled = post + " ; gh api repos/o/r/check-runs/1 --method PATCH -f conclusion=success";
    expect(checkRunSanctioned(postStep, doubled, simpleAssignments(doubled))).toBe(false);
    expect(
      auditDirReferenceViolations([{ name: postStep, run: doubled + SH }], { root: dir }).map((v) => v.reason),
    ).toEqual([CHECK_RUNS_REASON_WRITE]);
    // 对照 1：自证步的两条只读回读，逐次判仍然各自放行。
    const readStep = "结论自证：回读 Check Run";
    const readList =
      'gh api "repos/o/r/commits/abc/check-runs?filter=all&per_page=100" --paginate --slurp > "$runs_file"';
    const readOne = 'gh api "repos/o/r/check-runs/123" --jq ".conclusion"';
    const readText = [readList, readOne, ""].join(SH);
    expect(checkRunSanctioned(readStep, readList, simpleAssignments(readText))).toBe(true);
    expect(checkRunSanctioned(readStep, readOne, simpleAssignments(readText))).toBe(true);
    // 对照 2：同一行里第二条是写，即使第一条是回读也违规（豁免不按「这一行有回读」发）。
    const readThenWrite = readOne + " ; gh api repos/o/r/check-runs/1 --method POST -f conclusion=success";
    expect(checkRunSanctioned(readStep, readThenWrite, simpleAssignments(readThenWrite))).toBe(false);
    // 对照 3：文案行里提到 check-runs、但没有一次 http 调用 → 沿用文本级白名单（不是新的红）。
    const prose = 'fail("拿不到", "按 id 回读单条（GET repos/{owner}/{repo}/check-runs/<id>）非 0")';
    expect(httpCalls(prose).length).toBe(0);
    expect(checkRunSanctioned(readStep, prose, simpleAssignments(prose))).toBe(true);
  });

  it("轮二十一-4：赋值的门不止段首 NAME= —— readonly/declare/printf -v 与子 shell 都看得见", () => {
    const dir = mkdtempSync(join(tmpdir(), "audit-assignment-forms-"));
    const value = "-X POST -f name=audit -f conclusion=success";
    const forms = [
      'readonly FLAGS="' + value + '"; gh api "repos/o/r/check-runs" $FLAGS',
      'declare -x FLAGS="' + value + '"; gh api "repos/o/r/check-runs" $FLAGS',
      'typeset FLAGS="' + value + '"; gh api "repos/o/r/check-runs" $FLAGS',
      'local FLAGS="' + value + '"; gh api "repos/o/r/check-runs" $FLAGS',
      '( FLAGS="' + value + '" ); gh api "repos/o/r/check-runs" $FLAGS',
      '{ FLAGS="' + value + '"; } ; gh api "repos/o/r/check-runs" $FLAGS',
      'printf -v FLAGS "%s" "' + value + '"; gh api "repos/o/r/check-runs" $FLAGS',
    ];
    for (const form of forms) {
      expect(simpleAssignments(form).get("FLAGS")).toBe(value);
      expect(
        auditDirReferenceViolations([{ name: "插一步", run: form + SH }], { root: dir }).map((v) => v.reason),
      ).toEqual([CHECK_RUNS_REASON_WRITE]);
    }
    // 对照 1：命令前缀赋值不记成赋值记录（`A=1 gh api` 这种前缀在 shell 下不参与实参展开）—— 保持现状。
    expect(simpleAssignments("A=1 gh api repos/o/r/check-runs $A").has("A")).toBe(false);
    // 对照 2：不是段首的 `readonly F=` 不是赋值（引号里的字面量）。
    expect(simpleAssignments("echo 'readonly FLAGS=-X POST'").has("FLAGS")).toBe(false);
    // 对照 3：良性形态不制造假红。
    const benign = 'declare -x U="https://hooks.slack.com/x"; curl -sS -X POST "$U" -d \'{"text":"ok"}\'';
    expect(auditDirReferenceViolations([{ name: "告警", run: benign + SH }], { root: dir })).toEqual([]);
  });

  it("轮二十一-5：值带 $ 的赋值不落表 —— 由「端点可见 + 意图不可见」兜住", () => {
    const dir = mkdtempSync(join(tmpdir(), "audit-value-dollar-"));
    const line = 'FLAGS="$(cat flags)"; gh api "repos/o/r/check-runs" $FLAGS';
    // 值带 $ / 反引号的赋值**不落表**，也不进 unresolved：这是赋值层的已知静默，
    // 方向是「不许把良性 Slack 调用因为一个跟不下去的实参弄红」，所以不在这里加响。
    // 它不是靠赋值层兜住的：端点看得见、写意图看不见 → 不可判形态默认拒绝。
    expect(simpleAssignments(line).has("FLAGS")).toBe(false);
    expect(simpleAssignments(line).unresolved.has("FLAGS")).toBe(false);
    expect(checkRunWriteSurface(line)).toBeNull();
    expect(
      auditDirReferenceViolations([{ name: "插一步", run: line + SH }], { root: dir }).map((v) => v.reason),
    ).toEqual([CHECK_RUNS_REASON_UNKNOWN]);
    // 反面对照 1：同一个跟不下去的实参挂在别的 host 上（只读）→ 仍然放行。
    expect(checkRunWriteSurface('FLAGS="$(cat flags)"; curl -sS https://hooks.slack.com/x $FLAGS')).toBeNull();
    // 反面对照 2：可证明的只读回读不因为一个跟不下去的实参就变写。
    expect(checkRunWriteSurface("gh api repos/o/r/check-runs/1 --jq .conclusion")).toBeNull();
  });
});
  it("轮二十二-1：命令头不是字面量时不静默消失 —— 落 overflow，写面照响（F1）", () => {
    const SH = String.fromCharCode(10);
    const dir = mkdtempSync(join(tmpdir(), "audit-dynamic-head-"));
    // 六种动态头：shell 里展开出来都是 gh / curl / bash，静态层解不出展开结果。
    // 修前它们全部「看不见这次调用」，于是整条命令消失（实测 173 条全绿；把 gh$E 换成 gh 就红 8 条）。
    const write = "api repos/o/r/check-runs/1 -X PATCH -f conclusion=success";
    const forms = [
      ["前缀变量头 gh$E", "E=; gh$E " + write],
      ["命令替换头 $(echo gh)", "$(echo gh) " + write],
      ["反引号头", "\x60echo gh\x60 " + write],
      ["变量头 $GH_CLI", "$GH_CLI " + write],
      ["curl 前缀变量头 curl$E", "curl$E -X POST https://api.github.com/repos/o/r/check-runs"],
      ["shell 包装动态头 bash$E -c", "bash$E -c 'gh " + write + "'"],
    ];
    for (const [label, line] of forms) {
      // 静态层看不见这次调用，但必须响：overflow 非空即判写面。
      expect(checkRunWriteSurface(line), label).toBe("check-runs");
      expect(
        auditDirReferenceViolations([{ name: "插一步", run: line + SH }], { root: dir }).length,
        label,
      ).toBeGreaterThan(0);
    }
    // 良性反面对照 1：命令头是 gh 字面量的**只读**回读，动态头修法不许把它弄红。
    expect(checkRunWriteSurface("gh api repos/o/r/check-runs/1 --jq .conclusion")).toBeNull();
    expect(checkRunWriteSurface("gh api repos/o/r/commits/abc/check-runs --paginate --slurp")).toBeNull();
    // 良性反面对照 2：带 $ 的词不是「命令头 + 调用实参」，不制造假红。
    for (const [label, line] of [
      ["不是调用（gh pr view）", "gh$E pr view --json number"],
      ["只是打印这个变量", "echo gh$E"],
      ["变量在实参位置", "gh api repos/$GITHUB_REPOSITORY/check-runs/1 --jq .conclusion"],
      ["别的变量名不像客户端", "$OUT_DIR -X POST https://hooks.slack.com/x"],
    ]) {
      expect(checkRunWriteSurface(line), label).toBeNull();
    }
  });

  it("轮二十二-2：折叠标量也是命令边界 —— >- 与 | 的载荷整体判（F2）", () => {
    const SH = String.fromCharCode(10);
    const dir = mkdtempSync(join(tmpdir(), "audit-folded-scalar-"));
    mkdirSync(join(dir, WORKFLOW_DIR), { recursive: true });
    writeFileSync(join(dir, WORKFLOW_DIR, "audit.yml"), readFileSync(join(ROOT, WORKFLOW_DIR, "audit.yml"), "utf8"));
    const peer = (head, body) =>
      [
        "name: peer",
        "on: pull_request",
        "jobs:",
        "  peer:",
        "    runs-on: ubuntu-latest",
        "    steps:",
        "      - run: " + head,
        ...body.map((line) => "          " + line),
        "",
      ].join(SH);
    const writeLines = ["gh api repos/$GITHUB_REPOSITORY/check-runs/1", "-X PATCH -f conclusion=success"];
    // (a) 折叠标量：端点与写形态分在两个物理行，YAML 把两行折成**一条**命令。
    // 同一份文件、按解析出的 steps 判的 auditDirReferenceViolations 早就报 1 条，
    // 而按物理行判的入口一条都看不见 —— 判据的单位必须是命令，不是源码排版。
    writeFileSync(join(dir, WORKFLOW_DIR, "peer.yml"), peer(">-", writeLines));
    expect(
      YAML.parse(readFileSync(join(dir, WORKFLOW_DIR, "peer.yml"), "utf8")).jobs.peer.steps[0].run.trim(),
    ).toBe("gh api repos/$GITHUB_REPOSITORY/check-runs/1 -X PATCH -f conclusion=success");
    expect(workflowWriteSurfaceViolations({ root: dir }).map((v) => v.step)).toEqual(["peer.yml"]);
    expect(workflowWriteSurfaceViolations({ root: dir }).map((v) => v.where)).toEqual(["check-runs"]);
    expect(workflowWriteSurfaceFiles({ root: dir })).toEqual(["audit.yml", "peer.yml"]);
    // (b) 字面块保换行：整条命令写在块里的**一行**上（回归对照，换判据后仍然看得见）。
    writeFileSync(
      join(dir, WORKFLOW_DIR, "peer.yml"),
      peer("|", ["gh api repos/$GITHUB_REPOSITORY/check-runs/1 -X PATCH -f conclusion=success"]),
    );
    expect(workflowWriteSurfaceViolations({ root: dir }).map((v) => v.step)).toEqual(["peer.yml"]);
    expect(workflowWriteSurfaceFiles({ root: dir })).toEqual(["audit.yml", "peer.yml"]);
    // 良性反面对照 1：同形状的只读回读，折叠成一条也不写面。
    writeFileSync(
      join(dir, WORKFLOW_DIR, "peer.yml"),
      peer(">-", ["gh api repos/$GITHUB_REPOSITORY/commits/abc/check-runs", "--paginate --slurp > runs.json"]),
    );
    expect(workflowWriteSurfaceViolations({ root: dir })).toEqual([]);
    expect(workflowWriteSurfaceFiles({ root: dir })).toEqual(["audit.yml"]);
    // 良性反面对照 2：字面块里两行是**两条**命令（只读回读 + 分页读），不是一次写。
    writeFileSync(
      join(dir, WORKFLOW_DIR, "peer.yml"),
      peer("|", ["gh api repos/$GITHUB_REPOSITORY/commits/abc/check-runs", "--paginate --slurp > runs.json"]),
    );
    expect(workflowWriteSurfaceViolations({ root: dir })).toEqual([]);
    // 良性反面对照 3：真仓库零违规（改入口不是把整个目录变成红色）。
    expect(workflowWriteSurfaceViolations()).toEqual([]);
    expect(workflowWriteSurfaceFiles()).toEqual(["audit.yml"]);
  });

  it("轮二十二-3：白名单步里夹一条看不见的写 —— 看不见调用就不发豁免（F3）", () => {
    const SH = String.fromCharCode(10);
    const step = steps.find((item) => item.name === "回写 Check Run");
    expect(step).toBeTruthy();
    // 良性反面对照：真的那一步（POST + --input 载体）仍旧零违规。
    expect(auditDirReferenceViolations([step], { root: ROOT, jobPayloads: carrierPayloads })).toEqual([]);
    const WHO = "回写 Check Run";
    const injection = " && gh$E api repos/o/r/check-runs/1 -X PATCH -f conclusion=success";
    const realLines = step.run.trimEnd().split(SH);
    const postIndex = realLines.findIndex((line) => line.includes("--input"));
    expect(postIndex).toBeGreaterThanOrEqual(0);
    // 反面：真的那一行（POST + --input 载体）是**看得见调用**的豁免 —— states 非空、逐调用判。
    expect(checkRunSanctioned(WHO, realLines[postIndex], simpleAssignments(step.run))).toBe(true);
    // 注入 A：写在真实最后一行后面（豁免不得覆盖别的行上的写）。
    const tailRun = step.run.replace(/\n+$/, "") + injection + SH;
    // 注入 B：写在**那一行**上 —— 看得见的 POST 与看不见的 PATCH 同处一个命令序列，
    // 老的豁免按「看得见的调用逐个判」就会让整行通过（这正是 F3 的攻法）。
    const postLines = [...realLines];
    postLines[postIndex] = postLines[postIndex] + injection;
    const postRun = postLines.join(SH) + SH;
    for (const [label, run, needle] of [
      ["行尾追加", tailRun, CHECK_RUNS_REASON_UNKNOWN],
      ["挂在 POST 行上", postRun, CHECK_RUNS_REASON_WRITE],
    ]) {
      const assignments = simpleAssignments(run);
      const planted = run.trimEnd().split(SH).find((line) => line.includes("gh$E"));
      expect(planted, label).toBeTruthy();
      expect(checkRunWriteSurface(planted, assignments), label).toBe("check-runs");
      // 同一行两个判据必须一致：不是「写面」与「已豁免」同时成立。
      expect(checkRunSanctioned(WHO, planted, assignments), label).toBe(false);
      const violations = auditDirReferenceViolations([{ ...step, run }], { root: ROOT, jobPayloads: carrierPayloads });
      expect(violations.length, label).toBeGreaterThan(0);
      expect(violations.map((v) => v.reason), label).toContain(needle);
      expect(violations.some((v) => v.where === "run"), label).toBe(true);
    }
    // 第三种：正文里看得见写面字样、看得见的调用却不在这个面上 —— states 为空不等于没有写面。
    // 老口径只按文本放行（POST + --input 就够），于是同一行里的 check-runs 字样被忽略。
    const offSurface =
      "gh api repos/o/r/issues --method POST --input .audit/check-run.json && echo repos/o/r/check-runs";
    const offAssignments = simpleAssignments(offSurface);
    expect(httpCalls(offSurface, offAssignments).overflow).toEqual([]);
    expect(checkRunWriteSurface(offSurface, offAssignments)).toBeNull();
    expect(checkRunSanctioned(WHO, offSurface, offAssignments)).toBe(false);
  });

  it("轮二十二-4：job 级键按白名单收窄 —— if / permissions / strategy / timeout-minutes / container 都点名拒", () => {
    // 白名单必须与真文件 job 实有的键一致：预放行的键没人用，就等于给未来的执行面留门。
    const realJobKeys = [...new Set(Object.values(doc.jobs).flatMap((item) => Object.keys(item)))].sort();
    expect([...JOB_ALLOWED_KEYS].sort()).toEqual(realJobKeys);
    expect(Object.keys(doc.jobs)).toEqual(["audit-runner"]);
    // 良性反面对照：真 audit.yml 的 job 零违规。
    expect(jobKeyViolations(job)).toEqual([]);
    // 五种 job 级执行面键：每一个都能让 job 在不该绿的时候绿，白名单外就一律拒并点名。
    const mutations = {
      if: "false",
      permissions: { contents: "read" },
      strategy: { matrix: { shard: [1, 2] } },
      "timeout-minutes": 1,
      container: "node:22-bookworm",
    };
    for (const [key, value] of Object.entries(mutations)) {
      const violations = jobKeyViolations({ ...job, [key]: value });
      expect(violations.map((v) => v.where), key).toEqual([key]);
      expect(violations[0].step, key).toBe(job.name);
      expect(violations[0].reason, key).toContain(key);
      expect(violations[0].excerpt, key).toContain("job." + key);
    }
    // 一次塞两个要逐一点名，不是只报第一个。
    expect(jobKeyViolations({ ...job, if: "false", permissions: {} }).map((v) => v.where)).toEqual([
      "if",
      "permissions",
    ]);
  });

  it("轮二十二-5：--paginate --slurp 是页数组 —— 只读第一页会漏判（B2）", () => {
    const run = (id, conclusion) => ({
      id,
      name: "audit",
      status: "completed",
      conclusion,
      app: { slug: "github-actions" },
    });
    const fixture = (...pages) =>
      JSON.stringify({ total_count: pages.flat().length, check_runs: pages.flat() });
    // 本次那条（4242）与全页最大 id 都在**第二页**：只读 pages[0] 就看不到它们。
    const selfCheck = (out) => out.ran.find((step) => step.name === "结论自证：回读 Check Run");
    const ok = runWorkflow({
      AUDIT_FINDINGS_A: pass,
      AUDIT_FINDINGS_B: pass,
      FAKE_GH_PAGES: "2",
      FAKE_GH_CHECK_RUNS_JSON: fixture([run(1111, "failure"), run(2222, "failure")], [run(3333, "failure"), run(4242, "success")]),
    });
    expect(selfCheck(ok).status, String(selfCheck(ok).stdout) + String(selfCheck(ok).stderr)).toBe(0);
    expect(ok.summary).toBe("");
    // 第二页里有一条比本次更大的 id —— 只有真的把两页都收进来才看得见（盖过 → 必须红）。
    const covered = runWorkflow({
      AUDIT_FINDINGS_A: pass,
      AUDIT_FINDINGS_B: pass,
      FAKE_GH_PAGES: "2",
      FAKE_GH_CHECK_RUNS_JSON: fixture([run(1111, "failure"), run(2222, "failure")], [run(4242, "success"), run(9999, "failure")]),
    });
    expect(selfCheck(covered).status).not.toBe(0);
    expect(covered.summary).toContain("## audit 自证失败：被更新的结论盖过");
    expect(covered.summary).toContain("9999");
    // 良性反面对照：不声明页数时同一份夹具仍是单页（新开关不改既有形态）。
    const single = runWorkflow({
      AUDIT_FINDINGS_A: pass,
      AUDIT_FINDINGS_B: pass,
      FAKE_GH_CHECK_RUNS_JSON: fixture([run(1111, "failure"), run(2222, "failure")], [run(3333, "failure"), run(4242, "success")]),
    });
    expect(selfCheck(single).status, String(selfCheck(single).stdout)).toBe(0);
    expect(single.summary).toBe("");
  });

});