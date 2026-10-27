package main

import (
	"encoding/json"
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
