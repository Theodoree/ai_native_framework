# Changelog

本文件记录本项目所有显著变更，格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [未发布]

### 新增

#### 节点运行时与版本

- 节点可逐站声明 `harness`（`codex` / `claude` / `deepseek-harness`）与 CLI 版本；不写就落到节点类型的默认模板。选择顺序是「节点声明 > 类型映射 > 内嵌默认」，进链那一刻定成快照，之后改模板表不影响在跑的需求。空节点（`dev` / `merge`）声明这两个字段会被拒。
- 容器注入 `CHAIN_AGENT` 与 `CHAIN_AGENT_VERSION`，`entrypoint.sh` 用 `npx -y <包>@<版本>` 运行时解析：镜像不预装 agent CLI，换版本不用重烘镜像；要钉死版本（离线部署）才在 Dockerfile 里预装并打开 `ENV AGENT_CMD`。
- `GET /api/templates` 给前端下拉框：`latest` 排第一，其余按版本倒序最多 10 个候选。这是候选不是白名单，手填照样跑；建链前校验 harness，认不出就 400 点名可用键。
- 前端链条编辑器每站多了「agent 运行时」与「版本」两个可搜索下拉（都可在候选里搜索），节点卡副标题显示「运行时 · 版本」。候选来自 `GET /api/templates`：`latest` 排第一，其余按版本倒序最多 10 个。

#### 自定义 AGENTS.md 落文件

- 节点可以有一份自定义 AGENTS.md，整份读写（空内容＝清除，上限 256 KiB）：正文存 `$HOME/.<项目名>/agents/<需求 id>/<站 key>.md`，库里只记路径、`checksum`（sha256）、大小与更新时间。
- 每次读（含注入前）都重算摘要与库里比对：文件被人改过、或文件没了但库里还有记录，这一站直接拒绝执行，并在该节点留一条系统评论——不一致的内容绝不进容器。
- 老库里节点上的 `rules[]` 在第一次读到这条需求时一次性搬成文件（幂等），代码不再往那个字段写。
- 工作区布局改了：`$WORKSPACE/AGENTS.md` 由平台每次整份重写（默认职责 + 仓库策略指针 + 本站追加），仓库 clone 到 `$WORKSPACE/repo`（子目录名由 `CHAIN_SOURCE` 改），仓库自带的那份 AGENTS.md 逐字节不动。

### 变更

- 账号只由管理员分配：删掉自助注册与 `/api/signup`、`/api/bootstrap`（一律 404）。空库的第一个管理员用 `chain user add -username … -password … -admin` 建，空库启动时日志直接打出这行命令。
- 权力只由节点类型决定，删掉逐站权力覆盖：`create`→`dev`、`assess`→`review`、`dev`→`dev`、`crosstest`→`test`、`merge`→`review`、`release`→`release`。链条编辑器里不显示任何权力字样，权力只用于后端鉴权与按钮预禁用。
- 摘要字段从 `md5` 改名 `checksum`（算的一直是 sha256）：名字只承诺摘要、不承诺算法；老库那一列留成死列，不再读。
- 节点表补 `harness` / `version` 两列并读回：此前只在链路定义里有，需求里的节点快照拿不到。
- 框架文档按本仓现状填实：`AGENTS.md` 的工具链三行改为 gofmt / `go vet` / `go test`，`docs/development.md` 写清 Go 构建缓存放仓库内、测试与构建命令，`docs/language-standards.md` 的 Go 节改用 `go vet` 作 lint。

### 修复

- 需求详情的节点卡整块不渲染：后端把空数组字段整个省掉，前端按 `node.rules.length` 取长度就炸。前端在唯一数据入口把数组字段补齐后恢复。
- 链条编辑器的运行时下拉「能输入但不筛」：候选改走下拉的数据源（`:options` + `#option` 槽），键入 `cod` 只剩 `codex`。

### 移除

- 自助注册、`/api/bootstrap`、逐站权力覆盖。老库的 `nodes.power` 列保留但不读不写（不 DROP COLUMN 是避免破坏性迁移）。

## [0.1.0] - 2026-10-28

第一个完整版本：需求进链之后，位置只由节点状态推导；谁按得动哪一站，由账号与项目级角色决定。按能力分组，不复述提交历史。

### 新增

#### 链条与需求

- 节点类型封闭为六类（`create` / `assess` / `dev` / `crosstest` / `merge` / `release`）：链头必须是需求评估，链尾必须是上线，中间任意排。
- 项目可挂多条链，提需求时选链（不带 `chain` 时用第一条）；链的版本在需求进入那一刻钉住，之后改链条不影响已经在飞的需求。
- 需求进链即给出分支名 `req/<project>/<id>`（仓库里的分支要人自己建，平台不碰仓库）。
- 节点状态机 `pending → running → awaiting_review → accepted`，`rejected` 作回滚标记；位置不落库，由「第一个还没通过的节点」推导。

#### 账号与会话

