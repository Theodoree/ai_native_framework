package main

import (
	"bufio"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

const (
	outboxRel           = ".agents/platform/outbox.jsonl"
	defaultDeadline     = 10 * time.Minute
	outboxPollBase      = 5 * time.Second
	outboxPollMax       = 5 * time.Minute
	outboxUnknownTarget = ""
)

// 在途台账是**唯一无法从真源重建的本地事实**，所以落在自己的 append-only 文件，
// 既不进 ledger.jsonl（fold 会把非状态事件也当状态投影），也不只存在 index.db（那会
// 让「纯派生」自相矛盾）。

type OutboxTarget struct {
	Repo  string `json:"repo"`
	Issue int    `json:"issue"`
}

// OutboxRequest 是一条「发起」。Label 是本次要打上的目标 label（= labelPrefix + to），
// 对账时据此判断远端是否已生效。
type OutboxRequest struct {
	AttemptID   string       `json:"attemptId"`
	Item        string       `json:"item"`
	From        string       `json:"from"`
	To          string       `json:"to"`
	By          string       `json:"by"`
	Label       string       `json:"label"`
	Target      OutboxTarget `json:"target"`
	RequestedAt string       `json:"requestedAt"`
	Retry       int          `json:"retry,omitempty"`
}

type OutboxObserved struct {
	Labels []string `json:"labels"`
}

// OutboxResult 是一条「结果」。outcome 只有 applied / failed 两种；
// conflict 用 outcome=failed + reason=conflict 表达（不自动重试，交给人）。
type OutboxResult struct {
	AttemptID string         `json:"attemptId"`
	Outcome   string         `json:"outcome"`
	At        string         `json:"at"`
	Observed  OutboxObserved `json:"observed"`
	Reason    string         `json:"reason,omitempty"`
}

// outboxEntry 是按 attemptId 折叠出来的当前视图（后到覆盖先到）。
type outboxEntry struct {
	Request        OutboxRequest
	Attempts       int
	Outcome        string
	Reason         string
	ObservedAt     string
	ObservedLabels []string
}

const (
	statusPending  = "pending"
	statusApplied  = "applied"
	statusFailed   = "failed"
	statusStalled  = "stalled"
	statusConflict = "conflict"
)

func (a *app) outboxPath() string {
	if override := os.Getenv("PLATFORM_OUTBOX"); override != "" {
		return override
	}
	return filepath.Join(a.root, filepath.FromSlash(outboxRel))
}

// deadline 是「多久没生效就算 stalled」的上限，默认 10 分钟，PLATFORM_OUTBOX_DEADLINE 可覆盖。
func (a *app) deadline() time.Duration {
	raw := strings.TrimSpace(os.Getenv("PLATFORM_OUTBOX_DEADLINE"))
	if raw == "" {
		return defaultDeadline
	}
	parsed, err := time.ParseDuration(raw)
	if err != nil || parsed <= 0 {
		return defaultDeadline
	}
	return parsed
}

// attemptID 由 (item, from, to, requestedAt) 确定性生成：同一变更永远同一个 id，
// 重试复用而不是新增，所以重复发起不会长出一堆 pending。
func attemptID(item, from, to, requestedAt string) string {
	sum := sha256.Sum256([]byte(strings.Join([]string{item, from, to, requestedAt}, "|")))
	return "att-" + hex.EncodeToString(sum[:])[:16]
}

func (a *app) appendOutbox(record any) error {
	path := a.outboxPath()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return infraErr("E_OUTBOX_WRITE", "建不了在途台账目录: "+err.Error())
	}
	payload, err := json.Marshal(record)
	if err != nil {
		return infraErr("E_OUTBOX_WRITE", "在途记录无法序列化: "+err.Error())
	}
	file, err := os.OpenFile(path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
	if err != nil {
		return infraErr("E_OUTBOX_WRITE", "打不开在途台账: "+err.Error())
	}
	defer func() { _ = file.Close() }()
	if _, err := file.Write(append(payload, '\n')); err != nil {
		return infraErr("E_OUTBOX_WRITE", "写在途记录失败: "+err.Error())
	}
	return file.Sync()
}

type outboxLine struct {
	AttemptID   string          `json:"attemptId"`
	Item        string          `json:"item"`
	From        string          `json:"from"`
	To          string          `json:"to"`
	By          string          `json:"by"`
	Label       string          `json:"label"`
	Target      *OutboxTarget   `json:"target"`
	RequestedAt string          `json:"requestedAt"`
	Retry       int             `json:"retry"`
	Outcome     string          `json:"outcome"`
	At          string          `json:"at"`
	Observed    *OutboxObserved `json:"observed"`
	Reason      string          `json:"reason"`
}

// readOutbox 按 attemptId 折叠：先到的发起与后到的结果合成一个视图，顺序按首次出现。
func (a *app) readOutbox() ([]*outboxEntry, error) {
	file, err := os.Open(a.outboxPath())
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, infraErr("E_OUTBOX_UNREADABLE", "读不到在途台账: "+err.Error())
	}
	defer func() { _ = file.Close() }()

	entries := []*outboxEntry{}
	byID := map[string]*outboxEntry{}
	scanner := bufio.NewScanner(file)
	scanner.Buffer(make([]byte, 0, 64*1024), 1<<20)
	for scanner.Scan() {
		text := strings.TrimSpace(scanner.Text())
		if text == "" {
			continue
		}
		var line outboxLine
		if err := json.Unmarshal([]byte(text), &line); err != nil {
			return nil, infraErr("E_OUTBOX_CORRUPT", "在途台账有非 JSON 行，拒绝在坏台账上继续")
		}
		if line.AttemptID == "" {
			return nil, infraErr("E_OUTBOX_CORRUPT", "在途台账有缺少 attemptId 的行")
		}
		entry, ok := byID[line.AttemptID]
		if !ok {
			entry = &outboxEntry{}
			byID[line.AttemptID] = entry
			entries = append(entries, entry)
		}
		if line.RequestedAt != "" && line.Target != nil {
			entry.Request = OutboxRequest{
				AttemptID:   line.AttemptID,
				Item:        line.Item,
				From:        line.From,
				To:          line.To,
				By:          line.By,
				Label:       line.Label,
				Target:      *line.Target,
				RequestedAt: line.RequestedAt,
				Retry:       line.Retry,
			}
			entry.Attempts++
			continue
		}
		if line.Outcome != "" {
			entry.Outcome = line.Outcome
			entry.Reason = line.Reason
			entry.ObservedAt = line.At
			entry.ObservedLabels = []string{}
			if line.Observed != nil {
				entry.ObservedLabels = line.Observed.Labels
			}
		}
	}
	if err := scanner.Err(); err != nil {
		return nil, infraErr("E_OUTBOX_UNREADABLE", "读在途台账失败: "+err.Error())
	}
	return entries, nil
}

