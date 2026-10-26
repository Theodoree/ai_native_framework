# 写者自己取守卫证据

状态：active（已落地）

## 一、为什么做

P-21 让「声明了守卫就必须给证据」生效之后，平台立刻无法把任何条目判成 done。
真实事件：PR #42 合并触发 state-writer run `40264924991`，`validate` 步骤直接判

```json
{"verdict":"rejected","code":"E_GUARD_MISSING","message":"in-progress → done 需要守卫证据：merge-gate"}
```

于是 `apply` 被跳过，issue #41 至今是 CLOSED + `state:in-progress`。
留痕机制本身是对的（#41 上有 REJECTED 评论），错在没人给证据：
`scripts/build-intent.mjs` 从 PR 事件建意图时从不带 `guards`。

## 二、决定

守卫证据由**写者自己从宿主事实取**，不从人手里要、也不采信任何自述：

- workflow 新增一步，只在 `pull_request.closed` 且 `merged == true` 时跑；
  取该 PR **head 提交**上 `filter=latest` 的 check run 列表，挑 `name === "merge-gate"` 的那条；
- 只有 `conclusion === "success"` 才写 `guard-evidence.json`，内容是一句可复算的陈述
  （check run id + 名字 + 结论 + sha + PR 号）；
- `scripts/build-intent.mjs` 只从 `GUARD_EVIDENCE_FILE` 读注入的文件，自己不联网；
  文件不存在时意图的字节形状与改动前完全一致（无 `guards` 键）。

三条边界写进 `docs/workflow.md`：拿不到证据就不给证据（由判定器 reject 并留痕，写者不报错）；
写者不替自己作证（不用「我看到它合并了」这种自述，只用检查结论）；守卫名取本仓声明的那一个。

## 三、放弃了什么

- **用 `merge_commit_sha` 或 check_suite 取证据**：合并后的提交上不一定重跑检查，
  PR head 上的结论才是「这次改动被检查过」的事实。
- **允许人手工填守卫证据**：那等于把闸门的钥匙交回给被闸的人。
- **让 `build-intent.mjs` 联网自己取**：脚本目前无网络依赖，测试能整块跑；
  取数留在 workflow，脚本只消费产物。
- **把「没证据」当 infra 让 job 变红**：没有证据是正常的等待状态，
  reject + 留痕已经说清；job 变红会让人以为流水线坏了，学会忽略红灯。
- **同名多条时猜一条**：`filter=latest` 正常只回一条，回了多条说明「最新」这个前提不成立，
  猜一条等于把守卫交给运气。

## 四、落地形状

`.github/workflows/state-writer.yml` 的 `fetch guard evidence` 步骤：
先 `gh api` 把**原始 JSON** 落到临时文件，再交给 `node -e` 做选择与判定
（解析失败 / 没有该名字 / 同名多条 / 结论不是 success 四种情况都只写 step summary 并 `exit 0`）。

选择规则之所以从 `--jq` 表达式挪进脚本，是因为测试替身不会实现 `--jq`：
之前夹具传的是已经算好的字符串 `"890|success"`，假 gh 原样回放，
于是 `sort_by(.started_at) | last` 改成 `first` 也全绿——**测不到的选择逻辑等于没有**。

## 五、怎么验的

- `tests/build-intent.test.mjs`（34 例）与 `tests/state-writer-wiring.test.mjs`（16 例）共 50 例；
  三个真跑用例走完整 workflow（假 gh + 真判定器 + 真 `state-machine.yml`）：
  success → 写文件 → `validate` allowed → 标签 in-progress 改 done；
  无该 check、结论 failure、同名多条、JSON 读不出来 → 都不写文件、判定 reject E_GUARD_MISSING、job 仍绿。
- 变异（/tmp 副本，每组先打印改后行再跑）：
  `if (matched.length > 1)` → `if (false)` 红 2；
  catch 分支 `giveUp(...)` → `runs = []` 红 1；
  `run.conclusion !== "success"` → 恒不成立 红 2；
  `const guard = guardEvidence ? {...} : {}` → `{}` 红 2；
  `readGuardEvidence` 首行 `return null` 红 3；
  `if` 去掉 `&& merged == true` 红 2；
  `readGuardEvidence` 改名/环境变量改名 红 2。
- 修前那条洞也是这么找到的：`--jq` 版本把 `sort_by(.started_at) | last` 改成 `first` 全绿 48/48。

## 六、仍然没有的（刻意）

- 没有在真 Actions 上跑过这步（本地只用真的 `gh` 与真 token 验过端点形状）。
- 多个 App 都挂同名 `merge-gate` 时，`filter=latest` 的服务端去重规则归 GitHub 管；
  本仓只保证「拿到的列表里必须恰好一条」。
- 只生成本仓声明过的 `merge-gate` 一个名字；新增守卫要同步改这里（目前没有通用取数器）。
