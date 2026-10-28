package main

// usercli_test.go —— 账号只能从命令行/管理员来，权力只由节点类型决定。
//
// 这两条是同一个产品口径的两面：没有「首次注册」这回事，也没有「逐站覆盖权力」这回事。
// 用例钉的是「删掉之后行为确实变了」，而不是「函数还在」：
//   - chain user add 建出来的账号能登录、能当场当管理员；重名与短口令必须建不成
//   - PowerForNode 只看类型：老库里 power 列写着别的值也不影响判定

import (
	"database/sql"
	"net/http/httptest"
	"path/filepath"
	"testing"
)

// cliStore 打开一个临时库，用于跑命令行子命令后再从代码里查。
func cliDBPath(t *testing.T) string {
	t.Helper()
	return filepath.Join(t.TempDir(), "chain.db")
}

// TestUserAddCommandCreatesAdmin 钉「第一个管理员从命令行来」：
// 命令成功、库里确实有这个人、而且是管理员、而且口令真能用。
func TestUserAddCommandCreatesAdmin(t *testing.T) {
	path := cliDBPath(t)
	code := runUserAddCommand([]string{"-username", "root", "-password", "rootpass123", "-admin", "-db", path})
	if code != 0 {
		t.Fatalf("建管理员应当退 0，实际 %d", code)
	}
	store, err := OpenStore("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	u, err := store.UserByName("root")
	if err != nil {
		t.Fatalf("命令行建完，库里应当有 root：%v", err)
	}
	if !u.Admin {
		t.Fatal("-admin 建出来的账号必须是管理员")
	}
	if !verifyPassword(u.PasswordHash, "rootpass123") {
		t.Fatal("命令行写进去的口令必须能验过（哈希只有一处实现）")
	}
}

// TestUserAddCommandMadeAccountCanLogIn 把命令行与 HTTP 接起来：
// 只有「建出来的账号能登录」才算真的把第一个管理员造出来了。
func TestUserAddCommandMadeAccountCanLogIn(t *testing.T) {
	path := cliDBPath(t)
	if code := runUserAddCommand([]string{"-username", "root", "-password", "rootpass123", "-admin", "-db", path}); code != 0 {
		t.Fatalf("建管理员应当退 0，实际 %d", code)
	}
	store, err := OpenStore("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	ts := httptest.NewServer(NewServer(store, FakeExecutor{}).Handler())
	defer ts.Close()
	code, raw := exchange(t, ts, freshClient(t), "POST", "/api/login", map[string]any{"username": "root", "password": "rootpass123"})
	if code != 200 {
		t.Fatalf("命令行建的账号应当能登录，实际 %d：%s", code, raw)
	}
}

// TestUserAddCommandRejectsDuplicate 钉重名：退出码 1，库里还是只有那一个账号。
func TestUserAddCommandRejectsDuplicate(t *testing.T) {
	path := cliDBPath(t)
	if code := runUserAddCommand([]string{"-username", "root", "-password", "rootpass123", "-db", path}); code != 0 {
		t.Fatalf("第一次建账号应当退 0，实际 %d", code)
	}
	if code := runUserAddCommand([]string{"-username", "root", "-password", "another-pass-1", "-db", path}); code != 1 {
		t.Fatalf("重名应当退 1，实际 %d", code)
	}
	store, err := OpenStore("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	if n, err := store.CountUsers(); err != nil || n != 1 {
		t.Fatalf("重名被拒之后库里应当还是 1 个账号，实际 %d（%v）", n, err)
	}
}

// TestUserAddCommandRejectsShortPassword 钉口令规则与接口同一处：短口令退 1，不落账号。
func TestUserAddCommandRejectsShortPassword(t *testing.T) {
	path := cliDBPath(t)
	if code := runUserAddCommand([]string{"-username", "root", "-password", "short", "-db", path}); code != 1 {
		t.Fatalf("短口令应当退 1，实际 %d", code)
	}
	store, err := OpenStore("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	if n, err := store.CountUsers(); err != nil || n != 0 {
		t.Fatalf("口令不合规不该落账号，实际 %d（%v）", n, err)
	}
}

// TestUserAddDefaultsToPlainUser 钉默认：不写 -admin 建的是普通账号（不能提权）。
func TestUserAddDefaultsToPlainUser(t *testing.T) {
	path := cliDBPath(t)
	if code := runUserAddCommand([]string{"-username", "lisi", "-password", "lisi-pass-1", "-db", path}); code != 0 {
		t.Fatalf("建普通账号应当退 0，实际 %d", code)
	}
	store, err := OpenStore("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	u, err := store.UserByName("lisi")
	if err != nil {
		t.Fatal(err)
	}
	if u.Admin {
		t.Fatal("不写 -admin 建出来的是普通账号")
	}
}

// TestUserSubcommandDispatch 钉分派：不认识的字命令是参数错（退 2），空参数打用法。
func TestUserSubcommandDispatch(t *testing.T) {
	if code := runUserCommand(nil); code != 2 {
		t.Fatalf("空参数应当退 2（打用法），实际 %d", code)
	}
	if code := runUserCommand([]string{"nope"}); code != 2 {
		t.Fatalf("不认识的子命令应当退 2，实际 %d", code)
	}
	if code := runUserCommand([]string{"help"}); code != 0 {
		t.Fatalf("help 应当退 0，实际 %d", code)
	}
}

// TestPowerForNodeComesFromTypeOnly 钉「权力只由类型推导」：六类节点各给一个权力，
// 空节点 nil 给空串（调用方按判不了处理）。
func TestPowerForNodeComesFromTypeOnly(t *testing.T) {
	cases := []struct{ nodeType, want string }{
		{TypeCreate, PowerDev},
		{TypeAssess, PowerReview},
		{TypeDev, PowerDev},
		{TypeCrossTest, PowerTest},
		{TypeMerge, PowerReview},
		{TypeRelease, PowerRelease},
	}
	for _, c := range cases {
		if got := PowerForNode(&Node{Type: c.nodeType}); got != c.want {
			t.Fatalf("%s 站要的权力应当是 %s，实际 %s", c.nodeType, c.want, got)
		}
	}
	if got := PowerForNode(nil); got != "" {
		t.Fatalf("nil 节点应当给空串，实际 %q", got)
	}
}

// TestNodePowerColumnIsNotRead 钉「老库里的 power 列不再影响判定」：
// nodes 表还留着这一列（不 DROP COLUMN 是避免破坏性迁移），但哪怕值写着 release，
// assess 站的权力也必须还是 review —— 权力只由节点类型推导。
func TestNodePowerColumnIsNotRead(t *testing.T) {
	ts, store, dbPath := newTestServer(t)
	setupProject(t, ts)
	req := call(t, ts, "POST", "/api/p/demo/requirements", map[string]any{"context": "把 power 列改成别的值"}, 201)
	if got := PowerForNode(req.Node("assess")); got != PowerReview {
		t.Fatalf("assess 站的权力应当是 review，实际 %s", got)
	}
	// 直接改库里的死列：代码不读它，所以判定不该变。
	db, err := sql.Open("sqlite", dbPath)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if _, err := db.Exec("UPDATE nodes SET power = ? WHERE req_id = ?", PowerRelease, req.ID); err != nil {
		t.Fatal(err)
	}
	again, err := store.Requirement(req.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got := PowerForNode(again.Node("assess")); got != PowerReview {
		t.Fatalf("power 列已经不读了，判定应当仍是 review，实际 %s", got)
	}
}
