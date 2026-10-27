package main

// readscope_test.go —— 「读的一侧也要守住项目边界」的判据。
//
// 写的一侧早有权力判定（nodeRun/nodeAccept/nodeReject + 提需求/建项目），读的一侧原来没有：
// 任何登录用户 GET 一遍列表就能看到所有项目的需求正文、事件流与图片。
// 边界只有一条：项目。所以读这个项目的任何东西 = 「你是这个项目的人」，管理员不在此列（管理员天生算成员）。
//
// 判据钉的是「谁能看到什么」，不是过滤代码长什么样：同一个请求换身份，答案必须变。

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
)

// readJSON 以 who 的身份 GET 一个路径，要求状态码，返回原始响应体。
func readJSON(t *testing.T, ts *httptest.Server, who, path string, want int) []byte {
	t.Helper()
	var cl *http.Client
	if who != "" {
		cl = clientOf(t, ts, who)
	}
	code, raw := exchange(t, ts, cl, "GET", path, nil)
	if code != want {
		t.Fatalf("%s GET %s 期望 %d，实际 %d：%s", who, path, want, code, raw)
	}
	return raw
}

// keysOfProjects 解出项目列表里的 key 集合。
func keysOfProjects(t *testing.T, raw []byte) []string {
	t.Helper()
	var ps []Project
	if err := json.Unmarshal(raw, &ps); err != nil {
		t.Fatalf("项目列表解不出来：%v：%s", err, raw)
	}
	out := make([]string, 0, len(ps))
	for _, p := range ps {
		out = append(out, p.Key)
	}
	return out
}

// ① 项目列表只回「我参与的项目」：成员看自己那一个，管理员看全部，谁都不参与的人看到空数组。
func TestListProjectsOnlyMine(t *testing.T) {
	ts, _, _ := newTestServer(t)
	call(t, ts, "POST", "/api/projects", map[string]any{"key": "acme", "repo": "o/acme"}, 201)
	call(t, ts, "POST", "/api/projects", map[string]any{"key": "beta", "repo": "o/beta"}, 201)
	addUser(t, ts, "lisi", "lisi-pass-1")
	grantRole(t, ts, "acme", "开发", "lisi", PowerDev)
	addUser(t, ts, "wang", "wang-pass-1")

	if got := keysOfProjects(t, readJSON(t, ts, "lisi", "/api/projects", 200)); len(got) != 1 || got[0] != "acme" {
		t.Fatalf("成员应当只看到自己参与的项目 acme，实际 %v", got)
	}
	if got := keysOfProjects(t, readJSON(t, ts, rootUser, "/api/projects", 200)); len(got) != 2 {
		t.Fatalf("管理员应当看到全部 2 个项目，实际 %v", got)
	}
	// 一个项目都不参与的人：空数组，不是 null（前端靠它区分「没权限」和「一条都没有」）。
	raw := readJSON(t, ts, "wang", "/api/projects", 200)
	if strings.TrimSpace(string(raw)) != "[]" {
		t.Fatalf("没有参与任何项目应当回 []，实际 %s", raw)
	}
}

// ② 需求列表跟着项目走：非成员看不到别人项目下的需求，管理员看全部。
func TestListRequirementsOnlyMyProjects(t *testing.T) {
	ts, _, _ := newTestServer(t)
	call(t, ts, "POST", "/api/projects", map[string]any{"key": "acme", "repo": "o/acme"}, 201)
	call(t, ts, "POST", "/api/projects", map[string]any{"key": "beta", "repo": "o/beta"}, 201)
	mine := call(t, ts, "POST", "/api/p/acme/requirements", map[string]any{"context": "acme 的需求"}, 201)
	call(t, ts, "POST", "/api/p/beta/requirements", map[string]any{"context": "beta 的需求"}, 201)
	addUser(t, ts, "lisi", "lisi-pass-1")
	grantRole(t, ts, "acme", "开发", "lisi", PowerDev)

	var got []Requirement
	raw := readJSON(t, ts, "lisi", "/api/requirements", 200)
	if err := json.Unmarshal(raw, &got); err != nil {
		t.Fatalf("需求列表解不出来：%v：%s", err, raw)
	}
	if len(got) != 1 || got[0].ID != mine.ID {
		t.Fatalf("成员应当只看到自己项目下的那 1 条需求 %s，实际 %+v", mine.ID, got)
	}
	var all []Requirement
	if err := json.Unmarshal(readJSON(t, ts, rootUser, "/api/requirements", 200), &all); err != nil {
		t.Fatal(err)
	}
	if len(all) != 2 {
		t.Fatalf("管理员应当看到全部 2 条需求，实际 %d", len(all))
	}
}

