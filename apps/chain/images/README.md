# 节点镜像

这里放"真能跑"的节点镜像。平台只规定两件事：容器从环境变量读输入，在输出里打一行 `CHAIN_VERDICT:` 给结论。镜像里怎么干活是镜像自己的事。

## assess：需求评估（已经能真跑）

不接模型，只做机械判断——但它真读平台注入的东西、真看挂载的仓库、真给结论。

```bash
# 构建（本机 sandbox 下 docker 要写 ~/.docker，给个仓内配置目录）
export DOCKER_CONFIG=$PWD/.cache/docker-config
docker build -t ai-native/assess:latest apps/chain/images/assess
```

它做什么：

1. 打印平台注入的 `CHAIN_REQUIREMENT` / `CHAIN_NODE` / `CHAIN_BRANCH` / `BASE_URL` / `CHAIN_MODEL` / 需求正文 / 本站追加规则。
2. 数仓库里的文件、列出顶层目录、看有没有 `AGENTS.md`。
3. 从正文里挑出像标识符的词（`[A-Za-z0-9_-]` 长度 ≥ 4），去仓库里 `grep`，命中的算"可能的影响面"。
4. 给结论：正文去掉空白后不足 8 个字符 → `reject 原因`；否则 `pass`。

两条它自己承认的局限（写在输出里，不装作查过）：

- 中文正文挑不出可搜的锚点，影响面没有机械证据；
- 只按正文长度判"能不能评估"，不判"这个需求该不该做"——那是接模型之后的事。

## 怎么接进平台

平台按**节点类型**选模板（assess→`deepseek-harness`，dev/merge→空节点不跑容器），所以要让 assess 用这个镜像，用模板表把那个键覆盖掉：

```bash
go build -o /tmp/chaind ./apps/chain
/tmp/chaind -addr 127.0.0.1:8094 -db /tmp/demo/chain.db \
  -exec docker -templates apps/chain/images/templates.example.json \
  -base-url https://api.deepseek.com -model deepseek-chat
```

`templates.example.json` 的内容就是把 `deepseek-harness` 指到 `ai-native/assess:latest`。

## 写一个新镜像要知道的三件事

1. **镜像里不需要 ENTRYPOINT**：执行器每次都自己拼 `command`（模板表里必填），追加在镜像名后面；只写 ENTRYPOINT 会让那个 command 变成脚本的参数。用 `CMD` 给默认值。
2. **脚本要给读权限**：`COPY` 保留源文件权限，源文件是 `0600` 时 `chmod +x` 只得到 `0711`，解释器读不了脚本会报 `Permission denied`。用 `chmod 755`。
3. **容器会以非 root 跑**：这里的镜像是 `uid 10001`。挂载进来的仓库只读没问题，想写就别指望宿主的属主。

## 已知边界

- 只用 busybox 的工具：`grep` 没有 `--exclude-dir`（给了会整条报用法错误、一个文件都不搜），排除目录靠 `find`。
- 结论只从输出尾部 8KB 里读（平台`tailWriter` 的限制），先打结论再狂打日志会让结论被截掉 → 按"判不了"退回人工。
- 镜像没进任何 registry：`ai-native/assess:latest` 只在本机存在，别人 clone 下来要先自己 `docker build`。
