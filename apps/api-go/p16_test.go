package main

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"io/fs"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"
	"testing/fstest"
	"time"
)

// fakeFetcher 记账每次调用的请求头，测试据此断言「条件请求确实发出去了」。
type fakeFetcher struct {
	mu    sync.Mutex
	calls []FetchRequest
	reply *FetchResult
	err   error
}

func (f *fakeFetcher) Fetch(_ context.Context, request FetchRequest) (*FetchResult, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls = append(f.calls, request)
	if f.err != nil {
		return nil, f.err
	}
	return f.reply, nil
}

func (f *fakeFetcher) last() (FetchRequest, bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.calls) == 0 {
		return FetchRequest{}, false
	}
	return f.calls[len(f.calls)-1], true
}

type fakeDeliverer struct {
	mu    sync.Mutex
	calls []string
	err   error
}

func (d *fakeDeliverer) AddLabel(_ context.Context, target OutboxTarget, label string) error {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.calls = append(d.calls, target.Repo+"#"+itoa(target.Issue)+" "+label)
	return d.err
}

func itoa(value int) string {
	if value == 0 {
		return "0"
	}
	digits := ""
	for value > 0 {
		digits = string(rune('0'+value%10)) + digits
		value /= 10
	}
	return digits
}

// p16Root 在现有沙箱上补两件事：仓库坐标（默认解析不出 git remote）与只读 token。
func p16Root(t *testing.T) string {
	t.Helper()
	root := newRoot(t)
	t.Setenv("PLATFORM_REPO", "ted/example")
	t.Setenv("GH_TOKEN", "test-token")
	t.Setenv("PLATFORM_WRITE", "")
	return root
}

func cacheFile(root string) string {
	return filepath.Join(root, ".agents", "platform", "cache", "remote.json")
}

func outboxFile(root string) string {
	return filepath.Join(root, ".agents", "platform", "outbox.jsonl")
}

func indexFile(root string) string {
	return filepath.Join(root, ".agents", "platform", "index.db")
}

type boardItem struct {
	ID          string         `json:"id"`
	State       *string        `json:"state"`
	LedgerState *string        `json:"ledgerState"`
	Current     *string        `json:"current"`
	Divergence  bool           `json:"divergence"`
	Pending     map[string]any `json:"pending"`
}

func readBoard(t *testing.T, subject *app) []boardItem {
	t.Helper()
	recorder := call(t, subject, http.MethodGet, "/api/board", "")
	expectStatus(t, recorder, http.StatusOK)
	var payload struct {
		Items []boardItem `json:"items"`
	}
	decode(t, recorder, &payload)
	return payload.Items
}

type outboxPayload struct {
	Entries []struct {
		AttemptID   string `json:"attemptId"`
		Item        string `json:"item"`
		From        string `json:"from"`
		To          string `json:"to"`
		Label       string `json:"label"`
		Status      string `json:"status"`
		Attempts    int    `json:"attempts"`
		RequestedAt string `json:"requestedAt"`
	} `json:"entries"`
	NextCheckAt  *string `json:"nextCheckAt"`
	WriteEnabled bool    `json:"writeEnabled"`
}

func readOutboxPayload(t *testing.T, subject *app) outboxPayload {
	t.Helper()
	recorder := call(t, subject, http.MethodGet, "/api/outbox", "")
	expectStatus(t, recorder, http.StatusOK)
	var payload outboxPayload
	decode(t, recorder, &payload)
	return payload
}

// 304：请求带 If-None-Match，结果一个字节都不写盘。
func TestSyncNotModifiedWritesNothing(t *testing.T) {
	root := p16Root(t)
	subject := newApp(root)
	seed := &RemoteSnapshot{
		ETag:      `"etag-1"`,
		FetchedAt: "2024-01-01T00:00:00.000Z",
		Repo:      "ted/example",
		Issues:    []RemoteIssue{{Number: 1, Title: "旧快照", Labels: []string{"state:accepted"}}},
	}
	if err := subject.writeCache(seed); err != nil {
		t.Fatalf("写种子缓存失败: %v", err)
	}
	beforeBytes, err := os.ReadFile(cacheFile(root))
	if err != nil {
		t.Fatalf("读种子缓存失败: %v", err)
	}
	beforeStat, err := os.Stat(cacheFile(root))
	if err != nil {
		t.Fatalf("stat 种子缓存失败: %v", err)
	}

	fetcher := &fakeFetcher{reply: &FetchResult{NotModified: true}}
	subject.fetcher = fetcher
	recorder := call(t, subject, http.MethodPost, "/api/sync", "")
	expectStatus(t, recorder, http.StatusOK)
	var report syncReport
	decode(t, recorder, &report)
	if report.Status != "notModified" {
		t.Fatalf("status = %q，想要 notModified", report.Status)
	}
	if report.Issues != 1 || report.FetchedAt != seed.FetchedAt {
		t.Fatalf("304 应回报旧缓存事实: %+v", report)
	}

	sent, ok := fetcher.last()
	if !ok {
		t.Fatal("fetcher 没被调用")
	}
	// 「没变」的唯一判据是 ETag；since 已随字段一起删掉（见 TestFetchRequestHasNoSinceField）。
	if sent.ETag != seed.ETag {
		t.Fatalf("条件请求没带上 ETag: %+v", sent)
	}

	afterBytes, err := os.ReadFile(cacheFile(root))
	if err != nil {
		t.Fatalf("读缓存失败: %v", err)
	}
	afterStat, err := os.Stat(cacheFile(root))
	if err != nil {
		t.Fatalf("stat 缓存失败: %v", err)
	}
	if string(afterBytes) != string(beforeBytes) {
		t.Fatalf("304 改写了缓存内容: %s", afterBytes)
	}
	if !afterStat.ModTime().Equal(beforeStat.ModTime()) {
		t.Fatalf("304 重写了缓存文件（mtime 变了）: %v -> %v", beforeStat.ModTime(), afterStat.ModTime())
	}
}

