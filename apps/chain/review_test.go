package main

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// chainOf 造一条只关心「谁审」的链条：头 assess、尾 release，中间随便加。
func chainOf(nodes ...ChainNode) Chain {
	return Chain{Key: "feature", Type: "feature", Version: 1, Nodes: nodes}
}

func cn(key, typ, review string) ChainNode {
	return ChainNode{Key: key, Type: typ, Review: review}
}

// newReviewServer 起一个用指定链条与执行器的服务，省掉「先建 project」那一步。
func newReviewServer(t *testing.T, c Chain, exec Executor) (*httptest.Server, Store) {
	t.Helper()
	// 同 newTestServer：把家目录隔离掉，别往真家目录写自定义 AGENTS.md。
	t.Setenv("HOME", t.TempDir())
	store, err := OpenStore("sqlite", filepath.Join(t.TempDir(), "chain.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { store.Close() })
	ts := httptest.NewServer(NewServer(store, exec).Handler())
	t.Cleanup(ts.Close)
	p := Project{
		Key: "demo", Name: "Demo", Repo: "o/r", DefaultBranch: "main",
		Chains: []Chain{c}, CreatedAt: time.Now(),
	}
	if err := store.SaveProject(&p); err != nil {
		t.Fatal(err)
	}
	seedRoot(t, ts, store)
	return ts, store
}

func submit(t *testing.T, ts *httptest.Server, context string) *Requirement {
	t.Helper()
	return call(t, ts, "POST", "/api/p/demo/requirements", map[string]any{"context": context}, 201)
}

// submitWithReporter 造一条「外面提的」需求：回告地址只在库里，内部接口不暴露它。
func submitWithReporter(t *testing.T, ts *httptest.Server, store Store, context, callback string) *Requirement {
	t.Helper()
	req := submit(t, ts, context)
	saved, err := store.Requirement(req.ID)
	if err != nil {
		t.Fatal(err)
	}
	saved.Reporter = &Reporter{Kind: "webhook", Ref: "ticket-1", CallbackURL: callback}
	if err := store.SaveRequirement(saved); err != nil {
		t.Fatal(err)
	}
	return saved
}

func nodeOf(t *testing.T, r *Requirement, key string) *Node {
	t.Helper()
	n := r.Node(key)
	if n == nil {
		t.Fatalf("没有节点 %s", key)
	}
	return n
}

func lastComment(n *Node) Comment {
	if len(n.Comments) == 0 {
		return Comment{}
	}
	return n.Comments[len(n.Comments)-1]
}

func TestReviewAutoAcceptsOnPass(t *testing.T) {
	ts, _ := newReviewServer(t, chainOf(cn("assess", TypeAssess, ReviewAI), cn("release", TypeRelease, ReviewHuman)), FakeExecutor{})
	req := submit(t, ts, "加一个导出按钮")
	got := call(t, ts, "POST", "/api/requirements/"+req.ID+"/nodes/assess/run", map[string]any{}, 200)

	n := nodeOf(t, got, "assess")
	if n.State != StateAccepted {
		t.Fatalf("AI 自审通过后本节点应当定案，实际 %s", n.State)
	}
	if got.CurrentIndex() != 1 {
		t.Fatalf("位置应当前移到第 2 站，实际第 %d 站", got.CurrentIndex()+1)
	}
	if got.Node("assess").Attempts[0].Verdict != VerdictPass {
		t.Fatalf("执行记录上应当记下 pass，实际 %q", got.Node("assess").Attempts[0].Verdict)
	}
	c := lastComment(n)
	if c.AuthorType != "container" || c.Verdict != "approve" {
		t.Fatalf("定案应当留下一条容器的通过评论，实际 %+v", c)
	}
	// 下一站是人审：容器说了不算，节点必须停在待审。
	if got.Node("release").State != StatePending {
		t.Fatalf("第 2 站应当还是 pending，实际 %s", got.Node("release").State)
	}
}

func TestReviewRejectsAndRollsBackToPreviousNode(t *testing.T) {
	c := chainOf(
		cn("assess", TypeAssess, ReviewHuman),
		cn("tests", TypeCrossTest, ReviewAI),
		cn("release", TypeRelease, ReviewHuman),
	)
	ts, _ := newReviewServer(t, c, FakeExecutor{AIVerdict: VerdictReject, AIReason: "回归用例 3 个没过"})
	req := submit(t, ts, "改登录逻辑")
	call(t, ts, "POST", "/api/requirements/"+req.ID+"/nodes/assess/run", map[string]any{}, 200)
	call(t, ts, "POST", "/api/requirements/"+req.ID+"/nodes/assess/accept", map[string]any{"comment": "评估通过"}, 200)

	got := call(t, ts, "POST", "/api/requirements/"+req.ID+"/nodes/tests/run", map[string]any{}, 200)
	if got.Node("tests").State != StateRejected {
		t.Fatalf("AI 自审不通过时本节点应当 rejected，实际 %s", got.Node("tests").State)
	}
	if got.Node("assess").State != StateRunning {
		t.Fatalf("驳回应当把上一站拉回 running，实际 %s", got.Node("assess").State)
	}
	if got.State != ReqActive {
		t.Fatalf("中间站被拒不该拒掉整条需求，实际 %s", got.State)
	}
	if c := lastComment(got.Node("tests")); c.AuthorType != "container" || c.Verdict != "reject" || !strings.Contains(c.Body, "回归用例") {
		t.Fatalf("驳回理由应当以容器的身份留在评论里，实际 %+v", c)
	}
}

func TestReviewRejectOnFirstNodeRejectsWholeRequirement(t *testing.T) {
	var called bool
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		called = true
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		if body["state"] != ReqRejected {
			t.Errorf("回告里的 state 应当是 rejected，实际 %v", body["state"])
		}
		if body["node"] != "assess" {
			t.Errorf("回告里应当点名被拒的那一站，实际 %v", body["node"])
		}
		w.WriteHeader(204)
	}))
	defer srv.Close()

	ts, store := newReviewServer(t, chainOf(cn("assess", TypeAssess, ReviewAI), cn("release", TypeRelease, ReviewHuman)),
		FakeExecutor{AIVerdict: VerdictReject, AIReason: "这不像一条可做的需求"})
	req := submitWithReporter(t, ts, store, "随便写点啥", srv.URL)

	got := call(t, ts, "POST", "/api/requirements/"+req.ID+"/nodes/assess/run", map[string]any{}, 200)
	if got.State != ReqRejected {
		t.Fatalf("首站被 AI 自审拒掉时整条需求应当 rejected，实际 %s", got.State)
	}
	if !called {
		t.Fatal("整条需求被拒时应当回告提需求人，实际没有发出请求")
	}
	n := got.Node("assess")
	if last := lastComment(n); last.AuthorType != "system" || !strings.Contains(last.Body, "整条需求被拒") {
		t.Fatalf("平台应当留一条系统留言，实际 %+v", last)
	}
}

