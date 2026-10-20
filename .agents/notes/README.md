# Agent Notes · 决策记录

> **为什么记录**：agent 之间没有对话记忆，决策的"为什么"必须写下来。
> **开关说明**：当前只有两层（proposed/ + implemented/），archived/ 在出现归档需求时再加（见 AGENTS.md 的「特性启用」）。

## 何时写

- 非平凡变更（改行为/架构/契约/流程）建议带一条；团队并行后改为强制

## 格式

```markdown
# <标题>

- **日期**：YYYY-MM-DD
- **状态**：proposed / implemented

## 背景

为什么做？

## 决策

我们决定……

## 放弃了什么

备选方案及不选原因
```

## 生命周期

- `proposed/`：提案，未实施
- `implemented/`：已实施（从 proposed/ 移入，或直接写）
