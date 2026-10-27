#!/bin/sh
# build-images.sh —— 没有镜像时先跑这个。
# 三条 docker build，得到 deploy/nodes.yaml 里默认的那三个 tag。
set -eu
cd "$(dirname "$0")"

TAG_SUFFIX="${1:-dev}"

docker build -f Dockerfile.codex             -t "ai-native/agent-codex:$TAG_SUFFIX" .
docker build -f Dockerfile.claude            -t "ai-native/agent-claude:$TAG_SUFFIX" .
docker build -f Dockerfile.deepseek-harness  -t "ai-native/agent-deepseek-harness:$TAG_SUFFIX" .

echo "构建完成：ai-native/agent-{codex,claude,deepseek-harness}:$TAG_SUFFIX"
echo "换 tag 就传一个参数：sh build-images.sh 0.1.0"
