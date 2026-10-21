import { test, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  DEFAULT_ROUTING_PATH,
  DEFAULT_WORKFLOW_GLOB,
  loadRouting,
  resolve,
  scanWorkflows,
  validateRouting,
} from "../scripts/routing.mjs";

// 这一片的判据只有两条，且都能独立变红：声明自洽、workflow 不绕过声明。
// 所以每个用例只坏一条。declaration 与 workflow 都在临时目录里造——
// 扫真仓库只能证明「今天干净」，证明不了「坏了会红」。

const ROOT = process.cwd();
const SCRIPT = join(ROOT, "scripts", "routing.mjs");
const DECL = loadRouting(DEFAULT_ROUTING_PATH, ROOT);
const DATA = DECL.routes;

function clone() {
  return structuredClone(DECL);
}

function sandbox(routes = DATA, workflow) {
  const dir = mkdtempSync(join(tmpdir(), "routing-"));
  const declPath = join(dir, DEFAULT_ROUTING_PATH);
  mkdirSync(dirname(declPath), { recursive: true });
  writeFileSync(
    declPath,
    "version: 1\nroutes:\n" + routes.map(toYaml).join(""),
  );
  if (workflow !== undefined) {
    const flow = join(dir, ".github", "workflows", "audit.yml");
    mkdirSync(dirname(flow), { recursive: true });
    writeFileSync(flow, workflow);
  }
  return { dir, declPath };
}

function toYaml(route) {
  return (
    "  - name: " +
    route.name +
    "\n    provider: " +
    route.provider +
    "\n    model: " +
    route.model +
    "\n    purpose: " +
    route.purpose +
    "\n"
  );
}

function check(cwd) {
  return spawnSync(process.execPath, [SCRIPT, "--check"], {
    cwd,
    encoding: "utf8",
  });
}

// —— 正例：真声明必须真的过，且 resolve 拿到的是真源里那一条 ——

test("真声明自洽，三个逻辑名都能解析出 provider/model", () => {
  expect(validateRouting(DECL, { source: DEFAULT_ROUTING_PATH })).toEqual({
    ok: true,
    errors: [],
  });
  // 契约第四节点名的三个逻辑名就是最小集合，少一个都不算声明完成。
  const names = DATA.map((r) => r.name).sort();
  expect(names).toEqual(["impl", "review-a", "review-b"]);
  for (const name of names) {
    const route = resolve(name, DECL);
    expect(route.logical).toBe(name);
    expect(route.provider).toBeTruthy();
    expect(route.model).toBeTruthy();
    expect(
      route.purpose ?? DATA.find((r) => r.name === name).purpose,
    ).toBeTruthy();
  }
});

// —— 坏声明：空表 / 缺字段 / 重复，各自点名 ——

test("空表报错：一条路由都没有的声明没有意义", () => {
  const cfg = clone();
  cfg.routes = [];
  const { ok, errors } = validateRouting(cfg, { source: "x.yml" });
  expect(ok).toBe(false);
  expect(errors.some((e) => e.includes("空表"))).toBe(true);
});

test("缺字段报错并点名是哪一条缺哪个字段", () => {
  const cfg = clone();
  delete cfg.routes[1].purpose;
  const { ok, errors } = validateRouting(cfg, { source: "x.yml" });
  expect(ok).toBe(false);
  expect(errors).toHaveLength(1);
  expect(errors[0]).toContain(cfg.routes[1].name);
  expect(errors[0]).toContain("purpose");
});

test("逻辑名重复报错并点名重复的那个逻辑名", () => {
  const cfg = clone();
  cfg.routes.push({ ...cfg.routes[0], model: "pending-dup" });
  const { ok, errors } = validateRouting(cfg, { source: "x.yml" });
  expect(ok).toBe(false);
  expect(
    errors.some((e) => e.includes(cfg.routes[0].name) && e.includes("重复")),
  ).toBe(true);
});

test("model 与逻辑名同名、同一 model 跨 provider 都算自相矛盾", () => {
  const same = clone();
  same.routes[0].model = same.routes[1].name;
  expect(validateRouting(same).errors.some((e) => e.includes("同名"))).toBe(
    true,
  );

  const split = clone();
  split.routes[1].model = split.routes[0].model;
  split.routes[1].provider = split.routes[0].provider + "-other";
  expect(
    validateRouting(split).errors.some((e) => e.includes("provider")),
  ).toBe(true);
});

