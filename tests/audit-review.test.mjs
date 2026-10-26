import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { EXIT, MAX_DIFF_CHARS, run } from "../scripts/audit-review.mjs";
import { validateResult } from "../scripts/audit-findings.mjs";
import {
  DEFAULT_ROUTING_PATH,
  loadRouting,
  resolve as resolveRoute,
} from "../scripts/routing.mjs";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const scriptPath = join(repoRoot, "scripts", "audit-review.mjs");
const KEY = "sk-test-not-a-real-key-7f3a";

const workdir = () => mkdtempSync(join(tmpdir(), "audit-review-"));

const withDiff = (
  dir,
  text = "diff --git a/scripts/x.mjs b/scripts/x.mjs\n+x\n",
) => {
  const path = join(dir, "pr.diff");
  writeFileSync(path, text);
  return path;
};

const chatReply = ({ id = "req_live_9f1", content }) => ({
  status: 200,
  text: async () =>
    JSON.stringify({
      id,
      object: "chat.completion",
      choices: [{ message: { content } }],
    }),
});

const findingsJson = (findings) => JSON.stringify({ findings });

const baseFinding = {
  path: "scripts/x.mjs",
  line: 3,
  severity: "high",
  criterion: "新增分支没有对应测试",
  suggestion: "补一条覆盖该分支的用例",
};

// 每条用例都自己捕获 stdout/stderr：脚本对外的每一句话都是断言面。
const harness = ({ dir, diff, extraEnv = {}, fetchImpl, argv }) => {
  const lines = [];
  const errs = [];
  const outPath = join(dir, "review-a.json");
  const deps = {
    root: repoRoot,
    env: { DEEPSEEK_API_KEY: KEY, ...extraEnv },
    out: (line) => lines.push(String(line)),
    err: (line) => errs.push(String(line)),
    fetch: fetchImpl,
  };
  const args = argv ?? ["--slot", "review-a", "--diff", diff, "--out", outPath];
  return {
    outPath,
    exec: async () => ({ code: await run(args, deps), lines, errs }),
  };
};

const readRecord = (path) => JSON.parse(readFileSync(path, "utf8"));

describe("audit-review 成功路径", () => {
  it("写出四字段齐全的记录，退出码 0，且过口径层的 validateResult", async () => {
    const dir = workdir();
    const calls = [];
    const fetchImpl = async (url, init) => {
      calls.push({ url, init });
      return chatReply({ content: findingsJson([baseFinding]) });
    };
    const h = harness({ dir, diff: withDiff(dir), fetchImpl });
    const { code } = await h.exec();

    expect(code).toBe(EXIT.PASS);
    const record = readRecord(h.outPath);
    expect(record.verdict).toBe("needs_revision");
    expect(record.findings).toHaveLength(1);
    expect(record.evidence).toEqual({
      executor: "github",
      agent: "review-a",
      model: resolveRoute(
        "review-a",
        loadRouting(DEFAULT_ROUTING_PATH, repoRoot),
      ).model,
      request_id: "req_live_9f1",
    });
    // 判据只有一份：直接问口径层，不在这里抄一遍 schema。
    expect(validateResult(record)).toEqual({ ok: true, errors: [] });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.deepseek.com/chat/completions");
  });

  it("两个槽各自用 routing.yml 里绑定的模型", async () => {
    const routing = loadRouting(DEFAULT_ROUTING_PATH, repoRoot);
    const seen = {};
    for (const slot of ["review-a", "review-b"]) {
      const dir = workdir();
      const h = harness({
        dir,
        diff: withDiff(dir),
        argv: [
          "--slot",
          slot,
          "--diff",
          withDiff(dir),
          "--out",
          join(dir, "out.json"),
        ],
        fetchImpl: async (_url, init) => {
          seen[slot] = JSON.parse(init.body).model;
          return chatReply({ content: findingsJson([]) });
        },
      });
      const { code } = await h.exec();
      expect(code).toBe(EXIT.PASS);
      expect(readRecord(join(dir, "out.json")).evidence.model).toBe(
        resolveRoute(slot, routing).model,
      );
    }
    expect(seen["review-a"]).toBe("deepseek-chat");
    expect(seen["review-b"]).toBe("deepseek-reasoner");
    expect(seen["review-a"]).not.toBe(seen["review-b"]);
  });

  it("没有缺陷时 verdict=pass（空 findings 也是合格记录）", async () => {
    const dir = workdir();
    const h = harness({
      dir,
      diff: withDiff(dir),
      fetchImpl: async () => chatReply({ content: findingsJson([]) }),
    });
    const { code } = await h.exec();
    expect(code).toBe(EXIT.PASS);
    const record = readRecord(h.outPath);
    expect(record.verdict).toBe("pass");
    expect(validateResult(record).ok).toBe(true);
  });

  it("blocker 缺陷推出 reject，且仍是合格记录", async () => {
    const dir = workdir();
    const h = harness({
      dir,
      diff: withDiff(dir),
      fetchImpl: async () =>
        chatReply({
          content: findingsJson([{ ...baseFinding, severity: "blocker" }]),
        }),
    });
    const { code } = await h.exec();
    expect(code).toBe(EXIT.PASS);
    expect(readRecord(h.outPath).verdict).toBe("reject");
  });

  it("超过上限的 diff 被截断，并在 prompt 里说明已截断", async () => {
    const dir = workdir();
    let body = null;
    const h = harness({
      dir,
      diff: withDiff(dir, "a".repeat(MAX_DIFF_CHARS + 500)),
      fetchImpl: async (_url, init) => {
        body = JSON.parse(init.body);
        return chatReply({ content: findingsJson([]) });
      },
    });
    await h.exec();
    const user = body.messages.find((m) => m.role === "user").content;
    expect(user).toContain("已截断");
    expect(user.length).toBeLessThan(MAX_DIFF_CHARS + 1000);
  });
});

