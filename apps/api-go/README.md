# apps/api-go · 平台后端（Go 标准库）

**状态**：active —— 自 P-15 起是平台唯一的后端实现；旧原型（`web/` + `scripts/server.mjs`）已删除。

## 做什么

- 用 Go 标准库 §net/http§ 提供平台 JSON API（P-15 之前的那份脚本原型已删，行为以本文件与测试为准）
- 多一条事件时间线：§GET /api/events§
- 单二进制：构建期把 §apps/web-vue/dist§ 复制进 §apps/api-go/dist§，用 §//go:embed all:dist§ 内嵌；运行期不依赖磁盘 dist
- 远端同步：§POST /api/sync§ 只读拉 issue 列表（number/title/state/labels/updated_at），条件请求只靠 §If-None-Match§ + ETag，304 一个字节都不写盘
- 派生索引：§.agents/platform/index.db§（SQLite）存折叠结果、事件时间线、远端快照、在途记录，纯派生、删了自愈
- 在途台账：§.agents/platform/outbox.jsonl§ 记「本地改了状态、还没确认远端生效」的外发，只有它能回答「这条是不是还在路上」
- 知识库本体：§GET /api/kb§（列目录）与 §GET /api/kb/item§（看全文），索引落 §.agents/platform/kb.db§，纯派生、删了自愈
- 判定与账本全部经 §apps/engine§ 这个 Go 库直接调用（见「引擎契约」）：进程内调用，不再起子进程

## 不做什么

- 不判断状态机：§from/to/flow/labels§ 合法性、入口落点、声明的结构校验，全部只由 §apps/engine§ 回答
- 不解析 §state-machine.yml§：在 Go 里复制转换表校验，等于给真源开第二份实现
- 不自己读写账本结构：事件对象原样交给 §apps/engine§ 的账本函数
- 不做鉴权（本机单用户）
- 不替 label 与账本选边：两者不一致时只标 §divergence: true§ 并同时给出两边，不猜哪个对
- 默认不写远端：§PLATFORM_WRITE§ 不是 §1§ 时，发起变更只记在途、不联网；没有 token 时也不联网写
- 不把在途写进 §ledger.jsonl§：折叠器对每行按 §event.to§ 投影状态，非状态事件进去会污染折叠结果
- 不判定「该不该汇」：白名单是 §apps/api-go/kb.go§ 与 §apps/engine/kbexport.go§ 两处同口径（见「知识库本体」；逐字比对判据在 §tests/kb-allowlist-parity.test.mjs§），不改汇入范围、不做去重、不写知识库

## 运行

```bash
cd apps/api-go
PLATFORM_ROOT=$(git rev-parse --show-toplevel) PORT=4317 go run .
```

| 环境变量                    | 默认                                                             | 含义                                                         |
| --------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------ |
| §PORT§                      | §4317§                                                           | 只监听 §127.0.0.1§                                           |
| §PLATFORM_ROOT§             | 从当前目录向上找到带 §.agents/platform/state-machine.yml§ 的目录 | 仓库根；声明、账本、索引都以它为根                           |
| §PLATFORM_DIST§             | 空（用内嵌）                                                     | 开发态指向真实 dist 目录，覆盖内嵌页                         |
| §GH_TOKEN§ / §GITHUB_TOKEN§ | 空                                                               | 只读同步用的 token；都没有 → 同步回 §E_NO_TOKEN§，不假装成功 |
| §PLATFORM_REPO§             | 从 §git remote get-url origin§ 解析                              | 同步/投递的目标仓库 §owner/repo§                             |
| §PLATFORM_WRITE§            | 空（关闭）                                                       | §1§/§true§ 才允许真的向远端写 label                          |
| §PLATFORM_CACHE§            | §.agents/platform/cache/remote.json§                             | 远端快照缓存路径                                             |
| §PLATFORM_INDEX§            | §.agents/platform/index.db§                                      | 派生索引路径                                                 |
| §PLATFORM_OUTBOX§           | §.agents/platform/outbox.jsonl§                                  | 在途台账路径                                                 |
| §PLATFORM_OUTBOX_DEADLINE§  | §10m§                                                            | 在途超时判 §stalled§ 的时限（Go duration）                   |

