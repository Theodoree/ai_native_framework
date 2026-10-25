# P-09 挂 required check 与禁直推

- **日期**：2026-10-20
- **状态**：implemented —— 由仓库 ruleset `main-guard`（id 25521030，enforcement active）落实：`required_status_checks` = `check`、`merge-gate`，另有 `non_fast_forward` 与 `deletion` 两条规则；`strict_required_status_checks_policy` 关（不要求每次更新分支都重跑全绿）
- **里程碑**：M2 · 门与门牌
- **依赖**：P-08
> **需要人工/授权**：分支保护与 required status check 是 GitHub 仓库设置，须由人执行或明确授权。

## 背景

基线记录第六条：状态机管不了直推，所以「禁止直推默认分支」必须同时开着，否则前面所有设计一起失效。而没有 required check 的 workflow 只是一段打印，没有强制力。

## 目标 · 验收 · 边界

- **目标**：merge gate 成为合并的必要条件，默认分支不可直推。
- **验收**：两条证据——(a) 故意让 P-08 的某条守卫失败，GitHub UI 上合并按钮被禁用（截图）；(b) `git push origin main` 被拒，输出原文含 protected branch。
- **边界**：只动仓库设置。若实例有发布机直推，白名单单独列出并记录在案。

## 放弃了什么

- **只靠 workflow 打印 FAIL**：没有 required check 时红灯不阻断合并，等于没有门。
