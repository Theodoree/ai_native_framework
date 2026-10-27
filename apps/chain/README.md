# apps/chain — 链条平台的最小骨架

状态：**active**（可跑的纵切面，容器执行是假的）

## 它做什么

一条需求进链之后，位置由「每个节点的状态」推导出来，没有独立的编排器：

- **链条**：节点顺序的声明。节点类型是封闭的六类（create / assess / dev / crosstest / merge / release），头必须是需求评估、尾必须是上线。
- **需求**：进链即建分支（`req/<project>/<id>`），链的版本在进入时被钉住。
- **节点状态机**：pending → running → awaiting_review → accepted；rejected 是回滚标记。
- **评论、追加规则、执行记录**：都留在节点上，只追加不删。
- **拒绝**：回滚到上一节点，历史不清；首站被拒等于整条需求被拒。

## 它不做什么

- 不启动真容器、不连任何模型（`FakeExecutor` 只写一条评论，明确说「本次调用没有连任何外部服务」）。
- 不代做合并：`merge` 是人按「通过」来认定完成。
- 不做鉴权、不做多租户、不做并发控制（单机单写者）。
- 不读 GitHub：仓库只是 project 上的一个字符串字段。

## 数据形状

| 实体 | 关键字段 |
| --- | --- |
| Project | key、name、repo、defaultBranch、chains |
| Chain | key、type、version、nodes[]（key、type、review） |
| Node | key、type、review、index、state、attempts[]、comments[]、rules[]、artifacts[]、rev |
| Requirement | id、projectKey、chainKey、chainVersion、context、images、source、branch、state、nodes[]、rev |

落盘位置（默认 `-data data`，已 gitignore）：`projects/<key>.json`、`requirements/<id>/meta.json`、`requirements/<id>/events.jsonl`。写文件先写 `.tmp` 再 rename，半截文件视为不存在。

## HTTP 接口

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | `/` | 内嵌单页（无构建、无外部依赖） |
| GET / POST | `/api/projects` | 列表 / 创建（key 重复 409） |
| GET | `/api/requirements` | 全部需求 |
| POST | `/api/p/{project}/requirements` | 提需求（body: context、images、source、chain） |
| GET | `/api/requirements/{id}` | `{ requirement, events }` |
| POST | `/api/requirements/{id}/nodes/{node}/run` | 起容器或开始动手 |
| POST | `.../accept` | 通过（可带 comment） |
| POST | `.../reject` | 驳回（reason 必填，409 表示不是当前站） |
| POST | `.../comment` | 评论 |
| POST | `.../rules` | 往这一站追加规则，默认 AGENTS.md 不改 |

请求体用 `DisallowUnknownFields` + 1MiB 上限解码；未知字段返回 400。

## 怎么跑

```bash
cd apps/chain
export GOCACHE=$PWD/.cache/go-build GOPATH=$PWD/.cache/go
go test ./...
go run . -addr 127.0.0.1:8099 -data data
```

## 已知边界

1. `FakeExecutor` 不是容器执行器：接真执行器时替换 `Executor` 接口即可，状态机不需要改。
2. 审核方（ai / human）写在链上，但 AI 审核的调用还没有接；当前所有推进都由人按。
3. 事件流是给人看的记录，不参与任何判定。
4. 没有乐观锁：同一需求的两次并发写会互相覆盖（`rev` 字段已留，但还没有使用）。
