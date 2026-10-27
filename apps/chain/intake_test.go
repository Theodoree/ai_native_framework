package main

import (
	"bytes"
	"database/sql"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

const testAdminToken = "admin-secret-for-test"

// newIntakeServer 起一个打开了接入层的服务。store 拿回去是为了直接读事件与评论。
func newIntakeServer(t *testing.T) (*httptest.Server, Store) {
	t.Helper()
	path := filepath.Join(t.TempDir(), "chain.db")
	store, err := OpenStore("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { store.Close() })
	ts := httptest.NewServer(NewServer(store, FakeExecutor{}).WithAdminToken(testAdminToken).Handler())
	t.Cleanup(ts.Close)
	return ts, store
}

func intakeCall(t *testing.T, ts *httptest.Server, method, path, token string, body any, want int) []byte {
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
	raw, err := io.ReadAll(res.Body)
	if err != nil {
		t.Fatal(err)
	}
	if res.StatusCode != want {
		t.Fatalf("%s %s 期望 %d，实际 %d：%s", method, path, want, res.StatusCode, raw)
	}
	return raw
}

// intakeProject 走管理口令建一个 project，返回它的访问口令。
func intakeProject(t *testing.T, ts *httptest.Server, key string) string {
	t.Helper()
	raw := intakeCall(t, ts, "POST", "/api/intake/projects", testAdminToken,
		map[string]any{"key": key, "repo": "/tmp/" + key}, 201)
	var out intakeCreatedProject
	if err := json.Unmarshal(raw, &out); err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(out.IntakeToken, "pk_") {
		t.Fatalf("建 project 应发一个 pk_ 开头的访问口令，实际 %q", out.IntakeToken)
	}
	if len(out.Chains) == 0 {
		t.Fatal("没给链条时应落默认链条")
	}
	return out.IntakeToken
}

// 老库没有接入层的列：CREATE TABLE IF NOT EXISTS 不会补，得靠 migrate。
func TestOpenStoreMigratesOldDatabase(t *testing.T) {
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
	if _, err := db.Exec(`INSERT INTO projects VALUES ('old','old','/tmp/old','main','[]','2026-01-01T00:00:00Z')`); err != nil {
		t.Fatal(err)
	}
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}

	store, err := OpenStore("sqlite", path)
	if err != nil {
		t.Fatalf("老库应当被补列后可用：%v", err)
	}
	defer store.Close()
	p, err := store.Project("old")
	if err != nil {
		t.Fatal(err)
	}
	if p.IntakeToken != "" {
		t.Fatalf("老库补出来的访问口令应当为空（接入层没开过），实际 %q", p.IntakeToken)
	}
	p.IntakeToken = "pk_x"
	if err := store.SaveProject(p); err != nil {
		t.Fatal(err)
	}
	again, err := store.Project("old")
	if err != nil {
		t.Fatal(err)
	}
	if again.IntakeToken != "pk_x" {
		t.Fatalf("补列之后应当能写能读访问口令，实际 %q", again.IntakeToken)
	}
}

func TestIntakeStaysClosedWithoutAdminToken(t *testing.T) {
	ts, _, _ := newTestServer(t)
	intakeCall(t, ts, "POST", "/api/intake/projects", "", map[string]any{"key": "a", "repo": "/tmp/a"}, 503)
}

func TestIntakeCreateProjectNeedsAdminToken(t *testing.T) {
	ts, _ := newIntakeServer(t)
	intakeCall(t, ts, "POST", "/api/intake/projects", "wrong", map[string]any{"key": "a", "repo": "/tmp/a"}, 401)
	intakeCall(t, ts, "POST", "/api/intake/projects", testAdminToken, map[string]any{"key": "a"}, 400)       // 缺 repo
	intakeCall(t, ts, "POST", "/api/intake/projects", testAdminToken, map[string]any{"repo": "/tmp/a"}, 400) // 缺 key
	intakeProject(t, ts, "a")
	intakeCall(t, ts, "POST", "/api/intake/projects", testAdminToken, map[string]any{"key": "a", "repo": "/tmp/a"}, 409)
}

func TestIntakeTokenOnlySeesOwnProject(t *testing.T) {
	ts, _ := newIntakeServer(t)
	tokenA := intakeProject(t, ts, "alpha")
	tokenB := intakeProject(t, ts, "beta")
	if tokenA == tokenB {
		t.Fatal("两个 project 的访问口令不该相同")
	}

	raw := intakeCall(t, ts, "GET", "/api/intake/projects", tokenA, nil, 200)
	var view intakeProjectView
	if err := json.Unmarshal(raw, &view); err != nil {
		t.Fatal(err)
	}
	if view.Key != "alpha" {
		t.Fatalf("alpha 的口令只该看见 alpha，实际 %s", view.Key)
	}
	if strings.Contains(string(raw), tokenA) {
		t.Fatal("列表接口不该把访问口令再交回去")
	}
	intakeCall(t, ts, "GET", "/api/intake/projects", tokenB, nil, 200)
	intakeCall(t, ts, "GET", "/api/intake/projects", "pk_deadbeef", nil, 401)
	intakeCall(t, ts, "GET", "/api/intake/projects", "", nil, 401)
}

func TestIntakeRequirementSubmitAndPoll(t *testing.T) {
	ts, _ := newIntakeServer(t)
	token := intakeProject(t, ts, "alpha")

	raw := intakeCall(t, ts, "POST", "/api/intake/requirements", token,
		map[string]any{"context": "加一个导出按钮", "images": []string{"shot.png"}}, 201)
	var created intakeRequirementView
	if err := json.Unmarshal(raw, &created); err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(created.Branch, "req/alpha/REQ-") {
		t.Fatalf("进链即建分支，实际 %s", created.Branch)
	}
	if created.State != ReqActive || created.CurrentNode != "assess" || created.CurrentState != StatePending {
		t.Fatalf("刚收下的需求应停在评估站待跑，实际 %+v", created)
	}

	// 拉模式：没有回告地址，提需求的人靠这条接口自己取结论。
	raw = intakeCall(t, ts, "GET", "/api/intake/requirements/"+created.ID, token, nil, 200)
	var polled intakeRequirementView
	if err := json.Unmarshal(raw, &polled); err != nil {
		t.Fatal(err)
	}
	if polled.ID != created.ID || polled.Rejected {
		t.Fatalf("拉回来的结论应与刚才那条同一条且未被拒，实际 %+v", polled)
	}

	// 别人的口令看不到这条需求。
	other := intakeProject(t, ts, "beta")
	intakeCall(t, ts, "GET", "/api/intake/requirements/"+created.ID, other, nil, 404)
	// 空需求与不存在的链条都是 400。
	intakeCall(t, ts, "POST", "/api/intake/requirements", token, map[string]any{"context": "  "}, 400)
	intakeCall(t, ts, "POST", "/api/intake/requirements", token, map[string]any{"context": "x", "chain": "nope"}, 400)
}

func TestIntakeRejectReportsBackToReporter(t *testing.T) {
	ts, store := newIntakeServer(t)
	got := make(chan intakeCallbackBody, 1)
	cb := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body intakeCallbackBody
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Errorf("回告 body 不是 JSON：%v", err)
		}
		got <- body
		w.WriteHeader(204)
	}))
	t.Cleanup(cb.Close)

	token := intakeProject(t, ts, "alpha")
	raw := intakeCall(t, ts, "POST", "/api/intake/requirements", token, map[string]any{
		"context":  "随手一问",
		"reporter": map[string]any{"kind": "webhook", "ref": "ticket-7", "callbackURL": cb.URL},
	}, 201)
	var created intakeRequirementView
	if err := json.Unmarshal(raw, &created); err != nil {
		t.Fatal(err)
	}

	call(t, ts, "POST", "/api/requirements/"+created.ID+"/nodes/assess/run", map[string]any{}, 200)
	call(t, ts, "POST", "/api/requirements/"+created.ID+"/nodes/assess/reject",
		map[string]any{"reason": "这不是需求"}, 200)

	var body intakeCallbackBody
	select {
	case body = <-got:
	case <-time.After(3 * time.Second):
		t.Fatal("整条需求被拒后应该给提需求人回告一次，3 秒内没收到")
	}
	if body.Requirement != created.ID || body.Node != "assess" || body.Reason != "这不是需求" {
		t.Fatalf("回告里应带上被拒的是哪条需求、哪一站、为什么，实际 %+v", body)
	}
	if body.State != ReqRejected {
		t.Fatalf("回告里的结论应是整条需求被拒，实际 %s", body.State)
	}

	raw = intakeCall(t, ts, "GET", "/api/intake/requirements/"+created.ID, token, nil, 200)
	var polled intakeRequirementView
	if err := json.Unmarshal(raw, &polled); err != nil {
		t.Fatal(err)
	}
	if !polled.Rejected || polled.RejectedNode != "assess" || polled.Reason != "这不是需求" {
		t.Fatalf("拉模式也要能拿到拒绝原因，实际 %+v", polled)
	}

	evs, err := store.Events(created.ID)
	if err != nil {
		t.Fatal(err)
	}
	var notify bool
	for _, e := range evs {
		if e.Action == "notify" && strings.Contains(e.Detail, "回告已送达") {
			notify = true
		}
	}
	if !notify {
		t.Fatalf("回告结果应落成一条 notify 事件，实际 %+v", evs)
	}

	req, err := store.Requirement(created.ID)
	if err != nil {
		t.Fatal(err)
	}
	var platform bool
	for _, c := range req.Node("assess").Comments {
		if c.AuthorType == "system" && strings.Contains(c.Body, "整条需求被拒") {
			platform = true
		}
	}
	if !platform {
		t.Fatalf("整条需求被拒时库里要留一条平台留言，实际 %+v", req.Node("assess").Comments)
	}
}

