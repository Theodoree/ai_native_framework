# P-02 写者按策略落状态

- **日期**：2026-10-20
- **状态**：proposed
- **里程碑**：M0 · 自举
- **依赖**：P-01

> **进度**：机制侧已落地（`build-intent.mjs` 按 `defaultFlow` 决定目标状态；判定器按 flow 选转换且要求恰好一条）。剩余：workflow 注入 `DEFAULT_FLOW`。

## 背景

P-01 把策略声明出来之后，事件归一还得按策略选目标。现在的 `build-intent.mjs` 从事件推一个 `{from,to}`，没有读策略的能力。

## 决策

`build-intent` 读 `policy.default_flow`，在 `issues.opened` 时输出 `to: accepted`（auto）或 `to: triage`（manual）。
**仍然一次事件只推一条转换**，不做多步链式落状态：链式会让「回滚」变成多步原子操作，而当前唯一的兜底手段就是「非法就不写」。

## 目标 · 验收 · 边界

- **目标**：写者拿到意图时，目标状态已按策略确定，判定器只需要判定合法性。
- **验收**：`npx vitest run tests/build-intent.test.mjs` 新增用例通过——同一份 `issues.opened` 事件，policy=auto 得 `{from:"none",to:"accepted"}`，policy=manual 得 `{from:"none",to:"triage"}`；policy 缺失时判 INFRA 而不是猜一个默认。
- **边界**：可动 `scripts/build-intent.mjs`、`tests/build-intent.test.mjs`。不动 `state-machine.yml`（P-01 已定）、不动 `.github/workflows/state-writer.yml`。

## 放弃了什么

- **在 workflow 里用 `if:` 判断策略**：判定逻辑跑进 YAML 就不可单测了。
- **写死 accepted**：同 P-01。