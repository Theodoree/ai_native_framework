package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"testing/fstest"
)

func repoRoot(t *testing.T) string {
	t.Helper()
	workingDir, err := os.Getwd()
	if err != nil {
		t.Fatalf("取不到工作目录: %v", err)
	}
	return filepath.Dir(filepath.Dir(workingDir))
}

func copyFile(t *testing.T, from, to string) {
	t.Helper()
	payload, err := os.ReadFile(from)
	if err != nil {
		t.Fatalf("读不到 %s: %v", from, err)
	}
	if err := os.WriteFile(to, payload, 0o644); err != nil {
		t.Fatalf("写不了 %s: %v", to, err)
	}
}

// newRoot 造一个「像仓库根」的沙箱：只拷一份声明。判定与折叠都在进程内完成，
// 所以沙箱里不需要 scripts/ 也不需要 node_modules —— 少一份脚手架就少一处假象。
// 账本不建 —— 每个用例从空账本开始，也就不必碰真账本。
func newRoot(t *testing.T) string {
	t.Helper()
	root := t.TempDir()
	repo := repoRoot(t)
	platformDir := filepath.Join(root, ".agents", "platform")
	if err := os.MkdirAll(platformDir, 0o755); err != nil {
		t.Fatalf("建配置目录失败: %v", err)
	}
	copyFile(t,
		filepath.Join(repo, ".agents", "platform", "state-machine.yml"),
		filepath.Join(platformDir, "state-machine.yml"),
	)
	// 账本路径由环境变量透传到 Node 入口：不钉住的话，从平台进程内部跑测试（验证面板就是这么跑的）
	// 会继承外层的 PLATFORM_LEDGER，用例读到的就不是自己的空账本。
	t.Setenv("PLATFORM_LEDGER", ledgerPath(root))
	return root
}

func call(t *testing.T, subject *app, method, target, body string) *httptest.ResponseRecorder {
	t.Helper()
	request := httptest.NewRequest(method, target, strings.NewReader(body))
	recorder := httptest.NewRecorder()
	subject.ServeHTTP(recorder, request)
	return recorder
}

func decode(t *testing.T, recorder *httptest.ResponseRecorder, into any) {
	t.Helper()
	if err := json.Unmarshal(recorder.Body.Bytes(), into); err != nil {
		t.Fatalf("响应不是 JSON: %v（原文 %s）", err, recorder.Body.String())
	}
}

func expectStatus(t *testing.T, recorder *httptest.ResponseRecorder, want int) {
	t.Helper()
	if recorder.Code != want {
		t.Fatalf("状态码 = %d，想要 %d（体 %s）", recorder.Code, want, recorder.Body.String())
	}
	if got := recorder.Header().Get("content-type"); got != "application/json; charset=utf-8" {
		t.Fatalf("content-type = %q", got)
	}
}

func ledgerPath(root string) string {
	return filepath.Join(root, ".agents", "platform", "ledger.jsonl")
}

func ledgerLines(t *testing.T, root string) []string {
	t.Helper()
	payload, err := os.ReadFile(ledgerPath(root))
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		t.Fatalf("读账本失败: %v", err)
	}
	var lines []string
	for _, line := range strings.Split(string(payload), "\n") {
		if strings.TrimSpace(line) != "" {
			lines = append(lines, line)
		}
	}
	return lines
}