func TestSyncWithoutTokenReportsInfra(t *testing.T) {
	root := p16Root(t)
	t.Setenv("GH_TOKEN", "")
	t.Setenv("GITHUB_TOKEN", "")
	subject := newApp(root)
	fetcher := &fakeFetcher{err: errors.New("没有 token 时不该联网")}
	subject.fetcher = fetcher

	recorder := call(t, subject, http.MethodPost, "/api/sync", "")
	expectStatus(t, recorder, http.StatusInternalServerError)
	var problem struct {
		Kind string
		Code string
	}
	decode(t, recorder, &problem)
	if problem.Kind != "infra" || problem.Code != "E_NO_TOKEN" {
		t.Fatalf("错误形状不对: %+v", problem)
	}
	if _, called := fetcher.last(); called {
		t.Fatal("没有 token 还在联网")
	}
}

func TestSyncInfraErrorKeepsOldCache(t *testing.T) {
	root := p16Root(t)
	subject := newApp(root)
	seed := &RemoteSnapshot{ETag: `"etag-1"`, FetchedAt: "2024-01-01T00:00:00.000Z", Repo: "ted/example",
		Issues: []RemoteIssue{{Number: 1, Labels: []string{"state:accepted"}}}}
	if err := subject.writeCache(seed); err != nil {
		t.Fatalf("写种子缓存失败: %v", err)
	}
	before, err := os.ReadFile(cacheFile(root))
	if err != nil {
		t.Fatalf("读种子缓存失败: %v", err)
	}
	subject.fetcher = &fakeFetcher{err: &apiError{Kind: "infra", Code: "E_REMOTE_RATE_LIMIT",
		Message: "被限流", Extra: map[string]any{}}}

	recorder := call(t, subject, http.MethodPost, "/api/sync", "")
	expectStatus(t, recorder, http.StatusInternalServerError)
	var problem struct {
		Code string
	}
	decode(t, recorder, &problem)
	if problem.Code != "E_REMOTE_RATE_LIMIT" {
		t.Fatalf("code = %q，想要 E_REMOTE_RATE_LIMIT", problem.Code)
	}
	after, err := os.ReadFile(cacheFile(root))
	if err != nil {
		t.Fatalf("读缓存失败: %v", err)
	}
	if string(after) != string(before) {
		t.Fatalf("infra 错误清空/改写了旧缓存: %s", after)
	}
}

// 删掉 db 后重建结果必须等于折叠结果。
func TestIndexRebuildMatchesFold(t *testing.T) {
	root := p16Root(t)
	subject := newApp(root)
	expectStatus(t, call(t, subject, http.MethodPost, "/api/item", "{\"title\":\"真需求\",\"body\":\"细节\"}"), http.StatusOK)
	expectStatus(t, call(t, subject, http.MethodPost, "/api/verdict",
		"{\"id\":\"REQ-1\",\"to\":\"rejected\",\"actor_role\":\"owner\",\"comment\":\"不做\"}"), http.StatusOK)

	first := call(t, subject, http.MethodGet, "/api/board", "")
	expectStatus(t, first, http.StatusOK)
	if _, err := os.Stat(indexFile(root)); err != nil {
		t.Fatalf("board 之后应有索引 db: %v", err)
	}

	if err := os.Remove(indexFile(root)); err != nil {
		t.Fatalf("删 db 失败: %v", err)
	}
	second := call(t, subject, http.MethodGet, "/api/board", "")
	expectStatus(t, second, http.StatusOK)
	if first.Body.String() != second.Body.String() {
		t.Fatalf("删 db 后重建结果不一致:\n首次 %s\n重建 %s", first.Body.String(), second.Body.String())
	}
	if _, err := os.Stat(indexFile(root)); err != nil {
		t.Fatalf("删 db 后没有自愈: %v", err)
	}

	rebuild := call(t, subject, http.MethodPost, "/api/index/rebuild", "")
	expectStatus(t, rebuild, http.StatusOK)
	var result struct {
		OK           bool   `json:"ok"`
		Schema       string `json:"schemaVersion"`
		Items        int    `json:"items"`
		Events       int    `json:"events"`
		RemoteIssues int    `json:"remoteIssues"`
		Outbox       int    `json:"outbox"`
	}
	decode(t, rebuild, &result)
	if !result.OK || result.Items != 1 || result.Events != 2 || result.Schema != schemaVersion {
		t.Fatalf("重建计数不对: %s", rebuild.Body.String())
	}
}