func TestReviewWithoutVerdictFallsBackToHuman(t *testing.T) {
	ts, _ := newReviewServer(t, chainOf(cn("assess", TypeAssess, ReviewAI), cn("release", TypeRelease, ReviewHuman)),
		FakeExecutor{AIVerdict: VerdictUnknown})
	req := submit(t, ts, "加个按钮")
	got := call(t, ts, "POST", "/api/requirements/"+req.ID+"/nodes/assess/run", map[string]any{}, 200)

	if got.Node("assess").State != StateAwaitingReview {
		t.Fatalf("容器没给结论时应当停在待审，实际 %s", got.Node("assess").State)
	}
	if got.State != ReqActive {
		t.Fatalf("判不出来不该把需求推进或拒掉，实际 %s", got.State)
	}
	if last := lastComment(got.Node("assess")); last.AuthorType != "system" || !strings.Contains(last.Body, "没有给出自审结论") {
		t.Fatalf("应当留下「判不出来」的系统留言，实际 %+v", last)
	}
}

func TestReviewRejectWithoutReasonFallsBackToHuman(t *testing.T) {
	ts, _ := newReviewServer(t, chainOf(cn("assess", TypeAssess, ReviewAI), cn("release", TypeRelease, ReviewHuman)),
		FakeExecutor{AIVerdict: VerdictReject})
	req := submit(t, ts, "加个按钮")
	got := call(t, ts, "POST", "/api/requirements/"+req.ID+"/nodes/assess/run", map[string]any{}, 200)

	if got.Node("assess").State != StateAwaitingReview {
		t.Fatalf("没给理由的驳回没法回滚，应当停在待审，实际 %s", got.Node("assess").State)
	}
	if last := lastComment(got.Node("assess")); last.AuthorType != "system" || !strings.Contains(last.Body, "没给理由") {
		t.Fatalf("应当说明为什么判不了，实际 %+v", last)
	}
}

// alwaysVerdict 是不听话的容器：不管节点声明谁审，它都自称通过。
type alwaysVerdict struct{ verdict string }

// TemplateKeys：这个替身只关心结论，模板键跟假执行器一致即可。
func (a alwaysVerdict) TemplateKeys() []string { return fakeTemplateKeys() }

func (a alwaysVerdict) Run(r *Requirement, n *Node, now time.Time) (Attempt, Comment, []string) {
	att, c, arts := FakeExecutor{}.Run(r, n, now)
	att.Verdict = a.verdict
	return att, c, arts
}

func TestReviewHumanNodeIgnoresContainerVerdict(t *testing.T) {
	ts, _ := newReviewServer(t, chainOf(cn("assess", TypeAssess, ReviewHuman), cn("release", TypeRelease, ReviewHuman)),
		alwaysVerdict{verdict: VerdictPass})
	req := submit(t, ts, "加个按钮")
	got := call(t, ts, "POST", "/api/requirements/"+req.ID+"/nodes/assess/run", map[string]any{}, 200)

	if got.Node("assess").State != StateAwaitingReview {
		t.Fatalf("人审节点容器说了不算，应当停在待审，实际 %s", got.Node("assess").State)
	}
	if v := got.Node("assess").Attempts[0].Verdict; v != "" {
		t.Fatalf("人审节点不该记自审结论，实际 %q", v)
	}
}

func TestValidateChainRejectsAIOnEmptyNode(t *testing.T) {
	c := chainOf(cn("assess", TypeAssess, ReviewHuman), cn("dev", TypeDev, ReviewAI), cn("release", TypeRelease, ReviewHuman))
	err := ValidateChain(c)
	if err == nil {
		t.Fatal("空节点声明 AI 审核应当被链条校验拦下")
	}
	if !strings.Contains(err.Error(), "空节点") {
		t.Fatalf("错误信息应当说明原因，实际 %q", err)
	}
}