func TestBoardShape(t *testing.T) {
	subject := newApp(newRoot(t))
	recorder := call(t, subject, http.MethodGet, "/api/board", "")
	expectStatus(t, recorder, http.StatusOK)

	var board struct {
		Items  []map[string]any
		Config struct {
			DefaultFlow *string
			LabelPrefix string
			States      []struct {
				Name     string
				Terminal bool
				Meaning  string
			}
			Transitions []map[string]any
		}
	}
	decode(t, recorder, &board)
	if board.Items == nil {
		t.Fatal("items 必须是数组，收到 null")
	}
	if board.Config.LabelPrefix != "state:" {
		t.Fatalf("labelPrefix = %q", board.Config.LabelPrefix)
	}
	if board.Config.DefaultFlow == nil || *board.Config.DefaultFlow != "auto" {
		t.Fatalf("defaultFlow = %v", board.Config.DefaultFlow)
	}
	if len(board.Config.States) != 9 {
		t.Fatalf("states = %d，想要 9", len(board.Config.States))
	}
	terminals := 0
	for _, state := range board.Config.States {
		if state.Name == "" || state.Meaning == "" {
			t.Fatalf("state 字段不全: %+v", state)
		}
		if state.Terminal {
			terminals++
		}
	}
	if terminals != 3 {
		t.Fatalf("terminal 状态 = %d，想要 3", terminals)
	}
	if len(board.Config.Transitions) != 14 {
		t.Fatalf("transitions = %d，想要 14", len(board.Config.Transitions))
	}
}

func TestEventsStartsEmpty(t *testing.T) {
	subject := newApp(newRoot(t))
	recorder := call(t, subject, http.MethodGet, "/api/events", "")
	expectStatus(t, recorder, http.StatusOK)
	var events struct {
		Events []map[string]any
	}
	decode(t, recorder, &events)
	if len(events.Events) != 0 {
		t.Fatalf("空账本 events = %d", len(events.Events))
	}
}

func TestItemWritesLedgerAndBoard(t *testing.T) {
	root := newRoot(t)
	subject := newApp(root)
	recorder := call(t, subject, http.MethodPost, "/api/item", "{\"title\":\"真需求\",\"body\":\"细节\"}")
	expectStatus(t, recorder, http.StatusOK)

	var event map[string]any
	decode(t, recorder, &event)
	if event["id"] != "REQ-1" {
		t.Fatalf("id = %v", event["id"])
	}
	if event["to"] != "accepted" || event["by"] != "platform" {
		t.Fatalf("落点不是入口候选: %v -> %v", event["from"], event["to"])
	}
	if event["flow"] != "auto" {
		t.Fatalf("flow = %v", event["flow"])
	}
	if event["comment"] != "新需求受理" {
		t.Fatalf("comment = %v", event["comment"])
	}
	if lines := ledgerLines(t, root); len(lines) != 1 {
		t.Fatalf("账本行数 = %d，想要 1", len(lines))
	}

	// 时间线读的是原始事件，不是折叠投影：新增一条就必须多一条。
	timeline := call(t, subject, http.MethodGet, "/api/events", "")
	expectStatus(t, timeline, http.StatusOK)
	var events struct {
		Events []struct {
			ID    string
			Title string
		}
	}
	decode(t, timeline, &events)
	if len(events.Events) != 1 || events.Events[0].ID != "REQ-1" || events.Events[0].Title != "真需求" {
		t.Fatalf("事件时间线不对: %s", timeline.Body.String())
	}

	board := call(t, subject, http.MethodGet, "/api/board", "")
	expectStatus(t, board, http.StatusOK)
	var folded struct {
		Items []struct {
			ID      string
			Title   string
			State   *string
			History []map[string]any `json:"history"`
		}
	}
	decode(t, board, &folded)
	if len(folded.Items) != 1 || folded.Items[0].Title != "真需求" {
		t.Fatalf("折叠结果不对: %s", board.Body.String())
	}
	if folded.Items[0].State == nil || *folded.Items[0].State != "accepted" {
		t.Fatalf("state = %v", folded.Items[0].State)
	}
	if len(folded.Items[0].History) != 1 {
		t.Fatalf("history 长度 = %d", len(folded.Items[0].History))
	}
}

