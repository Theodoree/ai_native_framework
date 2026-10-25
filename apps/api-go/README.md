# apps/api-go · 平台后端（Go 标准库）

**状态**：active —— 本轮在 §feat/p15-platform§ 内实现；§scripts/server.mjs§ 仍是旧原型，替换是下一步。

## 做什么

- 用 Go 标准库 §net/http§ 复刻 §scripts/server.mjs§ 的 JSON API（行为等价，不照抄实现）
- 多一条事件时间线：§GET /api/events§
- 单二进制：构建期把 §apps/web-vue/dist§ 复制进 §apps/api-go/dist§，用 §//go:embed all:dist§ 内嵌；运行期不依赖磁盘 dist
- 远端同步：§POST /api/sync§ 只读拉 issue 列表（number/title/state/labels/updated_at），条件请求只靠 §If-None-Match§ + ETag，304 一个字节都不写盘
- 派生索引：§.agents/platform/index.db§（SQLite）存折叠结果、事件时间线、远端快照、在途记录，纯派生、删了自愈
- 在途台账：§.agents/platform/outbox.jsonl§ 记「本地改了状态、还没确认远端生效」的外发，只有它能回答「这条是不是还在路上」
- 判定与账本全部经两个 Node 入口（见「Node 入口契约」）

## 不做什么

- 不判断状态机：§from/to/flow/labels§ 合法性、入口落点、声明的结构校验，全部只由 §scripts/state-validate.mjs§ 回答
- 不解析 §state-machine.yml§：在 Go 里复制转换表校验，等于给真源开第二份实现
- 不自己读写账本结构：事件对象原样交给 §scripts/ledger-cli.mjs§
- 不做鉴权（本机单用户）
- 不替 label 与账本选边：两者不一致时只标 §divergence: true§ 并同时给出两边，不猜哪个对
- 默认不写远端：§PLATFORM_WRITE§ 不是 §1§ 时，发起变更只记在途、不联网；没有 token 时也不联网写
- 不把在途写进 §ledger.jsonl§：折叠器对每行按 §event.to§ 投影状态，非状态事件进去会污染折叠结果

## 运行

```bash
cd apps/api-go
PLATFORM_ROOT=$(git rev-parse --show-toplevel) PORT=4317 go run .
```

| 环境变量                    | 默认                                                     | 含义                                                         |
| --------------------------- | -------------------------------------------------------- | ------------------------------------------------------------ |
| §PORT§                      | §4317§                                                   | 只监听 §127.0.0.1§                                           |
| §PLATFORM_ROOT§             | 从当前目录向上找到带 §scripts/state-validate.mjs§ 的目录 | 仓库根；两个 Node 入口与账本都以它为工作目录                 |
| §PLATFORM_DIST§             | 空（用内嵌）                                             | 开发态指向真实 dist 目录，覆盖内嵌页                         |
| §GH_TOKEN§ / §GITHUB_TOKEN§ | 空                                                       | 只读同步用的 token；都没有 → 同步回 §E_NO_TOKEN§，不假装成功 |
| §PLATFORM_REPO§             | 从 §git remote get-url origin§ 解析                      | 同步/投递的目标仓库 §owner/repo§                             |
| §PLATFORM_WRITE§            | 空（关闭）                                               | §1§/§true§ 才允许真的向远端写 label                          |
| §PLATFORM_CACHE§            | §.agents/platform/cache/remote.json§                     | 远端快照缓存路径                                             |
| §PLATFORM_INDEX§            | §.agents/platform/index.db§                              | 派生索引路径                                                 |
| §PLATFORM_OUTBOX§           | §.agents/platform/outbox.jsonl§                          | 在途台账路径                                                 |
| §PLATFORM_OUTBOX_DEADLINE§  | §10m§                                                    | 在途超时判 §stalled§ 的时限（Go duration）                   |

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

标题（trim 后）为空 → 409 §E_TITLE_REQUIRED§。落到哪个状态、由谁触发，取自声明：§ledger-cli entry§ 给出 §{to,by}§，再交给判定器确认；Go 不做 flow 分支。

### §POST /api/verdict§ · body §{"id","to","actor_role","comment"}§ → 200 <新事件对象>

