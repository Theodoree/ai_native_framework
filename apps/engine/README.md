# apps/engine · 状态机判定器 + 账本（Go）

**状态**：active —— 自 P-31 阶段 A 起是判定器与账本的唯一实现。Go 后端 §apps/api-go§ §import§ 本库在进程内调用；同口径命令行供脚本、CI 与人使用。

## 做什么

- **判定**：读 §.agents/platform/state-machine.yml§，判定一条意图（§labels/to/actor_role/comment/guards§）允不允许、落到哪条转换
- **咨询**：只读地算「从当前态到目标态会命中哪条转换」，不评估守卫、不写账本
- **声明自检**：解析一遍声明，任何形状/引用错误都点名（§E_CONFIG_*§）
- **账本**：§fold§ / §events§ / §next-id§ / §append§ / §entry§ / §config§ 六个操作，读写 §.agents/platform/ledger.jsonl§
- **命令行**：单二进制多子命令（见下），退出码 §0§ allowed · §1§ rejected · §3§ infra（用法错误 §2§）

## 不做什么

- 不做 HTTP：路由与响应形状在 §apps/api-go§
- 不读 §scripts/§ 下的任何 JS：本库是唯一实现，不是包装器；阶段 D 才删那两份 .mjs
- 不缓存：每次调用重新读声明/账本，真相永远是磁盘上的文件
- 不引入依赖：除 §gopkg.in/yaml.v3§（读 YAML）外只用标准库
- 不改写文案：错误消息与 JSON 键序逐字节对齐既有 JS 实现（§tests/engine-parity.test.mjs§ 钉住）

## 库接口

```go
cfg, fail := engine.LoadConfigAt(root, ".agents/platform/state-machine.yml") // 绝对路径用 engine.LoadConfig
cfg, fail = engine.ParseConfig(raw []byte)                                  // 已在内存里的声明

res, fail := cfg.ValidateIntent(intent *engine.Value) // 完整判定（含 guards fail-closed）
res, fail = cfg.ResolveTransition(intent)             // 只读咨询：不评估 guards
res, fail = cfg.ResolveEntry(flow *engine.Value)       // 入口转换（none → ? 唯一命中）
view := cfg.View()                                     // board.config 的形状

events, fail := engine.ReadEvents(path)
items := engine.Fold(events)
id := engine.NextID(events)
fail = engine.AppendEvent(path, event)
```

- §*engine.Value§ 是保序 JSON 值（对象键序即输出键序，§undefined§ 与 JS 同语义地消失）：§ParseJSON§ / §ParseYAML§ / §Encode§
- 失败统一是 §*engine.Fail§：§Kind§（§rejected§ / §infra§）、§Code§、§Message§、§Extra§；§ExitCode()§ 给出对应退出码
- 成功时判定结果的键序固定：§from/to/by/flow/event§，声明了 §guards§ 时追加 §guards§

## 命令行

```bash
engine validate --intent <file|-> [--json] [--config <path>]   # 判定一条意图（- 表示 stdin）
engine check-config [--config <path>] [--json]                  # 声明自检
engine consult --intent <file|-> [--json] [--config <path>]     # 只读咨询
engine ledger fold|events|next-id|append|entry|config [--json]   # 账本/声明适配
engine --help
```

- 路径按**进程当前目录**解析：§.agents/platform/state-machine.yml§、§PLATFORM_LEDGER§（或默认 §.agents/platform/ledger.jsonl§）
- §validate/consult§ 失败时输出 §{"verdict"/"consult": …, "kind","code","message","extra"}§，退出码见上；§ledger§ 的失败走 stderr 一行 §{"kind","code","message","extra"}§

## 构建与验证

```bash
cd apps/engine
export GOPATH=$(cd ../.. && pwd)/.cache/go GOCACHE=$(cd ../.. && pwd)/.cache/go-build
test -z "$(gofmt -l *.go)" && go vet ./... && go test ./... && go build ./cmd/engine
```

- 与 JS 实现的逐字节对照在仓库根：`npx vitest run tests/engine-parity.test.mjs`（§node scripts/state-validate.mjs§ / §ledger-cli.mjs§ vs `go run ./cmd/engine`）
- 同一组检查已接进机器门：仓库根 `npm run check:engine`（`npm run check` 的一环，紧邻 `check:go`）

## 迁移注记

- P-31 阶段 A：本库落地，§apps/api-go§ 改为进程内调用；§scripts/*.mjs§ 仍在（阶段 D 才删），删前两者输出必须逐字节一致 —— 由 parity 测试兜住
- 为什么搬到 Go：Go 二进制不该因为要跑判定器而依赖本机装了 Node