- 用户名 + 口令的账号体系：首次开库时 `POST /api/signup` 可用且注册者即管理员，之后注册通道关闭（409），其余账号由管理员建。
- `POST /api/login` 发 HttpOnly Cookie `chain_session`（7 天），`POST /api/logout` 删会话，`PUT /api/me/password` 改自己的口令（≥8 位）。
- `GET /api/me` 返回 `{user, memberships}`：账号本身（含是否管理员）+ 在哪些项目里拿到哪个角色、哪些权力。
- API 密钥 `ak_…`：`POST /api/keys` 建（secret 只在响应里出现一次）、`DELETE /api/keys/{id}` 吊销，外部系统带 `Authorization: Bearer ak_…` 调用。密钥认人、不分权，权限仍看项目成员资格。

#### 项目级角色与权力

- 四种权力 `review` / `dev` / `test` / `release`；节点不写权力时按类型取默认（create→dev、assess→review、dev→dev、crosstest→test、merge→review、release→release），可逐站覆盖，进链即定死在快照里。
- 角色 = 名字 + 权力清单，授予给账号（`assignments` 表）；管理员天生四权齐全，普通账号取「在这个项目里被授予的角色并集」，项目外的授予不算。
- 资格收紧到三处：建项目限管理员；提需求、评论、追加规则、读需求与图片要项目成员（有任一权力即成员，管理员天生成员）；项目列表与需求列表只回「我参与的项目」。
- 节点动作默认拒绝：`run` / `accept` / `reject` / `restart` 要这一站所要的权力，401（没登录）/ 403（没资格、没权力）的文案是契约，前端与接入层共用同一份。

#### 需求

- 需求带图：`POST /api/requirements/{id}/images`（multipart，字段名 `files`，一次 ≤5 张、每张 ≤5MB，按文件头认 png / jpeg / webp / gif，先全校验再落盘），`GET` 取图、`DELETE` 删图；落盘目录由 `-uploads` 指定（默认 `data/uploads`）。
- 节点重启：`POST /api/requirements/{id}/nodes/{node}/restart`；已通过的站重启是破坏性的，必须写理由（后面基于它的站都要退）。
- 容器自审：节点声明 `review: ai` 时，容器在输出里打一行 `CHAIN_VERDICT: pass|reject 原因` 自己定案；标记缺失、取值认不出、reject 没写原因，一律停在待审并留系统留言——判不出来不许当通过。

#### 执行与部署

- `apps/chain/deploy/nodes.yaml`：节点模板表（模板 = 镜像 + 命令 + 超时 + 版本 + 环境，节点 = 哪一站用哪个模板）。它同时被 `go:embed` 编进二进制，改完要重新编译才会进二进制；仓库里没有、展开目录里也没有时回落内嵌默认表。
- `apps/chain/deploy/agent-image/`：三个可自建 agent 镜像（codex / claude / DeepSeek Harness）+ `build-images.sh` + `entrypoint.sh`，同样编进二进制，用 `chain assets` 展开到 `$HOME/.<项目名>/` 后在那里烘。执行器优先 clone 项目仓库，只有 `repo` 是本机绝对路径时才挂载；空节点不起容器。

#### 界面（Vue 3 + Vite + TS + Arco Design Vue）

- 登录 / 注册 / 会话态 / 顶栏用户菜单（改密码、登出）；登录态由 `GET /api/me` 探出，任意业务请求 401 时回登录页并提示会话过期。
- 后台三页：用户管理、项目设置（角色 + 成员）、我的 API 密钥。非管理员看到的入口置灰并给理由——功能真实存在，所以保留入口而不是隐藏。
- 需求列表可选链、需求详情可上传 / 预览 / 删除图片、横向节点链条、只追加的事件流。
- 按权力提前禁用按钮：前端默认权力表与后端同口径；前端禁用只是提前让步，后端 403 仍是最终裁决。

#### 接入层

- 两个接口：`POST /api/intake/requirements` 塞需求、`GET /api/intake/requirements/{id}` 拉结论；用 API 密钥认证，按项目成员资格放行。
- 整条需求被拒时尽力回告一次（`reporter.callbackURL`，5 秒超时），回告结果记成事件；**回告失败不改状态**，结论始终可以用拉模式取到。

### 变更

- HTTP 层从标准库 ServeMux 迁到 gin，对外行为不变。
- 存储从文件快照换成 SQLite（纯 Go 驱动 `modernc.org/sqlite`，免 cgo）；`Store` 仍是接口，换 MySQL 只加一个实现。
- 前端组件库从 PrimeVue 换成 Arco Design Vue 2.59.0（MIT，全量注册），代价是整包入库：999 kB JS / 421 kB CSS（gzip 298 / 52）。

### 修复

- 容器输出里的模型密钥会被抹掉再入库；日志分隔符改用真换行，不再把字面量写进评论。

### 移除

- 四类口令全部删除：`-admin-token` 管理口令、`pk_` 项目访问口令、`rl_` 角色口令、建项目送的 `owner` 角色。身份改由账号与会话承担，权限改由项目级角色授予。
- 上一版的 Node 判据载体（`scripts/*.mjs`）此前已整批删除，判据全部在 Go 里；`scripts/` 现在只剩一页索引。

[![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)
