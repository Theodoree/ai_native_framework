# knowledge-base.md · 知识库汇入契约

## 一、方向：单向

平台 → 知识库，**不回流**。知识库是只读副本，git 永远是真相源；冲突时以 git 为准，库侧不做编辑。

## 二、汇什么

| 内容     | 来源路径                                                                | 用途                       |
| -------- | ----------------------------------------------------------------------- | -------------------------- |
| 决策记录 | `.agents/notes/implemented/*.md`                                        | 复审时回答「为什么这么定」 |
| 模块契约 | 各模块 `README.md`                                                      | 审计判据的上下文           |
| 事故复盘 | `docs/postmortem/*.md`                                                  | 已知失效模式               |
| 架构地图 | `docs/architecture.md`、`docs/permissions.md`、`docs/audit-contract.md` | 审计时的约束来源           |

## 三、何时

每次合并到默认分支触发一次，按 commit 增量。**汇入失败不阻断合并**：记为 INFRA，进告警，下次合并重试同一路径的当前快照（幂等，按 path + sha256 去重）。

## 四、什么格式

每条记录带固定头，便于按 commit 复算：

```yaml
source_repo: owner/name
source_ref: main
commit: <40 位 sha>
path: .agents/notes/implemented/xxx.md
sha256: <文件内容摘要>
updated_at: <ISO 8601>
```

## 五、边界

- 不汇 secrets、不汇 `.env*`、不汇构建产物。
- 公开实例与私有实例的知识库**不共用**，也不搬运。
