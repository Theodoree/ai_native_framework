# apps/engine · 状态机判定器 + 账本（Go）

**状态**：active —— 自 P-31 阶段 A 起是判定器与账本的唯一实现，阶段 B 起**门牌重算 / 意图归一 / 留痕**三件 CLI 也在这里（§build-intent§ / §last-change§ / §writer-record§），阶段 C 起**合并资格判定**（§merge-gate§）也在（§mergegate.go§）。Go 后端 §apps/api-go§ §import§ 本库在进程内调用；同口径命令行供脚本、CI 与人使用。

## 做什么

- **判定**：读 §.agents/platform/state-machine.yml§，判定一条意图（§labels/to/actor_role/comment/guards§）允不允许、落到哪条转换
- **咨询**：只读地算「从当前态到目标态会命中哪条转换」，不评估守卫、不写账本
- **声明自检**：解析一遍声明，任何形状/引用错误都点名（§E_CONFIG_*§）
- **账本**：§fold§ / §events§ / §next-id§ / §append§ / §entry§ / §config§ 六个操作，读写 §.agents/platform/ledger.jsonl§
- **意图归一**（阶段 B）：把 §issues§ / §pull_request§ 事件压成一条 §{issue,to,actor,actor_role,labels,comment,…}§ 意图，认不出的事件就明确「不需要改状态」
- **门牌重算**（阶段 B）：从 §pull_request§ 事件 + §git diff§ 结果重算 §## LAST-CHANGE§ 表格，支持 §--in/--out§ 与「内容没变 §changed=0§」
- **留痕**（阶段 B）：读判定结果 §verdict.json§，只在 §rejected/infra§ 时往 issue 里评论一条「状态未被修改：…」
- **合并资格**（阶段 C）：四道守卫 §G1 issue-state§ / §G2 refs-and-files§ / §G3 checks§ / §G4 last-change§，任一条是 §infra§ 就整笔「未就绪」（§3§），有真失败才是拒绝（§1§）
- **命令行**：单二进制多子命令（见下），退出码 §0§ allowed · §1§ rejected · §3§ infra（用法错误 §2§）

## 不做什么

