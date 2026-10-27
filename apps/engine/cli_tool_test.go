package engine

import (
	"bytes"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

// 这些用例逐条钉住原 scripts/cli.mjs 的判据：参照物已随本批删除，全仓再无 Node
// 用例 import / spawn 过它，判据全部落在这里。
//
// 与 Node 侧的差别只在断言层，不在判据上：Node 起真实进程 + node:http 假后端，
// 这里经 Run(["cli", …]) 走 cli.go 的 case 表 + httptest 假后端。发出去的字节
// （method / path / body）、stdout / stderr 文案、退出码 0/1/2/3/4 一处不放宽。

type cliSeen struct {
	method string
	path   string
	raw    string
}

// cliRoute 按路径回放：返回 HTTP 状态码与响应正文。
type cliRoute func(cliSeen) (int, string)

type cliFake struct {
	server *httptest.Server
	seen   []cliSeen
}

// cliStart 复刻 Node 侧的 startBackend：每条请求都记下来，未登记的路径回 404 infra。
func cliStart(t *testing.T, routes map[string]cliRoute) *cliFake {
	t.Helper()
	fake := &cliFake{}
	fake.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var buf bytes.Buffer
		if r.Body != nil {
			_, _ = buf.ReadFrom(r.Body)
		}
		seen := cliSeen{method: r.Method, path: r.URL.Path, raw: buf.String()}
		fake.seen = append(fake.seen, seen)
		status, body := 404, `{"kind":"infra","code":"E_NO_ROUTE","message":"没有这个接口"}`
		if route, ok := routes[seen.path]; ok {
			status, body = route(seen)
		} else if fallback, ok := routes["*"]; ok {
			status, body = fallback(seen)
		}
		w.Header().Set("content-type", "application/json")
		w.WriteHeader(status)
		_, _ = w.Write([]byte(body))
	}))
	t.Cleanup(fake.server.Close)
	return fake
}

// cliStartStatus 是「所有路径都回同一状态码与正文」的假后端，用来钉退出码映射。
func cliStartStatus(t *testing.T, status int, body string) *cliFake {
	t.Helper()
	return cliStart(t, map[string]cliRoute{
		"*": func(cliSeen) (int, string) { return status, body },
	})
}

func (f *cliFake) url() string { return f.server.URL }

func (f *cliFake) only(t *testing.T) cliSeen {
	t.Helper()
	if len(f.seen) != 1 {
		t.Fatalf("请求数 = %d，期望 1", len(f.seen))
	}
	return f.seen[0]
}

func (f *cliFake) count(t *testing.T, want int) {
	t.Helper()
	if len(f.seen) != want {
		t.Fatalf("请求数 = %d，期望 %d", len(f.seen), want)
	}
}

// cliRun 走 cli.go 的 case 表，等价于 Node 侧的 spawn(process.execPath, [cli, …])。
func cliRun(t *testing.T, argv ...string) (int, string, string) {
	t.Helper()
	var out, errOut bytes.Buffer
	code := Run(append([]string{"cli"}, argv...), strings.NewReader(""), &out, &errOut, "")
	return code, out.String(), errOut.String()
}

func cliWantCode(t *testing.T, code, want int) {
	t.Helper()
	if code != want {
		t.Fatalf("退出码 = %d，期望 %d", code, want)
	}
}

func cliWantContains(t *testing.T, text, needle, what string) {
	t.Helper()
	if !strings.Contains(text, needle) {
		t.Fatalf("%s 应当含 %q；实际正文:\n%s", what, needle, text)
	}
}

func cliWantAbsent(t *testing.T, text, needle, what string) {
	t.Helper()
	if strings.Contains(text, needle) {
		t.Fatalf("%s 不该含 %q；实际正文:\n%s", what, needle, text)
	}
}

// cliWantSameJSON 比语义：两侧都解析后按同一编码器比，等价于 Node 的 JSON.parse + toEqual。
func cliWantSameJSON(t *testing.T, got, want, what string) {
	t.Helper()
	gotValue, gotErr := ParseJSON([]byte(got))
	if gotErr != nil {
		t.Fatalf("%s 不是合法 JSON: %v\n%s", what, gotErr, got)
	}
	wantValue, wantErr := ParseJSON([]byte(want))
	if wantErr != nil {
		t.Fatalf("%s 的期望值不是合法 JSON: %v", what, wantErr)
	}
	if gotValue.EncodeString() != wantValue.EncodeString() {
		t.Fatalf("%s 不符\n期望: %s\n实际: %s", what, wantValue.Encode(), gotValue.Encode())
	}
}

