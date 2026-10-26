# apps/engine · 状态机判定器 + 账本（Go）

**状态**：active —— 自 P-31 阶段 A 起是判定器与账本的唯一实现，阶段 B 起**门牌重算 / 意图归一 / 留痕**三件 CLI 也在这里（§build-intent§ / §last-change§ / §writer-record§）。Go 后端 §apps/api-go§ §import§ 本库在进程内调用；同口径命令行供脚本、CI 与人使用。

## 做什么

- **判定**：读 §.agents/platform/state-machine.yml§，判定一条意图（§labels/to/actor_role/comment/guards§）允不允许、落到哪条转换
- **咨询**：只读地算「从当前态到目标态会命中哪条转换」，不评估守卫、不写账本
- **声明自检**：解析一遍声明，任何形状/引用错误都点名（§E_CONFIG_*§）
- **账本**：§fold§ / §events§ / §next-id§ / §append§ / §entry§ / §config§ 六个操作，读写 §.agents/platform/ledger.jsonl§
- **意图归一**（阶段 B）：把 §issues§ / §pull_request§ 事件压成一条 §{issue,to,actor,actor_role,labels,comment,…}§ 意图，认不出的事件就明确「不需要改状态」
- **门牌重算**（阶段 B）：从 §pull_request§ 事件 + §git diff§ 结果重算 §## LAST-CHANGE§ 表格，支持 §--in/--out§ 与「内容没变 §changed=0§」
- **留痕**（阶段 B）：读判定结果 §verdict.json§，只在 §rejected/infra§ 时往 issue 里评论一条「状态未被修改：…」
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
engine build-intent [--resolve-issue]                            # 事件 → 意图（stdout=2 空格缩进 JSON；--resolve-issue 只印 issue 号）
engine last-change [--in <file>] [--out <file>]                   # 重算门牌表格（stderr 前缀「门牌重算失败：」）
engine writer-record [--verdict <file>] [--issue <n>]             # 按判定结果留痕（stderr 前缀「读不到判定结果: 」/「留痕失败: 」）
engine --help
```

- 路径按**进程当前目录**解析：§.agents/platform/state-machine.yml§、§PLATFORM_LEDGER§（或默认 §.agents/platform/ledger.jsonl§）
- §validate/consult§ 失败时输出 §{"verdict"/"consult": …, "kind","code","message","extra"}§，退出码见上；§ledger§ 的失败走 stderr 一行 §{"kind","code","message","extra"}§
- 阶段 B 三个子命令沿用原来的环境变量口径：§EVENT/EVENT_NAME/LAST_COMMENT/DEFAULT_FLOW/ISSUE_STATE_FILE/GUARD_EVIDENCE_FILE/GITHUB_OUTPUT§（§build-intent§）、§EVENT/EVENT_NAME/BASE/HEAD/GITHUB_OUTPUT§（§last-change§）；路径同样按**进程当前目录**解析
- 三者都 fail-closed：认不出的输入一律报错退出，不静默降级（§EVENT§ 不是 JSON、§labels§ 不是数组、§git diff§ 失败、判定结果未知……）

## 构建与验证

```bash
cd apps/engine
export GOPATH=$(cd ../.. && pwd)/.cache/go GOCACHE=$(cd ../.. && pwd)/.cache/go-build
test -z "$(gofmt -l *.go)" && go vet ./... && go test ./... && go build ./cmd/engine
```

- 与 JS 实现的逐字节对照在仓库根：`npx vitest run tests/engine-parity.test.mjs`（§node scripts/state-validate.mjs§ / §ledger-cli.mjs§ vs `go run ./cmd/engine`）
- 阶段 B 三个入口的对照：`npx vitest run tests/engine-parity-b.test.mjs`（55 条：19 §build-intent§ + 19 §last-change§ + 13 §writer-record§ + 4 条已登记例外）。每条都比 stdout 逐字节、stderr、退出码；成功用例额外断言关键片段，防止「两侧同样失败」被当成一致
- **已登记例外**（无法逐字节复刻，用「固定前缀 + 退出码」钉住）：Node 语法错误栈（§build-intent§ 的 §EVENT§ 非法、§EVENT=null§、§labels§ 不是数组）、§ENOENT§ 里带进程 pid 的临时文件名（§last-change --out§ 目录不存在）、§spawnSync gh ENOENT§ 这类运行时错误串。其余全部逐字节
- 同一组检查已接进机器门：仓库根 `npm run check:engine`（`npm run check` 的一环，紧邻 `check:go`）

## 迁移注记

- P-31 阶段 A：本库落地，§apps/api-go§ 改为进程内调用；§scripts/*.mjs§ 仍在（阶段 D 才删），删前两者输出必须逐字节一致 —— 由 parity 测试兜住
- P-31 阶段 B：§build-intent§ / §last-change§ / §writer-record§ 的判据搬进 §intent.go§ / §lastchange.go§ / §writer.go§，JS 语义（§\s§ 字符类、§String()§ 转换、§Number()§ 解析、§JSON.stringify§ 缩进、§ENOENT§ 文案）集中在 §jscompat.go§；JSON 仍走 §value.go§ 的保序值与编码器，没有第二套
- 阶段 C 的耦合点（merge-gate，尚在 §scripts/merge-gate.mjs§）：它 §import§ 的正是这三个 §.mjs§ 的导出函数（§buildIntent§ / §resolveIssueRefs§ / §renderSection§ 等），所以阶段 C 不能只调命令行，要么把这些函数原样导出，要么让 merge-gate 直接调命令行并吃掉 I/O 边界；另外 §last-change§ 依赖 §git§、§writer-record§ 依赖 §gh§，Go 侧同样是起子进程（只限这两个外部工具，不跑 node）
- 为什么搬到 Go：Go 二进制不该因为要跑判定器而依赖本机装了 Node
