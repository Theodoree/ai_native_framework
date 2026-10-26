import { afterEach, describe, expect, test } from "vitest";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// 这里验的是「CLI 只发命令、不写状态」这一条契约：用假后端记录收到的每一个请求，
// 再拿进程退出码对齐 0/1/2/3 的约定。断言落在「发出去的字节」与「退出码」上，
// 不靠人眼看输出。

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = join(ROOT, "scripts/cli.mjs");
const CLI_SOURCE = join(ROOT, "scripts/cli.mjs");

const servers = [];
const tempDirs = [];

afterEach(async () => {
  while (servers.length > 0) {
    const server = servers.pop();
    await new Promise((done) => server.close(done));
  }
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "cli-test-"));
  tempDirs.push(dir);
  return dir;
};

// 假后端：把 method/path/body 记下来，按路径回放（参考仓库里假 gh 的写法）。
const startBackend = async (routes) => {
  const requests = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      const record = {
        method: req.method,
        path: req.url,
        raw,
        body: raw === "" ? null : JSON.parse(raw),
      };
      requests.push(record);
      const reply = routes[req.url];
      const resolved = reply
        ? reply(record)
        : {
            status: 404,
            json: {
              kind: "infra",
              code: "E_NO_ROUTE",
              message: "没有这个接口: " + req.url,
            },
          };
      res.writeHead(resolved.status ?? 200, {
        "content-type": "application/json",
      });
      res.end(JSON.stringify(resolved.json));
    });
  });
  servers.push(server);
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const { port } = server.address();
  return { url: `http://127.0.0.1:${port}`, requests };
};

const runCli = (args, env = {}) =>
  new Promise((done) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd: ROOT,
      env: { ...process.env, ...env },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("close", (code) => done({ code, stdout, stderr }));
  });

// 先占一个端口再放掉：这个端口一定是「连得上但没人听」的反面 —— 连不上。
const closedPort = async () => {
  const server = createServer(() => {});
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const { port } = server.address();
  await new Promise((done) => server.close(done));
  return port;
};

const BOARD = {
  items: [
    { id: "REQ-1", title: "第一条需求", state: "accepted", divergence: false },
    {
      id: "REQ-2",
      title: "第二条需求",
      state: "in-progress",
      divergence: true,
    },
  ],
  config: { defaultFlow: "auto", labelPrefix: "state:" },
};

const boardRoutes = () => ({
  "/api/board": () => ({ status: 200, json: BOARD }),
});

describe("board：只读，路径与形状都对得上", () => {
  test("board --json 打 GET /api/board，stdout 是后端响应的原样 JSON", async () => {
    const backend = await startBackend(boardRoutes());
    const r = await runCli(["board", "--json", "--api", backend.url]);

    expect(backend.requests).toHaveLength(1);
    expect(backend.requests[0]).toMatchObject({
      method: "GET",
      path: "/api/board",
      body: null,
    });
    expect(r.code).toBe(0);
    expect(r.stderr).toBe("");
    expect(JSON.parse(r.stdout)).toEqual(BOARD);
  });

  test("board 人读模式打印 id / state / title，漂移条目单独标出", async () => {
    const backend = await startBackend(boardRoutes());
    const r = await runCli(["board", "--api", backend.url]);

    expect(r.code).toBe(0);
    expect(r.stdout).toContain("ID");
    expect(r.stdout).toContain("STATE");
    expect(r.stdout).toContain("TITLE");
    expect(r.stdout).toContain("REQ-1");
    expect(r.stdout).toContain("accepted");
    expect(r.stdout).toContain("第一条需求");
    expect(r.stdout).toContain("远端漂移");
  });

  test("PLATFORM_API 环境变量与 --api 等价", async () => {
    const backend = await startBackend(boardRoutes());
    const r = await runCli(["board", "--json"], { PLATFORM_API: backend.url });

    expect(r.code).toBe(0);
    expect(backend.requests[0].path).toBe("/api/board");
    expect(JSON.parse(r.stdout)).toEqual(BOARD);
  });
});

