package main

import (
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"
)

// 重启一站的接口：POST /api/requirements/{id}/nodes/{key}/restart，body 里可能有 reason。
// 语义按用户裁决：重启就是「把这一站的活再干一遍」，不是拒绝也不是确认。
// 容器站退回待开始后当场重跑；空节点（dev / merge）只退回待开始等人自己在分支上重做。

// restartAs 以 who 的身份重启一站，断言状态码并解出需求（>=400 时返回 nil）。
func restartAs(t *testing.T, ts *httptest.Server, who, id, node string, body any, want int) *Requirement {
	t.Helper()
	return callAs(t, ts, "POST", "/api/requirements/"+id+"/nodes/"+node+"/restart", who, body, want)
}

// fetchReq 读一条需求的当前状态（GET 单个需求的响应是 {requirement, events} 的信封）。
func fetchReq(t *testing.T, ts *httptest.Server, id string) *Requirement {
	t.Helper()
	code, raw := exchange(t, ts, clientOf(t, ts, rootUser), "GET", "/api/requirements/"+id, nil)
	if code != 200 {
		t.Fatalf("读需求期望 200，实际 %d：%s", code, raw)
	}
	var env struct {
		Requirement Requirement `json:"requirement"`
	}
	if err := json.Unmarshal(raw, &env); err != nil {
		t.Fatal(err)
	}
	return &env.Requirement
}

// acceptedThrough 把需求推到「assess 与 dev 都已通过」的位置，返回需求。
func acceptedThrough(t *testing.T, ts *httptest.Server) *Requirement {
	t.Helper()
	req := submit(t, ts, "加一个导出按钮")
	call(t, ts, "POST", "/api/requirements/"+req.ID+"/nodes/assess/run", map[string]any{}, 200)
	call(t, ts, "POST", "/api/requirements/"+req.ID+"/nodes/assess/accept", map[string]any{"comment": "评估可以"}, 200)
	call(t, ts, "POST", "/api/requirements/"+req.ID+"/nodes/dev/run", map[string]any{}, 200)
	return call(t, ts, "POST", "/api/requirements/"+req.ID+"/nodes/dev/accept", map[string]any{}, 200)
}

// 已通过的站重启是破坏性的：不给理由必须 400，理由是这一站的破格成本。
func TestRestartAcceptedNodeNeedsReason(t *testing.T) {
	ts, _ := newRoleServer(t)
	req := acceptedThrough(t, ts)
	for _, body := range []map[string]any{{}, {"reason": ""}, {"reason": "   "}, {"body": "\t\n"}} {
		raw := callRaw(t, ts, rootUser, "POST", "/api/requirements/"+req.ID+"/nodes/assess/restart", body, 400)
		if !strings.Contains(raw, "重启已通过的站必须说明理由") {
			t.Fatalf("空理由应当点名「重启已通过的站必须说明理由」，实际 %s", raw)
		}
	}
	// 一次失败不该改动任何状态：assess 仍是已通过，dev 也没被退。
	got := fetchReq(t, ts, req.ID)
	if got.Node("assess").State != StateAccepted || got.Node("dev").State != StateAccepted {
		t.Fatalf("400 之后状态不该动，实际 assess=%s dev=%s", got.Node("assess").State, got.Node("dev").State)
	}
}

// 已通过的站带了理由：本站退回待开始，后面基于它的站一起退回，历史全留。
func TestRestartAcceptedNodeRollsBackLaterNodes(t *testing.T) {
	ts, _ := newRoleServer(t)
	req := acceptedThrough(t, ts)
	before := req.Node("dev")
	got := restartAs(t, ts, rootUser, req.ID, "assess", map[string]any{"reason": "评估漏了迁移步骤"}, 200)
	if got == nil {
		t.Fatal("带理由的重启应当 200")
	}
	// assess 是容器站：退回待开始之后当场重跑，所以落点是「待审」，attempt 追加成第 2 次。
	if s := got.Node("assess").State; s != StateAwaitingReview {
		t.Fatalf("assess 退回后应重跑并停在待审，实际 %s", s)
	}
	if n := len(got.Node("assess").Attempts); n != 2 {
		t.Fatalf("重跑应当追加 attempt 到 2，实际 %d", n)
	}
	if s := got.Node("dev").State; s != StatePending {
		t.Fatalf("已通过的 dev 应一起退回待开始，实际 %s", s)
	}
	if got.CurrentIndex() != 0 {
		t.Fatalf("位置应回到第 1 站，实际 %d", got.CurrentIndex())
	}
	if got.State != ReqActive {
		t.Fatalf("整条需求应回到 active，实际 %s", got.State)
	}
	// 历史不清：dev 之前那次执行的记录与评论都还在。
	if len(got.Node("dev").Comments) < len(before.Comments) {
		t.Fatalf("重启不该删评论：之前 %d 条，现在 %d 条", len(before.Comments), len(got.Node("dev").Comments))
	}
	// 平台在这次重启下留了话，理由在里面。
	found := false
	for _, cm := range got.Node("assess").Comments {
		if cm.AuthorType == "system" && strings.Contains(cm.Body, "评估漏了迁移步骤") {
			if !strings.Contains(cm.Body, "重启第 1 站（assess）") {
				t.Fatalf("系统评论应当点名第几站，实际 %s", cm.Body)
			}
			if !strings.Contains(cm.Body, "后面的 1 站一起退回待开始") {
				t.Fatalf("系统评论应说清后续站一起退了，实际 %s", cm.Body)
			}
			found = true
		}
	}
	if !found {
		t.Fatalf("重启应当留系统评论，实际 %s", got.Node("assess").Comments)
	}
}

