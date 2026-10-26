# P-31 判据与门搬进 Go（进行中）

状态：proposed（人已定方向，分四阶段落地；阶段 A 已完成并合入，B / C / D 未做）

## 一、为什么做

`apps/api-go/node.go` 有 7 处 `runNode(...)` 把状态机判定器与账本当成外部命令调用（`app.go:20-21` 的 `validatorCLI` / `ledgerCLI`），`main.go:51` 甚至靠「当前目录里有没有 `scripts/state-validate.mjs`」来定位仓库根。结果是：编译出一个 Go 二进制，但机器上没装 Node 就启动不了。这是本仓唯一真实的依赖冗余。

其余 Node 脚本（审计六件套、`kb-export`）只在 CI 里跑，GitHub runner 自带 Node，仓库只装 1 个运行依赖 `yaml` —— 不构成运行时冗余，且 `tests/audit-findings.test.mjs` 一处就有 11568 行判据，重写等于重新踩坑。

## 二、决定

1. **判据与门搬进 Go**：`state-validate` / `build-intent` / `last-change` / `merge-gate` / `ledger` / `ledger-cli`。
2. **审计与知识库留 Node**：`audit-findings` / `audit-review` / `audit-collect` / `audit-slot` / `routing` / `kb-export` / `cli` / `copy-dist` / `writer-record`（`writer-record` 随阶段 B 一起看）。
3. **家**：`apps/engine/` 是库（module `ai-native-framework/apps/engine`），`apps/engine/cmd/engine` 是单二进制多子命令；`apps/api-go` 用 `require` + `replace => ../engine` 依赖它。判据是框架级资产，不藏在服务端 main 里。
4. **新增依赖上限：`gopkg.in/yaml.v3` 一个**。手写 YAML 解析器是更大的风险；除它以外不得引入任何第三方包。
5. **迁移手法：夹具对照（parity），不是重写判据**。每个阶段先让 Go 实现与现有 JS 实现对同一批 fixture 输出逐字节一致（新增 `tests/engine-parity.test.mjs` 驱动两侧），消费者切到 Go 之后再删 JS，最后把 parity 测试转成 golden 快照。这样做的好处是 17956 行已有判据一行不用重写，Go 侧直接继承它们的严格度。
6. **契约不动**：CLI 的 JSON 字段与值、退出码（0 允许 / 1 拒绝 / 2 用法错 / 3 infra）、错误码 `E_*`、`apps/api-go` 的 HTTP 响应体，一律保持原样。

## 三、阶段

| 阶段 | 内容 | 完成判据 |
| --- | --- | --- |
| A | `apps/engine` 骨架 + 账本 + 判定器（`ledger` 55+104 行、`state-validate` 366 行）；`api-go` 改直接调用库，不再 subprocess | parity 全绿；`go vet`/`go test`/`npm run check` 全绿；`go build ./cmd/engine` 产出单二进制 |
| B | `build-intent`（280 行）+ `last-change`（280 行）+ `writer-record`（72 行） | `state-writer` workflow 改调 Go 二进制；parity 全绿 |
| C | `merge-gate`（523 行） | `merge-gate` workflow 改调 Go；parity 全绿 |
| D | 清场：删已迁移的 `.mjs`、`package.json` 脚本改 Go、`check:state`/`check:go` 合并、workflow 铺 `setup-go`、parity 转 golden、文档与决策记录更新 | 仓库里只剩审计与知识库的 Node 脚本；`grep -r 'state-validate.mjs\|ledger-cli.mjs'` 零命中 |

## 四、不做什么

- 不动审计六件套与 `kb-export`（它们要 `gh`、要发网络、要 `yaml`，且判据测试 11568 行在护着）。
- 不改任何 CLI 契约或退出码。
- 不为「统一语言」而重写 `tests/` 里已有的判据。
- 不引入除 `gopkg.in/yaml.v3` 以外的第三方依赖。

## 五、验收证据口径