- 不做 HTTP：路由与响应形状在 §apps/api-go§
- 不读 §scripts/§ 下的任何 JS：本库是唯一实现，不是包装器；CI 与 npm 脚本的调用点指向本二进制，那几份 .mjs 只留作 parity 对照物
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
engine merge-gate [--event <file>] [--pr <file>] [--issue <file>] [--checks <file>] [--infra <file>] [--head <sha>] [--repo <dir>] [--config <path>] [--print-issue]   # 合并资格四条守卫（stdout=「merge-gate …」逐行；退出码 0 通过 / 1 真失败 / 3 未就绪）
engine --help
```

- 路径按**进程当前目录**解析：§.agents/platform/state-machine.yml§、§PLATFORM_LEDGER§（或默认 §.agents/platform/ledger.jsonl§）
- §validate/consult§ 失败时输出 §{"verdict"/"consult": …, "kind","code","message","extra"}§，退出码见上；§ledger§ 的失败走 stderr 一行 §{"kind","code","message","extra"}§
- 阶段 B 三个子命令沿用原来的环境变量口径：§EVENT/EVENT_NAME/LAST_COMMENT/DEFAULT_FLOW/ISSUE_STATE_FILE/GUARD_EVIDENCE_FILE/GITHUB_OUTPUT§（§build-intent§）、§EVENT/EVENT_NAME/BASE/HEAD/GITHUB_OUTPUT§（§last-change§）；路径同样按**进程当前目录**解析
- 三者都 fail-closed：认不出的输入一律报错退出，不静默降级（§EVENT§ 不是 JSON、§labels§ 不是数组、§git diff§ 失败、判定结果未知……）

## 构建与调用点

构建只有一个入口，CI 与测试共用它；产物落在仓库内 §.cache/bin/engine§（§.cache/§ 已忽略，不进仓库）：

```bash
npm run build:engine   # cd apps/engine + GOPATH/GOCACHE 指仓库 .cache + go build -o ../../.cache/bin/engine ./cmd/engine
```

调用点一律写 **cwd 相对**的 §./.cache/bin/engine§（子命令的路径都按进程当前目录解析，所以调用点必须在仓库根）：

| 调用点 | 命令 |
| ------ | ---- |
| `.github/workflows/merge-gate.yml`（collect inputs） | `./.cache/bin/engine merge-gate --event .gate/event.json --pr .gate/pr.json --print-issue` |
| `.github/workflows/merge-gate.yml`（gate） | `./.cache/bin/engine merge-gate --event .gate/event.json --pr .gate/pr.json --issue .gate/issue.json --checks .gate/checks.json --infra .gate/infra.json` |
| `.github/workflows/state-writer.yml`（resolve issue / build intent） | `./.cache/bin/engine build-intent [--resolve-issue]` |
| `.github/workflows/state-writer.yml`（validate） | `./.cache/bin/engine validate --intent intent.json --json` |
| `.github/workflows/state-writer.yml`（record） | `./.cache/bin/engine writer-record --verdict verdict.json --issue "$TARGET"` |
| `.github/workflows/last-change.yml`（render） | `./.cache/bin/engine last-change --in body.in.md --out body.out.md` |
| `package.json`（check:state） | `npm run --silent build:engine && ./.cache/bin/engine check-config` |

三个 workflow 在 §npm ci§ 之后各有一步 §actions/setup-go@v5§ + 无名 §npm run build:engine§：先有二进制，调用点才可能绿。无名是刻意的——wiring 测试只回放「有 name 的步骤」，构建不该在沙箱里重跑。测试侧由 §tests/helpers/engine.mjs§ 保证同一入口（二进制缺失或比源文件旧就构建，构建失败即红）与沙箱内 §./.cache/bin/engine§ 的存在。

## 验证

```bash
cd apps/engine
export GOPATH=$(cd ../.. && pwd)/.cache/go GOCACHE=$(cd ../.. && pwd)/.cache/go-build
test -z "$(gofmt -l .)" && go vet ./... && go test ./...
```

- 与 JS 实现的逐字节对照在仓库根：`npx vitest run tests/engine-parity.test.mjs`（§node scripts/state-validate.mjs§ / §ledger-cli.mjs§ vs `go run ./cmd/engine`）
- 阶段 B 三个入口的对照：`npx vitest run tests/engine-parity-b.test.mjs`（55 条：19 §build-intent§ + 19 §last-change§ + 13 §writer-record§ + 4 条已登记例外）。每条都比 stdout 逐字节、stderr、退出码；成功用例额外断言关键片段，防止「两侧同样失败」被当成一致
- 阶段 C 合并资格的对照：`npx vitest run tests/engine-parity-c.test.mjs`（45 条 fixture + 1 条数量断言）。§git§ 与 §gh§ 两侧都被 PATH 上的替身控制（假 §git§ 只认 §cat-file -e <sha>^{commit}§ 与 §cat-file -e <sha>:<path>§，假 §gh§ 一被调用就失败），所以「Go 侧偷偷起了 node / 真调了 gh」会当场变红；每条 fixture 先断言 JS 侧确实命中了它声称的分支（退出码 + §E_*§ 片段），再断言两侧 stdout 逐字节、stderr、退出码一致
- **已登记例外**（无法逐字节复刻，用「固定前缀 + 退出码」钉住）：Node 语法错误栈（§build-intent§ 的 §EVENT§ 非法、§EVENT=null§、§labels§ 不是数组）、§ENOENT§ 里带进程 pid 的临时文件名（§last-change --out§ 目录不存在）、§spawnSync gh ENOENT§ 这类运行时错误串，以及 §E_CONFIG_UNPARSABLE§ 的 YAML 解析器文案（§js-yaml§ 与 §yaml.v3§ 各说各的；钉住的是同一份坏文件同样被拒、同一个 §code§、§message§ 前缀「状态机配置不是合法 YAML: 」与退出码 §3§）。其余全部逐字节
- 阶段 C 的例外只有一条：§merge-gate§ 遇到 JS 侧未捕获异常（§issue.labels§ 不是数组）时，Node 打多行栈、Go 只打一行 §TypeError: …§；两侧一致的是「stdout 一个字节都没有 + 退出码 1」，栈文本不复刻。其余（含 §E_GIT_UNAVAILABLE§ 的 §spawnSync git ENOENT§、Node 24 §JSON.parse§ 带坐标的报错文案）都逐字节相同
- 同一组检查已接进机器门：仓库根 `npm run check:engine`（`npm run check` 的一环，紧邻 `check:go`）

## 迁移注记

- P-31 阶段 A：本库落地，§apps/api-go§ 改为进程内调用；§scripts/*.mjs§ 仍在（阶段 D 才删），删前两者输出必须逐字节一致 —— 由 parity 测试兜住
- P-31 阶段 B：§build-intent§ / §last-change§ / §writer-record§ 的判据搬进 §intent.go§ / §lastchange.go§ / §writer.go§，JS 语义（§\s§ 字符类、§String()§ 转换、§Number()§ 解析、§JSON.stringify§ 缩进、§ENOENT§ 文案）集中在 §jscompat.go§；JSON 仍走 §value.go§ 的保序值与编码器，没有第二套
- P-31 阶段 C：§scripts/merge-gate.mjs§ 的四道守卫搬进 §mergegate.go§，§cli.go§ 增 §merge-gate§ 子命令。耦合点的解法是**进程内调用**：§loadConfig§/§consultTransition§ → §LoadConfig§ + §(*Config).ConsultTransition§，§renderLastChange§ → §RenderLastChange§（门牌行号由渲染器的探针结果现算，不复制表格格式），§resolveIssueRefs§ → §ResolveIssueRefs§ + §issueRefsValue§。整条路径**不起 node 子进程**；外部工具只剩 §git§（§existsAt§ 的两条 §cat-file -e§）与 §gh§（merge-gate 根本不用，测试里放假 §gh§ 钉住这一点）
- 阶段 C 发现的一处 JS 侧契约（照原样复刻，未改 JS）：§G3§ 只排除名为 §merge-gate§ 的 check，**不排除生产者 §render§** —— 所以门牌生产者失败时，§G2/G4§ 报 §E_LAST_CHANGE_FAILED§（未就绪）而 §G3§ 同时报 §E_CHECK_NOT_GREEN§（真失败），整笔退出码是 §1§ 而不是 §3§。这条由 §tests/engine-parity-c.test.mjs§ 的「生产者这次没写成」用例钉住
- P-31 阶段 D1：CI 与 npm 脚本的调用点从 §node scripts/*.mjs§ 切到 §./.cache/bin/engine§（见「构建与调用点」）。判据、JSON 字段、stdout 文案与退出码一个字没改——两侧用同一批输入对比过，差别只落在已登记的四处例外里。§scripts/*.mjs§ 一份都没删：它们仍是 parity 测试的对照物，§state-validate.mjs§ / §merge-gate.mjs§ 还作为库入口被 §tests/§ 直接 §import§
- 为什么搬到 Go：Go 二进制不该因为要跑判定器而依赖本机装了 Node