func TestItemRejectsEmptyTitle(t *testing.T) {
	root := newRoot(t)
	recorder := call(t, newApp(root), http.MethodPost, "/api/item", "{\"title\":\"   \"}")
	expectStatus(t, recorder, http.StatusConflict)
	var problem struct {
		Kind    string
		Code    string
		Message string
	}
	decode(t, recorder, &problem)
	if problem.Kind != "rejected" || problem.Code != "E_TITLE_REQUIRED" || problem.Message == "" {
		t.Fatalf("错误形状不对: %+v", problem)
	}
	if _, err := os.Stat(ledgerPath(root)); !os.IsNotExist(err) {
		t.Fatal("被拒的请求不该留下账本")
	}
}

func TestVerdictRejectsUnknownItem(t *testing.T) {
	root := newRoot(t)
	recorder := call(t, newApp(root), http.MethodPost, "/api/verdict", "{\"id\":\"REQ-9\",\"to\":\"rejected\",\"comment\":\"不受理\"}")
	expectStatus(t, recorder, http.StatusConflict)
	var problem struct {
		Code    string
		Message string
	}
	decode(t, recorder, &problem)
	if problem.Code != "E_ITEM_MISSING" || problem.Message != "找不到该需求: REQ-9" {
		t.Fatalf("错误形状不对: %+v", problem)
	}
	if lines := ledgerLines(t, root); len(lines) != 0 {
		t.Fatalf("账本不该变化，实际 %d 行", len(lines))
	}
}

func TestVerdictPassesValidatorRejectionThrough(t *testing.T) {
	root := newRoot(t)
	subject := newApp(root)
	expectStatus(t, call(t, subject, http.MethodPost, "/api/item", "{\"title\":\"真需求\",\"body\":\"细节\"}"), http.StatusOK)

	// 缺评论：判定器的 comment_required 说了算，Go 不替它判断。
	missingComment := call(t, subject, http.MethodPost, "/api/verdict", "{\"id\":\"REQ-1\",\"to\":\"rejected\",\"actor_role\":\"owner\"}")
	expectStatus(t, missingComment, http.StatusConflict)
	var problem struct {
		Kind    string
		Code    string
		Message string
		Extra   map[string]any
	}
	decode(t, missingComment, &problem)
	if problem.Kind != "rejected" || problem.Code != "E_COMMENT_REQUIRED" || problem.Extra == nil {
		t.Fatalf("错误形状不对: %s", missingComment.Body.String())
	}

	// 无转换：accepted 没有到 triage 的边。
	noTransition := call(t, subject, http.MethodPost, "/api/verdict", "{\"id\":\"REQ-1\",\"to\":\"triage\",\"actor_role\":\"owner\",\"comment\":\"回炉\"}")
	expectStatus(t, noTransition, http.StatusConflict)
	decode(t, noTransition, &problem)
	if problem.Code != "E_NO_TRANSITION" {
		t.Fatalf("code = %q，想要 E_NO_TRANSITION（体 %s）", problem.Code, noTransition.Body.String())
	}

	// 未知状态：判定器判 infra，中间层照搬 500（不把 infra 改写成 rejected —— 那是第二份判定）。
	unknown := call(t, subject, http.MethodPost, "/api/verdict", "{\"id\":\"REQ-1\",\"to\":\"bogus\",\"actor_role\":\"owner\",\"comment\":\"去一个不存在的状态\"}")
	expectStatus(t, unknown, http.StatusInternalServerError)
	decode(t, unknown, &problem)
	if problem.Kind != "infra" || problem.Code != "E_UNKNOWN_STATE" {
		t.Fatalf("错误形状不对: %s", unknown.Body.String())
	}

	// 未知角色同理：判定器的分类是 infra，Go 只搬运。
	unknownRole := call(t, subject, http.MethodPost, "/api/verdict", "{\"id\":\"REQ-1\",\"to\":\"rejected\",\"actor_role\":\"maintainer\",\"comment\":\"角色不对\"}")
	expectStatus(t, unknownRole, http.StatusInternalServerError)
	decode(t, unknownRole, &problem)
	if problem.Kind != "infra" || problem.Code != "E_INTENT_SHAPE" {
		t.Fatalf("错误形状不对: %s", unknownRole.Body.String())
	}

	if lines := ledgerLines(t, root); len(lines) != 1 {
		t.Fatalf("被拒的裁决不该写账本，实际 %d 行", len(lines))
	}
}

