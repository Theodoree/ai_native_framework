package engine

// tests/audit-review.test.mjs 的 14 条判据搬到这里（P-31 阶段 D2 收口：Node 套件删除，判据不丢）。
// 原套件靠依赖注入换掉 fetch；Go 侧网络层只有一个出口（ReviewRequestChat），
// 所以这里用 httptest 起假上游、再由 --api-base 接进真代码路径 —— 注入边界换了一层，
// 断言的仍是「一个槽 -> 一次模型调用 -> 一份 findings JSON」。逐条映射见 /tmp/p31d2g-t17b-port.md。

import (
	"bytes"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// reviewTestKey 只用来证明它不出现在任何出口。
const reviewTestKey = "sk-test-not-a-real-key-7f3a"

type reviewFakeUpstream struct {
	calls         int
	authorization string
	contentType   string
	path          string
	lastBody      string
}

// newReviewFakeUpstream：每个用例自己决定回什么；调用计数、header、body 自动记下来。
func newReviewFakeUpstream(t *testing.T, respond func(body string) (int, string)) (*httptest.Server, *reviewFakeUpstream) {
	t.Helper()
	state := &reviewFakeUpstream{}
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		state.calls++
		state.authorization = request.Header.Get("authorization")
		state.contentType = request.Header.Get("content-type")
		state.path = request.URL.Path
		raw, _ := io.ReadAll(request.Body)
		state.lastBody = string(raw)
		status, text := respond(string(raw))
		writer.WriteHeader(status)
		io.WriteString(writer, text)
	}))
	t.Cleanup(server.Close)
	return server, state
}

// reviewChatReply 是上游 chat.completion 的正常响应体；id 为空时不写这个键（模拟上游没回 id）。
func reviewChatReply(id, content string) string {
	body := `{"object":"chat.completion","choices":[{"message":{"content":` + jsJSON(String(content)) + `}}]}`
	if id == "" {
		return body
	}
	return `{"id":` + jsJSON(String(id)) + `,` + body[1:]
}

const reviewBaseFinding = `{"path":"scripts/x.mjs","line":3,"severity":"high","criterion":"新增分支没有对应测试","suggestion":"补一条覆盖该分支的用例"}`
const reviewBlockerFinding = `{"path":"scripts/x.mjs","line":3,"severity":"blocker","criterion":"新增分支没有对应测试","suggestion":"补一条覆盖该分支的用例"}`
const reviewBadLineFinding = `{"path":"scripts/x.mjs","line":0,"severity":"high","criterion":"新增分支没有对应测试","suggestion":"补一条覆盖该分支的用例"}`

func reviewFindingsJSON(items string) string {
	return `{"findings":[` + items + `]}`
}

// reviewWorkdir 造一个临时工作目录（等价原套件的 mkdtempSync(join(tmpdir(), "audit-review-"))）。
func reviewWorkdir(t *testing.T) string {
	t.Helper()
	return t.TempDir()
}

func reviewDiffFile(t *testing.T, dir, text string) string {
	t.Helper()
	path := filepath.Join(dir, "pr.diff")
	if err := os.WriteFile(path, []byte(text), 0o644); err != nil {
		t.Fatalf("写 diff 失败: %v", err)
	}
	return path
}

// reviewRecord 读回 --out 落的那份记录。
func reviewRecord(t *testing.T, path string) *Value {
	t.Helper()
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("%s 没写出来: %v", path, err)
	}
	record, parseErr := ParseJSON(raw)
	if parseErr != nil {
		t.Fatalf("写出的记录不是合法 JSON: %v", parseErr)
	}
	return record
}

// runReview 调一次真代码路径，返回退出码与两个出口的全部字节。
func runReview(t *testing.T, argv []string, root string) (int, string, string) {
	t.Helper()
	var stdout, stderr bytes.Buffer
	code := RunAuditReview(argv, &stdout, &stderr, root)
	return code, stdout.String(), stderr.String()
}

