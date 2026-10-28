# apps/chain — 链条平台

状态：**active**（纵切面可跑：状态机 + SQLite + 容器执行器 + 嵌入的前端产物）

## 它做什么

一条需求进链之后，位置由「每个节点的状态」推导出来，没有独立的编排器：

- **链条**：节点顺序的声明。节点类型是封闭的六类（create / assess / dev / crosstest / merge / release），头必须是需求评估、尾必须是上线。
- **需求**：进链即建分支（`req/<project>/<id>`），链的版本在进入时被钉住。
- **节点状态机**：pending → running → awaiting_review → accepted；rejected 是回滚标记。
- **谁审**：每个节点声明 `review: ai | human`。ai 的节点由容器自己定案，human 的节点停在待审等人按。
- **评论、执行记录**：留在节点上，只追加不删。**自定义 AGENTS.md**：整份读写（空＝清除），正文存文件、库里只留路径与摘要。
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
| Chain       | key、type、version、nodes[]（key、type、review、harness、version）
                                                                        |
| Node        | key、type、review、harness、version、index、state、attempts[]、comments[]、agents{path,checksum,size,updatedAt}、artifacts[]、rev                   |
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

节点 → 容器模板的映射和模板本身都在声明文件 `apps/chain/deploy/nodes.yaml`（`version: 1` + `templates` + `nodes` 两段）。它在包内，因为 `go:embed` 只能嵌本包目录；仓库外没有第二份，二进制里那一份是同一个源。

`-templates` 不给时按三级回落找，日志会说清楚用的是哪一个：① 仓库里的 `apps/chain/deploy/nodes.yaml`（开发态）→ ② `$HOME/.<项目名>/nodes.yaml`（`chain assets` 展开态）→ ③ 内嵌默认表。

```bash
go run . -db chain.db -exec docker                    # 自动找：仓库 → 家目录 → 内嵌
go run . -db chain.db -exec docker -templates /etc/nodes.yaml
go run . assets --dry-run                             # 先看会展开哪些文件（不落盘）
go run . assets                                       # 展开到 $HOME/.<项目名>/
```

模板里有两个**互不相干**的字段：

- `image` 是镜像引用，**原样**交给 `docker run`（自己带 tag，如 `${APP}/agent-codex:latest`）。
- `version` 是**镜像里那个 agent CLI 的版本**（默认 `latest`），跟 tag 没关系：换 CLI 版本不用重烘镜像，容器的 `entrypoint.sh` 按它去 `npx -y <包>@<版本>` 解析。

将来真把 harness 烘进镜像（`image:tag = harness@version`）时两者才会绑在一起，本期没做，代码里只留了注释。

节点级还能各自覆盖：`harness` 决定用哪个模板（`codex` / `claude` / `deepseek-harness`），`version` 决定这一站跑哪个 CLI 版本。选择顺序是**节点声明 > 类型映射 > 内嵌默认**；进链时这两个字段就定成快照，事后改模板表不影响在跑的需求。空节点（`dev` / `merge`）声明 harness / version 会被拒——它不跑容器。

`versions` 是给前端下拉框的候选清单（`GET /api/templates` 取，`latest` 排第一，其余按版本倒序最多 10 个），**不是白名单**：手填一个没列出来的版本照样跑（自由输入，allow-create）。

项目名解析顺序是 `-app` > `CHAIN_APP` > 编译期默认（`-ldflags "-X main.appName=…"` 可改）。

- 扩展名 `.yaml`/`.yml` 按 YAML 读，其余后缀仍走早期版本的扁平 JSON 格式（老配置不用改）。
- 声明文件**不存在**时打一行日志回落内嵌默认表，服务照常起（部署里还没放这个文件时不至于起不来）。
- 声明文件**存在但写错**时 fail-closed 并点名字段：版本不是 1、模板缺 image 或 command、timeout 不是合法时长或 ≤0、nodes 里出现不认识的节点类型、节点引用了不存在的模板——这几种都是启动期报错，不猜。

解析在 `templates.go`（YAML 走 `gopkg.in/yaml.v3`，不自己切字符串）。

### 节点镜像从哪来

`apps/chain/deploy/` 整个目录（`nodes.yaml` + `agent-image/` 下的三个 Dockerfile、两个 shell 脚本、一份 README，共 7 个文件）被 `go:embed` 编进二进制。所以二进制离开仓库之后，模板与 Dockerfile 仍然在里面——**不需要先 clone 仓库才能烘镜像**。