func TestVerdictAllowedAppendsEvent(t *testing.T) {
	root := newRoot(t)
	subject := newApp(root)
	expectStatus(t, call(t, subject, http.MethodPost, "/api/item", "{\"title\":\"真需求\",\"body\":\"细节\"}"), http.StatusOK)

	recorder := call(t, subject, http.MethodPost, "/api/verdict", "{\"id\":\"REQ-1\",\"to\":\"rejected\",\"actor_role\":\"owner\",\"comment\":\"不做\"}")
	expectStatus(t, recorder, http.StatusOK)
	var event map[string]any
	decode(t, recorder, &event)
	if event["id"] != "REQ-1" || event["from"] != "accepted" || event["to"] != "rejected" {
		t.Fatalf("事件不对: %s", recorder.Body.String())
	}
	if event["comment"] != "不做" {
		t.Fatalf("comment = %v", event["comment"])
	}
	if _, ok := event["title"]; ok {
		t.Fatalf("裁决事件不该重复带标题: %s", recorder.Body.String())
	}
	if lines := ledgerLines(t, root); len(lines) != 2 {
		t.Fatalf("账本行数 = %d，想要 2", len(lines))
	}

	board := call(t, subject, http.MethodGet, "/api/board", "")
	expectStatus(t, board, http.StatusOK)
	var folded struct {
		Items []struct {
			State *string
		}
	}
	decode(t, board, &folded)
	if len(folded.Items) != 1 || folded.Items[0].State == nil || *folded.Items[0].State != "rejected" {
		t.Fatalf("折叠后状态不对: %s", board.Body.String())
	}
}

func TestConfigRead(t *testing.T) {
	subject := newApp(newRoot(t))
	recorder := call(t, subject, http.MethodGet, "/api/config", "")
	expectStatus(t, recorder, http.StatusOK)
	var payload struct {
		Text string
	}
	decode(t, recorder, &payload)
	if !strings.Contains(payload.Text, "label_prefix") || !strings.Contains(payload.Text, "transitions") {
		t.Fatalf("配置全文不对: %q", payload.Text)
	}
}

func TestConfigWriteKeepsFileOnValidatorRejection(t *testing.T) {
	root := newRoot(t)
	subject := newApp(root)
	configPath := filepath.Join(root, ".agents", "platform", "state-machine.yml")
	before, err := os.ReadFile(configPath)
	if err != nil {
		t.Fatalf("读原配置失败: %v", err)
	}

	recorder := call(t, subject, http.MethodPut, "/api/config", "{\"text\":\"version: 1\\ntransitions: [\"}")
	if recorder.Code != http.StatusConflict && recorder.Code != http.StatusInternalServerError {
		t.Fatalf("状态码 = %d，想要 409 或 500（体 %s）", recorder.Code, recorder.Body.String())
	}
	var problem struct {
		Kind    string
		Code    string
		Message string
	}
	decode(t, recorder, &problem)
	if problem.Code == "" || problem.Message == "" {
		t.Fatalf("错误形状不对: %s", recorder.Body.String())
	}
	after, err := os.ReadFile(configPath)
	if err != nil {
		t.Fatalf("原配置不见了: %v", err)
	}
	if string(before) != string(after) {
		t.Fatal("校验失败却动了正式配置")
	}
	if _, err := os.Stat(configPath + ".tmp"); !os.IsNotExist(err) {
		t.Fatal("校验失败必须删掉临时文件")
	}
}