func TestParseVerdict(t *testing.T) {
	nl := string([]byte{10})
	cases := []struct {
		name    string
		out     string
		verdict string
		reason  string
	}{
		{"没有标记", "干完了，随便看看", VerdictUnknown, ""},
		{"通过", "做事" + nl + "CHAIN_VERDICT: pass", VerdictPass, ""},
		{"冒号后无空格", "CHAIN_VERDICT:pass", VerdictPass, ""},
		{"带理由", "CHAIN_VERDICT: reject 用例 3 没过", VerdictReject, "用例 3 没过"},
		{"认不出的取值不猜成通过", "CHAIN_VERDICT: maybe", VerdictUnknown, ""},
		{"最后一次出现说了算", "CHAIN_VERDICT: reject 先说不" + nl + "CHAIN_VERDICT: pass 后来算了", VerdictPass, "后来算了"},
		{"大小写不敏感", "CHAIN_VERDICT: PASS", VerdictPass, ""},
		{"缩进也算标记", "   CHAIN_VERDICT: reject 缩进", VerdictReject, "缩进"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			v, r := parseVerdict(c.out)
			if v != c.verdict || r != c.reason {
				t.Fatalf("期望 (%s,%q)，实际 (%s,%q)", c.verdict, c.reason, v, r)
			}
		})
	}
}

// ---- 角色、账号与会话 ----
// 这一组钉的是设计里的验收口径：谁能按、按的人记成谁、账号怎么来、会话怎么失效、密钥怎么吊销。
// 文案是被断言的对象，不是提示语——前端靠这几句区分「该去登录」「该去被授予角色」还是「该找管理员」。

// roleChain 是一条三站链：assess 要 review、dev 要 dev、release 要 release。
func roleChain() Chain {
	return chainOf(
		cn("assess", TypeAssess, ReviewHuman),
		cn("dev", TypeDev, ReviewHuman),
		cn("release", TypeRelease, ReviewHuman),
	)
}