// label 态与账本态不一致 → divergence=true，且两边都显式给出。
func TestBoardFlagsDivergence(t *testing.T) {
	root := p16Root(t)
	subject := newApp(root)
	expectStatus(t, call(t, subject, http.MethodPost, "/api/item", "{\"title\":\"真需求\"}"), http.StatusOK)
	if err := subject.writeCache(&RemoteSnapshot{
		ETag: `"etag-1"`, FetchedAt: "2024-01-01T00:00:00.000Z", Repo: "ted/example",
		Issues: []RemoteIssue{{Number: 1, Title: "真需求", Labels: []string{"state:review"}}},
	}); err != nil {
		t.Fatalf("写缓存失败: %v", err)
	}

	items := readBoard(t, subject)
	if len(items) != 1 {
		t.Fatalf("items = %d", len(items))
	}
	item := items[0]
	if item.Current == nil || *item.Current != "review" {
		t.Fatalf("current = %v，想要 review", item.Current)
	}
	if item.LedgerState == nil || *item.LedgerState != "accepted" {
		t.Fatalf("ledgerState = %v，想要 accepted", item.LedgerState)
	}
	if !item.Divergence {
		t.Fatalf("label 与账本不一致却没标 divergence: %+v", item)
	}

	// 一致时不标：同一份缓存换成账本态。
	if err := subject.writeCache(&RemoteSnapshot{
		ETag: `"etag-2"`, FetchedAt: "2024-01-01T00:00:01.000Z", Repo: "ted/example",
		Issues: []RemoteIssue{{Number: 1, Labels: []string{"state:accepted"}}},
	}); err != nil {
		t.Fatalf("写缓存失败: %v", err)
	}
	if items := readBoard(t, subject); items[0].Divergence {
		t.Fatalf("一致却标了 divergence: %+v", items[0])
	}
}

// 发起后 pending 可见；写入默认关闭 → 不联网。
func TestOutboxPendingVisibleAfterVerdict(t *testing.T) {
	root := p16Root(t)
	subject := newApp(root)
	deliverer := &fakeDeliverer{}
	subject.deliverer = deliverer
	expectStatus(t, call(t, subject, http.MethodPost, "/api/item", "{\"title\":\"真需求\"}"), http.StatusOK)
	expectStatus(t, call(t, subject, http.MethodPost, "/api/verdict",
		"{\"id\":\"REQ-1\",\"to\":\"rejected\",\"actor_role\":\"owner\",\"comment\":\"不做\"}"), http.StatusOK)

	payload := readOutboxPayload(t, subject)
	if len(payload.Entries) != 1 {
		t.Fatalf("entries = %d，想要 1（%+v）", len(payload.Entries), payload.Entries)
	}
	entry := payload.Entries[0]
	if entry.Status != statusPending || entry.From != "accepted" || entry.To != "rejected" || entry.Label != "state:rejected" {
		t.Fatalf("在途记录不对: %+v", entry)
	}
	if entry.AttemptID == "" {
		t.Fatal("缺 attemptId")
	}
	if payload.NextCheckAt == nil {
		t.Fatal("有在途却没排巡检时间")
	}
	if len(deliverer.calls) != 0 {
		t.Fatalf("写投递默认关闭却联网了: %v", deliverer.calls)
	}
	if items := readBoard(t, subject); items[0].Pending == nil || items[0].Pending["status"] != statusPending {
		t.Fatalf("board 没带 pending: %+v", items[0])
	}

	// 在途只落在自己的文件里，绝不进账本。
	if lines := ledgerLines(t, root); len(lines) != 2 {
		t.Fatalf("账本行数 = %d，想要 2（在途不许进账本）", len(lines))
	}
}

// 重试复用同一 attemptId：不新增 pending，只多一行发起。
func TestOutboxRetryReusesAttemptID(t *testing.T) {
	root := p16Root(t)
	subject := newApp(root)
	expectStatus(t, call(t, subject, http.MethodPost, "/api/item", "{\"title\":\"真需求\"}"), http.StatusOK)
	expectStatus(t, call(t, subject, http.MethodPost, "/api/verdict",
		"{\"id\":\"REQ-1\",\"to\":\"rejected\",\"actor_role\":\"owner\",\"comment\":\"不做\"}"), http.StatusOK)
	first := readOutboxPayload(t, subject)
	attempt := first.Entries[0].AttemptID

	later := time.Now().Add(11 * time.Minute)
	subject.now = func() time.Time { return later }
	stalled := readOutboxPayload(t, subject)
	if stalled.Entries[0].Status != statusStalled {
		t.Fatalf("超时后 status = %q，想要 stalled（不是 success）", stalled.Entries[0].Status)
	}

	recorder := call(t, subject, http.MethodPost, "/api/outbox/retry", "{\"attemptId\":\""+attempt+"\"}")
	expectStatus(t, recorder, http.StatusOK)
	var retried struct {
		Retried []string `json:"retried"`
	}
	decode(t, recorder, &retried)
	if len(retried.Retried) != 1 || retried.Retried[0] != attempt {
		t.Fatalf("retried = %v，想要 [%s]", retried.Retried, attempt)
	}

	after := readOutboxPayload(t, subject)
	if len(after.Entries) != 1 {
		t.Fatalf("重试新增了在途记录: %d 条", len(after.Entries))
	}
	if after.Entries[0].AttemptID != attempt {
		t.Fatalf("attemptId 变了: %s -> %s", attempt, after.Entries[0].AttemptID)
	}
	if after.Entries[0].Status != statusPending {
		t.Fatalf("重试后 status = %q，想要 pending", after.Entries[0].Status)
	}
	body, err := os.ReadFile(outboxFile(root))
	if err != nil {
		t.Fatalf("读在途台账失败: %v", err)
	}
	if lines := len(splitLines(string(body))); lines != 2 {
		t.Fatalf("在途台账行数 = %d，想要 2（发起 + 重试发起）", lines)
	}
}

