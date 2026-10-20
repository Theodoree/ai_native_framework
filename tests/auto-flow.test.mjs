import { describe, expect, test } from "vitest";
import { loadConfig, validateIntent } from "../scripts/state-validate.mjs";

const CFG = loadConfig(".agents/platform/state-machine.yml");
const verdict = (intent) => {
  try {
    return { ok: true, value: validateIntent(CFG, intent) };
  } catch (error) {
    return { ok: false, kind: error.kind, code: error.code };
  }
};

describe("默认流程 auto：新需求自动受理", () => {
  test("none → accepted 由 platform 在当前 flow 下允许", () => {
    const r = verdict({ labels: [], to: "accepted", actor_role: "platform" });
    expect(r.ok).toBe(true);
    expect(r.value.from).toBe("none");
    expect(r.value.to).toBe("accepted");
    expect(r.value.flow).toBe("auto");
  });

  test("同一入口的 manual 转换在 auto flow 下不命中（不会两条都放行）", () => {
    const r = verdict({ labels: [], to: "triage", actor_role: "ci" });
    expect(r.ok).toBe(false);
    expect(r.kind).toBe("rejected");
    expect(r.code).toBe("E_NO_TRANSITION");
  });

  test("显式 flow=manual 时仍走 triage", () => {
    const r = verdict({
      labels: [],
      to: "triage",
      actor_role: "ci",
      flow: "manual",
    });
    expect(r.ok).toBe(true);
    expect(r.value.flow).toBe("manual");
  });

  test("flow 专属转换不会被非对应 flow 命中（无猜默认）", () => {
    const r = verdict({
      labels: [],
      to: "accepted",
      actor_role: "platform",
      flow: "manual",
    });
    expect(r.ok).toBe(false);
    expect(r.code).toBe("E_NO_TRANSITION");
  });
});

describe("auto flow 下 owner 仍可驳回", () => {
  test("accepted → rejected 带说明即允许", () => {
    const r = verdict({
      labels: ["state:accepted"],
      to: "rejected",
      actor_role: "owner",
      comment: "与现有 scope 重复",
    });
    expect(r.ok).toBe(true);
    expect(r.value.from).toBe("accepted");
  });

  test("accepted → rejected 缺说明被拒", () => {
    const r = verdict({
      labels: ["state:accepted"],
      to: "rejected",
      actor_role: "owner",
    });
    expect(r.ok).toBe(false);
    expect(r.code).toBe("E_COMMENT_REQUIRED");
  });

  test("accepted → needs-info 带说明即允许", () => {
    const r = verdict({
      labels: ["state:accepted"],
      to: "needs-info",
      actor_role: "owner",
      comment: "缺验收判据",
    });
    expect(r.ok).toBe(true);
  });
});

describe("反向用例：歧义必须判 INFRA 而不是随便挑一条", () => {
  test("同一 (from,to) 两条通用转换 → E_TRANSITION_AMBIGUOUS", () => {
    const cfg = {
      ...CFG,
      transitions: [
        ...CFG.transitions,
        { from: "none", to: "accepted", by: "platform" },
      ],
    };
    try {
      validateIntent(cfg, { labels: [], to: "accepted", actor_role: "platform" });
      throw new Error("应当抛出 E_TRANSITION_AMBIGUOUS");
    } catch (error) {
      expect(error.kind).toBe("infra");
      expect(error.code).toBe("E_TRANSITION_AMBIGUOUS");
    }
  });
});
test("入口转换由声明决定：auto → accepted/platform，manual → triage/ci", async () => {
  const { loadConfig, resolveEntry } = await import("../scripts/state-validate.mjs");
  const cfg = loadConfig(".agents/platform/state-machine.yml");
  expect(resolveEntry(cfg, "auto")).toMatchObject({ to: "accepted", by: "platform" });
  expect(resolveEntry(cfg, "manual")).toMatchObject({ to: "triage", by: "ci" });
});

test("入口歧义（两条 from=none 同 flow）判 INFRA，不猜", async () => {
  const { loadConfig, resolveEntry } = await import("../scripts/state-validate.mjs");
  const cfg = loadConfig(".agents/platform/state-machine.yml");
  const broken = { ...cfg, transitions: [...cfg.transitions, { from: "none", to: "triage", by: "ci" }] };
  let error;
  try {
    resolveEntry(broken, "auto");
  } catch (caught) {
    error = caught;
  }
  expect(error.code).toBe("E_ENTRY_AMBIGUOUS");
});
