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
- 不做多租户、不做并发控制（单机单写者）：一个部署一份库，写者是单进程。账号体系有，但只到「谁是谁 + 项目级角色」这一层，没有组织、没有分组、没有 SSO。
- 不保证回告必达：回告失败只记事件，结论靠拉模式自己取。
- 不读 GitHub：仓库只是 project 上的一个字符串字段，平台不调用任何仓库 API。
- 不在容器里替人改仓库：容器只产出日志、产物与评论。

## 数据形状

| 实体        | 关键字段                                                                                                                                         |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Project     | key、name、repo、defaultBranch、chains、createdAt                                                                                                |
| Chain       | key、type、version、nodes[]（key、type、review）                                                                                                 |
| Node        | key、type、review、power、index、state、attempts[]、comments[]、rules[]、artifacts[]、rev                                                        |
| Role        | id、projectKey、name、powers[]、createdAt（**没有口令**：角色是授予给账号的，不是一把钥匙）                                                      |
| Requirement | id、projectKey、chainKey、chainVersion、context、images、source、branch、state、nodes[]、rev、reporter（谁提的、回告地址；接入层带过来的原样存） |
| User        | id、username、passwordHash、admin、createdAt                                                                                                     |
| Session     | tokenHash、userID、createdAt、expiresAt（Cookie 里的原文不落库）                                                                                 |
| APIKey      | id、userID、name、keyHash、createdAt、lastUsedAt（`ak_…` 原文只在建的时候出现一次）                                                              |
| Assignment  | projectKey、roleID、userID（「谁在哪个项目里拿到哪个角色」）                                                                                     |

存储是接口 `Store`（`store.go`），默认实现是 SQLite（`store_sqlite.go`，纯 Go 驱动 modernc.org/sqlite，免 cgo）。默认库文件 `data/chain.db`（已 gitignore）。换 MySQL 只需要再写一个 `Store` 实现：调用方一行不改。

表：`projects` / `roles` / `assignments` / `users` / `sessions` / `api_keys` / `requirements` / `nodes` / `attempts` / `comments` / `events`。一次保存是单事务快照（upsert 需求 → 重插它的节点、执行记录、评论），连接池上限 1（SQLite 单写者）。

## 执行器

两个实现，都由 `-exec` 选：

| `-exec`  | 实现             | 行为                                                        |
| -------- | ---------------- | ----------------------------------------------------------- |
| `fake`   | `FakeExecutor`   | 只写一条评论，明确说「本次调用没有连任何外部服务」          |
| `docker` | `DockerExecutor` | `docker run --rm -i --init`，注入环境变量，日志只留尾部 8KB |

### 模板从哪来

节点 → 容器模板的映射和模板本身都在仓库里的声明文件 `deploy/nodes.yaml`（`version: 1` + `templates` + `nodes` 两段）。`-templates` 改路径，默认就是它：

```bash
go run ./cmd/chain -db chain.db -exec docker                      # 读 deploy/nodes.yaml
go run ./cmd/chain -db chain.db -exec docker -templates /etc/nodes.yaml
```

- 扩展名 `.yaml`/`.yml` 按 YAML 读，其余后缀仍走早期版本的扁平 JSON 格式（老配置不用改）。
- 声明文件**不存在**时打一行日志回落内嵌默认表，服务照常起（部署里还没放这个文件时不至于起不来）。
- 声明文件**存在但写错**时 fail-closed 并点名字段：版本不是 1、模板缺 image 或 command、timeout 不是合法时长或 ≤0、nodes 里出现不认识的节点类型、节点引用了不存在的模板——这几种都是启动期报错，不猜。

解析在 `templates.go`（YAML 走 `gopkg.in/yaml.v3`，不自己切字符串）。

### 注入什么、代码怎么进容器

注入的环境变量：`BASE_URL`、`CHAIN_MODEL`、`CHAIN_AGENTS_MD`（默认职责 + 本站追加规则，不改仓库里的 AGENTS.md）、`CHAIN_REQUIREMENT`、`CHAIN_NODE`、`CHAIN_BRANCH`、`CHAIN_CONTEXT`、`CHAIN_REPO`（project 的 repo 原值）、`CHAIN_WORKSPACE_MODE`（`clone` / `mount`），以及（存在时）`CHAIN_MODEL_KEY`。模板自己的 `env` 追加在这批之后，同名的覆盖。