// reviewRoutingModel 读真声明里这个槽绑的模型：测试不抄一份模型名。
func reviewRoutingModel(t *testing.T, slot string) string {
	t.Helper()
	cfg, err := LoadRouting(DefaultRoutingPath, repoRootAbs)
	if err != nil {
		t.Fatalf("真声明应当读得出来: %v", err)
	}
	_, model, routeErr := ResolveRouting(slot, cfg)
	if routeErr != nil {
		t.Fatalf("声明里应当有槽 %s: %v", slot, routeErr)
	}
	return model
}

func TestAuditReviewWritesFullRecord(t *testing.T) {
	dir := reviewWorkdir(t)
	server, state := newReviewFakeUpstream(t, func(string) (int, string) {
		return 200, reviewChatReply("req_live_9f1", reviewFindingsJSON(reviewBaseFinding))
	})
	t.Setenv("DEEPSEEK_API_KEY", reviewTestKey)
	outPath := filepath.Join(dir, "review-a.json")
	code, _, _ := runReview(t, []string{"--slot", "review-a", "--diff", reviewDiffFile(t, dir, "diff --git a/scripts/x.mjs b/scripts/x.mjs\n+x\n"), "--out", outPath, "--api-base", server.URL}, repoRootAbs)
	if code != ExitPass {
		t.Fatalf("写出可用记录应当退出 0，得到 %d", code)
	}
	record := reviewRecord(t, outPath)
	if verdict, _ := record.Get("verdict").StringValue(); verdict != "needs_revision" {
		t.Fatalf("一条 high 缺陷应当判 needs_revision，得到 %q", verdict)
	}
	if findings := record.Get("findings"); findings == nil || findings.Len() != 1 {
		t.Fatalf("findings 应当是 1 条，得到 %s", record.Get("findings").EncodeString())
	}
	want := `{"executor":"github","agent":"review-a","model":` + jsJSON(String(reviewRoutingModel(t, "review-a"))) + `,"request_id":"req_live_9f1"}`
	if got := record.Get("evidence").EncodeString(); got != want {
		t.Fatalf("evidence 必须是四字段齐全的那份：\nwant %s\ngot  %s", want, got)
	}
	// 判据只有一份：直接问口径层，不在这里抄一遍 schema。
	if ok, errors := ValidateAuditResult(record); !ok || len(errors) != 0 {
		t.Fatalf("写出的记录必须过口径层，得到 ok=%v errors=%v", ok, errors)
	}
	if state.calls != 1 {
		t.Fatalf("一个槽只该调一次上游，得到 %d 次", state.calls)
	}
	if state.path != "/chat/completions" {
		t.Fatalf("上游路径必须是 /chat/completions，得到 %q", state.path)
	}
}

func TestAuditReviewUsesRoutingModelPerSlot(t *testing.T) {
	seen := map[string]string{}
	for _, slot := range []string{"review-a", "review-b"} {
		seen[slot] = ""
	}
	for _, slot := range []string{"review-a", "review-b"} {
		dir := reviewWorkdir(t)
		slotName := slot
		server, state := newReviewFakeUpstream(t, func(string) (int, string) {
			return 200, reviewChatReply("req_1", reviewFindingsJSON(""))
		})
		t.Setenv("DEEPSEEK_API_KEY", reviewTestKey)
		outPath := filepath.Join(dir, "out.json")
		_, _, stderr := runReview(t, []string{"--slot", slotName, "--diff", reviewDiffFile(t, dir, "diff --git a/scripts/x.mjs b/scripts/x.mjs\n+x\n"), "--out", outPath, "--api-base", server.URL}, repoRootAbs)
		if stderr != "" {
			t.Fatalf("[%s] 成功路径不该有 stderr，得到 %q", slotName, stderr)
		}
		body, err := ParseJSON([]byte(state.lastBody))
		if err != nil {
			t.Fatalf("[%s] 请求体不是合法 JSON: %v", slotName, err)
		}
		model, _ := body.Get("model").StringValue()
		seen[slotName] = model
		record := reviewRecord(t, outPath)
		evidenceModel, _ := record.Get("evidence").Get("model").StringValue()
		if evidenceModel != reviewRoutingModel(t, slotName) {
			t.Fatalf("[%s] evidence.model 必须来自 routing.yml，want %q got %q", slotName, reviewRoutingModel(t, slotName), evidenceModel)
		}
	}
	if seen["review-a"] != "deepseek-chat" {
		t.Fatalf("review-a 应当用 deepseek-chat，得到 %q", seen["review-a"])
	}
	if seen["review-b"] != "deepseek-reasoner" {
		t.Fatalf("review-b 应当用 deepseek-reasoner，得到 %q", seen["review-b"])
	}
	if seen["review-a"] == seen["review-b"] {
		t.Fatalf("两个槽必须用不同的模型，得到同一个 %q", seen["review-a"])
	}
}