// status: applied/failed 是写下来的结论；stalled 是**算出来的**——超时未生效绝不冒充成功。
func (entry *outboxEntry) status(now time.Time, deadline time.Duration) string {
	switch entry.Outcome {
	case "applied":
		return statusApplied
	case "failed":
		if entry.Reason == "conflict" {
			return statusConflict
		}
		return statusFailed
	}
	requestedAt, err := time.Parse(time.RFC3339, entry.Request.RequestedAt)
	if err == nil && now.Sub(requestedAt) > deadline {
		return statusStalled
	}
	return statusPending
}

func (entry *outboxEntry) retryable(now time.Time, deadline time.Duration) bool {
	status := entry.status(now, deadline)
	return status == statusStalled || status == statusFailed
}

func (entry *outboxEntry) unsettled(now time.Time, deadline time.Duration) bool {
	status := entry.status(now, deadline)
	return status == statusPending || status == statusStalled
}

// outboxTarget 把 item 映射到远端 issue：约定 item id 的数字后缀就是 issue number
// （REQ-12 ↔ #12）。没有数字后缀或没有仓库坐标时不记在途 —— 没有目标就没有投递。
func (a *app) outboxTarget(item string) (OutboxTarget, bool) {
	number := issueNumberFor(item)
	if number <= 0 {
		return OutboxTarget{}, false
	}
	repo, err := a.repo()
	if err != nil || repo == "" {
		return OutboxTarget{}, false
	}
	return OutboxTarget{Repo: repo, Issue: number}, true
}

func issueNumberFor(item string) int {
	index := strings.LastIndexFunc(item, func(r rune) bool { return r < '0' || r > '9' })
	if index == len(item)-1 {
		return 0
	}
	number, err := strconv.Atoi(item[index+1:])
	if err != nil || number <= 0 {
		return 0
	}
	return number
}

