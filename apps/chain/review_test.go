package main

import (
	"bytes"
	"database/sql"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
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
	seedAllPowers(t, store, "demo")
	return ts, store
}

// seedRole 直接往库里落一个角色。这里测的是节点闸门，不是建角色那道门，
// 所以不走管理口令，省掉一层与判据无关的接线。
func seedRole(t *testing.T, store Store, projectKey, name, token string, powers ...string) Role {
	t.Helper()
	r := Role{
		ID: newID("r"), ProjectKey: projectKey, Name: name, Powers: powers,
		Token: token, CreatedAt: time.Now(),
	}
	if err := store.SaveRole(r); err != nil {
		t.Fatal(err)
	}
	return r
}

// seedAllPowers 发一个四权齐全的角色，口令是 testRoleToken。
func seedAllPowers(t *testing.T, store Store, projectKey string) Role {
	t.Helper()
	return seedRole(t, store, projectKey, "测试角色", testRoleToken,
		PowerReview, PowerDev, PowerTest, PowerRelease)
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

// ---- 角色与闸门 ----
// 这一组用例钉的是设计里那 8 条判据：谁能按、按的人记成谁、口令怎么换、口令怎么不外泄。
// 文案是被断言的对象，不是提示语——前端靠这三句区分「该去建角色」还是「该换口令」。

// roleChain 是一条三站链：assess 要 review、dev 要 dev、release 要 release。
func roleChain() Chain {
	return chainOf(
		cn("assess", TypeAssess, ReviewHuman),
		cn("dev", TypeDev, ReviewHuman),
		cn("release", TypeRelease, ReviewHuman),
	)
}

// newRoleServer 起一个开了管理口令的服务，用来测建 / 列 / 删 / 换口令这四条管理接口。
func newRoleServer(t *testing.T) (*httptest.Server, Store) {
	t.Helper()
	store, err := OpenStore("sqlite", filepath.Join(t.TempDir(), "chain.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { store.Close() })
	ts := httptest.NewServer(NewServer(store, FakeExecutor{}).WithAdminToken(testAdminToken).Handler())
	t.Cleanup(ts.Close)
	p := Project{Key: "demo", Name: "Demo", Repo: "o/r", DefaultBranch: "main",
		Chains: []Chain{roleChain()}, CreatedAt: time.Now()}
	if err := store.SaveProject(&p); err != nil {
		t.Fatal(err)
	}
	return ts, store
}

// callRaw 只断言状态码，不解响应体：删除角色这类 204 是空响应，解 JSON 反而会挡住。
func callRaw(t *testing.T, ts *httptest.Server, method, path, token string, body any, want int) string {
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
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	out, err := io.ReadAll(res.Body)
	if err != nil {
		t.Fatal(err)
	}
	if res.StatusCode != want {
		t.Fatalf("%s %s 期望 %d，实际 %d：%s", method, path, want, res.StatusCode, out)
	}
	return string(out)
}

// runAt 在指定节点上发起一个动作，带指定口令，要求 403 并返回错误文案。
func runAt(t *testing.T, ts *httptest.Server, id, node, action, token string) string {
	t.Helper()
	path := "/api/requirements/" + id + "/nodes/" + node + "/" + action
	return callRaw(t, ts, "POST", path, token, map[string]any{}, 403)
}

func TestRoleGateNeedsToken(t *testing.T) {
	ts, _ := newReviewServer(t, roleChain(), FakeExecutor{})
	req := submit(t, ts, "加个按钮")
	errText := runAt(t, ts, req.ID, "assess", "run", "")
	if !strings.Contains(errText, "这个动作需要一个带 review 权力的角色口令") {
		t.Fatalf("没带口令应当按这一站的权力说清楚，实际 %s", errText)
	}
	// 反向自证：同一个请求带上四权齐全的口令就放行，说明 403 来自闸门而不是别处。
	callAs(t, ts, "POST", "/api/requirements/"+req.ID+"/nodes/assess/run", testRoleToken, map[string]any{}, 200)
}

func TestRoleGateRejectsRoleFromOtherProject(t *testing.T) {
	ts, store := newReviewServer(t, roleChain(), FakeExecutor{})
	seedRole(t, store, "other", "别的项目的角色", "rl_other_project", PowerReview, PowerDev, PowerRelease)
	req := submit(t, ts, "加个按钮")
	errText := runAt(t, ts, req.ID, "assess", "run", "rl_other_project")
	if !strings.Contains(errText, "角色属于 other，这条需求在 demo") {
		t.Fatalf("跨项目应当点名两个 project，实际 %s", errText)
	}
}

func TestRoleGateNeedsMatchingPower(t *testing.T) {
	ts, store := newReviewServer(t, roleChain(), FakeExecutor{})
	seedRole(t, store, "demo", "张三", "rl_zhangsan", PowerReview)
	req := submit(t, ts, "加个按钮")
	// assess 要 review：张三有 review，放行。
	callAs(t, ts, "POST", "/api/requirements/"+req.ID+"/nodes/assess/run", "rl_zhangsan", map[string]any{}, 200)
	callAs(t, ts, "POST", "/api/requirements/"+req.ID+"/nodes/assess/accept", "rl_zhangsan", map[string]any{"comment": "评估通过"}, 200)
	errText := runAt(t, ts, req.ID, "dev", "run", "rl_zhangsan")
	if !strings.Contains(errText, "角色「张三」没有 dev 权力，不能在这个节点上确认/拒绝") {
		t.Fatalf("缺权力应当点名角色名与权力，实际 %s", errText)
	}
}

func TestRoleGateAcceptsAndRecordsRoleAuthor(t *testing.T) {
	ts, store := newReviewServer(t, roleChain(), FakeExecutor{})
	seedRole(t, store, "demo", "李四", "rl_lisi", PowerReview, PowerDev, PowerRelease)
	req := submit(t, ts, "加个按钮")
	callAs(t, ts, "POST", "/api/requirements/"+req.ID+"/nodes/assess/run", "rl_lisi", map[string]any{}, 200)
	got := callAs(t, ts, "POST", "/api/requirements/"+req.ID+"/nodes/assess/accept", "rl_lisi",
		map[string]any{"comment": "评估通过"}, 200)
	c := lastComment(nodeOf(t, got, "assess"))
	if c.AuthorType != "role" || c.Author != "李四" || c.Verdict != "approve" {
		t.Fatalf("过了闸门就该按角色记作者，实际 %+v", c)
	}
}

func TestRoleCommentWithoutTokenIsVisitor(t *testing.T) {
	ts, _ := newReviewServer(t, roleChain(), FakeExecutor{})
	req := submit(t, ts, "加个按钮")
	got := callAnon(t, ts, "POST", "/api/requirements/"+req.ID+"/nodes/assess/comment",
		map[string]any{"body": "我先看看"}, 200)
	c := lastComment(nodeOf(t, got, "assess"))
	if c.AuthorType != "visitor" || c.Author != "visitor" || c.Body != "我先看看" {
		t.Fatalf("不带口令的评论应当记成访客，实际 %+v", c)
	}
}

func TestRoleCommentWithTokenRecordsRole(t *testing.T) {
	ts, store := newReviewServer(t, roleChain(), FakeExecutor{})
	seedRole(t, store, "demo", "王五", "rl_wangwu", PowerTest)
	req := submit(t, ts, "加个按钮")
	got := callAs(t, ts, "POST", "/api/requirements/"+req.ID+"/nodes/assess/comment", "rl_wangwu",
		map[string]any{"body": "测试角度说一句"}, 200)
	c := lastComment(nodeOf(t, got, "assess"))
	if c.AuthorType != "role" || c.Author != "王五" {
		t.Fatalf("带口令的评论应当记成角色，实际 %+v", c)
	}
	// 评论不看权力：只有 test 权力的角色也能在 review 站说话，只是不能按。
	if c.Body != "测试角度说一句" {
		t.Fatalf("评论正文应当原样留下，实际 %q", c.Body)
	}
}

func TestRoleNodePowerOverride(t *testing.T) {
	// 链条作者把 dev 站要的权力改成 test：这一站就认 test，不认 dev。
	c := chainOf(
		cn("assess", TypeAssess, ReviewHuman),
		ChainNode{Key: "dev", Type: TypeDev, Review: ReviewHuman, Power: PowerTest},
		cn("release", TypeRelease, ReviewHuman),
	)
	ts, store := newReviewServer(t, c, FakeExecutor{})
	seedRole(t, store, "demo", "只懂测试", "rl_only_test", PowerTest)
	seedRole(t, store, "demo", "只懂开发", "rl_only_dev", PowerDev)
	req := submit(t, ts, "加个按钮")
	callAs(t, ts, "POST", "/api/requirements/"+req.ID+"/nodes/assess/run", testRoleToken, map[string]any{}, 200)
	callAs(t, ts, "POST", "/api/requirements/"+req.ID+"/nodes/assess/accept", testRoleToken,
		map[string]any{"comment": "评估通过"}, 200)
	// dev 站覆盖成 test：只有 test 权力的人能按，只有 dev 权力的人被挡。
	if errText := runAt(t, ts, req.ID, "dev", "run", "rl_only_dev"); !strings.Contains(errText, "没有 test 权力") {
		t.Fatalf("覆盖权力后应当按 test 判，实际 %s", errText)
	}
	got := callAs(t, ts, "POST", "/api/requirements/"+req.ID+"/nodes/dev/run", "rl_only_test", map[string]any{}, 200)
	if nodeOf(t, got, "dev").State != StateRunning {
		t.Fatalf("有 test 权力的人应当能动手，实际 %s", nodeOf(t, got, "dev").State)
	}
}

func TestRoleCreateChecksInput(t *testing.T) {
	ts, _ := newRoleServer(t)
	path := "/api/p/demo/roles"
	body := map[string]any{"name": "张三", "powers": []string{"review"}}
	// 管理接口吃的是 project 管理口令，不是角色口令。
	callRaw(t, ts, "POST", path, "", body, 401)
	callRaw(t, ts, "POST", path, testRoleToken, body, 401)
	callRaw(t, ts, "POST", path, "wrong", body, 401)
	callRaw(t, ts, "POST", path, testAdminToken, map[string]any{"name": "", "powers": []string{"review"}}, 400)
	callRaw(t, ts, "POST", path, testAdminToken, map[string]any{"name": "张三", "powers": []string{}}, 400)
	callRaw(t, ts, "POST", path, testAdminToken, map[string]any{"name": "张三", "powers": []string{"ops"}}, 400)
	token := createdToken(t, callRaw(t, ts, "POST", path, testAdminToken, body, 201))
	if !strings.HasPrefix(token, "rl_") {
		t.Fatalf("建角色应当发一个 rl_ 开头的口令，实际 %q", token)
	}
	// 同名再来一个：评论里记的是角色名，重名就分不清是谁按的。
	callRaw(t, ts, "POST", path, testAdminToken, body, 400)
	// 不存在的 project 建不了角色。
	callRaw(t, ts, "POST", "/api/p/nope/roles", testAdminToken, body, 404)
}

// createdToken 从建角色的响应里取口令。
func createdToken(t *testing.T, raw string) string {
	t.Helper()
	var r Role
	if err := json.Unmarshal([]byte(raw), &r); err != nil {
		t.Fatal(err)
	}
	return r.Token
}

func TestRoleListHidesToken(t *testing.T) {
	ts, _ := newRoleServer(t)
	callRaw(t, ts, "POST", "/api/p/demo/roles", testAdminToken,
		map[string]any{"name": "张三", "powers": []string{"review", "dev"}}, 201)
	raw := callRaw(t, ts, "GET", "/api/p/demo/roles", testAdminToken, nil, 200)
	if strings.Contains(raw, "rl_") || strings.Contains(raw, "token") {
		t.Fatalf("列表不该回显口令，实际 %s", raw)
	}
	var roles []Role
	if err := json.Unmarshal([]byte(raw), &roles); err != nil {
		t.Fatal(err)
	}
	if len(roles) != 1 || roles[0].Name != "张三" || len(roles[0].Powers) != 2 {
		t.Fatalf("列表应当给出角色名与权力，实际 %+v", roles)
	}
	// 没带管理口令看不到角色表。
	callRaw(t, ts, "GET", "/api/p/demo/roles", "", nil, 401)
}

func TestRoleRotateInvalidatesOldToken(t *testing.T) {
	ts, _ := newRoleServer(t)
	created := callRaw(t, ts, "POST", "/api/p/demo/roles", testAdminToken,
		map[string]any{"name": "张三", "powers": []string{"review"}}, 201)
	var role Role
	if err := json.Unmarshal([]byte(created), &role); err != nil {
		t.Fatal(err)
	}
	rotated := callRaw(t, ts, "POST", "/api/p/demo/roles/"+role.ID+"/rotate", testAdminToken, nil, 200)
	var fresh Role
	if err := json.Unmarshal([]byte(rotated), &fresh); err != nil {
		t.Fatal(err)
	}
	if fresh.Token == role.Token || !strings.HasPrefix(fresh.Token, "rl_") {
		t.Fatalf("换口令应当发一个新的 rl_ 口令，实际 %q", fresh.Token)
	}
	req := submit(t, ts, "加个按钮")
	// 旧口令立刻失效。
	if errText := runAt(t, ts, req.ID, "assess", "run", role.Token); !strings.Contains(errText, "这个动作需要一个带 review 权力的角色口令") {
		t.Fatalf("旧口令应当认不出来，实际 %s", errText)
	}
	// 新口令能用。
	callAs(t, ts, "POST", "/api/requirements/"+req.ID+"/nodes/assess/run", fresh.Token, map[string]any{}, 200)
}

func TestRoleDeleteRemovesToken(t *testing.T) {
	ts, _ := newRoleServer(t)
	created := callRaw(t, ts, "POST", "/api/p/demo/roles", testAdminToken,
		map[string]any{"name": "张三", "powers": []string{"review"}}, 201)
	var role Role
	if err := json.Unmarshal([]byte(created), &role); err != nil {
		t.Fatal(err)
	}
	callRaw(t, ts, "DELETE", "/api/p/demo/roles/"+role.ID, testAdminToken, nil, 204)
	req := submit(t, ts, "加个按钮")
	if errText := runAt(t, ts, req.ID, "assess", "run", role.Token); !strings.Contains(errText, "这个动作需要一个带 review 权力的角色口令") {
		t.Fatalf("删掉的角色不该还能按，实际 %s", errText)
	}
	callRaw(t, ts, "DELETE", "/api/p/demo/roles/"+role.ID, testAdminToken, nil, 404)
	// 别的 project 的管理口令不能删这个 project 的角色。
	created2 := callRaw(t, ts, "POST", "/api/p/demo/roles", testAdminToken,
		map[string]any{"name": "李四", "powers": []string{"review"}}, 201)
	var role2 Role
	if err := json.Unmarshal([]byte(created2), &role2); err != nil {
		t.Fatal(err)
	}
	callRaw(t, ts, "POST", "/api/intake/projects", testAdminToken, map[string]any{"key": "other", "repo": "/tmp/other"}, 201)
	callRaw(t, ts, "DELETE", "/api/p/other/roles/"+role2.ID, testAdminToken, nil, 404)
	callRaw(t, ts, "DELETE", "/api/p/demo/roles/"+role2.ID, testAdminToken, nil, 204)
}

func TestStoreRolesRoundTrip(t *testing.T) {
	store, err := OpenStore("sqlite", filepath.Join(t.TempDir(), "chain.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	now := time.Now()
	if err := store.SaveRole(Role{ID: "r-1", ProjectKey: "demo", Name: "张三",
		Powers: []string{PowerReview, PowerTest}, Token: "rl_one", CreatedAt: now}); err != nil {
		t.Fatal(err)
	}
	got, err := store.RoleByToken("rl_one")
	if err != nil {
		t.Fatal(err)
	}
	if got.Name != "张三" || len(got.Powers) != 2 || !got.HasPower(PowerTest) || got.HasPower(PowerDev) {
		t.Fatalf("角色应当原样读回来，实际 %+v", got)
	}
	// 口令不认识与口令为空是两种拒绝，都必须报错而不是给一个空角色。
	if _, err := store.RoleByToken("rl_nope"); err == nil {
		t.Fatal("不认识的口令应当报错")
	} else if strings.Contains(err.Error(), "rl_nope") {
		t.Fatalf("错误文案不该带口令，实际 %q", err)
	}
	if _, err := store.RoleByToken(""); err == nil {
		t.Fatal("没有口令应当报错")
	}
	if _, err := store.Role("r-nope"); err == nil {
		t.Fatal("没有这个角色应当报错")
	}
	// 换一个 project 的角色表互不串。
	if err := store.SaveRole(Role{ID: "r-2", ProjectKey: "other", Name: "李四",
		Powers: []string{PowerDev}, Token: "rl_two", CreatedAt: now}); err != nil {
		t.Fatal(err)
	}
	roles, err := store.Roles("demo")
	if err != nil || len(roles) != 1 || roles[0].ID != "r-1" {
		t.Fatalf("按 project 列角色只该给这个 project 的，实际 %v %+v", err, roles)
	}
}

func TestOpenStoreAddsRolesTableToOldDatabase(t *testing.T) {
	// 老库只有 projects 表：roles 表靠 CREATE TABLE IF NOT EXISTS 补上，不需要 ALTER。
	path := filepath.Join(t.TempDir(), "old.db")
	db, err := sql.Open("sqlite", "file:"+path)
	if err != nil {
		t.Fatal(err)
	}
	_, err = db.Exec(`CREATE TABLE projects (
  key TEXT PRIMARY KEY, name TEXT NOT NULL, repo TEXT NOT NULL,
  default_branch TEXT NOT NULL, chains TEXT NOT NULL, created_at TEXT NOT NULL)`)
	if err != nil {
		t.Fatal(err)
	}
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}
	store, err := OpenStore("sqlite", path)
	if err != nil {
		t.Fatalf("老库应当被补表后可用：%v", err)
	}
	defer store.Close()
	if err := store.SaveRole(Role{ID: "r-1", ProjectKey: "old", Name: "张三",
		Powers: []string{PowerReview}, Token: "rl_old", CreatedAt: time.Now()}); err != nil {
		t.Fatalf("老库应当能写角色：%v", err)
	}
	role, err := store.RoleByToken("rl_old")
	if err != nil || role.Name != "张三" {
		t.Fatalf("老库应当能读角色：%v %+v", err, role)
	}
}

// ---- 建项目即发 owner 口令 ----
// 这一组钉的是 t36 的那个断点：不配管理口令时，建项目的人得当场拿到项目的钥匙，
// 否则角色管理 503、闸门 403，整条链谁也按不动。

// createProjectRaw 建一个 project，把 201 的原始响应体拿回来（要看 ownerToken）。
func createProjectRaw(t *testing.T, ts *httptest.Server, key string) Project {
	t.Helper()
	raw := callRaw(t, ts, "POST", "/api/projects", "", map[string]any{"key": key, "repo": "o/r"}, 201)
	var p Project
	if err := json.Unmarshal([]byte(raw), &p); err != nil {
		t.Fatalf("建项目的响应不是 project JSON：%v（%s）", err, raw)
	}
	return p
}

func TestCreateProjectIssuesOwnerToken(t *testing.T) {
	ts, store := newReviewServer(t, roleChain(), FakeExecutor{})
	p := createProjectRaw(t, ts, "fresh")
	if !strings.HasPrefix(p.OwnerToken, "rl_") {
		t.Fatalf("建项目应当当场发一个 rl_ 开头的 owner 口令，实际 %q", p.OwnerToken)
	}
	// 库里落的是角色，不是口令本身之外的什么：owner 角色四权齐全。
	roles, err := store.Roles("fresh")
	if err != nil || len(roles) != 1 {
		t.Fatalf("建项目应当顺手落一个角色，实际 %v %+v", err, roles)
	}
	if roles[0].Name != ownerRoleName || len(roles[0].Powers) != 4 {
		t.Fatalf("owner 角色应当四权齐全，实际 %+v", roles[0])
	}
	// 拿这个口令就能直接对该项目的节点动手。
	raw := callRaw(t, ts, "POST", "/api/p/fresh/requirements", "", map[string]any{"context": "加个按钮"}, 201)
	var req Requirement
	if err := json.Unmarshal([]byte(raw), &req); err != nil {
		t.Fatal(err)
	}
	first := req.Nodes[0].Key
	callAs(t, ts, "POST", "/api/requirements/"+req.ID+"/nodes/"+first+"/run", p.OwnerToken, map[string]any{}, 200)
}

func TestCreateProjectWithoutAdminTokenIsUsable(t *testing.T) {
	// newReviewServer 不带管理口令：这正是「最普通的启动方式」。
	ts, _ := newReviewServer(t, roleChain(), FakeExecutor{})
	p := createProjectRaw(t, ts, "solo")
	if p.OwnerToken == "" {
		t.Fatal("没有管理口令的部署里，建项目必须当场发口令，否则没人能按")
	}
	// 角色管理接口仍然要管理口令：这条规则没因为 owner 口令而放宽。
	callRaw(t, ts, "POST", "/api/p/solo/roles", "", map[string]any{"name": "x", "powers": []string{"review"}}, 503)
	callRaw(t, ts, "POST", "/api/p/solo/roles", p.OwnerToken, map[string]any{"name": "x", "powers": []string{"review"}}, 503)

	raw := callRaw(t, ts, "POST", "/api/p/solo/requirements", "", map[string]any{"context": "端到端"}, 201)
	var req Requirement
	if err := json.Unmarshal([]byte(raw), &req); err != nil {
		t.Fatal(err)
	}
	// run 与 accept 全通：assess 站要 review，owner 有。
	callAs(t, ts, "POST", "/api/requirements/"+req.ID+"/nodes/assess/run", p.OwnerToken, map[string]any{}, 200)
	got := callAs(t, ts, "POST", "/api/requirements/"+req.ID+"/nodes/assess/accept", p.OwnerToken,
		map[string]any{"comment": "自己建的自己按"}, 200)
	c := lastComment(nodeOf(t, got, "assess"))
	if c.AuthorType != "role" || c.Author != ownerRoleName {
		t.Fatalf("按的人应当记成 owner 角色，实际 %+v", c)
	}
}

func TestListProjectsHidesOwnerToken(t *testing.T) {
	ts, _ := newReviewServer(t, roleChain(), FakeExecutor{})
	createProjectRaw(t, ts, "hidden")
	raw := callRaw(t, ts, "GET", "/api/projects", "", nil, 200)
	if strings.Contains(raw, "rl_") {
		t.Fatalf("列表不该出现角色口令，实际 %s", raw)
	}
	if strings.Contains(raw, "ownerToken") {
		t.Fatalf("列表不该出现 ownerToken 字段，实际 %s", raw)
	}
}

func TestOwnerRoleNameCannotBeDuplicated(t *testing.T) {
	ts, _ := newRoleServer(t)
	createProjectRaw(t, ts, "dup")
	// 同一 project 里再建一个叫 owner 的角色：重名就报错，不静默改名。
	errText := callRaw(t, ts, "POST", "/api/p/dup/roles", testAdminToken,
		map[string]any{"name": ownerRoleName, "powers": []string{"review"}}, 400)
	if !strings.Contains(errText, "这个 project 里已经有同名角色：owner") {
		t.Fatalf("重名应当点名 owner，实际 %s", errText)
	}
}

func TestCreateProjectFailsWhenOwnerRoleCannotBeIssued(t *testing.T) {
	ts, store := newRoleServer(t)
	// 先占住 owner 这个名字：建项目时发不出角色，就不该建出「没人能按」的项目。
	seedRole(t, store, "ghost", ownerRoleName, "rl_ghost", PowerReview)
	errText := callRaw(t, ts, "POST", "/api/projects", "", map[string]any{"key": "ghost", "repo": "o/r"}, 500)
	if !strings.Contains(errText, "建项目失败：owner 角色没有落库：这个 project 里已经有同名角色：owner") {
		t.Fatalf("发不出 owner 口令时应当如实说清，实际 %s", errText)
	}
	if _, err := store.Project("ghost"); err == nil {
		t.Fatal("owner 角色没落库时，项目也不该留下半截")
	}
}

// failingProjectStore 只让指定的 project 写不进去：用来测「项目没落库时，刚发的 owner 角色要回滚」。
// Store 是接口，所以这不需要真的把磁盘写坏——那反而会变成一条只在坏机器上跑得起来的用例。
type failingProjectStore struct {
	Store
	key string
}

func (f failingProjectStore) SaveProject(p *Project) error {
	if p.Key == f.key {
		return errors.New("磁盘写不进去")
	}
	return f.Store.SaveProject(p)
}

func TestCreateProjectRollsBackOwnerRoleWhenProjectSaveFails(t *testing.T) {
	inner, err := OpenStore("sqlite", filepath.Join(t.TempDir(), "chain.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { inner.Close() })
	ts := httptest.NewServer(NewServer(failingProjectStore{Store: inner, key: "half"}, FakeExecutor{}).Handler())
	t.Cleanup(ts.Close)

	errText := callRaw(t, ts, "POST", "/api/projects", "", map[string]any{"key": "half", "repo": "o/r"}, 500)
	if !strings.Contains(errText, "磁盘写不进去") {
		t.Fatalf("项目写不进去时应当如实回 500，实际 %s", errText)
	}
	// 同生共死的另一半：项目没进去，刚发的钥匙不能留在库里占名字。
	roles, err := inner.Roles("half")
	if err != nil {
		t.Fatal(err)
	}
	if len(roles) != 0 {
		t.Fatalf("项目没写进去时 owner 角色必须回滚，实际留下 %d 个：%+v", len(roles), roles)
	}
	if _, err := inner.Project("half"); err == nil {
		t.Fatal("这个项目本来就没写进去，不该读得出来")
	}
}