// newRoleServer 起一个只有管理员的服务，project demo 用 roleChain。
func newRoleServer(t *testing.T) (*httptest.Server, Store) {
	t.Helper()
	store, err := OpenStore("sqlite", filepath.Join(t.TempDir(), "chain.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { store.Close() })
	ts := httptest.NewServer(NewServer(store, FakeExecutor{}).Handler())
	t.Cleanup(ts.Close)
	seedRoot(t, ts, store)
	p := Project{Key: "demo", Name: "Demo", Repo: "o/r", DefaultBranch: "main",
		Chains: []Chain{roleChain()}, CreatedAt: time.Now()}
	if err := store.SaveProject(&p); err != nil {
		t.Fatal(err)
	}
	return ts, store
}

// callRaw 以 who 的身份发请求（空 = 匿名），只断言状态码，不解响应体。
func callRaw(t *testing.T, ts *httptest.Server, who, method, path string, body any, want int) string {
	t.Helper()
	var cl *http.Client
	if who != "" {
		cl = clientOf(t, ts, who)
	}
	code, raw := exchange(t, ts, cl, method, path, body)
	if code != want {
		t.Fatalf("%s %s 期望 %d，实际 %d：%s", method, path, want, code, raw)
	}
	return string(raw)
}

// runAt 以 who 的身份在指定节点上发起一个动作，要求 403 并返回错误文案。
func runAt(t *testing.T, ts *httptest.Server, id, node, action, who string) string {
	t.Helper()
	path := "/api/requirements/" + id + "/nodes/" + node + "/" + action
	return callRaw(t, ts, who, "POST", path, map[string]any{}, 403)
}

// nodePath 拼一个节点动作的路径，省得每条用例手拼。
func nodePath(id, node, action string) string {
	return "/api/requirements/" + id + "/nodes/" + node + "/" + action
}

func TestGateNeedsLogin(t *testing.T) {
	ts, _ := newReviewServer(t, roleChain(), FakeExecutor{})
	req := submit(t, ts, "加个按钮")
	raw := callRaw(t, ts, "", "POST", nodePath(req.ID, "assess", "run"), map[string]any{}, 401)
	if !strings.Contains(raw, "没有登录") {
		t.Fatalf("没登录应当说要先登录，实际 %s", raw)
	}
	// 反向自证：同一个请求换成管理员就放行，说明 401 来自身份闸门而不是别处。
	callRaw(t, ts, rootUser, "POST", nodePath(req.ID, "assess", "run"), map[string]any{}, 200)
}

func TestGateNeedsMembership(t *testing.T) {
	ts, _ := newReviewServer(t, roleChain(), FakeExecutor{})
	call(t, ts, "POST", "/api/projects", map[string]any{"key": "other", "repo": "o/other"}, 201)
	addUser(t, ts, "张三", "zhangsan-pass")
	// 张三在 other 里有 review，在 demo 里没有任何角色：跨项目就是没有这个项目的权力。
	grantRole(t, ts, "other", "别的项目的审核员", "张三", PowerReview)
	req := submit(t, ts, "加个按钮")
	errText := runAt(t, ts, req.ID, "assess", "run", "张三")
	if !strings.Contains(errText, "「张三」在 demo 里没有 review 权力") {
		t.Fatalf("跨项目应当点名人与 project，实际 %s", errText)
	}
}

func TestGateNeedsMatchingPower(t *testing.T) {
	ts, _ := newReviewServer(t, roleChain(), FakeExecutor{})
	addUser(t, ts, "张三", "zhangsan-pass")
	grantRole(t, ts, "demo", "审核员", "张三", PowerReview)
	req := submit(t, ts, "加个按钮")
	// assess 要 review：张三有 review，放行。
	callAs(t, ts, "POST", nodePath(req.ID, "assess", "run"), "张三", map[string]any{}, 200)
	callAs(t, ts, "POST", nodePath(req.ID, "assess", "accept"), "张三", map[string]any{"comment": "评估通过"}, 200)
	errText := runAt(t, ts, req.ID, "dev", "run", "张三")
	if !strings.Contains(errText, "「张三」在 demo 里没有 dev 权力，不能在这个节点上确认/拒绝") {
		t.Fatalf("缺权力应当点名人与权力，实际 %s", errText)
	}
}

func TestGateAcceptsAndRecordsUserAuthor(t *testing.T) {
	ts, _ := newReviewServer(t, roleChain(), FakeExecutor{})
	addUser(t, ts, "李四", "lisi-password")
	grantRole(t, ts, "demo", "全能", "李四", PowerReview, PowerDev, PowerRelease)
	req := submit(t, ts, "加个按钮")
	callAs(t, ts, "POST", nodePath(req.ID, "assess", "run"), "李四", map[string]any{}, 200)
	got := callAs(t, ts, "POST", nodePath(req.ID, "assess", "accept"), "李四",
		map[string]any{"comment": "评估通过"}, 200)
	c := lastComment(nodeOf(t, got, "assess"))
	if c.AuthorType != "user" || c.Author != "李四" || c.Verdict != "approve" {
		t.Fatalf("过了闸门就该按账号记作者，实际 %+v", c)
	}
}

func TestCommentNeedsLogin(t *testing.T) {
	ts, _ := newReviewServer(t, roleChain(), FakeExecutor{})
	req := submit(t, ts, "加个按钮")
	callRaw(t, ts, "", "POST", nodePath(req.ID, "assess", "comment"), map[string]any{"body": "我先看看"}, 401)
}

func TestCommentRecordsUsernameWithoutPower(t *testing.T) {
	ts, _ := newReviewServer(t, roleChain(), FakeExecutor{})
	addUser(t, ts, "王五", "wangwu-pass")
	grantRole(t, ts, "demo", "测试员", "王五", PowerTest)
	req := submit(t, ts, "加个按钮")
	got := callAs(t, ts, "POST", nodePath(req.ID, "assess", "comment"), "王五",
		map[string]any{"body": "测试角度说一句"}, 200)
	c := lastComment(nodeOf(t, got, "assess"))
	if c.AuthorType != "user" || c.Author != "王五" || c.Body != "测试角度说一句" {
		t.Fatalf("评论应当记成账号名且正文原样，实际 %+v", c)
	}
	// 评论不看权力：只有 test 权力的人能在 review 站说话，只是不能按。
	if callRaw(t, ts, "王五", "POST", nodePath(req.ID, "assess", "accept"), map[string]any{}, 403) == "" {
		t.Fatal("只有 test 权力的人不该能按 review 站")
	}
}

func TestRoleCreateChecksInput(t *testing.T) {
	ts, _ := newRoleServer(t)
	path := "/api/p/demo/roles"
	body := map[string]any{"name": "张三", "powers": []string{"review"}}
	// 角色管理是管理员动作：不是管理员一律 403，且文案是那唯一一句。
	addUser(t, ts, "普通人", "plain-pass-1")
	if raw := callRaw(t, ts, "普通人", "POST", path, body, 403); !strings.Contains(raw, adminOnlyText) {
		t.Fatalf("非管理员应当收到 %q，实际 %s", adminOnlyText, raw)
	}
	callRaw(t, ts, rootUser, "POST", path, map[string]any{"name": "", "powers": []string{"review"}}, 400)
	callRaw(t, ts, rootUser, "POST", path, map[string]any{"name": "张三", "powers": []string{}}, 400)
	callRaw(t, ts, rootUser, "POST", path, map[string]any{"name": "张三", "powers": []string{"ops"}}, 400)
	created := callRaw(t, ts, rootUser, "POST", path, body, 201)
	var role Role
	if err := json.Unmarshal([]byte(created), &role); err != nil {
		t.Fatal(err)
	}
	if role.ID == "" || role.Name != "张三" || len(role.Powers) != 1 {
		t.Fatalf("建角色应当返回 id / 名字 / 权力，实际 %s", created)
	}
	// 角色不再有口令：响应里不该出现口令字段。
	if strings.Contains(created, "token") {
		t.Fatalf("建角色不该再发口令，实际 %s", created)
	}
	// 同名再来一个：评论里记的是账号名，重名就分不清是谁按的。
	callRaw(t, ts, rootUser, "POST", path, body, 400)
	// 不存在的 project 建不了角色。
	callRaw(t, ts, rootUser, "POST", "/api/p/nope/roles", body, 404)
}

func TestRoleListNeedsAdmin(t *testing.T) {
	ts, _ := newRoleServer(t)
	callRaw(t, ts, rootUser, "POST", "/api/p/demo/roles",
		map[string]any{"name": "张三", "powers": []string{"review", "dev"}}, 201)
	addUser(t, ts, "普通人", "plain-pass-1")
	if raw := callRaw(t, ts, "普通人", "GET", "/api/p/demo/roles", nil, 403); !strings.Contains(raw, adminOnlyText) {
		t.Fatalf("非管理员不该看到角色表，实际 %s", raw)
	}
	raw := callRaw(t, ts, rootUser, "GET", "/api/p/demo/roles", nil, 200)
	if strings.Contains(raw, "token") {
		t.Fatalf("角色表不该再回显口令，实际 %s", raw)
	}
	var roles []Role
	if err := json.Unmarshal([]byte(raw), &roles); err != nil {
		t.Fatal(err)
	}
	if len(roles) != 1 || roles[0].Name != "张三" || len(roles[0].Powers) != 2 {
		t.Fatalf("列表应当给出角色名与权力，实际 %+v", roles)
	}
}

// userID 从管理员视角的用户表里取一个人的 id（建号接口只回客户端，不回 id）。
func userID(t *testing.T, ts *httptest.Server, username string) string {
	t.Helper()
	raw := callRaw(t, ts, rootUser, "GET", "/api/users", nil, 200)
	var users []User
	if err := json.Unmarshal([]byte(raw), &users); err != nil {
		t.Fatal(err)
	}
	for _, u := range users {
		if u.Username == username {
			return u.ID
		}
	}
	t.Fatalf("用户表里没有 %s：%s", username, raw)
	return ""
}

// submitWithKey 用 API 密钥（不是会话）调接入层提需求。
func submitWithKey(t *testing.T, ts *httptest.Server, secret string, body any, want int) []byte {
	t.Helper()
	b, err := json.Marshal(body)
	if err != nil {
		t.Fatal(err)
	}
	req, err := http.NewRequest("POST", ts.URL+"/api/intake/requirements", bytes.NewReader(b))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+secret)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != want {
		t.Fatalf("密钥提需求期望 %d，实际 %d：%s", want, resp.StatusCode, raw)
	}
	return raw
}

// sessionCookie 取这个客户端手里的会话 Cookie 原文——登出用例要拿它再试一次。
func sessionCookie(t *testing.T, cl *http.Client, ts *httptest.Server) *http.Cookie {
	t.Helper()
	u, err := url.Parse(ts.URL)
	if err != nil {
		t.Fatal(err)
	}
	for _, ck := range cl.Jar.Cookies(u) {
		if ck.Name == sessionCookieName {
			return ck
		}
	}
	t.Fatalf("客户端手里没有 %s：会话没建立？", sessionCookieName)
	return nil
}

// sendWithCookie 手动带上一条会话 Cookie 发请求，绕开 cookiejar 的自动清理。
func sendWithCookie(t *testing.T, ts *httptest.Server, ck *http.Cookie, method, path string, body any) (int, []byte) {
	t.Helper()
	var rd io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			t.Fatal(err)
		}
		rd = bytes.NewReader(b)
	}
	req, err := http.NewRequest(method, ts.URL+path, rd)
	if err != nil {
		t.Fatal(err)
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	req.AddCookie(ck)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, raw
}

