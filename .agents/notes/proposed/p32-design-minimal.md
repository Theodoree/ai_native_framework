# P-32 方案：链条 · 节点实例 · 一次执行

- **日期**：2026-10-27
- **状态**：proposed（方案第一版；需求基线见 `p32-node-chain-alignment.md`）
- **一句话**：需求的位置由各节点实例的状态推导出来，不存进度表；每个节点一次执行产出一条评论与一份产物，审核通过才往下走。

## 一、实体

| 实体         | 字段（最小集）                                                                                                  |
| ------------ | --------------------------------------------------------------------------------------------------------------- |
| Project      | `key`、`name`、`repo`（owner/name 或 URL）、`defaultBranch`、`chains[]`                                         |
| Chain        | `key`、`type`（fixbug / feature）、`nodes[]`（六类有序子集）、`version`（改定义即新版本）                       |
| Requirement  | `id`、`projectKey`、`chainKey` + `chainVersion`、`context`（文本 + 图）、`source`（谁提的，用于回告）、`branch` |
| NodeInstance | `requirementId`、`nodeKey`、`type`、`index`、`state`、`attempts[]`、`comments[]`、`rules[]`、`artifacts`        |
| Attempt      | `n`、`startedAt/endedAt`、`exitCode`、`image`、`env`（secret 遮掉）、`logRef`、`outcome`                        |
| Comment      | `authorType`（human / container / system）、`author`、`body`、`createdAt`、`verdict`（通过/驳回时用）           |

## 二、五条不变量

1. **位置是推导出来的**：需求的当前节点 = index 最小的、状态不是 `accepted` 的那个实例。没有 `currentNode` 字段，没有全局进度表。
2. **状态的唯一写者**：每个节点实例的状态只由它自己那一站的审核动作改；跨节点回滚也由被拒的那一站发起，不由中心调度改。
3. **评论只追加**：不改不删；评论不往下游传（需求基线 §三-7）。
4. **追加规则是唯一进入下游/重跑的信息通道**：评论不传，所以人若想让下一轮知道「为什么不满意」，只能写进该节点的 `rules`。
5. **产物由执行层写，裁决由人写**：容器只写评论与产物，人只写评论与裁决，两者不交叉。

## 三、状态机（节点实例）

```text
pending ──run──▶ running ──跑完/人干完──▶ awaiting_review
                    ▲                          │
                    │                    ┌─────┴─────┐
                    │                 通过│           │驳回
                    │                    ▼           ▼
                    └──重新执行─── rejected      accepted（终态）
```

- `reject(i)`：i 为 0 → 整条需求 `rejected`，经接入层回告；否则 `i-1` 回到 `running`（容器节点自动再跑一轮，人节点等人动手），i 之后所有实例重置为 `pending`。
- 重置是**状态重置，不是历史删除**：`attempts` 与 `comments` 全部保留。
- 需求级终态：最后一个节点 `accepted` → `done`；index 0 被拒 → `rejected`。

## 四、接口

接入层（对外，凭 project key）：

| 方法 | 路径                              | 作用                             |
| ---- | --------------------------------- | -------------------------------- |
| POST | `/api/projects`                   | create project                   |
| GET  | `/api/projects`                   | project list                     |
| POST | `/api/p/:projectKey/requirements` | 提需求（文本 + 可选图 → 建分支） |
| GET  | `/api/requirements/:id`           | 全量视图（链、各实例状态、评论） |

平台内动作（每个节点五个，正好对应需求基线 §七）：

| 动作    | 路径                                     | 谁能按                  |
| ------- | ---------------------------------------- | ----------------------- |
| run     | `POST …/nodes/:nodeKey/run`              | 容器节点自动 / 人点开始 |
| comment | `POST …/nodes/:nodeKey/comment`          | 任何人                  |
| accept  | `POST …/nodes/:nodeKey/accept`           | 审核方（AI 或人）       |
| reject  | `POST …/nodes/:nodeKey/reject`（带理由） | 审核方（AI 或人）       |
| rules   | `POST …/nodes/:nodeKey/rules`（追加）    | 人                      |

并发：每个节点实例带 `rev`，动作必须带 `expectedRev`，不匹配返回 409 —— 同一站两个动作同时到时不猜哪个先。

## 五、一次容器执行

1. 取节点模板：镜像、该节点的 `AGENTS.md`、`BASE_URL` / `model` / `key` 的来源。
2. 起容器：挂载该需求分支的 checkout；env 注入；`AGENTS.md` 注入到运行期路径（**默认文件不改**），该节点的 `rules` 拼在其后。
3. 收：退出码、日志、工作区 diff（有没有新 commit）。
4. 写：一条 `container` 评论 + `artifacts` → 状态转 `awaiting_review`。
5. AI 审核（P3）：同容器内自审，给出 通过 / 驳回；驳回自动走 `reject`。

失败与超时按「没通过」处理，但结论要分开写：**跑失败**（管线或镜像的问题，附日志）与**审核不过**（产出了但不行，附理由）不是一回事。

## 六、存储

沿用现有平台的形态——声明是 YAML，运行态是追加式事件：

```text
.platform/projects/<key>/project.yml        project 与链条声明
.platform/requirements/<id>/meta.json       需求基本信息与分支
.platform/requirements/<id>/events.jsonl    状态变化、评论、执行记录（只追加）
```

写入一律「先写 tmp 再 rename」；半截文件视为不存在。

## 七、最小纵切面（建议先做这一个）

一条链三站：**需求评估 → 开发 → 上线**，全部人审核；需求评估用一个 echo 形状的假容器。要证明的只有四件事：

1. 提需求即进链、即建分支；
2. 容器跑一次 → 评论 + 产物落盘；
3. 人按通过 → 位置前移；
4. 上线站被拒 → 回滚到开发站，历史保留。

这四件跑通，再谈容器模板、AI 审核、GitLab。

## 八、风险

| 风险           | 具体表现                                                       |
| -------------- | -------------------------------------------------------------- |
| 容器执行       | 镜像、网络、凭据、超时，四样任一坏都表现为「跑不动」，要能分清 |
| 并发           | 同一站两个动作同时到；靠 `rev` 的 409 挡住，不靠猜             |
| 密钥           | 注入后不能回显，日志要脱敏                                     |
| 分支冲突       | 多需求并行各建分支，合并发生在外部，平台不代解冲突             |
| 方案与现实脱节 | 先用最小纵切面落地，再往上加，不一次性把六个节点全实现         |

## 九、与现有代码的接触点（仍未决策）

`apps/api-go`（服务骨架可复用否）、`apps/web-vue`（看板改造成链条视图还是重写）、`apps/engine`（判据类子命令在新架构里是否还有用）、六个 workflow（不用 Actions 之后留下哪些）。这一节等最小纵切面跑通再谈。
