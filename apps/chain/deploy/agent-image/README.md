# 三个 agent 镜像（codex / claude / deepseek-harness）

链条上的容器节点（create / assess / crosstest / release）跑的就是这里的镜像。
空节点（dev / merge）由人动手，不起容器。

## 先有镜像，才有链条

    cd "$HOME/.<项目名>/agent-image" && sh build-images.sh  # 得到 <项目名>/agent-{codex,claude,deepseek-harness}:latest
    VERSION=0.1.0 sh build-images.sh                        # 或者自己定 tag
    APP_NAME=别的名字 sh build-images.sh                    # 或者换镜像前缀

项目名与版本都不写死：`build-images.sh` 用 `APP_NAME`（默认 = 项目名，展开时由
`chain assets` 把 ${APP} 换成真名）和 `VERSION`（默认 `latest`）；`nodes.yaml` 里的
`image: ${APP}/agent-xxx` + `version: latest` 与它们一一对应。

> 没展开就在仓库里直接跑这份脚本会报「没有项目名」并停下——这是故意的：宁可停下，
> 也不要烘出一个没人引用的 tag。要么先 `chain assets`，要么 `APP_NAME=名字 sh build-images.sh`。

三个 Dockerfile 只差两行：`npm i -g` 的包名，和 `AGENT_CMD`。想换成自己的 registry，
改 `nodes.yaml` 里各模板的 `image` 一行即可，代码不用动。

| 镜像                                     | 装的包（2026-10-28 核实）           | 默认 AGENT_CMD |
| ---------------------------------------- | ----------------------------------- | -------------- |
| `<项目名>/agent-codex:latest`            | `@openai/codex@0.164.0`             | `codex exec`   |
| `<项目名>/agent-claude:latest`           | `@anthropic-ai/claude-code@2.1.311` | `claude -p`    |
| `<项目名>/agent-deepseek-harness:latest` | `@deepseek-ai/dsh@0.2.1-rc.2`       | `dsh`          |

> `deepseek-harness@0.0.1` 是占位包，别装。真正的包名是 `@deepseek-ai/dsh`。

## 容器里发生什么（entrypoint.sh）

宿主（`apps/chain` 的 docker 执行器）注入这些环境变量，entrypoint 照着做：

| 变量                                  | 含义                                            |
| ------------------------------------- | ----------------------------------------------- |
| `CHAIN_NODE`                          | 节点键，如 `crosstest`                          |
| `CHAIN_REPO`                          | 仓库地址；本机绝对路径表示开发用的挂载模式      |
| `CHAIN_BRANCH`                        | 这次要处理的分支                                |
| `CHAIN_WORKSPACE_MODE`                | `clone`（默认）或 `mount`                       |
| `CHAIN_REQUIREMENT` / `CHAIN_CONTEXT` | 需求 id 与正文，拼成 prompt 从 stdin 喂给 agent |
| `CHAIN_AGENTS_MD`                     | 本次追加策略，写成（或追加到）`/work/AGENTS.md` |
| `AGENT_CMD`                           | 镜像里声明的 agent 命令，入口用 `sh -c` 跑它    |

顺序是：打头部信息 → **clone 或复用挂载** → 写策略 → 跑 agent → **最后一行必须是 `CHAIN_VERDICT:`**（前提是真的有结论）。

- **clone 模式（默认）**：`git clone --depth 1 --branch "$CHAIN_BRANCH" "$CHAIN_REPO" /work`。
  失败就打 git 的 stderr 与原因，然后 `CHAIN_VERDICT: reject clone 失败：…` 并 **exit 73**。
- **mount 模式（只有本地开发的绝对路径才用）**：`/work` 里得有 `.git`，有就直接用、不 clone。
  没有就 exit 73。这是捷径：真实部署永远走 clone。
- **结论**：agent 自己打了 `CHAIN_VERDICT: pass` / `CHAIN_VERDICT: reject 原因`，入口原样透出并放最后一行。
  没打标记时：非 0 退出 → `reject agent 退出码 N`（跑挂了本身就是结论）；
  **退出码 0 但没有标记 → 入口不打任何 CHAIN_VERDICT 行**，只打一句「agent 没有给出结论：本站交回人工审核」。
  脚本不替 agent 下结论：没结论就是没结论，平台侧（`parseVerdict`）认不出标记就落 unknown，本站交回人工审核 ——
  入口要是抢先补一句 `pass`，人工兜底那条路就断了。
- **不猜**：`AGENT_BIN` 取不到时只打一行警告，随后 `AGENT_CMD` 为空会在跑 agent 之前 `fail73`（「镜像没有设 AGENT_CMD」）；
  `AGENT_CMD` 有值但命令不存在时由 shell 报 127，入口照实判 `reject agent 退出码 127`。

退出码：`0` = 跑完了（结论在标记里；也可能没有结论——那时一行 CHAIN_VERDICT 都没有）；
`73` = 环境没准备好（clone 失败 / 挂载里没 .git / 没设 AGENT_CMD / 没需求内容），这时也一定打了一行 reject。

## 已知边界

- **私有仓库 clone 需要凭证，本期不注入 token**。走 clone 的私有仓库会 clone 失败并 exit 73；
  要支持就得在宿主侧加凭证注入（deploy key / HTTPS token / credential helper），还没做。
- **AGENT_CMD 的 CLI 形式只保证是「非交互 + 从 stdin 读 prompt」这一类**。换 agent 或升版本时，
  先在容器里跑 `<agent> --help` 确认真实子命令与开关，再改 Dockerfile 里的 AGENT_CMD——
  不要照着别的版本猜。
- 镜像里没有模型密钥；`CHAIN_MODEL_KEY` 由宿主以 `-e` 注入，日志里会被抹成 `***`。
- 只装了 git / ca-certificates / node 与三选一的 agent 包，没有装测试工具链；
  需要跑测试的节点自己用仓库里的脚本，或者在镜像里自己加。

## 手动试一次

    docker run --rm -it \
      -e CHAIN_NODE=crosstest -e CHAIN_BRANCH=main \
      -e CHAIN_REPO=https://example.com/org/repo.git -e CHAIN_WORKSPACE_MODE=clone \
      -e CHAIN_REQUIREMENT=REQ-1 -e CHAIN_CONTEXT="跑测试并给出结论" \
      ai_native_framework/agent-codex:latest   # <项目名>/agent-codex:<version>
