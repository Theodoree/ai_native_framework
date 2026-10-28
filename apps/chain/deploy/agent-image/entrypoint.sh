#!/bin/sh
# deploy/agent-image/entrypoint.sh —— 容器里的第一件事。
#
# 契约（宿主 apps/chain 的 docker 执行器注入这些环境变量）：
#   CHAIN_NODE            节点键（如 dev-1、crosstest）
#   CHAIN_REPO            仓库地址：HTTP(S)/SSH 地址（clone 模式）或宿主本机绝对路径（mount 模式）
#   CHAIN_BRANCH          这次要处理的分支
#   CHAIN_WORKSPACE_MODE  clone（默认）或 mount
#   CHAIN_SOURCE          仓库在工作区里的子目录名（默认 repo）
#   CHAIN_WORK_DIR        工作区根（默认 /work）
#   CHAIN_REQUIREMENT     需求 id
#   CHAIN_CONTEXT         需求正文/上下文
#   CHAIN_AGENTS_MD       整份 AGENTS.md 的正文（平台每次执行整份重写 $WORK/AGENTS.md）
#   CHAIN_AGENTS_APPEND   本站临时追加的那段（同一份内容也拼进 prompt，给不读文件的 agent 兜底）
#   CHAIN_AGENT           跑哪个 agent CLI（模板键：codex / claude / deepseek-harness）
#   CHAIN_AGENT_VERSION   那个 CLI 的版本（默认 latest），运行时按版本解析
#   AGENT_CMD             可选：镜像里定死的命令，声明了就覆盖上面两个（自带 CLI 的场景）
#
# 工作区布局（用户定的）：
#   $WORKSPACE/AGENTS.md          ← 平台写，每次整份重写
#   $WORKSPACE/$SOURCE/            ← git clone 出来的仓库（mount 模式下就是挂进来的目录）
# 仓库自带的 AGENTS.md 在 $SOURCE/AGENTS.md，脚本一个字都不改它。
# agent 的 cwd 是工作区根：既看得到 AGENTS.md，也看得到仓库子目录。
#
# 三种退出码：0 = 跑完了（agent 给了结论就在标记里；没给就不打标记，平台落 unknown
# 交回人工审核 —— 脚本不替 agent 下结论）；73 = 环境没准备好（clone 失败、挂载里没
# .git、没设 AGENT_CMD），此时也一定会打一行 reject。
set -u

MODE="${CHAIN_WORKSPACE_MODE:-clone}"
REPO="${CHAIN_REPO:-}"
BRANCH="${CHAIN_BRANCH:-}"
NODE="${CHAIN_NODE:-}"
WORK="${CHAIN_WORK_DIR:-/work}"
SOURCE="${CHAIN_SOURCE:-repo}"
SRC="$WORK/$SOURCE"

say() { printf '%s\n' "$*"; }
verdict() { printf 'CHAIN_VERDICT: %s\n' "$*"; }
fail73() { verdict "reject $1"; exit 73; }

say "== 链条节点 =="
say "CHAIN_NODE=$NODE"
say "CHAIN_BRANCH=$BRANCH"
say "CHAIN_REPO=$REPO"
say "CHAIN_WORKSPACE_MODE=$MODE"
say "CHAIN_WORK_DIR=$WORK"
say "CHAIN_SOURCE=$SOURCE"
AGENT="${CHAIN_AGENT:-}"
AGENT_VERSION="${CHAIN_AGENT_VERSION:-latest}"
say "AGENT_NAME=${AGENT_NAME:-unknown}"
say "CHAIN_AGENT=${AGENT:-unknown}"
say "CHAIN_AGENT_VERSION=$AGENT_VERSION"
say "AGENT_CMD=${AGENT_CMD:-}"

# ---- 跑哪个 CLI、哪个版本 ----
# 镜像是运行时，版本是数据：镜像不预装多个版本，这里按 CHAIN_AGENT + CHAIN_AGENT_VERSION
# 在运行时解析（npm 系包走 npx -y <pkg>@<version>）。所以换 CLI 版本不需要重烘镜像。
# 版本是自由输入（前端 allow-create），这里不校验、不白名单，原样交给 CLI 自己。
# AGENT_CMD 一旦声明就优先——留给「镜像里真预装了 CLI」与测试。
agentPackage() {
  case "$1" in
    codex) printf '%s' "@openai/codex" ;;
    claude) printf '%s' "@anthropic-ai/claude-code" ;;
    deepseek-harness) printf '%s' "@deepseek-ai/dsh" ;;
    *) printf '%s' "" ;;
  esac
}
agentSubcommand() {
  # 非交互跑法：codex 要显式 exec，claude 要 -p（prompt 走 stdin），dsh 直接吃 stdin。
  case "$1" in
    codex) printf '%s' "exec" ;;
    claude) printf '%s' "-p" ;;
    *) printf '%s' "" ;;
  esac
}

if [ -n "${AGENT_CMD:-}" ]; then
  RUN_CMD="$AGENT_CMD"
  say "agent 命令：镜像声明的 AGENT_CMD（版本由镜像自己定，不看 CHAIN_AGENT_VERSION）"
  AGENT_BIN="${AGENT_CMD%% *}"
  if command -v "$AGENT_BIN" >/dev/null 2>&1; then
    ver="$("$AGENT_BIN" --version 2>&1 | head -n 1)"
    say "agent 版本：${ver:-（--version 没有输出）}"
  fi