func TestIntakeCallbackFailureDoesNotChangeState(t *testing.T) {
	ts, store := newIntakeServer(t)
	token := intakeProject(t, ts, "alpha")
	raw := intakeCall(t, ts, "POST", "/api/intake/requirements", token, map[string]any{
		"context":  "随手一问",
		"reporter": map[string]any{"kind": "webhook", "ref": "t", "callbackURL": "http://127.0.0.1:1/nope"},
	}, 201)
	var created intakeRequirementView
	if err := json.Unmarshal(raw, &created); err != nil {
		t.Fatal(err)
	}
	call(t, ts, "POST", "/api/requirements/"+created.ID+"/nodes/assess/run", map[string]any{}, 200)
	res := call(t, ts, "POST", "/api/requirements/"+created.ID+"/nodes/assess/reject",
		map[string]any{"reason": "这不是需求"}, 200)
	if res.State != ReqRejected {
		t.Fatalf("回告送不到不该影响判定，实际 %s", res.State)
	}
	evs, err := store.Events(created.ID)
	if err != nil {
		t.Fatal(err)
	}
	var detail string
	for _, e := range evs {
		if e.Action == "notify" {
			detail = e.Detail
		}
	}
	if !strings.Contains(detail, "回告失败") {
		t.Fatalf("送不到要如实记成失败，实际 %q", detail)
	}
	req, err := store.Requirement(created.ID)
	if err != nil {
		t.Fatal(err)
	}
	if req.State != ReqRejected {
		t.Fatalf("落库的结论仍应是整条需求被拒，实际 %s", req.State)
	}
}
