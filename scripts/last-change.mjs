#!/usr/bin/env node
// last-change.mjs · 门牌的幂等重算（契约见 docs/last-change.md）
//
// 门牌是派生物：同一份输入（宿主事件 + git 区间）重算任意次，输出逐字相同。
// 因此覆盖写是安全的；写回 PR body 之后内容不再变化，重算也不会自激。
//
// 输入只有两类：宿主事件（EVENT / EVENT_NAME）与 git 区间（BASE..HEAD）。
// 身份全部取宿主字段，不读调用方自述；时间也不来自环境 —— 合并日期取自事件的
// merged_at，本脚本没有 Date.now()，「时钟」完全由注入的输入决定。
//
// 算不出来就报错（退出 1）：没引用 issue、区间里没有文件、合并事件缺
// merged_at / merged_by，都绝不输出空表当成功。

import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { resolveIssueRefs } from "./build-intent.mjs";

const HEADING = "## LAST-CHANGE";
const NOTICE = "<!-- 由 CI 重算，请勿手改 -->";
export const BLOCK_BEGIN = "<!-- LAST-CHANGE:BEGIN -->";
export const BLOCK_END = "<!-- LAST-CHANGE:END -->";
// 表里「还没发生」的项：审核人未指派、PR 未合并。空白更糟——分不清是没值还是脚本坏了。
const UNSET = "—";

function need(value, what) {
  if (value === undefined || value === null || String(value).trim() === "")
    throw new Error(`门牌缺 ${what}：算不出来就不写`);
  return String(value).trim();
}

function needNumber(value, what) {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0)
    throw new Error(
      `门牌缺 ${what}：期望正整数，实际 ${JSON.stringify(value)}`,
    );
  return n;
}

// 合并日期只认宿主给的 merged_at，取 UTC 日期（不做时区换算，换台机器也同答案）。
export function mergeDate(mergedAt) {
  const m = /^(\d{4}-\d{2}-\d{2})(?:[T ].*)?$/.exec(
    String(mergedAt ?? "").trim(),
  );
  if (!m)
    throw new Error(
      `合并日期算不出来：期望 ISO 时间，实际 ${JSON.stringify(mergedAt)}`,
    );
  return m[1];
}

// 表格单元格只做转义：竖线会切断列，换行会切断行。
function cell(value) {
  return String(value)
    .replace(/\s*\r?\n\s*/g, " ")
    .replace(/\|/g, "\\|")
    .trim();
}

// 对齐宽度按东亚宽字符算 2 列，与 PR 模板里那张表的观感一致；结果只依赖入参。
function width(text) {
  let w = 0;
  for (const ch of text)
    w +=
      /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6]/.test(
        ch,
      )
        ? 2
        : 1;
  return w;
}

function table(rows) {
  const w0 = Math.max(2, ...rows.map((r) => width(r[0])));
  const w1 = Math.max(2, ...rows.map((r) => width(r[1])));
  const line = (a, b) =>
    `| ${a}${" ".repeat(w0 - width(a))} | ${b}${" ".repeat(w1 - width(b))} |`;
  return [
    line("项", "值"),
    `| ${"-".repeat(w0)} | ${"-".repeat(w1)} |`,
    ...rows.map(([k, v]) => line(k, v)),
  ].join("\n");
}

// PR 正文里被引用的 issue：body 优先，body 一个都没写才看 title（与 build-intent 同一规则）。
// 只认「关键字 + #N」的显式引用；0 个或多个都算算不出来，不猜。
export function resolveIssue({ body, title }) {
  const inBody = resolveIssueRefs(body);
  const refs = inBody.length > 0 ? inBody : resolveIssueRefs(title);
  if (refs.length !== 1)
    throw new Error(
      `PR 必须引用恰好一个 issue（如 Fixes #4），实际 ${refs.length} 个：${JSON.stringify(refs)}`,
    );
  return refs[0];
}

// 宿主事件 → 门牌输入。merged=false 时合并人/日期必须缺席，不让半个合并信息混进去。
export function inputFromEvent({ eventName, payload }) {
  if (eventName !== "pull_request" || !payload?.pull_request)
    throw new Error(
      `门牌只由 pull_request 事件重算，实际是 ${JSON.stringify(eventName)}`,
    );
  const pr = payload.pull_request;
  const merged = pr.merged === true;
  return {
    pr: pr.number,
    title: pr.title,
    proposer: pr.user?.login,
    body: pr.body ?? "",
    // 宿主给的 review 名单；没人被指派就是 UNSET，不臆测审核人。
    reviewers: (pr.requested_reviewers ?? [])
      .map((r) => r?.login ?? r)
      .filter(Boolean),
    mergedBy: merged ? pr.merged_by?.login : null,
    mergedAt: merged ? pr.merged_at : null,
  };
}

