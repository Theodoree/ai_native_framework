package main

// permissions_test.go —— 「建项目、提需求、建管理员账号」三处资格的判据。
//
// 三条都是 t53 写文档时核出的口径不一致（代码比文档松），裁决是「权限的边界不许有例外」：
// 项目只能管理员建、需求只能成员提、管理员可以在建账号时指定。
// 判据钉的是「谁被挡住」和「挡住之后库里有没有半成品」，不是实现细节。

import (
	"encoding/json"
	"strings"
	"testing"
)

// projectCount 读库里现有项目数：用来证「被挡下的请求没有落半成品」。
func projectCount(t *testing.T, store Store) int {
	t.Helper()
	ps, err := store.Projects()
	if err != nil {
		t.Fatal(err)
	}
	return len(ps)
}

// ① 建项目是管理员动作：普通账号 403（文案是那唯一一句），管理员 201，被挡下的请求不落库。
func TestCreateProjectNeedsAdmin(t *testing.T) {
	ts, store, _ := newTestServer(t)
	addUser(t, ts, "lisi", "lisi-pass-1")
	before := projectCount(t, store)

	code, raw := exchange(t, ts, clientOf(t, ts, "lisi"), "POST", "/api/projects",
		map[string]any{"key": "acme", "repo": "o/acme"})
	if code != 403 {
		t.Fatalf("普通账号建项目应当 403，实际 %d：%s", code, raw)
	}
	if !strings.Contains(string(raw), adminOnlyText) {
		t.Fatalf("普通账号建项目应当收到 %q，实际 %s", adminOnlyText, raw)
	}
	// 被挡之后库里不能多一条：半成品比「没建成」更难收拾（同一个 key 以后谁都建不了）。
	if after := projectCount(t, store); after != before {
		t.Fatalf("被挡下的建项目不该落库：之前 %d 条，之后 %d 条", before, after)
	}
	if _, err := store.Project("acme"); err == nil {
		t.Fatalf("被挡下的项目不该在库里存在")
	}
	// 管理员建同一个 key：201 —— 挡住普通账号不等于这个 key 被占住。
	callRaw(t, ts, rootUser, "POST", "/api/projects", map[string]any{"key": "acme", "repo": "o/acme"}, 201)
	if after := projectCount(t, store); after != before+1 {
		t.Fatalf("管理员建项目之后应当多一条：之前 %d 条，之后 %d 条", before, after)
	}
}

// ② 提需求要成员资格：陌生人 403（文案点名人和项目），授予任一权力的成员 201，管理员 201。
// 项目不存在仍然 404 —— 这道门排在 404 之后，不能把「没这个项目」说成「你没资格」。
func TestCreateRequirementNeedsMembership(t *testing.T) {
	ts, _, _ := newTestServer(t)
	call(t, ts, "POST", "/api/projects", map[string]any{"key": "acme", "repo": "o/acme"}, 201)
	addUser(t, ts, "lisi", "lisi-pass-1")
	path := "/api/p/acme/requirements"

	code, raw := exchange(t, ts, clientOf(t, ts, "lisi"), "POST", path,
		map[string]any{"context": "加一个导出按钮"})
	if code != 403 {
		t.Fatalf("非成员提需求应当 403，实际 %d：%s", code, raw)
	}
	if !strings.Contains(string(raw), "lisi") || !strings.Contains(string(raw), "acme") {
		t.Fatalf("403 应当点名人和项目，实际 %s", raw)
	}
	// 授予 dev 权力就够：成员资格看「有没有任一权力」，不是「有没有这一站的权力」。
	grantRole(t, ts, "acme", "开发", "lisi", PowerDev)
	callAs(t, ts, "POST", path, "lisi", map[string]any{"context": "加一个导出按钮"}, 201)
	// 管理员不问成员资格：管理员天生算任何项目的成员。
	call(t, ts, "POST", path, map[string]any{"context": "管理员提的"}, 201)
	// 项目不存在：404，且不是 403（门在 404 之后）。
	callAs(t, ts, "POST", "/api/p/nope/requirements", "lisi", map[string]any{"context": "x"}, 404)
}