// initiateOutbox 记一条在途并尝试投递；同一 (item, from, to) 已有记录时复用它的 attemptId。
func (a *app) initiateOutbox(ctx context.Context, item, from, to, by, label string) (*outboxEntry, error) {
	if from == "" || to == "" {
		return nil, nil
	}
	target, ok := a.outboxTarget(item)
	if !ok {
		return nil, nil
	}
	entries, err := a.readOutbox()
	if err != nil {
		return nil, err
	}
	for _, entry := range entries {
		if entry.Request.Item == item && entry.Request.From == from && entry.Request.To == to {
			return entry, nil
		}
	}
	request := OutboxRequest{
		AttemptID:   attemptID(item, from, to, a.nowISO()),
		Item:        item,
		From:        from,
		To:          to,
		By:          by,
		Label:       label,
		Target:      target,
		RequestedAt: a.nowISO(),
	}
	if err := a.appendOutbox(request); err != nil {
		return nil, err
	}
	entry := &outboxEntry{Request: request, Attempts: 1}
	a.wakeOutboxLoop()
	a.deliver(ctx, entry)
	return entry, nil
}

// deliver 是唯一会发写请求的地方：默认关闭（PLATFORM_WRITE != 1），关闭时只记 pending。
// 成功也不在这里判 applied —— applied 只由「同步后观察到 label」得出。
func (a *app) deliver(ctx context.Context, entry *outboxEntry) {
	if !a.writeEnabled {
		return
	}
	if a.token() == "" {
		_ = a.appendOutbox(OutboxResult{
			AttemptID: entry.Request.AttemptID,
			Outcome:   "failed",
			At:        a.nowISO(),
			Observed:  OutboxObserved{Labels: []string{}},
			Reason:    "no_token",
		})
		return
	}
	if a.deliverer == nil {
		return
	}
	if err := a.deliverer.AddLabel(ctx, entry.Request.Target, entry.Request.Label); err != nil {
		_ = a.appendOutbox(OutboxResult{
			AttemptID: entry.Request.AttemptID,
			Outcome:   "failed",
			At:        a.nowISO(),
			Observed:  OutboxObserved{Labels: []string{}},
			Reason:    "deliver_failed: " + err.Error(),
		})
	}
}

type reconcileReport struct {
	Applied  int `json:"applied"`
	Conflict int `json:"conflict"`
	Pending  int `json:"pending"`
}

// reconcile 在每次同步后跑：拿每条未结在途的 target 与远端当前 labels 比。
func (a *app) reconcile(ctx context.Context, snapshot *RemoteSnapshot) (reconcileReport, error) {
	report := reconcileReport{}
	entries, err := a.readOutbox()
	if err != nil {
		return report, err
	}
	now := a.now()
	byNumber := map[int]RemoteIssue{}
	for _, issue := range snapshot.Issues {
		byNumber[issue.Number] = issue
	}
	for _, entry := range entries {
		if !entry.unsettled(now, a.deadline()) {
			continue
		}
		issue, ok := byNumber[entry.Request.Target.Issue]
		if !ok {
			report.Pending++
			continue
		}
		if containsString(issue.Labels, entry.Request.Label) {
			if err := a.appendOutbox(OutboxResult{
				AttemptID: entry.Request.AttemptID,
				Outcome:   "applied",
				At:        a.nowISO(),
				Observed:  OutboxObserved{Labels: issue.Labels},
			}); err != nil {
				return report, err
			}
			report.Applied++
			continue
		}
		prefix := strings.TrimSuffix(entry.Request.Label, entry.Request.To)
		current, ambiguous := stateOf(issue.Labels, prefix)
		// 远端确实变成了别的值（且不是本次的起点）→ conflict：别自动重试，交给人。
		if ambiguous || (current != nil && *current != entry.Request.To && *current != entry.Request.From) {
			if err := a.appendOutbox(OutboxResult{
				AttemptID: entry.Request.AttemptID,
				Outcome:   "failed",
				At:        a.nowISO(),
				Observed:  OutboxObserved{Labels: issue.Labels},
				Reason:    "conflict",
			}); err != nil {
				return report, err
			}
			report.Conflict++
			continue
		}
		report.Pending++
	}
	if report.Applied > 0 || report.Conflict > 0 {
		a.wakeOutboxLoop()
	}
	return report, nil
}

// retryOutbox 只对 stalled/failed 生效，复用同一个 attemptId：不新增第二条 pending。
func (a *app) retryOutbox(ctx context.Context, attemptIDValue string) ([]string, error) {
	entries, err := a.readOutbox()
	if err != nil {
		return nil, err
	}
	now := a.now()
	retried := []string{}
	for _, entry := range entries {
		if attemptIDValue != "" && entry.Request.AttemptID != attemptIDValue {
			continue
		}
		if !entry.retryable(now, a.deadline()) {
			continue
		}
		request := entry.Request
		request.RequestedAt = a.nowISO()
		request.Retry = entry.Request.Retry + 1
		if err := a.appendOutbox(request); err != nil {
			return retried, err
		}
		a.resetProbe(request.AttemptID)
		retried = append(retried, request.AttemptID)
		a.deliver(ctx, &outboxEntry{Request: request, Attempts: 1})
	}
	if len(retried) > 0 {
		a.wakeOutboxLoop()
	}
	return retried, nil
}