func TestAuditReviewPassesWhenNoFindings(t *testing.T) {
	dir := reviewWorkdir(t)
	server, _ := newReviewFakeUpstream(t, func(string) (int, string) {
		return 200, reviewChatReply("req_2", reviewFindingsJSON(""))
	})
	t.Setenv("DEEPSEEK_API_KEY", reviewTestKey)
	outPath := filepath.Join(dir, "review-a.json")
	code, _, _ := runReview(t, []string{"--slot", "review-a", "--diff", reviewDiffFile(t, dir, "diff\n+x\n"), "--out", outPath, "--api-base", server.URL}, repoRootAbs)
	if code != ExitPass {
		t.Fatalf("空 findings 也是合格记录，应当退出 0，得到 %d", code)
	}
	record := reviewRecord(t, outPath)
	if verdict, _ := record.Get("verdict").StringValue(); verdict != "pass" {
		t.Fatalf("没有缺陷应当判 pass，得到 %q", verdict)
	}
	if ok, _ := ValidateAuditResult(record); !ok {
		t.Fatalf("pass 记录也必须过口径层")
	}
}

func TestAuditReviewRejectsOnBlocker(t *testing.T) {
	dir := reviewWorkdir(t)
	server, _ := newReviewFakeUpstream(t, func(string) (int, string) {
		return 200, reviewChatReply("req_3", reviewFindingsJSON(reviewBlockerFinding))
	})
	t.Setenv("DEEPSEEK_API_KEY", reviewTestKey)
	outPath := filepath.Join(dir, "review-a.json")
	code, _, _ := runReview(t, []string{"--slot", "review-a", "--diff", reviewDiffFile(t, dir, "diff\n+x\n"), "--out", outPath, "--api-base", server.URL}, repoRootAbs)
	if code != ExitPass {
		t.Fatalf("judged 记录应当退出 0，得到 %d", code)
	}
	if verdict, _ := reviewRecord(t, outPath).Get("verdict").StringValue(); verdict != "reject" {
		t.Fatalf("blocker 必须推出 reject，得到 %q", verdict)
	}
}

func TestAuditReviewTruncatesLongDiff(t *testing.T) {
	dir := reviewWorkdir(t)
	server, state := newReviewFakeUpstream(t, func(string) (int, string) {
		return 200, reviewChatReply("req_4", reviewFindingsJSON(""))
	})
	t.Setenv("DEEPSEEK_API_KEY", reviewTestKey)
	diff := reviewDiffFile(t, dir, strings.Repeat("a", ReviewMaxDiffChars+500))
	_, _, _ = runReview(t, []string{"--slot", "review-a", "--diff", diff, "--out", filepath.Join(dir, "out.json"), "--api-base", server.URL}, repoRootAbs)
	body, err := ParseJSON([]byte(state.lastBody))
	if err != nil {
		t.Fatalf("请求体不是合法 JSON: %v", err)
	}
	messages := body.Get("messages")
	userContent := ""
	for index := 0; messages != nil && index < messages.Len(); index++ {
		message := messages.At(index)
		if role, _ := message.Get("role").StringValue(); role != "user" {
			continue
		}
		userContent, _ = message.Get("content").StringValue()
	}
	if !strings.Contains(userContent, "已截断") {
		t.Fatalf("超上限的 diff 必须在 prompt 里说明已截断")
	}
	if len([]rune(userContent)) >= ReviewMaxDiffChars+1000 {
		t.Fatalf("prompt 不该把整段 diff 都带上，得到 %d 字符", len([]rune(userContent)))
	}
}

