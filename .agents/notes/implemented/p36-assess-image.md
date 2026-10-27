# 第一个真节点镜像：assess 容器自己评估、自己给结论

状态：implemented（2026-10-27）
相关模块：`apps/chain/images/assess/`（Dockerfile + assess.sh）、`apps/chain/images/templates.example.json`

## 为什么要它

在此之前，assess 节点只有两种跑法：`-exec fake`（打印一段"假执行"）和 `-exec docker` + 占位镜像名 `ai-native/deepseek-harness:latest`（拉不到，落一条"容器没跑起来"）。也就是说，容器自审的整条链路（注入 → 执行 → 读 `CHAIN_VERDICT` → 定案）只在假执行器和假 docker 脚本上验过，没有一次是真容器。

这个镜像的用处不是"聪明"，是**让真容器跑一次真判断**：平台注入的东西能不能被容器读到、容器的结论能不能被平台读回来、驳回能不能一路走到整条需求被拒。

## 决定了什么

1. **不接模型，只做机械判断**：正文长度、仓库规模、正文关键词在仓库里的命中。
   - 放弃：现在就让容器调模型。没有 key 的镜像在别人机器上只会失败，那样连"链路通不通"都验不了。
   - 放弃：让平台写死评估规则。平台只认 `CHAIN_VERDICT` 一行，规则住在镜像里——换镜像就是换规则，不用改平台。
2. **判不了就说判不了**：中文正文挑不出英文锚点时，输出明写"影响面没有机械证据"，不假装查过；正文不足 8 字直接 `reject`。
3. **结论在最后一行**：平台取最后一条，所以脚本先打全过程、最后打结论。代价是结论必须落在尾部 8KB 内（平台日志只留尾部）。
4. **镜像只依赖 busybox**：不装 gcc、不装 python、不装 jq。少一个包就少一个拉取失败的理由，也让"别人 clone 下来能构建"这件事成立。
5. **镜像名留在本地**：`ai-native/assess:latest` 不推 registry；文档里写清"要先自己 build"。

## 判据在哪

这个镜像**不进 `go test`**：它需要 docker daemon，而 CI/沙箱里不一定有。它靠的是"真跑一次、把输出贴出来"：

- `docker run` 三种输入下的实测输出：正常中文正文（pass）、太短正文（reject + 原因）、带英文锚点的正文（命中真实文件）。
- 平台侧端到端：`-exec docker -templates ...` 跑出 `attempts[0].verdict=pass` → 节点 `accepted`；另一条 `reject` → 整条需求 `rejected`、`verdictReason` 就是容器那句话。

## 踩到的三个坑（都是容器本身的行为，不是平台的）

| 现象 | 根因 | 修法 |
| --- | --- | --- |
| `/bin/sh: can't open '/usr/local/bin/assess': Permission denied` | `COPY` 保留源文件权限（`0600`），`chmod +x` 给到 `0711`，解释器读不到脚本 | `RUN chmod 755` |
| 加了 `ENTRYPOINT` 后模板里的 command 变成脚本参数 | 执行器总是自己拼 command 并追加在镜像名之后 | 镜像只写 `CMD`，command 由模板表给 |
| `grep -ril --exclude-dir=... ` 什么都没搜到 | busybox 的 grep 没有 `--exclude-dir`，给了会打印用法并退出 | 排除目录交给 `find`，`-exec grep -il {} +` |

另有一条不是坑但值得记：构建镜像时 docker 要写 `~/.docker`，本机 sandbox 会拒；`DOCKER_CONFIG=$PWD/.cache/docker-config` 可以绕开。

## 已知边界

1. 这不是"智能评估"：它数文件、搜关键词、数字符。真正的需求评估要接模型（需要 `CHAIN_MODEL_KEY`），那是下一步。
2. 关键词是英文标识符；中文需求的锚点提取没做。
3. 镜像不推 registry，别人拿到仓库要先 build 一次。