// cliBody 把记下来的请求体解析成 Value；空正文返回 nil（Node 侧记作 body: null）。
func cliBody(t *testing.T, seen cliSeen) *Value {
	t.Helper()
	if seen.raw == "" {
		return nil
	}
	parsed, err := ParseJSON([]byte(seen.raw))
	if err != nil {
		t.Fatalf("请求体不是合法 JSON: %v\n%s", err, seen.raw)
	}
	return parsed
}

func cliWantField(t *testing.T, body *Value, key, want string) {
	t.Helper()
	if body == nil {
		t.Fatalf("请求体为空，取不到字段 %s", key)
	}
	got, ok := body.Get(key).StringValue()
	if !ok {
		t.Fatalf("请求体缺字段 %s；实际: %s", key, body.Encode())
	}
	if got != want {
		t.Fatalf("请求体字段 %s = %q，期望 %q", key, got, want)
	}
}

// 夹具：一条带漂移的看板响应。
const cliBoardFixture = `{"items":[{"id":"REQ-1","title":"第一条需求","state":"accepted","divergence":false},{"id":"REQ-2","title":"第二条需求","state":"in-progress","divergence":true}],"config":{"defaultFlow":"auto","labelPrefix":"state:"}}`

func cliBoardRoutes() map[string]cliRoute {
	return map[string]cliRoute{
		"/api/board": func(cliSeen) (int, string) { return 200, cliBoardFixture },
	}
}

func cliVerdictRoutes(body string) map[string]cliRoute {
	return map[string]cliRoute{
		"/api/verdict": func(cliSeen) (int, string) { return 200, body },
	}
}

// ---- board：只读，路径与形状都对得上 ----

func TestCliBoardJSONPrintsBackendResponseVerbatim(t *testing.T) {
	fake := cliStart(t, cliBoardRoutes())
	code, stdout, stderr := cliRun(t, "board", "--json", "--api", fake.url())
	seen := fake.only(t)

	if seen.method != "GET" || seen.path != "/api/board" || seen.raw != "" {
		t.Fatalf("请求形状不符：method=%q path=%q body=%q", seen.method, seen.path, seen.raw)
	}
	cliWantCode(t, code, 0)
	if stderr != "" {
		t.Fatalf("stderr 应当为空；实际: %q", stderr)
	}
	cliWantSameJSON(t, stdout, cliBoardFixture, "board --json 的 stdout")
}

func TestCliBoardHumanTableMarksDivergence(t *testing.T) {
	fake := cliStart(t, cliBoardRoutes())
	code, stdout, _ := cliRun(t, "board", "--api", fake.url())

	cliWantCode(t, code, 0)
	for _, needle := range []string{"ID", "STATE", "TITLE", "REQ-1", "accepted", "第一条需求", "远端漂移"} {
		cliWantContains(t, stdout, needle, "board 人读模式")
	}
}

func TestCliPlatformAPIEnvEqualsFlag(t *testing.T) {
	fake := cliStart(t, cliBoardRoutes())
	t.Setenv("PLATFORM_API", fake.url())
	code, stdout, _ := cliRun(t, "board", "--json")
	seen := fake.only(t)

	cliWantCode(t, code, 0)
	if seen.path != "/api/board" {
		t.Fatalf("请求路径 = %q，期望 /api/board", seen.path)
	}
	cliWantSameJSON(t, stdout, cliBoardFixture, "PLATFORM_API 的 stdout")
}

// ---- new：body 只有 title 与 body，缺 title 是用法错误 ----

