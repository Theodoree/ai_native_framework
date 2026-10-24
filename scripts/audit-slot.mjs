#!/usr/bin/env node
// 一个执行器不能占两个槽。
//
// 上游给的是「一份自称是谁的 JSON」，这里知道的是「它在哪个槽」。两者不交叉校验，
// 同一份 {executor:"github", agent:"review-b"} 填进两个槽就会被记成两个执行器、
// 两票独立结论 —— 双执行器比对的前提当场消失。
//
// 口径（与 scripts/audit-findings.mjs 同源）：判不了写 INFRA 记录，绝不写 pass。

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const SLOTS = ["review-a", "review-b"];

export function slotRecord({ slot, executor, input }) {
  const inf = (reason) =>
    JSON.stringify({ verdict: "INFRA", findings: [], evidence: { executor, agent: slot }, reason });
  const raw = (input ?? "").trim();
  if (raw === "") return inf("上游未注入 findings（" + slot + "）：判不了，不是通过");
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // 解析不了就原样交给口径层：它会把不合格 schema 判 INFRA，并点名哪个字段坏了。
    return raw;
  }
  const evidence = parsed && typeof parsed === "object" ? parsed.evidence : null;
  const claimed = evidence && typeof evidence === "object" ? evidence : null;
  if (!claimed || claimed.executor !== executor || claimed.agent !== slot)
    return inf(
      "evidence 自报身份与所在槽位不符：该槽是 " +
        executor +
        "/" +
        slot +
        "，输入自称 " +
        JSON.stringify(claimed) +
        "。一个执行器不能占两个槽。",
    );
  return raw;
}

function main(argv) {
  const arg = (name) => {
    const at = argv.indexOf("--" + name);
    return at === -1 ? null : argv[at + 1];
  };
  const slot = arg("slot");
  const executor = arg("executor");
  const out = arg("out");
  if (!SLOTS.includes(slot) || !executor || !out) {
    process.stderr.write("用法: audit-slot.mjs --slot review-a|review-b --executor sandbox|github --out <文件>\n");
    return 1;
  }
  const body = slotRecord({ slot, executor, input: process.env.AUDIT_INPUT });
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, body);
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(main(process.argv.slice(2)));
}

export { join };