describe("new：body 只有 title 与 body，缺 title 是用法错误", () => {
  test("new <title> --body <text> 发 POST /api/item，body 字段是 {title, body}", async () => {
    const backend = await startBackend({
      "/api/item": () => ({
        status: 200,
        json: { id: "REQ-9", from: "none", to: "accepted", by: "platform" },
      }),
    });
    const r = await runCli([
      "new",
      "cli 联调",
      "--body",
      "正文内容",
      "--api",
      backend.url,
    ]);

    expect(r.code).toBe(0);
    expect(backend.requests[0]).toMatchObject({
      method: "POST",
      path: "/api/item",
    });
    expect(backend.requests[0].body).toEqual({
      title: "cli 联调",
      body: "正文内容",
    });
    expect(Object.keys(backend.requests[0].body).sort()).toEqual([
      "body",
      "title",
    ]);
    expect(r.stdout).toContain("REQ-9");
    expect(r.stdout).toContain("accepted");
  });

  test("不给 --body 时发空 body 字段（形状稳定，不做省略）", async () => {
    const backend = await startBackend({
      "/api/item": () => ({
        status: 200,
        json: { id: "REQ-10", from: "none", to: "accepted" },
      }),
    });
    const r = await runCli(["new", "只给标题", "--api", backend.url]);

    expect(r.code).toBe(0);
    expect(backend.requests[0].body).toEqual({ title: "只给标题", body: "" });
  });

  test("完全没给 title：退出码 2、打印用法，且一个请求都不发", async () => {
    const backend = await startBackend({
      "/api/item": () => ({ status: 200, json: { id: "REQ-11" } }),
    });
    const r = await runCli(["new", "--api", backend.url]);

    expect(r.code).toBe(2);
    expect(r.stderr).toContain("用法");
    expect(r.stderr).toContain("title");
    expect(backend.requests).toHaveLength(0);
  });

  test("title 给了空串：原样发给后端，由后端判定并回 rejected → 退出码 1", async () => {
    const backend = await startBackend({
      "/api/item": () => ({
        status: 400,
        json: {
          kind: "rejected",
          code: "E_TITLE_REQUIRED",
          message: "标题不能为空",
          extra: {},
        },
      }),
    });
    const r = await runCli(["new", "", "--api", backend.url]);

    expect(backend.requests[0].body).toEqual({ title: "", body: "" });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("标题不能为空");
  });
});

describe("verdict：--to 原样转发，--role 缺省 owner", () => {
  test("body 是 {id, to, actor_role, comment}，缺省角色 owner", async () => {
    const backend = await startBackend({
      "/api/verdict": () => ({
        status: 200,
        json: { id: "REQ-1", from: "accepted", to: "in-progress", by: "owner" },
      }),
    });
    const r = await runCli([
      "verdict",
      "--id",
      "REQ-1",
      "--to",
      "in-progress",
      "--api",
      backend.url,
    ]);

    expect(r.code).toBe(0);
    expect(backend.requests[0]).toMatchObject({
      method: "POST",
      path: "/api/verdict",
    });
    expect(backend.requests[0].body).toEqual({
      id: "REQ-1",
      to: "in-progress",
      actor_role: "owner",
      comment: "",
    });
    expect(r.stdout).toContain("accepted -> in-progress");
  });

  test("--role ci --comment 原样进 body", async () => {
    const backend = await startBackend({
      "/api/verdict": () => ({
        status: 200,
        json: { id: "REQ-1", from: "accepted", to: "in-progress", by: "ci" },
      }),
    });
    const r = await runCli([
      "verdict",
      "--id",
      "REQ-1",
      "--to",
      "in-progress",
      "--role",
      "ci",
      "--comment",
      "CI 起 PR",
      "--api",
      backend.url,
    ]);

    expect(r.code).toBe(0);
    expect(backend.requests[0].body).toEqual({
      id: "REQ-1",
      to: "in-progress",
      actor_role: "ci",
      comment: "CI 起 PR",
    });
  });

  test("CLI 不校验状态名：--to 是任意字符串都原样转发", async () => {
    const backend = await startBackend({
      "/api/verdict": () => ({
        status: 200,
        json: {
          id: "REQ-1",
          from: "accepted",
          to: "made-up-state",
          by: "owner",
        },
      }),
    });
    const r = await runCli([
      "verdict",
      "--id",
      "REQ-1",
      "--to",
      "made-up-state",
      "--api",
      backend.url,
    ]);

    expect(r.code).toBe(0);
    expect(backend.requests[0].body.to).toBe("made-up-state");
  });

  test("缺 --id 或 --to：退出码 2，不发请求", async () => {
    const backend = await startBackend({
      "/api/verdict": () => ({ status: 200, json: { id: "REQ-1" } }),
    });
    const missingId = await runCli([
      "verdict",
      "--to",
      "in-progress",
      "--api",
      backend.url,
    ]);
    const missingTo = await runCli([
      "verdict",
      "--id",
      "REQ-1",
      "--api",
      backend.url,
    ]);

    expect(missingId.code).toBe(2);
    expect(missingId.stderr).toContain("--id");
    expect(missingTo.code).toBe(2);
    expect(missingTo.stderr).toContain("--to");
    expect(backend.requests).toHaveLength(0);
  });
});

