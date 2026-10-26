#!/usr/bin/env node
// audit-review.mjs · 审计的执行器（GitHub 侧）：一个槽 -> 一次模型调用 -> 一份 findings JSON。
//
// 它只做「把 diff 送进模型、把模型的话落成契约形状」这件事：
//   * 模型名的真源是 .agents/platform/routing.yml（经 scripts/routing.mjs 解析）；
//     本文件里没有第二个模型名，CLI 也不接受 --model —— 否则真源就有了第二个家，
//     而 routing.mjs 的「workflow 里出现真源 model 值即失败」那条判定会被绕开。
//   * 密钥只从 env 读（DEEPSEEK_API_KEY）：不进 prompt、不落盘、不打印。
//     header 是它唯一的去处；任何诊断文本出去之前都再过一次脱敏。
//   * 判不了就写 INFRA，绝不写 pass：拿不到 key、HTTP 非 200、响应不是 JSON、
//     模型输出不合 schema —— 一律 INFRA + 退出码 3。写出非 INFRA 记录才是 0。
//
// 退出码（与 scripts/audit-collect.mjs 的 EXIT 同一口径）：
//   0 = 写出了可用的 findings 记录（verdict 可能是 pass / needs_revision / reject）
//   2 = 用法错误（参数缺失 / 非法槽名 / --out 目录不存在）—— 什么都不发就说清楚
//   3 = 判不了（INFRA）
// 退出码只回答「这一次判定有没有跑成」，不回答「代码合不合格」：把 needs_revision
// 也映射成 1，会让调用方把「判过了，结论是不合格」和「没判过」混成一件事故。
//
// —— verdict 为什么由 severity 机械推出，而不是让模型自己声明 ——
// 模型只报缺陷；verdict 若也由模型给，同一个字段就有两个写者（模型的口径和契约的口径），
// 不一致时没有任何办法判断谁对。这里用一条可复算的映射：
//   有 blocker -> reject · 有其它缺陷 -> needs_revision · 一条都没有 -> pass。
//
// evidence 必须是真事实：executor=github / agent=槽名 / model=本次实际调用的模型（真源解析而来）
// / request_id=上游响应 id。拿不到就不写这个字段，绝不用占位符顶上 ——
// scripts/audit-findings.mjs 会把 pending-* 与空串判成占位符，占位符越过门就是把
// 「没跑到」写成「跑到并通过」。

