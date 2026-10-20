#!/usr/bin/env node
// server.mjs · 本机单进程：静态页 + JSON API，同源。
// 判定全部交给 state-validate.mjs；本文件不做任何状态判断。
import http from "node:http";
import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { loadConfig, resolveEntry, validateIntent } from "./state-validate.mjs";
import { appendEvent, fold, nextId, readEvents } from "./ledger.mjs";

const CONFIG_PATH = resolve(".agents/platform/state-machine.yml");
const WEB = resolve("web");
const STATIC = {
  "/": ["index.html", "text/html; charset=utf-8"],
  "/app.js": ["app.js", "text/javascript; charset=utf-8"],
  "/style.css": ["style.css", "text/css; charset=utf-8"],
};

function send(res, status, body, type = "application/json; charset=utf-8") {
  const payload = typeof body === "string" ? body : JSON.stringify(body);
  res.writeHead(status, { "content-type": type }).end(payload);
}

function readBody(req) {
  return new Promise((ok, fail) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 1_000_000) fail(new Error("请求体过大"));
    });
    req.on("end", () => {
      try {
        ok(raw ? JSON.parse(raw) : {});
      } catch {
        fail(new Error("请求体不是合法 JSON"));
      }
    });
    req.on("error", fail);
  });
}

// 唯一的写入口：判定器说行才落账本；不说行就原样把理由交回去。
function commit(event) {
  appendEvent(event);
  return event;
}

function handleBoard() {
  const cfg = loadConfig(CONFIG_PATH);
  return {
    items: fold(readEvents()),
    config: {
      defaultFlow: cfg.policy?.default_flow ?? null,
      labelPrefix: cfg.label_prefix,
      states: Object.entries(cfg.states).map(([name, meta]) => ({
        name,
        terminal: Boolean(meta?.terminal),
        meaning: meta?.meaning ?? "",
      })),
      transitions: cfg.transitions,
    },
  };
}

function handleItem(body) {
  const cfg = loadConfig(CONFIG_PATH);
  const events = readEvents();
  const id = nextId(events);
  const title = String(body.title ?? "").trim();
  if (!title) throw Object.assign(new Error("标题不能为空"), { kind: "rejected", code: "E_TITLE_REQUIRED" });
  // 落到哪、由谁触发，全部从声明读；这里不写任何 flow 分支。
  const entry = resolveEntry(cfg);
  const verdict = validateIntent(cfg, {
    labels: [],
    to: entry.to,
    actor_role: entry.by,
  });
  return commit({
    id,
    at: new Date().toISOString(),
    title,
    body: String(body.body ?? ""),
    from: verdict.from,
    to: verdict.to,
    by: verdict.by,
    flow: verdict.flow,
    comment: "新需求受理",
  });
}

function handleVerdict(body) {
  const cfg = loadConfig(CONFIG_PATH);
  const events = readEvents();
  const item = fold(events).find((i) => i.id === body.id);
  if (!item) throw Object.assign(new Error("找不到该需求: " + body.id), { kind: "rejected", code: "E_ITEM_MISSING" });
  const labels = item.state ? [cfg.label_prefix + item.state] : [];
  const verdict = validateIntent(cfg, {
    labels,
    to: String(body.to ?? ""),
    actor_role: String(body.actor_role ?? "owner"),
    comment: String(body.comment ?? ""),
  });
  return commit({
    id: item.id,
    at: new Date().toISOString(),
    from: verdict.from,
    to: verdict.to,
    by: verdict.by,
    flow: verdict.flow,
    comment: String(body.comment ?? ""),
  });
}

function handleConfigRead() {
  return { text: readFileSync(CONFIG_PATH, "utf8") };
}

function handleConfigWrite(body) {
  const text = String(body.text ?? "");
  const tmp = CONFIG_PATH + ".tmp";
  writeFileSync(tmp, text, "utf8");
  try {
    loadConfig(tmp);
  } catch (error) {
    rmSync(tmp, { force: true });
    throw error;
  }
  renameSync(tmp, CONFIG_PATH);
  return { ok: true };
}

function handleVerify() {
  const run = spawnSync("npm", ["run", "check"], { encoding: "utf8", timeout: 180000 });
  const output = [run.stdout ?? "", run.stderr ?? ""].join("").trim();
  return { exitCode: run.status, output: output.slice(-8000) };
}

const ROUTES = {
  "GET /api/board": handleBoard,
  "GET /api/config": handleConfigRead,
  "PUT /api/config": handleConfigWrite,
  "POST /api/item": handleItem,
  "POST /api/verdict": handleVerdict,
  "POST /api/verify": handleVerify,
};

export const handlers = {
  board: handleBoard,
  item: handleItem,
  verdict: handleVerdict,
  configRead: handleConfigRead,
  configWrite: handleConfigWrite,
  verify: handleVerify,
};

export function createServer() {
  return http.createServer(async (req, res) => {
  const path = (req.url ?? "/").split("?")[0];
  const stat = STATIC[path];
  if (stat && req.method === "GET") {
    try {
      send(res, 200, readFileSync(resolve(WEB, stat[0]), "utf8"), stat[1]);
    } catch {
      send(res, 404, { kind: "infra", code: "E_STATIC_MISSING", message: "缺 " + stat[0] });
    }
    return;
  }
  const handler = ROUTES[req.method + " " + path];
  if (!handler) return send(res, 404, { kind: "infra", code: "E_NO_ROUTE", message: "没有这个接口: " + path });
  try {
    const body = req.method === "GET" ? {} : await readBody(req);
    send(res, 200, await handler(body));
  } catch (error) {
    // 判定器的 Fail 带 kind：rejected = 拒绝（409），infra = 基础设施问题（500）。
    const kind = error.kind ?? "infra";
    const status = kind === "rejected" ? 409 : 500;
    send(res, status, {
      kind,
      code: error.code ?? "E_UNEXPECTED",
      message: error.message,
      extra: error.extra ?? {},
    });
  }
  });
}

if (import.meta.url === "file://" + process.argv[1]) {
  const port = Number(process.env.PORT ?? 4317);
  const server = createServer();
  server.on("error", (error) => {
    if (error.code === "EADDRINUSE") {
      process.stderr.write(
        "端口 " + port + " 已被占用：换一个 PORT 再起（PORT=4318 npm run platform）\n",
      );
      process.exit(3);
    }
    throw error;
  });
  server.listen(port, "127.0.0.1", function () {
    process.stdout.write(
      "平台已起: http://127.0.0.1:" + this.address().port + "\n",
    );
  });
}