- 账本里没有该 §id§ → 409 §E_ITEM_MISSING§
- 判定器拒绝 → 409，§code/message/extra§ 原样透传（例如 §E_NO_TRANSITION§、§E_COMMENT_REQUIRED§、§E_TERMINAL_STATE§）
- 判定器判 infra（例如未知状态、未知角色）→ 500，同样原样透传

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
| §infra§    | 500  | 基础设施（配置坏、node 起不来、请求体坏）    |
| ——         | 404  | 没有这个路由，§code: E_NO_ROUTE§             |

请求体解析失败 → 500 §E_BODY_UNPARSABLE§（与原型一致）；请求体超过 1MB → 500 §E_BODY_TOO_LARGE§。

## Node 入口契约（Go 侧唯一能调的两个）

工作目录固定为仓库根；所有命令输出机器可读 JSON。

### 判定器 §scripts/state-validate.mjs§

```bash
node scripts/state-validate.mjs --json --intent -      # 意图 JSON 从 stdin 进
node scripts/state-validate.mjs --json --check-config --config <path>
```

- stdin：一个意图对象 §{"labels": [], "to": "<状态>", "actor_role": "<角色>", "comment": "<可选>"}§
- stdout：一行 §{"verdict":"allowed|rejected|infra","code","message", ...extra}§
  - §allowed§ 的 extra 含 §from/to/by/flow/event§
  - §rejected/infra§ 的 extra 含判定器给出的细节
- 退出码：§0§ allowed · §1§ rejected · §3§ infra

### 账本/声明适配器 §scripts/ledger-cli.mjs§

```bash
node scripts/ledger-cli.mjs fold     --json   # stdout: JSON 数组（items）
node scripts/ledger-cli.mjs events   --json   # stdout: JSON 数组（原始事件）
node scripts/ledger-cli.mjs next-id  --json   # stdout: {"id":"REQ-4"}
node scripts/ledger-cli.mjs append   --json   # stdin: 一个事件对象 → stdout: 落盘后的事件
node scripts/ledger-cli.mjs entry    --json   # stdout: {"to","by"}（来自 resolveEntry）
node scripts/ledger-cli.mjs config   --json   # stdout: 本文件 §board.config§ 的形状
```

出错时 stderr 一行 §{"kind","code","message","extra"}§ 且退出非 0，Go 侧原样搬运成错误响应。
§config§ 是契约之外新增的一条：§board.config§ 只能由 §loadConfig§ 产生，Go 解析 YAML 等于复制真源。

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
- 巡检只在**在途非空**时排期，指数退避 5s→5min 封顶；调度决策是纯函数（在途集合 + 现在 → 下次时间或 §nil§），协程里没有写死的 sleep
- 为什么单独一个文件：进 §ledger.jsonl§ 会污染折叠（折叠器按每行的 §event.to§ 投影状态），只放 §index.db§ 又与「索引纯派生」矛盾 —— 在途是唯一无法从真源重建的本地事实

## 依赖与许可证

| 依赖                 | 版本      | 许可证       | 为什么                                                                                                   |
| -------------------- | --------- | ------------ | -------------------------------------------------------------------------------------------------------- |
| §modernc.org/sqlite§ | §v1.34.5§ | BSD-3-Clause | 纯 Go SQLite（无 cgo，跨平台交叉编译不需要 C 工具链）；索引是 SQL 查询面，手写文件格式会自己造一个数据库 |

传递依赖（§go.sum§ 全部已提交，CI 里 §go build§/§go test§ 按需下载）：§modernc.org/libc§、§modernc.org/mathutil§、§modernc.org/memory§、§github.com/remyoudompheng/bigfft§、§golang.org/x/sys§（BSD-3-Clause）；§github.com/dustin/go-humanize§、§github.com/mattn/go-isatty§、§github.com/ncruces/go-strftime§、§github.com/google/uuid§（MIT / BSD-3-Clause）。

成本（macOS arm64 实测）：带内嵌前端的二进制 16MB，前端未构建（§dist§ 只有占位）时 15MB；SQLite 与内嵌页各占一部分，没有单独拆开测。首次构建要下载模块；不引 cgo，所以 §CGO_ENABLED=0§ 仍可交叉编译。

## 已知取舍

1. 每次读账本/读声明都新起一个 node 进程 —— 本机单用户，先求正确与单一真源，再谈性能。
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