import {
  existsSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { validateResult } from "./audit-findings.mjs";
import {
  DEFAULT_ROUTING_PATH,
  loadRouting,
  resolve as resolveRoute,
} from "./routing.mjs";

export const EXIT = { PASS: 0, FAIL: 1, USAGE: 2, UNKNOWN: 3 };
export const SLOTS = ["review-a", "review-b"];
export const EXECUTOR = "github";
export const DEFAULT_API_BASE = "https://api.deepseek.com";
export const MAX_DIFF_CHARS = 120_000;
export const DEFAULT_TIMEOUT_MS = 180_000;
export const TRUNCATED_NOTE =
  "（diff 超过 " +
  MAX_DIFF_CHARS +
  " 字符，只送了前 " +
  MAX_DIFF_CHARS +
  " 字符：已截断）";

const USAGE =
  "用法: node scripts/audit-review.mjs --slot review-a|review-b --diff <diff 文件> --out <输出 json> [--api-base <url>]";

const VALUE_FLAGS = {
  "--slot": "slot",
  "--diff": "diff",
  "--out": "out",
  "--api-base": "apiBase",
};

const SYSTEM_PROMPT = [
  "你是代码审计器：只审查给出的 git diff，不猜 diff 以外的文件。",
  '只输出一个 JSON 对象：{"findings":[{"path","line","severity","criterion","suggestion"}]}，不要输出任何解释文字。',
  "path 用 diff 里的仓库相对路径（去掉 a/ b/ 前缀）；line 用变更后（+ 侧）的行号，必须是 ≥1 的整数。",
  "severity 只能是 blocker / high / medium / low。",
  "criterion 写违反了哪条判据，suggestion 写怎么改；两者都不能为空。",
  '没有缺陷就输出 {"findings":[]}。',
].join("\n");

const isText = (value) => typeof value === "string" && value.trim() !== "";
const describe = (error) =>
  error instanceof Error
    ? error.message
    : error === undefined
      ? "未知错误"
      : String(error);
const clip = (value, max) => {
  const text = String(value ?? "")
    .replace(/[\r\n]+/g, " ")
    .trim();
  return text.length <= max ? text : text.slice(0, max) + "…";
};
// 脱敏放在唯一的诊断出口上，而不是散在各条错误上：漏掉哪一条，哪一条就是泄漏面。
const redact = (text, secret) =>
  isText(secret)
    ? String(text ?? "")
        .split(secret)
        .join("[REDACTED]")
    : String(text ?? "");

// 参数是输入面：每个都要点名。--model 刻意不存在 —— 它一旦存在，模型名就有第二个家。
export function parseArgs(argv, root = process.cwd()) {
  const values = {
    slot: null,
    diff: null,
    out: null,
    apiBase: DEFAULT_API_BASE,
  };
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!Object.hasOwn(VALUE_FLAGS, token))
      return { ok: false, error: "认不出的参数 " + JSON.stringify(token) };
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--"))
      return { ok: false, error: token + " 缺少取值" };
    if (seen.has(token)) return { ok: false, error: token + " 重复给出" };
    seen.add(token);
    values[VALUE_FLAGS[token]] = value;
    index += 1;
  }

  if (values.slot === null)
    return { ok: false, error: "--slot 必填（" + SLOTS.join("|") + "）" };
  if (!SLOTS.includes(values.slot))
    return {
      ok: false,
      error:
        "--slot 只接受 " +
        SLOTS.join("|") +
        "，收到 " +
        JSON.stringify(values.slot),
    };
  if (values.out === null)
    return { ok: false, error: "--out 必填（该槽的 findings JSON 文件）" };

  // 目录不存在就报错，不替调用方创建：--out 指错路径时，悄悄造一份记录比失败更坏。
  const outPath = isAbsolute(values.out)
    ? values.out
    : resolvePath(root, values.out);
  const outDir = dirname(outPath);
  if (!existsSync(outDir) || !statSync(outDir).isDirectory())
    return {
      ok: false,
      error: "--out 的目录不存在：" + outDir + "（本脚本不创建目录）",
    };

  if (values.diff === null)
    return { ok: false, error: "--diff 必填（调用方生成的 git diff 文本）" };
  const diffPath = isAbsolute(values.diff)
    ? values.diff
    : resolvePath(root, values.diff);
  if (!existsSync(diffPath))
    return { ok: false, error: "--diff 文件不存在：" + values.diff };
  if (!statSync(diffPath).isFile())
    return { ok: false, error: "--diff 不是文件：" + values.diff };
  let diffText;
  try {
    diffText = readFileSync(diffPath, "utf8");
  } catch (error) {
    return {
      ok: false,
      error: "--diff 读不出来：" + String(error?.code ?? describe(error)),
    };
  }

  if (!/^https?:\/\/[^/\s]+/.test(values.apiBase))
    return {
      ok: false,
      error:
        "--api-base 必须是 http(s) URL，收到 " + JSON.stringify(values.apiBase),
    };

  return {
    ok: true,
    opts: {
      slot: values.slot,
      out: outPath,
      diff: diffText,
      apiBase: values.apiBase.replace(/\/+$/, ""),
    },
  };
}

// 截断是脚本自己的事（调用方只管给 diff）：上限内原样送，超了就截断并在 prompt 里说明，
// 免得模型对着半截 diff 断言「没有缺陷」而没人知道它看漏了。
export function buildPrompt(diffText) {
  const text = typeof diffText === "string" ? diffText : "";
  const truncated = text.length > MAX_DIFF_CHARS;
  const body = truncated ? text.slice(0, MAX_DIFF_CHARS) : text;
  const fence = "```";
  return [
    { role: "system", content: SYSTEM_PROMPT },
    {
      role: "user",
      content:
        (truncated ? TRUNCATED_NOTE + "\n\n" : "") +
        fence +
        "diff\n" +
        body +
        "\n" +
        fence,
    },
  ];
}