func TestConfigWriteCommitsValidText(t *testing.T) {
	root := newRoot(t)
	subject := newApp(root)
	original, err := os.ReadFile(filepath.Join(root, ".agents", "platform", "state-machine.yml"))
	if err != nil {
		t.Fatalf("读原配置失败: %v", err)
	}
	// 只改注释：内容变了，但仍是同一份合法声明。
	updated := string(original) + "# 由测试追加的一行注释\n"
	payload, err := json.Marshal(map[string]string{"text": updated})
	if err != nil {
		t.Fatalf("编不出请求体: %v", err)
	}
	recorder := call(t, subject, http.MethodPut, "/api/config", string(payload))
	expectStatus(t, recorder, http.StatusOK)
	var ok struct {
		OK bool
	}
	decode(t, recorder, &ok)
	if !ok.OK {
		t.Fatalf("ok = %v", ok.OK)
	}
	after, err := os.ReadFile(filepath.Join(root, ".agents", "platform", "state-machine.yml"))
	if err != nil {
		t.Fatalf("读新配置失败: %v", err)
	}
	if string(after) != updated {
		t.Fatal("合法配置没有落盘")
	}
	if _, err := os.Stat(filepath.Join(root, ".agents", "platform", "state-machine.yml.tmp")); !os.IsNotExist(err) {
		t.Fatal("成功后不该留下临时文件")
	}
}

// newVerifyRoot 造一个能真跑 npm run check 的沙箱：不碰真仓库的检查链。
func newVerifyRoot(t *testing.T, checkScript string) string {
	t.Helper()
	root := t.TempDir()
	manifest, err := json.Marshal(map[string]any{
		"name":    "verify-fixture",
		"private": true,
		"scripts": map[string]string{"check": "node check.mjs"},
	})
	if err != nil {
		t.Fatalf("编不出 package.json: %v", err)
	}
	if err := os.WriteFile(filepath.Join(root, "package.json"), manifest, 0o644); err != nil {
		t.Fatalf("写 package.json 失败: %v", err)
	}
	if err := os.WriteFile(filepath.Join(root, "check.mjs"), []byte(checkScript), 0o644); err != nil {
		t.Fatalf("写 check.mjs 失败: %v", err)
	}
	return root
}

func TestVerifyReallyRunsCheck(t *testing.T) {
	subject := newApp(newVerifyRoot(t, "console.log(\"fixture-ok\")\n"))
	recorder := call(t, subject, http.MethodPost, "/api/verify", "")
	expectStatus(t, recorder, http.StatusOK)
	var result struct {
		ExitCode *int
		Output   string
	}
	decode(t, recorder, &result)
	if result.ExitCode == nil || *result.ExitCode != 0 {
		t.Fatalf("exitCode = %v", result.ExitCode)
	}
	if !strings.Contains(result.Output, "fixture-ok") {
		t.Fatalf("output 没有真跑痕迹: %q", result.Output)
	}
}

func TestVerifyReportsNonZeroExit(t *testing.T) {
	subject := newApp(newVerifyRoot(t, "process.exit(3)\n"))
	recorder := call(t, subject, http.MethodPost, "/api/verify", "")
	expectStatus(t, recorder, http.StatusOK)
	var result struct {
		ExitCode *int
		Output   string
	}
	decode(t, recorder, &result)
	if result.ExitCode == nil || *result.ExitCode != 3 {
		t.Fatalf("exitCode = %v，想要 3", result.ExitCode)
	}
}

func TestVerifyTruncatesOutputTail(t *testing.T) {
	subject := newApp(newVerifyRoot(t, "process.stdout.write(\"x\".repeat(9000))\n"))
	recorder := call(t, subject, http.MethodPost, "/api/verify", "")
	expectStatus(t, recorder, http.StatusOK)
	var result struct {
		Output string
	}
	decode(t, recorder, &result)
	runes := []rune(result.Output)
	if len(runes) != outputLimit {
		t.Fatalf("output 长度 = %d，想要 %d", len(runes), outputLimit)
	}
	if strings.Trim(string(runes), "x") != "" {
		t.Fatal("被截的不是末尾")
	}
}

