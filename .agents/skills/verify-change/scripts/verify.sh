#!/usr/bin/env bash
# verify-change 自带验证脚本：识别项目技术栈 → 跑测试 → 逐项结果 + 汇总行。
# 非交互、不联网、不改仓库文件；识别不到技术栈时打印 SKIP 并 exit 0（这不是错误）。
# 兼容 macOS 自带 bash 3.2：不用 mapfile / 关联数组 / ${var^^}。
set -u

WORK=""
trap '[ -z "$WORK" ] || rm -rf "$WORK"' EXIT

usage() {
  cat <<'EOF'
用法: verify.sh [--run "<命令>"]... [--dry-run] [--help]

  （无参数）  按项目自带的工具配置文件自动识别要跑什么
  --run CMD   指定要跑的命令；可重复；出现即覆盖自动识别
  --dry-run   只打印计划，不执行
  --help      打印本用法

自动识别（按优先级取第一个命中；只认项目已有的配置文件，不新增任何格式）：
  package.json -> <包管理器> test（包管理器按 lockfile 判定，没有就用 npm）
  apps/chain/go.mod -> gofmt + go vet + go test（缓存落到 apps/chain/.cache/）
  go.mod       -> go test ./...
  Cargo.toml   -> cargo test
  pyproject.toml / pytest.ini / tox.ini -> pytest -q
  pom.xml      -> mvn -q test
  build.gradle -> ./gradlew test
  都没命中     -> 打印 SKIP 与提示，exit 0

每步一行「ok/FAIL  标签（exit N，耗时 Xs）」；失败步骤打印其输出尾部（最多 30 行）。
结尾一行汇总。命令在本机不存在时该步记 SKIP（不是 PASS）。
只有裸程序名才做「本机是否存在」预检；带赋值前缀或复合语法的命令一律直接执行，
以免把真实的失败误降级成 SKIP（那会让失败看起来像通过）。
退出码：0 = 没有任何步骤失败；1 = 至少一步失败。
EOF
}

NSTEP=0
LBL=(); CMD=()
add() { LBL[$NSTEP]="$1"; CMD[$NSTEP]="$2"; NSTEP=$((NSTEP + 1)); }

take_first() {  # 自动识别：按优先级取第一个命中
  if [ -f package.json ] && grep -q '"test"[[:space:]]*:' package.json; then
    if [ -f pnpm-lock.yaml ]; then add "pnpm test" "pnpm test"
    elif [ -f yarn.lock ]; then add "yarn test" "yarn test"
    else add "npm test" "npm test"; fi
  elif [ -f apps/chain/go.mod ]; then
    # 本仓：模块在 apps/chain，构建缓存必须落仓库内（沙箱与 CI 都不写家目录）。
    add "gofmt" 'cd apps/chain && export GOCACHE="$PWD/.cache/go-build" GOPATH="$PWD/.cache/go" && test -z "$(gofmt -l $(find . -name "*.go" -not -path "./.cache/*"))"'
    add "go vet" 'cd apps/chain && export GOCACHE="$PWD/.cache/go-build" GOPATH="$PWD/.cache/go" && go vet ./...'
    add "go test" 'cd apps/chain && export GOCACHE="$PWD/.cache/go-build" GOPATH="$PWD/.cache/go" && go test ./...'
  elif [ -f go.mod ]; then add "go test ./..." "go test ./..."
  elif [ -f Cargo.toml ]; then add "cargo test" "cargo test"
  elif [ -f pyproject.toml ] || [ -f pytest.ini ] || [ -f tox.ini ]; then add "pytest -q" "pytest -q"
  elif [ -f pom.xml ]; then add "mvn -q test" "mvn -q test"
  elif [ -f build.gradle ]; then add "./gradlew test" "./gradlew test"
  fi
}

first_word() {  # 命令的首个词（去掉前导空白）
  w="${1#"${1%%[![:space:]]*}"}"
  printf '%s' "${w%%[[:space:]]*}"
}

is_simple_prog() {  # 仅裸程序名可预检；空串/赋值前缀/复合语法视为“不确定”，交给 shell 执行
  case "$1" in "" | *[!A-Za-z0-9_./@+-]*) return 1 ;; esac
  return 0
}

DRY=0
while [ $# -gt 0 ]; do
  case "$1" in
    --help) usage; exit 0 ;;
    --dry-run) DRY=1; shift ;;
    --run)
      [ $# -ge 2 ] || { echo "错误: --run 需要跟一个命令字符串" >&2; usage >&2; exit 2; }
      add "run-$((NSTEP + 1))" "$2"; shift 2 ;;
    *) echo "错误: 未知参数: $1" >&2; usage >&2; exit 2 ;;
  esac
done
[ "$NSTEP" -gt 0 ] || take_first

if [ "$DRY" -eq 1 ]; then
  if [ "$NSTEP" -eq 0 ]; then
    echo "计划: 空（未识别到技术栈；可用 --run 指定要跑的命令）"
  else
    echo "计划（--dry-run：只打印，不执行）:"
    i=0; while [ "$i" -lt "$NSTEP" ]; do echo "  run  ${CMD[$i]}"; i=$((i + 1)); done
  fi
  exit 0
fi

PASS=0; FAIL=0; SKIP=0
if [ "$NSTEP" -eq 0 ]; then
  echo "SKIP  未识别到可执行的测试命令（看过 package.json 的 test 脚本 / apps/chain/go.mod / go.mod / Cargo.toml / pyproject.toml / pytest.ini / tox.ini / pom.xml / build.gradle）"
  echo "      提示：用 --run \"<命令>\" 显式指定。识别不到技术栈不是失败，但也不等于验证通过。"
  SKIP=1
fi

WORK="$(mktemp -d 2>/dev/null || echo "${TMPDIR:-/tmp}/verify-change.$$")"
mkdir -p "$WORK"
i=0
while [ "$i" -lt "$NSTEP" ]; do
  label="${LBL[$i]}"; cmd="${CMD[$i]}"; i=$((i + 1))
  prog="$(first_word "$cmd")"
  if is_simple_prog "$prog" && ! command -v "$prog" >/dev/null 2>&1; then
    printf 'SKIP  %s（本机没有 %s，跳过该步）\n' "$label" "$prog"
    SKIP=$((SKIP + 1)); continue
  fi
  out="$WORK/step-$i.log"
  t0="$(date +%s)"
  if ( eval "$cmd" ) >"$out" 2>&1; then rc=0; else rc=$?; fi
  secs=$(( $(date +%s) - t0 ))
  if [ "$rc" -eq 0 ]; then
    printf 'ok    %s（exit %s，耗时 %ss）\n' "$label" "$rc" "$secs"
    PASS=$((PASS + 1))
  else
    printf 'FAIL  %s（exit %s，耗时 %ss）\n' "$label" "$rc" "$secs"
    FAIL=$((FAIL + 1))
    echo "  --- $label 输出尾部（最多 30 行）---"
    if [ -s "$out" ]; then tail -n 30 "$out" | sed 's/^/  /'; else echo "  （本步没有输出）"; fi
    echo "  --- 尾部结束 ---"
  fi
done

echo "=== 汇总: PASS=$PASS FAIL=$FAIL SKIP=$SKIP ==="
[ "$FAIL" -eq 0 ] || exit 1
exit 0