## 单二进制

```bash
npm run check:web        # 构建前端 + 把 dist 复制进 apps/api-go/dist
cd apps/api-go && go build -o /tmp/platform-api .
cd /tmp && /tmp/platform-api   # 磁盘上没有 dist 也能出页面
```

- §apps/api-go/dist§ 只保留 §.gitkeep§ 与说明文件：没有前端产物时 §go build§ 不失败，页面回 404
- 页面来源判定顺序：§PLATFORM_DIST§（开发态）→ 内嵌 §embed.FS§（默认）

## 验证

```bash
cd ../.. && npm run check   # 链尾的 check:go = gofmt 干净 + go vet + go test
```

## 接口契约

响应 §content-type§ 恒为 §application/json; charset=utf-8§（静态页除外）。

### §GET /api/board§ → 200

```json
{
  "items": ["<ledger fold 的投影，字段原样透传>"],
  "config": {
    "defaultFlow": "auto",
    "labelPrefix": "state:",
    "states": [
      { "name": "accepted", "terminal": false, "meaning": "受理，等认领" }
    ],
    "transitions": ["<state-machine.yml 的 transitions 原样透传>"]
  }
}
```

每个 item 在折叠投影之上多四个字段：

| 字段          | 含义                                                                          |
| ------------- | ----------------------------------------------------------------------------- |
| §current§     | 远端 issue 当前 §state:*§ label 的值；没有快照或该 issue 无 label → §null§    |
| §ledgerState§ | 账本折叠出的状态（= 原来的 §state§，保留旧名不破坏调用方）                    |
| §divergence§  | §current§ 与 §ledgerState§ 都存在且不相等；label 有多个 §state:*§（歧义）也算 |
| §pending§     | 该 item 未结案的在途投递（见「在途台账」），没有则 §null§                     |

### §POST /api/sync§ → 200

```json
{ "status": "changed|notModified", "repo": "owner/repo", "fetchedAt": "<ISO>", "etag": ""…"", "issues": 12,
  "reconciled": { "applied": 0, "conflict": 0, "pending": 1 } }
```

- 请求侧只带 §If-None-Match§（缓存 ETag），**不带 §since§**：URL 里有 since 时 ETag 会随 URL 变，304 永不命中；§304§ 时**一个字节都不写盘**，只对账
- 分页跟 §Link: rel="next"§ 逐页取完再合并（上限 50 页，超限报 §E_REMOTE_PAGING§，绝不静默截断）；缓存永远是**整份快照**，任何一页失败都不写盘
- 缺 token → 500 §{"kind":"infra","code":"E_NO_TOKEN"}§，且不发请求
- 网络错误 / §401§ §E_REMOTE_UNAUTHORIZED§ / §403§·§429§ §E_REMOTE_RATE_LIMIT§ / 其他 §E_REMOTE_STATUS§ → 500 §infra§，**旧缓存原样保留**（旧缓存 + 明确 §fetchedAt§ 比清空更诚实）

### §GET /api/remote§ → 200

```json
{ "present": true, "etag": ""…"", "fetchedAt": "<ISO>", "repo": "owner/repo", "issues": [ { "number": 1, "title": "…", "state": "open", "labels": ["state:accepted"], "updatedAt": "<ISO>" } ] }
```

§present§ 为 §false§ 表示「还没同步过」，不是「远端没有 issue」。

### §GET /api/outbox§ → 200