func TestCliNewPostsTitleAndBody(t *testing.T) {
	fake := cliStart(t, map[string]cliRoute{
		"/api/item": func(cliSeen) (int, string) {
			return 200, `{"id":"REQ-9","from":"none","to":"accepted","by":"platform"}`
		},
	})
	code, stdout, _ := cliRun(t, "new", "cli 联调", "--body", "正文内容", "--api", fake.url())
	seen := fake.only(t)
	body := cliBody(t, seen)

	cliWantCode(t, code, 0)
	if seen.method != "POST" || seen.path != "/api/item" {
		t.Fatalf("请求形状不符：method=%q path=%q", seen.method, seen.path)
	}
	// Node 侧同时钉了 toEqual 与 Object.keys().sort()：键集合恰好两个，不许多带。
	if body == nil || body.EntryCount() != 2 {
		t.Fatalf("请求体应当恰好两个字段；实际: %s", seen.raw)
	}
	cliWantField(t, body, "title", "cli 联调")
	cliWantField(t, body, "body", "正文内容")
	cliWantContains(t, stdout, "REQ-9", "new 的 stdout")
	cliWantContains(t, stdout, "accepted", "new 的 stdout")
}

func TestCliNewWithoutBodySendsEmptyBody(t *testing.T) {
	fake := cliStart(t, map[string]cliRoute{
		"/api/item": func(cliSeen) (int, string) {
			return 200, `{"id":"REQ-10","from":"none","to":"accepted"}`
		},
	})
	code, _, _ := cliRun(t, "new", "只给标题", "--api", fake.url())
	seen := fake.only(t)
	body := cliBody(t, seen)

	cliWantCode(t, code, 0)
	if body == nil || body.EntryCount() != 2 {
		t.Fatalf("请求体应当恰好两个字段；实际: %s", seen.raw)
	}
	cliWantField(t, body, "title", "只给标题")
	cliWantField(t, body, "body", "")
}

func TestCliNewWithoutTitleIsUsageError(t *testing.T) {
	fake := cliStart(t, map[string]cliRoute{
		"/api/item": func(cliSeen) (int, string) { return 200, `{"id":"REQ-11"}` },
	})
	code, _, stderr := cliRun(t, "new", "--api", fake.url())

	cliWantCode(t, code, 2)
	cliWantContains(t, stderr, "用法", "缺 title 的 stderr")
	cliWantContains(t, stderr, "title", "缺 title 的 stderr")
	fake.count(t, 0)
}

func TestCliNewEmptyTitleForwardsAndBackendRejects(t *testing.T) {
	fake := cliStart(t, map[string]cliRoute{
		"/api/item": func(cliSeen) (int, string) {
			return 400, `{"kind":"rejected","code":"E_TITLE_REQUIRED","message":"标题不能为空","extra":{}}`
		},
	})
	code, _, stderr := cliRun(t, "new", "", "--api", fake.url())
	body := cliBody(t, fake.only(t))

	cliWantField(t, body, "title", "")
	cliWantField(t, body, "body", "")
	cliWantCode(t, code, 1)
	cliWantContains(t, stderr, "标题不能为空", "rejected 的 stderr")
}

// ---- verdict：--to 原样转发，--role 缺省 owner ----

func TestCliVerdictBodyDefaultsOwner(t *testing.T) {
	fake := cliStart(t, cliVerdictRoutes(`{"id":"REQ-1","from":"accepted","to":"in-progress","by":"owner"}`))
	code, stdout, _ := cliRun(t, "verdict", "--id", "REQ-1", "--to", "in-progress", "--api", fake.url())
	seen := fake.only(t)
	body := cliBody(t, seen)

	cliWantCode(t, code, 0)
	if seen.method != "POST" || seen.path != "/api/verdict" {
		t.Fatalf("请求形状不符：method=%q path=%q", seen.method, seen.path)
	}
	if body == nil || body.EntryCount() != 4 {
		t.Fatalf("请求体应当恰好四个字段；实际: %s", seen.raw)
	}
	cliWantField(t, body, "id", "REQ-1")
	cliWantField(t, body, "to", "in-progress")
	cliWantField(t, body, "actor_role", "owner")
	cliWantField(t, body, "comment", "")
	cliWantContains(t, stdout, "accepted -> in-progress", "verdict 的 stdout")
}

