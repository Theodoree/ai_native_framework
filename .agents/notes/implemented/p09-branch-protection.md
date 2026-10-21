# P-09 · 禁直推与 required checks 挂在平台规则上

- **状态**：implemented
- **日期**：2026-10-21
- **判据**：直接 `git push origin <branch>:main` 被平台拒绝；PR 合并前 `check` 与 `merge-gate` 必须绿。

## 一、先撞上的硬限制

GitHub 的分支保护与 rulesets 对**私有仓库**只在付费计划（Pro/Team/Enterprise）开放。两次实测（仓库 admin 权限是有的，挡的是计划级别）：

```text
gh api repos/.../rulesets     → 403 Upgrade to GitHub Pro or make this repository public
gh api -X PUT .../protection  → 403 Upgrade to GitHub Pro or make this repository public
```

处置由人决定：仓库转 **public**（保留私有要付费；「用 workflow 事后判直推」也是选项，但那是事后变红，不是事前拒绝）。

## 二、落地方式：repository ruleset，不用经典分支保护

经典分支保护的 `required_pull_request_reviews` 至少要 1 个批准，单人仓库无法自批 → 死锁。ruleset 允许 `required_approving_review_count: 0`，「必须走 PR」与「必须过检查」都能表达：

```text
ruleset main-guard（enforcement=active，target=branch，include refs/heads/main）
  pull_request            required_approving_review_count=0，允许 merge/squash/rebase
  required_status_checks  check, merge-gate（strict=false）
  deletion                禁止删除 main
  non_fast_forward        禁止强推
```

- **不设 bypass actors**：连 admin 也受约束，否则「门」对仓库主人是装饰。
- **strict=false**：不强制分支永远与 main 同步；PR head 上的检查绿了就能合，避免为凑最新而反复重跑。
- **没有用 `restrictions`**：限制推送名单会同时挡住 PR 合并（合并本身就是一次对 main 的推送）。

## 三、证据

- 直推被拒（main 未变，仍是合并前的 `a0d685b`）：
  ```text
  remote: error: GH013: Repository rule violations found for refs/heads/main.
  remote: - 2 of 2 required status checks are failing.
   ! [remote rejected] feat/m2-merge-gate -> main (push declined due to repository rule violations)
  ```
- ruleset 生效：`gh api repos/.../rules/branches/main` → `pull_request / required_status_checks / deletion / non_fast_forward`
- PR #2 在 `check / merge-gate / render / write` 四绿后合并成功（`9954028`）。

## 四、放弃与残余

- **放弃 `--admin` 合并**：那等于给门开后门，本 PR 的合并走了正常路径。
- 残余：ruleset 由仓库管理员维护，改它不需要过门——这是平台侧的固有权力边界，只能靠「改规则的动因也该过 PR」这条纪律兜住。
