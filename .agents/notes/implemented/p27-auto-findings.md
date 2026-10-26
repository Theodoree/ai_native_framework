# P-27 审计自动产出 findings（接进 audit.yml）

状态：active（已落地）

## 一、为什么做

P-26 给了审查执行器，但没有任何东西会去调它：`audit` 要人先手写两份 findings 再 `gh workflow run`。
于是「审计」在真实流程里等于不存在——每个 PR 都靠人记得去造输入。`docs/audit-contract.md` 要求的输入
（两份独立 opinion）要么由人生成，要么就永远没有。

这一步把「谁产出 findings」接进 workflow 本体：两个 input 都为空时，自己产出。

## 二、决定

1. **二选一，绝不混用**：`findings_a` / `findings_b` 任一非空 → 只认人给的，自动路径整段不跑；
   两个都为空（纯空白也算空）→ 自动产出。混着用会让「这一票是谁投的」变成两个来源拼出的混合物，
   而口径层逐条比对的前提正是「两个槽各自独立投一票」。
2. **来源判断走 env，不进 run 块**：`${{ inputs.* }}` 出现在 `run:` 里就是一次 shell 拼接。
   判断结果落成 `source` 步骤的 `auto=1|0` output，后面的步骤按 `if` 分两路。
3. **自动槽自报 `--executor github`，人给输入自报 `--executor sandbox`**：执行器是事实描述
   （谁真的跑出来的），不是标签。两条路径的执行器不同，这是它们只能二选一的另一个理由。
4. **退出 3 = 一条结论，不是故障**：脚本没有 key / 上游不可达 / 回的不合契约时会写下 INFRA 记录并退出 3。
   那一步不红（红只留给退出 2 与「退出 3 但文件没落地」）：否则「判不了」和「真没过」压成同一种红，
   而两者的责任方向相反。
5. **diff 只问 GitHub 要**：`gh pr diff <pr>`。不走 `fetch-depth: 0` + 比对 base sha 那套，
   那要为 CI 额外开一条下载面，而这里要的只是「被审对象改了什么」。
6. **空 diff 直接红**：空补丁不是「没问题」而是「没有可审的对象」，不能在取输入这一步就放过。
7. **没有 secret 就是 INFRA，不是通过**：仓库当前 `gh secret list` 为空，接进 CI 后自动路径必然
   写出 INFRA、`audit` 结论必然是 `action_required`。这是正确行为——判不了。

## 三、放弃了什么

- **一个 secret 跑两个槽但同一模型**：两槽自报同执行器同模型 → 跨槽不变式判 INFRA。模型必须不同。
- **自动路径失败时回落成人给输入**：两条来源拼接，一票说不清是谁投的。
- **把 diff 落成 artifact 供复查**：多一个产物面，且 diff 里可能有不该外传的内容。
- **retry/超时重排**：执行器自己带 180s 超时，重排在 workflow 里没有可信语义。
- **让自动路径也接受 `--executor sandbox`**：执行器写错会让跨槽不变式误判独立性。

## 四、落地形状

`.github/workflows/audit.yml`（+88）：新增「选择 findings 来源」（id `source`）、「取 PR diff」、
「自动 review-a」、「自动 review-b」四步；「落盘 review-a/b」的 `if` 加 `&& steps.source.outputs.auto == '0'`。
自动两步分别调 `node scripts/audit-review.mjs --slot review-a|review-b --diff … --out $RUNNER_TEMP/…`，
key 只经 `env: DEEPSEEK_API_KEY` 进入。

`tests/audit-findings.test.mjs`（+159）：沙箱 workflow 的假 `gh` 增 `pr diff` 分支；新增用例覆盖
「两 input 都空 → 自动路径真跑并落盘」「有一份输入 → 自动路径整段不跑」「自动路径能落成 pass」
「退出 3 不红、退出 2 红」；载体写者集合改为「每条载体两个互斥写者」。

## 五、怎么验的

- `npx vitest run tests/audit-findings.test.mjs` = 198 passed；整仓 `npm run check` exit 0。
- 我自己的四组变异（/tmp 副本，先打印改后行）：
  `auto=1` → `auto=0`：2 红；自动槽 `--executor github` → `sandbox`：2 红；
  `[ "$code" -ne 0 ] && [ "$code" -ne 3 ]` → 只留前者：1 红；整段删掉「取 PR diff」：1 红。还原后 198 绿。
- 无凭据实跑：`env -u DEEPSEEK_API_KEY node scripts/audit-review.mjs --slot review-a --diff … --out …`
  → 打印 `verdict=INFRA`、exit 3、文件里有 INFRA 记录且 evidence 不含 `request_id`。

## 六、仍然没有的（刻意 / 已知）

- **仓库没有任何 secret**，所以 CI 里这条路径还从未真跑过一次 `pass`。要真跑需要人先
  `gh secret set DEEPSEEK_API_KEY`——凭据只能由人给。
- 分叉 PR 拿不到 secret（`docs/audit-contract.md` 已写明），那种情况恒 INFRA。
- 两槽串行跑（同一 job 内顺序执行），并发与超时不由 workflow 掌握。
- `audit` 仍不挂 required：在拿到真结论之前挂 required 等于每个 PR 自己锁死。
