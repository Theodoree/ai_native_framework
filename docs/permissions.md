# permissions.md · 权限 ↔ 交付节点

## 一、六个身份

| 身份            | 是什么                       | 凭什么被识别                                     |
| --------------- | ---------------------------- | ------------------------------------------------ |
| 提议人 proposer | 提需求的人                   | issue 正文的「发起人」字段（机器人代发，见 §三） |
| owner           | 对区域产出负责的人           | `OWNERS.md` 登记                                 |
| 接入 bot        | 创建 issue 的 GitHub App     | installation token                               |
| CI              | workflow 里的 `GITHUB_TOKEN` | 事件触发                                         |
| 分析 agent      | 只产评论的执行体             | 沙盒内会话                                       |
| 审核 agent      | 交叉验证 / 审计的执行体      | 沙盒内会话，或 GitHub 侧执行器                   |

## 二、九段节点 × 身份 × 权限

| 节点                                              | 谁能做                      | 需要的 GitHub 权限                                    | 改状态                  |
| ------------------------------------------------- | --------------------------- | ----------------------------------------------------- | ----------------------- |
| 建 issue                                          | 接入 bot                    | Issues: write · Metadata: read                        | 否                      |
| 分发 triage → analyzing                           | CI                          | Issues: write                                         | 是                      |
| 分析                                              | 分析 agent                  | Issues: read（**无 write**）                          | 否                      |
| 裁决 analyzing → accepted / rejected / needs-info | **owner**                   | Issues: write 或 label 权限                           | 是                      |
| 补信息 needs-info → analyzing                     | **proposer**                | comment                                               | 是                      |
| 认领开发                                          | owner 或 owner 指派者       | Contents: write（分支）                               | 否                      |
| 开 PR                                             | 认领者                      | Pull requests: write                                  | 否（由 PR 事件推导）    |
| 审计                                              | 审核 agent                  | Pull requests: read · Checks: write（回写 Check Run） | 否                      |
| 合并                                              | owner 或 required reviewer  | Merge                                                 | 否（由 merge 事件推导） |
| 交付完成 → done                                   | CI（merge gate 守卫通过后） | Issues: write                                         | 是                      |
| 放弃 → cancelled                                  | **owner**                   | Issues: write                                         | 是                      |

## 三、两条硬线

1. **agent 不在转换表里** —— `state-machine.yml` 的 `by` 只有 `ci` / `owner` / `proposer`。agent 越权写状态由校验器拒绝，不是靠提示词约束。
2. **接入 bot 不要 Contents: write** —— 它只建 issue；代码与门牌由 CI 的 `GITHUB_TOKEN` 写。issue 由 bot 代发，正文固定一行「发起人：@handle」，因此 `author_association` 失效，判定一律看发起人字段。

> 公开实例里「审核评论」人人可发，所以**裁决只能由 required reviewer 做**，评论本身不构成门。