func TestRoleDeleteRemovesAssignment(t *testing.T) {
	ts, _ := newRoleServer(t)
	addUser(t, ts, "张三", "zhangsan-pass")
	role := grantRole(t, ts, "demo", "审核员", "张三", PowerReview)
	req := submit(t, ts, "加个按钮")
	callRaw(t, ts, "张三", "POST", nodePath(req.ID, "assess", "run"), map[string]any{}, 200)
	// 删角色连带删授予：权力是挂在角色上的，角色没了权力就该没了。
	callRaw(t, ts, rootUser, "DELETE", "/api/p/demo/roles/"+role.ID, map[string]any{}, 204)
	if errText := runAt(t, ts, req.ID, "assess", "accept", "张三"); !strings.Contains(errText, "「张三」在 demo 里没有 review 权力") {
		t.Fatalf("角色删了就该没有权力，实际 %s", errText)
	}
	// 再删一次不存在，跨项目也删不到。
	callRaw(t, ts, rootUser, "DELETE", "/api/p/demo/roles/"+role.ID, nil, 404)
	call(t, ts, "POST", "/api/projects", map[string]any{"key": "other", "repo": "o/other"}, 201)
	other := grantRole(t, ts, "other", "别的审核员", "", PowerReview)
	callRaw(t, ts, rootUser, "DELETE", "/api/p/demo/roles/"+other.ID, nil, 404)
}

