# P-30 自动审查先装依赖：本机有 node_modules 才显得绿的地方，CI 里第一次真跑就崩

状态：active（已落地）

## 一、怎么发现的

`audit` 一直是手动触发，所以 P-27 把「两个 input 都空时自己产出 findings」接进去之后，这条路在真实 Actions 上一次都没跑过。我用真事件跑了一次（`gh workflow run audit.yml --ref main -f pr=74`，不带 findings），run `40284427925` 直接红在 `自动 review-a`：

```text
Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'yaml' imported from .../scripts/routing.mjs
##[error]review-a 没跑成（退出码 1）：用法或写盘故障，不是判不了
```

`yaml` 是 devDependency，而 `audit.yml` 从头到尾没有安装依赖的步骤。本机 `node_modules` 一直在，所以本地跑任何脚本都正常、198 条用例全绿；CI 上是干净 checkout，`routing.mjs`（被 `audit-review.mjs` 导入，用来取模型真源）连模块都加载不了。

## 二、决定

- 在 `node` 之后加一步 `安装依赖`：`npm ci || npm install`，不带 `continue-on-error`（装不上就该红，不该让后面以「判不了」收场）。
- 沙箱（`tests/audit-findings.test.mjs` 的行为 runner）按 name 跳过联网步（`NETWORK_STEPS = new Set(["安装依赖"])`），因为沙箱没有 lockfile、跑起来只有噪声。
- 跳过必须配一条形状断言：这一步存在、排在 `node` 之后、`run` 含 `npm ci`、没有 `continue-on-error`。否则「跳过」会退化成「可以不装」——正是这次的成因。

## 三、放弃了什么

- **不**把 `yaml` 换成手写解析或把 `routing.yml` 改成 JSON：为了绕开一次安装而改数据格式，是拿契约换方便。
- **不**在 `audit-review.mjs` 里 catch 掉 `ERR_MODULE_NOT_FOUND` 记 INFRA：那会把「管线坏了」伪装成「判不了」，让人以为只是没配 key。
- **不**只在本地验证「装了依赖就能跑」：本地一直有 `node_modules`，这种验证证明不了 CI。

## 四、怎么验的（真事件，不是本地）

分支 `fix/p30-audit-install-deps`（提交 `2e57468`）推上去后，用该 ref dispatch：`gh workflow run audit.yml --ref fix/p30-audit-install-deps -f pr=74` → run `40285322981` **completed/success**，步骤链：`checkout → node → 安装依赖 success → 解析 PR 上下文 → 选择 findings 来源 → 取 PR diff → 自动 review-a success → 自动 review-b success → 落盘(skipped，auto=1) → 口径层判定 → 结论兜底 → 回写 Check Run → 结论自证 → INFRA 留痕 → 判定`。

PR #74 的 head `53bf152` 上留下 `name=audit conclusion=action_required title="audit INFRA"`（id `121447566381`）—— 没有 `DEEPSEEK_API_KEY` 时按设计写 INFRA，job 仍是绿的（判不了不等于没跑成）。

变异：删掉 `安装依赖` 步骤 → 新用例 1 failed；恢复后 199 passed。

## 五、仍然没有的

- 仓库仍没有 `DEEPSEEK_API_KEY`（`gh secret list --json name` 为空），所以真跑出 `success` 的那一半还没验过；现在这条路的结论是诚实的 `action_required`。
- 装依赖用 `npm ci || npm install`：`npm ci` 失败（比如 lockfile 与 package.json 不同步）时会静默退到 `npm install`，两者都不算慢，但「为什么退」不会出现在日志的显式判断里。