// 容器站重启＝当场再跑一遍：attempt 追加而不是覆盖。
func TestRestartContainerNodeReruns(t *testing.T) {
	ts, _ := newRoleServer(t)
	req := submit(t, ts, "加一个导出按钮")
	ran := call(t, ts, "POST", "/api/requirements/"+req.ID+"/nodes/assess/run", map[string]any{}, 200)
	if n := len(ran.Node("assess").Attempts); n != 1 {
		t.Fatalf("第一次跑应有 1 次 attempt，实际 %d", n)
	}
	got := restartAs(t, ts, rootUser, req.ID, "assess", map[string]any{}, 200)
	if got == nil {
		t.Fatal("当前站 restart 应当 200")
	}
	if n := len(got.Node("assess").Attempts); n != 2 {
		t.Fatalf("重启容器站应当再跑一次（attempt 追加到 2），实际 %d", n)
	}
	if s := got.Node("assess").State; s != StateAwaitingReview {
		t.Fatalf("重跑之后应回到待审，实际 %s", s)
	}
	if !strings.Contains(got.Node("assess").Comments[0].Body, "【假执行】") {
		t.Fatalf("第一次执行的评论不该被清掉，实际 %s", got.Node("assess").Comments[0].Body)
	}
}

// 空节点没有活可跑：重启只把它退回待开始，不产生执行记录。
func TestRestartEmptyNodeOnlyResets(t *testing.T) {
	ts, _ := newRoleServer(t)
	req := submit(t, ts, "加一个导出按钮")
	call(t, ts, "POST", "/api/requirements/"+req.ID+"/nodes/assess/run", map[string]any{}, 200)
	call(t, ts, "POST", "/api/requirements/"+req.ID+"/nodes/assess/accept", map[string]any{}, 200)
	running := call(t, ts, "POST", "/api/requirements/"+req.ID+"/nodes/dev/run", map[string]any{}, 200)
	if s := running.Node("dev").State; s != StateRunning {
		t.Fatalf("dev 动手后应 running，实际 %s", s)
	}
	got := restartAs(t, ts, rootUser, req.ID, "dev", map[string]any{}, 200)
	if got == nil {
		t.Fatal("空节点 restart 应当 200")
	}
	if s := got.Node("dev").State; s != StatePending {
		t.Fatalf("空节点重启应退回待开始，实际 %s", s)
	}
	if n := len(got.Node("dev").Attempts); n != 0 {
		t.Fatalf("空节点不该有执行记录，实际 %d 条", n)
	}
}

// 被驳回的站重启不需要理由：它本来就没通过过，退回去重做不是破坏性的。
func TestRestartRejectedNodeNeedsNoReason(t *testing.T) {
	ts, _ := newRoleServer(t)
	req := submit(t, ts, "加一个导出按钮")
	call(t, ts, "POST", "/api/requirements/"+req.ID+"/nodes/assess/run", map[string]any{}, 200)
	call(t, ts, "POST", "/api/requirements/"+req.ID+"/nodes/assess/accept", map[string]any{}, 200)
	call(t, ts, "POST", "/api/requirements/"+req.ID+"/nodes/dev/run", map[string]any{}, 200)
	rejected := call(t, ts, "POST", "/api/requirements/"+req.ID+"/nodes/dev/reject", map[string]any{"reason": "分支上有冲突"}, 200)
	if s := rejected.Node("dev").State; s != StateRejected {
		t.Fatalf("驳回后 dev 应 rejected，实际 %s", s)
	}
	got := restartAs(t, ts, rootUser, req.ID, "dev", map[string]any{}, 200)
	if got == nil {
		t.Fatal("被驳回的站重启不需要理由")
	}
	if s := got.Node("dev").State; s != StatePending {
		t.Fatalf("退回待开始，实际 %s", s)
	}
}

