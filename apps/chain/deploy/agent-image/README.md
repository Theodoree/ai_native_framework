# 三个 agent 镜像（codex / claude / deepseek-harness）

链条上的容器节点（create / assess / crosstest / release）跑的就是这里的镜像。
空节点（dev / merge）由人动手，不起容器。

## 先有镜像，才有链条

    cd "$HOME/.<项目名>/agent-image" && sh build-images.sh  # 得到 <项目名>/agent-{codex,claude,deepseek-harness}:latest
    VERSION=0.1.0 sh build-images.sh                        # 或者自己定 tag
    APP_NAME=别的名字 sh build-images.sh                    # 或者换镜像前缀

项目名与**镜像 tag** 都不写死：`build-images.sh` 用 `APP_NAME`（默认 = 项目名，展开时由
`chain assets` 把 ${APP} 换成真名）和 `VERSION`（默认 `latest`）；`nodes.yaml` 里各模板的
`image: ${APP}/agent-xxx:latest` 与它们一一对应。

> 没展开就在仓库里直接跑这份脚本会报「没有项目名」并停下——这是故意的：宁可停下，
> 也不要烘出一个没人引用的 tag。要么先 `chain assets`，要么 `APP_NAME=名字 sh build-images.sh`。

三个 Dockerfile 只差 `AGENT_NAME` 一行——**它们都不预装 agent CLI**（见下一节）。
想换成自己的 registry，改 `nodes.yaml` 里各模板的 `image` 一行即可，代码不用动。

| 镜像                                     | 运行时装的包（npx 解析，2026-10-28 核实） | 非交互跑法    |
| ---------------------------------------- | ---------------------------------------- | ------------- |
| `<项目名>/agent-codex:latest`            | `@openai/codex`                          | `codex exec`  |
| `<项目名>/agent-claude:latest`           | `@anthropic-ai/claude-code`              | `claude -p`   |
| `<项目名>/agent-deepseek-harness:latest` | `@deepseek-ai/dsh`                       | `dsh`         |

> `deepseek-harness@0.0.1` 是占位包，别装。真正的包名是 `@deepseek-ai/dsh`；这三个包名与
> 非交互跑法都写在 `entrypoint.sh` 的 `agentPackage` / `agentSubcommand` 里。

## 换 CLI 版本不需要重烘镜像

**镜像只是运行时，版本是数据。** 宿主按节点声明注入 `CHAIN_AGENT`（哪个 CLI）与
`CHAIN_AGENT_VERSION`（哪个版本），entrypoint 在容器里执行
`npx -y <包>@<版本> <非交互跑法>` —— 版本在运行时解析，不是镜像里预装好几个版本。

- 换版本：改 `nodes.yaml` 里的 `versions` 候选清单，或前端直接手填（自由输入，allow-create）。
- 换镜像 tag 与换 CLI 版本是**两件事**：`image` 决定用哪个镜像，`version` 决定镜像里跑哪个 CLI 版本。
  只有将来真把 harness 烘进镜像（`image:tag = harness@version`）时两者才会绑在一起，本期没做。
- 代价（已知边界，见文末）：`npx` 需要容器能访问 npm registry；完全离线的部署要在镜像里预装
  并把 `AGENT_CMD` 打开注释，那时版本由镜像自己定。

## 容器里发生什么（entrypoint.sh）

宿主（`apps/chain` 的 docker 执行器）注入这些环境变量，entrypoint 照着做：

| 变量                                  | 含义                                            |
| ------------------------------------- | ----------------------------------------------- |
| `CHAIN_NODE`                          | 节点键，如 `crosstest`                          |
| `CHAIN_REPO`                          | 仓库地址；本机绝对路径表示开发用的挂载模式      |
| `CHAIN_BRANCH`                        | 这次要处理的分支                                |
| `CHAIN_WORKSPACE_MODE`                | `clone`（默认）或 `mount`                       |
| `CHAIN_REQUIREMENT` / `CHAIN_CONTEXT` | 需求 id 与正文，拼成 prompt 从 stdin 喂给 agent |
| `CHAIN_SOURCE`                        | 仓库在工作区里的子目录名，默认 `repo`（工作区根 = `/work`） |
| `CHAIN_AGENTS_MD`                     | 工作区根 `AGENTS.md` 的**整份正文**（平台每次重写，不是往仓库那份后面追加） |
| `CHAIN_AGENTS_APPEND`                 | 只有「本站临时追加」那一段；有就写进 `AGENTS.md` 末尾并拼进 prompt |
| `CHAIN_AGENT`                         | 跑哪个 CLI（模板键：`codex` / `claude` / `deepseek-harness`） |
| `CHAIN_AGENT_VERSION`                 | 那个 CLI 的版本（默认 `latest`），运行时用 `npx` 解析 |
| `AGENT_CMD`                           | 可选：镜像里定死的命令；声明了就覆盖上面两个（自带 CLI 的场景） |

顺序是：打头部信息（含跑哪个 CLI、哪个版本）→ clone 或复用挂载 → 写工作区 `AGENTS.md` → 跑 agent
→ **最后一行是 `CHAIN_VERDICT:`**（前提是真的有结论）。

