#!/usr/bin/env node
// cli.mjs · 接入层：让终端和外部流水线能发命令，但它自己不写任何状态。
//
// 为什么这么薄：状态的唯一真相在账本与 issue label 上，判定器只有一份实现。
// 所以本文件只做三件事：读参数、发 HTTP、把结果打到 stdout —— 不读账本、不落盘、
// 不判断状态转换；--to 原样交给后端，CLI 里出现转换规则就是第二份真相。
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

const DEFAULT_API = "http://127.0.0.1:4317";

// 退出码与 scripts/state-validate.mjs 的约定对齐：0 允许 / 1 拒绝 / 3 基础设施。
// 2 只表示用法错误，绝不复用 1 或 3，否则调用方分不清「后端说不」和「命令写错了」。
const EXIT_OK = 0;
const EXIT_REJECTED = 1;
const EXIT_USAGE = 2;
const EXIT_INFRA = 3;

const USAGE = `用法: cli <命令> [选项] [--api <url>] [--json]

命令:
  board [--json]                                   列出条目（id / state / title / 漂移）
  new <title> [--body <text>] [--json]             新建需求，打印新 id 与落到的状态
  verdict --id <id> --to <state> [--role <role>] [--comment <text>] [--json]
                                                   发起一次状态变更（--role 缺省 owner）
  verify [--json]                                  真跑校验，打印 exitCode 与输出尾部
  outbox [--json]                                  列出在途条目（status/attempts/nextCheckAt）

全局:
  --api <url>   后端地址，默认 \`$PLATFORM_API\` 或 ${DEFAULT_API}
  --json        机器可读输出（原样打印后端响应）
  --help        打印本用法

退出码: 0 成功 / 1 后端拒绝（kind=rejected）/ 2 用法错误 / 3 网络或后端故障（kind=infra）
`;

class CliError extends Error {
  constructor(exitCode, message) {
    super(message);
    this.exitCode = exitCode;
  }
}

const usageError = (message) => new CliError(EXIT_USAGE, message);
const infraError = (message) => new CliError(EXIT_INFRA, message);

// 每个命令收哪些选项：没登记的选项一律按用法错误处理，不做「猜你要什么」。
const COMMAND_FLAGS = {
  board: {},
  new: { body: true },
  verdict: { id: true, to: true, role: true, comment: true },
  verify: {},
  outbox: {},
};

const takeValue = (tokens, flag) => {
  if (tokens.length === 0) throw usageError(`选项 ${flag} 缺少取值`);
  return tokens.shift();
};

const parseArgv = (argv) => {
  const tokens = [...argv];
  const parsed = {
    command: null,
    help: false,
    json: false,
    api: null,
    flags: {},
    positionals: [],
  };
  while (tokens.length > 0) {
    const token = tokens.shift();
    if (token === "--help" || token === "-h") {
      parsed.help = true;
      continue;
    }
    if (token === "--json") {
      parsed.json = true;
      continue;
    }
    if (token === "--api") {
      parsed.api = takeValue(tokens, "--api");
      continue;
    }
    if (token.startsWith("--api=")) {
      parsed.api = token.slice("--api=".length);
      continue;
    }
    if (token.startsWith("--")) {
      const name = token.slice(2);
      const allowed = parsed.command ? COMMAND_FLAGS[parsed.command] : null;
      if (!allowed || !Object.hasOwn(allowed, name)) {
        throw usageError(
          parsed.command
            ? `命令 ${parsed.command} 不认识选项 ${token}`
            : `不认识全局选项 ${token}`,
        );
      }
      parsed.flags[name] = takeValue(tokens, token);
      continue;
    }
    if (parsed.command === null) {
      parsed.command = token;
      continue;
    }
    parsed.positionals.push(token);
  }

  if (parsed.help) return parsed;
  if (parsed.command === null) throw usageError("缺少命令");
  if (!Object.hasOwn(COMMAND_FLAGS, parsed.command))
    throw usageError(`未知命令: ${parsed.command}`);

  // 必填参数只查「给没给」；给了什么（哪怕是空串）都原样交给后端判定器。
  const required = parsed.command === "verdict" ? ["id", "to"] : [];
  for (const name of required) {
    if (parsed.flags[name] === undefined)
      throw usageError(`命令 ${parsed.command} 缺少必填选项 --${name}`);
  }
  if (parsed.command === "new") {
    if (parsed.positionals.length === 0)
      throw usageError("命令 new 缺少必填参数 <title>");
    if (parsed.positionals.length > 1)
      throw usageError(
        `命令 new 只收一个 <title>，多给了 ${parsed.positionals.length - 1} 个`,
      );
  } else if (parsed.positionals.length > 0) {
    throw usageError(
      `命令 ${parsed.command} 不收位置参数: ${parsed.positionals.join(" ")}`,
    );
  }
  return parsed;
};