func splitLines(text string) []string {
	out := []string{}
	current := ""
	for _, char := range text {
		if char == '\n' {
			if current != "" {
				out = append(out, current)
			}
			current = ""
			continue
		}
		current += string(char)
	}
	if current != "" {
		out = append(out, current)
	}
	return out
}

// 同步后远端已是目标 label → applied。
func TestOutboxReconcileApplied(t *testing.T) {
	root := p16Root(t)
	subject := newApp(root)
	expectStatus(t, call(t, subject, http.MethodPost, "/api/item", "{\"title\":\"真需求\"}"), http.StatusOK)
	expectStatus(t, call(t, subject, http.MethodPost, "/api/verdict",
		"{\"id\":\"REQ-1\",\"to\":\"rejected\",\"actor_role\":\"owner\",\"comment\":\"不做\"}"), http.StatusOK)

	subject.fetcher = &fakeFetcher{reply: &FetchResult{ETag: `"etag-2"`, Issues: []RemoteIssue{
		{Number: 1, Title: "真需求", Labels: []string{"state:rejected"}},
	}}}
	recorder := call(t, subject, http.MethodPost, "/api/sync", "")
	expectStatus(t, recorder, http.StatusOK)
	var report syncReport
	decode(t, recorder, &report)
	if report.Status != "changed" || report.Reconciled.Applied != 1 {
		t.Fatalf("同步/对账结果不对: %s", recorder.Body.String())
	}

	payload := readOutboxPayload(t, subject)
	if payload.Entries[0].Status != statusApplied {
		t.Fatalf("status = %q，想要 applied", payload.Entries[0].Status)
	}
	if payload.NextCheckAt != nil {
		t.Fatalf("在途已结案却还排巡检: %v", *payload.NextCheckAt)
	}
	if items := readBoard(t, subject); items[0].Pending != nil {
		t.Fatalf("已结案还带 pending: %+v", items[0].Pending)
	}
}

// 远端被改成别的 label → conflict（不自动重试，交给人）。
func TestOutboxReconcileConflict(t *testing.T) {
	root := p16Root(t)
	subject := newApp(root)
	expectStatus(t, call(t, subject, http.MethodPost, "/api/item", "{\"title\":\"真需求\"}"), http.StatusOK)
	expectStatus(t, call(t, subject, http.MethodPost, "/api/verdict",
		"{\"id\":\"REQ-1\",\"to\":\"rejected\",\"actor_role\":\"owner\",\"comment\":\"不做\"}"), http.StatusOK)

	subject.fetcher = &fakeFetcher{reply: &FetchResult{ETag: `"etag-2"`, Issues: []RemoteIssue{
		{Number: 1, Title: "真需求", Labels: []string{"state:done"}},
	}}}
	recorder := call(t, subject, http.MethodPost, "/api/sync", "")
	expectStatus(t, recorder, http.StatusOK)
	var report syncReport
	decode(t, recorder, &report)
	if report.Reconciled.Conflict != 1 {
		t.Fatalf("conflict 计数 = %d，想要 1", report.Reconciled.Conflict)
	}
	payload := readOutboxPayload(t, subject)
	if payload.Entries[0].Status != statusConflict {
		t.Fatalf("status = %q，想要 conflict", payload.Entries[0].Status)
	}
}

// 超时未生效 → stalled，且不是 applied/成功。
func TestOutboxStalledWhenDeadlinePasses(t *testing.T) {
	root := p16Root(t)
	subject := newApp(root)
	expectStatus(t, call(t, subject, http.MethodPost, "/api/item", "{\"title\":\"真需求\"}"), http.StatusOK)
	expectStatus(t, call(t, subject, http.MethodPost, "/api/verdict",
		"{\"id\":\"REQ-1\",\"to\":\"rejected\",\"actor_role\":\"owner\",\"comment\":\"不做\"}"), http.StatusOK)

	if payload := readOutboxPayload(t, subject); payload.Entries[0].Status != statusPending {
		t.Fatalf("刚发起 status = %q，想要 pending", payload.Entries[0].Status)
	}
	subject.now = func() time.Time { return time.Now().Add(11 * time.Minute) }
	payload := readOutboxPayload(t, subject)
	if payload.Entries[0].Status != statusStalled {
		t.Fatalf("超过时限 status = %q，想要 stalled", payload.Entries[0].Status)
	}
	// stalled 仍算未结案：巡检继续排。
	if payload.NextCheckAt == nil {
		t.Fatal("stalled 却没排巡检")
	}
}

