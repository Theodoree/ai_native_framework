# P-05 拒绝与 INFRA 留痕

- **日期**：2026-10-20
- **状态**：proposed
- **里程碑**：M1 · 写者闭环
- **依赖**：P-03

## 背景

判定器已有三出口（0 允许 / 1 拒绝 / 3 INFRA），基线记录第三条明确「INFRA 不计入合并判据但必须留痕」。workflow 里已有 record 步骤，但从未在真事件上验证过，尤其没有验证「INFRA 不会被读成通过」。

## 目标 · 验收 · 边界

- **目标**：任何一次非法或无法判定的转换都在 issue 上留下一条可读评论，且 INFRA 一定让 job 变红。
- **验收**：两次人造事件的输出原文——(a) 构造一次非法转换（例如 `analyzing → done`），issue 收到 `状态未被修改：REJECTED ...` 评论且 job 成功（拒绝不是故障）；(b) 构造一次 INFRA（例如手工删掉一个 `state:*` label），issue 收到 `... INFRA ...` 评论且 job **失败**。
- **边界**：可动 `.github/workflows/state-writer.yml`、`scripts/state-validate.mjs`、`tests/`。

## 放弃了什么

- **INFRA 静默重试**：重试会把「没能判定」变成一个偶然的成功，等于取消判据。
- **在 issue 里贴 workflow 日志链接代替评论正文**：日志会过期，评论是永久的留痕。