func TestCliVerdictRoleAndCommentForwarded(t *testing.T) {
	fake := cliStart(t, cliVerdictRoutes(`{"id":"REQ-1","from":"accepted","to":"in-progress","by":"ci"}`))
	code, _, _ := cliRun(t, "verdict", "--id", "REQ-1", "--to", "in-progress",
		"--role", "ci", "--comment", "CI 起 PR", "--api", fake.url())
	body := cliBody(t, fake.only(t))

	cliWantCode(t, code, 0)
	cliWantField(t, body, "actor_role", "ci")
	cliWantField(t, body, "comment", "CI 起 PR")
}

func TestCliVerdictForwardsAnyStateName(t *testing.T) {
	fake := cliStart(t, cliVerdictRoutes(`{"id":"REQ-1","from":"accepted","to":"made-up-state","by":"owner"}`))
	code, _, _ := cliRun(t, "verdict", "--id", "REQ-1", "--to", "made-up-state", "--api", fake.url())
	body := cliBody(t, fake.only(t))

	cliWantCode(t, code, 0)
	cliWantField(t, body, "to", "made-up-state")
}

func TestCliVerdictMissingIDOrToIsUsageError(t *testing.T) {
	fake := cliStart(t, cliVerdictRoutes(`{"id":"REQ-1"}`))
	missingIDCode, _, missingIDErr := cliRun(t, "verdict", "--to", "in-progress", "--api", fake.url())
	missingToCode, _, missingToErr := cliRun(t, "verdict", "--id", "REQ-1", "--api", fake.url())

	cliWantCode(t, missingIDCode, 2)
	cliWantContains(t, missingIDErr, "--id", "缺 --id 的 stderr")
	cliWantCode(t, missingToCode, 2)
	cliWantContains(t, missingToErr, "--to", "缺 --to 的 stderr")
	fake.count(t, 0)
}

// ---- verdict --guard：守卫证据原样进 body.guards ----

func cliDoneRoutes() map[string]cliRoute {
	return cliVerdictRoutes(`{"id":"REQ-40","from":"in-progress","to":"done","by":"ci"}`)
}

func TestCliVerdictGuardEvidenceKeepsEquals(t *testing.T) {
	fake := cliStart(t, cliDoneRoutes())
	const evidence = "merge-gate PASS 4/4 PR #40 (k=v)"
	code, _, _ := cliRun(t, "verdict", "--id", "REQ-40", "--to", "done", "--role", "ci",
		"--guard", "merge-gate="+evidence, "--api", fake.url())
	body := cliBody(t, fake.only(t))

	cliWantCode(t, code, 0)
	cliWantField(t, body, "id", "REQ-40")
	cliWantField(t, body, "to", "done")
	cliWantField(t, body, "actor_role", "ci")
	cliWantField(t, body, "comment", "")
	guards := body.Get("guards")
	if guards == nil || guards.EntryCount() != 1 {
		t.Fatalf("guards 应当恰好一个键；实际: %s", body.Encode())
	}
	cliWantField(t, guards, "merge-gate", evidence)
}

func TestCliVerdictGuardRepeatable(t *testing.T) {
	fake := cliStart(t, cliDoneRoutes())
	code, _, _ := cliRun(t, "verdict", "--id", "REQ-40", "--to", "done", "--role", "ci",
		"--guard", "merge-gate=PASS", "--guard", "audit-contract=24/24", "--api", fake.url())
	body := cliBody(t, fake.only(t))

	cliWantCode(t, code, 0)
	guards := body.Get("guards")
	if guards == nil || guards.EntryCount() != 2 {
		t.Fatalf("guards 应当恰好两个键；实际: %s", body.Encode())
	}
	cliWantField(t, guards, "merge-gate", "PASS")
	cliWantField(t, guards, "audit-contract", "24/24")
}

func TestCliVerdictGuardWithoutEqualsIsUsageError(t *testing.T) {
	fake := cliStart(t, cliDoneRoutes())
	code, _, stderr := cliRun(t, "verdict", "--id", "REQ-40", "--to", "done",
		"--guard", "merge-gate", "--api", fake.url())

	cliWantCode(t, code, 2)
	cliWantContains(t, stderr, "name=evidence", "--guard 形状错误的 stderr")
	fake.count(t, 0)
}

func TestCliVerdictGuardEmptyNameIsUsageError(t *testing.T) {
	fake := cliStart(t, cliDoneRoutes())
	code, _, stderr := cliRun(t, "verdict", "--id", "REQ-40", "--to", "done",
		"--guard", "=PASS", "--api", fake.url())

	cliWantCode(t, code, 2)
	cliWantContains(t, stderr, "name 不能为空", "--guard 空 name 的 stderr")
	fake.count(t, 0)
}