func TestRoleMembersRoundTrip(t *testing.T) {
	ts, _ := newRoleServer(t)
	addUser(t, ts, "张三", "zhangsan-pass")
	role := grantRole(t, ts, "demo", "审核员", "", PowerReview)
	base := "/api/p/demo/roles/" + role.ID + "/members"
	callRaw(t, ts, rootUser, "POST", base, map[string]any{"username": ""}, 400)
	callRaw(t, ts, rootUser, "POST", base, map[string]any{"username": "李四"}, 404)
	callRaw(t, ts, rootUser, "POST", base, map[string]any{"username": "张三"}, 201)
	callRaw(t, ts, rootUser, "POST", base, map[string]any{"username": "张三"}, 409)
	raw := callRaw(t, ts, rootUser, "GET", base, nil, 200)
	var names []string
	if err := json.Unmarshal([]byte(raw), &names); err != nil {
		t.Fatal(err)
	}
	if len(names) != 1 || names[0] != "张三" {
		t.Fatalf("成员表应当只有张三，实际 %+v", names)
	}
	req := submit(t, ts, "加个按钮")
	callRaw(t, ts, "张三", "POST", nodePath(req.ID, "assess", "run"), map[string]any{}, 200)
	callRaw(t, ts, rootUser, "DELETE", base+"/张三", nil, 204)
	if errText := runAt(t, ts, req.ID, "assess", "accept", "张三"); !strings.Contains(errText, "没有 review 权力") {
		t.Fatalf("移出角色后该没有权力，实际 %s", errText)
	}
}

