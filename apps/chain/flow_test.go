package main

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

// 测试里的「人」是一个账号加一个带 cookie jar 的 http.Client：登录一次，之后
// 请求自动带 chain_session。服务端只认 whoIs 这一处解析，所以辅助函数也不再传口令，
// 而是传「谁」——口令那套身份已经不存在了。
//
// 为了不让每个用例都改成层层传客户端，按「服务地址 + 用户名」登记，call/callAs 用用户名取。

// rootUser 是每个测试服务里第一个注册的账号：空库第一个注册的人自动是管理员。
const rootUser = "root"
const rootPass = "root-password-1"

var sessions sync.Map // "服务地址|用户名" -> *http.Client

func remember(ts *httptest.Server, username string, cl *http.Client) {
	sessions.Store(ts.URL+"|"+username, cl)
}

func clientOf(t *testing.T, ts *httptest.Server, username string) *http.Client {
	t.Helper()
	v, ok := sessions.Load(ts.URL + "|" + username)
	if !ok {
		t.Fatalf("这个测试里没有人以 %q 登录过", username)
	}
	return v.(*http.Client)
}

func freshClient(t *testing.T) *http.Client {
	t.Helper()
	jar, err := cookiejar.New(nil)
	if err != nil {
		t.Fatal(err)
	}
	return &http.Client{Jar: jar}
}

