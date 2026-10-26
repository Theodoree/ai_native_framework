# P-31 判据与门搬进 Go（进行中）

状态：阶段 A、B、C、D1 已完成并合入，D2（删 .mjs、parity 转 golden、去掉剩余 Node 依赖）未做。

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

## 八、阶段 B 落地记录（build-intent / last-change / writer-record）

**交付物**：`apps/engine/jscompat.go`（150 行，JS 语义垫片：空白集、Number()、JSON.stringify、appendFileSync、ENOENT 文案）、`intent.go`（394）、`lastchange.go`（492）、`writer.go`（113）、`phase_b_test.go`（168）、`tests/engine-parity-b.test.mjs`（670，55 例）；改 `cli.go`（Run 三个 case + EngineUsage）、`value.go`（新增 `EncodeIndent` 复刻 `JSON.stringify(v,null,2)`）、`README.md`。手法与阶段 A 同：真双跑对照，不重写判据。

**已登记的非逐字节例外**（用前缀 + 退出码钉住，不放松判据）：Node 未捕获异常栈（含 `<anonymous_script>` 与行号）、`--out` 目录不存在的 ENOENT（临时文件名含 pid）、`spawnSync gh ENOENT`、git 二进制缺失（同一机制）。

**移植中修掉的两个真 bug**：`isEastAsianWide` 曾把 `\u2E80-\uA4CF` 写成 `0x2e80-0x4acf`（表格列宽错算）；writer 的 `--issue` 缺值应得 NaN（`JSON.stringify(NaN)` 是 `null`），否则会把 `"0"` 当编号。

**变异验证**（我亲跑四组，就地改 + /tmp 备份 + 先打印改后行 + 恢复）：lastchange 分隔行 `-`→`=` 8 红；`intent.go` 的 `"ci"`→`"bot"` 1 红；writer 正文文案改 4 红；**`value.go` 的 `EncodeIndent` 缩进 +1 → 10 红**（这组是我自己找的，交付方未测）。恢复后 parity 55 全绿、整仓 `npm run check` 609 tests 全绿、工作树无残留。

**阶段 C 的耦合点（先说清，免得改错）**：`merge-gate.mjs` 是 **import 这三个 .mjs 的导出函数**（`buildIntent`/`resolveIssueRefs`/`renderSection`/`recordBody`），不是调 CLI —— Go 侧已有同名导出，阶段 C 是把 merge-gate 改成调库，入口契约不经过命令行。另：last-change 的 git 命令别换 plumbing（`-z` 等），`core.quotePath=true` 会把非 ASCII 路径转八进制转义，两侧逐字节一致正是靠它；writer-record 的退出码是「判定结论 × 评论成功」的合成，infra 评论成功仍退 1，不是可重试信号；`GITHUB_OUTPUT` 是追加写。
**运行时方言第二次咬人（与阶段 A 同一类，这次的载体是 stderr 文案）**：last-change 的「EVENT 非法 JSON」用例本地（Node 24）全绿、CI（Node 20）红——JSON.parse 的坐标后缀 (line 1 column 2) 只在 Node 22+ 出现。修法与阶段 A 同口径：比对前把坐标后缀从两侧摘掉（位置数字仍比），并**单独断言 Go 侧一律带坐标**，避免「两边都摘」退化成什么都没比。判断：凡是把 JSON.parse 的消息写进输出面的入口，都按这条办。

## 九、同步到 main 时暴露的一个状态机缺口（未修，登记）

阶段 B 的 PR #83 基分支误设为 `develop`：GitHub 只在**指向默认分支**时自动关单，main 也就没快进。补的同步 PR #84（`develop → main`）又踩到第二层：门 G1 需要一个**还能被合并带到 done 的 issue**，而 #82 已被写者带到 `state:done`，门如实报 `E_TERMINAL_STATE 终态 done 不能再转换`。于是单独开 #85 作为同步单。

PR #84 合并后 #85 被 GitHub 自动关闭，但标签停在 `state:in-progress`。原因查清：写者的意图表**只认 `issues.opened` 与 `issues.labeled`**（`scripts/build-intent.mjs:158`、`:164`，Go 侧同源），`issues.closed` 不产生意图；而 PR 关闭事件（`pull_request.closed && merged` → done）与 GitHub 的自动关单几乎同时发生，谁先谁后不确定。结果是「关单是平台外的动作，状态标签是平台内的记录」这两件事在时间上脱钩。