// 还没走到的站没有「重启」可言。
func TestRestartFutureNodeConflicts(t *testing.T) {
	ts, _ := newRoleServer(t)
	req := submit(t, ts, "加一个导出按钮")
	raw := callRaw(t, ts, rootUser, "POST", "/api/requirements/"+req.ID+"/nodes/release/restart", map[string]any{}, 409)
	if !strings.Contains(raw, "还没到这一站") || !strings.Contains(raw, "release") {
		t.Fatalf("重启未来的站应 409 并点名，实际 %s", raw)
	}
}

// 整条被拒之后单站重启讲不清楚，直接 409。
func TestRestartOnRejectedRequirementConflicts(t *testing.T) {
	ts, _ := newRoleServer(t)
	req := submit(t, ts, "加一个导出按钮")
	call(t, ts, "POST", "/api/requirements/"+req.ID+"/nodes/assess/run", map[string]any{}, 200)
	whole := call(t, ts, "POST", "/api/requirements/"+req.ID+"/nodes/assess/reject", map[string]any{"reason": "这需求不成立"}, 200)
	if whole.State != ReqRejected {
		t.Fatalf("第一站被拒应拒掉整条，实际 %s", whole.State)
	}
	raw := callRaw(t, ts, rootUser, "POST", "/api/requirements/"+req.ID+"/nodes/assess/restart", map[string]any{}, 409)
	if !strings.Contains(raw, "整条需求已被拒") {
		t.Fatalf("整条被拒时重启应 409 并说明，实际 %s", raw)
	}
}

// 重启按的是「确认/拒绝」那一档权力：能按这一站的人才能重启这一站。
func TestRestartNeedsReviewPower(t *testing.T) {
	ts, _ := newRoleServer(t)
	req := submit(t, ts, "加一个导出按钮")
	addUser(t, ts, "路人", "passer-pass-1")
	grantRole(t, ts, "demo", "开发", "路人", PowerDev)
	raw := runAt(t, ts, req.ID, "assess", "restart", "路人")
	if !strings.Contains(raw, "路人") || !strings.Contains(raw, PowerReview) {
		t.Fatalf("缺 review 权力时应点名角色与权力，实际 %s", raw)
	}
}

// 没登录一律 401。
func TestRestartNeedsLogin(t *testing.T) {
	ts, _ := newRoleServer(t)
	req := submit(t, ts, "加一个导出按钮")
	raw := callRaw(t, ts, "", "POST", "/api/requirements/"+req.ID+"/nodes/assess/restart", map[string]any{}, 401)
	if !strings.Contains(raw, needLoginText) {
		t.Fatalf("未登录应回 needLoginText，实际 %s", raw)
	}
}

// 重启之后还能再跑：退回待开始不是死状态。
func TestRestartThenRunAgain(t *testing.T) {
	ts, _ := newRoleServer(t)
	req := submit(t, ts, "加一个导出按钮")
	call(t, ts, "POST", "/api/requirements/"+req.ID+"/nodes/assess/run", map[string]any{}, 200)
	call(t, ts, "POST", "/api/requirements/"+req.ID+"/nodes/assess/accept", map[string]any{}, 200)
	call(t, ts, "POST", "/api/requirements/"+req.ID+"/nodes/dev/run", map[string]any{}, 200)
	restartAs(t, ts, rootUser, req.ID, "dev", map[string]any{}, 200)
	got := call(t, ts, "POST", "/api/requirements/"+req.ID+"/nodes/dev/run", map[string]any{}, 200)
	if s := got.Node("dev").State; s != StateRunning {
		t.Fatalf("重启后再跑应能跑起来，实际 %s", s)
	}
}

// 重启留 event：action=restart，from/to 记清从哪退到哪。
func TestRestartWritesEvent(t *testing.T) {
	ts, store := newRoleServer(t)
	req := acceptedThrough(t, ts)
	restartAs(t, ts, rootUser, req.ID, "assess", map[string]any{"reason": "漏了迁移步骤"}, 200)
	evs, err := store.Events(req.ID)
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, ev := range evs {
		if ev.Action == "restart" && ev.Node == "assess" {
			if ev.From != StateAccepted || ev.To != StatePending {
				t.Fatalf("restart event 的 from/to 应是 accepted→pending，实际 %s→%s", ev.From, ev.To)
			}
			if !strings.Contains(ev.Detail, "漏了迁移步骤") {
				t.Fatalf("event 里应带理由，实际 %s", ev.Detail)
			}
			found = true
		}
	}
	if !found {
		t.Fatalf("重启应当留一条 action=restart 的 event，实际 %v", evs)
	}
}