// exchange 发一次请求，返回状态码与响应体。cl 为 nil 表示匿名。
func exchange(t *testing.T, ts *httptest.Server, cl *http.Client, method, path string, body any) (int, []byte) {
	t.Helper()
	var buf bytes.Buffer
	if body != nil {
		if err := json.NewEncoder(&buf).Encode(body); err != nil {
			t.Fatal(err)
		}
	}
	req, err := http.NewRequest(method, ts.URL+path, &buf)
	if err != nil {
		t.Fatal(err)
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	client := cl
	if client == nil {
		client = http.DefaultClient
	}
	res, err := client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	raw, err := io.ReadAll(res.Body)
	if err != nil {
		t.Fatal(err)
	}
	return res.StatusCode, raw
}

// signupRoot 在空库里注册第一个账号（自动是管理员），并把它的客户端登记下来。
func signupRoot(t *testing.T, ts *httptest.Server) *http.Client {
	t.Helper()
	cl := freshClient(t)
	code, raw := exchange(t, ts, cl, "POST", "/api/signup", map[string]any{"username": rootUser, "password": rootPass})
	if code != 201 {
		t.Fatalf("注册第一个账号期望 201，实际 %d：%s", code, raw)
	}
	// 注册即进站：signup 自己就下发会话，不必再登录一次（t42）。
	if ck := sessionCookie(t, cl, ts); ck.Value == "" {
		t.Fatalf("注册之后客户端应当已经有 %s", sessionCookieName)
	}
	remember(ts, rootUser, cl)
	return cl
}

// loginAs 用账号密码登录，返回带着新会话的客户端并登记。
func loginAs(t *testing.T, ts *httptest.Server, username, password string) *http.Client {
	t.Helper()
	cl := freshClient(t)
	code, raw := exchange(t, ts, cl, "POST", "/api/login", map[string]any{"username": username, "password": password})
	if code != 200 {
		t.Fatalf("登录 %s 期望 200，实际 %d：%s", username, code, raw)
	}
	remember(ts, username, cl)
	return cl
}

// addUser 让管理员建一个普通账号并登录，返回它的客户端。
func addUser(t *testing.T, ts *httptest.Server, username, password string) *http.Client {
	t.Helper()
	code, raw := exchange(t, ts, clientOf(t, ts, rootUser), "POST", "/api/users",
		map[string]any{"username": username, "password": password})
	if code != 201 {
		t.Fatalf("建账号 %s 期望 201，实际 %d：%s", username, code, raw)
	}
	return loginAs(t, ts, username, password)
}

// grantRole 让管理员建一个角色，并把 username 放进这个角色（username 为空只建角色）。
func grantRole(t *testing.T, ts *httptest.Server, project, roleName, username string, powers ...string) Role {
	t.Helper()
	admin := clientOf(t, ts, rootUser)
	code, raw := exchange(t, ts, admin, "POST", "/api/p/"+project+"/roles",
		map[string]any{"name": roleName, "powers": powers})
	if code != 201 {
		t.Fatalf("建角色 %s 期望 201，实际 %d：%s", roleName, code, raw)
	}
	var role Role
	if err := json.Unmarshal(raw, &role); err != nil {
		t.Fatal(err)
	}
	if username != "" {
		code, raw = exchange(t, ts, admin, "POST", "/api/p/"+project+"/roles/"+role.ID+"/members",
			map[string]any{"username": username})
		if code != 201 {
			t.Fatalf("把 %s 放进角色期望 201，实际 %d：%s", username, code, raw)
		}
	}
	return role
}

func newTestServer(t *testing.T) (*httptest.Server, Store, string) {
	t.Helper()
	path := filepath.Join(t.TempDir(), "chain.db")
	store, err := OpenStore("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { store.Close() })
	ts := httptest.NewServer(NewServer(store, FakeExecutor{}).Handler())
	t.Cleanup(ts.Close)
	signupRoot(t, ts)
	return ts, store, path
}

// call 以管理员身份发一次请求：管理员等同四权齐全，节点闸门一律放行。
func call(t *testing.T, ts *httptest.Server, method, path string, body any, want int) *Requirement {
	t.Helper()
	return callAs(t, ts, method, path, rootUser, body, want)
}

// callAnon 是不登录的请求：用来钉「/api/** 除注册登录外一律 401」。
func callAnon(t *testing.T, ts *httptest.Server, method, path string, body any, want int) *Requirement {
	t.Helper()
	return callAs(t, ts, method, path, "", body, want)
}

// callAs 以指定账号（空 = 匿名）发请求，断言状态码并把响应体解成需求。
func callAs(t *testing.T, ts *httptest.Server, method, path, who string, body any, want int) *Requirement {
	t.Helper()
	var cl *http.Client
	if who != "" {
		cl = clientOf(t, ts, who)
	}
	code, raw := exchange(t, ts, cl, method, path, body)
	if code != want {
		t.Fatalf("%s %s 期望 %d，实际 %d：%s", method, path, want, code, raw)
	}
	if code >= 400 {
		return nil
	}
	var r Requirement
	if err := json.Unmarshal(raw, &r); err != nil {
		return nil
	}
	return &r
}

func setupProject(t *testing.T, ts *httptest.Server) {
	t.Helper()
	call(t, ts, "POST", "/api/projects", map[string]any{"key": "demo", "repo": "o/r"}, 201)
}

func newNodeReq(t *testing.T, ts *httptest.Server, node, action string, body any, want int) *Requirement {
	t.Helper()
	reqs := listReqs(t, ts)
	return call(t, ts, "POST", "/api/requirements/"+reqs[0].ID+"/nodes/"+node+"/"+action, body, want)
}

func listReqs(t *testing.T, ts *httptest.Server) []Requirement {
	t.Helper()
	code, raw := exchange(t, ts, clientOf(t, ts, rootUser), "GET", "/api/requirements", nil)
	if code != 200 {
		t.Fatalf("列需求期望 200，实际 %d：%s", code, raw)
	}
	var out []Requirement
	if err := json.Unmarshal(raw, &out); err != nil {
		t.Fatal(err)
	}
	return out
}

func TestFlowHappyPath(t *testing.T) {
	ts, _, _ := newTestServer(t)
	setupProject(t, ts)
	req := call(t, ts, "POST", "/api/p/demo/requirements", map[string]any{"context": "加一个导出按钮"}, 201)
	if !strings.HasPrefix(req.Branch, "req/demo/REQ-") {
		t.Fatalf("进链即建分支，实际 %s", req.Branch)
	}

	if got := newNodeReq(t, ts, "assess", "run", map[string]any{}, 200); got.Node("assess").State != StateAwaitingReview {
		t.Fatalf("容器节点跑完应待审，实际 %s", got.Node("assess").State)
	}
	got := newNodeReq(t, ts, "assess", "accept", map[string]any{"comment": "评估可接受"}, 200)
	if got.Node("assess").State != StateAccepted || got.CurrentIndex() != 1 {
		t.Fatalf("通过后应前进到开发站，实际 %s/%d", got.Node("assess").State, got.CurrentIndex())
	}

	if got = newNodeReq(t, ts, "dev", "run", map[string]any{}, 200); got.Node("dev").State != StateRunning {
		t.Fatalf("空节点开始动手后应 running，实际 %s", got.Node("dev").State)
	}
	if got = newNodeReq(t, ts, "dev", "accept", map[string]any{}, 200); got.CurrentIndex() != 2 {
		t.Fatalf("开发通过后应到上线站，实际 %d", got.CurrentIndex())
	}

	if got = newNodeReq(t, ts, "release", "run", map[string]any{}, 200); got.Node("release").State != StateAwaitingReview {
		t.Fatalf("上线容器跑完应待审，实际 %s", got.Node("release").State)
	}
	got = newNodeReq(t, ts, "release", "accept", map[string]any{}, 200)
	if got.State != ReqDone {
		t.Fatalf("最后一站通过后需求应 done，实际 %s", got.State)
	}
	if len(got.Nodes[0].Comments) == 0 || got.Nodes[0].Comments[0].AuthorType != "container" {
		t.Fatal("容器产出应当落成节点评论")
	}
}

func TestFlowRejectAtFirstNodeRejectsRequirement(t *testing.T) {
	ts, _, _ := newTestServer(t)
	setupProject(t, ts)
	call(t, ts, "POST", "/api/p/demo/requirements", map[string]any{"context": "随手一问"}, 201)
	newNodeReq(t, ts, "assess", "run", map[string]any{}, 200)
	got := newNodeReq(t, ts, "assess", "reject", map[string]any{"reason": "这不是需求"}, 200)
	if got.State != ReqRejected {
		t.Fatalf("首站被拒应拒掉整条需求，实际 %s", got.State)
	}
	var human *Comment
	for i := range got.Node("assess").Comments {
		if c := got.Node("assess").Comments[i]; c.AuthorType == "user" {
			human = &c
		}
	}
	if human == nil || human.Verdict != "reject" || human.Body != "这不是需求" {
		t.Fatalf("拒绝理由应落成按账号记的 reject 评论，实际 %+v", human)
	}
	last := got.Node("assess").Comments[len(got.Node("assess").Comments)-1]
	if last.AuthorType != "system" {
		t.Fatalf("整条需求被拒应留一条平台留言在最后，实际 %+v", last)
	}
}

func TestFlowRejectRollsBackToPreviousNode(t *testing.T) {
	ts, _, _ := newTestServer(t)
	setupProject(t, ts)
	call(t, ts, "POST", "/api/p/demo/requirements", map[string]any{"context": "改一下导出格式"}, 201)
	for _, n := range []string{"assess", "dev"} {
		newNodeReq(t, ts, n, "run", map[string]any{}, 200)
		newNodeReq(t, ts, n, "accept", map[string]any{}, 200)
	}
	newNodeReq(t, ts, "release", "run", map[string]any{}, 200)
	got := newNodeReq(t, ts, "release", "reject", map[string]any{"reason": "上线脚本会删数据"}, 200)
	if got.Node("release").State != StateRejected || got.State != ReqActive {
		t.Fatalf("被拒站应 rejected 而需求仍在进行中，实际 %s/%s", got.Node("release").State, got.State)
	}
	if got.Node("dev").State != StateRunning {
		t.Fatalf("上一站应回到 running，实际 %s", got.Node("dev").State)
	}
	if got.CurrentIndex() != 1 {
		t.Fatalf("位置应回到开发站，实际 %d", got.CurrentIndex())
	}
	if len(got.Node("release").Comments) != 2 {
		t.Fatal("回滚不删历史：容器评论 + 拒绝理由都该在")
	}
}

func TestFlowRejectsBadInput(t *testing.T) {
	ts, _, _ := newTestServer(t)
	setupProject(t, ts)
	call(t, ts, "POST", "/api/projects", map[string]any{"key": "demo"}, 409)
	call(t, ts, "POST", "/api/p/nope/requirements", map[string]any{"context": "x"}, 404)
	call(t, ts, "POST", "/api/p/demo/requirements", map[string]any{"context": "  "}, 400)
	call(t, ts, "POST", "/api/p/demo/requirements", map[string]any{"content": "打字错了"}, 400)
	call(t, ts, "POST", "/api/p/demo/requirements", map[string]any{"context": "x"}, 201)

	newNodeReq(t, ts, "assess", "accept", map[string]any{}, 409)
	newNodeReq(t, ts, "dev", "run", map[string]any{}, 409)
	newNodeReq(t, ts, "release", "reject", map[string]any{}, 409)
	req := listReqs(t, ts)[0]
	call(t, ts, "POST", "/api/requirements/"+req.ID+"/nodes/nope/run", map[string]any{}, 404)
	call(t, ts, "POST", "/api/requirements/NOPE/nodes/assess/run", map[string]any{}, 404)
}

func TestFlowSurvivesRestart(t *testing.T) {
	ts, _, path := newTestServer(t)
	setupProject(t, ts)
	call(t, ts, "POST", "/api/p/demo/requirements", map[string]any{"context": "重启后还在吗"}, 201)
	newNodeReq(t, ts, "assess", "run", map[string]any{}, 200)
	ts.Close()

	reopened, err := OpenStore("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	ps, err := reopened.Projects()
	if err != nil || len(ps) != 1 || ps[0].Key != "demo" {
		t.Fatalf("project 应当从磁盘读回来：%v %+v", err, ps)
	}
	reqs, err := reopened.Requirements()
	if err != nil || len(reqs) != 1 {
		t.Fatalf("需求应当从磁盘读回来：%v %+v", err, reqs)
	}
	if reqs[0].Node("assess").State != StateAwaitingReview {
		t.Fatalf("节点状态应当持久化，实际 %s", reqs[0].Node("assess").State)
	}
	events, err := reopened.Events(reqs[0].ID)
	if err != nil || len(events) < 3 {
		t.Fatalf("事件流应当只追加地留着：%v %d", err, len(events))
	}
}