// verdict 的唯一来源：见文件头。模型不参与这一列。
export function verdictFor(findings) {
  const list = Array.isArray(findings) ? findings : [];
  if (list.length === 0) return "pass";
  return list.some((finding) => finding?.severity === "blocker")
    ? "reject"
    : "needs_revision";
}

// 模型偶尔把 JSON 包在围栏里。剥围栏只是去掉传输格式，不改内容；
// 剥完还不是 JSON 就按「输出不合契约」判 INFRA。
function stripFence(text) {
  const fence = "```";
  const trimmed = text.trim();
  if (!trimmed.startsWith(fence)) return trimmed;
  const firstBreak = trimmed.indexOf("\n");
  if (firstBreak === -1) return trimmed;
  const rest = trimmed.slice(firstBreak + 1);
  const end = rest.lastIndexOf(fence);
  return (end === -1 ? rest : rest.slice(0, end)).trim();
}

export function parseModelJson(content) {
  const text = typeof content === "string" ? stripFence(content) : "";
  if (text === "") return { ok: false, error: "模型回复是空的" };
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (error) {
    return { ok: false, error: "模型回复不是合法 JSON：" + describe(error) };
  }
}

const readBody = async (response) => {
  try {
    return typeof response.text === "function" ? await response.text() : "";
  } catch {
    return "";
  }
};

// 网络层只有一个出口，fetch 从参数注入：测试注入假实现，绝不真发请求。
export async function requestChat({
  apiBase,
  apiKey,
  model,
  messages,
  fetchImpl,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}) {
  if (typeof fetchImpl !== "function")
    return { ok: false, reason: "运行环境没有可用的 fetch：判不了" };
  const url = String(apiBase).replace(/\/+$/, "") + "/chat/completions";
  const body = { model, messages, stream: false, temperature: 0 };
  let response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer " + apiKey,
      },
      body: JSON.stringify(body),
      signal:
        typeof AbortSignal !== "undefined" &&
        typeof AbortSignal.timeout === "function"
          ? AbortSignal.timeout(timeoutMs)
          : undefined,
    });
  } catch (error) {
    return {
      ok: false,
      reason: "调用上游失败（没拿到响应）：" + describe(error),
    };
  }
  if (!response || typeof response !== "object")
    return { ok: false, reason: "调用上游失败：fetch 没有返回响应" };

  const status = response.status;
  const text = await readBody(response);
  if (status !== 200)
    return {
      ok: false,
      reason: "上游 HTTP " + String(status) + "：" + clip(text, 200),
    };

  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    return { ok: false, reason: "上游响应体不是 JSON：" + clip(text, 200) };
  }
  const choices =
    payload && Array.isArray(payload.choices) ? payload.choices : null;
  const content = choices?.[0]?.message?.content;
  if (typeof content !== "string")
    return { ok: false, reason: "上游响应里没有 choices[0].message.content" };
  return {
    ok: true,
    content,
    requestId: typeof payload.id === "string" ? payload.id : null,
  };
}

// evidence 只写已知的真事实：不知道就不写这个字段，交给口径层判「不算证据」。
const evidenceFor = ({ slot, model, requestId }) => {
  const evidence = { executor: EXECUTOR, agent: slot };
  if (isText(model)) evidence.model = model;
  if (isText(requestId)) evidence.request_id = requestId;
  return evidence;
};