const resolveApi = (raw) => {
  const value = raw ?? process.env.PLATFORM_API ?? DEFAULT_API;
  let url;
  try {
    url = new URL(value);
  } catch {
    throw usageError(`--api 不是合法 URL: ${value}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw usageError(`--api 只支持 http/https: ${value}`);
  }
  return url;
};

// 只取 origin：后端路径是固定的，--api 里带没带路径都不改变我们要打的接口。
const endpoint = (api, pathname) => {
  const url = new URL(api.origin);
  url.pathname = pathname;
  return url;
};

const networkReason = (error) => {
  const cause = error && typeof error === "object" ? error.cause : undefined;
  if (cause && typeof cause === "object" && typeof cause.message === "string")
    return cause.message;
  if (error && typeof error.message === "string") return error.message;
  return "未知网络错误";
};

const send = (url, { method, body }) =>
  new Promise((resolve, reject) => {
    const client = url.protocol === "https:" ? httpsRequest : httpRequest;
    const payload =
      body === undefined ? null : Buffer.from(JSON.stringify(body), "utf8");
    const headers = payload
      ? { "content-type": "application/json", "content-length": payload.length }
      : { "content-length": 0 };
    const req = client(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || (url.protocol === "https:" ? 443 : 80),
        path: url.pathname + url.search,
        method,
        headers,
        // 每次请求一个独立 agent：命令结束即断连，进程不留 keep-alive 句柄。
        agent: false,
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          resolve({
            status: res.statusCode ?? 0,
            text: Buffer.concat(chunks).toString("utf8"),
          });
        });
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });

const parseJson = (text) => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

// 后端错误形状是 {kind, code, message, extra}：kind 优先，状态码兜底。
const backendError = (status, payload) => {
  const kind =
    payload && typeof payload.kind === "string" ? payload.kind : null;
  const code =
    payload && typeof payload.code === "string" ? payload.code : null;
  const message =
    payload && typeof payload.message === "string"
      ? payload.message
      : `HTTP ${status}`;
  const detail = code ? `${code}: ${message}` : message;
  if (kind === "rejected")
    return new CliError(EXIT_REJECTED, `后端拒绝（HTTP ${status}）: ${detail}`);
  if (kind === "infra")
    return infraError(`后端故障（HTTP ${status}）: ${detail}`);
  if (status >= 500) return infraError(`后端故障（HTTP ${status}）: ${detail}`);
  if (status >= 400)
    return new CliError(EXIT_REJECTED, `后端拒绝（HTTP ${status}）: ${detail}`);
  return infraError(`后端回应无法理解（HTTP ${status}）: ${detail}`);
};

const request = async (api, pathname, options = {}) => {
  const url = endpoint(api, pathname);
  let response;
  try {
    response = await send(url, {
      method: options.method ?? "GET",
      body: options.body,
    });
  } catch (error) {
    throw infraError(`连不上后端 ${api.origin}: ${networkReason(error)}`);
  }
  const payload = parseJson(response.text);
  if (response.status >= 200 && response.status < 300) {
    if (payload === null) {
      throw infraError(`后端返回的不是 JSON（HTTP ${response.status}）`);
    }
    return payload;
  }
  throw backendError(response.status, payload);
};

const renderJson = (payload) => `${JSON.stringify(payload, null, 2)}\n`;

const cell = (value) =>
  value === null || value === undefined || value === "" ? "-" : String(value);

// 中文在终端占两列：按显示宽度而不是码点数补空格，表才不会歪。
const displayWidth = (value) => {
  let total = 0;
  for (const char of String(value)) {
    total += isWide(char) ? 2 : 1;
  }
  return total;
};

const isWide = (char) => {
  const code = char.codePointAt(0) ?? 0;
  return (
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe6f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x1f300 && code <= 0x1f64f) ||
    (code >= 0x1f900 && code <= 0x1f9ff)
  );
};

const pad = (value, widthValue) => {
  const body = String(value);
  return body + " ".repeat(Math.max(0, widthValue - displayWidth(body)));
};

const renderTable = (headers, rows) => {
  const cells = rows.map((row) => row.map(cell));
  const widths = headers.map((header, index) =>
    Math.max(
      displayWidth(header),
      ...cells.map((row) => displayWidth(row[index])),
    ),
  );
  const line = (values) =>
    values
      .map((value, index) => pad(value, widths[index]))
      .join("  ")
      .trimEnd();
  return [
    line(headers),
    line(widths.map((w) => "-".repeat(w))),
    ...cells.map(line),
  ].join("\n");
};

const board = async (context) => {
  const payload = await request(context.api, "/api/board");
  if (context.json) return renderJson(payload);
  const items = Array.isArray(payload.items) ? payload.items : null;
  if (items === null) throw infraError("board 响应里没有 items 数组");
  if (items.length === 0) return "（没有条目）\n";
  const drifted = items.some((item) => item.divergence === true);
  const headers = ["ID", "STATE", "TITLE"];
  if (drifted) headers.push("漂移");
  const rows = items.map((item) => {
    const row = [
      item.id,
      item.state === null ? "none" : item.state,
      item.title ?? "",
    ];
    if (drifted) row.push(item.divergence === true ? "远端漂移" : "");
    return row;
  });
  return renderTable(headers, rows) + "\n";
};

const createItem = async (context) => {
  const title = context.positionals[0];
  const body = context.flags.body ?? "";
  const created = await request(context.api, "/api/item", {
    method: "POST",
    body: { title, body },
  });
  if (context.json) return renderJson(created);
  return `新需求: ${cell(created.id)}\n落到状态: ${cell(created.to)}\n`;
};

const verdict = async (context) => {
  // actor_role 的缺省值只在这里出现一次（后端约定 owner），CLI 不校验取值合法性。
  const payload = {
    id: context.flags.id,
    to: context.flags.to,
    actor_role: context.flags.role ?? "owner",
    comment: context.flags.comment ?? "",
  };
  const created = await request(context.api, "/api/verdict", {
    method: "POST",
    body: payload,
  });
  if (context.json) return renderJson(created);
  return `${cell(created.id)}: ${cell(created.from)} -> ${cell(created.to)}（by ${cell(created.by)}）\n`;
};

const verify = async (context) => {
  const result = await request(context.api, "/api/verify", { method: "POST" });
  if (context.json) return renderJson(result);
  const exitCode =
    result.exitCode === null || result.exitCode === undefined
      ? "null（超时或被杀，不可信）"
      : result.exitCode;
  const output = typeof result.output === "string" ? result.output : "";
  const lines = output === "" ? [] : output.split("\n");
  const tail = lines.slice(-20);
  const header = `exitCode: ${exitCode}`;
  if (tail.length === 0) return header + "\n（输出为空）\n";
  return `${header}\n--- 输出尾部（最多 20 行，--json 看全文）---\n${tail.join("\n")}\n`;
};

const outbox = async (context) => {
  const payload = await request(context.api, "/api/outbox");
  if (context.json) return renderJson(payload);
  const entries = Array.isArray(payload.entries) ? payload.entries : null;
  if (entries === null) throw infraError("outbox 响应里没有 entries 数组");
  const nextCheckAt =
    payload.nextCheckAt === null || payload.nextCheckAt === undefined
      ? "无（在途为空）"
      : payload.nextCheckAt;
  if (entries.length === 0)
    return `（没有在途条目）\n下次巡检: ${nextCheckAt}\n`;
  const rows = entries.map((entry) => [
    entry.attemptId,
    entry.item,
    entry.from,
    entry.to,
    entry.status,
    entry.attempts,
  ]);
  return (
    renderTable(["ATTEMPT", "ITEM", "FROM", "TO", "STATUS", "ATTEMPTS"], rows) +
    `\n下次巡检: ${nextCheckAt}\n`
  );
};

const HANDLERS = { board, new: createItem, verdict, verify, outbox };

const execute = async (argv) => {
  const parsed = parseArgv(argv);
  if (parsed.help) return { code: EXIT_OK, stdout: USAGE };
  const api = resolveApi(parsed.api);
  const stdout = await HANDLERS[parsed.command]({
    api,
    json: parsed.json,
    flags: parsed.flags,
    positionals: parsed.positionals,
  });
  return { code: EXIT_OK, stdout };
};

const main = async (argv) => {
  try {
    const result = await execute(argv);
    process.stdout.write(result.stdout);
    return result.code;
  } catch (error) {
    if (error instanceof CliError) {
      process.stderr.write(`cli: ${error.message}\n`);
      if (error.exitCode === EXIT_USAGE) process.stderr.write(`\n${USAGE}`);
      return error.exitCode;
    }
    // 兜底不打印原始堆栈：堆栈会把退出码约定淹掉，调用方只需要一行原因。
    const message =
      error && typeof error === "object" && typeof error.message === "string"
        ? error.message
        : String(error);
    process.stderr.write(`cli: 内部错误: ${message}\n`);
    return EXIT_INFRA;
  }
};

process.exitCode = await main(process.argv.slice(2));
