# P-24 在途巡检不再零等待空转

状态：active（已落地）

## 一、为什么做

用户报「api-go 会循环，两个核心跑满了」。pprof 实测（临时副本注入 §net/http/pprof§，5 秒采样）：

| 采样合计 | 161% | 与「两个核心跑满」一致 |
| --- | --- | --- |
| §runOutboxLoop§ | 3.86s / 46.8% | |
| §readOutbox§ | 3.85s / 46.7% | 其中 §os.Open§ 2.66s |
| §probeOutbox§ | 1.95s / 23.6% | |
| §nextOutboxCheck§ | 1.90s / 23.0% | |

goroutine 栈：§probeOutbox§ ← §runOutboxLoop§。也就是说：协程在毫无进展地反复读同一份台账。

## 二、根因

调度纯函数把「已过期」夹紧成「立刻」：

```go
due := entry.RequestedAt.Add(pollInterval(entry.Attempts))
if due.Before(now) { due = now }   // ← 等待 0 秒
```

于是：任何 §requestedAt§ 远在过去的未结在途 → 定时器 0 秒触发 → §probeOutbox§ 在没有 token 时只记账后立刻返回、没有任何事实被改变 → 下一轮又是 0 等待。**指数退避被算出来又被夹紧丢掉，从来没生效过**。每轮还要读两次台账（§nextOutboxCheck§ 一次、§probeOutbox§ 一次）。

## 三、决定

过期条目从「现在」重新计时一个**完整的退避间隔**，绝不返回零等待：

```go
interval := pollInterval(entry.Attempts)
due := entry.RequestedAt.Add(interval)
if !due.After(now) { due = now.Add(interval) }
```

理由：巡检是**对账**，不是催促。对账的频率下限应当恒等于退避间隔；一旦允许「过期就跑」，退避这条约束在最需要它的场景（早该检查却一直没检查）里恰好失效。

## 四、放弃了什么

- **不改成「按超时累加」**：看起来更精确，但会让等待时间依赖「这次巡检晚了多少」，同一份台账在不同时刻得出不同排期，纯函数就不再纯了。
- **不加「读台账前先比 mtime」的缓存**：机器仍然会每 0 等待醒来一次，只是醒来后少读一次盘。省的是开销，不是空转。
- **不在协程里写 §time.Sleep§ 兜底**：那是把调度决策从纯函数挪进协程，撤掉了「调度可单测」这个性质。

## 五、怎么验的

- 新用例 §apps/api-go/p16_test.go§ 的 §TestNextInspectionNeverSchedulesImmediately§：过期 24h、§attempts=5§ 的条目必须排在 §pollInterval(5)§ 之后；刚发起的条目也必须晚于现在。修前红（报「等待为 0 会让巡检协程空转」），修后绿。
- 修后同一压力场景复测：5 秒采样 §Total samples = 0§（完全空闲），§/api/outbox§ 的 §nextCheckAt§ 落在约 25 秒之后——真的在等，而不是假装在等。
- §gofmt -l *.go§ 无输出、整仓 §npm run check§ 通过。

## 六、仍然没有的（刻意）

- 巡检仍然是「定时醒来看看」，没有事件驱动唤醒。在途为空时不排期已经足够，再加唤醒通道就多一个需要一致性的状态源。
- 新发起的在途也要等一个退避间隔才被巡检到。这是本次修法的直接结果，**不是 bug**：投递本身在发起时就地做过，巡检只负责对账。