```json
{
  "entries": [
    {
      "attemptId": "att-…",
      "item": "REQ-1",
      "from": "accepted",
      "to": "rejected",
      "by": "owner",
      "label": "state:rejected",
      "target": { "repo": "owner/repo", "issue": 1 },
      "requestedAt": "<ISO>",
      "attempts": 1,
      "status": "pending|applied|failed|stalled|conflict"
    }
  ],
  "nextCheckAt": "<ISO>|null",
  "deadline": "10m0s",
  "writeEnabled": false
}
```

§nextCheckAt§ 只在有未结在途时给出；在途为空 → §null§，也就意味着**零请求**。

### §POST /api/outbox/retry§ · body §{"attemptId": "att-…"}§ → 200 §{"retried": ["att-…"]}§

只对 §stalled§/§failed§ 生效；重试**复用同一个 §attemptId§**，台账只多一行发起，不新增 pending。§conflict§ 不自动重试。

### §POST /api/index/rebuild§ → 200

```json
{
  "ok": true,
  "schemaVersion": "1",
  "path": ".agents/platform/index.db",
  "items": 1,
  "events": 2,
  "remoteIssues": 0,
  "outbox": 0
}
```

### §GET /api/kb§ → 200

```json
{
  "items": [
    {
      "path": ".agents/notes/implemented/p19-kb.md",
      "title": "P-19 知识库本体",
      "sha256": "<64 hex>",
      "bytes": 1234,
      "group": "notes"
    }
  ],
  "count": 1,
  "builtAt": "<ISO8601>"
}
```

- §group§ 只有四个值：§notes§（§.agents/notes/implemented/<单层>.md§）、§module§（任意层级的 §README.md§）、§docs§（§docs/architecture.md§、§docs/permissions.md§、§docs/audit-contract.md§）、§postmortem§（§docs/postmortem/<单层>.md§）
- 排序固定：先按 §notes → module → docs → postmortem§ 的组序，组内按 §path§ 字典序；前端不必再排
- §title§：文件第一行（跳过开头的空行）以 §"# "§ 开头就去掉 §#§ 与空白；没有标题则用文件名去扩展名
- §sha256§ 是**工作区文件字节**的摘要，不是 §apps/engine/kbexport.go§ 那份 CI 清单用的 git blob 字节（§git cat-file blob <ref>:<path>§，见该文件的 §KbSha256Hex§）；§bytes§ 是同一份字节的长度
- §builtAt§ 只在索引重建时变：现盘没变它就稳定，可用来判断「这份目录是不是新的」
- 一次请求就把全部白名单文件读一遍并复算 §sha256§：索引是缓存，不是真相源；对几十个小文件，这比「按 mtime 猜」更不可能漏掉漂移

### §GET /api/kb/item?path=<仓库相对路径>§ → 200

```json
{
  "path": "docs/architecture.md",
  "sha256": "<64 hex>",
  "bytes": 4893,
  "text": "<原文>"
}
```

- §text§ 是磁盘上的原文字节按 UTF-8 转成的字符串，不做任何改写
- 路径不在白名单、含 §..§、是绝对路径、用反斜杠、或解析软链后跑出仓库根 → §400§；白名单内但文件不存在 / 不是普通文件 → §404§。两种都是 §{"kind":"rejected","code":"E_KB_PATH","message":"…","extra":{}}§，**绝不读到白名单外的文件**
- 单文件上限 §4MB§：超过回 §400 E_KB_PATH§。先看 §stat§ 大小再读，读后又按长度兜一次（文件可能在两次之间长大），避免一个大文件把响应撑爆

### §GET /api/events§ → 200

```json
{ "events": ["<账本原始事件，按写入顺序>"] }
```

### §GET /api/config§ → 200

```json
{ "text": "<state-machine.yml 全文>" }
```

### §PUT /api/config§ · body §{"text": "<新声明>"}§ → 200 §{"ok": true}§