要让它们落到磁盘上，跑一次展开：

```bash
go run . assets --dry-run          # 只列出会写哪 7 个文件，不落盘
go run . assets                    # 写到 $HOME/.<项目名>/
go run . assets -dir /tmp/x        # 换个目录（不给就是 $HOME/.<项目名>）
go run . assets -app demo_app      # 换项目名展开，${APP} 换成 demo_app
```

展开后的形状固定：`$HOME/.<项目名>/nodes.yaml` + `$HOME/.<项目名>/agent-image/`，两个 `.sh` 是 0755、其余 0644。它幂等：内容没变的文件不重写，复跑一行就是「新写 0 个，覆盖 0 个，跳过 7 个」（某一段模板被改过时只覆盖那一个文件）。

镜像就在展开目录里本地烘（同一套 Dockerfile 搬到 k3s 的构建端也一样跑，脚本不假设仓库在）：

```bash
cd "$HOME/.<项目名>/agent-image" && sh build-images.sh
VERSION=0.1.0 sh build-images.sh          # 换 tag
APP_NAME=别的名字 sh build-images.sh      # 换前缀（要和 nodes.yaml 的 image 对得上）
```

三条 `docker build` 得到 `nodes.yaml` 默认引用的那三个 tag。`APP_NAME` 的默认值就是展开时写进去的项目名，烘出来的名字与被引用的名字天然一致；拿仓库里**没展开**的那份直接跑会因缺项目名报错停下（比烘出一个没人引用的 tag 好）。

`${APP}` 是占位符：加载模板时换成当前项目名，`chain assets` 展开时也会把它换成真名写进 `nodes.yaml` 和 `build-images.sh`。所以项目改名之后（`-app` / `CHAIN_APP` / 编译期 `-ldflags`）模板表与脚本都不用动。

镜像里只有 `node:22-slim` + git + `entrypoint.sh`，**不预装 agent CLI**——版本是数据不是构建产物，容器里按 `CHAIN_AGENT` + `CHAIN_AGENT_VERSION` 用 `npx` 解析。想钉死某个版本（离线部署）就在 Dockerfile 里预装并打开 `ENV AGENT_CMD`，那时版本由镜像定。容器内的 clone / 写 AGENTS.md / 跑 agent / 报 `CHAIN_VERDICT:` 都归 `entrypoint.sh` 管。

### 注入什么、代码怎么进容器

注入的环境变量：`BASE_URL`、`CHAIN_MODEL`、`CHAIN_AGENTS_MD`（**整份** `$WORKSPACE/AGENTS.md` 的正文：默认职责 + 仓库策略指针 + 本站追加）、`CHAIN_AGENTS_APPEND`（只有本站追加那一段，同一份内容也拼进前缀 prompt，给不读文件的 agent 兜底）、`CHAIN_REQUIREMENT`、`CHAIN_NODE`、`CHAIN_BRANCH`、`CHAIN_CONTEXT`、`CHAIN_REPO`（project 的 repo 原值）、`CHAIN_WORKSPACE_MODE`（`clone` / `mount`）、`CHAIN_SOURCE`（仓库在工作区里的子目录名，默认 `repo`）、`CHAIN_AGENT`（跑哪个 CLI，就是模板键）、`CHAIN_AGENT_VERSION`（那个 CLI 的版本），以及（存在时）`CHAIN_MODEL_KEY`。模板自己的 `env` 追加在这批之后，同名的覆盖。

代码获取**默认是 clone**：容器拿到 `CHAIN_REPO` + `CHAIN_BRANCH`，在容器里自己 `git clone --depth 1 --branch`。只有 project 的 repo 是本机绝对路径且目录存在时才改成挂载（`--mount type=bind,…,target=/work`），那是**本地开发捷径**——执行记录里会写清这次是 clone 还是 mount。

`dev` / `merge` 是空节点，本来就不跑容器（人动手）；执行器这一层也会早退，不会因为模板表里查不到就报错。

镜像怎么来、为什么要先 `chain assets` 再 `build-images.sh`，见上一节「节点镜像从哪来」。

已知边界：**私有仓库 clone 需要凭证，本期不往容器里注入 token**——私有 repo 上跑容器节点会 clone 失败（entrypoint 打出 reject 并退 73）。

密钥只从环境变量取，且执行日志会把它替换成 `***`；未知模板 fail-closed（不猜镜像）。

### 给 agent 加插件、加技能：写这一站的自定义 AGENTS.md