// ③ 建账号时可以指定 admin：带 admin:true 建出来的账号能建项目，默认（不写）建出来的不能。
// 仍然只有管理员能调这条接口 —— 本期不做「把已有账号升级为管理员」。
func TestCreateUserCanBeAdminAtCreation(t *testing.T) {
	ts, store, _ := newTestServer(t)
	raw := callRaw(t, ts, rootUser, "POST", "/api/users",
		map[string]any{"username": "boss", "password": "boss-pass-1", "admin": true}, 201)
	var boss User
	if err := json.Unmarshal([]byte(raw), &boss); err != nil {
		t.Fatal(err)
	}
	if !boss.Admin {
		t.Fatalf("admin:true 建出来的账号应当带管理员标记，实际 %s", raw)
	}
	if strings.Contains(raw, "argon2id") || strings.Contains(raw, "passwordHash") {
		t.Fatalf("建账号的响应不该回显密码哈希，实际 %s", raw)
	}
	loginAs(t, ts, "boss", "boss-pass-1")
	callAs(t, ts, "POST", "/api/projects", "boss", map[string]any{"key": "acme", "repo": "o/acme"}, 201)

	// body 不写 admin：默认 false，建出来的人建不了项目。
	addUser(t, ts, "lisi", "lisi-pass-1")
	if u, err := store.UserByName("lisi"); err != nil || u.Admin {
		t.Fatalf("不写 admin 建出来的账号应当是普通账号，实际 %+v / %v", u, err)
	}
	code, body := exchange(t, ts, clientOf(t, ts, "lisi"), "POST", "/api/projects",
		map[string]any{"key": "lisi-proj", "repo": "o/x"})
	if code != 403 || !strings.Contains(string(body), adminOnlyText) {
		t.Fatalf("普通账号建项目应当 403 %q，实际 %d：%s", adminOnlyText, code, body)
	}
	// 建账号这条接口本身还是管理员的：普通账号连给自己人加号都不行。
	if got := callRaw(t, ts, "lisi", "POST", "/api/users",
		map[string]any{"username": "sneaky", "password": "sneaky-pass-1", "admin": true}, 403); !strings.Contains(got, adminOnlyText) {
		t.Fatalf("普通账号建账号应当收到 %q，实际 %s", adminOnlyText, got)
	}
	if _, err := store.UserByName("sneaky"); err == nil {
		t.Fatalf("被挡下的建账号不该落库")
	}
	// 账号列表里能看到这把标记：列表是唯一能看到 admin 的地方。
	var users []User
	if err := json.Unmarshal([]byte(callRaw(t, ts, rootUser, "GET", "/api/users", nil, 200)), &users); err != nil {
		t.Fatal(err)
	}
	foundBoss := false
	for _, u := range users {
		if u.Username == "boss" && u.Admin {
			foundBoss = true
		}
	}
	if !foundBoss {
		t.Fatalf("账号列表应当回显 boss 且带管理员标记，实际 %+v", users)
	}
}

// ④ 三条门的顺序：401（没身份）→ 404（项目不存在）→ 403（不是成员）。
// 顺序错了文案就撒谎：把「没登录」说成「没资格」，或把「没这个项目」说成「你不是成员」。
func TestRequirementGateOrder(t *testing.T) {
	ts, _, _ := newTestServer(t)
	call(t, ts, "POST", "/api/projects", map[string]any{"key": "acme", "repo": "o/acme"}, 201)
	// 匿名：401，压在 404 前面（中间件拦掉，走不到项目查询）。
	callAnon(t, ts, "POST", "/api/p/nope/requirements", map[string]any{"context": "x"}, 401)
	// 有身份但项目不存在：404。
	addUser(t, ts, "lisi", "lisi-pass-1")
	callAs(t, ts, "POST", "/api/p/nope/requirements", "lisi", map[string]any{"context": "x"}, 404)
	// 项目在、人不在：403。
	code, raw := exchange(t, ts, clientOf(t, ts, "lisi"), "POST", "/api/p/acme/requirements",
		map[string]any{"context": "x"})
	if code != 403 {
		t.Fatalf("非成员在存在的项目里提需求应当 403，实际 %d：%s", code, raw)
	}
}