export async function run(argv, deps = {}) {
  const root = deps.root ?? process.cwd();
  const env = deps.env ?? process.env;
  const log = deps.out ?? ((line) => process.stdout.write(line + "\n"));
  const warn = deps.err ?? ((line) => process.stderr.write(line + "\n"));
  const fetchImpl = deps.fetch ?? globalThis.fetch;

  const parsed = parseArgs(argv, root);
  if (!parsed.ok) {
    warn("audit-review " + parsed.error);
    warn(USAGE);
    return EXIT.USAGE;
  }
  const { slot, out: outPath, apiBase, diff } = parsed.opts;
  const apiKey =
    typeof env.DEEPSEEK_API_KEY === "string" ? env.DEEPSEEK_API_KEY.trim() : "";

  const infra = ({ model, requestId, reason, findings }) => ({
    verdict: "INFRA",
    findings: Array.isArray(findings) ? findings : [],
    evidence: evidenceFor({ slot, model, requestId }),
    reason,
  });

  // 唯一写出口：无论成败都落这一份文件。写不出去 = 判不了，退出码不给 0。
  const finish = (record) => {
    try {
      writeFileSync(outPath, JSON.stringify(record, null, 2) + "\n");
    } catch (error) {
      warn("audit-review 写不出 " + outPath + "：" + describe(error));
      return EXIT.UNKNOWN;
    }
    const code = record.verdict === "INFRA" ? EXIT.UNKNOWN : EXIT.PASS;
    log(
      "audit-review slot=" +
        slot +
        " verdict=" +
        record.verdict +
        " findings=" +
        record.findings.length +
        " exit=" +
        code +
        " out=" +
        outPath,
    );
    if (record.reason) warn("audit-review " + redact(record.reason, apiKey));
    return code;
  };

  // 模型名的真源。读不到就不许猜一个模型去调 —— 那会把「配置坏了」变成一次假运行。
  let route;
  try {
    route = resolveRoute(
      slot,
      loadRouting(deps.routingPath ?? DEFAULT_ROUTING_PATH, root),
    );
  } catch (error) {
    return finish(
      infra({
        reason:
          "取不到模型真源（" +
          String(deps.routingPath ?? DEFAULT_ROUTING_PATH) +
          "）：" +
          describe(error),
      }),
    );
  }
  const model = route.model;

  if (apiKey === "")
    return finish(
      infra({ model, reason: "没有 DEEPSEEK_API_KEY：判不了，不是通过" }),
    );

  const call = await requestChat({
    apiBase,
    apiKey,
    model,
    messages: buildPrompt(diff),
    fetchImpl,
    timeoutMs: deps.timeoutMs,
  });
  if (!call.ok)
    return finish(infra({ model, reason: redact(call.reason, apiKey) }));

  // request_id 是「真跑过」的凭据：拿不到就不编，直接按判不了处理。
  if (!isText(call.requestId))
    return finish(
      infra({
        model,
        reason: "上游没有回 request_id：没有它就无法追溯，不拿占位符凑数",
      }),
    );

  const parsedJson = parseModelJson(call.content);
  if (!parsedJson.ok)
    return finish(
      infra({ model, requestId: call.requestId, reason: parsedJson.error }),
    );

  const findings = parsedJson.value && parsedJson.value.findings;
  if (!Array.isArray(findings))
    return finish(
      infra({
        model,
        requestId: call.requestId,
        reason: "模型输出的 JSON 里没有 findings 数组",
      }),
    );

  const record = {
    verdict: verdictFor(findings),
    findings,
    evidence: evidenceFor({ slot, model, requestId: call.requestId }),
  };
  // 判据只问口径层要（scripts/audit-findings.mjs），不在这里抄第二份。
  const validation = validateResult(record);
  if (!validation.ok)
    return finish(
      infra({
        model,
        requestId: call.requestId,
        reason: "模型输出不合 schema：" + validation.errors.join("；"),
      }),
    );
  return finish(record);
}

// 入口判定走 realpath（与 scripts/audit-slot.mjs / audit-collect.mjs 同一条规矩）：
// worktree / 软链下 argv[1] 与 import.meta.url 不是同一条字面路径，判不中就会静默
// 不执行、exit 0 —— 于是 --out 那份记录根本没写出去，而调用方看到的是绿。
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
  run(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      process.stderr.write(
        "audit-review 崩溃: " + (error?.stack ?? error) + "\n",
      );
      process.exitCode = EXIT.UNKNOWN;
    },
  );