func TestAuditReviewInfraWhenCannotJudge(t *testing.T) {
	cases := []struct {
		name    string
		noKey   bool
		respond func(string) (int, string)
	}{
		{name: "没有 DEEPSEEK_API_KEY", noKey: true, respond: nil},
		{name: "上游 401", respond: func(string) (int, string) { return 401, `{"error":{"message":"Unauthorized"}}` }},
		{name: "上游 500", respond: func(string) (int, string) { return 500, "boom" }},
		{name: "响应体不是 JSON", respond: func(string) (int, string) { return 200, "<html>oops</html>" }},
		{name: "响应体里没有 choices", respond: func(string) (int, string) { return 200, `{"id":"req_5","object":"chat.completion"}` }},
		{name: "模型回的不是 JSON", respond: func(string) (int, string) {
			return 200, reviewChatReply("req_6", "我认为这段 diff 没什么问题")
		}},
		{name: "模型 JSON 里没有 findings", respond: func(string) (int, string) { return 200, reviewChatReply("req_7", `{"notes":[]}`) }},
		{name: "findings 不合契约", respond: func(string) (int, string) {
			return 200, reviewChatReply("req_8", reviewFindingsJSON(reviewBadLineFinding))
		}},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			dir := reviewWorkdir(t)
			var state *reviewFakeUpstream
			apiBase := "http://127.0.0.1:1"
			if testCase.respond != nil {
				server, serverState := newReviewFakeUpstream(t, testCase.respond)
				state = serverState
				apiBase = server.URL
			}
			if testCase.noKey {
				t.Setenv("DEEPSEEK_API_KEY", "")
			} else {
				t.Setenv("DEEPSEEK_API_KEY", reviewTestKey)
			}
			outPath := filepath.Join(dir, "review-a.json")
			code, _, _ := runReview(t, []string{"--slot", "review-a", "--diff", reviewDiffFile(t, dir, "diff\n+x\n"), "--out", outPath, "--api-base", apiBase}, repoRootAbs)
			if code != ExitUnknown {
				t.Fatalf("判不了必须退出 %d，得到 %d", ExitUnknown, code)
			}
			record := reviewRecord(t, outPath)
			if verdict, _ := record.Get("verdict").StringValue(); verdict != "INFRA" {
				t.Fatalf("判不了只能落 INFRA，得到 %q", verdict)
			}
			findings := record.Get("findings")
			if findings == nil || findings.Len() != 0 {
				t.Fatalf("INFRA 记录不该带 findings，得到 %s", record.Get("findings").EncodeString())
			}
			evidence := record.Get("evidence")
			if executor, _ := evidence.Get("executor").StringValue(); executor != ReviewExecutor {
				t.Fatalf("evidence.executor 必须是 %q，得到 %q", ReviewExecutor, executor)
			}
			if agent, _ := evidence.Get("agent").StringValue(); agent != "review-a" {
				t.Fatalf("evidence.agent 必须是槽名 review-a，得到 %q", agent)
			}
			reason, hasReason := record.Get("reason").StringValue()
			if !hasReason || strings.TrimSpace(reason) == "" {
				t.Fatalf("INFRA 必须说明为什么判不了")
			}
			if testCase.noKey && state != nil && state.calls != 0 {
				t.Fatalf("没有 key 时不该碰上游，得到 %d 次调用", state.calls)
			}
			if !testCase.noKey && state != nil && state.calls != 1 {
				t.Fatalf("判不了也要看一次上游的答复，得到 %d 次调用", state.calls)
			}
			// 判不了的时候 evidence 里本来就没有 model / request_id，schema 必然不合格；
			// 口径层对不合格的处理就是 INFRA —— 断言这条链，而不是断言「记录恰好齐全」。
			if effective := AuditEffectiveVerdict(record); effective != "INFRA" {
				t.Fatalf("口径层必须把它当 INFRA，得到 %q", effective)
			}
		})
	}
}