平台不做插件管理：没有「装 skill / 装插件 / 挂 MCP」这类配置项，节点声明里也没有对应字段。想让某一站的 agent 多会一件事，就给这一站写一份自定义 AGENTS.md——它会被注入容器的工作区，等于给这一站的 agent 加了一段临时策略（用户口径：「因为现在的 AGENTS.md 没有办法满足现在的功能，所以我需要临时追加一些信息」）。

**正文存文件，库里只有路径与摘要**（用户口径：`数据库里面存路径和 md5，外面存文件`）：

| 存在哪 | 说明 |
| --- | --- |
| 正文 | `$HOME/.<项目名>/agents/<需求 id>/<站 key>.md`（只建 `agents` 这一个文件夹；先写临时文件再改名，读的人不会读到写了一半的那份） |
| 库里 | `nodes` 表的 `agents_path` / `agents_checksum` / `agents_size` / `agents_updated_at` 四列，**没有正文列** |
| 路径形状 | 相对 AppHome 的路径，不是绝对路径——项目改名后 AppHome 跟着变，存绝对路径的老记录一律失效 |

摘要字段叫 `checksum`，算的是 sha256。**名字只承诺摘要，不承诺算法**：以前叫 `md5` 的字段算的也是 sha256，改成 `checksum` 是免得后来的人拿它去对 md5（老库里那一列留成死列，不再读）。

接口沿用 `/rules` 路径，语义是**整份文档**：

- `GET /api/requirements/{id}/nodes/{node}/rules` → `{content, path, checksum, size, updatedAt}`；没有文档时 `content` 是空串。
- `POST` 同路径，请求体 `{content}` **整份覆盖**；`content` 全是空白＝清除（删文件、清字段、仍 200）；上限 256 KiB，超了 400 并报出实际字节数。
- 这道门与评论同一条成员门（文案「改不了这一站的规则」），但自定义文档比评论危险得多：评论只留一句话，这份文档会被整份注入容器、在下一站真正执行。

**注入（每次执行整份重写）**。工作区布局是用户定的：

```
$WORKSPACE/
           AGENTS.md      ← 平台写（默认职责 + 仓库策略指针 + 本站追加），每次整份重写
           $SOURCE/       ← git clone 出来的仓库（默认名 repo，CHAIN_SOURCE 可改）
```

- `$WORKSPACE/AGENTS.md` 是我们自己的文件，每次执行整份重写：两行默认职责 + 一句指针「仓库自带的策略在 `$SOURCE/AGENTS.md`，存在就先读它，与本文冲突时以本文为准」；这一站有追加内容时再接一段 `## 本站临时追加`。没有追加内容就不留空小节。
- 仓库自带的 `$SOURCE/AGENTS.md` **一个字都不动**（用户口径：「不是改原始 AGENTS.md」）。用例 `TestWorkspaceAgentsLayout` 断言它逐字节不变。
- agent 的 cwd 是工作区根，不是仓库目录：它要同时看到 `AGENTS.md` 与仓库子目录。
- 追加内容同时进 `CHAIN_AGENTS_APPEND` 与前缀 prompt：有的 agent 根本不读文件，prompt 是保底。
- 重启重跑会按同一份内容重新注入，不需要人工重填。

**对不上就不跑（fail-closed）**。每次读（含注入前）都重算摘要与库里的 `checksum` 比对：文件被人手改过、或文件没了但库里还有记录，这一站直接拒绝执行，在该站留一条系统评论「自定义 AGENTS.md 与库里记录不符（摘要不符 / 文件缺失），这一站不跑」。不一致的内容绝不进容器——那等于让容器跑一份没人知道是什么的指令。

**老数据**：以前存在节点上的 `rules[]` 会在读到这条需求时一次性搬成文件（一行一个「- 」列表项），搬完清空旧字段，幂等。代码不再往 `rules[]` 写。

只有「每次执行都要有、且与具体需求无关」的东西（新的 CLI、系统依赖）才动 Dockerfile 与 entrypoint，因为那属于镜像。

一句话：**随需求变的能力写这一站的 AGENTS.md，随平台变的能力进镜像**。

## HTTP 接口

