# P-31 判据与门搬进 Go

状态：阶段 A–D4 已完成并合入 main；E2（按模块把 Node 判据搬进 Go，搬完即删）进行中——第一批 writer-record、第二批 last-change 已完成（A/B/C 见 §六–§十，D1 §十一、D2 §十二、D3 §十三、D4 §十四）。audit.yml 判定步自 D3 起调编译产物；parity 自 D4 起只跑引擎、与冻结 golden 比对，测试路径不再执行 scripts/*.mjs。scripts/*.mjs 与钉其实现细节的 Node 套件仍在（约 690 例），删除前置已解除但须先把用例移植成 Go 单测（§14.6）；USAGE 文案仍写 Node 载体名。

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

| 阶段 | 内容                                                                                                                                           | 完成判据                                                                                   |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| A    | `apps/engine` 骨架 + 账本 + 判定器（`ledger` 55+104 行、`state-validate` 366 行）；`api-go` 改直接调用库，不再 subprocess                      | parity 全绿；`go vet`/`go test`/`npm run check` 全绿；`go build ./cmd/engine` 产出单二进制 |
| B    | `build-intent`（280 行）+ `last-change`（280 行）+ `writer-record`（72 行）                                                                    | `state-writer` workflow 改调 Go 二进制；parity 全绿                                        |
| C    | `merge-gate`（523 行）                                                                                                                         | `merge-gate` workflow 改调 Go；parity 全绿                                                 |
| D    | 清场：删已迁移的 `.mjs`、`package.json` 脚本改 Go、`check:state`/`check:go` 合并、workflow 铺 `setup-go`、parity 转 golden、文档与决策记录更新 | 仓库里只剩审计与知识库的 Node 脚本；`grep -r 'state-validate.mjs\|ledger-cli.mjs'` 零命中  |

> 上表是初始计划。实际落地分阶段记录：§六（A）、§八（B）、§十（C）、§十一（D1：CI 与 npm 脚本）、§十二（D2：Node 调用面）、§十三（D3：`audit.yml` 判定步）。阶段 D 原定的「删已迁移的 `.mjs`」**本轮不做**（用户裁决）：引擎在 `main` 上跑稳之前，`scripts/*.mjs` 保留为 parity 的黄金基准，一份不删。

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

## 八、阶段 B 落地记录（build-intent / last-change / writer-record）

**交付物**：`apps/engine/jscompat.go`（150 行，JS 语义垫片：空白集、Number()、JSON.stringify、appendFileSync、ENOENT 文案）、`intent.go`（394）、`lastchange.go`（492）、`writer.go`（113）、`phase_b_test.go`（168）、`tests/engine-parity-b.test.mjs`（670，55 例）；改 `cli.go`（Run 三个 case + EngineUsage）、`value.go`（新增 `EncodeIndent` 复刻 `JSON.stringify(v,null,2)`）、`README.md`。手法与阶段 A 同：真双跑对照，不重写判据。

**已登记的非逐字节例外**（用前缀 + 退出码钉住，不放松判据）：Node 未捕获异常栈（含 `<anonymous_script>` 与行号）、`--out` 目录不存在的 ENOENT（临时文件名含 pid）、`spawnSync gh ENOENT`、git 二进制缺失（同一机制）。

**移植中修掉的两个真 bug**：`isEastAsianWide` 曾把 `\u2E80-\uA4CF` 写成 `0x2e80-0x4acf`（表格列宽错算）；writer 的 `--issue` 缺值应得 NaN（`JSON.stringify(NaN)` 是 `null`），否则会把 `"0"` 当编号。

**变异验证**（我亲跑四组，就地改 + /tmp 备份 + 先打印改后行 + 恢复）：lastchange 分隔行 `-`→`=` 8 红；`intent.go` 的 `"ci"`→`"bot"` 1 红；writer 正文文案改 4 红；**`value.go` 的 `EncodeIndent` 缩进 +1 → 10 红**（这组是我自己找的，交付方未测）。恢复后 parity 55 全绿、整仓 `npm run check` 609 tests 全绿、工作树无残留。

**阶段 C 的耦合点（先说清，免得改错）**：`merge-gate.mjs` 是 **import 这三个 .mjs 的导出函数**（`buildIntent`/`resolveIssueRefs`/`renderSection`/`recordBody`），不是调 CLI —— Go 侧已有同名导出，阶段 C 是把 merge-gate 改成调库，入口契约不经过命令行。另：last-change 的 git 命令别换 plumbing（`-z` 等），`core.quotePath=true` 会把非 ASCII 路径转八进制转义，两侧逐字节一致正是靠它；writer-record 的退出码是「判定结论 × 评论成功」的合成，infra 评论成功仍退 1，不是可重试信号；`GITHUB_OUTPUT` 是追加写。
**运行时方言第二次咬人（与阶段 A 同一类，这次的载体是 stderr 文案）**：last-change 的「EVENT 非法 JSON」用例本地（Node 24）全绿、CI（Node 20）红——JSON.parse 的坐标后缀 (line 1 column 2) 只在 Node 22+ 出现。修法与阶段 A 同口径：比对前把坐标后缀从两侧摘掉（位置数字仍比），并**单独断言 Go 侧一律带坐标**，避免「两边都摘」退化成什么都没比。判断：凡是把 JSON.parse 的消息写进输出面的入口，都按这条办。

## 九、同步到 main 时暴露的一个状态机缺口（已修，见 §十二）

阶段 B 的 PR #83 基分支误设为 `develop`：GitHub 只在**指向默认分支**时自动关单，main 也就没快进。补的同步 PR #84（`develop → main`）又踩到第二层：门 G1 需要一个**还能被合并带到 done 的 issue**，而 #82 已被写者带到 `state:done`，门如实报 `E_TERMINAL_STATE 终态 done 不能再转换`。于是单独开 #85 作为同步单。

PR #84 合并后 #85 被 GitHub 自动关闭，但标签停在 `state:in-progress`。原因查清：写者的意图表**只认 `issues.opened` 与 `issues.labeled`**（`scripts/build-intent.mjs:158`、`:164`，Go 侧同源），`issues.closed` 不产生意图；而 PR 关闭事件（`pull_request.closed && merged` → done）与 GitHub 的自动关单几乎同时发生，谁先谁后不确定。结果是「关单是平台外的动作，状态标签是平台内的记录」这两件事在时间上脱钩。

不在这里手工改标签：状态只有一个写者，绕过写者改标签等于把契约当建议。当时的状态如实写在 PR/issue 里，读的人能看到。

**后续已修**（阶段 D2）：`issues.closed` 现在产生意图，门 G1 另加「已关闭的 issue 不得判在途」。两条路径里选了前者，理由与实现见 §12.4。

## 十、阶段 C 落地记录（merge-gate）

**派了两次**：第一次的执行器中途失败、零改动、无收尾消息（`git status` 空）；按 R6 重派一次并加约束「每完成一步就记一行」，第二次正常交付。这类「静默失败」只能靠工作树有没有变来发现，靠回合数等不出来。

**交付物**：`apps/engine/mergegate.go`（新增 800 行：四守卫 G1 issue-state / G2 refs-and-files / G3 checks / G4 last-change，加 collect/report/fail 与 `RunMergeGate`）；`apps/engine/cli.go`（+3 行：`merge-gate` 子命令）；`apps/engine/README.md`；`tests/engine-parity-c.test.mjs`（439 行，46 用例，假 git/假 gh 双替身）。`scripts/*.mjs`、`package.json`、`.github/**`、`apps/api-go/**`、`apps/web-vue/**` 一个字节都没动。

**耦合点全部进程内**：`LoadConfig` + `ConsultTransition` / `RenderLastChange` / `ResolveIssueRefs` + `issueRefsValue`，整条路径不起 node 子进程，外部工具只剩 `git` 的两条 `cat-file -e`。这正是阶段 A 之后 api-go 已经达到的形态，阶段 C 把门也拉到同一形态。

**唯一不做逐字节对照的地方**：JS 未捕获异常的多行栈（G1 的 labels 不是数组时 Node 打 `TypeError: ... is not a function` 加栈帧）。Go 只打首行。一致的契约降到「stdout 一个字节都没有 + 退出码 1」，这条写进了 parity 用例名与 README。

**我的独立变异（五组，就地改 + /tmp 备份 + 先打印改后行 + 恢复）**：

| #   | 变异                                                                                          | 红数             |
| --- | --------------------------------------------------------------------------------------------- | ---------------- |
| A   | `mergegate.go:276` `mergeGateNewest` 的 `>=` → `>`（平手取先出现的那条）                      | **0 红（漏了）** |
| B   | `mergegate.go:449` `!strictEqual(sha, ctx.head)` → `!strictEqual(sha, sha)`（stale 永不成立） | 1 红             |
| C   | `mergegate.go:318` `len(refs) != 1` → `len(refs) < 1`（放过多个引用）                         | 1 红             |
| D   | `mergegate.go:353` 咨询 `to:"done"` → `to:"in-progress"`（G1 目标状态错）                     | 30 红            |
| E   | `mergegate.go:727` 汇总行「未就绪=」→「未完成=」                                              | 28 红            |

**A 是这一轮唯一抓到的缺口，根因是夹具 id 全不等**：`newest` 在 JS 里是 `(a,b) => Number(b?.id ?? 0) >= Number(a?.id ?? 0) ? b : a`，平手取**后**出现的那条；交付方的 45 个夹具里没有一条让两条同名 check 的 id 相等，于是 `>=` 与 `>` 在测试面上不可区分。补的夹具是「两条 `render`，id 都是 2，前一条 completed/success、后一条 in_progress」——JS 取后者 → `E_LAST_CHANGE_PENDING`/exit 3；改成 `>` 取前者 → 直接放行。补完后 A 变 1 红，恢复 47 全绿（46 + 新增 1）。

**教训**：同名取最新这类判据，夹具必须同时覆盖「id 不等」和「id 相等」两种形状——只盖不等的话，比较符号写反、写成 `>`、写成字典序都测不出来。这跟阶段 B 的「单守卫夹具盖不到多守卫拼接」是同一类：**夹具形状的单一性，等于判据半个身子没被测**。

**顺手清掉一条 lint**：`tests/engine-parity-c.test.mjs:145` 的 `...(spec.env ?? {})` → `...spec.env`（oxlint 的 no-useless-fallback-in-spread）。`npx oxlint scripts tests` 回到 3 warnings，全部是 `tests/audit-findings.test.mjs` 的既有正则转义噪声。

**交付方照实登记、我复核认可的 JS 侧可疑之处（未改 scripts/，因为对照物必须保持原样）**：

1. **G3 不排除生产者 `render`**：G2/G4 把 render 当「门牌还没就绪」（infra/3），G3 却把它当「别人家的 check」判真失败（1）。于是 render 自己失败时整笔是 exit 1 且同时出现 INFRA 与 FAIL 两种结论，语义上「无法判定」被降级成「真失败」。
2. **G2 先查生产者再查 issue 引用**：于是「PR 正文既不引用 issue、门牌也没写完」报的是 `E_ISSUE_REFS`（真失败）而不是 `E_LAST_CHANGE_MISSING`（未就绪）。
3. **`--head` 恒优先于 `--pr` 的 head**：事件快照旧、现况文件新时，G3 的 stale 判断会拿旧 head 去比。
4. **`readJson` 用 `!path` 判「没提供」**：`--issue ""` 被当成没给，报「没有提供」而不是「读不到」。
5. **`resolvePrIssue` 只在 body 解析为空时才看 title**：body 有一个引用、title 另一个时不报「多个引用」。
6. **同名「最新」按 id 数值比**，不是时间戳；id 若来自不同来源不保证单调；平手取后出现的那条。

**运行时方言第三次咬人（这次是 stdout 里的 JSON.parse 文案）**：本地 Node 24 的 JSON.parse 报错带 (line L column C)，CI 的 Node 20 不带，于是 E_EVENT_UNPARSABLE 与 E_INPUT_UNPARSABLE 两个夹具在 CI 红、本地绿。修法与阶段 A/B 同口径：比对前把坐标后缀从两侧摘掉（position N 的数字仍比），并**单独断言「Go 侧只要报了 at position 就必须带坐标」**——否则两侧都摘成空等于什么都没比。代价是 line/column 的数值不再参与比较（实测：把 column 改 +1 仍绿，把 column 写成 col 则 2 红），position 的数值仍比。
这些都在 parity 夹具里以「照原样复刻」的形式钉住了——**先复刻再议**，改语义是另一件事（阶段 D 之后再单独决定）。
**第二次发生（阶段 C 的 #86，2026-10-26）**：PR #87 基分支是 `main`，`Fixes #86` 生效、issue 被关，标签又停在 `state:in-progress`。同一个缺口第二次咬人，说明它不是一次性事故。

顺带看清了它的**后果不只是显示难看**：门 G1 拿标签去咨询转换表，标签停在 `state:in-progress` 的已关单看起来「还能被合并带到 done」，于是 G1 会对一个已经关掉的 issue 判 PASS。也就是说，缺口的真实风险是**门可能把已关单当成在途单放行**，而不只是标签不准。

两条修法与最终取舍见 §十二：给 `issues.closed` 建意图（已落地），把自动关单挪进写者不做。

## 十一、阶段 D1 落地记录（CI 与 npm 脚本切到 Go 引擎）

阶段 A/B/C 让 Go 有了全部判据，但调用点还在 Node——冗余没真正消掉。D1 把 8 个生产调用点指向 `./.cache/bin/engine`：

| 调用点                       | 命令                                                                             |
| ---------------------------- | -------------------------------------------------------------------------------- |
| `merge-gate.yml` collect     | `./.cache/bin/engine merge-gate --event … --pr … --print-issue`                  |
| `merge-gate.yml` gate        | `./.cache/bin/engine merge-gate --event … --pr … --issue … --checks … --infra …` |
| `state-writer.yml` resolve   | `ISSUE="$(./.cache/bin/engine build-intent --resolve-issue)"`                    |
| `state-writer.yml` intent    | `./.cache/bin/engine build-intent > intent.json`                                 |
| `state-writer.yml` validate  | `./.cache/bin/engine validate --intent intent.json --json`                       |
| `state-writer.yml` record    | `./.cache/bin/engine writer-record --verdict verdict.json --issue "$TARGET"`     |
| `last-change.yml` render     | `./.cache/bin/engine last-change --in body.in.md --out body.out.md`              |
| `package.json` `check:state` | `npm run --silent build:engine && ./.cache/bin/engine check-config`              |

构建入口只有一个：`build:engine`（`cd apps/engine` + `go build -o ../../.cache/bin/engine ./cmd/engine`，GOPATH/GOCACHE 指仓库 `.cache`；`.cache/` 早已在 .gitignore，产物不进仓库）。三个 workflow 各在 `npm ci` 之后加 `actions/setup-go@v5`(1.22) + `npm run build:engine`；`check` 链未变，故一次 check 只构建一次。仍用 Node 的只剩审计六件套、kb-sync、copy-dist、cli 与内联 `node -e/-p`，所以 `setup-node` 全部保留——**零 Node 属 D2，不是本阶段**。

### 等价性（25 组，同 cwd/env/fixture，比 stdout+stderr+退出码+写出文件）

22 组逐字节相同（含 10 条失败路径，0/1/3 三种退出码全覆盖）；3 组差异全部落在**已登记**的例外界内：`build-intent` 的 `EVENT` 非 JSON ×2（Node 语法栈）、`check-config` 坏 YAML（js-yaml 与 yaml.v3 文案不同，verdict/code/前缀/退出码相同，`tests/engine-parity.test.mjs` 已钉服务契约，`apps/engine/README.md` 例外清单补登）。

### 我补的第四条门：`tests/engine-wiring.test.mjs`（9 例）

执行器交付时自报两条「接线无覆盖」，我复现后确认实际是**四种静默形态**，全在改动后仍 105 例全绿：① `check:state` 退回 `node scripts/state-validate.mjs`；② 构建步挪到 `setup-go` 之前；③ 删掉构建步；④ 构建步换成 `echo skipped`。②③④ 在运行时会表现成 127（会红，但红在 CI 不在测试），① 是真静默——全绿而 Node 又回来了。

新用例只盯这一条链，且每条都能被单个改动打红：`build:engine` 是唯一入口且产物落 `.cache/bin`；`check:state` 走引擎不走 node（`check` 链仍含 `check:state`/`check:engine`）；扫描面非空且恰好是三家调用引擎的 workflow（扫描落空也要红）；每个调用引擎的 job 里 setup-go < 唯一构建步 < 首次引擎调用；没有谁把调用点换回 `node scripts/*.mjs`；构建步不许 `continue-on-error`；`go-version` 钉 `1.22`。

七组变异全部见红：check:state 退回 node（1）、构建步前移（1）、删构建步（1）、改 echo（1）、加 `continue-on-error`（1）、`go-version` 改 1.21（1）、三家调用点全换回 node（2）。还原 9 绿，整仓 `npm run check` exit=0（21 文件 / 665 用例）。

### 仍然存在的边界

- 构建真失败时表现为运行时 127（CI 红、测试不红）：静态判据只能证明「该建的地方有建」，证不了「建得出来」。
- workflow 里仍有内联 `node -e/-p`（取 check runs、拼 JSON），所以运行时依赖 Node 只是变少，没有消失；要归零得把这些也搬到引擎，属 D2。
- `tests/helpers/engine.mjs` 用 mtime 判新鲜：Go 源比二进制新就重建。时钟异常或跨机器搬运二进制会误判，代价是多一次 `go build`。
- `cache:false`（与 `check.yml` 现状一致）每次下载 Go 工具链，换来的是不受缓存键漂移影响。

## 十一·补、阶段 D1 的 CI 红：文本扫描器把编译产物当源码读

切到 Go 引擎后 PR #89 的 `check` 红了九条断言，全部一个根：`tests/audit-findings.test.mjs` 的 workflow 扫描器把 `./.cache/bin/engine` 当成被引用的脚本，用 utf8 把 4 MB 二进制读进了判据面。CI 上因此报出 669 条「写结论」violation，`excerpt` 全是乱码；本地同一份代码全绿——本地构建的二进制里没有能命中的字节，于是「同一份判据 + 同一个文件」在两个环境给出相反结论。

判断：文本扫描器读二进制，两个方向都不成立——随机字节可能被当成命中（假红），真写面也可能藏进读不出来的字节里（假绿）。所以正确的修法不是「让本地也红」，而是**这类文件根本不该进文本判据面**。

修法（只改 `tests/audit-findings.test.mjs`）：

- `isBinarySource()`（读前 8 KB，含 NUL 即判二进制）把二进制挡在扫描面外，改记 `binary-source` gap；
- 该 gap 不计入 violation，也不计入「命中写面的文件」；
- 新增 `workflowBinarySourceGaps()`，在真仓库用例里断言被跳过的恰好是 `.cache/bin/engine`（只有构建过引擎才做精确断言，未构建不失败）——**跳过不等于没看见**。

学到的三条：

1. 判据的输入面必须先回答「这是不是文本」，否则同一份判据会在不同机器上给出不同答案。CI 红、本地绿这种分歧，多半是环境把判据的某个假设改掉了，而不是环境有 bug。
2. 变异能证明「断言在承重」，证不了「它读的东西在两个环境里是同一类东西」。
3. 三组变异留存：`isBinarySource` 恒 false → 1 红；gap 允许计入 violation → 10 红；`stepTexts` 不跳过 → 1 红；还原后 199 绿，整仓 665 绿。

## 十二、阶段 D2 落地记录（Node 调用面收进引擎 + §九 收口）

D2 的原计划是「删 `.mjs`、parity 转 golden、去掉剩余 Node 依赖」。实际做的是**先把行为搬进 Go 并切换能切干净的那部分调用点**，`.mjs` 一份没删——理由见下面「用户裁决」第 4 条。

### 12.1 逐文件交付

| 文件                                                  | 行数      | 子命令           | 内容                                                                                                                 |
| ----------------------------------------------------- | --------- | ---------------- | -------------------------------------------------------------------------------------------------------------------- |
| `apps/engine/auditfindings.go`                        | 新增      | `audit-findings` | 审计口径层：schema 校验、多执行器 verdict 归一、两槽逐条比对、Check conclusion（0 pass / 1 不合格 / 3 INFRA）        |
| `apps/engine/auditslot.go`                            | 新增      | `audit-slot`     | 槽位落盘 + 自报身份与槽位一致性校验                                                                                  |
| `apps/engine/routing.go`                              | 新增      | `routing`        | 路由真源自洽 + 扫 workflow 硬编码模型名                                                                              |
| `apps/engine/auditcollect.go`                         | 新增      | `audit-collect`  | 编排：预检 → dispatch → 轮询 run → 回读 Check Run                                                                    |
| `apps/engine/auditreview.go`                          | 新增      | `audit-review`   | 一个槽一次模型调用，落契约形状 findings                                                                              |
| `apps/engine/copy_dist.go`                            | 114       | `copy-dist`      | `apps/web-vue/dist` → `apps/api-go/dist`                                                                             |
| `apps/engine/cli_tool.go`                             | 722       | `cli`            | 接入层五个命令 + 显示宽度算表格                                                                                      |
| `apps/engine/kbexport.go`                             | 803       | `kb-export`      | 知识库汇入清单（sha256 幂等、白名单、累积继承、INFRA 重试）                                                          |
| `apps/engine/cli.go`                                  | +24       | —                | 注册上述 8 个子命令与 `EngineUsage` 行                                                                               |
| `apps/engine/config.go`                               | +34       | —                | `(*Config).ClosedTerminalTargets()`：只认 `by=ci`、目标是 terminal、排除 `from="*"/"none"`                           |
| `apps/engine/intent.go`                               | +54       | —                | `issues + closed` 分支（见 12.4）                                                                                    |
| `apps/engine/mergegate.go`                            | +16       | —                | `mergeGateIssueClosed` + G1 的 `E_ISSUE_CLOSED_IN_FLIGHT`（见 12.4）                                                 |
| `apps/engine/closed_intent_test.go`                   | 新增      | —                | 7 个 Test：关单意图四种形状 + 带守卫终态 + G1 关单拒绝                                                               |
| `scripts/build-intent.mjs` / `scripts/merge-gate.mjs` | +56 / +11 | —                | 对照物同源落地（parity 需要两侧都能跑出新行为）                                                                      |
| `package.json`                                        | +6/-6     | —                | `check:web` / `web:dist` / `cli` 改指 `./.cache/bin/engine`                                                          |
| `.github/workflows/kb-sync.yml`                       | +11       | —                | `npm ci` 后插 `actions/setup-go@v5`(1.22) + 无名 `npm run build:engine`；export 步改 `./.cache/bin/engine kb-export` |
| `tests/engine-parity-d.test.mjs`                      | 新增      | —                | 50 条（见 12.2）                                                                                                     |
| `tests/engine-parity-e.test.mjs`                      | 新增      | —                | 37 条（见 12.2）                                                                                                     |
| `tests/build-intent.test.mjs`                         | 41→50     | —                | 关单意图的四种形状 + 带守卫终态                                                                                      |
| `tests/state-writer-wiring.test.mjs`                  | 16→19     | —                | `on.issues.types` 含 `closed`、意图步读得到 `ISSUE_STATE_FILE`                                                       |
| `tests/merge-gate.test.mjs`                           | +3        | —                | G1 已关闭+非终态 → 拒；未关闭仍 PASS；缺 `state` 按未关闭判                                                          |
| `tests/engine-parity-b.test.mjs`                      | 55→59     | —                | 3 条关单意图 parity + 1 条新登记例外                                                                                 |
| `tests/engine-wiring.test.mjs`                        | +1        | —                | 期望集合加 `kb-sync.yml`（仍 `toEqual`）                                                                             |
| `tests/kb-export.test.mjs`                            | +14/-7    | —                | 钉 `./.cache/bin/engine kb-export` 且 `not.toContain("node")`；沙箱改用 `tests/helpers/engine.mjs`                   |

边界：`.github/workflows/audit.yml` 一字符未动（理由见 12.5）。

### 12.2 parity 覆盖（四套，实测）

| 套                               | 条数 | 结构                                                                                                                                                        | 说明                                                                  |
| -------------------------------- | ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `tests/engine-parity-c.test.mjs` | 47   | 46 fixture + 1 条数量断言                                                                                                                                   | 阶段 C 的 merge-gate                                                  |
| `tests/engine-parity-b.test.mjs` | 59   | 22 build-intent + 19 last-change + 13 writer-record + 5 已登记例外                                                                                          |                                                                       |
| `tests/engine-parity-d.test.mjs` | 50   | 48 fixture + 2 条数量/例外断言；夹具 8 audit-findings + 6 audit-slot + 7 routing + 7 audit-collect + 20 audit-review；失败路径 33 条，退出码 0/1/2/3 全覆盖 | `gh` 与模型上游都是替身（上游是另一个进程里的假 `/chat/completions`） |
| `tests/engine-parity-e.test.mjs` | 37   | 3 copy-dist + 10 kb-export + 19 cli + 3 条「引擎都是真跑出来的结论」+ 2 条调用点钉住；失败路径 16 条                                                        | 后端是另一个进程里的假 `apps/api-go`；kb-export 在真 git 仓库上跑     |

对照手法与前几个阶段一致：同一批输入同时喂两侧，比 stdout 逐字节 / stderr / 退出码 / 写出文件 / 打到上游的请求体。

### 12.3 非逐字节例外（D2 新增，全部写成显式归一）

| #   | 例外                                                                      | 归一方式                                                              |
| --- | ------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| 1   | 路由声明的 YAML 解析器文案（`npm yaml` vs `yaml.v3`）                     | 只比前缀「路由声明不是合法 YAML: .agents/platform/routing.yml: 」     |
| 2   | 网络栈文案（`fetch failed` vs `dial tcp …: connect: connection refused`） | 只比前缀「调用上游失败（没拿到响应）：」                              |
| 3   | `cli` 连不上后端（`connect ECONNREFUSED 127.0.0.1:1` vs `dial tcp …`）    | 只比前缀「连不上后端 <origin>: 」                                     |
| 4   | `issues.closed` + 两个终态标签的 fail-closed 报错                         | 登记进 `tests/engine-parity-b.test.mjs` 的 `KNOWN_DIVERGENCES`（4→5） |

归一的写法是「按固定前缀截断后只比前缀」而不是「整段跳过」——例外仍然要求两侧同一个 code、同一个退出码。

### 12.4 §九 的缺口：怎么修的、为什么这么修

**落地**：`issues.closed` 现在产生意图。

- 候选来源：`(*Config).ClosedTerminalTargets()` 只把 `by=ci` 且目标是 terminal 的转换当候选，排除 `from="*"` 与 `from="none"`——owner 裁决出来的终态不自动落。
- 判定分支（两侧同源）：没有 `state:*` 标签 → 无意图；同时带两个标签 → fail-closed；候选为空 → 无意图；恰好一个候选 → `to=该终态`、`actor_role=ci`；多个候选 → fail-closed。
- 带守卫的终态在关单事件上必然 `E_GUARD_MISSING` → 写者留痕、标签不动、job 绿。这是**如实交出去**，不是漏：门那边由 G1 兜住（下条）。

**G1 也补了判据**（用户裁决 1）：门现在读 `issue.state`，已关闭 + 非终态标签 → `rejected / E_ISSUE_CLOSED_IN_FLIGHT`，文案点名成因；输入里没有 `state` 时不当作已关闭（门不靠猜补输入）。两侧各一份：`mergegate.go` 与 `scripts/merge-gate.mjs`；测试分别由 `apps/engine/closed_intent_test.go` 与 `tests/merge-gate.test.mjs` 覆盖。

**为什么不选另一条**（把 `Fixes #N` 的自动关单挪进写者）：自动关单发生在 GitHub 侧，写者拦不住、也没法在测试里复现；而 `Fixes #N` 这个引用语法是 merge-gate G2 的前置判据，挪走会打坏 G2。代价是「关单事件与标签落定」仍在时间上脱钩，所以 G1 的判据是配套而非可选。

### 12.5 用户裁决（4 条，逐条落地）

| #   | 裁决                                                                                | 落地                                                                                                               |
| --- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| 1   | G1 加「已关闭的 issue 不得判在途」                                                  | `mergegate.go` + `scripts/merge-gate.mjs` + `tests/merge-gate.test.mjs` 3 条新 test + `closed_intent_test.go` 断言 |
| 2   | 阶段 D3 切 `audit.yml` 到引擎二进制**之前**必须补等价判据（不接受「证明责任降级」） | D2 轮内 `audit.yml` 一字符未动；7 条前置清单见 12.7，已在阶段 D3 逐条收口（§十三）                                 |
| 3   | workflow 沙箱内真构建引擎（照其他三个 workflow 的无名 `setup-go` + build 做法）     | `kb-sync.yml` 加 `actions/setup-go@v5`(1.22) + 无名 `npm run build:engine`，wiring 测试期望集合同步                |
| 4   | `scripts/*.mjs` 保留，等引擎在 `main` 上跑稳再删；parity 仍以它们为黄金基准         | 一份没删；`tests/engine-parity*.test.mjs` 继续双侧对照                                                             |

### 12.6 变异验证（12 组，全部见红，均在 `/tmp` 副本做）

| 组       | 变异                                | 红数                                             |
| -------- | ----------------------------------- | ------------------------------------------------ |
| audit-1  | `auditfindings` 的 INFRA 退出码改错 | 4                                                |
| audit-2  | `auditreview` 的 blocker 判定失效   | 1                                                |
| audit-3  | `auditcollect` 的 failure 结论失效  | 1                                                |
| audit-4  | `routing` 词边界失效                | **首轮 0 红**，补 `rt-word-boundary` 夹具后 1 红 |
| intent-1 | 关单分支整体失效                    | go 3 + vitest 3                                  |
| intent-2 | 多个终态取第一个                    | go 1                                             |
| intent-3 | 两个标签不 fail-closed              | go 1                                             |
| intent-4 | 去掉 `by=ci` 过滤                   | go 2                                             |
| intent-5 | Node 侧关单分支失效                 | vitest 6                                         |
| port-1   | `kb-sync.yml` 改回 `node`           | 3                                                |
| port-2   | wiring 期望里删 `kb-sync.yml`       | 1                                                |
| port-3   | 沙箱不给引擎二进制                  | 1（`expected '127' to be '3'`）                  |

门（各自实测真退出码）：`gofmt -l` 空、`go vet ./...` 0、`go test ./...` 0；三条交付线交付时的整仓 `npm run check` 均 exit=0（t3 交付时 23 文件 / 772 用例）。

### 12.7 教训与未关面

**教训**

1. **软链会让 parity 假绿**：JS 那份 `copy-dist.mjs` 只在 `process.argv[1]` 与 `import.meta.url` 相等时执行主体，而 macOS 的 `/var` 指向 `/private/var`、ESM loader 会把 `import.meta.url` 解成真实路径——沙箱目录不 `realpath` 就出现「两侧都没有输出」的假绿（`tests/engine-parity-e.test.mjs` 已 `realpathSync`）。这是「两侧同样失败被当成一致」的第四次同款。
2. **夹具形状单一 ＝ 判据半个身子没测**（第三次）：`routing` 词边界那组首轮 0 红，因为夹具里没有能区分「按词边界」与「按子串」的样例；补一条才咬住。
3. **变异必须在副本上做**：用 `PARITY_ENGINE_DIR` 指向 `/tmp` 里改过的引擎，仓库里的对照物保持原样，否则「黄金基准」被自己改坏。
4. **真仓库探针会留外部痕迹**：验证 G1 时对真仓库 issue #85 发过一条评论（`issuecomment-6418895158`）。探针要么走 dry-run，要么接受留痕。

**未关面（登记在案，不在本轮做）**

- `cli` / `kb-export` 的 `USAGE` 文案仍写 Node 载体名（`node scripts/cli.mjs …`）：parity 比字节，改文案两侧要一起改，单独一轮处理。
- `tests/engine-parity-c.test.mjs` 的 issue 夹具不带 `state`：G1 的 `E_ISSUE_CLOSED_IN_FLIGHT` 不在 Go↔JS parity 面内，两侧一致性只由 `closed_intent_test.go` 与 `tests/merge-gate.test.mjs` 各自保证。
- `audit.yml` 切到引擎（阶段 D3）的前置：`tests/audit-findings.test.mjs` 里对 `scripts/audit-findings.mjs` 的字面量断言、`resultWriters` 的「唯一生产者」断言、回放沙箱里没有 `.cache/bin/engine`、以及 `binary-source` 口径（二进制产物会被文本扫描器跳过）。这几条都属判据口径变更，要按用户裁决 2 先补等价判据。**已在阶段 D3 收口**（§十三）：13 条既有断言等价重写或换注入点、无一条删除；判据改为按「这一次调用」放行并由 `--explain` 自证，放行名单与契约各自被用例与变异钉住。
- `kb-export` 的白名单/排除项三处同口径（`scripts/kb-export.mjs` / `apps/api-go/kb.go` / `apps/engine/kbexport.go`），三份表的对照在 `tests/kb-allowlist-parity.test.mjs`；变量名与正则写法各不相同，改动必须三处一起动。

## 十三、阶段 D3 落地记录（`audit.yml` 的判定步切编译产物 + 自证声明）

### 13.1 切了什么

**workflow 侧**（`.github/workflows/audit.yml`）：

| 位置 | 改动 |
| ---- | ---- |
| 「安装依赖」之后 | 新增 `actions/setup-go@v5`（`go-version: "1.22"`）与「构建引擎」步（`npm run build:engine`），与其余四家调引擎的 workflow 同形态 |
| 判定步 | `node scripts/audit-findings.mjs --a .audit/review-a.json --b .audit/review-b.json --out .audit/result.json` → `./.cache/bin/engine audit-findings --a … --b … --out …` |

构建步的位置是判据的一部分：产物必须由**这个 workflow 自己**在调它之前建出来。少了它，「能不能合」那一步会在 CI 上以 `No such file or directory` 失败，而那是管线故障、不是「判不了」——两者在 check-run.json 里必须分得开。

**引擎侧**：

| 文件 | 改动 |
| ---- | ---- |
| `apps/engine/auditfindings.go` | 新增 `AuditFindingsExplain() *Value`：机器可读地声明 `subcommand` / `args` / `reads` / `writes` / `source` / `exitCodes`（走 `value.go` 的保序编码器 `EncodeIndent(2)`，键序稳定）；`RunAuditFindings` 开头 `if hasArg(argv, "--explain")` → 打印声明并退 0 |
| `apps/engine/cli.go` | `EngineUsage` 的 `audit-findings` 行补「`--explain` 打印它读什么 / 写什么 / 退出码语义」 |
| `apps/engine/README.md` | 状态行改为「阶段 D3 起 audit.yml 判定步也调编译产物」；用法补 `[--explain]`；新增 P-31 阶段 D3 的迁移注记 |

`--explain` 的实测输出（`./.cache/bin/engine audit-findings --explain`，exit 0）：`subcommand=audit-findings`、`args=[--a,--b,--out]`、`reads=[--a,--b]`、`writes=[--out]`、`exitCodes={0: 有结论且结论是 pass, 1: 有结论且结论是 needs_revision / reject, 3: 判不了（INFRA）}`、`source=[scripts/audit-findings.mjs]`。

**测试侧**：`tests/audit-findings.test.mjs` 的判据改造（见 13.3、13.4）+ 5 条 D3 用例；`tests/engine-wiring.test.mjs` 的「调引擎的 workflow」名单 +1（`audit.yml`）——这是切换的**连带判据**，不是放宽。

### 13.2 为什么要自证，而不是「换个二进制就完了」

t6 的原话要点：

> **D3 的价值不在换成二进制，而在二进制也要有可对账的声明**：`--explain` 的声明必须同时与调用点 argv、与实现行为各对一次账，否则就是声明自证声明。

代价是实测出来的，不是推测：这一行换掉之后，冻结的 `tests/audit-findings.test.mjs` 从 199 passed / exit 0 变成 **29 failed | 170 passed / exit 1**；把引擎塞进 wiring 沙箱后仍有 **13 failed | 186 passed**。这 13 条不是「测试写得脆」，是三类真实的口径缺口：

1. 扫描面对**二进制执行体**一律默认拒绝（9 条）：`binary-source` 只在「二进制当被扫的数据源」时被容忍，当执行体时落进兜底文案「执行面跟不下去：按默认拒绝」。
2. 「口径层崩溃兜底」「空 conclusion 不许互证」这两类行为**在二进制下无法再注入与观测**（2 条）。
3. 判据直接从文本里推导（写死的旧命令、读者/产出者由 import 图推导）（2 条）。

于是三件事一起做：引擎自证（`--explain`）、判据按**这一次调用**放行（`sanctionedContractHolds`）、每次跳过留账（`noteBinarySkip` / `takeBinarySkips`）。

### 13.3 判据是怎么保持严格的

- **放行粒度是「那一次调用」，不是文件名**：`SANCTIONED_CONTRACT` 记 `{subcommand, argv}`，`sanctionedContractHolds(argv)` 先比 `words[0]` 再逐词比 `argv`——多一个参数、少一个参数、换个子命令、换条路径，全部退回默认拒绝。**放行名单本身**也有用例对账：它必须与调用点那一次 argv 逐词相等，不许是手抄的副本。
- **声明与实现各对一次账**：① 声明 ↔ 调用点：`shellCommands(decide.run)` 里 `./.cache/bin/engine` 那一次的 argv 与 `--explain` 的 `subcommand`/`args`/`reads`/`writes`/`exitCodes` 逐项相等，三个 option 的**文件名**也逐个对（`--a`/`--b`/`--out`）；② 声明 ↔ 实现：tmp 目录写两份 findings，真跑产物，断言退出 0、`readdirSync(dir).sort()` **恰好**三份（声明说只写 `--out`，就该只有它）、`out.json` 的 `verdict === "pass"`。声明与实现各有一条，缺一条就是自证自明。
- **每一次跳过都要留账，且 `why` 非空**：`noteBinarySkip(file, why)` 记账，`takeBinarySkips()` 的每一格 `why` 都要有内容——静默 `continue` 等于给「把执行体换成二进制」开一条谁都查不到的暗道。真 audit.yml 的判定步在扫描里产生的 gap 必须 `detail === ".cache/bin/engine"`、`sanctioned === true`、`why === BINARY_SKIP_WHY_SANCTIONED`。
- **源码模块由声明豁免，不由硬编码路径豁免**：`writers` 变成 `[".cache/bin/engine"]` 之后，`scripts/audit-findings.mjs` 会被当成「造字段名的读者」——根因是 `scripts/audit-review.mjs` 里 `import { validateResult } from "./audit-findings.mjs"`。解法是把「实现是谁」放进自证（`--explain` 的 `source`），判据按声明豁免（`isSanctionedSource`），而不是把路径写死进判据。
- **两条反面对照**（防「白名单变成万能钥匙」）：换子命令（`audit-slot`）与多一个参数（`--explain`）都仍必须是 `where === "binary-source"` 的违规；`sanctionedBinaryUse(".cache/bin/other", …) === false`；只被 `echo` 提及、没被执行，也不算放行。
- **扫描器本身没被放宽**：`workflowWriteSurfaceFiles()` 仍恰好是 `["audit.yml"]`，`workflowBinarySourceGaps()` 仍把 `.cache/bin/engine` 记成二进制 gap——只是这个 gap 带 `sanctioned` 标记，不是不记。

### 13.4 上一轮 13 条既有断言的处置：等价重写或换注入点，没有一条被删

| # | 断言在原处钉什么 | 本轮处置 |
| - | ---------------- | -------- |
| 1 | 判定步把结论交给 Check Run | 写死的 Node 命令改成写死**新调用**；另加一条更强的：放行名单必须与调用点 argv 逐词相等 |
| 2 | 「空 conclusion 不许互证」 | 注入目标从 `scripts/audit-findings.mjs` 搬到**产物**（`#!/bin/sh` 替身写 `{"verdict":"INFRA","conclusion":""…}`）；用例语义不变，另加「桩真被执行」marker，防「桩没跑到所以空绿」 |
| 3 | 兜底补的结果不是第二份口径层 | `fieldReadViolations` 增加「自证声明的源码模块」豁免；产物身份仍是 `.cache/bin/engine` |
| 4 | 口径层崩溃、result.json 没落地 | 同第 2 条：产物替身 `exit 70` + marker 断言 |
| 5–13 | 9 条「执行面跟不下去：按默认拒绝」 | 二进制扫描分支先算 `sanctioned`（按这一次调用比对声明契约）再决定放行，并把 `sanctioned`/`why` 写进 gap；`auditDirReferenceViolations` 只对 `sanctioned` 的二进制 gap 放行，未 sanction 的照旧是违规 |

结果：`npx vitest run tests/audit-findings.test.mjs` = **204 passed / exit 0**（切换前 199 条，另加 5 条 D3 用例）；`tests/engine-wiring.test.mjs` = 11 passed。

### 13.5 变异验证（8 组，全部见红）

| 组 | 变异 | 结果 |
| -- | ---- | ---- |
| M1 | 放行名单 argv 少一条（`--out`） | 红 1 |
| M2 | `sanctionedContractHolds` → `return true`（按文件名放行） | 红 1 |
| M3 | 删掉两处 `isSanctionedSource` 豁免 | 红 1 |
| M4 | 删掉「已 sanction 的二进制 gap 放行」那一行 | 红 1 |
| M5 | `noteBinarySkip` 的 `why` 置空 | 红 1 |
| M5b | gap 的 `sanctioned` 恒 `false`（二进制永远被拒） | 红 1 |
| M6 | 引擎 `--explain` 的 `source` 改指向 `scripts/routing.mjs` | 红 1 |
| M7 | 判定步退回 `node scripts/audit-findings.mjs …` | 红 1 |

前两轮 M1、M5 曾**逃逸**（M1 是断言只对「声明 vs 调用点」对账、放行名单本身没人对；M5 是账本 `why` 没有用例读）。本轮补了这两条不变式后不再逃逸——又一次印证 12.7 那条教训：**判据没被变异咬过就不算判据**。

### 13.6 未关面

- **`scripts/*.mjs` 本轮一份不删**（用户裁决）：引擎在 `main` 上跑稳之前，parity 仍以它们为黄金基准；`audit.yml` 切的是判定步的执行体，没删对照物。
- **`USAGE` 文案仍写 Node 载体名**（`node scripts/audit-findings.mjs …`）：parity 比字节，改文案两侧要一起改，单独一轮处理。
- **`--explain` 是声明，不是证明**：一个被改坏的引擎可以声明得漂亮而行为不同。目前只靠「按契约真跑一遍、只比落盘形态与结论」挡一层；更严的做法是在 Go 单测里直接钉 `AuditFindingsExplain()` 的字段，本轮没加（避免与 parity 用例重复记账）。
- **`.audit/*.json` 的读写面在 CI 上已不可文本扫描**：等价覆盖靠 `tests/audit-findings.test.mjs` 的静态判据与 `tests/engine-parity-d.test.mjs` 的 50 条行为对照，两者都在 `npm run check` 里。

### 13.7 验收（独立对抗验收，t12）

**结论：D3 这一刀可以放行——判定面收紧、无断言被削弱、无逃逸变异。**

验收人未改仓库（真仓只读快照 `/tmp/vd4`，变异在独立副本 `/tmp/vm4`，每组改完 `cmp` 还原），自跑门：`npm run check` exit=0 / 23 files / **786 tests**（与交付方声称一致，非转述）；`gofmt -l` 无输出、`go vet ./...` 与 `go test ./...` exit=0。共 10 组变异，**全部见红**（A1–A4、B1–B3、D1–D2、E1；红数依次 28/27/20/24/2/1/1/1/1/3）。

#### 13.7.1 放行粒度确实是「那一次调用」，不是文件名

每次只改判定步那一行，跑 `tests/audit-findings.test.mjs`（基线 204 passed）：

| 组 | 变异 | 结果 |
| -- | ---- | ---- |
| A1 | 路径对、子命令换成 `audit-slot` | exit=1，**28 failed** / 176 passed |
| A2 | 子命令对、行尾多一个 `--explain` | exit=1，**27 failed** / 177 passed |
| A3 | 行首加 `echo`（提及但不执行） | exit=1，**20 failed** / 184 passed |
| A4 | 二进制换成 `engine-copy` | exit=1，**24 failed** / 180 passed |
| E1 | 引擎调用**下一行再加回** `node scripts/audit-findings.mjs …`（两种载体并存） | exit=1，**3 failed** / 201 passed |

E1 是最值得记的一条：引擎那次已经逐词对了，残留的 node 调用仍然被判成第二份口径层（红在「兜底补的结果不是第二份口径层」等 3 条）。**半切换不会被整体放行** ——「这一刀切干净」本身是判据，不是结果。

#### 13.7.2 `--explain` 声明 ↔ 实现是真对账

变异改 Go 源码，**重建引擎**后再跑（`ensureEngine()` 会因 mtime 触发重建，这条链路本身也是被验的）：

| 组 | 变异 | 结果 |
| -- | ---- | ---- |
| B1 | `source` 改指 `scripts/merge-gate.mjs` | build=0，exit=1，**2 failed**：「声明的源码模块在仓库里，且它就是本用例 import 的那份判据」+「兜底补的结果不是第二份口径层」 |
| B2 | `args` 去掉 `--out` | build=0，exit=1，**1 failed**：「声明里的…与判定步的实际参数逐词一致」 |
| B3 | `exitCodes` 去掉 `3`（判不了/INFRA） | build=0，exit=1，**1 failed**：同一条 |

B1 尤其关键：`source` 不是抄死的常量，是被真读出来再对仓库核对的——改 Go 必须重建才生效，而重建后的偏差确实被抓到。

#### 13.7.3 既有断言没有被削弱

`expect` 计数（HEAD → 现在），6 个文件**无一处减少**：

| 文件 | expect | it |
| ---- | ------ | -- |
| `tests/audit-findings.test.mjs` | 1022 → **1057** | 199 → **204** |
| `tests/build-intent.test.mjs` | 125 → **143** | 0 → 0 |
| `tests/engine-parity-b.test.mjs` | 22 → 22 | 4 → 4 |
| `tests/engine-parity-c.test.mjs` | 15 → 15 | 2 → 2 |
| `tests/engine-wiring.test.mjs` | 19 → 19 | 6 → 6 |
| `tests/kb-allowlist-parity.test.mjs` | 5 → **12** | 3 → **7** |

被删改的 4 条「-侧」断言逐条定性——没有一条是「删掉少判一点」：

| # | 原断言 | 定性 |
| - | ------ | ---- |
| 1 | 判定步引用的脚本 `toContain("scripts/audit-findings.mjs")` | **换钉点**：判定步已不引用脚本，改钉仍在被执行的 `scripts/audit-review.mjs`；判定步的真实命令由新增 D3 用例逐词钉住 |
| 2 | `resultWriters(steps) toEqual(["scripts/audit-findings.mjs"])` | **等价重写**：仍是 `toEqual` 精确相等，只换载体为 `.cache/bin/engine` |
| 3 | 沙箱跳过集合 `NETWORK_STEPS = {"安装依赖"}` | **沙箱跳过面 +1**（见下，唯一一处扫描面变窄） |
| 4 | 两处注入桩（ESM 脚本 + `exit 70`/写 result.json） | **换注入点且加强**：改 posix `sh` 桩，并新增正向对照断言「桩确实跑过」（`stub-ran` 标记），老写法区分不了「桩没跑到」与「桩跑了但没写」 |

**唯一一处扫描面变窄**：`SANDBOX_SKIPPED_STEPS` 由 1 项（`安装依赖`）扩为 2 项（+`构建引擎`）。理由：构建步在沙箱里不再真跑（`beforeAll` 已真跑一次、`engineInto` 复制同一份），否则 133 条用例各建一次引擎。补偿只在 `tests/engine-wiring.test.mjs` 的单条顺序用例。

#### 13.7.4 workflow 层顺序与「删步」对抗

真仓 `audit.yml` 的实际顺序：`node`（setup-node）→ `安装依赖` → `setup-go`（`actions/setup-go@v5`, `go-version "1.22"`）→ `构建引擎`（`npm run build:engine`）→ `口径层判定`（`./.cache/bin/engine audit-findings …`）。构建步与 setup-go 都在判定步之前，顺序正确。

| 组 | 变异 | 结果 |
| -- | ---- | ---- |
| D1 | 删掉「构建引擎」步 | `tests/engine-wiring.test.mjs` **1 failed / 10 passed**；`tests/audit-findings.test.mjs` **204 passed（不红）** |
| D2 | 删掉 `setup-go` 步 | `tests/engine-wiring.test.mjs` **1 failed / 10 passed** |

`tests/engine-wiring.test.mjs` 的 workflow 名单仍 `.sort()).toEqual([...5 项])` 精确相等，没有放宽成包含；本次只是 +1 元素（`audit.yml`）。

#### 13.7.5 还没被钉住的面（低危、不阻塞、本轮不改）

1. **单跑 `tests/audit-findings.test.mjs` 看不见构建前置**：删掉「构建引擎」步它仍 204 passed（D1 实测），这个面只由 `tests/engine-wiring.test.mjs` 那一条顺序用例兜。谁把那一条的断言挪走，`audit.yml` 的构建前置就会静默消失。
2. **步名与沙箱跳过集合字符串耦合**：`SANDBOX_SKIPPED_STEPS` 认的是步名 `构建引擎`，改名后沙箱会去真跑构建（慢，但不红）。顺序判据按 `run: npm run build:engine` 的内容与位置判，这点是够的。
3. **`tests/engine-wiring.test.mjs` 的 it 标题仍写「恰好是三家」**，而列表已是 5 项。纯文案，不影响判定（本轮只记录，不改测试）。
4. **sanction 只认 `.cache/bin/engine` 这一个字面路径**：将来改用绝对路径或 `sh -c` 包裹会被判成 unsanctioned 违规。方向安全（fail-closed），届时该改契约而不是改放行口径。
5. **`vi` 在 `tests/audit-findings.test.mjs` 两侧都是 0 使用**（既有冗余，oxlint 未报，非本轮引入）。
6. **`USAGE` 文案仍写 Node 载体名**（13.6 已登记，未变化）。

验收方法学有一条值得固化：本轮探针**两次假绿**（B1 首版嵌套引号导致替换未落盘、B3 首版 `\n` 变成真换行导致 SyntaxError，两次都读到 204 passed）。规则因此定为「改后行必须与改前不同（grep 打印 + `cmp` 还原），否则不算变异」——与 13.5 的「判据没被变异咬过就不算判据」是同一条教训的两面。

证据：`/tmp/p31d3-verify.md`（166 行，含逐组日志路径）、`/tmp/v4-check.log`、`/tmp/v4-mut-{A1..A4,B1..B3,D1,D2,E1}.log`。

## 十四、阶段 D4 落地记录（parity 与冻结 golden 比对）

### 14.1 为什么先做这一步

计划表里「D：删已迁移的 `.mjs`」一直没做，真实原因不是没空，而是**验收闸门自己依赖被删的对象**：五个 parity 套件那时是「同一 fixture 同时跑 Node 入口与 Go 入口，逐字节比」。只要 parity 还要执行 `scripts/*.mjs`，删脚本就等于删掉自己的参照物。所以顺序必须是：先把期望值**变成数据**，再谈删载体。

### 14.2 落成了什么

| 件 | 说明 |
| --- | --- |
| `tests/goldens/{a,b,c,d,e}/*.json` | 235 条冻结期望（46/59/50/48/32），单条含 argv、env 归一签名、断言口径、exitCode、stdout、stderr、写出的文件、上游请求 |
| `tests/goldens/index.json` | suite → 条数与 case id 列表，不含时间戳（重冻必须逐字节相同） |
| `tests/goldens/parity-cases.mjs` | 五套夹具的唯一来源（97KB） |
| `tests/goldens/freeze.mjs` | **唯一**显式冻结入口，也是全仓唯一还知道 `scripts/*.mjs` 路径的地方 |
| `tests/helpers/parity-golden.mjs`、`parity-suite.mjs` | golden 读写比对 / vitest 驱动 |
| 五个 `tests/engine-parity*.test.mjs` | 各缩成 8 行 driver（E 另留 2 条调用点接线断言） |

测试路径**不再执行任何 `scripts/*.mjs`**：期望值入库即数据，`grep process.execPath tests/engine-parity*.mjs` 零命中。

### 14.3 冻结时最容易被忽略的一步：归一化

第一版 golden 把机器指纹冻进去了——`PATH`/`HOME`/tmpdir 的绝对路径、仓库绝对路径、Node 栈里的 `file://…`、随机 `.tmp-N` 后缀、索引里的时间戳。这样的期望值换一台机器就红，而且红得没有信息。归一化（`<REPO>`/`<WORK>`/`<PATH>`/`<HOME>`/`<TMP>`、`.tmp-N → .tmp-<N>`、去掉时间戳）之后才做到**在另一个 checkout 全量重冻与仓库内 golden `diff -r` 逐字节一致**——这条是 golden 能不能当数据的关键，不是洁癖。

### 14.4 唯一实质降级点（登记）

B 套 5 条 `KNOWN_DIVERGENCES`（Node 侧抛未捕获异常）改成 `pattern` 口径：仍钉退出码与 Go 侧 stderr 前缀，但「Node 侧 stderr 必须含 `SyntaxError`/`TypeError`」这半边不再断言——Node 侧已不在测试路径上，没有可比对象。补偿是 `freeze.mjs` 的 Node 侧自检（`nodeStderrContains`）在冻结时确认参照物真的打中了它声称的分支，冻结产物本身不依赖运行时。

### 14.5 变异表（均在与仓库无关的 `/tmp` 副本）

| 变异 | 结果 |
| --- | --- |
| `mergegate.go` 的 `Verdict: "PASS"` → `"PASSED"` | C 套 39 红 |
| `auditfindings.go` 的 `action_required` → `action-needed` | D 套 4 红 |
| 篡改 `goldens/d/d-05.json` 一个字节 | 1 红 |
| 删掉某条 golden | 1 红，报「golden 不存在…确需重冻请显式运行 node tests/goldens/freeze.mjs」 |
| 删掉整套 golden 后跑测试 | 240 红，且跑完**没有任何文件被补回来**（默认路径不写 golden） |
| `kbexport.go` 清单头改一个字符 | E 套 5 红 |

### 14.6 仍未关

`scripts/*.mjs` 与钉它们实现细节的 Node 套件仍在（约 690 例）。**删脚本的前提已解除，但删之前必须先把这些用例移植成 Go 单测**——直接删等于同时删掉 690 条验证，只剩 95 条 golden 对照与 24 条 Go 单测，那是撤闸不是清场。移植按模块增量做，每移植完一个模块才删它对应的那一份。

### 14.7 第一轮 CI 就红了：本地全绿不等于跨机器绿

PR #95 的 `check` 红在一条只有 CI 能看见的差异上：

```text
期望: ... out=/private<ROOT>/out/record.json
实际: ... out=<ROOT>/out/record.json
```

根因：旧归一化按 `[dir, realpath(dir)]` 顺序替换。macOS 上临时目录经 realpath 是 `/private/var/folders/…`，先吃掉 `/var/folders/…` 那一截，就只剩 `/private<ROOT>`；Linux 上没有这层前缀，于是同一份 golden 在两台机器上要求两种输出。

**「换一个 checkout 重冻、`diff -r` 一致」为什么没挡住它**：那是在同一台 macOS 上做的，只能证明路径无关，证明不了操作系统无关。同一台机器上的两类路径形态必须同时被覆盖，才是可移植。

修法：`pathVariants` 对每个根取 `[root, realpath(root)]`，每种再补一个 `/private` 孪生（双向：去前缀 / 加前缀），合并成一张映射并**按长度降序**替换，长的先吃，前缀不会残留。

永久判据（默认在测试路径上，五个 suite 每次都跑）：`scanGoldenHygiene()` 扫 `tests/goldens/**/*.json`，命中 `/private`、`/var/folders/`、`/Users/`、`/home/`、`/tmp/`、Windows 用户目录即红并点名文件与片段；同一用例内另有单元级断言（`/var/folders/x` 与 `/private/var/folders/x` 必须归到同一占位符、symlink 化的 TMPDIR 两种写法必须等价）。

独立性验证：把 `pathVariants` 打回旧行为 → 单元断言立刻红（`expected '/private<ROOT>/a.json' to be '<ROOT>/a.json'`）；把 `TMPDIR` 指到 symlink 目录（`/tmp/tmplink -> /tmp/tmpreal`，与 macOS 上 `/tmp -> /private/tmp` 同形）全量重冻 → 与仓库内 golden `diff -rq` **零差异**。

重冻 diff 只动了 16 个 `d/` 文件，差异只有 `/private<ROOT>` → `<ROOT>` 一类；`a/b/c/e` 与 `index.json` 零变化——说明修的是漏掉的那类形态，不是顺手改期望值。

## 十五、E2 第一批：writer-record 判据搬进 Go，脚本与其 Node 套件同时删除

路线仍按 §14.6 定的顺序：一个模块一批，判据先搬、搬完再删，删除之后闸门不能变松。这一批是第一个样本，因为它最小且 CI 已无调用点。

### 15.1 搬了什么

9 条 Node 用例（`tests/writer-record.test.mjs`，164 行）→ 11 条 Go 单测（`apps/engine/writer_test.go`，272 行）：函数级钉正文逐字与退出码，CLI 级经 `Run(["writer-record", ...])` 走 `cli.go` 的 case 表，并用假 `gh`（`PATH` 前置 + 脚本把 `$*` 追加进 `calls.log`）钉「一次都没被调用」与逐字 argv。

13 条 CLI 形状本来就已由 `tests/goldens/b/b-42…b-54` 冻住，删除参照物不影响默认测试路径——这正是先做 E1 的理由。

### 15.2 两处无法等价表达，如实降级（不是静默）

- 「要留痕却没有 issue 号时不发到 0 号上」：Node 侧注入 `comment` 回调断言「根本不调用」；Go 侧 `postComment` 直接 exec `gh`，没有可注入边界。等价物改成 CLI 边界——假 `gh` + 断言 `calls.log` 零字节 + stderr 原文 + exit 1。断言层从「注入的函数没被调」平移到「gh 进程没被起」，强度不减但不同层。
- 「认不出的判定结果」：Node 断言抛异常类型；Go 无异常类型，等价物是 `error` + 文案逐字 + 退出码。异常**类型**不可表达（也没有语义），文案与退出码全部保留。

### 15.3 参照物消失后，冻结入口必须会说话

`tests/goldens/freeze.mjs` 新增 `missingReferences`/`assertRefreezePossible`：参照物被删时以可读说明中止（`冻结中止：参照物已删除，这些夹具没有可重冻的来源。` + 逐条列 13 条夹具 + 「要重冻这些夹具，先把被参照的 scripts 恢复回来」），exit 1，不崩溃、不静默跳过。实测去掉这条守卫后，同一条命令不再提「参照物已删除」，而是继续跑到 Go/Node 对账失败并指向某个夹具的差异——操作者会被引去调错的模块，真正的病因（缺参照物）看不见。`parity-cases.mjs` 的 suite b 用 `refreezeLocked: ["writer-record"]` 声明这一点。

### 15.4 变异（我自跑，`/tmp` 副本）

| 变异 | 结果 |
| --- | --- |
| 正文前缀 `状态未被修改：` → `状态被修改：` | 5 条红 |
| `RecordExitCode` 让 `infra` 也归 0 | 3 条红 |
| issue 守卫 `<= 0` → `< 0` | 1 条红 |
| 去掉 freeze 的参照物守卫 | 无 vitest 红（冻结不在默认测试路径）+ 直接运行报错指向别处 |

### 15.5 又一次「探针自己坏了」

我第一次把 `RecordExitCode` 改成 `if true {`，编译报 `declared and not used: kind`，脚本又只 grep `^--- FAIL`，于是得到 `fails=0` —— 看起来像「这三条断言不承重」。改成真正会编译的形态（追加 `|| isStringValue(kind, "infra")`）才是 3 条红。**固定动作再补一条：Go 侧变异后先看有没有 `build failed`，再看 `--- FAIL`；`fails=0` 在构建失败时毫无意义。**

### 15.6 数字

`npm run check` exit 0；22 files / **783 tests**（792 − 9，精确等于被删 Node 用例数；新增 11 条 Go 测试不计入 vitest）；gofmt/vet/`go test` 全 0；oxlint 4 warnings 0 errors（都是既有文件里的既有写法，其中 `tests/audit-findings.test.mjs` 那三处 `\*`/`\?` 转义在字符串字面量里是夹具语义，不能动）。

顺带清掉两处陈旧注释：`tests/audit-findings.test.mjs` 里拿已删脚本当例子（换成现存的 `scripts/merge-gate.mjs`）、`.github/workflows/state-writer.yml` 仍写「只由 writer-record.mjs 决定」（改成引擎子命令）。`.agents/notes/implemented/` 里的两条历史决策记录按规矩不动——它们记的是当时的 why。

### 15.7 下一批

按 CI 引用面从易到难：`last-change` / `copy-dist` / `cli` / `kb-export`（CI 已无 Node 调用点）→ `merge-gate` / `build-intent` → `routing` / `ledger` / `state-validate` → `audit-collect`/`audit-findings`/`audit-slot`/`audit-review`（最后一批，要动 `.github/workflows/audit.yml` 的 verifier 边界，单独一次带变异证据的变更）。

## 十六、E2 第二批：last-change 判据搬进 Go，Node 套件删除但脚本暂留

### 16.1 为什么会留下一个脚本不删

`scripts/last-change.mjs` 不只是被测对象，它还是 `scripts/merge-gate.mjs` 的渲染器来源（`renderLastChange`/`BLOCK_BEGIN`/`BLOCK_END`），`tests/merge-gate.test.mjs` 也从它 import `renderSection` 造夹具。

执行者给的选项里有「把渲染器逐字搬进 merge-gate.mjs、测试改冻结字面量，本批就能删干净」。我否掉了：`merge-gate.mjs` 本身就是后面要被整体删掉的 Node 载体，现在往里做一次逐字搬迁、下一批再全删，等于造一个没人验收的中间态。**判据先搬、脚本后删，删除的批次必须跟着它最后的消费者一起走。**

所以这一批：12 条判据搬进 `apps/engine/lastchange_test.go`（16 个测试）、删 `tests/last-change.test.mjs`、`scripts/last-change.mjs` 保留并在 `scripts/README.md` 标 deprecated 写明「仅作为 merge-gate 的渲染器载体存活，随 merge-gate 批次一起删」。b 套 golden 继续可重冻——这是正确状态，没有提前加 `refreezeLocked`。

### 16.2 (f) 三条没有搬进 Go，理由是保真度不可自证

原套件里有 3 条不是模块判据而是 **workflow 接线判据**：它们把 `.github/workflows/last-change.yml` 的 render/write 两个 run 块原样执行，用假 `gh` 断言 `pr view 9 --json body --jq .body` 与 `pr edit 9 --body-file body.out.md`。

执行者提议用 Go 复刻 YAML 的 `${{ }}` 插值与 `if:` 求值搬过去。我否掉了：那等于在 Go 里再实现半个 Actions 表达式引擎，成本高且**保真度自己无法证明**，最后会变成「看着在钉接线，其实在钉我自己的复刻」。

替代层是新建 `tests/last-change-wiring.test.mjs`（3 条）：仍原样执行 run 块、仍走 `if: steps.render.outputs.changed == '1'` 的求值路径，`evalIf` 只支持 `==`/`!=`/`&&`，越界即 throw 而不是默认放行；并且**不 import 任何 `scripts/*.mjs`**——接线判据的对象是 workflow，与脚本无关。

### 16.3 「挪走参照物还能绿」这条要求是这轮最有价值的检查

要求写进 brief 并要求它在 `/tmp` 副本里当场取证；我也自己复跑了一次：`mv scripts/last-change.mjs` 之后 `npx vitest run tests/last-change-wiring.test.mjs` → **1 file / 3 tests passed, exit=0**。没有这一步，「不依赖脚本」只是注释里的一句话。

### 16.4 变异（我自跑两组，执行者另跑五组）

| 变异 | 结果 |
| --- | --- |
| `MergeDate` 返回整段时间戳（`match[1]`→`match[0]`） | 4 条红（含仓里原有的 `TestMergeDate`） |
| `/tmp` 副本里 workflow 的 `if: … changed == '1'` 反转成 `'0'` | wiring `2 failed / 1 passed` |
| （执行者）去掉 `--diff-filter=d` | 1 红 |
| （执行者）`ReplaceLastChangeSection` 丢掉节后尾巴 | 2 红 |
| （执行者）`changed` 恒 1 | 1 红 |

### 16.5 数字

`npm run check` exit 0；22 files / **774 tests**（783 − 12 + 3）；`gofmt` 干净、`go vet` 0、`go test -count=1` ok；`apps/engine` 下无 `.cache`。

残留 grep：`scripts/last-change.mjs` 只剩 `tests/merge-gate.test.mjs:14`（禁区，随 merge-gate 批次处理）与 `tests/goldens/parity-cases.mjs:1262`（注释，说明「期望值已脱离实现独立存在」）——**可执行调用点 0**。

### 16.6 记一笔操作噪声

我曾误发起一个 brief 为 `noop` 的子代理（什么都没做就结束）。它无副作用，但它说明「派单前先读一遍自己写的 prompt」这件事对调度方同样成立。

## 十七、E2 第三批之后：判据批量搬进 Go（t15–t21 一次收口）

前两批（writer-record、last-change）是「一个模块一条线」手工做的；从第三批起改由 AgentTeams 的成员并行推进，规则不变，只是每批要连带处理两类反例：**概率红**（判据的输入不可复现）与**逃逸断言**（断言被另一个分支的文案满足）。

| 批次 | 搬进 Go 的判据 | Node 套件 | 载体（Node 脚本） | 计数 |
| --- | --- | --- | --- | --- |
| 第三批 | ledger / ledger-cli / copy-dist | 0（原本无人钉） | 删 3 个 | 774 |
| 第四批 | routing / build-intent / cli / kb-export | routing 与 build-intent 套件删，cli 与 kb-export 套件删 | 删 `cli.mjs` / `kb-export.mjs`；`routing.mjs` / `build-intent.mjs` 暂留（仍被 `audit-review.mjs`、`last-change.mjs`、`merge-gate.mjs` import） | 665 |
| t15 | state-validate 与 auto-flow | 删 `state-machine.test.mjs`(15) + `auto-flow.test.mjs`(10) → `validator_test.go`(25) | `state-validate.mjs` 暂留（`merge-gate.mjs` 与 `freeze.mjs` 的 @consult-probe 录制器） | 640 |
| t16 / t19 | merge-gate 36 条 → `mergegate_cli_test.go`(35)，wiring 3 条另立 `tests/merge-gate-wiring.test.mjs` | 删 `merge-gate.test.mjs`(39) | `merge-gate.mjs` 暂留（workflow 仍在跑它，且它是门牌渲染器的最后消费者） | 604 |
| t18 / t20 | guards 15 条 → `guards_validator_test.go` | `guards.test.mjs` 320 → 73 行（留 2 条 Node 独占判据） | — | 589 |
| t17 | audit-collect / audit-review / audit-slot 51 条 | 删三个套件 | 删 `audit-collect.mjs` | 526 |
| t21 | —（切换批次） | 8 条扫描面用例泛化成按子命令的契约表，0 条删除 | `audit.yml` 六处调用切 `./.cache/bin/engine audit-review|audit-slot` | 527 |

### 17.1 两类假红（判据的输入不可复现）

1. **sha 随墙钟变**：`TestMergeGateIgnoresUndeclaredFlags` 比两次独立运行的完整 stdout，而夹具每次新建 git 仓库、commit 时间精确到秒 → sha 不同 → 概率红（`-count=10` 抓出 4 次）。修法是把夹具钉成确定的（`GIT_AUTHOR_DATE`/`GIT_COMMITTER_DATE` 冻结 + `TestMergeGateFixtureIsDeterministic`），不是把 sha 归一化掉——归一化是降级断言，缺陷在夹具不在判据。
2. **扫描面扫进不受版本控制的文件**："仓库源码里没有 skipGuards" 用 `walk(ROOT)` 实现，把 `.gitignore` 忽略的 `.agent-teams/`（运行时写、内容随任务描述变）也扫进来。修法是把扫描面换成 `git ls-files --cached --others --exclude-standard`，让排除规则回到 `.gitignore` 这唯一一处，而不是加一张手写目录黑名单（那张名单永远漏下一个）。

假红比真红更坏：它训练人把红当噪声，而噪声一旦合理，真红就没人看。

### 17.2 一类逃逸断言（断言被另一个分支满足）

`audit-review` 的 request_id 守卫被短路后，记录里确实没有 `evidence.request_id`（断言真），下游确实判 INFRA（断言真），退出码确实 3（断言真）——但那条 INFRA 的理由是 schema 校验写的，理由文本里**也**含 `request_id`。四条断言全被另一个分支满足，判据绿而守卫已死。修法是把断言钉在守卫自己那句话的前缀上（`HasPrefix("上游没有回 request_id")`）。

教训：断言里出现某个「标识串」时，要问一句**除了我以为的那个分支，还有谁会输出它**。

### 17.3 测试接缝会变成生产参数

`audit-collect` 的 10 秒轮询原本是注入依赖，Go 侧只能从进程边界注入，于是引入 `AUDIT_COLLECT_POLL_INTERVAL_MS`。接受它时同时加了一条静态判据：**该变量出现在任何 workflow 里即违规**——接缝一旦能在 CI 里被设上，它就从接缝变成别人能改门行为的旋钮。

### 17.4 t21 切换批次的验收

- 六处调用点前后逐条对照，退出码语义与 Node 版一致（实测：review 无 key → 3；review 缺参数 → 2；slot 身份不符 → 0 并写 INFRA；slot 缺参数 → 1；两槽 pass → findings 0 且结论 success），所以 workflow 里 `|| code=$?` 的分流不用改。
- 我自己跑两组变异：把一处调用退回 `node scripts/audit-slot.mjs` → 1 红；往 workflow 的 job env 加 `AUDIT_COLLECT_POLL_INTERVAL_MS` → 2 红（第一次做这组探针时锚点没命中、脚本静默失败，看到的是「全绿」——又一次「探针自己坏了」）。
- **仍未关**：`audit-review.mjs` / `audit-slot.mjs` / `routing.mjs` / `build-intent.mjs` / `last-change.mjs` / `merge-gate.mjs` / `state-validate.mjs` / `audit-findings.mjs` 八个脚本仍在，卡在 `tests/goldens/parity-cases.mjs` 冻结夹具与两处 workflow 上；usage 文案里仍写 `node scripts/*.mjs`（改它要重冻 40 条不可重冻 golden，留到下一次 golden 口径变更一并做）。