func TestAuditReviewOmitsRequestIDWhenUpstreamSilent(t *testing.T) {
	dir := reviewWorkdir(t)
	server, _ := newReviewFakeUpstream(t, func(string) (int, string) {
		return 200, reviewChatReply("", reviewFindingsJSON(""))
	})
	t.Setenv("DEEPSEEK_API_KEY", reviewTestKey)
	outPath := filepath.Join(dir, "review-a.json")
	code, _, _ := runReview(t, []string{"--slot", "review-a", "--diff", reviewDiffFile(t, dir, "diff\n+x\n"), "--out", outPath, "--api-base", server.URL}, repoRootAbs)
	if code != ExitUnknown {
		t.Fatalf("上游没回 id 就等于没有可追查的凭据，必须退出 %d，得到 %d", ExitUnknown, code)
	}
	record := reviewRecord(t, outPath)
	if verdict, _ := record.Get("verdict").StringValue(); verdict != "INFRA" {
		t.Fatalf("应当落 INFRA，得到 %q", verdict)
	}
	// 必须钉住「是 request_id 这一格判不了」，而不是「结果不合 schema」——
	// 后者也会提到 request_id，但那是校验器在替守卫兜底，说明守卫已被绕过。
	if reason, _ := record.Get("reason").StringValue(); !strings.HasPrefix(reason, "上游没有回 request_id") {
		t.Fatalf("reason 必须是 request_id 守卫给出的那句话，得到 %q", reason)
	}
	if record.Get("evidence").Get("request_id") != nil {
		t.Fatalf("没有 id 就不该写这个键，得到 %s", record.Get("evidence").EncodeString())
	}
}

func TestAuditReviewWithoutKeyNeverWritesKey(t *testing.T) {
	dir := reviewWorkdir(t)
	t.Setenv("DEEPSEEK_API_KEY", "")
	outPath := filepath.Join(dir, "review-a.json")
	code, stdout, stderr := runReview(t, []string{"--slot", "review-a", "--diff", reviewDiffFile(t, dir, "diff\n+x\n"), "--out", outPath}, repoRootAbs)
	if code != ExitUnknown {
		t.Fatalf("没有 key 必须退出 %d，得到 %d", ExitUnknown, code)
	}
	raw, err := os.ReadFile(outPath)
	if err != nil {
		t.Fatalf("即使判不了也要留下记录: %v", err)
	}
	if strings.Contains(string(raw), "sk-") || strings.Contains(stdout, "sk-") || strings.Contains(stderr, "sk-") {
		t.Fatalf("任何出口都不该出现 key 形态的串")
	}
	if reason, _ := reviewRecord(t, outPath).Get("reason").StringValue(); !strings.Contains(reason, "DEEPSEEK_API_KEY") {
		t.Fatalf("reason 必须点出缺的是环境变量，得到 %q", reason)
	}
}

func TestAuditReviewInfraWhenRoutingMissing(t *testing.T) {
	// Go 侧没有 routingPath 注入口：把 root 换成一个空目录，真声明就读不到了（等价原套件的注入）。
	dir := reviewWorkdir(t)
	server, state := newReviewFakeUpstream(t, func(string) (int, string) {
		return 200, reviewChatReply("req_9", reviewFindingsJSON(""))
	})
	t.Setenv("DEEPSEEK_API_KEY", reviewTestKey)
	outPath := filepath.Join(dir, "review-a.json")
	code, _, _ := runReview(t, []string{"--slot", "review-a", "--diff", reviewDiffFile(t, dir, "diff\n+x\n"), "--out", outPath, "--api-base", server.URL}, dir)
	if code != ExitUnknown {
		t.Fatalf("取不到模型真源必须退出 %d，得到 %d", ExitUnknown, code)
	}
	if state.calls != 0 {
		t.Fatalf("不知道用哪个模型就不该调上游，得到 %d 次", state.calls)
	}
	record := reviewRecord(t, outPath)
	if verdict, _ := record.Get("verdict").StringValue(); verdict != "INFRA" {
		t.Fatalf("应当落 INFRA，得到 %q", verdict)
	}
}

