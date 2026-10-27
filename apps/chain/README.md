# apps/chain — 链条平台

状态：**active**（纵切面可跑：状态机 + SQLite + 容器执行器 + 嵌入的前端产物）

## 它做什么

一条需求进链之后，位置由「每个节点的状态」推导出来，没有独立的编排器：

- **链条**：节点顺序的声明。节点类型是封闭的六类（create / assess / dev / crosstest / merge / release），头必须是需求评估、尾必须是上线。
- **需求**：进链即建分支（`req/<project>/<id>`），链的版本在进入时被钉住。
- **节点状态机**：pending → running → awaiting_review → accepted；rejected 是回滚标记。
- **谁审**：每个节点声明 `review: ai | human`。ai 的节点由容器自己定案，human 的节点停在待审等人按。
- **评论、追加规则、执行记录**：都留在节点上，只追加不删。
- **拒绝**：回滚到上一节点，历史不清；首站被拒等于整条需求被拒。

## 它不做什么

- 不代做合并：`merge` 是人按「通过」来认定完成。
- 不做账号体系、不做多租户、不做并发控制（单机单写者）：身份只有 project 级管理口令、project 访问口令与角色口令三种，没有用户表，也没有登录。
- 不保证回告必达：回告失败只记事件，结论靠拉模式自己取。
- 不读 GitHub：仓库只是 project 上的一个字符串字段，平台不调用任何仓库 API。
- 不在容器里替人改仓库：容器只产出日志、产物与评论。

## 数据形状

| 实体 | 关键字段 |
| --- | --- |
| Project | key、name、repo、defaultBranch、chains、intakeToken（只在建 project 时交出去一次）、ownerToken（同上，且不落库） |
| Chain | key、type、version、nodes[]（key、type、review） |
| Node | key、type、review、power、index、state、attempts[]、comments[]、rules[]、artifacts[]、rev |
| Role | id、projectKey、name、powers[]、token（只在建角色与换口令的响应里出现一次）、createdAt |
| Requirement | id、projectKey、chainKey、chainVersion、context、images、source、branch、state、nodes[]、rev、reporter（谁提的、回告地址） |

存储是接口 `Store`（`store.go`），默认实现是 SQLite（`store_sqlite.go`，纯 Go 驱动 modernc.org/sqlite，免 cgo）。默认库文件 `data/chain.db`（已 gitignore）。换 MySQL 只需要再写一个 `Store` 实现：调用方一行不改。

表：`projects` / `roles` / `requirements` / `nodes` / `attempts` / `comments` / `events`。一次保存是单事务快照（upsert 需求 → 重插它的节点、执行记录、评论），连接池上限 1（SQLite 单写者）。

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
| GET / POST | `/api/projects` | 列表 / 创建（key 重复 409）；创建会顺手发一个 owner 角色口令，只在 201 里出现 |
| GET | `/api/requirements` | 全部需求 |
| POST | `/api/p/{project}/requirements` | 提需求（body: context、images、source、chain） |
| GET | `/api/requirements/{id}` | `{ requirement, events }` |
| POST | `/api/requirements/{id}/nodes/{node}/run` | 起容器或开始动手 |
| POST | `.../accept` | 通过（可带 comment） |
| POST | `.../reject` | 驳回（reason 必填，409 表示不是当前站） |
| POST | `.../comment` | 评论 |
| POST | `.../rules` | 往这一站追加规则，默认 AGENTS.md 不改 |
| POST | `/api/requirements/{id}/images` | 传图：`multipart/form-data`，字段名 `files`（可多个）；一次 ≤5 张、每张 ≤5MB，按文件头认 png / jpeg / webp / gif；有一张不合规就整批 400 且不进盘 |
| GET | `/api/requirements/{id}/images/{name}` | 取图：原样字节 + 正确的 `Content-Type` / `Content-Length`；文件名越界、或不属于这条需求，一律 404 |
| DELETE | `/api/requirements/{id}/images/{name}` | 删图：文件删掉、同时从 `Images` 里摘掉；找不到 404 |
| GET | `/api/bootstrap` | **免登录**：`{"signupAvailable": true}` 只在库是空的时候（还有没有人可注册） |

请求体用 `DisallowUnknownFields` + 1MiB 上限解码；未知字段返回 400。

## 接入层

给平台外面的人（脚本、另一个系统）用的四个接口。它们只做「认身份 / 塞需求 / 拿回结果」，判定仍归状态机：

| 方法 | 路径 | 认证 | 用途 |
| --- | --- | --- | --- |
| POST | `/api/intake/projects` | 管理口令 `-admin-token` | 建 project，**唯一一次**返回它的访问口令 `pk_…` |
| GET | `/api/intake/projects` | 访问口令 | 这个 project 的名字与链条（选链条用） |
| POST | `/api/intake/requirements` | 访问口令 | 收需求（context、images、chain、reporter） |
| GET | `/api/intake/requirements/{id}` | 访问口令 | 拉模式：到哪一步了、成没成、为什么 |

- 认证走 `Authorization: Bearer <token>`；口令比较是常数时间，且不落日志。
- 服务不配 `-admin-token` 时「建 project」直接 503：接入层默认是关的。
- 整条需求被拒（首站被拒）时，除了库里留一条平台留言，还会尽力 POST 一次到 `reporter.callbackURL`（5 秒超时），结果记成一条 `notify` 事件。**回告失败不改状态**——送不到是网络的事，不是判定的事。
- 没有 callback 也能拿到结论：拉模式就是兜底。

