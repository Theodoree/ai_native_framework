# 存储换成 SQLite、执行换成 docker、前端换成 Vue

日期：2026-10-27 ｜ 状态：implemented ｜ 分支：`feat/p32-chain-platform`

## 为什么动这三样

上一版骨架能用，但三处都停在「演示可以、接真活不行」：数据以 JSON 文件散落、执行器是假的、页面是手写的一坨 HTML。用户明确要求「数据库 sqlite，后续可能是 mysql」「执行引擎先用本地的，后续给 k3s」「前端用一个漂亮的现代框架」。

## 决定一：SQLite，但先立接口

**做法**：`Store` 是接口（`store.go`），SQLite 只是它的一个实现（`store_sqlite.go`）。驱动选 `modernc.org/sqlite`——纯 Go，不要 cgo。

**为什么**：要换 MySQL 时，如果调用方知道 SQL，换库就等于改一片代码；接口挡住这一层，换库只加一个实现。选纯 Go 驱动是为了 `go build` 在任何机器上都能过——cgo 会让交叉编译和「换台机器就跑不起来」变成常态问题。

**放弃了什么**：
- 单写者。SQLite 并发写会撞 `database is locked`，所以连接池上限设 1。等于承认这一版是单机单实例；真要多实例，换 MySQL 之前也跑不了。
- 保存是整份快照（单事务里 upsert 需求 → 重插节点 / 执行记录 / 评论）。行级增量更新更省，但要在 Go 侧维护「哪几行变了」，而这一版的数据量用不上这个优化。

## 决定二：DockerExecutor 用环境变量注入，不挂配置文件

**做法**：`docker run --rm -i --init`，所有上下文（`BASE_URL`、`CHAIN_MODEL`、`CHAIN_AGENTS_MD`、`CHAIN_REQUIREMENT`、`CHAIN_NODE`、`CHAIN_BRANCH`、`CHAIN_CONTEXT`、必要时 `CHAIN_MODEL_KEY`）走 `-e`；repo 是绝对路径时挂到 `/work`；日志只留尾部 8KB；密钥在落库前替换成 `***`。

**为什么**：容器里的 agent 需要一个「我是谁、我要干什么」的入口，环境变量是最短的路径——不用约定挂载点、不用生成临时配置文件、不用清理。`CHAIN_AGENTS_MD` 是**生成的文本**而不是挂载仓库里的 AGENTS.md，因为「某条需求某一步要加规则」那条铁律要求默认文件不改。

**放弃了什么**：
- 注入面是固定的：想让容器多知道一件事，就得改 Go 代码加一个变量。这是故意的——注入面就是平台的暴露面。
- 日志只留尾部：跑 30 分钟的容器，前面 8KB 之外的东西没人看得到。留全文需要另存对象，这一版没做。
- 未知模板 fail-closed（不猜镜像名）。写错模板 key 就是一条失败评论，而不是一个「好像跑起来了」的假成功。

## 决定三：前端产物入库

**做法**：`apps/web`（Vue 3 + Vite + TS），`vite build` 输出到 `apps/chain/webui/dist`，`main.go` 用 `//go:embed webui/dist` 打进二进制；产物提交进仓库。

**为什么**：`go:embed` 只能嵌构建时已存在的文件，所以要么产物入库，要么 `go build` 之前必须先跑一次 npm——后者会让「clone 下来就能 `go run .`」这件事失效。一个二进制造型的小平台，产物入库更省事。

**放弃了什么**：
- 改了前端不重新 build 就不会生效，而且这种「忘了」不会报错——页面只是旧的。写进了 `apps/chain/README.md` 与根 README。
- 产物 148K 进版本库，每次改前端都产生一次 diff。

## 顺带记下

- 模板遗留的 `src/` 删除：本仓代码在 `apps/<模块>/`，留一个空的 `src/README.md` 会让「模块契约在哪」出现两个答案。
- `AGENTS.md` 特性表里的「机器 gate」保持 **OFF** 并注明理由：`.github` 整套已删，判据只剩本地 `go test`。若将来要接托管 CI，先决定「判据跑在谁的代码上」，否则会重演上一版「workflow 在 PR 自己的代码上现场编译引擎」的老问题。
- 写 Go 时踩到一个工具链坑：模板字符串里的 `\n` 会被吃掉一层变成真换行，导致 `string literal not terminated`。要换行符就 `var nl = string([]byte{10})` 或改用原始字符串。
