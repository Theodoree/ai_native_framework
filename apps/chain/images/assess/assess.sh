#!/bin/sh
# 需求评估容器：只用 POSIX sh 与 busybox 的工具，不联网、不写仓库。
# 输出即评论，最后一行是自审结论（平台按 CHAIN_VERDICT 读）。
set -eu

say() { printf '%s\n' "$*"; }

context=${CHAIN_CONTEXT:-}
branch=${CHAIN_BRANCH:-（未给出）}
node=${CHAIN_NODE:-（未给出）}
req=${CHAIN_REQUIREMENT:-（未给出）}

say "【需求评估】需求 $req / 节点 $node"
say "分支 $branch"
say "模型端 ${BASE_URL:-（未注入）} · 模型 ${CHAIN_MODEL:-（未注入）}"
say ""
say "--- 需求正文 ---"
say "${context:-（空）}"
say ""
say "--- 本站追加规则 ---"
say "${CHAIN_AGENTS_MD:-（无）}"
say ""

# 正文长度：去掉空白后算，太短的没法评估。
trimmed=$(printf '%s' "$context" | tr -d '[:space:]')
len=${#trimmed}

# 从正文里挑出像标识符的词（英文/数字/下划线），当作可搜的锚点。
# 中文正文挑不出锚点，这一点必须说出来，不能假装查过。
words=$(printf '%s' "$context" | tr -cs 'A-Za-z0-9_-' '\n' | awk 'length($0) >= 4' | sort -u | head -5)
hit=0

# busybox 的 grep 没有 --exclude-dir（给了会整条报用法错误、一个文件都不搜），
# 排除目录交给 find，命中只取前三个。
search() {
  find /work -type f \
    -not -path '*/.git/*' -not -path '*/node_modules/*' -not -path '*/.cache/*' \
    -exec grep -il -- "$1" {} + 2>/dev/null | head -3
}

say "--- 仓库 ---"
if [ -d /work ]; then
  files=$(find /work -type f -not -path '*/.git/*' -not -path '*/node_modules/*' -not -path '*/.cache/*' | wc -l | tr -d ' ')
  say "已挂载 /work，可见文件 $files 个"
  say "顶层："
  for d in /work/*; do
    [ -d "$d" ] || continue
    n=$(find "$d" -type f -not -path '*/.git/*' -not -path '*/node_modules/*' -not -path '*/.cache/*' | wc -l | tr -d ' ')
    say "  - $(basename "$d")/（$n 个文件）"
  done
  if [ -f /work/AGENTS.md ]; then
    say "仓库里有 AGENTS.md：改之前先看它的约束"
  fi
  if [ -n "$words" ]; then
    say "从正文里取出这些词去仓库里找：$(printf '%s' "$words" | tr '\n' ' ')"
    for w in $words; do
      matches=$(search "$w")
      if [ -n "$matches" ]; then
        hit=$((hit + 1))
        say "· $w 命中："
        printf '%s\n' "$matches" | sed 's|^/work/|  - |'
      fi
    done
    if [ "$hit" -eq 0 ]; then
      say "这些词在仓库里没有命中：诉求可能落在仓库之外"
    fi
  else
    say "正文里没有可搜的英文标识符（中文整段挑不出锚点），影响面没有机械证据"
  fi
else
  say "没有挂载 /work：只能按正文评估"
fi
say ""

# 结论：只判一件事——这段正文能不能被评估。判不了就明说，不要硬给通过。
if [ "$len" -lt 8 ]; then
  say "CHAIN_VERDICT: reject 需求正文去掉空白后只有 $len 个字符，没法据此评估"
  exit 0
fi

say "评估要点："
say "1. 正文 $len 字，诉求可辨认"
if [ ! -d /work ]; then
  say "2. 仓库未挂载，影响面待开发节点补"
elif [ "$hit" -eq 0 ]; then
  say "2. 仓库可见，但没有可搜的锚点，影响面待开发节点补"
else
  say "2. 仓库可见，$hit 个锚点在仓库里有命中，见上面的清单"
fi
if [ "$hit" -eq 0 ]; then
  say "3. 下一步建议：开发站先落一份改动清单，再动手"
else
  say "3. 下一步建议：把上面命中的文件当作改动起点，先在开发站落一份改动清单"
fi
say ""
say "CHAIN_VERDICT: pass"