describe("verify：exitCode 与输出尾部", () => {
  test("--json 给全部输出，人读最多 20 行尾部", async () => {
    const output = Array.from(
      { length: 30 },
      (_, index) => `line-${index + 1}`,
    ).join("\n");
    const backend = await startBackend({
      "/api/verify": () => ({ status: 200, json: { exitCode: 0, output } }),
    });

    const machine = await runCli(["verify", "--json", "--api", backend.url]);
    expect(machine.code).toBe(0);
    expect(machine.stdout).toContain("line-1");
    expect(JSON.parse(machine.stdout)).toEqual({ exitCode: 0, output });
    expect(backend.requests[0]).toMatchObject({
      method: "POST",
      path: "/api/verify",
    });

    const human = await runCli(["verify", "--api", backend.url]);
    expect(human.code).toBe(0);
    expect(human.stdout).toContain("exitCode: 0");
    expect(human.stdout).toContain("line-30");
    expect(human.stdout).toContain("line-11");
    expect(human.stdout).not.toContain("line-10\n");
    expect(human.stdout.trimEnd().split("\n").length).toBe(2 + 20);
  });
});

describe("outbox：在途台账原样呈现", () => {
  test("--json 原样打印，人读带 status / attempts / nextCheckAt", async () => {
    const payload = {
      entries: [
        {
          attemptId: "att-1",
          item: "REQ-1",
          from: "accepted",
          to: "in-progress",
          status: "pending",
          attempts: 2,
        },
      ],
      deadline: "10m0s",
      writeEnabled: false,
      nextCheckAt: "2026-10-26T10:30:00Z",
    };
    const backend = await startBackend({
      "/api/outbox": () => ({ status: 200, json: payload }),
    });

    const machine = await runCli(["outbox", "--json", "--api", backend.url]);
    expect(machine.code).toBe(0);
    expect(JSON.parse(machine.stdout)).toEqual(payload);

    const human = await runCli(["outbox", "--api", backend.url]);
    expect(human.code).toBe(0);
    expect(human.stdout).toContain("att-1");
    expect(human.stdout).toContain("pending");
    expect(human.stdout).toContain("2");
    expect(human.stdout).toContain("2026-10-26T10:30:00Z");
  });
});