## 角色与权力

节点动作要「资格」：一个请求能不能按某一站，由「角色对这个节点有没有权力」决定。身份只有口令，没有账号体系。

权力四值：`review` / `dev` / `test` / `release`。

不写权力时按节点类型给默认值（建链可逐站覆盖）：

| 节点类型 | 默认权力 |
| --- | --- |
| create | dev |
| assess | review |
| dev | dev |
| crosstest | test |
| merge | review |
| release | release |

链条上每个节点可以写 `power` 覆盖默认值；需求进链那一刻把权力定死在快照里——之后改链条，不改已经在飞的需求。

角色管理接口用 project 管理口令认证（`-admin-token`），不是角色口令：

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| POST | `/api/p/{project}/roles` | 建角色（name + powers），**唯一一次**返回角色口令 `rl_…` |
| GET | `/api/p/{project}/roles` | 列出角色，不回显口令 |
| POST | `/api/p/{project}/roles/{id}/rotate` | 换口令：旧口令立刻失效，新口令只在这条响应里出现 |
| DELETE | `/api/p/{project}/roles/{id}` | 删角色；删掉之后它再也不能按 |

- 同一个 project 里角色名唯一：评论里记的是角色名，重名就分不清是谁按的。
- 角色只在它自己的 project 里有意义：拿一个 project 的管理口令改不到别的 project 的角色。
- 没配 `-admin-token` 的部署里这四个接口一律 503（接入层没开）。但**链不会因此按不动**：建 project 时平台顺手发一个四权齐全的 `owner` 角色，口令就在那条 201 响应里——建项目的人当场拿到这个项目的钥匙。手建别的角色仍然要管理口令，这条没放宽。

### 动作默认拒绝

`run` / `accept` / `reject` 要求「带得出对应权力的角色口令」，判不了就挡。三条 403 的文案就是契约（前端靠它们区分「该去建角色」还是「该换口令」）：

| 情形 | 响应 |
| --- | --- |
| 请求里没有认得出的角色口令 | `这个动作需要一个带 %s 权力的角色口令` |
| 角色属于别的 project | `角色属于 %s，这条需求在 %s` |
| 角色属于本 project 但没有这个权力 | `角色「%s」没有 %s 权力，不能在这个节点上确认/拒绝` |

没有角色时按钮按不动，只能看。这是刻意的：宽进来一次就会变成常态。

### 评论不受限

`comment` 不校验权力：谁都能说话。带了认得出的角色口令，作者记成那个角色；没带就是访客。`rules`（给这一站追加规则）同样不看权力。

## 怎么跑

前端产物已经入库（`webui/dist`），因为 `//go:embed` 要它：

```bash
cd apps/chain
export GOCACHE=$PWD/.cache/go-build GOPATH=$PWD/.cache/go
go test ./...
go run . -addr 127.0.0.1:8099 -exec fake     # 打开 http://127.0.0.1:8099
# 要对外开放接入层（建 project 用的管理口令）：
# go run . -addr 127.0.0.1:8099 -exec fake -admin-token "$(openssl rand -hex 16)"
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

## 审核方：容器自审怎么表达

节点的 `review` 只有两个取值。定了 `ai` 的节点，容器跑完由**它自己**给出结论，平台只负责读与落：

| 容器输出里最后一行 | 平台做什么 |
| --- | --- |
| `CHAIN_VERDICT: pass` | 本节点直接定案，位置前移，留一条容器的通过评论 |
| `CHAIN_VERDICT: reject 原因` | 与人工驳回走同一条路：回滚到上一站；首站则拒掉整条需求并回告 |
| 没有这行 / 取值认不出 / reject 但没写原因 | 停在待审，留一条系统留言说明「判不了」，转人工 |

约定只有三条，都是为了「判不出来不许当通过」：

1. 取**最后一条**出现的标记：容器可以先自评再更正，最后那句才算数。
2. 认不出的取值是 unknown，不是 pass。
3. 没写理由的 reject 不回滚——没有理由的驳回没法让人知道该改什么。

人审节点上容器说破天也只是输出：结论要不要当结论，由落库那一步（`FinishRun`）定性，执行器只负责如实报告。空节点（dev / merge）没有容器，声明 `review: ai` 会被链条校验直接拒掉。

容器这边要做的只有一件事：在输出里打一行 `CHAIN_VERDICT`。想接模型就在那一行之前自己问自己，平台不掺和。

仓库里有一个真能跑的镜像：`images/assess/`（alpine + 一段 sh，做机械评估并给结论），构建与接线见 `images/README.md`。

## 已知边界

1. AI 自审只认容器自己打的那一行标记（见下节），平台不去调模型、也不看容器干得对不对。
2. 事件流是给人看的记录，不参与任何判定。
3. 没有乐观锁：同一需求的两次并发写会互相覆盖（`rev` 字段已留，但还没有使用）。
4. 容器里跑什么都没验证：平台只保证注入与留痕，不保证镜像真的能干那件事。
5. 回告只发一次、没有重试队列，也没有签名：对方不能靠签名验真伪，只能靠拉模式对账。
6. 访问口令不能轮换也不能吊销：要换只能改库或重建 project。
7. 角色口令没有过期时间、也没有审计：发出去就一直有效，谁用过只留在评论与事件里。
8. 角色不能跨 project：一个角色只在一个 project 里有意义。
9. 管理口令不分级：拿到它的人能建任意角色；它和访问口令一样不能吊销。