// 在途为空 → 下一次巡检时间为 nil（零请求）；有在途时退避有界。
func TestNextInspectionIsNilWhenEmpty(t *testing.T) {
	now := time.Date(2024, 1, 1, 0, 0, 0, 0, time.UTC)
	if next := NextInspection(nil, now); next != nil {
		t.Fatalf("空在途却排了巡检: %v", *next)
	}
	if next := NextInspection([]pendingEntry{}, now); next != nil {
		t.Fatalf("空切片却排了巡检: %v", *next)
	}

	pending := []pendingEntry{{AttemptID: "att-1", RequestedAt: now, Attempts: 0}}
	next := NextInspection(pending, now)
	if next == nil {
		t.Fatal("有在途却没排巡检")
	}
	if !next.After(now) && !next.Equal(now) {
		t.Fatalf("巡检时间早于现在: %v", *next)
	}
	if next.Sub(now) > outboxPollMax {
		t.Fatalf("退避超过上限: %v", *next)
	}
	// 指数退避：尝试越多越晚，但封顶 outboxPollMax。
	if pollInterval(0) != outboxPollBase {
		t.Fatalf("首次间隔 = %v，想要 %v", pollInterval(0), outboxPollBase)
	}
	if pollInterval(2) <= pollInterval(1) {
		t.Fatalf("退避没有增长: %v vs %v", pollInterval(2), pollInterval(1))
	}
	if pollInterval(100) != outboxPollMax {
		t.Fatalf("退避没封顶: %v", pollInterval(100))
	}
}

// 排期不许「零等待」：上一次巡检没改变任何事实时，下一次必须至少等一个退避间隔。
// 归零会让 runOutboxLoop 以 wait=0 空转（实测 161% CPU，46% 花在读在途台账）。
func TestNextInspectionNeverSchedulesImmediately(t *testing.T) {
	now := time.Date(2024, 1, 1, 0, 0, 0, 0, time.UTC)

	// 早该巡检的在途：RequestedAt 远在过去，attempts 已涨到 5。
	overdue := []pendingEntry{{AttemptID: "att-old", RequestedAt: now.Add(-24 * time.Hour), Attempts: 5}}
	next := NextInspection(overdue, now)
	if next == nil {
		t.Fatal("有在途却没排巡检")
	}
	if !next.After(now) {
		t.Fatalf("排期 %v 不晚于现在 %v —— 等待为 0 会让巡检协程空转", *next, now)
	}
	if want := pollInterval(5); next.Sub(now) < want {
		t.Fatalf("过期在途的等待 = %v，短于退避间隔 %v", next.Sub(now), want)
	}

	// 刚发起的在途同样按退避间隔排，不就地触发。
	fresh := []pendingEntry{{AttemptID: "att-new", RequestedAt: now, Attempts: 0}}
	if scheduled := NextInspection(fresh, now); scheduled == nil || !scheduled.After(now) {
		t.Fatalf("新在途的排期 = %v，必须晚于现在", scheduled)
	}
}

// 磁盘没有 dist 时照样出页面：内嵌 FS 就是页面来源。
func TestEmbeddedDistServesWithoutDiskDist(t *testing.T) {
	if _, err := fs.ReadFile(distFS, "README.md"); err != nil {
		t.Fatalf("内嵌 dist 缺少占位说明（go:embed all:dist 应包含它）: %v", err)
	}
	root := p16Root(t)
	if _, err := os.Stat(filepath.Join(root, "apps", "web-vue", "dist")); !os.IsNotExist(err) {
		t.Fatalf("沙箱里不该有磁盘 dist: %v", err)
	}
	subject := newApp(root)
	subject.dist = fstest.MapFS{
		"index.html":    &fstest.MapFile{Data: []byte("<html>内嵌页面</html>")},
		"assets/app.js": &fstest.MapFile{Data: []byte("console.log(2)")},
	}
	page := call(t, subject, http.MethodGet, "/", "")
	if page.Code != http.StatusOK || page.Body.String() != "<html>内嵌页面</html>" {
		t.Fatalf("没有磁盘 dist 却没出页面: %d %q", page.Code, page.Body.String())
	}
	if got := page.Header().Get("content-type"); got != "text/html; charset=utf-8" {
		t.Fatalf("content-type = %q", got)
	}
	spa := call(t, subject, http.MethodGet, "/board/REQ-1", "")
	if spa.Code != http.StatusOK || spa.Body.String() != "<html>内嵌页面</html>" {
		t.Fatalf("SPA 回退失效: %d %q", spa.Code, spa.Body.String())
	}
	asset := call(t, subject, http.MethodGet, "/assets/app.js", "")
	if asset.Code != http.StatusOK || asset.Header().Get("content-type") != "text/javascript; charset=utf-8" {
		t.Fatalf("静态资源不对: %d %q", asset.Code, asset.Header().Get("content-type"))
	}
	// 真内嵌 FS 若已构建（CI 的 check:web 会先复制），必须能出 HTML。
	if _, err := fs.Stat(distFS, "index.html"); err == nil {
		real := newApp(root)
		built := call(t, real, http.MethodGet, "/", "")
		if built.Code != http.StatusOK || !containsSubstring(built.Body.String(), "<html") {
			t.Fatalf("内嵌 index.html 没生效: %d", built.Code)
		}
	}
}