每一阶段都要有：parity 对照表（同一 fixture 两侧输出）、至少 3 组变异（改坏 Go 实现看 parity 红）、`npm run check` 真实退出码。空跑不算。

## 六、阶段 A 落地记录（已完成）

**交付物**

- `apps/engine/`（module `ai-native-framework/apps/engine`，go 1.22，唯一三方依赖 `gopkg.in/yaml.v3 v3.0.1`）：`value.go`（保序 JSON 值 + 与 JS 一致的编码与数字格式）、`json_parse.go`（复刻 V8 `JSON.parse` 的 error headline 与 `at position N (line L column C)` 定位）、`yaml.go`、`config.go`、`validate.go`、`ledger.go`、`fail.go`、`cli.go`、`cmd/engine/main.go`、`engine_test.go`、`README.md`。
- `tests/engine-parity.test.mjs`（46 例）：真双跑——`spawnSync` 同时跑 JS 与 `go build -o <tmp>/engine ./cmd/engine`，比 stdout / stderr / 退出码。consult 的 JS 侧是测试内临时探针（动态 import `consultTransition`）。
- `apps/api-go`：`node.go` 从「起子进程」改写成引擎适配；删掉 `validatorCLI`/`ledgerCLI`；`main.go` 的根定位从「找 `scripts/state-validate.mjs`」改成「向上找 `.agents/platform/state-machine.yml`」；`go.mod` 加 `require` + `replace => ../engine`。
- `check:engine`（package.json）：`cd apps/engine && gofmt -l . 为空 && go vet ./... && go test ./...`，GOPATH/GOCACHE 与 `check:go` 同口径（仓库根 `.cache`），插在 check 链里紧邻 `check:go`。

**判据口径**：parity 只钉「两侧输出一致」，不重写任何一条判据——45 条 fixture 逐字节相同。唯一例外是「非法 YAML」：js-yaml 与 yaml.v3 的解析器消息无法逐字复刻，只钉前缀 + code + 退出码，这一条例外写在测试里而不是让判据松掉。

**运行时方言**：`JSON.parse` 的报错文本跨 Node 版本不同——Node 20 是 `… at position 1`，Node 22+ 追加 `(line 1 column 2)`。本机 Node 24 与实现同代，所以本地全绿、CI（Node 20）红。修法：比对前把坐标后缀从两侧摘掉（位置数字仍比），并单独断言 Go 侧一律带坐标；理由写在 `tests/engine-parity.test.mjs` 的 `POSITION_SUFFIX` 旁。教训：parity 的对手是「另一份实现 + 另一个运行时」，本地绿只证明第一半。

**变异验证**（改坏 Go 实现看 parity / 单测变红）：`validate.go` 消息里的「的转换」→「的迁移」5 红；`fail.go` 的 ExitCode 默认值 3→0 共 14 红；`ledger.go` 的 `"REQ-"`→`"REQ"` 1 红；`cli.go` 的 `asJSON` 恒 false 26 红；`engine_test.go:166` 断言 `REQ-4`→`REQ-3` → `check:engine` 退出码 1（`--- FAIL: TestFoldAndNextID`）。

**两处要记住的教训**

1. 单守卫 fixture 覆盖不到「多个守卫拼接」：把守卫分隔符从「、」改成「 / 」原本没人红，补了一条双守卫 fixture 才咬住。
2. 变异探针本身会坏，这一轮的坏法是**锚点先命中注释**：改的是 `// 所以 3 条事件后的下一个是 REQ-4` 那行而不是断言行，看起来「改坏了却全绿」。固定动作不变：改完先打印改后那一行，确认是承重那一行。

## 七、阶段 A 遗留（进 B/C/D 时一起收）

- `scripts/state-validate.mjs` 与 `scripts/ledger-cli.mjs` 仍在，CI 与 parity 还在用（阶段 D 删）。
- `merge-gate.mjs` 仍 import 这两个 JS 实现（阶段 C 解决）。
- `npm run check` 现在同时跑 `check:go` 与 `check:engine`，两个模块各自的 gofmt/vet/test（阶段 D 可合并）。

