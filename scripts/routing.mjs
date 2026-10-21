#!/usr/bin/env node
// routing.mjs · 逻辑名 → 模型映射的真源解析 + 两条机械判定
//
// 审计契约第四节：workflow 里只写逻辑名（review-a / review-b / impl），真实模型由网关映射，
// 网关只是执行者，真源在 .agents/platform/routing.yml。于是本脚本只做两件事：
//   1) 声明本身自洽（validateRouting）—— 空表、缺字段、逻辑名重复、结构自相矛盾；
//   2) workflow 没有绕过声明（scanWorkflows）—— 文件里出现任何一个真源里的 model 值即违规。
// 第二条的判据从真源推出，不需要猜模型命名规范：不依赖「模型名长什么样」这个平台事实。
//
// 不联网：输入只有文件。--check 有任何问题写 stderr 并 exit 1，全好打印一行摘要 exit 0。

import { readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

export const DEFAULT_ROUTING_PATH = ".agents/platform/routing.yml";
export const DEFAULT_WORKFLOW_GLOB = ".github/workflows/*.yml";

const REQUIRED_FIELDS = ["provider", "model", "purpose"];
// 「像标识符的字符」：命中边界判定用；模型名里的 - . _ 都算标识符内部。
const WORDISH = /[A-Za-z0-9_.-]/;

const nonEmpty = (value) => typeof value === "string" && value.trim() !== "";

export class RoutingError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "RoutingError";
    this.code = code;
  }
}

// 读声明。缺失 / 空文件 / 坏 YAML / 结构不对一律抛错——静默返回空表会让 --check 变绿，
// 而对门来说「看起来绿」是最坏的失败形态。
export function loadRouting(path = DEFAULT_ROUTING_PATH, root = process.cwd()) {
  const abs = isAbsolute(path) ? path : resolvePath(root, path);
  let raw;
  try {
    raw = readFileSync(abs, "utf8");
  } catch {
    throw new RoutingError("E_ROUTING_MISSING", "读不到路由声明: " + path);
  }
  if (raw.trim() === "")
    throw new RoutingError("E_ROUTING_EMPTY", "路由声明是空文件: " + path);
  let cfg;
  try {
    cfg = YAML.parse(raw);
  } catch (error) {
    throw new RoutingError(
      "E_ROUTING_UNPARSABLE",
      "路由声明不是合法 YAML: " + path + ": " + error.message,
    );
  }
  if (cfg === null || typeof cfg !== "object" || Array.isArray(cfg))
    throw new RoutingError(
      "E_ROUTING_SHAPE",
      "路由声明顶层必须是映射: " + path,
    );
  if (!Array.isArray(cfg.routes))
    throw new RoutingError(
      "E_ROUTING_SHAPE",
      "路由声明缺少 routes 列表: " + path,
    );
  return cfg;
}

// 声明自洽。errors 逐条点名是哪一条路由的哪个字段——读者不需要再猜。
export function validateRouting(cfg, { source = DEFAULT_ROUTING_PATH } = {}) {
  const routes = Array.isArray(cfg?.routes) ? cfg.routes : null;
  if (!routes) return { ok: false, errors: [source + ": 缺少 routes 列表"] };
  const errors = [];
  if (routes.length === 0)
    errors.push(source + ": 空表 —— 一条路由都没有的声明没有意义");

  const firstIndex = new Map();
  routes.forEach((route, i) => {
    const at = source + ": routes[" + i + "]";
    if (!route || typeof route !== "object" || Array.isArray(route)) {
      errors.push(at + " 不是对象");
      return;
    }
    const named = nonEmpty(route.name);
    const label = named ? "逻辑名 " + route.name : at + "（缺 name）";
    if (!named) errors.push(at + ": 缺少 name（逻辑名）");
    for (const field of REQUIRED_FIELDS)
      if (!nonEmpty(route[field])) errors.push(label + ": 缺少 " + field);
    if (named) {
      if (firstIndex.has(route.name))
        errors.push(
          label +
            ": 逻辑名重复（第 " +
            (firstIndex.get(route.name) + 1) +
            " 条与第 " +
            (i + 1) +
            " 条）",
        );
      else firstIndex.set(route.name, i);
    }
  });

  // 结构自洽的两条判据。都不引用模型命名规范——命名规范是平台事实，本仓库无从证实。
  const names = new Set(firstIndex.keys());
  const modelOwners = new Map();
  for (const route of routes) {
    if (!route || typeof route !== "object") continue;
    if (!nonEmpty(route.model)) continue;
    const label = nonEmpty(route.name)
      ? "逻辑名 " + route.name
      : "routes 中的一条";
    // model 不得等于某个逻辑名：同一字符串既是逻辑名又是模型名，会让
    // 「workflow 里出现 model 值」这条判据自相矛盾（写逻辑名也会被判违规）。
    if (names.has(route.model))
      errors.push(
        label +
          ": model 与逻辑名 " +
          route.model +
          " 同名，逻辑名与模型名必须分开",
      );
    // 同一 model 值不得挂在不同 provider 下：模型 id 是 provider 域内的，
    // 跨 provider 同名 = 声明有歧义，网关按哪个执行都不对。
    const owner = modelOwners.get(route.model);
    if (owner && owner.provider !== route.provider)
      errors.push(
        label +
          ": model " +
          route.model +
          " 已由逻辑名 " +
          owner.name +
          " 声明在 provider " +
          owner.provider +
          " 下，不能同时属于 " +
          String(route.provider),
      );
    else if (!owner)
      modelOwners.set(route.model, {
        name: route.name ?? "(未命名)",
        provider: route.provider,
      });
  }

  return { ok: errors.length === 0, errors };
}