- **工作区布局**：`/work/AGENTS.md` 是平台的文件（每次整份重写），仓库在 `/work/$CHAIN_SOURCE/`
  （默认 `/work/repo`），agent 的 cwd 是 `/work`——它要同时看到策略与仓库子目录。
  仓库自带的 `$SOURCE/AGENTS.md` **一个字都不动**，`/work/AGENTS.md` 里只有一句指针让它去读。
  有 `CHAIN_AGENTS_APPEND` 时 `/work/AGENTS.md` 末尾接一段 `## 本站临时追加`；没有就不留空小节。

- **命令从哪来**：`AGENT_CMD` 有值就用它（镜像自带 CLI）；否则按 `CHAIN_AGENT` 查包名与
  非交互跑法，拼成 `npx -y <包>@<CHAIN_AGENT_VERSION>`。认不出 `CHAIN_AGENT` 又没有
  `AGENT_CMD` → exit 73。版本不做白名单：手填一个没写在 `versions` 里的版本也照跑。

- **clone 模式（默认）**：`git clone --depth 1 --branch "$CHAIN_BRANCH" "$CHAIN_REPO" /work/$CHAIN_SOURCE`。
  失败就打 git 的 stderr 与原因，然后 `CHAIN_VERDICT: reject clone 失败：…` 并 **exit 73**。
- **mount 模式（只有本地开发的绝对路径才用）**：宿主把本机目录挂到 `/work/$CHAIN_SOURCE`，
  那里得有 `.git`，有就直接用、不 clone。没有就 exit 73。这是捷径：真实部署永远走 clone。
- **结论**：agent 自己打了 `CHAIN_VERDICT: pass` / `CHAIN_VERDICT: reject 原因`，入口原样透出并放最后一行。
  没打标记时：非 0 退出 → `reject agent 退出码 N`（跑挂了本身就是结论）；
  **退出码 0 但没有标记 → 入口不打任何 CHAIN_VERDICT 行**，只打一句「agent 没有给出结论：本站交回人工审核」。
  脚本不替 agent 下结论：没结论就是没结论，平台侧（`parseVerdict`）认不出标记就落 unknown，本站交回人工审核 ——
  入口要是抢先补一句 `pass`，人工兜底那条路就断了。
- **不猜**：认不出 `CHAIN_AGENT` 且没有 `AGENT_CMD` → `fail73`（「认不出 CHAIN_AGENT=…」）；
  `AGENT_CMD` 有值但命令不存在时由 shell 报 127，入口照实判 `reject agent 退出码 127`。
- **跑的是哪个版本，日志里能看到**：头两行 `CHAIN_AGENT` / `CHAIN_AGENT_VERSION` 与「agent 命令：…」
  都打在容器日志里，Agent 的结论可以按它回溯。

退出码：`0` = 跑完了（结论在标记里；也可能没有结论——那时一行 CHAIN_VERDICT 都没有）；
`73` = 环境没准备好（clone 失败 / 挂载里没 .git / 认不出 agent 又没有 AGENT_CMD / 没 npx / 没需求内容），
这时也一定打了一行 reject。

## 已知边界

- **私有仓库 clone 需要凭证，本期不注入 token**。走 clone 的私有仓库会 clone 失败并 exit 73；
  要支持就得在宿主侧加凭证注入（deploy key / HTTPS token / credential helper），还没做。
- **`/work/AGENTS.md` 会被覆盖**：容器里每次执行都整份重写它，别把持久内容放在那个位置；
  要改 agent 的行为写在仓库自己的 `AGENTS.md`（原样保留）或这一站的自定义 AGENTS.md 里。
- **AGENT_CMD 的 CLI 形式只保证是「非交互 + 从 stdin 读 prompt」这一类**。换 agent 或升版本时，
  先在容器里跑 `<agent> --help` 确认真实子命令与开关，再改 Dockerfile 里的 AGENT_CMD——
  不要照着别的版本猜。
- 镜像里没有模型密钥；`CHAIN_MODEL_KEY` 由宿主以 `-e` 注入，日志里会被抹成 `***`。
- 只装了 git / ca-certificates / node，**没有预装 agent CLI**，也没有测试工具链；
  需要跑测试的节点自己用仓库里的脚本，或者在镜像里自己加。
- **`npx` 需要容器能访问 npm registry**。离线部署要么给 registry 代理，要么在 Dockerfile 里
  预装 CLI 并打开 `ENV AGENT_CMD`（那时版本由镜像定，`CHAIN_AGENT_VERSION` 不再起作用）。

## 手动试一次

    docker run --rm -it \
      -e CHAIN_NODE=crosstest -e CHAIN_BRANCH=main \
      -e CHAIN_REPO=https://example.com/org/repo.git -e CHAIN_WORKSPACE_MODE=clone \
      -e CHAIN_REQUIREMENT=REQ-1 -e CHAIN_CONTEXT="跑测试并给出结论" \
      -e CHAIN_SOURCE=repo -e CHAIN_AGENT=codex -e CHAIN_AGENT_VERSION=0.164.0 \
      ai_native_framework/agent-codex:latest   # <项目名>/agent-codex:<镜像 tag>
