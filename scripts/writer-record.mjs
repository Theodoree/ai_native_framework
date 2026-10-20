#!/usr/bin/env node
// writer-record.mjs · 唯一写者的「留痕」出口
//
// 判定器给出 verdict 之后，评论正文与 job 红绿只在这里生成：
//   allowed  → 不留痕，退出 0（合法路径本就不评论）
//   rejected → 留痕，退出 0（拒绝不是故障，红 job 会掩盖它）
//   infra    → 留痕，退出 1（没判定成功绝不当通过）
// 「怎么留痕」只有这一个家；判定逻辑不在这里，在 state-validate.mjs。

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

// 正文格式（与既有评论逐字一致）：verdict 大写 + code + 破折号 + 原因。
export function recordBody(verdict) {
  const kind = verdict?.verdict;
  if (kind === "allowed") return null;
  if (kind !== "rejected" && kind !== "infra")
    throw new Error(`未知判定结果: ${JSON.stringify(verdict)}`);
  return `状态未被修改：${kind.toUpperCase()} ${verdict.code} — ${verdict.message}`;
}

// 只有 infra 让 job 红；其余（含认不出的结果）都不是「通过」。
export function recordExitCode(verdict) {
  const kind = verdict?.verdict;
  return kind === "allowed" || kind === "rejected" ? 0 : 1;
}

// comment(issue, body) 由调用方注入：CLI 用 gh，测试用假实现。
export async function recordOutcome({ verdict, issue, comment }) {
  const body = recordBody(verdict);
  if (body !== null) {
    if (!Number.isInteger(issue) || issue <= 0)
      throw new Error(`留痕需要一个 issue 号，实际是 ${JSON.stringify(issue)}`);
    await comment(issue, body);
  }
  return recordExitCode(verdict);
}

function main(argv) {
  const flag = (name, fallback) => {
    const at = argv.indexOf(name);
    return at === -1 ? fallback : argv[at + 1];
  };
  let verdict;
  try {
    verdict = JSON.parse(
      readFileSync(flag("--verdict", "verdict.json"), "utf8"),
    );
  } catch (error) {
    process.stderr.write(`读不到判定结果: ${error.message}\n`);
    process.exit(1);
  }
  const post = (issue, body) =>
    execFileSync("gh", ["issue", "comment", String(issue), "--body", body], {
      stdio: ["ignore", "inherit", "inherit"],
    });
  recordOutcome({ verdict, issue: Number(flag("--issue", "0")), comment: post })
    .then((code) => {
      if (code !== 0)
        process.stderr.write(
          `${verdict.verdict.toUpperCase()} ${verdict.code}\n`,
        );
      process.exit(code);
    })
    .catch((error) => {
      process.stderr.write(`留痕失败: ${error.message}\n`);
      process.exit(1);
    });
}

if (import.meta.url === `file://${process.argv[1]}`)
  main(process.argv.slice(2));