// —— resolve：未知逻辑名要说得出已知有哪些 ——

test("resolve 未知逻辑名抛错，错误信息列出已知逻辑名", () => {
  let message = "";
  try {
    resolve("nope", DECL);
  } catch (error) {
    message = error.message;
  }
  expect(message).toContain("nope");
  for (const route of DATA) expect(message).toContain(route.name);
});

// —— 读声明：缺失 / 空 / 坏 YAML 都不许静默变绿 ——

test("声明缺失、空文件、坏 YAML 都抛错", () => {
  expect(() => loadRouting("nope.yml", tmpdir())).toThrow(/读不到/);
  const empty = sandbox([], undefined);
  writeFileSync(empty.declPath, "");
  expect(() => loadRouting(DEFAULT_ROUTING_PATH, empty.dir)).toThrow(/空文件/);
  writeFileSync(empty.declPath, "routes: [ {name: a\n");
  expect(() => loadRouting(DEFAULT_ROUTING_PATH, empty.dir)).toThrow(/YAML/);
});

// —— scanWorkflows：正反两向，都在临时目录里造 ——

test("workflow 里出现真源的 model 值即命中；换成逻辑名就不再命中", () => {
  const model = DATA[0].model;
  const bad = sandbox(DATA, "jobs:\n  audit:\n    model: " + model + "\n");
  const hits = scanWorkflows(DEFAULT_WORKFLOW_GLOB, DECL, bad.dir);
  expect(hits).toEqual([
    { file: ".github/workflows/audit.yml", line: 3, model },
  ]);

  const good = sandbox(
    DATA,
    "jobs:\n  audit:\n    model: " + DATA[0].name + "\n",
  );
  expect(scanWorkflows(DEFAULT_WORKFLOW_GLOB, DECL, good.dir)).toEqual([]);
});

test("扫描只认真源里的 model 值：别的模型名与更长标识符都不算", () => {
  const model = DATA[0].model;
  const dir = sandbox(
    DATA,
    "jobs:\n  a:\n    model: some-other-model\n  b:\n    model: " +
      model +
      "-x\n",
  );
  expect(scanWorkflows(DEFAULT_WORKFLOW_GLOB, DECL, dir.dir)).toEqual([]);
});

test("没有 workflow 目录不算错误，命中列表为空", () => {
  const dir = mkdtempSync(join(tmpdir(), "routing-"));
  expect(scanWorkflows(DEFAULT_WORKFLOW_GLOB, DECL, dir)).toEqual([]);
});

// —— CLI ——

test("CLI --check 在真仓库上 exit 0 并只打印一行摘要", () => {
  const out = check(ROOT);
  expect(out.status).toBe(0);
  expect(out.stderr).toBe("");
  expect(out.stdout.trim().split("\n")).toHaveLength(1);
  expect(out.stdout).toMatch(/^routing OK \d+ 条路由 \/ \d+ 个 workflow/);
});

test("CLI --check 在坏声明上 exit 1 并点名", () => {
  const empty = sandbox([], undefined);
  writeFileSync(empty.declPath, "version: 1\nroutes: []\n");
  const out = check(empty.dir);
  expect(out.status).toBe(1);
  expect(out.stderr).toContain("空表");
  expect(out.stdout).toBe("");
});

test("CLI --check 在 workflow 硬编码模型名时 exit 1 并点名文件与模型", () => {
  const model = DATA[2].model;
  const dir = sandbox(
    DATA,
    "on: push\njobs:\n  x:\n    model: " + model + "\n",
  );
  const out = check(dir.dir);
  expect(out.status).toBe(1);
  expect(out.stderr).toContain(".github/workflows/audit.yml:4");
  expect(out.stderr).toContain(model);
});

// —— 零联网：脚本里没有任何外联通道 ——

test("routing.mjs 不含任何网络/子进程调用", () => {
  const source = readFileSync(SCRIPT, "utf8");
  for (const needle of [
    "fetch(",
    "node:http",
    "node:https",
    "node:net",
    "node:dns",
    "node:tls",
    "child_process",
    "XMLHttpRequest",
  ])
    expect(source).not.toContain(needle);
});
