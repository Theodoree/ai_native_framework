# 测试里的 stdin：用 `-`，不用 `/dev/stdin`

- **状态**：implemented
- **日期**：2026-10-21
- **触发**：PR #2 的 `check` 在 CI 上红、本地全绿

## 现象

CI（ubuntu-latest）两条测试红，本地 macOS 全绿：

```
FAIL tests/state-machine.test.mjs > CLI：非法意图退出 1
AssertionError: expected 3 to be 1
FAIL tests/build-intent.test.mjs > (b) 上链路：无引用的 PR 事件被判定器判 INFRA
+ INFRA E_INTENT_MISSING 读不到意图输入（--intent <file> 或 stdin）
```

根因：两处用例给判定器传 `--intent /dev/stdin`。Linux 上 `/dev/stdin` 是
`/proc/self/fd/0`，读管道会失败，于是走到「读不到意图输入」的 INFRA 分支，退出码 3。

## 决定

- 契约：`--intent -`（或省略 `--intent`）表示读 stdin，实现是 `readFileSync(0)`。
- `/dev/stdin` 不作为受支持写法；跨平台差异不进契约，进实现注释。
- 测试一律用 `-`。

## 放弃了什么

- 不给 `/dev/stdin` 加特判：那是给一个平台假设打补丁，换个 runner 还可能坏。
- 不把这条塞进 `docs/development.md`：它是「测试怎么写」的具体写法，
  属于可推导细节；契约层面的 stdin 语义已经由 `--intent -` 表达。

## 教训

「本地绿、CI 红」多数不是环境玄学，而是**测试里写死了一个平台事实**。
判据：同一份输入在两个平台上走到的分支不同，就说明被测行为本身写得比契约更具体。