不在这里手工改标签：状态只有一个写者，绕过写者改标签等于把契约当建议。这条缺口留给后续（要么给 `issues.closed` 建意图，要么把自动关单从平台外挪进写者）。当前状态如实写在 PR/issue 里，读的人能看到。

## 十、阶段 C 落地记录（merge-gate）

**派了两次**：第一次的执行器中途失败、零改动、无收尾消息（`git status` 空）；按 R6 重派一次并加约束「每完成一步就记一行」，第二次正常交付。这类「静默失败」只能靠工作树有没有变来发现，靠回合数等不出来。

**交付物**：`apps/engine/mergegate.go`（新增 800 行：四守卫 G1 issue-state / G2 refs-and-files / G3 checks / G4 last-change，加 collect/report/fail 与 `RunMergeGate`）；`apps/engine/cli.go`（+3 行：`merge-gate` 子命令）；`apps/engine/README.md`；`tests/engine-parity-c.test.mjs`（439 行，46 用例，假 git/假 gh 双替身）。`scripts/*.mjs`、`package.json`、`.github/**`、`apps/api-go/**`、`apps/web-vue/**` 一个字节都没动。

**耦合点全部进程内**：`LoadConfig` + `ConsultTransition` / `RenderLastChange` / `ResolveIssueRefs` + `issueRefsValue`，整条路径不起 node 子进程，外部工具只剩 `git` 的两条 `cat-file -e`。这正是阶段 A 之后 api-go 已经达到的形态，阶段 C 把门也拉到同一形态。

**唯一不做逐字节对照的地方**：JS 未捕获异常的多行栈（G1 的 labels 不是数组时 Node 打 `TypeError: ... is not a function` 加栈帧）。Go 只打首行。一致的契约降到「stdout 一个字节都没有 + 退出码 1」，这条写进了 parity 用例名与 README。

**我的独立变异（五组，就地改 + /tmp 备份 + 先打印改后行 + 恢复）**：

| # | 变异 | 红数 |
| --- | --- | --- |
| A | `mergegate.go:276` `mergeGateNewest` 的 `>=` → `>`（平手取先出现的那条） | **0 红（漏了）** |
| B | `mergegate.go:449` `!strictEqual(sha, ctx.head)` → `!strictEqual(sha, sha)`（stale 永不成立） | 1 红 |
| C | `mergegate.go:318` `len(refs) != 1` → `len(refs) < 1`（放过多个引用） | 1 红 |
| D | `mergegate.go:353` 咨询 `to:"done"` → `to:"in-progress"`（G1 目标状态错） | 30 红 |
| E | `mergegate.go:727` 汇总行「未就绪=」→「未完成=」 | 28 红 |

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

修法仍是那两条（给 `issues.closed` 建意图，或把自动关单挪进写者），本轮不动：状态只有一个写者这条约束优先。
## 十一、阶段 D1 落地记录（CI 与 npm 脚本切到 Go 引擎）

阶段 A/B/C 让 Go 有了全部判据，但调用点还在 Node——冗余没真正消掉。D1 把 8 个生产调用点指向 `./.cache/bin/engine`：

| 调用点 | 命令 |
| ------ | ---- |
| `merge-gate.yml` collect | `./.cache/bin/engine merge-gate --event … --pr … --print-issue` |
| `merge-gate.yml` gate | `./.cache/bin/engine merge-gate --event … --pr … --issue … --checks … --infra …` |
| `state-writer.yml` resolve | `ISSUE="$(./.cache/bin/engine build-intent --resolve-issue)"` |
| `state-writer.yml` intent | `./.cache/bin/engine build-intent > intent.json` |
| `state-writer.yml` validate | `./.cache/bin/engine validate --intent intent.json --json` |
| `state-writer.yml` record | `./.cache/bin/engine writer-record --verdict verdict.json --issue "$TARGET"` |
| `last-change.yml` render | `./.cache/bin/engine last-change --in body.in.md --out body.out.md` |
| `package.json` `check:state` | `npm run --silent build:engine && ./.cache/bin/engine check-config` |

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