func TestCliVerdictWithoutGuardOmitsField(t *testing.T) {
	fake := cliStart(t, cliDoneRoutes())
	code, stdout, _ := cliRun(t, "verdict", "--id", "REQ-40", "--to", "done", "--api", fake.url())
	body := cliBody(t, fake.only(t))

	cliWantCode(t, code, 0)
	if body.Has("guards") {
		t.Fatalf("没给 --guard 时不该带 guards 字段；实际: %s", body.Encode())
	}
	cliWantAbsent(t, stdout, "guards", "verdict 的 stdout")
}

// ---- verify：exitCode 与输出尾部 ----

func cliVerifyPayload(exitCode string, output string) string {
	return "{\"exitCode\":" + exitCode + ",\"output\":" + String(output).EncodeString() + "}"
}

func TestCliVerifyJSONFullOutputHumanTail20Lines(t *testing.T) {
	lines := make([]string, 0, 30)
	for index := 1; index <= 30; index++ {
		lines = append(lines, "line-"+strconv.Itoa(index))
	}
	output := strings.Join(lines, "\n")
	payload := cliVerifyPayload("0", output)
	fake := cliStart(t, map[string]cliRoute{
		"/api/verify": func(cliSeen) (int, string) { return 200, payload },
	})

	machineCode, machineOut, _ := cliRun(t, "verify", "--json", "--api", fake.url())
	cliWantCode(t, machineCode, 0)
	cliWantContains(t, machineOut, "line-1", "verify --json 的 stdout")
	cliWantSameJSON(t, machineOut, payload, "verify --json 的 stdout")
	seen := fake.only(t)
	if seen.method != "POST" || seen.path != "/api/verify" {
		t.Fatalf("请求形状不符：method=%q path=%q", seen.method, seen.path)
	}

	humanCode, humanOut, _ := cliRun(t, "verify", "--api", fake.url())
	cliWantCode(t, humanCode, 0)
	cliWantContains(t, humanOut, "exitCode: 0", "verify 人读模式")
	cliWantContains(t, humanOut, "line-30", "verify 人读模式")
	cliWantContains(t, humanOut, "line-11", "verify 人读模式")
	cliWantAbsent(t, humanOut, "line-10\n", "verify 人读模式的尾部截断")
	if got := len(strings.Split(strings.TrimRight(humanOut, "\n"), "\n")); got != 22 {
		t.Fatalf("人读输出行数 = %d，期望 2 + 20", got)
	}
}

func TestCliVerifyRedExits4AndStillPrintsOutput(t *testing.T) {
	payload := cliVerifyPayload("1", "FAIL tests/x.test.mjs")
	fake := cliStart(t, map[string]cliRoute{
		"/api/verify": func(cliSeen) (int, string) { return 200, payload },
	})

	machineCode, machineOut, _ := cliRun(t, "verify", "--json", "--api", fake.url())
	// 4 是「真的判了、真的没过」：既不是 1（后端拒绝流转），也不是 3（拿不到结论）。
	cliWantCode(t, machineCode, 4)
	cliWantSameJSON(t, machineOut, payload, "verify --json 的 stdout")

	humanCode, humanOut, _ := cliRun(t, "verify", "--api", fake.url())
	cliWantCode(t, humanCode, 4)
	cliWantContains(t, humanOut, "exitCode: 1", "判红的 verify")
	cliWantContains(t, humanOut, "FAIL tests/x.test.mjs", "判红的 verify")
}

func TestCliVerifyUntrustworthyExit3(t *testing.T) {
	nulled := cliStart(t, map[string]cliRoute{
		"/api/verify": func(cliSeen) (int, string) { return 200, cliVerifyPayload("null", "") },
	})
	timedOutCode, timedOutOut, _ := cliRun(t, "verify", "--api", nulled.url())
	// 超时/被杀 = 不知道过没过；算成 4 会让「没过」与「没跑完」混成一档。
	cliWantCode(t, timedOutCode, 3)
	cliWantContains(t, timedOutOut, "不可信", "exitCode 为 null 的 verify")

	missing := cliStart(t, map[string]cliRoute{
		"/api/verify": func(cliSeen) (int, string) { return 200, `{"output":"oops"}` },
	})
	noFieldCode, _, _ := cliRun(t, "verify", "--api", missing.url())
	cliWantCode(t, noFieldCode, 3)
}