func TestStoreRolesRoundTrip(t *testing.T) {
	store, err := OpenStore("sqlite", filepath.Join(t.TempDir(), "chain.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	r := Role{ID: newID("r"), ProjectKey: "demo", Name: "审核员", Powers: []string{PowerReview}, CreatedAt: time.Now()}
	if err := store.SaveRole(r); err != nil {
		t.Fatal(err)
	}
	got, err := store.Role(r.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got.Name != "审核员" || len(got.Powers) != 1 || got.Powers[0] != PowerReview {
		t.Fatalf("角色存取丢字段，实际 %+v", got)
	}
	if _, err := store.Role("r-nope"); err == nil {
		t.Fatal("取不存在的角色必须报错，不能给空值加 nil")
	}
}

// ---- 账号、会话与密钥 ----

// TestNoSelfSignupRoutes 钉「没有首次注册这回事」：注册与「还能不能注册」两条入口都不存在了，
// 账号一律由管理员建（第一个管理员来自命令行的 chain user add）。
// 这两条留在路由表里会让人以为还能自助开号，所以必须是 404，不是 403 也不是 409。
func TestNoSelfSignupRoutes(t *testing.T) {
	store, err := OpenStore("sqlite", filepath.Join(t.TempDir(), "chain.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	ts := httptest.NewServer(NewServer(store, FakeExecutor{}).Handler())
	defer ts.Close()
	for _, path := range []string{"/api/signup", "/api/bootstrap"} {
		if code, raw := exchange(t, ts, nil, "POST", path, map[string]any{"username": rootUser, "password": rootPass}); code != 404 {
			t.Fatalf("POST %s 应当 404（没有这条路），实际 %d：%s", path, code, raw)
		}
		if code, raw := exchange(t, ts, nil, "GET", path, nil); code != 404 {
			t.Fatalf("GET %s 应当 404（没有这条路），实际 %d：%s", path, code, raw)
		}
	}
	if n, err := store.CountUsers(); err != nil || n != 0 {
		t.Fatalf("打不存在的注册入口不该落账号，库里应当 0 个，实际 %d（err=%v）", n, err)
	}
	// 未登录访问任何 /api 都要 401（只有 login 例外）。
	if code, raw := exchange(t, ts, nil, "GET", "/api/requirements", nil); code != 401 || !strings.Contains(string(raw), "没有登录") {
		t.Fatalf("未登录应当 401 并说明要先登录，实际 %d %s", code, raw)
	}
}

func TestLoginLogoutInvalidatesCookie(t *testing.T) {
	ts, _ := newReviewServer(t, roleChain(), FakeExecutor{})
	loginAs(t, ts, rootUser, rootPass)
	cl := clientOf(t, ts, rootUser)
	ck := sessionCookie(t, cl, ts)
	if code, raw := exchange(t, ts, cl, "GET", "/api/me", nil); code != 200 {
		t.Fatalf("登录后 /api/me 应当 200，实际 %d %s", code, raw)
	}
	if code, raw := exchange(t, ts, cl, "POST", "/api/logout", nil); code != 200 {
		t.Fatalf("登出应当 200，实际 %d %s", code, raw)
	}
	// 登出删的是库里的会话行：把原来那条 Cookie 手动塞回去也必须失效。
	code, raw := sendWithCookie(t, ts, ck, "GET", "/api/me", nil)
	if code != 401 || !strings.Contains(string(raw), "没有登录") {
		t.Fatalf("登出后旧 Cookie 必须 401，实际 %d %s", code, raw)
	}
}

func TestNonAdminCannotManageUsersOrRoles(t *testing.T) {
	ts, _ := newRoleServer(t)
	addUser(t, ts, "普通人", "plain-pass-1")
	if raw := callRaw(t, ts, "普通人", "GET", "/api/users", nil, 403); !strings.Contains(raw, adminOnlyText) {
		t.Fatalf("非管理员不该看到用户表，实际 %s", raw)
	}
	if raw := callRaw(t, ts, "普通人", "POST", "/api/users", map[string]any{"username": "auditor", "password": "audit-pass-1"}, 403); !strings.Contains(raw, adminOnlyText) {
		t.Fatalf("非管理员不该能开号，实际 %s", raw)
	}
	if raw := callRaw(t, ts, "普通人", "POST", "/api/p/demo/roles", map[string]any{"name": "x", "powers": []string{"review"}}, 403); !strings.Contains(raw, adminOnlyText) {
		t.Fatalf("非管理员不该能建角色，实际 %s", raw)
	}
}

func TestAdminResetsPassword(t *testing.T) {
	ts, _ := newRoleServer(t)
	addUser(t, ts, "张三", "zhangsan-pass")
	id := userID(t, ts, "张三")
	callRaw(t, ts, rootUser, "POST", "/api/users/"+id+"/password", map[string]any{"password": "short"}, 400)
	callRaw(t, ts, rootUser, "POST", "/api/users/"+id+"/password", map[string]any{"password": "reset-pass-1"}, 200)
	// 旧口令立刻不管用，新口令能登。
	code, raw := exchange(t, ts, freshClient(t), "POST", "/api/login", map[string]any{"username": "张三", "password": "zhangsan-pass"})
	if code != 401 || !strings.Contains(string(raw), "用户名或密码不对") {
		t.Fatalf("旧口令应当登不进，实际 %d %s", code, raw)
	}
	loginAs(t, ts, "张三", "reset-pass-1")
}

func TestChangeOwnPassword(t *testing.T) {
	ts, _ := newRoleServer(t)
	addUser(t, ts, "张三", "zhangsan-pass")
	cl := clientOf(t, ts, "张三")
	code, raw := exchange(t, ts, cl, "PUT", "/api/me/password", map[string]any{"oldPassword": "nope", "newPassword": "changed-pass-1"})
	if code != 400 || !strings.Contains(string(raw), "旧密码不对") {
		t.Fatalf("旧密码不对应当 400 点名，实际 %d %s", code, raw)
	}
	if code, raw = exchange(t, ts, cl, "PUT", "/api/me/password", map[string]any{"oldPassword": "zhangsan-pass", "newPassword": "changed-pass-1"}); code != 200 {
		t.Fatalf("自己改密码应当 200，实际 %d %s", code, raw)
	}
	loginAs(t, ts, "张三", "changed-pass-1")
}

func TestMeListsMemberships(t *testing.T) {
	ts, _ := newRoleServer(t)
	addUser(t, ts, "张三", "zhangsan-pass")
	grantRole(t, ts, "demo", "审核员", "张三", PowerReview, PowerTest)
	cl := clientOf(t, ts, "张三")
	code, raw := exchange(t, ts, cl, "GET", "/api/me", nil)
	if code != 200 {
		t.Fatalf("/api/me 应当 200，实际 %d %s", code, raw)
	}
	if !strings.Contains(string(raw), "demo") || !strings.Contains(string(raw), "审核员") || !strings.Contains(string(raw), "review") {
		t.Fatalf("/api/me 应当带上授予与权力，实际 %s", raw)
	}
}

func TestAPIKeyLifecycle(t *testing.T) {
	ts, _ := newRoleServer(t)
	addUser(t, ts, "接入者", "intake-pass-1")
	grantRole(t, ts, "demo", "接入员", "接入者", PowerReview)
	cl := clientOf(t, ts, "接入者")
	// 原文只出现这一次。
	code, raw := exchange(t, ts, cl, "POST", "/api/keys", map[string]any{"name": "脚本"})
	if code != 201 {
		t.Fatalf("建密钥应当 201，实际 %d %s", code, raw)
	}
	var created struct {
		Key    APIKey `json:"key"`
		Secret string `json:"secret"`
	}
	if err := json.Unmarshal(raw, &created); err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(created.Secret, apiKeyPrefix) {
		t.Fatalf("密钥应当是 %s 前缀，实际 %q", apiKeyPrefix, created.Secret)
	}
	code, listed := exchange(t, ts, cl, "GET", "/api/keys", nil)
	if code != 200 || strings.Contains(string(listed), created.Secret) {
		t.Fatalf("列表不该回显原文，实际 %d %s", code, listed)
	}
	// 用密钥调接入层：它认的是人，人来定权限。
	submitWithKey(t, ts, created.Secret, map[string]any{"project": "demo", "context": "用密钥提的需求"}, 201)
	// 密钥只能吊销自己的：换个人来删就是 404，得用例主亲自删。
	callRaw(t, ts, "接入者", "DELETE", "/api/keys/"+created.Key.ID, nil, 204)
	submitWithKey(t, ts, created.Secret, map[string]any{"project": "demo", "context": "吊销后"}, 401)
}

func TestAccountsEndToEnd(t *testing.T) {
	// 从空库开始的完整路径：注册 → 建项目 → 建角色 → 建号 → 授予 → 第二个账号只在自己那站能按。
	store, err := OpenStore("sqlite", filepath.Join(t.TempDir(), "chain.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	ts := httptest.NewServer(NewServer(store, FakeExecutor{}).Handler())
	defer ts.Close()
	if n, err := store.CountUsers(); err != nil || n != 0 {
		t.Fatalf("新库不该有账号，实际 %d 个（%v）", n, err)
	}
	seedRoot(t, ts, store)
	call(t, ts, "POST", "/api/projects", map[string]any{"key": "demo", "repo": "o/r"}, 201)
	grantRole(t, ts, "demo", "审核员", "", PowerReview)
	addUser(t, ts, "审核员小李", "auditor-pass-1")
	// 把号授进去：授予是授予，登录是登录。
	roles := callRaw(t, ts, rootUser, "GET", "/api/p/demo/roles", nil, 200)
	var list []Role
	if err := json.Unmarshal([]byte(roles), &list); err != nil {
		t.Fatal(err)
	}
	if len(list) != 1 {
		t.Fatalf("应当只有一个角色，实际 %+v", list)
	}
	callRaw(t, ts, rootUser, "POST", "/api/p/demo/roles/"+list[0].ID+"/members", map[string]any{"username": "审核员小李"}, 201)
	req := submit(t, ts, "改一下导出的列名")
	// assess 要 review：能按。
	callAs(t, ts, "POST", nodePath(req.ID, "assess", "run"), "审核员小李", map[string]any{}, 200)
	callAs(t, ts, "POST", nodePath(req.ID, "assess", "accept"), "审核员小李", map[string]any{"comment": "评估通过"}, 200)
	// release 要 release：403，且点名缺哪个权力。
	if errText := runAt(t, ts, req.ID, "release", "run", "审核员小李"); !strings.Contains(errText, "没有 release 权力") {
		t.Fatalf("release 站应当 403 点名 release，实际 %s", errText)
	}
}

// TestPowersIgnoreRoleFromAnotherProject 钉的是「权力只来自本项目的角色」：
// 授予行说它属于 demo，角色其实属于 other —— 这种错位的行不能把权力借过来。
// 没有这条，把 powersFor 里的 ProjectKey 校验删掉也不会红：库里的授予行按 project 分开查，
// 两道防线互相冗余，只有直接构造错位才打得中那一道。
func TestPowersIgnoreRoleFromAnotherProject(t *testing.T) {
	store, err := OpenStore("sqlite", filepath.Join(t.TempDir(), "chain.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	s := NewServer(store, FakeExecutor{})
	u := User{ID: newID("u"), Username: "张三", PasswordHash: "x", CreatedAt: time.Now()}
	if err := store.SaveUser(u); err != nil {
		t.Fatal(err)
	}
	role := Role{ID: newID("r"), ProjectKey: "other", Name: "别的审核员",
		Powers: []string{PowerReview}, CreatedAt: time.Now()}
	if err := store.SaveRole(role); err != nil {
		t.Fatal(err)
	}
	// 故意把授予行写成 demo：角色本身属于 other。
	if err := store.SaveAssignment(Assignment{ProjectKey: "demo", RoleID: role.ID, UserID: u.ID}); err != nil {
		t.Fatal(err)
	}
	if got := s.powersFor(&u, "demo"); len(got) != 0 {
		t.Fatalf("别的项目的角色不该给出 demo 的权力，实际 %+v", got)
	}
}

// TestDeleteRoleDropsAssignments 钉的是「删角色连带删授予」这条存储卫生：
// 只看权力是看不出来的（角色没了，指过去的授予行也换不出权力），所以直接数行。
func TestDeleteRoleDropsAssignments(t *testing.T) {
	ts, store := newRoleServer(t)
	addUser(t, ts, "张三", "zhangsan-pass")
	role := grantRole(t, ts, "demo", "审核员", "张三", PowerReview)
	callRaw(t, ts, rootUser, "DELETE", "/api/p/demo/roles/"+role.ID, nil, 204)
	st, ok := store.(*sqliteStore)
	if !ok {
		t.Fatalf("这个用例要直接数授予行，store 得是 sqliteStore，实际 %T", store)
	}
	var n int
	if err := st.db.QueryRow("SELECT COUNT(*) FROM assignments WHERE role_id = ?", role.ID).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 0 {
		t.Fatalf("删角色应当连带删掉授予行，实际留下 %d 行", n)
	}
}

// TestExpiredSessionIsRejectedAndDeleted 钉的是「会话过期就当场作废」：
// 直接把库里那条会话的过期时间改成过去，同一个 Cookie 再来必须 401，而且那行要被删掉——
// 不删的话每次带上过期 Cookie 都会白查一次库，也让「登出即失效」之外多出一条活路。
func TestExpiredSessionIsRejectedAndDeleted(t *testing.T) {
	ts, store := newRoleServer(t)
	loginAs(t, ts, rootUser, rootPass)
	cl := clientOf(t, ts, rootUser)
	ck := sessionCookie(t, cl, ts)
	st, ok := store.(*sqliteStore)
	if !ok {
		t.Fatalf("这个用例要直接改过期时间，store 得是 sqliteStore，实际 %T", store)
	}
	if _, err := st.db.Exec("UPDATE sessions SET expires_at = ? WHERE token_hash = ?",
		formatTime(time.Now().Add(-time.Hour)), hashToken(ck.Value)); err != nil {
		t.Fatal(err)
	}
	code, raw := sendWithCookie(t, ts, ck, "GET", "/api/me", nil)
	if code != 401 || !strings.Contains(string(raw), "没有登录") {
		t.Fatalf("过期会话必须 401，实际 %d %s", code, raw)
	}
	var n int
	if err := st.db.QueryRow("SELECT COUNT(*) FROM sessions WHERE token_hash = ?", hashToken(ck.Value)).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 0 {
		t.Fatalf("过期会话应当当场删掉，实际还剩 %d 行", n)
	}
}
