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
go test ./...                                   # 14 个用例：状态机 + 端到端 HTTP
go run . -addr 127.0.0.1:8099 -data data        # 打开 http://127.0.0.1:8099
```

页面可以建 project、提需求、逐站运行 / 通过 / 驳回 / 评论 / 追加规则，并看到只追加的事件流。这一版**不启动真容器**：`FakeExecutor` 只写一条评论，并在评论里说清楚自己没连过任何外部服务。

## 铁律

1. **状态只有一个写者**：节点状态只能由状态机改，HTTP 层只做校验与搬运。
2. **位置是推导出来的**：不存「当前位置」，只存每个节点的状态。
3. **评论与执行记录只追加**：回滚重置状态，不删历史。
4. **人保留否决权**：合并这件事永远由人按，平台不代做。
5. **默认文件不改**：某一条需求某一步要加规则，追加到该节点上，不动默认 AGENTS.md。

## 仓库结构

| 路径 | 装什么 |
| --- | --- |
| `apps/chain/` | 链条平台：状态机、存储、HTTP、单页 UI（Go 标准库，零外部依赖） |
| `.agents/notes/proposed/p32-node-chain-alignment.md` | 需求基线：六类节点、链条规则、状态转换、五条收口假设 |
| `.agents/notes/proposed/p32-design-minimal.md` | 设计：实体、不变量、九个接口、容器执行五步、文件存储 |
| `AGENTS.md` / `docs/` | 工作规则与原则 |

## 关于被丢掉的前一版

这个仓库此前是一套「声明 + CI 门禁 + 审计 Check Run」的实现，判据全部搬进 Go 引擎、静态判据写了二十几轮。它证明了一件事：**当判定层要靠静态扫描去猜「这段 YAML 会不会改写结论」时，输的永远是判据**。所以这一版换了观测点——结论由状态机产生，进度由节点状态推导，谁都不能靠改一行配置把结论说成绿的。

[![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)
