# 推倒重来：为什么删掉门禁与审计，改由状态机做唯一判定

- 日期：2026-10-27
- 状态：implemented
- 关联：`.agents/notes/proposed/p32-node-chain-alignment.md`、`p32-design-minimal.md`

## 被删掉的东西

`.github/workflows/` 下六个 workflow（check / merge-gate / last-change / state-writer / audit / kb-sync）、`scripts/`（判据载体，最终搬进 `apps/engine`）、`apps/engine`（16 个子命令）、`apps/api-go`、`apps/web-vue`、`tests/`（含 235 条冻结 golden）。

## 为什么

旧的那套把「这次改动能不能合」交给一条 CI 判定链：workflow 取数 → 引擎判定 → 写 Check Run → required check 读取。为了让这条链不被改一行配置骗过，静态判据写了二十几轮（引号里的命令替换、跨行续写、小写 `--method patch`、`curl -sSd` 簇写、`tar -xf` 落盘、`with: script` 载荷……），最后不得不承认：**任何「扫文本猜行为」的判据都是开放集，每修一条就是给对手一张清单**。更糟的是它还会假红，把人训练成把红当噪声。

## 换的观测点

新的骨架里，结论只有一个写者（状态机），位置是推导出来的（第一个没通过的节点）。要「把结论说成绿的」，得去改状态机本身——而那会被 `go test` 直接抓住，不需要人去猜 YAML 会不会改写它。

## 现在的合并闸门

`main-guard` ruleset 保留 pull_request 规则与一条 required check：`check`（`.github/workflows/check.yml`，只跑 gofmt / go vet / go test）。原来那条 `merge-gate` 已从 required 里摘掉，因为它的实现随 `.github/workflows/merge-gate.yml` 一起删了：一个永远等不到的状态检查不是闸门，是让人习惯性点 admin merge 的装置。

## 代价（如实记）

1. 机器闸门从「审计 + 门 + 自证」缩到「编译 + 用例」：判不了「这次改动是否符合流程」，只判「代码是否自洽」。
2. 冻结 golden（235 条）随之删除，它们是旧判据的参照物，旧判据没了就没有意义。