func TestUnknownRouteIs404(t *testing.T) {
	subject := newApp(newRoot(t))
	// 页面源默认是内嵌资源；本用例要的是「没有任何页面可出」时的 404，所以把页面源显式清空。
	subject.dist = fstest.MapFS{}
	for _, target := range []string{"/api/nope", "/api", "/"} {
		recorder := call(t, subject, http.MethodGet, target, "")
		expectStatus(t, recorder, http.StatusNotFound)
		var problem struct {
			Code string
		}
		decode(t, recorder, &problem)
		if problem.Code != "E_NO_ROUTE" {
			t.Fatalf("%s 的 code = %q", target, problem.Code)
		}
	}
}

func TestWrongMethodIs404Not405(t *testing.T) {
	subject := newApp(newRoot(t))
	recorder := call(t, subject, http.MethodDelete, "/api/board", "")
	expectStatus(t, recorder, http.StatusNotFound)
	var problem struct {
		Code string
	}
	decode(t, recorder, &problem)
	if problem.Code != "E_NO_ROUTE" {
		t.Fatalf("code = %q", problem.Code)
	}
}

func TestBadBodyIs500(t *testing.T) {
	subject := newApp(newRoot(t))
	recorder := call(t, subject, http.MethodPost, "/api/item", "{\"title\":")
	expectStatus(t, recorder, http.StatusInternalServerError)
	var problem struct {
		Kind string
		Code string
	}
	decode(t, recorder, &problem)
	if problem.Kind != "infra" || problem.Code != "E_BODY_UNPARSABLE" {
		t.Fatalf("错误形状不对: %+v", problem)
	}
}

func TestOversizedBodyIs500(t *testing.T) {
	subject := newApp(newRoot(t))
	huge := "{\"title\":\"" + strings.Repeat("a", maxBodyBytes+16) + "\"}"
	recorder := call(t, subject, http.MethodPost, "/api/item", huge)
	expectStatus(t, recorder, http.StatusInternalServerError)
	var problem struct {
		Code string
	}
	decode(t, recorder, &problem)
	if problem.Code != "E_BODY_TOO_LARGE" {
		t.Fatalf("code = %q", problem.Code)
	}
}

func TestStaticServesSPAFallback(t *testing.T) {
	root := newRoot(t)
	dist := filepath.Join(root, "apps", "web-vue", "dist")
	if err := os.MkdirAll(filepath.Join(dist, "assets"), 0o755); err != nil {
		t.Fatalf("建 dist 失败: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dist, "index.html"), []byte("<html>spa</html>"), 0o644); err != nil {
		t.Fatalf("写 index.html 失败: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dist, "assets", "app.js"), []byte("console.log(1)"), 0o644); err != nil {
		t.Fatalf("写 app.js 失败: %v", err)
	}
	// 磁盘 dist 只在开发态生效：用 PLATFORM_DIST 显式指过去，否则默认走内嵌。
	t.Setenv("PLATFORM_DIST", dist)
	subject := newApp(root)
	for _, target := range []string{"/", "/board/REQ-1"} {
		recorder := call(t, subject, http.MethodGet, target, "")
		if recorder.Code != http.StatusOK || recorder.Body.String() != "<html>spa</html>" {
			t.Fatalf("%s 没有回退到 index.html: %d %q", target, recorder.Code, recorder.Body.String())
		}
		if got := recorder.Header().Get("content-type"); got != "text/html; charset=utf-8" {
			t.Fatalf("%s content-type = %q", target, got)
		}
	}
	asset := call(t, subject, http.MethodGet, "/assets/app.js", "")
	if asset.Code != http.StatusOK || asset.Body.String() != "console.log(1)" {
		t.Fatalf("静态资源没命中: %d %q", asset.Code, asset.Body.String())
	}
	if got := asset.Header().Get("content-type"); got != "text/javascript; charset=utf-8" {
		t.Fatalf("静态资源 content-type = %q", got)
	}
	// /api 之外仍是接口边界：dist 存在也不该把未知 API 当静态页。
	apiMiss := call(t, subject, http.MethodGet, "/api/nope", "")
	expectStatus(t, apiMiss, http.StatusNotFound)
}
