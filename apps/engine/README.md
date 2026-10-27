# apps/engine · 状态机判定器 + 账本（Go）

**状态**：active —— 自 P-31 阶段 A 起是判定器与账本的唯一实现，阶段 B 起**门牌重算 / 意图归一 / 留痕**三件 CLI 也在这里（§build-intent§ / §last-change§ / §writer-record§），阶段 C 起**合并资格判定**（§merge-gate§）也在（§mergegate.go§），阶段 D2 起**前端产物复制 / 平台 API 客户端 / 知识库汇入**（§copy-dist§ / §cli§ / §kb-export§）也在（§copy_dist.go§ / §cli_tool.go§ / §kbexport.go§），**审计口径五子命令**（§audit-findings§ / §audit-slot§ / §routing§ / §audit-collect§ / §audit-review§）同样在（§auditfindings.go§ / §auditslot.go§ / §routing.go§ / §auditcollect.go§ / §auditreview.go§），阶段 D3 起 §.github/workflows/audit.yml§ 的判定步也改调编译产物（读写面由 §--explain§ 自证，见「构建与调用点」与「迁移注记」）。Go 后端 §apps/api-go§ §import§ 本库在进程内调用；同口径命令行供脚本、CI 与人使用。

## 做什么

- **判定**：读 §.agents/platform/state-machine.yml§，判定一条意图（§labels/to/actor_role/comment/guards§）允不允许、落到哪条转换
- **咨询**：只读地算「从当前态到目标态会命中哪条转换」，不评估守卫、不写账本
- **声明自检**：解析一遍声明，任何形状/引用错误都点名（§E_CONFIG_*§）
- **账本**：§fold§ / §events§ / §next-id§ / §append§ / §entry§ / §config§ 六个操作，读写 §.agents/platform/ledger.jsonl§
- **意图归一**（阶段 B）：把 §issues§ / §pull_request§ 事件压成一条 §{issue,to,actor,actor_role,labels,comment,…}§ 意图，认不出的事件就明确「不需要改状态」
- **门牌重算**（阶段 B）：从 §pull_request§ 事件 + §git diff§ 结果重算 §## LAST-CHANGE§ 表格，支持 §--in/--out§ 与「内容没变 §changed=0§」
- **留痕**（阶段 B）：读判定结果 §verdict.json§，只在 §rejected/infra§ 时往 issue 里评论一条「状态未被修改：…」
- **合并资格**（阶段 C）：四道守卫 §G1 issue-state§ / §G2 refs-and-files§ / §G3 checks§ / §G4 last-change§，任一条是 §infra§ 就整笔「未就绪」（§3§），有真失败才是拒绝（§1§）；§G1§ 另有一条独立拒绝：issue 已关闭（§state=closed§）却还带非终态标签时报 §E_ISSUE_CLOSED_IN_FLIGHT§，输入里没有 §state§ 时不当作已关闭
- **前端产物复制**（阶段 D2）：§apps/web-vue/dist§ 铺进 §apps/api-go/dist§，没有产物时保留占位文件退 §0§（§go build§ 仍可跑，页面不进二进制），铺之前只清上一轮生成的条目
- **平台 API 客户端**（阶段 D2）：§board§ / §new§ / §verdict§ / §verify§ / §outbox§ 五个命令打 §apps/api-go§，表格列宽按显示宽度算（宽字符占两格），退出码 §0§ 成功 · §1§ 后端拒绝 · §2§ 用法 · §3§ 网络或后端故障 · §4§ 校验判红
- **知识库汇入**（阶段 D2）：从 §git§ commit 区间算清单（§path + sha256§ 幂等、白名单/排除项、累积继承、§INFRA§ 重试），退出码 §0§ 完整 · §2§ 用法 · §3§ §INFRA§
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
engine audit-findings [--a <file>] [--b <file>] [--out <file>] [--explain]   # 审计口径层：schema / 归一 / 两槽比对 / conclusion（stdout=「audit-findings …」逐行；退出码 0 pass / 1 不合格 / 3 判不了）。--explain 打印它读什么 / 写什么 / 退出码语义 / 源码模块（stdout=2 空格缩进 JSON，退出码 0），供「按文本扫不出读写面」的调用点自证用
engine audit-slot --slot review-a|review-b --executor sandbox|github --out <file>   # 槽位身份校验（输入从 §AUDIT_INPUT§ 读）
engine routing [--check]                                          # 模型映射真源自洽 + workflow 未硬编码模型名
engine audit-collect --pr <n> --a <file> --b <file> [--ref <branch>] [--dry-run] [--json] [--timeout <秒>]   # 审计编排：发 run → 等结论 → 读 Check Run
engine audit-review --slot review-a|review-b --diff <file> --out <file> [--api-base <url>]   # 一个槽 -> 一次模型调用 -> 一份 findings
engine copy-dist                                                  # apps/web-vue/dist → apps/api-go/dist（stdout=「copy-dist: …」；恒退 0）
engine cli board|new <title>|verdict|verify|outbox [--json] [--api <url>]   # 平台 API 客户端（退出码 0/1/2/3/4）
engine kb-export --repo <owner/name> [--ref <name>] (--from <a> --to <b> | --range <a>..<b>) [--cwd <dir>] [--existing <file>] [--require-existing] [--retry <file>] [--out <file>] [--infra-out <file>]   # 知识库汇入清单（退出码 0/2/3）
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