写盘顺序固定：先写 §<config>.tmp§ → 用判定器 §--check-config§ 校验 → 失败删 tmp 并回错误形状 → 成功才 §rename§ 覆盖。任何一步失败，原声明一个字节都不动。

### §POST /api/item§ · body §{"title","body"}§ → 200 <新事件对象>

标题（trim 后）为空 → 409 §E_TITLE_REQUIRED§。落到哪个状态、由谁触发，取自声明：引擎的入口解析给出 §{to,by}§，再交给判定器确认；Go 不做 flow 分支。

### §POST /api/verdict§ · body §{"id","to","actor_role","comment","guards"}§ → 200 <新事件对象>

§guards§ 可选：守卫名 → 证据字符串，原样交给判定器（§{"merge-gate":"merge-gate PASS 4/4"}§）。

- 账本里没有该 §id§ → 409 §E_ITEM_MISSING§
- 判定器拒绝 → 409，§code/message/extra§ 原样透传（例如 §E_NO_TRANSITION§、§E_COMMENT_REQUIRED§、§E_TERMINAL_STATE§、§E_GUARD_MISSING§）
- 判定器判 infra（例如未知状态、未知角色）→ 500，同样原样透传
- §guards§ 形状不是「对象 + 每值字符串」（数组、数字、嵌套对象、某个值是 §null§）→ 500 §E_GUARD_SHAPE§，§extra§ 为 §{}§；不静默忽略、不强转、不落账本。整个 §guards§ 字段显式给 §null§ 与「没给」等价（与判定器的 §?? null§ 语义一致），不是形状错
- 判定被拒时账本一行不加；allowed 时事件带上判定器采纳的 §guards§（§omitempty§：没有证据的事件不多出这个字段）

### §POST /api/verify§ → 200 §{"exitCode": <int|null>, "output": <末尾 8000 字符>}§

真跑 §npm run check§（180s 上限）。§exitCode§ 只有进程真给出退出码时才是一个数；超时/被杀是 §null§ —— 不伪造 0。npm 起不来 → 500 §E_CHECK_SPAWN§。

### 错误形状

```json
{
  "kind": "rejected",
  "code": "E_NO_TRANSITION",
  "message": "没有从 accepted 到 done 的转换",
  "extra": {}
}
```

| kind       | HTTP | 何时                                         |
| ---------- | ---- | -------------------------------------------- |
| §rejected§ | 409  | 业务拒绝（判定器拒绝、标题为空、找不到需求） |
| §infra§    | 500  | 基础设施（配置坏、引擎读不到、请求体坏）     |
| ——         | 404  | 没有这个路由，§code: E_NO_ROUTE§             |

请求体解析失败 → 500 §E_BODY_UNPARSABLE§（与原型一致）；请求体超过 1MB → 500 §E_BODY_TOO_LARGE§。

## 引擎契约（§apps/engine§，进程内调用）

判定与账本只有一份实现：§apps/engine§。本服务 §import§ 它，不起子进程、不读 §scripts/§ 下的任何 JS 文件；同一份库另有单二进制命令行（`engine validate|check-config|consult|ledger`）给人和其他脚本用，契约同源。

### 判定器

```go
cfg, fail := engine.LoadConfigAt(root, configRel) // 绝对路径用 engine.LoadConfig(path)
res, fail := cfg.ValidateIntent(intent)           // 完整判定（含 guards）
res, fail := cfg.ResolveTransition(intent)        // 只读咨询：不评估 guards
res, fail := cfg.ResolveEntry(nil)                // 入口落点 {to,by}
```

