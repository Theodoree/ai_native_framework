# P-04 PR 事件推导

- **日期**：2026-10-20
- **状态**：proposed
- **里程碑**：M1 · 写者闭环
- **依赖**：P-03

## 背景

状态机已经声明 `accepted → in-progress`（`pull_request.opened`）、`in-progress → blocked`（owner）、`blocked → in-progress`（`pull_request.synchronize`）、`in-progress → done`（merged，带 merge-gate 守卫）。这些目前在真仓里没有跑过。

## 目标 · 验收 · 边界

- **目标**：开 PR、修 PR、合并 PR 三个动作让 issue 状态自动跟进，不靠人记得点 label。
- **验收**：`gh issue view <n> --json labels` 在三次动作后分别显示 `state:in-progress` → （blocked 后）`state:in-progress` → `state:done`；`tests/state-machine.test.mjs` 覆盖「PR 事件找不到引用 issue」时判 INFRA 而非静默。
- **边界**：可动 `scripts/build-intent.mjs`、`tests/`、`.github/workflows/state-writer.yml`。不动 `state-machine.yml` 的转换表（已定）。

## 放弃了什么

- **由 PR 模板里的勾选框驱动状态**：评论和正文都不构成门（`docs/audit-contract.md §三.1`），状态必须从事件推。
