# apps/chain — 链条平台

状态：**active**（纵切面可跑：状态机 + SQLite + 容器执行器 + 嵌入的前端产物）

## 它做什么

一条需求进链之后，位置由「每个节点的状态」推导出来，没有独立的编排器：

- **链条**：节点顺序的声明。节点类型是封闭的六类（create / assess / dev / crosstest / merge / release），头必须是需求评估、尾必须是上线。
- **需求**：进链即建分支（`req/<project>/<id>`），链的版本在进入时被钉住。
- **节点状态机**：pending → running → awaiting_review → accepted；rejected 是回滚标记。
- **评论、追加规则、执行记录**：都留在节点上，只追加不删。
- **拒绝**：回滚到上一节点，历史不清；首站被拒等于整条需求被拒。

## 它不做什么

- 不代做合并：`merge` 是人按「通过」来认定完成。
- 不做鉴权、不做多租户、不做并发控制（单机单写者）。
- 不读 GitHub：仓库只是 project 上的一个字符串字段，平台不调用任何仓库 API。
- 不在容器里替人改仓库：容器只产出日志、产物与评论。

## 数据形状

| 实体 | 关键字段 |
| --- | --- |
| Project | key、name、repo、defaultBranch、chains |
| Chain | key、type、version、nodes[]（key、type、review） |
| Node | key、type、review、index、state、attempts[]、comments[]、rules[]、artifacts[]、rev |
| Requirement | id、projectKey、chainKey、chainVersion、context、images、source、branch、state、nodes[]、rev |

存储是接口 `Store`（`store.go`），默认实现是 SQLite（`store_sqlite.go`，纯 Go 驱动 modernc.org/sqlite，免 cgo）。默认库文件 `data/chain.db`（已 gitignore）。换 MySQL 只需要再写一个 `Store` 实现：调用方一行不改。

表：`projects` / `requirements` / `nodes` / `attempts` / `comments` / `events`。一次保存是单事务快照（upsert 需求 → 重插它的节点、执行记录、评论），连接池上限 1（SQLite 单写者）。

## 执行器

两个实现，都由 `-exec` 选：

| `-exec` | 实现 | 行为 |
| --- | --- | --- |
| `fake` | `FakeExecutor` | 只写一条评论，明确说「本次调用没有连任何外部服务」 |
| `docker` | `DockerExecutor` | `docker run --rm -i --init`，注入环境变量，日志只留尾部 8KB |

容器模板默认三套（deepseek-harness / codex / claude），镜像名是占位值 `ai-native/<name>:latest`，用 `-templates templates.json` 增量覆盖。注入的东西固定为：`BASE_URL`、`CHAIN_MODEL`、`CHAIN_AGENTS_MD`（默认职责 + 本站追加规则，不改仓库里的 AGENTS.md）、`CHAIN_REQUIREMENT`、`CHAIN_NODE`、`CHAIN_BRANCH`、`CHAIN_CONTEXT`，以及（存在时）`CHAIN_MODEL_KEY`。project 的 repo 是绝对路径时以只读意图挂到 `/work`。

密钥只从环境变量取，且执行日志会把它替换成 `***`；未知模板 fail-closed（不猜镜像）。

## HTTP 接口

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | `/` | 内嵌前端（`webui/dist`） |
| GET | `/assets/` | 内嵌前端的静态资源 |
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

前端产物已经入库（`webui/dist`），因为 `//go:embed` 要它：

```bash
cd apps/chain
export GOCACHE=$PWD/.cache/go-build GOPATH=$PWD/.cache/go
go test ./...
go run . -addr 127.0.0.1:8099 -exec fake     # 打开 http://127.0.0.1:8099
```

要接真容器（需要本机 docker daemon）：

```bash
go run . -addr 127.0.0.1:8099 -exec docker -templates templates.json \
  -base-url https://api.deepseek.com -model deepseek-chat
```

改了 `apps/web` 就要重新构建并提交产物，否则页面还是旧的：

```bash
cd ../web && npm run build      # 输出到 ../chain/webui/dist
```

## 已知边界

1. AI 审核（链上的 `review: ai`）还没有接自动调用：容器跑完进入 `awaiting_review`，AI 那一档也仍由人按。
2. 事件流是给人看的记录，不参与任何判定。
3. 没有乐观锁：同一需求的两次并发写会互相覆盖（`rev` 字段已留，但还没有使用）。
4. 容器里跑什么都没验证：平台只保证注入与留痕，不保证镜像真的能干那件事。