| 方法       | 路径                                             | 用途                                                                                                                                              |
| ---------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET        | `/`                                              | 内嵌前端（`webui/dist`）                                                                                                                          |
| GET        | `/assets/`                                       | 内嵌前端的静态资源                                                                                                                                |
| GET        | `/api/templates`                                | 节点模板表：`[{key, image, version, versions, timeout}]`（登录即可）。建链时前端拿它填 harness 下拉框与版本候选                          |
| GET / POST | `/api/projects`                                  | 列表只回我参与的项目（管理员回全部）/ 创建（key 重复 409）。**管理员**；只写 project 本身，不授予任何人角色                                       |
| GET        | `/api/requirements`                              | 只回我参与的项目下的需求                                                                                                                          |
| POST       | `/api/p/{project}/requirements`                  | 提需求（body: context、images、source、chain）。**项目成员**：任一权力即成员，管理员天生是                                                        |
| GET        | `/api/requirements/{id}`                         | `{ requirement, events }`。要成员资格：401 → 404 → 403                                                                                            |
| POST       | `/api/requirements/{id}/nodes/{node}/run`        | 起容器或开始动手                                                                                                                                  |
| POST       | `/api/requirements/{id}/nodes/{node}/accept`     | 通过（可带 comment）                                                                                                                              |
| POST       | `/api/requirements/{id}/nodes/{node}/reject`     | 驳回（reason 必填，409 表示不是当前站）                                                                                                           |
| POST       | `/api/requirements/{id}/nodes/{node}/restart`    | 从这一站重跑（按不动就 403）                                                                                                                      |
| POST       | `/api/requirements/{id}/nodes/{node}/comment`    | 评论（**项目成员**，不查权力）                                                                                                                    |
| GET / POST | `/api/requirements/{id}/nodes/{node}/rules`      | 读 / 整份覆盖这一站的自定义 AGENTS.md：`{content, path, checksum, size, updatedAt}`，空 content＝清除，上限 256 KiB（**项目成员**，不查权力）           |
| POST       | `/api/requirements/{id}/images`                  | 传图：`multipart/form-data`，字段名 `files`（可多个）；一次 ≤5 张、每张 ≤5MB，按文件头认 png / jpeg / webp / gif；有一张不合规就整批 400 且不进盘 |
| GET        | `/api/requirements/{id}/images/{name}`           | 取图：原样字节 + 正确的 `Content-Type` / `Content-Length`；文件名越界、或不属于这条需求，一律 404                                                 |
| DELETE     | `/api/requirements/{id}/images/{name}`           | 删图：文件删掉、同时从 `Images` 里摘掉；找不到 404                                                                                                |
| POST       | `/api/login`                                     | **免登录**：用户名 + 口令，发 Cookie `chain_session`（HttpOnly，7 天）                                                                            |
| POST       | `/api/logout`                                    | 删掉当前会话                                                                                                                                      |
| GET        | `/api/me`                                        | 我是谁：`{user, memberships}`——账号（含是否管理员）+ 在每个项目里拿到了哪些角色与权力                                                             |
| PUT        | `/api/me/password`                               | 改自己的口令（≥8 位）                                                                                                                             |
| GET / POST | `/api/users`                                     | 列表 / 建账号。**管理员**；body 可带 `admin: true` 建一个管理员账号，不带则建成普通账号（已有账号不能升级，见「已知边界」）                       |
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
| 造第一个账号                              | 命令行 `./chain user add -username admin -password <密码> -admin`（**没有自助注册**：`/api/signup`、`/api/bootstrap` 已删除，一律 404） |
| 建项目                                    | 管理员（`POST /api/projects` 的第一道门）                                                                           |
| 建角色 / 加成员 / 删角色                  | 管理员。把人放进项目只有这一个入口                                                                                  |
| 提需求（界面）                            | 该项目的成员：任一权力即成员，管理员天生是                                                                          |
| 提需求 / 拉结论（接入层）                 | 该项目的成员（管理员天生是；普通账号要有这个项目里任一角色）                                                        |
| 按节点（run / accept / reject / restart） | 有这个节点所要权力的人                                                                                              |
| 看需求、看图、看列表                      | 列表只回我参与的项目；单条需求与图片要成员资格（401 → 404 → 403）                                                   |
| 评论、自定义 AGENTS.md                    | 该项目的成员，不查权力                                                                                              |

> 建项目限管理员、加成员也是管理员专属，所以「建完项目自己进不去」这个缝不存在：建项目的人一定是管理员，管理员天生算任何项目的成员。普通账号的项目成员资格只有一个来源——管理员在项目设置里授予一个角色。

### 权力四值

`review` / `dev` / `test` / `release`（`model.go` 里的四个常量；写别的字符串在造链和造角色时就被拒）。

