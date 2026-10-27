# AI 原生研发交付引擎

一条需求从提出到上线，中间只有两样东西：**节点**和**节点的状态**。没有独立编排器，没有 CI 门禁，也不依赖 GitHub 的任何一套机制。

## 三个概念

- **链条**：节点顺序的声明。节点类型封闭为六类——`create`（建项目）、`assess`（需求评估）、`dev`（人在分支上开发）、`crosstest`（跨端测试）、`merge`（人在仓库里合并）、`release`（上线）。头必须是评估、尾必须是上线，中间随便排。
- **需求**：进链即建分支，链的版本在进入那一刻被钉住。提出的东西是 fix bug 还是新功能，走同一条链。
- **节点状态**：`pending → running → awaiting_review → accepted`。需求此刻站在哪，由「第一个还没通过的节点」推导出来，不需要额外记录位置。

驳回就是回滚到上一节点，历史一条都不删；第一站被驳回，等于整条需求被驳回。

## 现在能跑什么

```bash
cd apps/chain
export GOCACHE=$PWD/.cache/go-build GOPATH=$PWD/.cache/go
go test ./...                                    # 状态机 + 存储 + 执行器 + 端到端 HTTP
go run . -addr 127.0.0.1:8099 -exec fake         # 打开 http://127.0.0.1:8099
```

页面可以建 project、提需求、逐站运行 / 通过 / 驳回 / 评论 / 追加规则，并看到只追加的事件流。

平台外面（脚本、另一个系统）走接入层：带 `-admin-token` 启动后，用它建 project 并拿到该 project 的访问口令，之后用口令提需求、用口令拉结论。整条需求被拒时会尽力回告一次，**回告失败不改状态**——所以拉模式永远是可信的那条路。接口表见 `apps/chain/README.md` 的「接入层」一节。

- **存储**：SQLite（纯 Go 驱动，免 cgo），库文件默认 `data/chain.db`。`Store` 是接口，换 MySQL 只加一个实现。
- **执行**：`-exec fake` 只写一条评论并声明自己没连过外部服务；`-exec docker` 会用 `docker run` 起真容器并注入 `BASE_URL` / 模型 / AGENTS.md / 需求正文，密钥只从环境变量取且会从日志里抹掉。
- **前端**：Vue 3 + Vite + TS，构建产物已入库（`apps/chain/webui/dist`），被 `//go:embed` 打进二进制。改了 `apps/web` 要记得 `npm run build`。

## 铁律

1. **状态只有一个写者**：节点状态只能由状态机改，HTTP 层只做校验与搬运。
2. **位置是推导出来的**：不存「当前位置」，只存每个节点的状态。
3. **评论与执行记录只追加**：回滚重置状态，不删历史。
4. **人保留否决权**：合并这件事永远由人按，平台不代做。
5. **默认文件不改**：某一条需求某一步要加规则，追加到该节点上，不动默认 AGENTS.md。

## 仓库结构

| 路径 | 装什么 |
| --- | --- |
| `apps/chain/` | 链条平台：状态机、SQLite 存储、HTTP、容器执行器、嵌入的前端产物 |
| `apps/web/` | 前端源码：Vue 3 + Vite + TypeScript，无 UI 库 |
| `docs/architecture.md` | 架构总览：分层、模块地图、一次需求流过什么 |
| `.agents/notes/proposed/p32-node-chain-alignment.md` | 需求基线：六类节点、链条规则、状态转换、五条收口假设 |
| `.agents/notes/proposed/p32-design-minimal.md` | 设计：实体、不变量、九个接口、容器执行五步（其中「文件存储」已被 SQLite 取代，见 `.agents/notes/implemented/p33-sqlite-docker-frontend.md`） |
| `AGENTS.md` / `docs/` | 工作规则与原则 |

## 关于被丢掉的前一版

这个仓库此前是一套「声明 + CI 门禁 + 审计 Check Run」的实现，判据全部搬进 Go 引擎、静态判据写了二十几轮。它证明了一件事：**当判定层要靠静态扫描去猜「这段 YAML 会不会改写结论」时，输的永远是判据**。所以这一版换了观测点——结论由状态机产生，进度由节点状态推导，谁都不能靠改一行配置把结论说成绿的。

[![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)