// pendingEntry 是巡检决策的输入：只带纯数据，函数本身不碰时钟、不碰网络。
type pendingEntry struct {
	AttemptID   string
	RequestedAt time.Time
	Attempts    int
}

// pollInterval: 指数退避，起 5s，上限 5min。attempts=1 → 5s，2 → 10s，……
func pollInterval(attempts int) time.Duration {
	interval := outboxPollBase
	for i := 1; i < attempts; i++ {
		if interval >= outboxPollMax {
			break
		}
		interval *= 2
	}
	if interval > outboxPollMax {
		return outboxPollMax
	}
	return interval
}

// NextInspection 是纯决策函数：给定 pending 集合与当前时间，给出下次巡检时间。
// **在途为空时返回 nil —— 零请求**，绝不为了「保持轮询」而空转。
func NextInspection(pending []pendingEntry, now time.Time) *time.Time {
	if len(pending) == 0 {
		return nil
	}
	var next *time.Time
	for _, entry := range pending {
		due := entry.RequestedAt.Add(pollInterval(entry.Attempts))
		if due.Before(now) {
			due = now
		}
		if next == nil || due.Before(*next) {
			copied := due
			next = &copied
		}
	}
	return next
}

// inspectionInput 把折叠结果与内存里的巡检次数合成纯函数输入（次数不落盘，重启即归零）。
func (a *app) inspectionInput(entries []*outboxEntry) []pendingEntry {
	now := a.now()
	pending := []pendingEntry{}
	for _, entry := range entries {
		if !entry.unsettled(now, a.deadline()) {
			continue
		}
		requestedAt, err := time.Parse(time.RFC3339, entry.Request.RequestedAt)
		if err != nil {
			requestedAt = now
		}
		pending = append(pending, pendingEntry{
			AttemptID:   entry.Request.AttemptID,
			RequestedAt: requestedAt,
			Attempts:    entry.Attempts + a.probeCount(entry.Request.AttemptID),
		})
	}
	return pending
}

func (a *app) nextOutboxCheck() *time.Time {
	entries, err := a.readOutbox()
	if err != nil {
		return nil
	}
	return NextInspection(a.inspectionInput(entries), a.now())
}

func (a *app) probeCount(attemptIDValue string) int {
	a.probeMu.Lock()
	defer a.probeMu.Unlock()
	return a.probes[attemptIDValue]
}

func (a *app) bumpProbe(attemptIDValue string) {
	a.probeMu.Lock()
	defer a.probeMu.Unlock()
	a.probes[attemptIDValue]++
}

func (a *app) resetProbe(attemptIDValue string) {
	a.probeMu.Lock()
	defer a.probeMu.Unlock()
	delete(a.probes, attemptIDValue)
}

func (a *app) wakeOutboxLoop() {
	select {
	case a.wake <- struct{}{}:
	default:
	}
}

// probeOutbox 是一次巡检：在途为空时直接返回（零请求）；非空才退避后取一次远端并对账。
func (a *app) probeOutbox(ctx context.Context) {
	entries, err := a.readOutbox()
	if err != nil || len(entries) == 0 {
		return
	}
	now := a.now()
	pending := []pendingEntry{}
	for _, entry := range entries {
		if !entry.unsettled(now, a.deadline()) {
			continue
		}
		a.bumpProbe(entry.Request.AttemptID)
		pending = append(pending, pendingEntry{AttemptID: entry.Request.AttemptID})
	}
	if len(pending) == 0 || a.token() == "" {
		return
	}
	_, _ = a.runSync(ctx)
}

// runOutboxLoop 只在「在途非空」时才排期：没有睡眠常量，也没有固定间隔轮询。
func (a *app) runOutboxLoop(ctx context.Context) {
	for {
		next := a.nextOutboxCheck()
		if next == nil {
			select {
			case <-ctx.Done():
				return
			case <-a.wake:
				continue
			}
		}
		wait := next.Sub(a.now())
		if wait < 0 {
			wait = 0
		}
		timer := time.NewTimer(wait)
		select {
		case <-ctx.Done():
			timer.Stop()
			return
		case <-a.wake:
			timer.Stop()
			continue
		case <-timer.C:
			a.probeOutbox(ctx)
		}
	}
}

func containsString(values []string, want string) bool {
	for _, value := range values {
		if value == want {
			return true
		}
	}
	return false
}
