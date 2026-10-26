# 审计真 findings 的采集编排——只发命令、只读结论

状态：active（已落地）

## 一、为什么做

P-14 的结论是「审计判定保持手动触发」。手动不等于手动拼命令：发起一次真审计要四步——解出 PR head sha、两份 findings 先按口径层预检、按那个 sha 上对应的分支 dispatch、再回读这个 sha 上的 `audit` Check Run 才能知道结论。少一步就是「看起来跑了」或「拿错 sha 的旧结论」。

## 二、决定

1. **只编排不判定**。结论永远由 `audit.yml` 写成 Check Run，本脚本只回读。判据（schema、两槽身份、结论归一）不复制一行，直接 `import` `scripts/audit-findings.mjs` 的 `assess`——同一份证据不能有第二个判法。
2. 预检不过就一次 gh 都不调，退出 3。预检的目标不是给结论，而是别把一份明显不合格的 JSON 送进 workflow 换回一个「判不了」。
3. 轮询只认 `headSha === 目标 sha` 且 `createdAt >= 发起时刻` 的 run。只比 sha 会拿到「上一次 dispatch 的 run」，那个 run 的结论属于别的 findings。
4. 回读 `commits/<sha>/check-runs`，取 `name === "audit"` 里 id 最大的那条——与 `scripts/merge-gate.mjs` 的 `newest` 同一条语义，门读到哪条，这里就读哪条。
5. **只有 `success` 给 0**。`neutral`/`skipped` 在 GitHub 那边算「通过」，在审计门这边不算；认不出的 conclusion 一律 3（fail-closed）。
6. 退出码沿用 `scripts/state-validate.mjs` 的 0/1/3，另加 2 = 用法错误：`0 通过 / 1 判不合格 / 2 用法错 / 3 判不了或没判过`。
7. 不写任何文件、不 import `ledger.mjs`、零新依赖；`deps` 注入 `{ gh, now, sleep, intervalMs, out, err }`，测试给假 runner 与假时钟，不联网、不真等。

## 三、放弃了什么

- **不做「失败自动重试」**：重试会把「判不了」翻译成「再试一次」，而判不了的真实成因（凭据缺失、端点变了）重试一万次也一样。
- **不把结论缓存到本地**：缓存一旦与 Check Run 不同步，门与本工具就会各说各话；Check Run 是唯一真源。
- **不在本工具里跑本地判定**：本地判据是审计执行器的事，采集器替它判一次，就等于给了第二个结论写者。
- **不给 `--dry-run` 加「非 OPEN 也发」的开关**：真跑路径必须拦非 OPEN PR，dry-run 只打印。

## 四、落地形状

- `scripts/audit-collect.mjs`（455 行）：`--pr/--a/--b/--ref/--dry-run/--json/--timeout`；五步 = 取 sha/ref/state → 预检 → dispatch → 轮询 run → 回读 Check Run。
- `tests/audit-collect.test.mjs`（31 例）：参数与文件错误→2、PR 非 OPEN→3、预检不过→3 且 run 调用 0 次、轮询超时→3、四种 conclusion 的映射、无 audit check run→3、`--json` 只有一行合法 JSON、入口在软链下也必须真的跑起来。
- `scripts/README.md` 一行索引。

## 五、怎么验的

- 真 gh 干跑（PR #14，`--dry-run`）：打印出解到的 sha/ref/state 与将要发出的 `gh workflow run`，并显式提示「PR 状态是 CLOSED，真跑会在发起前被拒绝」。
- 我自己的变异（/tmp 副本，每组先打印改后行）：`action_required` 映射成 0 → 2 红；不比对 `headSha` → 1 红；预检失败仍发 → 1 红；取 id 最小 → 1 红；无 audit check run 当通过 → 2 红；入口条件整体失效 → 1 红；`realpathSync(argv[1])` 退回裸 `argv[1]` → 1 红。
- 一条**非**缺陷的核对：去掉 `?filter=latest` 仍全绿——GitHub 该参数默认就是 `latest`，去掉是等价改写，不是假绿。

## 六、仍然没有的（刻意）

- 不自动挂 required、不给 PR 触发；判定仍是手动发起（P-14 决策）。
- 不校验 findings 的内容真假——那是审查执行器的自报，本仓不替它背书。
- 真 GitHub 上 `--jq` 投影与分页未在本机 CI 复跑；替身覆盖了行为，真网络只跑过 `--dry-run`。
