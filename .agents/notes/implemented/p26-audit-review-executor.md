# P-26 审计审查执行器：一个槽一次真调用

状态：active（已落地，2026-10-26）

## 一、为什么做

P-14 前半程只把 `audit` 跑通了「人喂 findings」这条路：`gh workflow run audit.yml -f pr=<PR> -f findings_a=@… -f findings_b=@…`。也就是说**结论的原料是人给的**，机器只负责把它算成红绿。P-14 后半要补的正是源头：谁去产这份 findings。

补之前先撞上一条自己的契约：`scripts/audit-findings.mjs` 原来按「执行器」判两个槽是不是独立——两个槽自报同一个 `evidence.executor` 就两槽一起判 INFRA。而自动产出的两位审查者都跑在同一个 GitHub Actions 里，执行器必然都是 `github`，于是这条路一接上就永远是 INFRA。**判据本身把要做的功能判死了**，所以这两半必须一起改。

## 二、决定

1. **独立性身份 = 执行器 + 模型**。同一个执行器但模型不同，仍是两次独立判断；执行器与模型都相同才算「一份意见被记成两票」，此时两槽判 INFRA。理由：执行器是「在哪跑」，模型是「谁在想」；两位审查者共用流水线不等于共用判断力。
2. **一个 secret，两个模型**。`DEEPSEEK_API_KEY` 一份；`review-a → deepseek-chat`、`review-b → deepseek-reasoner`。换两家厂商要多管一份凭据，收益只是「更不像同一个脑子」，先不做。
3. **模型名的家只有一个**：`.agents/platform/routing.yml`。脚本 `import` `scripts/routing.mjs` 的 `loadRouting` / `resolve` 取模型，CLI 不提供 `--model`（传了就是用法错误）。读不到路由就不许猜一个模型去调——那会把「配置坏了」变成一次看起来正常的假运行。
4. **evidence 只写已知的真事实**。`executor` / `agent` / `model` / `request_id` 里任何一项拿不到就**不写这个键**，并且 `request_id` 拿不到直接判 INFRA——追溯字段上填占位符，等于给一份没跑过的记录发凭据。
5. **verdict 不由模型自报**：`blocker → reject`、其余缺陷 `→ needs_revision`、空 `→ pass`。让模型自己声明结论，等于请被审的人判自己。
6. **schema 判据不复制**：成功记录先过 `scripts/audit-findings.mjs` 的 `validateResult`，不合格转 INFRA。
7. **判不了就说判不了**：没有 key / 上游非 200 / 响应不是 JSON / 没有 choices / 输出不合 schema / 写不出文件，一律落一份 `verdict: "INFRA"` 的记录并退出 3，绝不给 0。

## 三、放弃了什么

- **两个槽跑同一模型、靠不同 prompt 区分**：反思强度不同才叫两个脑子，换个提示词不叫。
- **两家厂商两份凭据**：多一份要轮换的密文，换来的独立性边际很小。
- **让模型自报 verdict**：见决定 5。
- **在 `audit-review.mjs` 里再写一份 findings schema**：两份判据必然漂移，口径层的 `validateResult` 已经在那儿。
- **给 `--model` 留个逃生口**：那就是绕过真源的第二条路，且会在 PR 里以「临时调试」的样子长期存活。

## 四、落地形状

- 新增 `scripts/audit-review.mjs`：`parseArgs` / `buildPrompt` / `verdictFor` / `parseModelJson` / `requestChat` / `run`；退出码 `0` 写出非 INFRA 记录、`2` 用法错（`--out` 目录不存在也不 mkdir）、`3` INFRA。diff 上限 120000 字符，超了截断并在 prompt 里前置说明。
- `.agents/platform/routing.yml`：`review-a` → `deepseek/deepseek-chat`，`review-b` → `deepseek/deepseek-reasoner`；`impl` 仍是占位值。
- `scripts/audit-findings.mjs`：跨槽不变式 `assess()` 的身份从 `executor` 改成 `executor + NUL + model`。
- `docs/audit-contract.md` §三.3 写明这条身份定义。

## 五、怎么验的

- `npx vitest run tests/audit-review.test.mjs` → 26 passed；`node scripts/routing.mjs --check` → `routing OK 3 条路由 / 6 个 workflow 无硬编码模型名`；整仓 `npm run check` → 全绿。
- 跨槽身份：`npx vitest run tests/audit-findings.test.mjs tests/audit-collect.test.mjs` → 225 passed；把 `claimants` 退回只认执行器 → 跨槽用例 2 红。
- 我自己的变异（`/tmp` 副本，每组先打印改后行）：INFRA 退出码改 0 → 11 红；把 key 塞进请求体 → 1 红；模型写死不从路由取 → 1 红；`evidence.request_id` 缺了也编一个 → **25 全绿**。
- 最后那组暴露一条真缺口：「不知道就不写这个键」原本没有任何用例在盯，于是我补了「上游回了 200 但没有 `id` → 记录里不许出现 `request_id`」，补完同一变异 1 红。**实现是对的，守卫是空的**——这类事只能用变异找，读代码看不出来。

## 六、仍然没有的（刻意）

- **还没接进 `audit.yml`**：现在仍要人 `gh workflow run -f findings_a=@…`；接线（生成 PR diff、两槽各跑一次、喂给口径层）是下一步。
- **没有真跑过一次**：本机没有可用于测试的 DeepSeek key，所有上游交互都在注入的 `fetch` 上完成。第一次真跑要等接线后在有 secret 的环境里做。
- **diff 只当文本看**：不按文件类型分块、不跳过二进制/锁文件、不做 per-file 截断配额；截断按整份 diff 从尾切。
- **两槽的并发与超时**：脚本只负责一个槽一次调用，`180` 秒超时；两个槽谁先跑、能不能并行，由调用方（workflow）决定。
- **分叉 PR 拿不到 secret**：契约 `docs/audit-contract.md` 已写明。