func TestAuditReviewKeepsKeyOutOfBodyAndOutput(t *testing.T) {
	dir := reviewWorkdir(t)
	server, state := newReviewFakeUpstream(t, func(string) (int, string) {
		return 200, reviewChatReply("req_10", reviewFindingsJSON(""))
	})
	t.Setenv("DEEPSEEK_API_KEY", reviewTestKey)
	outPath := filepath.Join(dir, "review-a.json")
	_, stdout, stderr := runReview(t, []string{"--slot", "review-a", "--diff", reviewDiffFile(t, dir, "diff\n+x\n"), "--out", outPath, "--api-base", server.URL}, repoRootAbs)
	if state.authorization != "Bearer "+reviewTestKey {
		t.Fatalf("key 必须只在 Authorization 头里，得到 %q", state.authorization)
	}
	if state.contentType != "application/json" {
		t.Fatalf("content-type 必须是 application/json，得到 %q", state.contentType)
	}
	raw, err := os.ReadFile(outPath)
	if err != nil {
		t.Fatalf("记录没写出来: %v", err)
	}
	for _, surface := range []struct{ name, text string }{
		{"请求体", state.lastBody},
		{"上游 URL", server.URL},
		{"stdout", stdout},
		{"stderr", stderr},
		{"写出文件", string(raw)},
	} {
		if strings.Contains(surface.text, reviewTestKey) {
			t.Fatalf("%s 里出现了 key", surface.name)
		}
	}
}

func TestAuditReviewRedactsKeyInDiagnostics(t *testing.T) {
	dir := reviewWorkdir(t)
	server, _ := newReviewFakeUpstream(t, func(string) (int, string) {
		return 401, `{"error":{"message":"bad key ` + reviewTestKey + `"}}`
	})
	t.Setenv("DEEPSEEK_API_KEY", reviewTestKey)
	outPath := filepath.Join(dir, "review-a.json")
	_, stdout, stderr := runReview(t, []string{"--slot", "review-a", "--diff", reviewDiffFile(t, dir, "diff\n+x\n"), "--out", outPath, "--api-base", server.URL}, repoRootAbs)
	raw, err := os.ReadFile(outPath)
	if err != nil {
		t.Fatalf("记录没写出来: %v", err)
	}
	for _, surface := range []struct{ name, text string }{
		{"stderr", stderr},
		{"stdout", stdout},
		{"写出文件", string(raw)},
	} {
		if strings.Contains(surface.text, reviewTestKey) {
			t.Fatalf("%s 把上游回的 key 原样带出来了", surface.name)
		}
	}
	if !strings.Contains(stderr, "[REDACTED]") && !strings.Contains(string(raw), "[REDACTED]") {
		t.Fatalf("脱敏要留下看得见的替身，stderr=%q", stderr)
	}
}
func TestAuditReviewUsageErrors(t *testing.T) {
	// 用法错是「调用方写错了」，不是「判不了」——退出码必须分得开。
	cases := []struct {
		name string
		argv func(dir string) []string
	}{
		{name: "缺 --slot", argv: func(dir string) []string {
			return []string{"--diff", filepath.Join(dir, "pr.diff"), "--out", filepath.Join(dir, "out.json")}
		}},
		{name: "缺 --diff", argv: func(dir string) []string {
			return []string{"--slot", "review-a", "--out", filepath.Join(dir, "out.json")}
		}},
		{name: "缺 --out", argv: func(dir string) []string {
			return []string{"--slot", "review-a", "--diff", filepath.Join(dir, "pr.diff")}
		}},
		{name: "非法槽位", argv: func(dir string) []string {
			return []string{"--slot", "review-c", "--diff", filepath.Join(dir, "pr.diff"), "--out", filepath.Join(dir, "out.json")}
		}},
		{name: "不许指定模型", argv: func(dir string) []string {
			return []string{"--slot", "review-a", "--diff", filepath.Join(dir, "pr.diff"), "--out", filepath.Join(dir, "out.json"), "--model", "gpt-x"}
		}},
		{name: "--out 目录不存在", argv: func(dir string) []string {
			return []string{"--slot", "review-a", "--diff", filepath.Join(dir, "pr.diff"), "--out", filepath.Join(dir, "no-such-dir", "out.json")}
		}},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			dir := reviewWorkdir(t)
			reviewDiffFile(t, dir, "diff\n+x\n")
			server, state := newReviewFakeUpstream(t, func(string) (int, string) {
				return 200, reviewChatReply("req_11", reviewFindingsJSON(""))
			})
			t.Setenv("DEEPSEEK_API_KEY", reviewTestKey)
			argv := testCase.argv(dir)
			argv = append(argv, "--api-base", server.URL)
			code, _, stderr := runReview(t, argv, repoRootAbs)
			if code != ExitUsage {
				t.Fatalf("用法错必须退出 %d，得到 %d", ExitUsage, code)
			}
			if strings.TrimSpace(stderr) == "" {
				t.Fatalf("用法错必须说明怎么用")
			}
			if state.calls != 0 {
				t.Fatalf("参数都没校验完就不该碰上游，得到 %d 次调用", state.calls)
			}
		})
	}
}

