package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
)

func newTestServer(t *testing.T) (*httptest.Server, Store, string) {
	t.Helper()
	path := filepath.Join(t.TempDir(), "chain.db")
	store, err := OpenStore("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { store.Close() })
	mux := http.NewServeMux()
	NewServer(store, FakeExecutor{}).Routes(mux)
	ts := httptest.NewServer(mux)
	t.Cleanup(ts.Close)
	return ts, store, path
}

// call 发一次请求并解出需求，断言状态码。
func call(t *testing.T, ts *httptest.Server, method, path string, body any, want int) *Requirement {
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
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	var raw json.RawMessage
	if err := json.NewDecoder(res.Body).Decode(&raw); err != nil {
		t.Fatalf("%s %s 响应不是 JSON：%v", method, path, err)
	}
	if res.StatusCode != want {
		t.Fatalf("%s %s 期望 %d，实际 %d：%s", method, path, want, res.StatusCode, raw)
	}
	if res.StatusCode >= 400 {
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
	res, err := http.Get(ts.URL + "/api/requirements")
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	var out []Requirement
	if err := json.NewDecoder(res.Body).Decode(&out); err != nil {
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
	last := got.Node("assess").Comments[len(got.Node("assess").Comments)-1]
	if last.Verdict != "reject" || last.Body != "这不是需求" {
		t.Fatalf("拒绝理由应落成 reject 评论，实际 %+v", last)
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