// 解析逻辑名。未知逻辑名要能直接读：错误里列出已知逻辑名，省掉一次开文件。
export function resolve(logical, cfg) {
  const routes = Array.isArray(cfg?.routes) ? cfg.routes : [];
  const route = routes.find((r) => nonEmpty(r?.name) && r.name === logical);
  if (!route) {
    const known = routes.map((r) => r?.name).filter(nonEmpty);
    throw new RoutingError(
      "E_ROUTING_UNKNOWN",
      "未知逻辑名 " +
        JSON.stringify(logical) +
        "；已知逻辑名: " +
        (known.length ? known.join(", ") : "(空表)"),
    );
  }
  return { logical, provider: route.provider, model: route.model };
}

function globToRegExp(pattern) {
  const escaped = pattern.replace(/[.+^$(){}|[\]\\?]/g, "\\$&");
  return new RegExp(
    "^" + escaped.replace(/\*/g, ".*").replace(/\?/g, ".") + "$",
  );
}

// 极简展开：只认最后一段里的 * 与 ?（.github/workflows/*.yml 这一种用法就够了）。
// 目录不存在 = 没有 workflow，返回空数组（不是错误，摘要里会报 0 个）。
function expand(pathsOrGlob, root) {
  const lists = Array.isArray(pathsOrGlob) ? pathsOrGlob : [pathsOrGlob];
  const files = [];
  for (const entry of lists) {
    if (typeof entry !== "string") continue;
    const abs = isAbsolute(entry) ? entry : resolvePath(root, entry);
    if (/[*?]/.test(entry)) {
      const cut = Math.max(abs.lastIndexOf("/"), abs.lastIndexOf("\\"));
      const dir = cut === -1 ? "." : abs.slice(0, cut) || "/";
      const matcher = globToRegExp(abs.slice(cut + 1));
      let names;
      try {
        names = readdirSync(dir);
      } catch {
        continue;
      }
      for (const name of names.sort())
        if (matcher.test(name) && statSync(join(dir, name)).isFile())
          files.push(join(dir, name));
      continue;
    }
    try {
      if (statSync(abs).isFile()) files.push(abs);
    } catch {
      // 显式给出的文件不存在：跳过。缺失的 workflow 由别处判，不在这里伪造命中。
    }
  }
  return files;
}

function occurs(line, model) {
  let from = 0;
  for (;;) {
    const at = line.indexOf(model, from);
    if (at === -1) return false;
    const before = at === 0 ? "" : line[at - 1];
    const after = line[at + model.length] ?? "";
    if (!WORDISH.test(before) && !WORDISH.test(after)) return true;
    from = at + 1;
  }
}

// 扫 workflow：文件里出现真源里的任何一个 model 值即违规（含注释——注释里的模型名
// 同样是绕过真源的泄漏）。判据全部来自 routing.yml，没有第二条模型命名规则。
export function scanWorkflows(
  pathsOrGlob = DEFAULT_WORKFLOW_GLOB,
  cfg,
  root = process.cwd(),
) {
  const config = cfg ?? loadRouting(DEFAULT_ROUTING_PATH, root);
  const routes = Array.isArray(config?.routes) ? config.routes : [];
  const models = [...new Set(routes.map((r) => r?.model).filter(nonEmpty))];
  const hits = [];
  if (models.length === 0) return hits;
  for (const file of expand(pathsOrGlob, root)) {
    const lines = readFileSync(file, "utf8").split(/\r?\n/);
    lines.forEach((line, i) => {
      for (const model of models)
        if (occurs(line, model))
          hits.push({ file: relative(root, file) || file, line: i + 1, model });
    });
  }
  return hits;
}

function main(argv) {
  if (!argv.includes("--check")) {
    process.stderr.write("用法: node scripts/routing.mjs --check\n");
    process.exit(2);
  }
  const root = process.cwd();
  const fail = (lines) => {
    for (const line of lines) process.stderr.write(line + "\n");
    process.stderr.write(
      "routing FAIL " +
        lines.length +
        " 个问题（" +
        DEFAULT_ROUTING_PATH +
        "）\n",
    );
    process.exit(1);
  };
  let cfg;
  try {
    cfg = loadRouting(DEFAULT_ROUTING_PATH, root);
  } catch (error) {
    fail([error instanceof RoutingError ? error.message : String(error)]);
  }
  const verdict = validateRouting(cfg, { source: DEFAULT_ROUTING_PATH });
  if (!verdict.ok) fail(verdict.errors);
  let hits;
  try {
    hits = scanWorkflows(DEFAULT_WORKFLOW_GLOB, cfg, root);
  } catch (error) {
    fail([error instanceof RoutingError ? error.message : String(error)]);
  }
  if (hits.length)
    fail(
      hits.map(
        (h) =>
          h.file +
          ":" +
          h.line +
          " 硬编码了模型名 " +
          h.model +
          "（workflow 只许写逻辑名，模型映射的真源是 " +
          DEFAULT_ROUTING_PATH +
          "）",
      ),
    );
  const files = expand(DEFAULT_WORKFLOW_GLOB, root).length;
  process.stdout.write(
    "routing OK " +
      cfg.routes.length +
      " 条路由 / " +
      files +
      " 个 workflow 无硬编码模型名\n",
  );
  process.exit(0);
}

// 入口判定走 realpath：worktree / 挂载点下 argv[1] 与 import.meta.url 不是同一条字面路径，
// 判不中就成了「静默不判定、exit 0」——对门来说是最坏的失败形态。
const invoked = process.argv[1]
  ? (() => {
      try {
        return realpathSync(process.argv[1]);
      } catch {
        return undefined;
      }
    })()
  : undefined;
if (invoked && invoked === realpathSync(fileURLToPath(import.meta.url)))
  main(process.argv.slice(2));
