# architecture.md · 架构总览

## 一、这是什么

AI 原生研发交付引擎：需求以 issue 入库，以 PR 交付，交付物是**可复算的证据**。
接入层（飞书 / 钉钉 / 微信 / CLI / Webhook）只发命令，不写状态。

三条不变式：

1. **状态只有一个家** —— issue 的 `state:*` label。平台不存第二份状态。
2. **判决与执行分离** —— 「能不能合」由 required status check 判定，不由评论判定；agent 只产出 findings，**不能改状态**。
3. **基础设施失败不算通过** —— `INFRA` 是独立出口，既不折算成 PASS，也不允许「重跑到绿」。

## 二、交付链

```text
接入层 → issue(proposed|bugfix) → 分析 → owner 裁决 → 分支/PR → 审计 → merge gate → 合并 → 知识库汇入
```

| 段                                    | 由谁执行                | 谁改状态              |
| ------------------------------------- | ----------------------- | --------------------- |
| 入库 + 分发                           | CI（issues.opened）     | CI                    |
| 分析（含交叉验证）                    | agent 沙盒，只出评论    | 不写（只建议）        |
| 裁决 accepted / rejected / needs-info | OWNERS 登记的 owner     | owner                 |
| 认领开发 → 开 PR                      | 人 / owner 指派的 agent | CI（PR 事件推导）     |
| 审计                                  | 一个契约 + 两个执行器   | 不写（产出 findings） |
| 合并                                  | required status checks  | CI                    |
| 知识库汇入                            | 合并后 job              | CI                    |

### 判据跑在哪（Node 载体全部删除后的事实）

- **一个二进制**：`apps/engine` 编译出 `.cache/bin/engine`，16 个子命令 —— `validate` / `check-config` / `consult` / `ledger` / `build-intent` / `last-change` / `writer-record` / `merge-gate` / `audit-findings` / `audit-slot` / `routing` / `audit-collect` / `audit-review` / `copy-dist` / `cli` / `kb-export`；`apps/api-go` 以库的形式在同一进程里调用它，不起子进程。
- **所有判据调用点都在这里**：六个 workflow（`audit` / `check` / `kb-sync` / `last-change` / `merge-gate` / `state-writer`）的判定步，以及 `package.json` 的 `check:state` / `check:web` / `web:dist` / `cli`，跑的都是 `./.cache/bin/engine`。构建唯一入口是 `npm run build:engine`，六个 workflow 都在 `npm ci` 之后各有一份 `actions/setup-go@v5`(1.22) + 一次 `npm run build:engine`——先有二进制，调用点才可能绿。
- **Node 只剩非判据用途**：workflow 里的内联 `node -e/-p`（`audit.yml` 4 处、`state-writer.yml` 5 处、`merge-gate.yml` 1 处，取 check runs、拼读 JSON 片段；以 HEAD 为准）与测试/工具链（vitest、prettier、oxlint、`tests/goldens/freeze.mjs`）。没有一处 Node 在执行判据，六个 workflow 仍留 `setup-node` 只为这些片段。
- **`scripts/` 里已没有 `.mjs`**：15 个 Node 载体整批删除，判据实现只在 `apps/engine`。独立参照不是旧脚本，而是 `tests/goldens/` 里 Node 时代冻下来的逐字节期望值（stdout / stderr / 退出码 / 写出文件 / 请求记录）；`freeze.mjs` 按 `scripts/` 下被引用文件是否存在判断能否重冻，a / b / c 三套因此不可重冻，命中即以可读说明中止，不崩溃也不静默跳过。

## 三、声明真源（一个事实只有一个家）

| 事实                                | 家                                                                                                                                                                                                                |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| issue 状态、允许的转换、谁能触发    | `.agents/platform/state-machine.yml`                                                                                                                                                                              |
| 转换合法性的机械判定                | `apps/engine`（Go 库 + `cmd/engine` 单二进制：平台与门在进程内调用，CI 与 npm 脚本调 `.cache/bin/engine`）；Node 侧对照物已整批删除，独立的第二意见是 `tests/goldens/` 的冻结 golden（不可重冻，见 `freeze.mjs`） |
| 权限项与交付节点的对应              | `docs/permissions.md`                                                                                                                                                                                             |
| 审计的输入、输出、判据与 INFRA 口径 | `docs/audit-contract.md`                                                                                                                                                                                          |
| PR 必填字段                         | `.github/PULL_REQUEST_TEMPLATE/proposed.md`、`.github/PULL_REQUEST_TEMPLATE/bugfix.md`                                                                                                                            |
| 汇入什么 / 何时 / 什么格式          | `docs/knowledge-base.md`                                                                                                                                                                                          |
| 每个模块是否强制带测试              | `OWNERS.md` 的模块表                                                                                                                                                                                              |
| 本机平台实例：HTTP 面与账本接口     | `apps/api-go/README.md`（判定与账本经 `apps/engine` 在进程内调用，不起子进程、不自己判状态机）                                                                                                                    |
| 本机平台实例：页面与交互            | `apps/web-vue/README.md`（页面只经 JSON API 说话，不判合法性，409 原样呈现）                                                                                                                                      |
| 远端 issue 列表快照（读缓存）       | `apps/api-go/README.md`（`.agents/platform/cache/remote.json` 是缓存，不是真源；304 不写、失败保留旧快照 + fetchedAt）                                                                                            |
| 派生索引（查询用）                  | `apps/api-go/README.md`（`.agents/platform/index.db` 纯派生，删了自愈；不许反向当作真源）                                                                                                                         |
| 在途投递台账（本地未完成的外发）    | `apps/api-go/README.md`（`.agents/platform/outbox.jsonl`：唯一无法从真源重建的本地事实，不进账本）                                                                                                                |

## 四、两段式触发（按实例分，不写进规范分支）

规范里不出现「如果是开源就……」。两段式是**实现路径**，不是配置项：

- **一段式**（私有实例）：`pull_request` 事件直接跑审计，secret 可用。
- **两段式**（公开实例）：`pull_request` 只跑确定性检查（**无 secret**）；`workflow_run` 才带 secret，且**绝不 checkout 不可信代码**。

分叉 PR 拿不到 secret，所以公开实例的审计只能走 GitHub 侧执行器；私有实例可走平台沙盒。**禁止跨实例搬运产物与知识库。**
