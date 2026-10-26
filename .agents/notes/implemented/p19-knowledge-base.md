# P-19 知识库本体：派生索引 + 两个只读 API

状态：implemented

## 一、这件事要解决什么

`docs/knowledge-base.md` 从 P-10 起就写清了「汇什么、什么格式、按 path+sha256 幂等」，但落地只有一半：
`scripts/kb-export.mjs` 产出**清单**（manifest），仓库里没有任何一处能回答「这条决策为什么这么定」「这个模块的契约是什么」。
也就是说 M3 的完成判据（同一合并触发两次汇入结果一致、且不产生重复）从来没有被真事件满足过——没有本体可汇。

P-19 补的就是本体：一份可查询的索引 + 两个只读接口，前端有一页能读。

## 二、为什么是「派生索引」而不是一个新的真相源

`git` 永远是真相源，知识库是只读副本，这是 `docs/knowledge-base.md` 第一节就定死的方向。
所以 `.agents/platform/kb.db` 与 `index.db` 同性质：**纯派生**，删掉必须自愈。三条重建触发写死在实现里：

1. 文件不存在；
2. 结构版本不符；
3. 任一条记录的 `sha256`/`bytes` 与现盘不符（改一个字就重建，而不是等下一次有人手动清库）。

代价是每次列表请求都复扫白名单、复算摘要（当前 30 条，可忽略）。换来的是「索引永远不会跟工作区不一致」——
这是它作为派生物唯一需要的正确性。

## 三、白名单为什么必须有两处实现，以及为什么必须有一个跨语言测试

汇入的路径集合是一个事实，但两处都要用它：

- `scripts/kb-export.mjs`（Node，按 commit 区间导出清单，喂给外部知识库）；
- `apps/api-go/kb.go`（Go，扫描工作区建索引，喂给平台页面）。

让 Go 去执行 Node、或让 Node 去调 API 都会把「能读文件」变成跨进程依赖，代价比收益大，所以保留两份实现，
但**不允许它们静默漂移**：`tests/kb-allowlist-parity.test.mjs` 直接从两份源码抽规则比集合相等，再跑一张 22 条路径的判定表。
改一处不改另一处必然红。这是 AGENTS.md 准则 3（一个事实只有一个家）在「代码不得不有两份」时的落地方式：
家还是文档，两份实现被一个可执行判据钉在一起。

## 四、接口契约（形状即契约）

```text
GET /api/kb        → {"items":[{path,title,sha256,bytes,group}...],"count":N,"builtAt":"<ISO8601>"}
GET /api/kb/item   → {"path","sha256","bytes","text"}；非法路径 400 E_KB_PATH，白名单内不存在 404 E_KB_PATH
```

排序由后端负责（group 固定 notes → module → docs → postmortem，组内按 path 字典序），前端不做任何重排：
排序规则若有两处，就会有两份不一致的排序。

## 五、边界与取舍

- **正文按纯文本显示**，不引 markdown 渲染库：渲染意味着 HTML 注入面，而知识库内容来自仓库文件，没有渲染需求。
- **越界判据只有一条**（`kbResolve`）：白名单 + 拒 `..` + 拒绝对路径 + 解析后必须仍在仓库根内。软链指到仓库外按「跑出了仓库根」拒绝。
- **sha256 用文件字节**，与导出器的 git blob 摘要不相等：两处只各自判「变没变」，从不互相比对；真要跨处对账需要先统一口径。
- **不汇 secrets/产物**：deny 目录与 deny 名字表与导出器同口径，先 deny 后 allow（否则 `node_modules/x/README.md` 会被「模块 README」放进来）。
- 单条 4MiB 上限，超限回 400 但仍留在列表里（列表与正文两条路径分开失败）。

## 六、证据

- 真服务：`GET /api/kb` → `count=30`、`builtAt` 随文件改动更新；`GET /api/kb/item?path=docs/architecture.md` 的 `sha256` 与 `shasum -a 256` 逐字符相同。
- 越界探针：`../../etc/passwd`、`%2e%2e%2f` 编码穿越、`x.md%00.png`、`DOCS/architecture.md`、`node_modules/../README.md` 全部 400；软链指到 `/etc/passwd` 不在列表、取正文回「解析后跑出了仓库根」。
- 漂移：改一个字 → `sha 5e2aa3f2 → e89d53d7`、`bytes 4893 → 4915`；还原后逐字符回到原值。
- 浏览器真机（ego 驱动真后端）：知识库页 `30` 条、四个分组头顺序与后端一致、选中 `docs/architecture.md` 后正文 3516 字符且**子元素数 0**（证明没被当 HTML 解析）、搜索 `architecture` 剩 1 条、搜 `zzz-没有这条` 显示空态文案。
- 闸门：`gofmt -l *.go` 空、`go vet`/`go test` 绿、`vue-tsc --noEmit` 0、`vite build` 0、`prettier --check apps/web-vue` 0、整仓 `npm run check` EXIT=0。

## 七、放弃的选项

- **把白名单抽成共享 JSON 让 Go 运行时读取**：多一个运行期文件依赖与一组「找不到文件怎么办」的分支，换来的只是省掉一个测试。
- **用 git blob 摘要做索引**：那要求索引跟 commit 绑定，工作区改一个字就得等提交才生效，与「删掉必须自愈」冲突。
- **前端引 markdown 渲染**：见第五节。

## 八、后续

- 知识库与 P-22 的看板搜索是两条独立路径（前者按 path 索引文档，后者筛条目），不共享索引。
- 若将来真要让外部知识库与平台索引对账，需要先统一摘要口径（git blob vs 工作区字节），这是一个显式的决策点，不是顺手能改的细节。