代码获取**默认是 clone**：容器拿到 `CHAIN_REPO` + `CHAIN_BRANCH`，在容器里自己 `git clone --depth 1 --branch`。只有 project 的 repo 是本机绝对路径且目录存在时才改成挂载（`--mount type=bind,…,target=/work`），那是**本地开发捷径**——执行记录里会写清这次是 clone 还是 mount。

`dev` / `merge` 是空节点，本来就不跑容器（人动手）；执行器这一层也会早退，不会因为模板表里查不到就报错。

镜像由 `deploy/agent-image/` 自建（`build-images.sh` 一次烘三个：codex / claude / deepseek-harness），里面只是 `node:22-slim` + git + 一个 agent CLI + `entrypoint.sh`。容器内的 clone / 写 AGENTS.md / 跑 agent / 报 `CHAIN_VERDICT:` 都归 `entrypoint.sh` 管。

已知边界：**私有仓库 clone 需要凭证，本期不往容器里注入 token**——私有 repo 上跑容器节点会 clone 失败（entrypoint 打出 reject 并退 73）。

密钥只从环境变量取，且执行日志会把它替换成 `***`；未知模板 fail-closed（不猜镜像）。

## HTTP 接口

| 方法       | 路径                                             | 用途                                                                                                                                              |
| ---------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET        | `/`                                              | 内嵌前端（`webui/dist`）                                                                                                                          |
| GET        | `/assets/`                                       | 内嵌前端的静态资源                                                                                                                                |
| GET / POST | `/api/projects`                                  | 列表 / 创建（key 重复 409）。要登录；创建只写 project 本身，不授予任何人角色                                                                      |
| GET        | `/api/requirements`                              | 全部需求                                                                                                                                          |
| POST       | `/api/p/{project}/requirements`                  | 提需求（body: context、images、source、chain）                                                                                                    |
| GET        | `/api/requirements/{id}`                         | `{ requirement, events }`                                                                                                                         |
| POST       | `/api/requirements/{id}/nodes/{node}/run`        | 起容器或开始动手                                                                                                                                  |
| POST       | `/api/requirements/{id}/nodes/{node}/accept`     | 通过（可带 comment）                                                                                                                              |
| POST       | `/api/requirements/{id}/nodes/{node}/reject`     | 驳回（reason 必填，409 表示不是当前站）                                                                                                           |
| POST       | `/api/requirements/{id}/nodes/{node}/restart`    | 从这一站重跑（按不动就 403）                                                                                                                      |
| POST       | `/api/requirements/{id}/nodes/{node}/comment`    | 评论（不查权力）                                                                                                                                  |
| POST       | `/api/requirements/{id}/nodes/{node}/rules`      | 往这一站追加规则，默认 AGENTS.md 不改（不查权力）                                                                                                 |
| POST       | `/api/requirements/{id}/images`                  | 传图：`multipart/form-data`，字段名 `files`（可多个）；一次 ≤5 张、每张 ≤5MB，按文件头认 png / jpeg / webp / gif；有一张不合规就整批 400 且不进盘 |
| GET        | `/api/requirements/{id}/images/{name}`           | 取图：原样字节 + 正确的 `Content-Type` / `Content-Length`；文件名越界、或不属于这条需求，一律 404                                                 |
| DELETE     | `/api/requirements/{id}/images/{name}`           | 删图：文件删掉、同时从 `Images` 里摘掉；找不到 404                                                                                                |
| POST       | `/api/signup`                                    | **免登录**：只在库是空的时候可用（第一个注册的人就是管理员），之后 409                                                                            |
| POST       | `/api/login`                                     | **免登录**：用户名 + 口令，发 Cookie `chain_session`（HttpOnly，7 天）                                                                            |
| GET        | `/api/bootstrap`                                 | **免登录**：`{"signupAvailable": true}` 只在库是空的时候（还有没有人可注册）                                                                      |
| POST       | `/api/logout`                                    | 删掉当前会话                                                                                                                                      |
| GET        | `/api/me`                                        | 我是谁：`{user, memberships}`——账号（含是否管理员）+ 在每个项目里拿到了哪些角色与权力                                                             |
| PUT        | `/api/me/password`                               | 改自己的口令（≥8 位）                                                                                                                             |
| GET / POST | `/api/users`                                     | 列表 / 建账号。**管理员**；新建的账号一律是普通账号（管理员只有一个，见「已知边界」）                                                             |
| POST       | `/api/users/{id}/password`                       | 重置别人的口令。**管理员**                                                                                                                        |
| GET / POST | `/api/keys`                                      | 列 / 建自己的 API 密钥；建的响应里 `secret` 只出现这一次                                                                                          |
| DELETE     | `/api/keys/{id}`                                 | 吊销自己的密钥（别人的 id 一律 404）                                                                                                              |
| GET / POST | `/api/p/{project}/roles`                         | 列 / 建角色（name + powers[]）。**管理员**                                                                                                        |
| DELETE     | `/api/p/{project}/roles/{id}`                    | 删角色，连带删掉它的授予。**管理员**                                                                                                              |
| GET / POST | `/api/p/{project}/roles/{id}/members`            | 列 / 加成员（body: `username`）。**管理员**                                                                                                       |
| DELETE     | `/api/p/{project}/roles/{id}/members/{username}` | 摘掉一个成员。**管理员**                                                                                                                          |
| POST       | `/api/intake/requirements`                       | 平台外塞需求（见下节「接入层」）                                                                                                                  |
| GET        | `/api/intake/requirements/{id}`                  | 平台外拉结论（见下节「接入层」）                                                                                                                  |