describe("退出码约定：rejected=1 / infra=3 / 用法=2", () => {
  test("409 kind=rejected → 退出码 1，message 进 stderr，stdout 为空", async () => {
    const backend = await startBackend({
      "/api/verdict": () => ({
        status: 409,
        json: {
          kind: "rejected",
          code: "E_TRANSITION_UNDECLARED",
          message: "accepted → done 不是声明里的转换",
          extra: {},
        },
      }),
    });
    const r = await runCli([
      "verdict",
      "--id",
      "REQ-1",
      "--to",
      "done",
      "--api",
      backend.url,
    ]);

    expect(r.code).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("accepted → done 不是声明里的转换");
  });

  test("500 kind=infra → 退出码 3", async () => {
    const backend = await startBackend({
      "/api/board": () => ({
        status: 500,
        json: {
          kind: "infra",
          code: "E_NODE_OUTPUT",
          message: "账本折叠失败",
          extra: {},
        },
      }),
    });
    const r = await runCli(["board", "--api", backend.url]);

    expect(r.code).toBe(3);
    expect(r.stderr).toContain("账本折叠失败");
  });

  test("非 JSON 的 502 也归 3（响应坏了不等于后端说不）", async () => {
    const raw = createServer((req, res) => {
      res.writeHead(502, { "content-type": "text/plain" });
      res.end("bad gateway");
    });
    servers.push(raw);
    await new Promise((done) => raw.listen(0, "127.0.0.1", done));
    const r = await runCli([
      "board",
      "--api",
      `http://127.0.0.1:${raw.address().port}`,
    ]);

    expect(r.code).toBe(3);
    expect(r.stderr).toContain("502");
  });

  test("端口不通 → 退出码 3，只报一行原因，不抛原始堆栈", async () => {
    const port = await closedPort();
    const r = await runCli(["board", "--api", `http://127.0.0.1:${port}`]);

    expect(r.code).toBe(3);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("连不上后端");
    expect(r.stderr).not.toContain("TypeError");
    expect(r.stderr).not.toMatch(/\n\s+at\s/);
  });

  test("未知子命令 → 退出码 2 并打印用法", async () => {
    const r = await runCli(["nope"]);

    expect(r.code).toBe(2);
    expect(r.stderr).toContain("未知命令: nope");
    expect(r.stderr).toContain("用法: cli");
  });

  test("未知选项 → 退出码 2", async () => {
    const r = await runCli(["board", "--nope"]);

    expect(r.code).toBe(2);
    expect(r.stderr).toContain("--nope");
  });

  test("--help → 退出码 0 并打印用法", async () => {
    const r = await runCli(["--help"]);

    expect(r.code).toBe(0);
    expect(r.stdout).toContain("用法: cli");
    expect(r.stdout).toContain("退出码");
  });
});

describe("不写状态：CLI 自己绝不落盘", () => {
  test("跑完全部子命令后，PLATFORM_LEDGER 指向的账本逐字节不变", async () => {
    const dir = tempDir();
    const ledger = join(dir, "ledger.jsonl");
    const before = Buffer.from(
      '{"id":"REQ-1","at":"2026-10-20T06:50:33.716Z","from":"none","to":"accepted","by":"platform","comment":"新需求受理"}\n',
      "utf8",
    );
    writeFileSync(ledger, before);

    const backend = await startBackend({
      "/api/board": () => ({ status: 200, json: BOARD }),
      "/api/item": () => ({
        status: 200,
        json: { id: "REQ-9", from: "none", to: "accepted" },
      }),
      "/api/verdict": () => ({
        status: 200,
        json: { id: "REQ-9", from: "accepted", to: "in-progress", by: "ci" },
      }),
      "/api/verify": () => ({
        status: 200,
        json: { exitCode: 0, output: "ok" },
      }),
      "/api/outbox": () => ({
        status: 200,
        json: {
          entries: [],
          deadline: "10m0s",
          writeEnabled: false,
          nextCheckAt: null,
        },
      }),
    });

    const env = { PLATFORM_LEDGER: ledger };
    const runs = [
      await runCli(["board", "--json", "--api", backend.url], env),
      await runCli(["new", "写入测试", "--api", backend.url], env),
      await runCli(
        [
          "verdict",
          "--id",
          "REQ-9",
          "--to",
          "in-progress",
          "--role",
          "ci",
          "--api",
          backend.url,
        ],
        env,
      ),
      await runCli(["verify", "--json", "--api", backend.url], env),
      await runCli(["outbox", "--json", "--api", backend.url], env),
    ];

    for (const run of runs) expect(run.code).toBe(0);
    expect(backend.requests).toHaveLength(5);
    expect(readFileSync(ledger).equals(before)).toBe(true);
  });

  test("源码里没有账本 import，也没有任何写文件的 API（写成断言，不靠人看）", () => {
    const source = readFileSync(CLI_SOURCE, "utf8");

    expect(source).not.toMatch(/ledger\.mjs/);
    expect(source).not.toMatch(/node:fs/);
    expect(source).not.toMatch(
      /writeFile|appendFileSync|createWriteStream|appendFile/,
    );
    // 账本路径也不该出现：读了就会有人开始「顺手推断状态」。
    expect(source).not.toMatch(/ledger\.jsonl/);
  });
});
