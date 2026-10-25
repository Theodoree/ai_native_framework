# apps/api-go · 平台后端（Go 标准库）

**状态**：active —— 本轮在 §feat/p15-platform§ 内实现；§scripts/server.mjs§ 仍是旧原型，替换是下一步。

## 做什么

- 用 Go 标准库 §net/http§ 复刻 §scripts/server.mjs§ 的 JSON API（行为等价，不照抄实现）
- 多一条事件时间线：§GET /api/events§
- §apps/web-vue/dist§ 存在时托管 SPA 静态页
- 判定与账本全部经两个 Node 入口（见「Node 入口契约」）

## 不做什么

- 不判断状态机：§from/to/flow/labels§ 合法性、入口落点、声明的结构校验，全部只由 §scripts/state-validate.mjs§ 回答
- 不解析 §state-machine.yml§：在 Go 里复制转换表校验，等于给真源开第二份实现
- 不自己读写账本结构：事件对象原样交给 §scripts/ledger-cli.mjs§
- 不做鉴权（本机单用户）

## 运行

~~~bash
cd apps/api-go
PLATFORM_ROOT=$(git rev-parse --show-toplevel) PORT=4317 go run .
~~~

| 环境变量 | 默认 | 含义 |
| --- | --- | --- |
| §PORT§ | §4317§ | 只监听 §127.0.0.1§ |
| §PLATFORM_ROOT§ | 从当前目录向上找到带 §scripts/state-validate.mjs§ 的目录 | 仓库根；两个 Node 入口与账本都以它为工作目录 |

## 验证

~~~bash
cd ../.. && npm run check   # 链尾的 check:go = gofmt 干净 + go vet + go test
~~~

## 接口契约

响应 §content-type§ 恒为 §application/json; charset=utf-8§（静态页除外）。

### §GET /api/board§ → 200

~~~json
{
  "items": [ "<ledger fold 的投影，字段原样透传>" ],
  "config": {
    "defaultFlow": "auto",
    "labelPrefix": "state:",
    "states": [{ "name": "accepted", "terminal": false, "meaning": "受理，等认领" }],
    "transitions": [ "<state-machine.yml 的 transitions 原样透传>" ]
  }
}
~~~

### §GET /api/events§ → 200

~~~json
{ "events": [ "<账本原始事件，按写入顺序>" ] }
~~~

### §GET /api/config§ → 200

~~~json
{ "text": "<state-machine.yml 全文>" }
~~~

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

~~~json
{ "kind": "rejected", "code": "E_NO_TRANSITION", "message": "没有从 accepted 到 done 的转换", "extra": {} }
~~~

| kind | HTTP | 何时 |
| --- | --- | --- |
| §rejected§ | 409 | 业务拒绝（判定器拒绝、标题为空、找不到需求） |
| §infra§ | 500 | 基础设施（配置坏、node 起不来、请求体坏） |
| —— | 404 | 没有这个路由，§code: E_NO_ROUTE§ |

请求体解析失败 → 500 §E_BODY_UNPARSABLE§（与原型一致）；请求体超过 1MB → 500 §E_BODY_TOO_LARGE§。

## Node 入口契约（Go 侧唯一能调的两个）

工作目录固定为仓库根；所有命令输出机器可读 JSON。

### 判定器 §scripts/state-validate.mjs§

~~~bash
node scripts/state-validate.mjs --json --intent -      # 意图 JSON 从 stdin 进
node scripts/state-validate.mjs --json --check-config --config <path>
~~~

- stdin：一个意图对象 §{"labels": [], "to": "<状态>", "actor_role": "<角色>", "comment": "<可选>"}§
- stdout：一行 §{"verdict":"allowed|rejected|infra","code","message", ...extra}§
  - §allowed§ 的 extra 含 §from/to/by/flow/event§
  - §rejected/infra§ 的 extra 含判定器给出的细节
- 退出码：§0§ allowed · §1§ rejected · §3§ infra

### 账本/声明适配器 §scripts/ledger-cli.mjs§

~~~bash
node scripts/ledger-cli.mjs fold     --json   # stdout: JSON 数组（items）
node scripts/ledger-cli.mjs events   --json   # stdout: JSON 数组（原始事件）
node scripts/ledger-cli.mjs next-id  --json   # stdout: {"id":"REQ-4"}
node scripts/ledger-cli.mjs append   --json   # stdin: 一个事件对象 → stdout: 落盘后的事件
node scripts/ledger-cli.mjs entry    --json   # stdout: {"to","by"}（来自 resolveEntry）
node scripts/ledger-cli.mjs config   --json   # stdout: 本文件 §board.config§ 的形状
~~~

出错时 stderr 一行 §{"kind","code","message","extra"}§ 且退出非 0，Go 侧原样搬运成错误响应。
§config§ 是契约之外新增的一条：§board.config§ 只能由 §loadConfig§ 产生，Go 解析 YAML 等于复制真源。

## 静态页托管

- §apps/web-vue/dist§ 存在：§GET /§ 与未知非 §/api§ 路径回 §index.html§（SPA 回退），命中真实文件时按扩展名给 content-type
- 不存在：§/api§ 之外一律 404 §E_NO_ROUTE§
- 不读老的 §web/§：两套静态页会让契约分裂

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