// ---- outbox：在途台账原样呈现 ----

func TestCliOutboxJSONAndHuman(t *testing.T) {
	const payload = `{"entries":[{"attemptId":"att-1","item":"REQ-1","from":"accepted","to":"in-progress","status":"pending","attempts":2}],"deadline":"10m0s","writeEnabled":false,"nextCheckAt":"2026-10-26T10:30:00Z"}`
	fake := cliStart(t, map[string]cliRoute{
		"/api/outbox": func(cliSeen) (int, string) { return 200, payload },
	})

	machineCode, machineOut, _ := cliRun(t, "outbox", "--json", "--api", fake.url())
	cliWantCode(t, machineCode, 0)
	cliWantSameJSON(t, machineOut, payload, "outbox --json 的 stdout")

	humanCode, humanOut, _ := cliRun(t, "outbox", "--api", fake.url())
	cliWantCode(t, humanCode, 0)
	for _, needle := range []string{"att-1", "pending", "ATTEMPTS", "2026-10-26T10:30:00Z"} {
		cliWantContains(t, humanOut, needle, "outbox 人读模式")
	}
}

// ---- 退出码约定：rejected=1 / infra=3 / 用法=2 ----

func TestCliRejected409Exits1WithEmptyStdout(t *testing.T) {
	fake := cliStartStatus(t, 409,
		`{"kind":"rejected","code":"E_TRANSITION_UNDECLARED","message":"accepted → done 不是声明里的转换","extra":{}}`)

	code, stdout, stderr := cliRun(t, "verdict", "--id", "REQ-1", "--to", "done", "--api", fake.url())

	cliWantCode(t, code, 1)
	if stdout != "" {
		t.Fatalf("stdout 应当为空；实际: %q", stdout)
	}
	cliWantContains(t, stderr, "accepted → done 不是声明里的转换", "rejected 的 stderr")
}

func TestCliInfra500Exits3(t *testing.T) {
	fake := cliStartStatus(t, 500,
		`{"kind":"infra","code":"E_NODE_OUTPUT","message":"账本折叠失败","extra":{}}`)

	code, _, stderr := cliRun(t, "board", "--api", fake.url())

	cliWantCode(t, code, 3)
	cliWantContains(t, stderr, "账本折叠失败", "infra 的 stderr")
}

func TestCliNonJSON502Exits3(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("content-type", "text/plain")
		w.WriteHeader(502)
		_, _ = w.Write([]byte("bad gateway"))
	}))
	t.Cleanup(server.Close)

	code, _, stderr := cliRun(t, "board", "--api", server.URL)

	cliWantCode(t, code, 3)
	cliWantContains(t, stderr, "502", "非 JSON 502 的 stderr")
}

func TestCliUnreachablePortExits3OneLine(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("占端口失败: %v", err)
	}
	port := listener.Addr().(*net.TCPAddr).Port
	if closeErr := listener.Close(); closeErr != nil {
		t.Fatalf("放端口失败: %v", closeErr)
	}

	code, stdout, stderr := cliRun(t, "board", "--api", "http://127.0.0.1:"+strconv.Itoa(port))

	cliWantCode(t, code, 3)
	if stdout != "" {
		t.Fatalf("stdout 应当为空；实际: %q", stdout)
	}
	cliWantContains(t, stderr, "连不上后端", "端口不通的 stderr")
	cliWantAbsent(t, stderr, "goroutine", "端口不通的 stderr 不该带栈")
	// 「只报一行原因」：除首行外不许再有缩进的栈帧。
	for _, line := range strings.Split(strings.TrimRight(stderr, "\n"), "\n") {
		if strings.HasPrefix(line, " ") || strings.HasPrefix(line, "\t") {
			t.Fatalf("stderr 出现栈帧行: %q", line)
		}
	}
}

