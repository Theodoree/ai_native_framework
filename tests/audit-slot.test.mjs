import { describe, expect, it } from "vitest";
import { slotRecord } from "../scripts/audit-slot.mjs";

const ok = (evidence) => JSON.stringify({ verdict: "pass", findings: [], evidence });

describe("audit-slot：槽位身份", () => {
  it("自报身份与槽位一致：原样透传", () => {
    const raw = ok({ executor: "sandbox", agent: "review-a", model: "m", request_id: "r" });
    expect(slotRecord({ slot: "review-a", executor: "sandbox", input: raw })).toBe(raw);
  });

  it("一个执行器不许占两个槽：身份不符记 INFRA 并点名两边", () => {
    const raw = ok({ executor: "github", agent: "review-b", model: "m", request_id: "r" });
    const out = JSON.parse(slotRecord({ slot: "review-a", executor: "sandbox", input: raw }));
    expect(out.verdict).toBe("INFRA");
    expect(out.reason).toContain("一个执行器不能占两个槽");
    expect(out.evidence).toEqual({ executor: "sandbox", agent: "review-a" });
  });

  it("没注入就是 INFRA，不是空 findings 的 pass", () => {
    for (const input of ["", "   ", undefined]) {
      const out = JSON.parse(slotRecord({ slot: "review-b", executor: "github", input }));
      expect(out.verdict).toBe("INFRA");
      expect(out.findings).toEqual([]);
    }
  });

  it("坏 JSON 原样交出去：让口径层点名坏字段，而不是在这里改写成 pass", () => {
    expect(slotRecord({ slot: "review-a", executor: "sandbox", input: "{not json" })).toBe("{not json");
  });

  it("evidence 缺失也算身份不符（没有自报身份就等于无法证明是谁）", () => {
    const out = JSON.parse(
      slotRecord({ slot: "review-a", executor: "sandbox", input: JSON.stringify({ verdict: "pass", findings: [] }) }),
    );
    expect(out.verdict).toBe("INFRA");
  });
});