请求体用 `DisallowUnknownFields` + 1MiB 上限解码；未知字段返回 400。

## 接入层

给平台外面的人（脚本、另一个系统）用的两个接口。它们只做「认身份 / 塞需求 / 拿回结果」，判定仍归状态机：

| 方法 | 路径                            | 用途                                                            |
| ---- | ------------------------------- | --------------------------------------------------------------- |
| POST | `/api/intake/requirements`      | 收需求（body：`project` `context` `images` `chain` `reporter`） |
| GET  | `/api/intake/requirements/{id}` | 拉模式：到哪一步了、成没成、为什么                              |

- **怎么进来**：先发一把 API 密钥（界面里「密钥」页建，或 `POST /api/keys`），外部系统带 `Authorization: Bearer ak_…` 调用。密钥是某个账号的，认出来的就是那个人——没有「项目口令」这种身份了。
- 身份只有一个解析点：有 `Authorization: Bearer ak_…` 就按密钥认（库里存 sha256，只顺手记「上次使用时间」）；没有才看 Cookie `chain_session`（登录态）。带了 `ak_` 却查不到**不退回 Cookie**：一把被吊销的钥匙不该因为浏览器里还留着会话就继续好用。
- **权限是成员资格**：管理员天生算任何项目的成员，普通账号要有这个项目里的任一角色。不是成员就 403，文案点名到人：「「<用户名>」不是 <project> 的成员，提不了需求」/「…看不到这条需求」。
- 没有「接入层开关」：`-admin-token` 这个开关已删除（连同它背后的项目访问口令一起），这些接口永不 503；能不能进来只由账号与项目成员资格决定。
- 整条需求被拒（首站被拒）时，除了库里留一条平台留言，还会尽力 POST 一次到 `reporter.callbackURL`（5 秒超时），结果记成一条 `notify` 事件。**回告失败不改状态**——送不到是网络的事，不是判定的事。
- 没有 callback 也能拿到结论：拉模式就是兜底。

## 角色与权力

节点动作要「资格」：一个请求能不能按某一站，由「这个人对这个项目有没有这一站的权力」决定。**身份是账号，权力来自角色授予**——不再有「带着某个口令来代表某个角色」这条路。

### 谁能做什么

| 动作                                      | 谁可以                                                                                                              |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| 注册第一个账号                            | 谁先来谁注册：库是空的时候 `POST /api/signup` 开，注册的人就是管理员；之后注册通道关死（409），其余账号只能管理员建 |
| 建项目                                    | 任何登录的人（`POST /api/projects` 里没有管理员闸门）                                                               |
| 建角色 / 加成员 / 删角色                  | 管理员。把人放进项目只有这一个入口                                                                                  |
| 提需求（界面）                            | 任何登录的人（`POST /api/p/{project}/requirements` 只查登录）                                                       |
| 提需求 / 拉结论（接入层）                 | 该项目的成员（管理员天生是；普通账号要有这个项目里任一角色）                                                        |
| 按节点（run / accept / reject / restart） | 有这个节点所要权力的人                                                                                              |
| 评论、追加规则                            | 任何登录的人，不查权力                                                                                              |

> 前两条放在一起看有个缝：普通账号能建项目，却没有任何办法把自己或别人加进去——加成员是管理员专属。所以普通账号建完项目，自己并不是成员。这条是现状，不是设计。

### 权力四值

`review` / `dev` / `test` / `release`（`model.go` 里的四个常量；写别的字符串在造链和造角色时就被拒）。

