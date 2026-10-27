# 接入层：给平台外面的人三件事

状态：implemented（2026-10-27）
相关模块：`apps/chain/intake.go`、`store_sqlite.go` 的 `migrate`、`model.go` 的 `Reporter` / `AddSystemComment`

## 为什么要它

需求里有三条是原来做不到的：**外面的人用「project key + 需求正文」提需求**、**首站被拒等于整条需求被拒并回告提需求人**、**能给出一份 project 清单**。原来的 HTTP 面只服务自己人（页面），没有任何「认身份」的东西。

## 决定了什么

1. **口令即身份**：`POST /api/intake/projects` 用服务级管理口令（`-admin-token`）认证，返回该 project 的访问口令 `pk_…`。之后所有接入调用只认这个口令，不认人。
   - 放弃：人员身份、OAuth、按人计权。一个 project 一个口令，谁拿到就是谁。
2. **默认关着**：不配 `-admin-token`，建 project 直接 503。接入层等于「有人明确决定把仓库挂上来」才开。
3. **口令比较是常数时间**（`subtle.ConstantTimeCompare`），且口令不出现在任何响应里（除了创建那一刻）与日志里。
4. **回告失败不改状态**。整条需求被拒时：先在内存里留一条**平台留言**（`AuthorType: "system"`，与人的评论分开，读的人要能分清哪句是人说的）与一条 `reject` 事件 → **落库** → 再尽力 POST 一次 `reporter.callbackURL`（5 秒超时）→ 结果记成 `notify` 事件。
   - 顺序是先落库再回告：回告失败不该让一条已经落定的驳回看起来没发生。
   - 放弃：重试队列、签名、给对方幂等键。送不到就是送不到，拉模式（`GET /api/intake/requirements/{id}`）是可信的那条路。
5. **回告内容只给结论**：需求 id、project、分支、state、被拒的是哪一站、原因。不给整份事件流。
6. **老库补列**：`CREATE TABLE IF NOT EXISTS` 不会改老表，所以 `migrate` 显式 `ALTER TABLE … ADD COLUMN` 并忽略 `duplicate column name`。补出来的 `intake_token` 是空串——老 project 的接入层默认也是关的。

## 判据

`apps/chain/intake_test.go` 7 例：接入层不开 503、管理口令缺失/错误/缺字段/重复 key、口令只看自己那个 project 且不回显口令、提需求与拉模式、整条需求被拒的回告（curl 收 body + 事件 + 平台留言）、回告送不到时状态不变且如实记失败、老库迁移。

变异（`/tmp` 副本，逐条确认改后行与构建成功）：
- 去掉 `deliverCallback` 调用 → 2 红（回告没发、失败事件没记）
- 去掉 `recordRejection` → 2 红（平台留言没了，含一条既有 flow 用例）
- `sameSecret` 改成「非空就算过」→ 3 红（错口令能建 project、能看别人的 project）
- `intakeView` 的 rejected 分支短路 → 1 红（拉模式拿不到原因）
- `migrate` 空转 → 1 红（`no such column: intake_token`）

## 踩到的坑

- 探针把 `go vet && go test` 串起来：`vet` 因不可达代码报错导致 `go test` 根本没跑，`FAILS=0` 看起来像「断言不承重」。规则照旧：**先看构建/vet 真通过，再看红几条**。
- 驳回要求节点处于 `running`/`awaiting_review`：测试里得先 `run` 一次再 `reject`，否则 409。
- 既有 flow 用例断言「最后一条评论是拒绝理由」，加了平台留言后不再成立：改成按作者类型分别断言（人的 reject 评论带原因 + 最后一条是 system）。不是放宽，是把两条事实分开钉。

## 已知边界

1. 口令不能轮换也不能吊销：要换只能改库或重建 project。
2. 回告只发一次、无重试、无签名；对方不能验真伪，只能靠拉模式对账。
3. 没有速率限制：接入层假设调用方是自己人。
4. 需求正文上限来自统一解码器（1MiB），图片只存路径字符串，不做上传。