else
  PKG="$(agentPackage "$AGENT")"
  if [ -z "$PKG" ]; then
    fail73 "认不出 CHAIN_AGENT=${AGENT:-（空）}，镜像也没有声明 AGENT_CMD"
  fi
  if ! command -v npx >/dev/null 2>&1; then
    fail73 "镜像里没有 npx，跑不了 $PKG@$AGENT_VERSION"
  fi
  SUB="$(agentSubcommand "$AGENT")"
  if [ -n "$SUB" ]; then
    RUN_CMD="npx -y $PKG@$AGENT_VERSION $SUB"
  else
    RUN_CMD="npx -y $PKG@$AGENT_VERSION"
  fi
  say "agent 命令：${RUN_CMD}（运行时按版本解析，不靠镜像预装）"
fi

# ---- 工作区：仓库落在子目录里，工作区根留给平台写的 AGENTS.md ----
case "$MODE" in
  mount)
    if [ -d "$SRC/.git" ]; then
      say "工作区 mount：宿主目录挂在 ${SRC}（开发捷径，不 clone）"
    else
      say "工作区 mount，但 ${SRC} 里没有 .git"
      fail73 "工作区挂载里没有 .git：${SRC}"
    fi
    ;;
  clone)
    if [ -z "$REPO" ]; then
      fail73 "没有给仓库地址（CHAIN_REPO 为空）"
    fi
    if [ -d "$SRC/.git" ]; then
      say "工作区 clone：${SRC} 里已有仓库，直接复用"
    else
      say "工作区 clone：git clone --depth 1 --branch $BRANCH $REPO $SRC"
      rm -rf "$SRC"
      mkdir -p "$SRC"
      if err="$(git clone --depth 1 --branch "$BRANCH" "$REPO" "$SRC" 2>&1)"; then
        say "clone 成功：分支 $BRANCH"
      else
        printf '%s\n' "$err"
        say "clone 失败的原因在上面（分支不存在、地址写错、或私有仓库没有凭证）"
        fail73 "clone 失败：$BRANCH @ $REPO"
      fi
    fi
    ;;
  *)
    fail73 "不认识的 CHAIN_WORKSPACE_MODE：${MODE}（只有 clone 与 mount）"
    ;;
esac

# ---- 策略：平台这份每次整份重写；仓库自带那份（$SOURCE/AGENTS.md）一个字都不动 ----
if [ -n "${CHAIN_AGENTS_MD:-}" ]; then
  printf '%s\n' "$CHAIN_AGENTS_MD" > "$WORK/AGENTS.md"
  say "策略写入：${WORK}/AGENTS.md（整份覆盖，含默认职责与仓库策略指针）"
else
  say "没有 CHAIN_AGENTS_MD：工作区根不放策略文件，仓库自己那份照旧"
fi
if [ -f "$SRC/AGENTS.md" ]; then
  say "仓库自带的策略在 ${SRC}/AGENTS.md：先读它，与工作区根那份冲突时以根那份为准"
fi

# ---- prompt ----
PROMPT="${CHAIN_REQUIREMENT:-}"
if [ -n "${CHAIN_CONTEXT:-}" ]; then
  PROMPT="$PROMPT

$CHAIN_CONTEXT"
fi
# 追加内容也拼进 prompt：有的 agent 不读文件，prompt 是保底（用户口径里这一条是必须的）。
if [ -n "${CHAIN_AGENTS_APPEND:-}" ]; then
  PROMPT="$PROMPT

## 本站临时追加

$CHAIN_AGENTS_APPEND"
fi
if [ -z "$PROMPT" ]; then
  fail73 "没有需求内容（CHAIN_REQUIREMENT 与 CHAIN_CONTEXT 都是空）"
fi

# ---- 跑 agent ----
# agent 的 cwd 是工作区根（不是仓库目录）：它要同时看到 AGENTS.md 与仓库子目录。
# 注意：RUN_CMD 要么是镜像声明的 AGENT_CMD，要么是按 agent 键与版本拼出来的 npx 调用。
# 换成别的 agent 或别的版本时，先在容器里跑 <agent> --help 确认真实子命令，不要照着猜。
cd "$WORK" || fail73 "进不去工作区：$WORK"
say "开始跑 agent：${RUN_CMD}（workdir=${WORK}，仓库在 ${SRC}）"
if out="$(printf '%s\n' "$PROMPT" | sh -c "$RUN_CMD" 2>&1)"; then
  code=0
else
  code=$?
fi
printf '%s\n' "$out" | tail -n 200

# ---- 结论：最后一行必须是 CHAIN_VERDICT ----
mark="$(printf '%s\n' "$out" | grep -o 'CHAIN_VERDICT:.*' | tail -n 1)"
if [ -n "$mark" ]; then
  say "agent 自己给了结论：${mark}"
  say "$mark"
  exit 0
fi
if [ "$code" -eq 0 ]; then
  # 不替 agent 编结论：没标记就是没结论，平台侧会把它落成 unknown 并交回人工审核。
  # 这里一旦补一句 pass，人工兜底那条路就断了（「没人给结论」被伪装成「通过」）。
  say "agent 没有给出结论：本站交回人工审核"
else
  say "agent 退出码 ${code}，且没有给 CHAIN_VERDICT 标记"
  verdict "reject agent 退出码 $code"
fi
exit 0