- §intent§ 是 §*engine.Value§：§{"labels": [], "to": "<状态>", "actor_role": "<角色>", "comment": "<可选>", "guards": {"<守卫名>": "<证据>"}}§
- 成功时 §res§ 的键序固定：§from/to/by/flow/event§；转换声明了 §guards§ 时还含 §guards§（采纳的证据），未声明时不出现该键
- 失败统一是 §*engine.Fail§：§Kind§（§rejected§/§infra§）、§Code§、§Message§、§Extra§，本服务原样搬成错误响应；§ExitCode()§ 与命令行一致（§0§ allowed · §1§ rejected · §3§ infra）
- 转换声明了 §guards§ 而证据缺失 → §rejected§ §E_GUARD_MISSING§；§guards§ 形状错 → §infra§ §E_GUARD_SHAPE§
- 「声明自洽」就是 §LoadConfig/ParseConfig§ 成功（等同原 §--check-config§ 的全部检查）

### 账本/声明适配器

```go
events, fail := engine.ReadEvents(path)  // 逐行事件（原始顺序）
items := engine.Fold(events)             // board.items 的折叠结果
id := engine.NextID(events)              // "REQ-4"
fail = engine.AppendEvent(path, event)   // 追加一行并回显落盘后的事件
view := cfg.View()                       // board.config 的形状
```

出错时 §*engine.Fail§ 照样带 §kind/code/message/extra§，本服务原样搬运成错误响应。
§config§ 是契约之外新增的一条：字段与文案由引擎产出，本服务只做透传与反序列化，不自己解析声明。

## 静态页托管

- 页面来自 §fs.FS§：默认内嵌，§PLATFORM_DIST§ 覆盖（开发态），见「单二进制」
- §GET /§ 与未知非 §/api§ 路径回 §index.html§（SPA 回退），命中真实文件时按扩展名给 content-type
- 该 FS 里没有 §index.html§（前端还没构建）：§/api§ 之外一律 404 §E_NO_ROUTE§
- 不读老的 §web/§：两套静态页会让契约分裂

## 在途台账（§.agents/platform/outbox.jsonl§）

一次本地状态变更要变成远端 issue 的一个 §state:*§ label，而写请求可能失败、超时、被限流。在途台账就是这条外发的本地账：**不能反复轮询等它，也不能假装成功**。

```json
{"attemptId":"att-8f…","item":"REQ-1","from":"accepted","to":"rejected","by":"owner","label":"state:rejected","target":{"repo":"owner/repo","issue":1},"requestedAt":"2024-01-01T00:00:00.000Z"}
{"attemptId":"att-8f…","outcome":"applied","at":"2024-01-01T00:06:00.000Z","observed":{"labels":["state:rejected"]}}
```

- §attemptId§ = §(item, from, to, requestedAt)§ 的确定性哈希：同一变更永远同一个 id，重试复用而不是新增
- 按 §attemptId§ 折叠：后到的结果覆盖先到的发起，得到 §pending / applied / failed / stalled / conflict§
- §applied§ 只由「同步后亲眼看到目标 label」得出，不由写请求的成功吐出；超时未生效是 §stalled§，**不是 success**
- 远端 label 变成别的值（且不是本次起点）→ §conflict§，不自动重试，交给人
- 对账在每次同步后跑：拿每条未结在途的 §target§ 与远端当前 labels 比
- §reconciled§ 只数**本次调用自己判定的**条数：巡检协程可能已经先对过同一条（它的报告被丢弃），此时接口回 §applied: 0§ 而在途台账里已有 §applied§ 记录 —— 判「有没有生效」看台账，不要看这一次响应
- 巡检只在**在途非空**时排期，指数退避 5s→5min 封顶；调度决策是纯函数（在途集合 + 现在 → 下次时间或 §nil§），协程里没有写死的 sleep
- 已过期的条目从**现在**重新计时一个退避间隔，不返回「立刻」：把过期当成「立刻」会让巡检协程零等待空转（实测两个核心跑满）
- 为什么单独一个文件：进 §ledger.jsonl§ 会污染折叠（折叠器按每行的 §event.to§ 投影状态），只放 §index.db§ 又与「索引纯派生」矛盾 —— 在途是唯一无法从真源重建的本地事实

## 知识库本体（§/api/kb§ + §.agents/platform/kb.db§）

