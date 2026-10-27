# P-40 节点容器：模板走 yaml、代码默认 clone、入口不许替 agent 下结论

日期：2026-10-28　　状态：implemented

## 一、为什么把镜像与命令挪出代码

镜像名、启动命令、超时是**运维事实**：换一次 registry 或抬一次超时不该改 Go 源码、更不该重编译平台。所以模板表放 `deploy/nodes.yaml`（`version: 1` + `templates` + `nodes`），启动时用 `-templates` 指，改完重启即可。

读表的判据全部 fail-closed 并点名字段：版本不认识、缺 `image`、缺 `command`、超时解析不了、`nodes` 引用了不存在的模板名、节点类型不认识——逐条报错而不是猜一个默认值。只有「文件不存在」才回落内嵌表并打一行日志，因为「路径写错」和「故意的默认」必须分得开。

放弃了什么：不写 YAML 解析器（引 `gopkg.in/yaml.v3`）；老 JSON 扁平格式继续认，因为冻结的 golden 里有它。

## 二、代码默认 clone，挂载只作开发捷径

节点容器要的是「这次需求那条分支的最新代码」，不是宿主机上的工作目录。所以默认 `CHAIN_WORKSPACE_MODE=clone`，容器里 `git clone --depth 1 --branch <branch> <repo> /work`；只有 `project.repo` 是本机绝对路径且目录存在时才 bind mount，并在评论里明写「开发捷径」。

**已知边界**：私有仓库 clone 需要凭证，本期不往容器里注入 token——私有 repo 上跑容器节点会 clone 失败，入口脚本打 reject 并退 73。这条不是疏漏，是不想在没有凭据轮换机制时把长期 token 塞进环境变量。

## 三、入口脚本不许替 agent 下结论（这一条是验收时抓出来的）

第一版 `entrypoint.sh` 在「agent 退出码 0 但没打 `CHAIN_VERDICT:`」时自己补一句「按通过处理」并打 `CHAIN_VERDICT: pass`。看着像贴心兜底，实际是把**人工兜底那条路堵死**：平台侧 `parseVerdict` 认不出标记会落 `unknown`，`ApplyReview` 再把本站交回人工审核；脚本抢在前面宣布通过，等于「没人给结论」被伪装成「通过」。

改成：没标记就一行结论都不打，exit 0，只留一句「agent 没有给出结论：本站交回人工审核」。agent 自己给了标记、或非 0 退出这两条不变（非 0 且无标记 → reject 带退出码，这是对的）。

教训：**替别人下结论的缺省值，看起来总比「不知道」更友好**。凡是「拿不到就按通过」，都要问一句：这个通过，是谁给的？

## 四、四条行为进了 Go 判据

入口脚本原来只有「手跑一次」的证据。现在 `apps/chain/entrypoint_test.go` 用真 `sh` 跑脚本、用真 `git` 建裸库：clone 成功、分支不存在（exit 73 且带 reject）、**agent 沉默时零结论行**、mount 缺 `.git`（exit 73 且带 reject）。

变异验证：把 `verdict pass` 加回去 → 只有「沉默」那条红；去掉版本校验 → 只有对应的模板用例红；放行未知模板名 → 同样只红对应那条。

## 五、代价与边界

- 三个 agent 镜像的 Dockerfile 与入口脚本在 `deploy/agent-image/`，**本机没有 docker 登录态与 agent CLI 凭据，真镜像端到端未跑**；clone / prompt / 结论语义用裸库实跑钉住，`DockerExecutor` 侧用 docker 替身钉住。要真验：在有 docker 的机器上跑 `deploy/agent-image/build-images.sh`。
- 模板按**节点类型**选，不由请求指定；`/run` 的 body 多写一个 `template` 字段会被 400 拒。
- 日志只留尾部 8KB，密钥在落库前抹两次（命令行与容器 stdout 各一次）。