describe("audit-review 判不了时写 INFRA", () => {
  const cases = [
    {
      name: "没有 DEEPSEEK_API_KEY",
      extraEnv: { DEEPSEEK_API_KEY: "" },
      fetchImpl: async () => {
        throw new Error("有 key 才会发请求，这条不该被调用");
      },
    },
    {
      name: "HTTP 401",
      fetchImpl: async () => ({
        status: 401,
        text: async () => "Unauthorized",
      }),
    },
    {
      name: "HTTP 500",
      fetchImpl: async () => ({ status: 500, text: async () => "boom" }),
    },
    {
      name: "响应体不是 JSON",
      fetchImpl: async () => ({ status: 200, text: async () => "<html>" }),
    },
    {
      name: "响应体没有 choices",
      fetchImpl: async () => ({ status: 200, text: async () => '{"id":"x"}' }),
    },
    {
      name: "模型回了一段不是 JSON 的文本",
      fetchImpl: async () =>
        chatReply({ content: "我认为这个 PR 有问题，但没有结构化输出。" }),
    },
    {
      name: "模型 JSON 里没有 findings 数组",
      fetchImpl: async () => chatReply({ content: '{"notes":[]}' }),
    },
    {
      name: "findings 不合契约 schema",
      fetchImpl: async () =>
        chatReply({ content: findingsJson([{ ...baseFinding, line: 0 }]) }),
    },
  ];

  for (const item of cases) {
    it(item.name + " → INFRA + 退出码 3", async () => {
      const dir = workdir();
      const h = harness({
        dir,
        diff: withDiff(dir),
        extraEnv: item.extraEnv,
        fetchImpl: item.fetchImpl,
      });
      const { code } = await h.exec();
      expect(code).toBe(EXIT.UNKNOWN);
      const record = readRecord(h.outPath);
      expect(record.verdict).toBe("INFRA");
      expect(record.findings).toEqual([]);
      // INFRA 也必须是「真跑过」的一份记录：executor / agent 从不缺席。
      expect(record.evidence.executor).toBe("github");
      expect(record.evidence.agent).toBe("review-a");
      expect(typeof record.reason).toBe("string");
      expect(record.reason).not.toBe("");
    });
  }

  it("上游没回 id 时不写 request_id：traceability 字段不许编", async () => {
    const dir = workdir();
    const h = harness({
      dir,
      diff: withDiff(dir),
      // 200 + 合法 choices，但响应体没有 id —— 这次调用没有任何可追溯的凭据。
      fetchImpl: async () => ({
        status: 200,
        text: async () =>
          JSON.stringify({
            choices: [{ message: { content: findingsJson([]) } }],
          }),
      }),
    });
    const { code } = await h.exec();
    expect(code).toBe(EXIT.UNKNOWN);
    const record = readRecord(h.outPath);
    expect(record.verdict).toBe("INFRA");
    expect(record.reason).toContain("request_id");
    // evidence 只写已知的真事实：不知道就不写这个键，绝不填一个看起来像真的占位值。
    expect(record.evidence).not.toHaveProperty("request_id");
  });

  it("无 key 时文件内容不含 key 字样", async () => {
    const dir = workdir();
    const h = harness({
      dir,
      diff: withDiff(dir),
      extraEnv: { DEEPSEEK_API_KEY: "" },
      fetchImpl: async () => chatReply({ content: findingsJson([]) }),
    });
    await h.exec();
    expect(readFileSync(h.outPath, "utf8")).not.toContain("sk-");
  });

  it("取不到模型真源时也写 INFRA（不猜一个模型去调）", async () => {
    const dir = workdir();
    let called = false;
    const outPath = join(dir, "out.json");
    const code = await run(
      ["--slot", "review-a", "--diff", withDiff(dir), "--out", outPath],
      {
        root: repoRoot,
        env: { DEEPSEEK_API_KEY: KEY },
        routingPath: join(dir, "no-such-routing.yml"),
        out: () => {},
        err: () => {},
        fetch: async () => {
          called = true;
          return chatReply({ content: findingsJson([]) });
        },
      },
    );
    expect(code).toBe(EXIT.UNKNOWN);
    expect(called).toBe(false);
    expect(readRecord(outPath).verdict).toBe("INFRA");
  });
});