// 这个 PR 自己的改动：三点 diff 从 merge-base 起算，才不会把 base 的历史算进门牌。
export function changedFiles({ base, head, cwd = process.cwd() }) {
  const b = need(base, "git 区间的 base");
  const h = need(head, "git 区间的 head");
  let out;
  try {
    out = execFileSync(
      "git",
      // 门牌列的文件必须在 head 上真的存在（G2 就是这么判的），所以：
      // 删掉的不列（--diff-filter=d 排除 D），重命名只留新路径（-M 打开重命名检测）。
      // 少了这两条，一次 git mv 就会让门牌列出已经不存在的路径，门自己打自己。
      [
        "diff",
        "--name-only",
        "--diff-filter=d",
        "-M",
        "--no-color",
        "--no-ext-diff",
        `${b}...${h}`,
      ],
      { cwd, encoding: "utf8" },
    );
  } catch (error) {
    throw new Error(`git diff ${b}...${h} 失败：${error.message.trim()}`);
  }
  const files = out
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean)
    .sort();
  if (files.length === 0)
    throw new Error(`${b}...${h} 里没有文件变更：门牌不能是空表`);
  return files;
}

// 一张表：派生物的全部内容都在这里，行与顺序跟 PR 模板一致。
export function renderLastChange(input) {
  const pr = needNumber(input.pr, "PR 号");
  const issue = needNumber(input.issue, "issue 号");
  const title = need(input.title, "标题");
  const proposer = need(input.proposer, "提议人");
  const files = input.files ?? [];
  if (files.length === 0) throw new Error("门牌缺变更文件：算不出来就不写");

  const mergedBy = input.mergedBy ?? null;
  const mergedAt = input.mergedAt ?? null;
  if ((mergedBy === null) !== (mergedAt === null))
    throw new Error("合并人与合并日期必须成对出现：只补一半会让门牌自相矛盾");

  const rows = [
    ["提议人", proposer],
    ["审核人", input.reviewers?.length ? input.reviewers.join(", ") : UNSET],
    ["issue", `#${issue}`],
    ["PR", `#${pr}`],
    ["标题", title],
    ["变更文件", files.map((f) => `\`${f}\``).join(", ")],
    ["合并人", mergedBy ?? UNSET],
    ["合并日期", mergedAt === null ? UNSET : mergeDate(mergedAt)],
  ].map(([k, v]) => [k, cell(v)]);
  return table(rows);
}

export function renderSection(input) {
  return [
    HEADING,
    "",
    NOTICE,
    "",
    BLOCK_BEGIN,
    renderLastChange(input),
    BLOCK_END,
  ].join("\n");
}

// 覆盖写，不追加：标记区间 → 整节 → 追加，三种情况都收敛到「只有一张表」。
// 节内残留的冲突标记、旧表、手写内容一律被这次重算覆盖 —— 派生物不需要人工合并。
export function replaceLastChangeSection(text, section) {
  const source = String(text ?? "");
  const begin = source.indexOf(BLOCK_BEGIN);
  const end = source.indexOf(BLOCK_END);
  if (begin !== -1 && end > begin) {
    const inner = section.slice(section.indexOf(BLOCK_BEGIN));
    return (
      source.slice(0, begin) + inner + source.slice(end + BLOCK_END.length)
    );
  }
  const at = source.indexOf(HEADING);
  if (at !== -1) {
    const lead = source.slice(0, at).replace(/\s+$/, "");
    const rest = source.slice(at + HEADING.length);
    const next = rest.search(/\n## /);
    // 后面还有别的小节就不吞掉它；门牌与它之间留一个空行。
    const after = next === -1 ? "" : rest.slice(next + 1);
    return (
      (lead ? lead + "\n\n" : "") + section + (after ? "\n\n" + after : "\n")
    );
  }
  const lead = source.replace(/\s+$/, "");
  return (lead ? lead + "\n\n" : "") + section + "\n";
}

// 落盘要么整份新表，要么什么都不动：补写失败时已有字段必须原样还在。
export function writeAtomic(path, text) {
  const tmp = `${path}.tmp-${process.pid}`;
  try {
    writeFileSync(tmp, text, "utf8");
    renameSync(tmp, path);
  } catch (error) {
    try {
      unlinkSync(tmp);
    } catch {
      // 临时文件本来就没建成，没什么可删的
    }
    throw error;
  }
}

// 「这次重算改动了没有」是脚本自己知道的事实，由它公布，别让 YAML 去猜。
function publishChanged(changed) {
  const path = process.env.GITHUB_OUTPUT;
  if (!path) return;
  appendFileSync(path, `changed=${changed ? 1 : 0}\n`);
}

function main(argv) {
  const flag = (name) => {
    const at = argv.indexOf(name);
    return at === -1 ? undefined : argv[at + 1];
  };
  try {
    const payload = JSON.parse(process.env.EVENT ?? "{}");
    const input = inputFromEvent({
      eventName: process.env.EVENT_NAME ?? "",
      payload,
    });
    const files = changedFiles({
      base: process.env.BASE,
      head: process.env.HEAD,
    });
    const before = flag("--in") ? readFileSync(flag("--in"), "utf8") : "";
    const text = replaceLastChangeSection(
      before,
      renderSection({ ...input, issue: resolveIssue(input), files }),
    );
    const out = flag("--out");
    if (out) writeAtomic(out, text);
    else process.stdout.write(text);
    publishChanged(text !== before);
  } catch (error) {
    process.stderr.write(`门牌重算失败：${error.message}\n`);
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`)
  main(process.argv.slice(2));
