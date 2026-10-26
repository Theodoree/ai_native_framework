# P-29 写者的标签事件：状态就是标签，重复的就是无操作

状态：active（已落地，第二版）

## 一、为什么做

写者改状态的方式是改标签。一次 `--add-label state:done --remove-label state:in-progress` 会被 GitHub 拆成两个事件各自触发一次写者；写者对每个 `state:*` 标签事件都去问判定器「能不能从当前状态转到这里」，而这时状态已经是那个标签了。于是每次正常合并之后，issue 时间线上都会多出几条 `REJECTED E_NO_TRANSITION`（「没有从 in-progress 到 in-progress 的转换」）或 `E_TERMINAL_STATE` 的拒绝评论。

结论本身是对的（确实没有转换可做），但留痕是错的：这些评论挂着 REJECTED 的样子，读起来像出了问题，实际什么都没发生。真正的拒绝（比如缺守卫证据、非法转换）淹没在噪声里，久了就没人看。

## 二、决定

在意图构造里加一条判定，事实来源是「这次事件能看到的完整标签集」：

- `issues.opened`：payload 自带 `issue.labels`，若其中已有 `state:*` 标签（建单时直接带状态标签是常见做法），不产出受理意图 —— 受理等于把 accepted/triage 再判一次，而状态已经不在那里了。
- `issues.labeled`：若这次加的 `state:*` 标签是完整标签集里**唯一**的状态标签，那就不是一次转换 —— 返回「不需要改动状态」，后面的判定、改标签、留痕整段跳过。

依据是「状态就是标签」这条设计本身：状态没有第二个家，标签集合里能读出的状态就是它。只剩这一个状态标签，说明状态已经等于它，没有可做的转换。

## 三、放弃了什么

- **不在判定器里加「to 等于 from 就静默通过」**：那是把一条真规则（终态不能再转）改成条件放行，且判定器看不出「这个事件是写者自己制造的」。噪声的来源是事件来源，就该在事件源头拦。
- **不靠给写者加 skip 标签或去重表**：多一个状态载体，多一处可能不一致；事件触发这件事本身是宿主的，不是我们的。
- **不只信注入的宿主标签文件（第一版的做法，已被真事件推翻）**：见下节。

## 四、落地形状

`scripts/build-intent.mjs` 在 opened / labeled 两个分支之前先统一取事实：

```js
const hostLabels = Array.isArray(issue.labels)
  ? eventLabels
  : issueLabelsFromHost;
const stateLabels = Array.isArray(hostLabels)
  ? hostLabels.filter((name) => String(name).startsWith("state:"))
  : null;
```

`issues.*` 的 payload 天然带完整标签集，优先用它；`issueLabelsFromHost`（`ISSUE_STATE_FILE` 注入）只在 PR 事件取得到。两个来源都没有时 `stateLabels` 是 `null`，**不做**无操作判断，仍交给判定器 —— 「查不到」不能被读成「什么都不用做」。

命中无操作时走既有路径：打印 `no-state-change <事件名>`、`has_intent=0`，后续判定/改标签/留痕全部跳过。

## 五、怎么验的（两轮）

### 轮一：单元测试全绿，真事件全红

第一版只认 `issueLabelsFromHost`，4 条用例、1 组变异、54 passed，合并进 main（`8322d34`）。随后建探针 issue #72（建单即带 `--label state:in-progress`），时间线上立刻出现两条拒绝评论：

```text
06:58:47 状态未被修改：REJECTED E_NO_TRANSITION — 没有从 in-progress 到 accepted 的转换
06:59:05 状态未被修改：REJECTED E_NO_TRANSITION — 没有从 in-progress 到 in-progress 的转换
```

两个 run（40282963150 opened、40282963477 labeled）的 head 都是新代码。查步骤结论：`6 fetch issue state skipped` —— 该步 `if: steps.resolve.outputs.issue != ''`，而 issues 事件里 resolve 输出为空，`issue-state.json` 根本没生成，`issueLabelsFromHost === null`，守卫整段被跳过。

**根因不是判据错，是事实来源错**：单元测试把「宿主标签」这个事实直接喂了进去，真实事件里它永远缺。

### 轮二：把事实来源换对

用例（`tests/build-intent.test.mjs` 41 例 + wiring 16 = 57 passed）：

1. `labeled`：payload 自带唯一 `state:done`、事件也在加 `state:done` → `null`（无操作）；
2. `labeled`：payload 带 `state:analyzing` + `state:accepted`、事件加 `state:accepted` → 仍产出意图；
3. `labeled`：payload 自带唯一 state 标签、注入文件缺失 → 仍是 `null`（钉住事实来源，正是第一版漏掉的那一格）；
4. `labeled`：payload 没有标签、注入也缺失 → 仍产出意图（事实缺失不静默）；
5. `opened`：payload 已带 `state:in-progress` → `null`；
6. `opened`：payload 没有 state 标签 → 照旧受理（auto）。

变异（隔离副本，每组先打印改后行确认命中）：`const hostLabels = issueLabelsFromHost;` → 2 failed；opened 守卫 `if (false)` → 1 failed；labeled 守卫 `if (false)` → 3 failed；还原后 41 passed、文件逐字节相同。整仓 `npm run check` CHECK_EXIT=0。

## 六、教训

- **判据挂在哪份事实上，和判据本身一样重要**：第一版判据完全正确，只是那份事实在真实事件上永远是 `null`，于是它一次都没跑过。写守卫时要问「这个变量在真实事件里从哪来、取不到时是什么」，而不是「测试里我能不能喂进去」。
- **变异测试只能证明用例在盯，不能证明它盯的是真实路径**。轮一 4 条用例 + 1 组变异全绿，仍要靠真事件才暴露。
- 探针 issue 是成本最低的验收：建一条、看时间线、删掉，比在 CI 里推演强。

## 七、仍然没有的（刻意）

- 记不住「这条评论是写者自己造成的」：判断依据只有标签集合，没有事件来源白名单；人手动把「唯一状态标签」再加一遍也会被静默跳过 —— 但那本来也是无操作。
- 不改历史噪声：issue #41 / #48 / #51 / #54 / #72 等时间线上的旧拒绝评论不会自动清掉。
- 没动 `unlabeled` 事件：那条路本来就返回 `null`（不产生意图）。
- 不校验「payload 与注入文件不一致」：两者都可用时 payload 优先，冲突本身没人报。