func TestCliUnknownCommandUsageExit2(t *testing.T) {
	code, _, stderr := cliRun(t, "nope")

	cliWantCode(t, code, 2)
	cliWantContains(t, stderr, "未知命令: nope", "未知子命令的 stderr")
	cliWantContains(t, stderr, "用法: cli", "未知子命令要打印用法")
}

func TestCliUnknownOptionExit2(t *testing.T) {
	code, _, stderr := cliRun(t, "board", "--nope")

	cliWantCode(t, code, 2)
	cliWantContains(t, stderr, "--nope", "未知选项的 stderr")
}

func TestCliHelpExit0(t *testing.T) {
	code, stdout, _ := cliRun(t, "--help")

	cliWantCode(t, code, 0)
	cliWantContains(t, stdout, "用法: cli", "--help 的 stdout")
	cliWantContains(t, stdout, "退出码", "--help 的 stdout")
}

// ---- 不写状态：CLI 自己绝不落盘 ----

func TestCliRunsEveryCommandWithoutTouchingLedger(t *testing.T) {
	dir := t.TempDir()
	ledger := filepath.Join(dir, "ledger.jsonl")
	before := "{\"id\":\"REQ-1\",\"at\":\"2026-10-20T06:50:33.716Z\",\"from\":\"none\",\"to\":\"accepted\",\"by\":\"platform\",\"comment\":\"新需求受理\"}\n"
	if err := os.WriteFile(ledger, []byte(before), 0o644); err != nil {
		t.Fatalf("写账本失败: %v", err)
	}
	t.Setenv("PLATFORM_LEDGER", ledger)

	fake := cliStart(t, map[string]cliRoute{
		"/api/board": func(cliSeen) (int, string) { return 200, cliBoardFixture },
		"/api/item":  func(cliSeen) (int, string) { return 200, `{"id":"REQ-9","from":"none","to":"accepted"}` },
		"/api/verdict": func(cliSeen) (int, string) {
			return 200, `{"id":"REQ-9","from":"accepted","to":"in-progress","by":"ci"}`
		},
		"/api/verify": func(cliSeen) (int, string) { return 200, cliVerifyPayload("0", "ok") },
		"/api/outbox": func(cliSeen) (int, string) {
			return 200, `{"entries":[],"deadline":"10m0s","writeEnabled":false,"nextCheckAt":null}`
		},
	})

	runs := [][]string{
		{"board", "--json", "--api", fake.url()},
		{"new", "写入测试", "--api", fake.url()},
		{"verdict", "--id", "REQ-9", "--to", "in-progress", "--role", "ci", "--api", fake.url()},
		{"verify", "--json", "--api", fake.url()},
		{"outbox", "--json", "--api", fake.url()},
	}
	for _, argv := range runs {
		code, _, stderr := cliRun(t, argv...)
		if code != 0 {
			t.Fatalf("%v 退出码 = %d，期望 0；stderr: %s", argv, code, stderr)
		}
	}
	fake.count(t, 5)

	after, err := os.ReadFile(ledger)
	if err != nil {
		t.Fatalf("读账本失败: %v", err)
	}
	if string(after) != before {
		t.Fatalf("账本被改写了；实际: %q", string(after))
	}
}

// TestCliSourceHasNoLedgerImportOrFileWrites 钉住「接入层不碰状态」的实现细节。
// Node 侧的等价物是读 scripts/cli.mjs 源码做断言；参照物删除后，钉的对象换成它的
// Go 实现本体（同一手法见 tests/kb-allowlist-parity.test.mjs 读 Go 源码）。
func TestCliSourceHasNoLedgerImportOrFileWrites(t *testing.T) {
	raw, err := os.ReadFile("cli_tool.go")
	if err != nil {
		t.Fatalf("读 cli_tool.go 失败: %v", err)
	}
	source := string(raw)

	// 账本路径也不该出现：读了就会有人开始「顺手推断状态」。
	for _, forbidden := range []string{
		"RunLedger", "ledger.jsonl", "Ledger{",
		"os.WriteFile", "os.Create", "os.OpenFile", "os.MkdirAll",
		"os.Remove", "os.Rename", "os.Chmod", "os.Truncate",
	} {
		if strings.Contains(source, forbidden) {
			t.Fatalf("cli_tool.go 不该含 %q —— 接入层只发命令、不落盘", forbidden)
		}
	}
}