func containsSubstring(text, needle string) bool {
	for index := 0; index+len(needle) <= len(text); index++ {
		if text[index:index+len(needle)] == needle {
			return true
		}
	}
	return false
}

// 缓存快照端点：没同步过是 present=false，不是空仓库。
func TestRemoteReportsPresence(t *testing.T) {
	root := p16Root(t)
	subject := newApp(root)
	empty := call(t, subject, http.MethodGet, "/api/remote", "")
	expectStatus(t, empty, http.StatusOK)
	var absence struct {
		Present bool `json:"present"`
	}
	decode(t, empty, &absence)
	if absence.Present {
		t.Fatalf("没同步过却报 present: %s", empty.Body.String())
	}

	subject.fetcher = &fakeFetcher{reply: &FetchResult{ETag: `"etag-1"`, Issues: []RemoteIssue{{Number: 3, Title: "x"}}}}
	expectStatus(t, call(t, subject, http.MethodPost, "/api/sync", ""), http.StatusOK)
	present := call(t, subject, http.MethodGet, "/api/remote", "")
	expectStatus(t, present, http.StatusOK)
	var snapshot struct {
		Present bool   `json:"present"`
		ETag    string `json:"etag"`
		Repo    string `json:"repo"`
		Issues  []struct {
			Number int `json:"number"`
		} `json:"issues"`
	}
	decode(t, present, &snapshot)
	if !snapshot.Present || snapshot.ETag != `"etag-1"` || snapshot.Repo != "ted/example" || len(snapshot.Issues) != 1 {
		t.Fatalf("快照不对: %s", present.Body.String())
	}
}

var _ = json.Marshal

// ---- 真 HTTP 层：httptest 顶替 GitHub，条件请求/分页/状态码/写投递都能在本地验证 ----

func newTestFetcher(server *httptest.Server) *httpFetcher {
	return &httpFetcher{client: server.Client(), baseURL: server.URL}
}

func newTestDeliverer(server *httptest.Server, token string) *httpDeliverer {
	return &httpDeliverer{client: server.Client(), token: func() string { return token }, baseURL: server.URL}
}

// 条件请求的唯一判据是 ETag：URL 里不允许出现 since（ETag 随 URL 变，304 就永不命中）。
func TestSyncSendsETagWithoutSince(t *testing.T) {
	root := p16Root(t)
	subject := newApp(root)
	seed := &RemoteSnapshot{ETag: `"etag-seed"`, FetchedAt: "2024-01-01T00:00:00.000Z", Repo: "ted/example",
		Issues: []RemoteIssue{{Number: 1, Labels: []string{"state:accepted"}}}}
	if err := subject.writeCache(seed); err != nil {
		t.Fatalf("写种子缓存失败: %v", err)
	}

	received := make(chan *http.Request, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		received <- r.Clone(context.Background())
		w.Header().Set("etag", `"etag-new"`)
		_, _ = w.Write([]byte(`[{"number":7,"title":"新快照","state":"open","labels":[{"name":"state:review"}],"updated_at":"2024-01-02T00:00:00Z"}]`))
	}))
	defer server.Close()
	subject.fetcher = newTestFetcher(server)

	recorder := call(t, subject, http.MethodPost, "/api/sync", "")
	expectStatus(t, recorder, http.StatusOK)

	var sent *http.Request
	select {
	case sent = <-received:
	default:
		t.Fatal("假远端没收到请求")
	}
	if strings.Contains(strings.ToLower(sent.URL.RawQuery), "since") {
		t.Fatalf("请求 URL 还带 since: %s", sent.URL.String())
	}
	if got := sent.Header.Get("if-none-match"); got != seed.ETag {
		t.Fatalf("if-none-match = %q，想要 %q", got, seed.ETag)
	}
	cache, err := subject.readCache()
	if err != nil {
		t.Fatalf("读缓存失败: %v", err)
	}
	// 缓存语义是整份快照：新结果整份替换，不是叠加，更不是半份。
	if cache.ETag != `"etag-new"` || len(cache.Issues) != 1 || cache.Issues[0].Number != 7 {
		t.Fatalf("缓存没被整份替换: %+v", cache)
	}
}

// FetchRequest 不许再长出 since：加回增量参数就是把局部结果当快照，对账随后把未结在途全判 pending。
func TestFetchRequestHasNoSinceField(t *testing.T) {
	if _, ok := reflect.TypeOf(FetchRequest{}).FieldByName("Since"); ok {
		t.Fatal("FetchRequest 又有 Since 字段了：缓存语义必须是整份快照")
	}
}