知识库要「汇什么」由 §docs/knowledge-base.md§ 定义；这里只负责把同一批文件做成可查询的派生索引。**白名单两处同口径，改一处必须改另一处：§apps/api-go/kb.go§ 的 §kbAllowRules§ / §kbDenyDirs§ / §kbDenyNames§ 与 §apps/engine/kbexport.go§ 的 §kbAllowed§ / §kbDenyDirs§ / §kbDenyNames§。** 两份实现写法不同（前者反引号原始串、后者双引号串），规则集必须一致；逐字比对由 §tests/kb-allowlist-parity.test.mjs§ 读两份源码做，归一只有三条（剥 §(?i)§ 行内标志、§(?:…)§ 视为 §(…)§、§\/§ 与 §/§ 归一）。

| 命中路径                              | group        |
| ------------------------------------- | ------------ |
| §.agents/notes/implemented/<单层>.md§ | §notes§      |
| 任意层级的 §README.md§                | §module§     |
| §docs/architecture.md§ 等三份契约文档 | §docs§       |
| §docs/postmortem/<单层>.md§           | §postmortem§ |

- 判定顺序与导出器一致：**先 deny 再 allow**。deny 目录 §node_modules/dist/build/coverage/.next/out/tmp/vendor§，deny 名字 `.env*`、后缀型 `*.pem` / `*.key` / `*.p12` 等，以及含 `secret` / `credential` / `api_key` / `token` 的词，共十条，与导出器的 `DENY_NAMES` 逐条对应
- 扫描额外跳过 §.git§ 与 §.cache§：前者不是汇入内容，后者是本机的 Go 构建缓存（上万个文件）
- 索引表 §kb_items(path, title, sha256, bytes, grp)§ + §meta(schema_version, built_at)§；重建在**一个事务**里 §DROP§ 后重写，半途失败不会留下半份结构
- 重建触发只有三条：索引文件不存在、§schema_version§ 不符、现盘扫描结果与索引记录的集合或 §sha256/bytes§ 有任一不符（增、删、改都算）。命中任一条就**整份重建**，不做增量
- 索引**不是真相源**：每次列表请求先扫白名单现盘并复算 §sha256§，再拿它跟索引比 —— 真相永远是 git 里的文件，删掉 §kb.db§ 只是让下一次请求多干一次重建
- 两处同口径由测试钉住，不靠自觉：§tests/kb-allowlist-parity.test.mjs§ 读这两份源码，比对 §ALLOWED/DENY_DIRS/DENY_NAMES§ 与 §kbAllowRules/kbDenyDirs/kbDenyNames§ 是同一集合，再用一张判定表断言两边对同一路径给出同样结论 —— **只改一处就会红**；§kb_test.go§ 的 §TestKBWhitelistParityTable§ 另行钉住 Go 侧自己的容许/拒绝语义

## 依赖与许可证

| 依赖                              | 版本                   | 许可证       | 为什么                                                                                                   |
| --------------------------------- | ---------------------- | ------------ | -------------------------------------------------------------------------------------------------------- |
| §modernc.org/sqlite§              | §v1.34.5§              | BSD-3-Clause | 纯 Go SQLite（无 cgo，跨平台交叉编译不需要 C 工具链）；索引是 SQL 查询面，手写文件格式会自己造一个数据库 |
| §ai-native-framework/apps/engine§ | §replace => ../engine§ | 本仓         | 判定器与账本的唯一实现（进程内调用）；它带进来的第三方依赖只有 §gopkg.in/yaml.v3§（MIT）                 |

传递依赖（§go.sum§ 全部已提交，CI 里 §go build§/§go test§ 按需下载）：§modernc.org/libc§、§modernc.org/mathutil§、§modernc.org/memory§、§github.com/remyoudompheng/bigfft§、§golang.org/x/sys§（BSD-3-Clause）；§github.com/dustin/go-humanize§、§github.com/mattn/go-isatty§、§github.com/ncruces/go-strftime§、§github.com/google/uuid§（MIT / BSD-3-Clause）。

