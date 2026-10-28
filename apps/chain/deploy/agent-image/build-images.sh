#!/bin/sh
# build-images.sh —— 没有镜像时先跑这个。
# 三条 docker build，得到 ../nodes.yaml 里默认的那三个 tag。
#
# 项目名与版本都不写死：
#   APP_NAME=别的名字 sh build-images.sh     # 换镜像前缀（要和 nodes.yaml 的 image 对得上）
#   VERSION=0.1.0 sh build-images.sh         # 换 tag（默认 latest）
#
# APP_NAME 的默认值就是项目名：`chain assets` 展开时会把这个占位符换成真名。
# 直接在仓库里跑没展开的这份会报错停下——比烘出一个没人引用的 tag 好。
set -eu
cd "$(dirname "$0")"

# 项目名那一行里的 ${APP} 是展开占位符：chain assets 会把它换成真名。
# 仓库里没展开的这份跑起来时它不存在，所以这一行临时关掉 set -u——
# 否则用户看到的是 "APP: unbound variable" 这种 shell 内部错误，
# 而不是下面那句「没有项目名」的人话。
set +u
APP_NAME="${APP_NAME:-${APP}}"
set -u
VERSION="${VERSION:-latest}"
: "${APP_NAME:?没有项目名：先跑 chain assets 展开，或 APP_NAME=名字 sh build-images.sh}"

docker build -f Dockerfile.codex            -t "$APP_NAME/agent-codex:$VERSION" .
docker build -f Dockerfile.claude           -t "$APP_NAME/agent-claude:$VERSION" .
docker build -f Dockerfile.deepseek-harness -t "$APP_NAME/agent-deepseek-harness:$VERSION" .

echo "构建完成：$APP_NAME/agent-{codex,claude,deepseek-harness}:$VERSION"
echo "换 tag：VERSION=0.1.0 sh build-images.sh；换前缀：APP_NAME=别的名字 sh build-images.sh"
