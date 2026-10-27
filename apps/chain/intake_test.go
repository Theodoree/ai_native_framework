package main

import (
	"database/sql"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// 接入层现在的身份是「登录态或 API 密钥，且要是这个项目的成员」。
// reporter 是测试里那个「平台外提需求的人」：普通账号，靠被授予角色成为成员。
const reporterUser = "reporter"
const reporterPass = "reporter-password-1"
const outsiderUser = "outsider"
const outsiderPass = "outsider-password-1"

// newIntakeServer 起一个服务，并建好 reporter 与 outsider 两个普通账号。
func newIntakeServer(t *testing.T) (*httptest.Server, Store) {
	t.Helper()
	ts, store, _ := newTestServer(t)
	addUser(t, ts, reporterUser, reporterPass)
	addUser(t, ts, outsiderUser, outsiderPass)
	return ts, store
}

// intakeProject 以管理员身份建一个 project，并把 reporter 放进它的一个角色里。
// 「是不是成员」看的是有没有角色，所以给一个 review 权力就够提需求。
func intakeProject(t *testing.T, ts *httptest.Server, key string) {
	t.Helper()
	call(t, ts, "POST", "/api/projects", map[string]any{"key": key, "repo": "/tmp/" + key}, 201)
	grantRole(t, ts, key, key+"-审核员", reporterUser, PowerReview)
}

// intakeCall 以 who 的身份发请求（who 为空表示匿名），只断言状态码并返回原始响应体。
func intakeCall(t *testing.T, ts *httptest.Server, who, method, path string, body any, want int) []byte {
	t.Helper()
	var cl *http.Client
	if who != "" {
		cl = clientOf(t, ts, who)
	}
	code, raw := exchange(t, ts, cl, method, path, body)
	if code != want {
		t.Fatalf("%s %s 期望 %d，实际 %d：%s", method, path, want, code, raw)
	}
	return raw
}

// 老库既没有接入层那几列，也没有账号/会话/授予那几张表：
// CREATE TABLE IF NOT EXISTS 不会补列，得靠 migrate 一路补齐。
func TestOpenStoreMigratesOldDatabase(t *testing.T) {
	path := filepath.Join(t.TempDir(), "old.db")
	db, err := sql.Open("sqlite", "file:"+path)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`CREATE TABLE projects (
  key TEXT PRIMARY KEY, name TEXT NOT NULL, repo TEXT NOT NULL,
  default_branch TEXT NOT NULL, chains TEXT NOT NULL, created_at TEXT NOT NULL)`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`INSERT INTO projects VALUES ('old','old','/tmp/old','main','[]','2026-01-01T00:00:00Z')`); err != nil {
		t.Fatal(err)
	}
	// 老库里的 roles 表还带着「口令」列，而且是 NOT NULL：搬过来的第一件事就是把它放开。
	if _, err := db.Exec(`CREATE TABLE roles (id TEXT PRIMARY KEY, project_key TEXT NOT NULL,
  name TEXT NOT NULL, powers TEXT NOT NULL, token TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL)`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`INSERT INTO roles VALUES ('r-old','old','老角色','["review"]','rl_legacy','2026-01-01T00:00:00Z')`); err != nil {
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
	if p.Key != "old" || p.DefaultBranch != "main" {
		t.Fatalf("老库的 project 应当原样读回来，实际 %+v", p)
	}
	if err := store.SaveProject(p); err != nil {
		t.Fatalf("老库的 project 应当还能写回去：%v", err)
	}
	// 角色不再有口令列：同一个 id 覆盖写一次不该撞唯一约束。
	if err := store.SaveRole(Role{ID: "r-old", ProjectKey: "old", Name: "老角色",
		Powers: []string{PowerReview}, CreatedAt: time.Now()}); err != nil {
		t.Fatalf("口令列放开之后角色应当能不带口令写进去：%v", err)
	}
	if _, err := store.Role("r-old"); err != nil {
		t.Fatal(err)
	}
	// 新表也要在老库上建出来。
	if n, err := store.CountUsers(); err != nil || n != 0 {
		t.Fatalf("老库补出来的账号表应当是空的：%v %d", err, n)
	}
}

func TestIntakeNeedsLogin(t *testing.T) {
	ts, _ := newIntakeServer(t)
	intakeProject(t, ts, "alpha")
	raw := intakeCall(t, ts, "", "POST", "/api/intake/requirements",
		map[string]any{"project": "alpha", "context": "加个按钮"}, 401)
	if !strings.Contains(string(raw), "没有登录") {
		t.Fatalf("没登录应当说要先登录，实际 %s", raw)
	}
	intakeCall(t, ts, "", "GET", "/api/intake/requirements/x", nil, 401)
}

func TestIntakeNeedsMembership(t *testing.T) {
	ts, _ := newIntakeServer(t)
	intakeProject(t, ts, "alpha")
	raw := intakeCall(t, ts, outsiderUser, "POST", "/api/intake/requirements",
		map[string]any{"project": "alpha", "context": "加个按钮"}, 403)
	if !strings.Contains(string(raw), "不是 alpha 的成员") {
		t.Fatalf("不是成员应当点名 project，实际 %s", raw)
	}
	// 成员才谈得上「这个 project 存不存在」之外的判断。
	intakeCall(t, ts, reporterUser, "POST", "/api/intake/requirements", map[string]any{"context": "x"}, 400)
}

func TestIntakeRequirementSubmitAndPoll(t *testing.T) {
	ts, _ := newIntakeServer(t)
	intakeProject(t, ts, "alpha")

	raw := intakeCall(t, ts, reporterUser, "POST", "/api/intake/requirements",
		map[string]any{"project": "alpha", "context": "加一个导出按钮", "images": []string{"shot.png"}}, 201)
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
	raw = intakeCall(t, ts, reporterUser, "GET", "/api/intake/requirements/"+created.ID, nil, 200)
	var polled intakeRequirementView
	if err := json.Unmarshal(raw, &polled); err != nil {
		t.Fatal(err)
	}
	if polled.ID != created.ID || polled.Rejected {
		t.Fatalf("拉回来的结论应与刚才那条同一条且未被拒，实际 %+v", polled)
	}

	// 不是成员的人看不到这条需求。
	intakeCall(t, ts, outsiderUser, "GET", "/api/intake/requirements/"+created.ID, nil, 403)
	// 空需求、不存在的链条、不存在的 project 各是 400/400/404。
	intakeCall(t, ts, reporterUser, "POST", "/api/intake/requirements", map[string]any{"project": "alpha", "context": "  "}, 400)
	intakeCall(t, ts, reporterUser, "POST", "/api/intake/requirements", map[string]any{"project": "alpha", "context": "x", "chain": "nope"}, 400)
	intakeCall(t, ts, reporterUser, "GET", "/api/intake/requirements/NOPE", nil, 404)
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

	intakeProject(t, ts, "alpha")
	raw := intakeCall(t, ts, reporterUser, "POST", "/api/intake/requirements", map[string]any{
		"project":  "alpha",
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

	raw = intakeCall(t, ts, reporterUser, "GET", "/api/intake/requirements/"+created.ID, nil, 200)
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
	intakeProject(t, ts, "alpha")
	raw := intakeCall(t, ts, reporterUser, "POST", "/api/intake/requirements", map[string]any{
		"project":  "alpha",
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