describe("audit-review 注入面", () => {
  it("key 只在 header 里，request body 与输出都不含它", async () => {
    const dir = workdir();
    const calls = [];
    const h = harness({
      dir,
      diff: withDiff(dir),
      fetchImpl: async (url, init) => {
        calls.push({ url, init });
        return chatReply({ content: findingsJson([baseFinding]) });
      },
    });
    const { lines, errs } = await h.exec();

    expect(calls[0].init.headers.authorization).toBe("Bearer " + KEY);
    expect(calls[0].init.body).not.toContain(KEY);
    expect(calls[0].url).not.toContain(KEY);
    expect(JSON.stringify(lines)).not.toContain(KEY);
    expect(JSON.stringify(errs)).not.toContain(KEY);
    expect(readFileSync(h.outPath, "utf8")).not.toContain(KEY);
  });

  it("上游错误信息里出现 key 时，诊断出口把它脱敏", async () => {
    const dir = workdir();
    const h = harness({
      dir,
      diff: withDiff(dir),
      fetchImpl: async () => ({
        status: 401,
        text: async () => "invalid api key " + KEY,
      }),
    });
    const { code, errs } = await h.exec();
    expect(code).toBe(EXIT.UNKNOWN);
    expect(JSON.stringify(errs)).not.toContain(KEY);
    expect(readFileSync(h.outPath, "utf8")).not.toContain(KEY);
  });
});

describe("audit-review 用法错误", () => {
  const usageCases = [
    {
      name: "缺少 --slot",
      argv: (dir) => ["--diff", withDiff(dir), "--out", join(dir, "o.json")],
    },
    {
      name: "缺少 --diff",
      argv: (dir) => ["--slot", "review-a", "--out", join(dir, "o.json")],
    },
    {
      name: "缺少 --out",
      argv: (dir) => ["--slot", "review-a", "--diff", withDiff(dir)],
    },
    {
      name: "非法槽名",
      argv: (dir) => [
        "--slot",
        "review-c",
        "--diff",
        withDiff(dir),
        "--out",
        join(dir, "o.json"),
      ],
    },
    {
      name: "出现了 --model",
      argv: (dir) => [
        "--slot",
        "review-a",
        "--diff",
        withDiff(dir),
        "--out",
        join(dir, "o.json"),
        "--model",
        "deepseek-chat",
      ],
    },
    {
      name: "--out 目录不存在",
      argv: (dir) => [
        "--slot",
        "review-a",
        "--diff",
        withDiff(dir),
        "--out",
        join(dir, "nope", "o.json"),
      ],
    },
  ];

  for (const item of usageCases) {
    it(item.name + " → 退出码 2，不发请求", async () => {
      const dir = workdir();
      let called = false;
      const code = await run(item.argv(dir), {
        root: repoRoot,
        env: { DEEPSEEK_API_KEY: KEY },
        out: () => {},
        err: () => {},
        fetch: async () => {
          called = true;
          return chatReply({ content: findingsJson([]) });
        },
      });
      expect(code).toBe(EXIT.USAGE);
      expect(called).toBe(false);
    });
  }
});

describe("audit-review 作为 CLI 跑起来", () => {
  it("真实进程里无 key 时退出码 3，并写出一份 INFRA", () => {
    const dir = workdir();
    const diff = withDiff(dir);
    const out = join(dir, "out.json");
    const env = { PATH: process.env.PATH, HOME: process.env.HOME };
    const result = spawnSync(
      process.execPath,
      [scriptPath, "--slot", "review-b", "--diff", diff, "--out", out],
      {
        encoding: "utf8",
        env,
      },
    );
    expect(result.status).toBe(EXIT.UNKNOWN);
    const record = readRecord(out);
    expect(record.verdict).toBe("INFRA");
    expect(record.evidence.agent).toBe("review-b");
    expect(String(result.stdout + result.stderr)).not.toContain("sk-");
  });

  it("真实进程里用法错误退出码 2", () => {
    const result = spawnSync(
      process.execPath,
      [scriptPath, "--slot", "review-z"],
      {
        encoding: "utf8",
        env: { PATH: process.env.PATH, HOME: process.env.HOME },
      },
    );
    expect(result.status).toBe(EXIT.USAGE);
  });
});