// 304 → NotModified 且缓存文件一个字节都不动（真发请求，不靠假 fetcher）。
func TestHTTPFetcherNotModifiedKeepsCacheBytes(t *testing.T) {
	root := p16Root(t)
	subject := newApp(root)
	seed := &RemoteSnapshot{ETag: `"etag-seed"`, FetchedAt: "2024-01-01T00:00:00.000Z", Repo: "ted/example",
		Issues: []RemoteIssue{{Number: 1, Labels: []string{"state:accepted"}}}}
	if err := subject.writeCache(seed); err != nil {
		t.Fatalf("写种子缓存失败: %v", err)
	}
	beforeBytes, err := os.ReadFile(cacheFile(root))
	if err != nil {
		t.Fatalf("读种子缓存失败: %v", err)
	}
	beforeStat, err := os.Stat(cacheFile(root))
	if err != nil {
		t.Fatalf("stat 种子缓存失败: %v", err)
	}

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if got := r.Header.Get("if-none-match"); got != `"etag-seed"` {
			t.Errorf("条件请求没带缓存 ETag: %q", got)
		}
		w.WriteHeader(http.StatusNotModified)
	}))
	defer server.Close()
	subject.fetcher = newTestFetcher(server)

	recorder := call(t, subject, http.MethodPost, "/api/sync", "")
	expectStatus(t, recorder, http.StatusOK)
	var report syncReport
	decode(t, recorder, &report)
	if report.Status != "notModified" || report.Issues != 1 {
		t.Fatalf("304 应回报旧缓存事实: %+v", report)
	}

	afterBytes, err := os.ReadFile(cacheFile(root))
	if err != nil {
		t.Fatalf("读缓存失败: %v", err)
	}
	afterStat, err := os.Stat(cacheFile(root))
	if err != nil {
		t.Fatalf("stat 缓存失败: %v", err)
	}
	if string(afterBytes) != string(beforeBytes) {
		t.Fatalf("304 改写了缓存内容: %s", afterBytes)
	}
	if !afterStat.ModTime().Equal(beforeStat.ModTime()) {
		t.Fatalf("304 重写了缓存文件（mtime 变了）: %v -> %v", beforeStat.ModTime(), afterStat.ModTime())
	}
}

// 第一页带 Link: rel="next" → 跟到第二页，合并成完整列表，快照 ETag 取第一页。
func TestHTTPFetcherFollowsNextLink(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Query().Get("page") {
		case "":
			next := "http://" + r.Host + r.URL.Path + "?state=all&per_page=100&page=2"
			w.Header().Set("etag", `"etag-page1"`)
			// last 在前、next 在后：解析必须按 rel 找，不能按位置取。
			w.Header().Set("link", "<"+next+"&page=9>; rel=\"last\", <"+next+">; rel=\"next\"")
			_, _ = w.Write([]byte(`[{"number":1,"title":"第一页","labels":[{"name":"state:accepted"}]}]`))
		case "2":
			w.Header().Set("etag", `"etag-page2"`)
			_, _ = w.Write([]byte(`[{"number":2,"title":"第二页","labels":[{"name":"state:review"}]}]`))
		default:
			t.Errorf("意外的 page 参数: %q", r.URL.Query().Get("page"))
			w.WriteHeader(http.StatusBadRequest)
		}
	}))
	defer server.Close()

	result, err := newTestFetcher(server).Fetch(context.Background(), FetchRequest{Repo: "ted/example", Token: "test-token"})
	if err != nil {
		t.Fatalf("分页取数失败: %v", err)
	}
	if len(result.Issues) != 2 {
		t.Fatalf("拿到 %d 条（分页没跟完，超过 100 条就会被静默截断）: %+v", len(result.Issues), result.Issues)
	}
	if result.Issues[0].Number != 1 || result.Issues[1].Number != 2 {
		t.Fatalf("合并顺序不对: %+v", result.Issues)
	}
	if result.ETag != `"etag-page1"` {
		t.Fatalf("快照 ETag = %q，想要第一页的 ETag", result.ETag)
	}
}

// 分页没有尽头时报 E_REMOTE_PAGING：宁可失败，也不静默截断成半份快照。
func TestHTTPFetcherPagingCapReportsError(t *testing.T) {
	hits := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits++
		next := "http://" + r.Host + r.URL.Path + "?page=" + itoa(hits+1)
		w.Header().Set("link", "<"+next+">; rel=\"next\"")
		_, _ = w.Write([]byte("[]"))
	}))
	defer server.Close()

	_, err := newTestFetcher(server).Fetch(context.Background(), FetchRequest{Repo: "ted/example"})
	if err == nil {
		t.Fatal("分页成环却没报错")
	}
	var typed *apiError
	if !errors.As(err, &typed) || typed.Code != "E_REMOTE_PAGING" {
		t.Fatalf("错误码不对: %v", err)
	}
	if hits > remotePageCap+1 {
		t.Fatalf("请求次数 = %d，超过上限 %d", hits, remotePageCap+1)
	}
}

