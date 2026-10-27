#!/bin/sh
# deploy/agent-image/entrypoint.sh —— 容器里的第一件事。
#
# 契约（宿主 apps/chain 的 docker 执行器注入这些环境变量）：
#   CHAIN_NODE            节点键（如 dev-1、crosstest）
#   CHAIN_REPO            仓库地址：HTTP(S)/SSH 地址（clone 模式）或宿主本机绝对路径（mount 模式）
#   CHAIN_BRANCH          这次要处理的分支
#   CHAIN_WORKSPACE_MODE  clone（默认）或 mount
#   CHAIN_REQUIREMENT     需求 id
#   CHAIN_CONTEXT         需求正文/上下文
#   CHAIN_AGENTS_MD       本次追加的策略（写成 /work/AGENTS.md）
#   AGENT_CMD             镜像里定死的 agent 命令（如 "claude -p"）
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

say() { printf '%s\n' "$*"; }
verdict() { printf 'CHAIN_VERDICT: %s\n' "$*"; }
fail73() { verdict "reject $1"; exit 73; }

say "== 链条节点 =="
say "CHAIN_NODE=$NODE"
say "CHAIN_BRANCH=$BRANCH"
say "CHAIN_REPO=$REPO"
say "CHAIN_WORKSPACE_MODE=$MODE"
say "AGENT_NAME=${AGENT_NAME:-unknown}"
say "AGENT_CMD=${AGENT_CMD:-}"

AGENT_BIN="${AGENT_CMD%% *}"
if [ -n "$AGENT_BIN" ] && command -v "$AGENT_BIN" >/dev/null 2>&1; then
  ver="$("$AGENT_BIN" --version 2>&1 | head -n 1)"
  say "agent 版本：${ver:-（--version 没有输出）}"
else
  say "agent 不可执行：${AGENT_BIN:-（空）}——镜像 build 时 npm i -g 那一步可能失败了"
fi

# ---- 工作区 ----
case "$MODE" in
  mount)
    if [ -d "$WORK/.git" ]; then
      say "工作区 mount：直接用宿主挂进来的 ${WORK}（开发捷径，不 clone）"
    else
      say "工作区 mount，但 ${WORK} 里没有 .git"
      fail73 "工作区挂载里没有 .git：${WORK}"
    fi
    ;;
  clone)
    if [ -z "$REPO" ]; then
      fail73 "没有给仓库地址（CHAIN_REPO 为空）"
    fi
    if [ -d "$WORK/.git" ]; then
      say "工作区 clone：${WORK} 里已有仓库，直接复用"
    else
      say "工作区 clone：git clone --depth 1 --branch $BRANCH $REPO $WORK"
      rm -rf "$WORK"
      mkdir -p "$WORK"
      if err="$(git clone --depth 1 --branch "$BRANCH" "$REPO" "$WORK" 2>&1)"; then
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

# ---- 策略 ----
if [ -n "${CHAIN_AGENTS_MD:-}" ]; then
  if [ -f "$WORK/AGENTS.md" ]; then
    printf '\n## 本次节点的追加策略\n\n%s\n' "$CHAIN_AGENTS_MD" >> "$WORK/AGENTS.md"
    say "策略追加到已有的 ${WORK}/AGENTS.md（保留仓库自己的那份）"
  else
    printf '%s\n' "$CHAIN_AGENTS_MD" > "$WORK/AGENTS.md"
    say "策略写入：${WORK}/AGENTS.md"
  fi
else
  say "没有 CHAIN_AGENTS_MD，沿用仓库里已有的策略文件"
fi

# ---- prompt ----
PROMPT="${CHAIN_REQUIREMENT:-}"
if [ -n "${CHAIN_CONTEXT:-}" ]; then
  PROMPT="$PROMPT

$CHAIN_CONTEXT"
fi
if [ -z "$PROMPT" ]; then
  fail73 "没有需求内容（CHAIN_REQUIREMENT 与 CHAIN_CONTEXT 都是空）"
fi

if [ -z "${AGENT_CMD:-}" ]; then
  fail73 "镜像没有设 AGENT_CMD"
fi

# ---- 跑 agent ----
# 注意：AGENT_CMD 是镜像里声明的、经过验证的命令形式。换成别的 agent 或别的版本时，
# 先在容器里跑 <agent> --help 确认真实子命令，不要照着猜。
cd "$WORK" || fail73 "进不去工作区：$WORK"
say "开始跑 agent：${AGENT_CMD}（workdir=${WORK}）"
if out="$(printf '%s\n' "$PROMPT" | sh -c "$AGENT_CMD" 2>&1)"; then
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