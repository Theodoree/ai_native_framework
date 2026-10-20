# P-05 拒绝与 INFRA 留痕

- **日期**：2026-10-20
- **状态**：implemented（M1 机制侧已落地；真事件验收待 P-03 远端）
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

## 落地记录

- 留痕单元：新增 `scripts/writer-record.mjs`，评论正文与 job 红绿只在那里生成（allowed → 无评论；rejected/infra → `状态未被修改：<VERDICT> <code> — <message>`；rejected → exit 0、infra → exit 1）。YAML 里不再有内联模板与判定。
- 无意图事件不算 INFRA（验收时挖出的洞）：`issues.closed` / `issues.reopened` / 未合并的 `pull_request.closed` 原本会让 validate 读到空的 `intent.json`，判 `E_INTENT_EMPTY`，于是 record 贴一条误导性 INFRA 评论并让 job 变红。修法是让「有没有意图」由产地公布：build-intent 写 `has_intent=0/1` 到 `$GITHUB_OUTPUT`，validate/apply/record 三步都以 `has_intent == '1'` 门控。
- record 的 `if` 必须带 `has_intent == '1'` 这个合取项：validate 被跳过时它的 `outputs.exit` 是空串，单看 `exit != '0'` 会成立，空 verdict 照样被送进留痕。
- 判定器 `E_INTENT_EMPTY` 原样保留——它没错，错的是把没有意图的事件喂给它。
- 测试把 YAML 当真源执行：`tests/state-writer-wiring.test.mjs` 解析 workflow、执行真实 `run:` 块、求值真实 `if:`、用假 `gh` 记账，断言「无意图零调用且 job 绿 / 合法改标签 / 拒绝绿 / INFRA 红」。