// 分页地址由远端给出：只跟本端点下的地址，别的主机一次都不该被访问（否则等于把 token 送出去）。
func TestHTTPFetcherRejectsForeignPagingHost(t *testing.T) {
	evilHits := 0
	evil := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		evilHits++
		_, _ = w.Write([]byte(`[{"number":2,"title":"不该出现","state":"open","labels":[],"updated_at":"2024-01-02T00:00:00Z"}]`))
	}))
	defer evil.Close()

	hits := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits++
		w.Header().Set("link", "<"+evil.URL+"/repos/o/r/issues?page=2>; rel=\"next\"")
		_, _ = w.Write([]byte(`[{"number":1,"title":"甲","state":"open","labels":[],"updated_at":"2024-01-02T00:00:00Z"}]`))
	}))
	defer server.Close()

	_, err := newTestFetcher(server).Fetch(context.Background(), FetchRequest{Repo: "ted/example"})
	if err == nil {
		t.Fatal("分页指向别的主机却没报错")
	}
	var typed *apiError
	if !errors.As(err, &typed) || typed.Code != "E_REMOTE_PAGING" {
		t.Fatalf("错误码不对: %v", err)
	}
	if hits != 1 {
		t.Fatalf("本端点请求次数 = %d，想要 1 次（第一页拿到跨主机 Link 就该停）", hits)
	}
	if evilHits != 0 {
		t.Fatalf("evil 主机被访问了 %d 次，token 有外送风险", evilHits)
	}
}

// 401/403/429 各自映射：都不能被当成「远端没数据」。
func TestHTTPFetcherStatusMapping(t *testing.T) {
	cases := []struct {
		status int
		code   string
	}{
		{http.StatusUnauthorized, "E_REMOTE_UNAUTHORIZED"},
		{http.StatusForbidden, "E_REMOTE_RATE_LIMIT"},
		{http.StatusTooManyRequests, "E_REMOTE_RATE_LIMIT"},
	}
	for _, item := range cases {
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(item.status)
		}))
		_, err := newTestFetcher(server).Fetch(context.Background(), FetchRequest{Repo: "ted/example"})
		server.Close()
		var typed *apiError
		if !errors.As(err, &typed) || typed.Code != item.code {
			t.Fatalf("%d 的映射不对: %v", item.status, err)
		}
	}
}

// issues 端点会混着 PR：它的状态是 open/closed，不是 state:* label，必须剔除。
func TestHTTPFetcherDropsPullRequests(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`[
			{"number":1,"title":"真 issue","state":"open","labels":[{"name":"state:accepted"}],"updated_at":"2024-01-01T00:00:00Z"},
			{"number":2,"title":"其实是个 PR","state":"open","labels":[],"pull_request":{"url":"https://example.test/pr/2"}}
		]`))
	}))
	defer server.Close()

	result, err := newTestFetcher(server).Fetch(context.Background(), FetchRequest{Repo: "ted/example"})
	if err != nil {
		t.Fatalf("取数失败: %v", err)
	}
	if len(result.Issues) != 1 || result.Issues[0].Number != 1 {
		t.Fatalf("PR 条目没被剔除: %+v", result.Issues)
	}
}

// 写投递的请求形状与结果判定：2xx 才算成功，4xx 是失败。
func TestHTTPDelivererAddLabel(t *testing.T) {
	type seenRequest struct {
		method        string
		path          string
		authorization string
		contentType   string
		body          string
	}
	received := make(chan seenRequest, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		received <- seenRequest{
			method:        r.Method,
			path:          r.URL.Path,
			authorization: r.Header.Get("authorization"),
			contentType:   r.Header.Get("content-type"),
			body:          string(body),
		}
		w.WriteHeader(http.StatusCreated)
		_, _ = w.Write([]byte(`{"labels":[{"name":"state:rejected"}]}`))
	}))
	defer server.Close()

	deliverer := newTestDeliverer(server, "test-token")
	if err := deliverer.AddLabel(context.Background(), OutboxTarget{Repo: "ted/example", Issue: 5}, "state:rejected"); err != nil {
		t.Fatalf("2xx 却报错: %v", err)
	}
	sent := <-received
	if sent.method != http.MethodPost || sent.path != "/repos/ted/example/issues/5/labels" {
		t.Fatalf("请求不对: %+v", sent)
	}
	if sent.authorization != "Bearer test-token" {
		t.Fatalf("authorization = %q", sent.authorization)
	}
	if sent.contentType != "application/json" {
		t.Fatalf("content-type = %q", sent.contentType)
	}
	var payload struct {
		Labels []string `json:"labels"`
	}
	if err := json.Unmarshal([]byte(sent.body), &payload); err != nil {
		t.Fatalf("请求体不是合法 JSON: %v (%q)", err, sent.body)
	}
	if len(payload.Labels) != 1 || payload.Labels[0] != "state:rejected" {
		t.Fatalf("请求体不对: %q", sent.body)
	}

	rejecting := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnprocessableEntity)
		_, _ = w.Write([]byte(`{"message":"Validation Failed"}`))
	}))
	defer rejecting.Close()
	err := newTestDeliverer(rejecting, "test-token").AddLabel(context.Background(), OutboxTarget{Repo: "ted/example", Issue: 5}, "state:rejected")
	if err == nil {
		t.Fatal("4xx 却当成成功")
	}
	if !strings.Contains(err.Error(), "422") {
		t.Fatalf("错误里没带状态码: %v", err)
	}
}