func TestAuditReviewCLIWithoutKeyWritesINFRA(t *testing.T) {
	// 走真进程：这一条的注入边界就在 CLI（环境变量 + 退出码），Go 内测不到「进程怎么退出」。
	dir := reviewWorkdir(t)
	engine := engineBinaryForTest(t)
	diffPath := reviewDiffFile(t, dir, "diff\n+x\n")
	outPath := filepath.Join(dir, "review-b.json")
	command := exec.Command(engine, "audit-review", "--slot", "review-b", "--diff", diffPath, "--out", outPath)
	command.Dir = dir
	command.Env = append([]string{}, "PATH="+os.Getenv("PATH"), "HOME="+os.Getenv("HOME"), "DEEPSEEK_API_KEY=")
	var stdout, stderr bytes.Buffer
	command.Stdout = &stdout
	command.Stderr = &stderr
	err := command.Run()
	exitCode := 0
	if err != nil {
		var exitErr *exec.ExitError
		if !errors.As(err, &exitErr) {
			t.Fatalf("跑不起来: %v", err)
		}
		exitCode = exitErr.ExitCode()
	}
	if exitCode != ExitUnknown {
		t.Fatalf("没有 key 的进程必须退出 %d，得到 %d（stderr=%s）", ExitUnknown, exitCode, stderr.String())
	}
	record := reviewRecord(t, outPath)
	if verdict, _ := record.Get("verdict").StringValue(); verdict != "INFRA" {
		t.Fatalf("应当落 INFRA，得到 %q", verdict)
	}
	if agent, _ := record.Get("evidence").Get("agent").StringValue(); agent != "review-b" {
		t.Fatalf("evidence.agent 必须是槽名 review-b，得到 %q", agent)
	}
	if strings.Contains(stdout.String(), "sk-") || strings.Contains(stderr.String(), "sk-") {
		t.Fatalf("进程出口不该出现 key 形态的串")
	}
}

func TestAuditReviewCLIUsageExit2(t *testing.T) {
	dir := reviewWorkdir(t)
	engine := engineBinaryForTest(t)
	command := exec.Command(engine, "audit-review", "--slot", "review-z", "--diff", filepath.Join(dir, "pr.diff"), "--out", filepath.Join(dir, "out.json"))
	command.Dir = dir
	command.Env = []string{"PATH=" + os.Getenv("PATH"), "HOME=" + os.Getenv("HOME")}
	err := command.Run()
	if err == nil {
		t.Fatalf("非法槽位应当以 %d 退出", ExitUsage)
	}
	var exitErr *exec.ExitError
	if !errors.As(err, &exitErr) {
		t.Fatalf("跑不起来: %v", err)
	}
	if exitErr.ExitCode() != ExitUsage {
		t.Fatalf("非法槽位必须退出 %d，得到 %d", ExitUsage, exitErr.ExitCode())
	}
}
