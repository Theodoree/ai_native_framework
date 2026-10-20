# P-04 PR 事件推导

- **日期**：2026-10-20
- **状态**：implemented（M1 机制侧已落地；真事件验收待 P-03 远端）
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

## 落地记录

- 缺陷先行确认：旧映射里 PR 号直接进 `issue` 字段，PR 事件会把 `state:` 标签打到 PR 上而不是被引用的 issue 上——「PR 事件自动跟进」从来没成立过。
- 解析规则：只认「close 类关键字 + `#N`」（closes/closed/close/fix/fixes/fixed/resolve/resolves/resolved，大小写不敏感、冒号可有可无），body 优先、title 兜底、去重保序；恰好 1 个才用。
- 0 个或 ≥2 个引用一律判 INFRA `E_ISSUE_UNRESOLVED`（判定器新增的唯一出口），**不猜**：多数引用时挑一个等于用猜测代替判据。
- 解不出 issue 时 build-intent 仍退出 0，判决由判定器发出（exit 3）。理由：Actions 默认 `bash -e`，映射层非零退出会掐死 job，validate/record 都不跑 → 红得没有评论、没有留痕，正是要消灭的静默失败。
- apply 步骤改为用 `intent.json` 里的 issue 改标签，否则缺陷只修一半。
- 实测：`Fixes #12` → issue 12；无引用 → `E_ISSUE_UNRESOLVED` exit 3；`Fixes #12, closes #13` → exit 3；`issues.labeled` 回归不变。