| 调用点                                                               | 命令                                                                                                                                                      |
| -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.github/workflows/merge-gate.yml`（collect inputs）                 | `./.cache/bin/engine merge-gate --event .gate/event.json --pr .gate/pr.json --print-issue`                                                                |
| `.github/workflows/merge-gate.yml`（gate）                           | `./.cache/bin/engine merge-gate --event .gate/event.json --pr .gate/pr.json --issue .gate/issue.json --checks .gate/checks.json --infra .gate/infra.json` |
| `.github/workflows/state-writer.yml`（resolve issue / build intent） | `./.cache/bin/engine build-intent [--resolve-issue]`                                                                                                      |
| `.github/workflows/state-writer.yml`（validate）                     | `./.cache/bin/engine validate --intent intent.json --json`                                                                                                |
| `.github/workflows/state-writer.yml`（record）                       | `./.cache/bin/engine writer-record --verdict verdict.json --issue "$TARGET"`                                                                              |
| `.github/workflows/last-change.yml`（render）                        | `./.cache/bin/engine last-change --in body.in.md --out body.out.md`                                                                                       |
| `.github/workflows/kb-sync.yml`（export manifest）                   | `./.cache/bin/engine kb-export --repo … --ref … --from … --to … --existing … --retry … --out … --infra-out …`                                             |
| `package.json`（check:state）                                        | `npm run --silent build:engine && ./.cache/bin/engine check-config`                                                                                       |
| `package.json`（check:web / web:dist）                               | `./.cache/bin/engine copy-dist`                                                                                                                           |
| `package.json`（cli）                                                | `./.cache/bin/engine cli`                                                                                                                                 |

审计四步（§.github/workflows/audit.yml§）在阶段 D2 仍然调 §node scripts/audit-_.mjs§：workflow 里的判定步是「谁读/写 §.audit/_.json§」的可扫描文本，换成编译产物是判据口径变更、不属于机械迁移，留给阶段 D3 单独处理。五个子命令的行为已由 §tests/engine-parity-d.test.mjs§ 与 JS 逐字节对齐。

四个 workflow（§merge-gate.yml§ / §state-writer.yml§ / §last-change.yml§ / §kb-sync.yml§）在 §npm ci§ 之后各有一步 §actions/setup-go@v5§ + 无名 §npm run build:engine§：先有二进制，调用点才可能绿。无名是刻意的——wiring 测试只回放「有 name 的步骤」，构建不该在沙箱里重跑。测试侧由 §tests/helpers/engine.mjs§ 保证同一入口（二进制缺失或比源文件旧就构建，构建失败即红）与沙箱内 §./.cache/bin/engine§ 的存在。

## 验证

```bash
cd apps/engine
export GOPATH=$(cd ../.. && pwd)/.cache/go GOCACHE=$(cd ../.. && pwd)/.cache/go-build
test -z "$(gofmt -l .)" && go vet ./... && go test ./...
```

- 与 JS 实现的逐字节对照在仓库根：`npx vitest run tests/engine-parity.test.mjs`（对照物已从 §scripts/*.mjs§ 换成冻结的 §tests/goldens/§：§scripts/state-validate.mjs§ 仍在，§ledger-cli.mjs§ 与 §copy-dist.mjs§ 已随 E2 删除）
- 阶段 B 三个入口的对照：`npx vitest run tests/engine-parity-b.test.mjs`（59 条：22 §build-intent§ + 19 §last-change§ + 13 §writer-record§ + 5 条已登记例外）。每条都比 stdout 逐字节、stderr、退出码；成功用例额外断言关键片段，防止「两侧同样失败」被当成一致
- 阶段 C 合并资格的对照：`npx vitest run tests/engine-parity-c.test.mjs`（46 条 fixture + 1 条数量断言）。§git§ 与 §gh§ 两侧都被 PATH 上的替身控制（假 §git§ 只认 §cat-file -e <sha>^{commit}§ 与 §cat-file -e <sha>:<path>§，假 §gh§ 一被调用就失败），所以「Go 侧偷偷起了 node / 真调了 gh」会当场变红；每条 fixture 先断言 JS 侧确实命中了它声称的分支（退出码 + §E_*§ 片段），再断言两侧 stdout 逐字节、stderr、退出码一致
- **已登记例外**（无法逐字节复刻，用「固定前缀 + 退出码」钉住）：Node 语法错误栈（§build-intent§ 的 §EVENT§ 非法、§EVENT=null§、§labels§ 不是数组）、§ENOENT§ 里带进程 pid 的临时文件名（§last-change --out§ 目录不存在）、§spawnSync gh ENOENT§ 这类运行时错误串，以及 §E_CONFIG_UNPARSABLE§ 的 YAML 解析器文案（§js-yaml§ 与 §yaml.v3§ 各说各的；钉住的是同一份坏文件同样被拒、同一个 §code§、§message§ 前缀「状态机配置不是合法 YAML: 」与退出码 §3§）。其余全部逐字节
- 阶段 C 的例外只有一条：§merge-gate§ 遇到 JS 侧未捕获异常（§issue.labels§ 不是数组）时，Node 打多行栈、Go 只打一行 §TypeError: …§；两侧一致的是「stdout 一个字节都没有 + 退出码 1」，栈文本不复刻。其余（含 §E_GIT_UNAVAILABLE§ 的 §spawnSync git ENOENT§、Node 24 §JSON.parse§ 带坐标的报错文案）都逐字节相同
- 阶段 D 审计六件套的对照：`npx vitest run tests/engine-parity-d.test.mjs`（50 条：8 §audit-findings§ + 6 §audit-slot§ + 7 §routing§ + 7 §audit-collect§ + 20 §audit-review§ + 2 条数量/例外断言）。每条都把同一批输入同时喂给 JS 与编译好的 engine，比 stdout 逐字节 / stderr / 退出码 / 写出文件内容 / 打到上游的请求体；§gh§ 与模型上游都是替身（假 §gh§ 只认四个查询，上游是另一个进程里的假 §/chat/completions§——被测进程用 §spawnSync§ 起，同线程 http server 会与它互等），所以「Go 侧偷偷起 node / 真调了 gh / 改了请求体」都会当场变红。变异验证用 §PARITY_ENGINE_DIR§ 指向 §/tmp§ 里改过的引擎副本，仓库本身不动
- 阶段 D 的已登记例外只有两条，都已写成显式归一（按固定前缀截断后只比前缀）：（1）YAML 解析器文案（§npm yaml§ 与 §yaml.v3§ 各说各的，前缀「路由声明不是合法 YAML: .agents/platform/routing.yml: 」）；（2）网络栈文案（§fetch failed§ 与 §dial tcp …: connect: connection refused§，前缀「调用上游失败（没拿到响应）：」）。其余全部逐字节
- 阶段 D2 后半（§copy-dist§ / §cli§ / §kb-export§）的对照：`npx vitest run tests/engine-parity-e.test.mjs`（37 条：3 §copy-dist§ + 10 §kb-export§ + 19 §cli§ + 3 条「引擎都是真跑出来的结论」+ 2 条调用点钉住断言），失败路径 16 条。后端是**另一个进程**里的假 §apps/api-go§（§spawnSync§ 起的被测进程拿不到同线程 server 的 CPU），所以「请求体变了 / 少发了一次 / Go 侧偷偷起 node」都会当场变红；§kb-export§ 在真 §git§ 仓库上跑（两个 commit 的夹具），比 stdout / stderr / 退出码 / 清单与 §INFRA§ 文件 / 请求体。已登记例外只有一条：§cli§ 连不上后端时的网络栈文案（§connect ECONNREFUSED 127.0.0.1:1§ vs §dial tcp …: connect: connection refused§），按前缀「连不上后端 <origin>: 」截断后只比前缀
- 同一组检查已接进机器门：仓库根 `npm run check:engine`（`npm run check` 的一环，紧邻 `check:go`）

## 迁移注记

- P-31 阶段 A：本库落地，§apps/api-go§ 改为进程内调用；§scripts/*.mjs§ 仍在（阶段 D 才删），删前两者输出必须逐字节一致 —— 由 parity 测试兜住
- P-31 阶段 B：§build-intent§ / §last-change§ / §writer-record§ 的判据搬进 §intent.go§ / §lastchange.go§ / §writer.go§，JS 语义（§\s§ 字符类、§String()§ 转换、§Number()§ 解析、§JSON.stringify§ 缩进、§ENOENT§ 文案）集中在 §jscompat.go§；JSON 仍走 §value.go§ 的保序值与编码器，没有第二套
- P-31 阶段 C：§scripts/merge-gate.mjs§ 的四道守卫搬进 §mergegate.go§，§cli.go§ 增 §merge-gate§ 子命令。耦合点的解法是**进程内调用**：§loadConfig§/§consultTransition§ → §LoadConfig§ + §(*Config).ConsultTransition§，§renderLastChange§ → §RenderLastChange§（门牌行号由渲染器的探针结果现算，不复制表格格式），§resolveIssueRefs§ → §ResolveIssueRefs§ + §issueRefsValue§。整条路径**不起 node 子进程**；外部工具只剩 §git§（§existsAt§ 的两条 §cat-file -e§）与 §gh§（merge-gate 根本不用，测试里放假 §gh§ 钉住这一点）
- 阶段 C 发现的一处 JS 侧契约（照原样复刻，未改 JS）：§G3§ 只排除名为 §merge-gate§ 的 check，**不排除生产者 §render§** —— 所以门牌生产者失败时，§G2/G4§ 报 §E_LAST_CHANGE_FAILED§（未就绪）而 §G3§ 同时报 §E_CHECK_NOT_GREEN§（真失败），整笔退出码是 §1§ 而不是 §3§。这条由 §tests/engine-parity-c.test.mjs§ 的「生产者这次没写成」用例钉住
- P-31 阶段 D1：CI 与 npm 脚本的调用点从 §node scripts/_.mjs§ 切到 §./.cache/bin/engine§（见「构建与调用点」）。判据、JSON 字段、stdout 文案与退出码一个字没改——两侧用同一批输入对比过，差别只落在已登记的四处例外里。§scripts/_.mjs§ 一份都没删：它们仍是 parity 测试的对照物，§state-validate.mjs§ / §merge-gate.mjs§ 还作为库入口被 §tests/§ 直接 §import§
- P-31 阶段 D2：审计六件套（§audit-findings.mjs§ / §audit-slot.mjs§ / §routing.mjs§ / §audit-collect.mjs§ / §audit-review.mjs§）的行为搬进 §auditfindings.go§ / §auditslot.go§ / §routing.go§ / §auditcollect.go§ / §auditreview.go§，§cli.go§ 增五个子命令。判据、JSON 字段、stdout 文案与退出码一个字没改，差别只落在两条已登记例外里。调用点本轮**不切换**：§.github/workflows/audit.yml§ 仍调 Node——它把「谁读写 §.audit/*.json§」从可扫描文本降级成不可读产物，属判据设计变更，留到阶段 D3
- P-31 阶段 D2 后半：§scripts/copy-dist.mjs§ / §scripts/cli.mjs§ / §scripts/kb-export.mjs§ 的行为搬进 §copy_dist.go§ / §cli_tool.go§ / §kbexport.go§，§cli.go§ 增 §copy-dist§ / §cli§ / §kb-export§ 三个子命令，调用点**本轮切换**（§package.json§ 的 §check:web§ / §web:dist§ / §cli§ 与 §.github/workflows/kb-sync.yml§ 都改指 §./.cache/bin/engine§）。判据、stdout 文案与退出码一个字没改，差别只落在一条已登记例外里（§cli§ 的网络栈文案）。§kb-export§ 的白名单与排除项与 §scripts/kb-export.mjs§ 的 §ALLOWED§/§DENY_*§、§apps/api-go/kb.go§ 的 §kbAllowRules§ 同口径（变量名与正则写法各不相同），改动必须三处一起动，三份表的同口径对照在 §tests/kb-allowlist-parity.test.mjs§；§cli§ 的 §USAGE§ 与子命令旗标逐字复刻（§--help§ 输出被断言）
- P-31 阶段 D3：§.github/workflows/audit.yml§ 的判定步从 §node scripts/audit-findings.mjs§ 切到 §./.cache/bin/engine audit-findings§，§scripts/_.mjs§ 一份没删。这一刀与前几刀不同：判据是**文本扫描器**，它读不出一个编译产物读哪些 §.audit/_.json§、写哪一份，于是「谁写结论」这条判据失去可扫描的载体。解法不是放宽扫描器，而是给产物一条**自证通道**：§audit-findings --explain§ 出声明的 §subcommand§ / §args§ / §reads§ / §writes§ / §exitCodes§ / §source§，扫描面按「**这一次调用**是否恰好等于它声明的契约」放行——粒度是调用不是文件名（同一个产物被别的子命令或带多余参数调用仍是默认拒绝），而且每次跳过都记一条 §kind + file + why§ 的账（§takeBinarySkips()§），静默 §continue§ 不被允许。§--explain§ 的声明与调用点参数、与实现三处对齐由 §tests/audit-findings.test.mjs§ 的「阶段 D3」五条用例钉住（声明↔workflow 逐词一致、按契约真跑产物只写出 §--out§ 那一份、两条反面对照、自证声明的源码模块在仓库里）
- 阶段 D2 后半踩到的坑（测试侧，不是实现侧）：JS 那份 §copy-dist.mjs§ 只在 §process.argv[1]§ 与 §import.meta.url§ 相等时才执行主体，而 macOS 的 §/var§ 是指向 §/private/var§ 的软链、Node 的 ESM loader 会把 §import.meta.url§ 解成真实路径——沙箱目录不做 §realpath§ 就会出现「两侧都没有输出」的假绿（§tests/engine-parity-e.test.mjs§ 里已 §realpathSync§ 一次）
- P-31 阶段 D2 收口时补的 §G1§ 判据：门也读 §issue.state§（§mergegate.go§ 的 §mergeGateIssueClosed§，只认字符串 §closed§，输入里缺 §state§ 不当成已关闭），已关闭 + 非终态标签 → §E_ISSUE_CLOSED_IN_FLIGHT§（§rejected§）。Node 对照物 §scripts/merge-gate.mjs§ 同源落地；两侧分别由 §apps/engine/closed_intent_test.go§ 与 §tests/merge-gate.test.mjs§ 覆盖——§tests/engine-parity-c.test.mjs§ 的 issue 夹具不带 §state§，这条守卫目前不在 Go↔JS parity 面内
- P-31 收尾（§writer-record§）：参照物 §scripts/writer-record.mjs§ 与只钉它实现细节的 §tests/writer-record.test.mjs§ 已删除，9 条判据等价搬进 §writer_test.go§（11 条 Go 单测：函数级的正文/退出码 + CLI 级的 stdout/stderr/退出码/假 §gh§ 调用记录，全部经 §Run(["writer-record", …])§ 走 §cli.go§ 的 case 表），13 条 CLI 形状仍由 §tests/goldens/b/§ 的冻结 golden 逐字节钉住；§tests/goldens/freeze.mjs§ 在参照物缺失时以可读说明中止（不崩溃、不静默跳过），§parity-cases.mjs§ 的 suite b 用 §refreezeLocked§ 标明 writer-record 不再可重冻
- E2 第三批（§copy-dist§ / §ledger§ / §ledger-cli§）：参照物 §scripts/copy-dist.mjs§ / §scripts/ledger.mjs§ / §scripts/ledger-cli.mjs§ 已删除，判据搬进 §copy_dist_test.go§（3 条，对应 §tests/goldens/e/§ 的 e-01…e-03）与 §ledger_cli_test.go§（12 条，对应 §tests/goldens/a/§ 的 a-35…a-46，另加 1 条函数级的 next-id 边界：条数 + 1 撞上已用号要往后跳）。全部经 §Run(["copy-dist"]) / Run(["ledger", …])§ 走 §cli.go§ 的 case 表，断言的 stdout / stderr / 退出码 / 落盘字节与冻结 golden 逐字节相同；夹具本身仍由 §engine-parity.test.mjs§ / §engine-parity-e.test.mjs§ 对着 Go 引擎逐字节比，所以删掉参照物不降低强度。这一批**没删任何 vitest 用例**——全仓 grep 显示没有 Node 用例 §import§ / §spawn§ 过这三个脚本。与 P-31 收尾的差别只有一处：§tests/goldens/§ 属本批禁区，suite a / e 没加 §refreezeLocked§ 标记，§freeze.mjs§ 的名点改由 §missingReferences§ 动态给出；另外「与 JS 实现的逐字节对照」一节里那位旧命令行仍点名 §ledger-cli.mjs§，那是删除前的历史记录，本批只改状态行与迁移注记，故未动它。
- 为什么搬到 Go：Go 二进制不该因为要跑判定器而依赖本机装了 Node

[![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)