成本（macOS arm64 实测）：带内嵌前端的二进制 16MB，前端未构建（§dist§ 只有占位）时 15MB；SQLite 与内嵌页各占一部分，没有单独拆开测。首次构建要下载模块；不引 cgo，所以 §CGO_ENABLED=0§ 仍可交叉编译。

## 已知取舍

1. 每次读账本/读声明都重新读一遍文件（进程内 Go 库调用，没有缓存）—— 本机单用户，先求正确与单一真源，再谈性能。
2. 空标题、缺 id 先判：坏账本 + 空标题时原型回 500，这里回 409。
3. 字段类型比原型严：§title/body/comment/text§ 只认字符串，非字符串按缺失处理（原型会 §String()§ 强转）。
4. 请求体超 1MB 的 code 用 §E_BODY_TOO_LARGE§（原型落到 §E_UNEXPECTED§）。
5. §verify§ 超时 → §exitCode: null§（与原型 §spawnSync§ 同义），不冒充 0。
6. 已知路径的方法不对时回 404 §E_NO_ROUTE§（与原型查表行为一致），不是 405。
7. **未知角色（§actor_role§ 不在 §ci/platform/owner/proposer/agent§ 内）回 500 §E_INTENT_SHAPE§，不是 409。** 原因：判定器把它归类为 §verdict: infra§（退出码 3），Go 只搬运判定器的 kind，不在本地把 infra 改写成 rejected —— 在 Go 里判「角色合不合法」就是第二份判定。要改成 409，只能改判定器的分类，那是真源那边的决定。
8. **§to§ 指向未定义状态回 500 §E_UNKNOWN_STATE§，不是 409。** 同上：判定器判 §infra§，Go 照搬。
9. §GET /api/board§ 的响应就是 §{"items", "config"}§ 两个键，不多包一层、不改名（前端时间线与列表直接吃这个形状）。
10. §divergence§ 只说「不一致」，不说谁对：issue 的 §state:*§ label 是当前态、账本是历史，哪边该被纠正属人工决定。
11. §stalled§ 是**算出来的**状态（超时未生效），不写进台账文件：台账只记发生过的事实（发起 / 结果），状态是投影 —— 所以改时限不需要迁数据。
12. 在途的记录形状是 append-only JSONL 而不是数据库行：它是唯一无法从真源重建的本地事实，必须能被人直接读、直接改、直接 git diff。
13. 索引重建是「检测陈旧 → 全量重算」，不做增量：真源是几份小文件，增量复杂度换不来时间。
14. 巡检协程的调度是纯函数（在途集合 + 现在 → 下次时间或 §nil§），协程只负责等：在途为空时它不排期，也不发请求。
15. 知识库索引的 §sha256§ 用**工作区文件字节**，导出器用 **git blob 字节**：Go 侧不调 §git§（不联网、不依赖 PATH 里有什么），代价是同一文件的两种摘要不相等 —— 两边都只拿它判「这份文件变没变」，从不互相比对。
16. §GET /api/kb§ 每次请求都全量复扫白名单并复算 §sha256§（当前 30 条），而不是信的 §mtime§ 或索引：这样删掉 §kb.db§、手改一个字节、新增一份笔记都会在下一次响应里体现，代价是每次多读几十个小文件。
17. 路径非法（400）与文件不存在（404）共用同一个 §code§：§E_KB_PATH§。前端只需认这一个 code 做统一提示，区别只在 HTTP 状态与 §message§ 里；分成两个 code 会让前端多一条永远走不到的分支。
18. §title§ 只存在索引里、不在 §GET /api/kb/item§ 的响应里返回：列表已经给了 title，正文接口只管正文，同一个事实不留两处生成。