判定只有一个地方：**管理员四权齐全**；普通账号取「在这个项目里被授予的所有角色的并集」。项目外的授予一律不算——跨项目越权就是在这里断掉的。

不写权力时按节点类型给默认值（建链可逐站覆盖）：

| 节点类型  | 默认权力 |
| --------- | -------- |
| create    | dev      |
| assess    | review   |
| dev       | dev      |
| crosstest | test     |
| merge     | review   |
| release   | release  |

链条上每个节点可以写 `power` 覆盖默认值；需求进链那一刻把权力定死在快照里——之后改链条，不改已经在飞的需求。老库里节点没有 `power` 列的，落回类型默认（升级不该把已有需求变成谁也按不动）。

角色本身没有口令、也不会过期：它是一个「名字 + 权力清单」，被授予给账号。授予关系存在 `assignments` 表里，删角色会连带删掉它的授予。

### 动作默认拒绝

`run` / `accept` / `reject` / `restart` 要求「有这一站所要的权力」，判不了就挡。文案是契约（前端靠它区分「该去登录」还是「该找管理员要角色」）：

| 情形                      | 状态码 | 响应                                                                                    |
| ------------------------- | ------ | --------------------------------------------------------------------------------------- |
| 没有登录、也没带 API 密钥 | 401    | `没有登录：请先登录（POST /api/login）或带上 API 密钥（Authorization: Bearer ak_…）`    |
| 登录了但没有这一站的权力  | 403    | `「%s」在 %s 里没有 %s 权力，不能在这个节点上确认/拒绝`（依次是用户名、项目 key、权力） |
| 要管理员才行的接口        | 403    | `只有管理员能做这件事`                                                                  |

没有权力时按钮按不动，只能看。这是刻意的：宽进来一次就会变成常态。

### 评论不受限

`comment` 不校验权力：登录了就能说话，作者记成账号名。`rules`（给这一站追加规则）同样不看权力。

## 怎么跑

前端产物已经入库（`webui/dist`），因为 `//go:embed` 要它：

```bash
cd apps/chain
export GOCACHE=$PWD/.cache/go-build GOPATH=$PWD/.cache/go
go test ./...
go run . -addr 127.0.0.1:8099 -exec fake     # 打开 http://127.0.0.1:8099
# 打开页面先注册（库是空的，第一个注册的人就是管理员），之后用这个账号登录
```

要接真容器（需要本机 docker daemon）：

```bash
go run . -addr 127.0.0.1:8099 -exec docker -templates deploy/nodes.yaml \
  -base-url https://api.deepseek.com -model deepseek-chat
```

需求图片落在 `-uploads`（默认 `data/uploads`，不存在会按需创建；`data/` 已 gitignore）。换目录就 `-uploads /var/lib/chain/uploads`，库里的记录与磁盘上的文件必须一起搬。

改了 `apps/web` 就要重新构建并提交产物，否则页面还是旧的：

```bash
cd ../web && npm run build      # 输出到 ../chain/webui/dist
```

## 审核方：容器自审怎么表达

节点的 `review` 只有两个取值。定了 `ai` 的节点，容器跑完由**它自己**给出结论，平台只负责读与落：

| 容器输出里最后一行                        | 平台做什么                                                   |
| ----------------------------------------- | ------------------------------------------------------------ |
| `CHAIN_VERDICT: pass`                     | 本节点直接定案，位置前移，留一条容器的通过评论               |
| `CHAIN_VERDICT: reject 原因`              | 与人工驳回走同一条路：回滚到上一站；首站则拒掉整条需求并回告 |
| 没有这行 / 取值认不出 / reject 但没写原因 | 停在待审，留一条系统留言说明「判不了」，转人工               |

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
6. 会话只靠过期：Cookie 里是会话 id，7 天到期，登出即删；没有「记住我」、没有二次验证、也没有会话列表可踢。
7. API 密钥能吊销，但身份不变：删掉密钥立刻失效，可它认出来的还是同一个人——权限仍看项目成员资格，不按密钥分权。
8. 角色不能跨 project：一个角色只在一个 project 里有意义。
9. 角色没有过期时间、也没有审计：授予与收回都不留事件，谁有过什么角色只能查当前表。
10. 管理员只有一个：第一个注册的人。之后建的账号一律是普通账号——没有「升成管理员」也没有「降回普通」的接口，多一个管理员只能改库。管理员天生四权齐全，不分级。