// ③ 需求详情的读也要成员资格：403 点名「谁」「哪个项目」「干什么」，成员与管理员都读得到。
func TestReadRequirementDetailNeedsMembership(t *testing.T) {
	ts, _, _ := newTestServer(t)
	call(t, ts, "POST", "/api/projects", map[string]any{"key": "acme", "repo": "o/acme"}, 201)
	call(t, ts, "POST", "/api/projects", map[string]any{"key": "beta", "repo": "o/beta"}, 201)
	mine := call(t, ts, "POST", "/api/p/acme/requirements", map[string]any{"context": "acme 的需求"}, 201)
	theirs := call(t, ts, "POST", "/api/p/beta/requirements", map[string]any{"context": "beta 的需求"}, 201)
	addUser(t, ts, "lisi", "lisi-pass-1")
	grantRole(t, ts, "acme", "开发", "lisi", PowerDev)

	var cl *http.Client = clientOf(t, ts, "lisi")
	code, raw := exchange(t, ts, cl, "GET", "/api/requirements/"+theirs.ID, nil)
	if code != 403 {
		t.Fatalf("非成员读别人项目下的需求详情应当 403，实际 %d：%s", code, raw)
	}
	for _, want := range []string{"lisi", "beta", actionViewRequirement} {
		if !strings.Contains(string(raw), want) {
			t.Fatalf("403 文案应当含 %q，实际 %s", want, raw)
		}
	}
	// 自己的项目照读，管理员照读：挡住非成员不等于把读也收紧。
	readJSON(t, ts, "lisi", "/api/requirements/"+mine.ID, 200)
	readJSON(t, ts, rootUser, "/api/requirements/"+theirs.ID, 200)
}

// ④ 顺序：需求不存在是 404，不能因为「不是你的项目」就说成 403 —— 那等于确认「有这条需求」。
func TestReadRequirementAbsentBeatsForbidden(t *testing.T) {
	ts, _, _ := newTestServer(t)
	call(t, ts, "POST", "/api/projects", map[string]any{"key": "acme", "repo": "o/acme"}, 201)
	addUser(t, ts, "lisi", "lisi-pass-1")
	grantRole(t, ts, "acme", "开发", "lisi", PowerDev)

	code, raw := exchange(t, ts, clientOf(t, ts, "lisi"), "GET", "/api/requirements/NOPE", nil)
	if code != 404 {
		t.Fatalf("需求不存在应当 404（不是 403），实际 %d：%s", code, raw)
	}
}

// ⑤ 传图是新写：非成员 403，且盘上一个字节都不留（半成品比「没传成」更难收拾）。
func TestUploadImageNeedsMembership(t *testing.T) {
	ts, _, dir := newImageServer(t)
	call(t, ts, "POST", "/api/projects", map[string]any{"key": "other", "repo": "o/other"}, 201)
	theirs := call(t, ts, "POST", "/api/p/other/requirements", map[string]any{"context": "别人的需求"}, 201)
	addUser(t, ts, "lisi", "lisi-pass-1")
	grantRole(t, ts, "demo", "开发", "lisi", PowerDev)

	code, raw := uploadRaw(t, ts, "lisi", theirs.ID, []filePart{{name: "a.png", data: pngBytes}})
	if code != 403 {
		t.Fatalf("非成员传图应当 403，实际 %d：%s", code, raw)
	}
	if !strings.Contains(string(raw), actionChangeRequirement) {
		t.Fatalf("传图被拒的文案应当是 %q，实际 %s", actionChangeRequirement, raw)
	}
	if n := countFiles(t, dir); n != 0 {
		t.Fatalf("被挡下的上传不该在盘上留文件，实际 %d 个", n)
	}
	// 成员照传：挡住非成员不等于把功能关掉。
	grantRole(t, ts, "other", "开发", "lisi", PowerDev)
	if code, raw := uploadRaw(t, ts, "lisi", theirs.ID, []filePart{{name: "a.png", data: pngBytes}}); code != 200 {
		t.Fatalf("成员传图应当 200，实际 %d：%s", code, raw)
	}
}

// ⑥ 读图与删图同一条边界：非成员两样都 403，且删不掉（文件还在）。
func TestImageReadAndDeleteNeedMembership(t *testing.T) {
	ts, _, dir := newImageServer(t)
	call(t, ts, "POST", "/api/projects", map[string]any{"key": "other", "repo": "o/other"}, 201)
	theirs := call(t, ts, "POST", "/api/p/other/requirements", map[string]any{"context": "别人的需求"}, 201)
	got := uploadOK(t, ts, theirs.ID, []filePart{{name: "a.png", data: pngBytes}})
	addUser(t, ts, "lisi", "lisi-pass-1")
	grantRole(t, ts, "demo", "开发", "lisi", PowerDev)

	code, raw := exchange(t, ts, clientOf(t, ts, "lisi"), "GET", got.Images[0], nil)
	if code != 403 || !strings.Contains(string(raw), actionViewRequirement) {
		t.Fatalf("非成员读图应当 403 %q，实际 %d：%s", actionViewRequirement, code, raw)
	}
	code, raw = exchange(t, ts, clientOf(t, ts, "lisi"), "DELETE", got.Images[0], nil)
	if code != 403 || !strings.Contains(string(raw), actionChangeRequirement) {
		t.Fatalf("非成员删图应当 403 %q，实际 %d：%s", actionChangeRequirement, code, raw)
	}
	if n := countFiles(t, filepath.Join(dir, theirs.ID)); n != 1 {
		t.Fatalf("被挡下的删除不该动到磁盘，实际还剩 %d 个文件", n)
	}
	// 管理员照读：图没被藏起来，只是不给非成员看。
	res, err := clientOf(t, ts, rootUser).Get(ts.URL + got.Images[0])
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	if res.StatusCode != 200 {
		t.Fatalf("管理员读图应当 200，实际 %d", res.StatusCode)
	}
}