判定只有一个地方：**管理员四权齐全**；普通账号取「在这个项目里被授予的所有角色的并集」。项目外的授予一律不算——跨项目越权就是在这里断掉的。

节点要哪一档权力，只看类型（没有逐站覆盖这回事）：

| 节点类型  | 默认权力 |
| --------- | -------- |
| create    | dev      |
| assess    | review   |
| dev       | dev      |
| crosstest | test     |
| merge     | review   |
| release   | release  |

**权力只由节点类型决定**，链条上不能逐站覆盖：同一类站永远是同一档权力，改链条也不会把某一站改成别的权力。所以「授予谁能按这类站」只取决于「这个人在这个项目里有没有这一档权力」。

老库的 `nodes.power` 列还在，但代码既不读也不写（不 DROP COLUMN 是避免破坏性迁移）：升级不会把已有需求变成谁也按不动。

角色本身没有口令、也不会过期：它是一个「名字 + 权力清单」，被授予给账号。授予关系存在 `assignments` 表里，删角色会连带删掉它的授予。

### 动作默认拒绝

`run` / `accept` / `reject` / `restart` 要求「有这一站所要的权力」，判不了就挡。文案是契约（前端靠它区分「该去登录」还是「该找管理员要角色」）：

| 情形                      | 状态码 | 响应                                                                                                                                           |
| ------------------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| 没有登录、也没带 API 密钥 | 401    | `没有登录：请先登录（POST /api/login）或带上 API 密钥（Authorization: Bearer ak_…）`                                                           |
| 登录了但没有这一站的权力  | 403    | `「%s」在 %s 里没有 %s 权力，不能在这个节点上确认/拒绝`（依次是用户名、项目 key、权力）                                                        |
| 要管理员才行的接口        | 403    | `只有管理员能做这件事`                                                                                                                         |
| 不是项目成员              | 403    | `「%s」不是 %s 的成员，%s`（依次是用户名、项目 key、动作：提不了需求 / 看不到这条需求 / 改不了这条需求 / 评不了这条需求 / 改不了这一站的规则） |

没有权力时按钮按不动，只能看。这是刻意的：宽进来一次就会变成常态。

### 评论与自定义 AGENTS.md：要成员，不要权力

`comment` 与 `rules`（读写这一站的自定义 AGENTS.md）不校验**权力**，但要校验**成员资格**：是这个项目的人才能说话，作者记成账号名。

评论以前对任何登录的人开放，现在收进项目边界。自定义 AGENTS.md 比评论更严——它会被整份注入容器的工作区、影响容器下一步怎么干，所以走的是同一条成员门，文案是「改不了这一站的规则」。

## 怎么跑

前端产物已经入库（`webui/dist`），因为 `//go:embed` 要它：

```bash
cd apps/chain
export GOCACHE=$PWD/.cache/go-build GOPATH=$PWD/.cache/go
go test ./...
go run . -addr 127.0.0.1:8099 -exec fake     # 打开 http://127.0.0.1:8099
# 第一个账号只能从命令行造（没有自助注册）：
go run . user add -username admin -password <至少 8 位> -admin
# 库里一个账号都没有时，启动日志会提示这一行
```

`chain user add` 就是「造账号」这一个子命令（口令规则与 `POST /api/users` 是同一处实现，撞名与短口令都建不成，退出码非 0）：

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| `-username` | 必填 | 同一个库里不能重名 |
| `-password` | 必填 | 至少 8 个字符 |
| `-admin` | 关 | 建的是管理员；**已有账号不能靠这个参数升级** |
| `-db-driver` / `-db` | `sqlite` / `data/chain.db` | 与服务同一套参数，指向同一个库 |

要接真容器（需要本机 docker daemon）：

```bash
cd apps/chain
# -templates 不给时先找仓库里的 apps/chain/deploy/nodes.yaml，再找 $HOME/.<项目名>/nodes.yaml
go run . -addr 127.0.0.1:8099 -exec docker \
  -base-url https://api.deepseek.com -model deepseek-chat

# 要烘镜像（第一次用容器节点）：
go run . assets && sh "$HOME/.<项目名>/agent-image/build-images.sh"
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
10. 已有账号不能升级为管理员，只能新建一个管理员账号：`POST /api/users` 的 body 带 `admin: true` 即可（默认 false）。没有把管理员降回普通账号的接口，也没有分级——管理员天生四权齐全。
