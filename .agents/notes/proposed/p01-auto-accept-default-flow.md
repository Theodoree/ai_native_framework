# P-01 默认流程：proposed 自动受理

- **日期**：2026-10-20
- **状态**：proposed
- **里程碑**：M0 · 自举
- **依赖**：无

> **进度**：声明侧已落地（`policy.default_flow: auto`、`none → accepted` by platform、`accepted` 增加 owner 驳回到 `rejected` / `needs-info`）。剩余：GitHub 侧 `issues.opened` 消费 `DEFAULT_FLOW`。

## 背景

平台没有真实实例，也没有 owner 常驻裁决。若沿用「analyzing → accepted 由 owner 手动裁决」，需求会卡在 analyzing 等一个人——链路第一步就断，后面所有里程碑都喂不进真事件。

## 决策

把「初始走哪条路径」声明成策略，默认 auto，仍然放在状态机里（一个事实只有一个家）：

```yaml
policy:
  default_flow: auto
transitions:
  - { from: none, to: triage,   by: ci, event: "issues.opened", flow: manual }
  - { from: none, to: accepted, by: ci, event: "issues.opened", flow: auto }
```

同一 `(from, event)` 允许多条转换，靠 `flow` 区分。判定器要求**恰好命中一条**：命中 0 条或 2 条以上都判 INFRA（歧义不是允许，是配置错误）。

`triage` / `analyzing` / `needs-info` 全部保留——manual 流程（真有人裁决的实例）仍然需要它们，owner 也仍然能手动 reject / cancel。

## 目标 · 验收 · 边界

- **目标**：新建 proposed / bugfix issue 时，CI 直接把状态落到 `state:accepted`，不需要任何人操作。
- **验收**：`npm run check` 全绿，且其中 `node scripts/state-validate.mjs --check-config` 输出含 `default_flow = auto`；`npx vitest run tests/state-machine.test.mjs` 新增 3 个用例通过——(a) flow=auto 下 `none → accepted` 允许，(b) flow=manual 下 `none → triage` 允许且 `none → accepted` 拒绝，(c) 同 `(from,event)` 两条都命中时判 INFRA 且 exit 3。
- **边界**：可动 `.agents/platform/state-machine.yml`、`scripts/state-validate.mjs`、`tests/state-machine.test.mjs`、`docs/architecture.md`（交付链那行）、`docs/permissions.md`（裁决那行标注默认自动）。不动 `scripts/build-intent.mjs`（属 P-02），不动 `.github/workflows/`。

## 放弃了什么

- **新开 `.agents/platform/flow.yml`**：多一个文件就多一个会跟状态机不同步的家。
- **直接把 `none → accepted` 写死**：manual 流程被抹掉，以后想恢复到「owner 裁决」就得改代码而不是改一行声明。