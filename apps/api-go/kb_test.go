package main

import (
	"encoding/json"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// kbRoot 造一个只装知识库白名单样本的沙箱根：不依赖真仓库内容，也就不会被别处的文档改动带崩。
func kbRoot(t *testing.T) string {
	t.Helper()
	root := t.TempDir()
	files := map[string]string{
		".agents/notes/implemented/alpha.md": "# Alpha 决策\n\n为什么这么定。\n",
		".agents/notes/implemented/beta.md":  "没有标题的决策记录\n",
		"README.md":                          "根目录契约，没有标题\n",
		"apps/api-go/README.md":              "# apps/api-go · 平台后端\n",
		"docs/architecture.md":               "# 架构地图\n\n模块关系。\n",
		"docs/permissions.md":                "# 权限矩阵\n",
		"docs/postmortem/README.md":          "复盘模板，没有标题\n",
		"docs/postmortem/p1.md":              "# 事故一\n",
		// 以下都在「不汇」的一侧，用来钉住拒绝集与先判 deny 的顺序。
		"apps/api-go/dist/README.md": "# 构建产物里的 README\n",
		"node_modules/pkg/README.md": "# 依赖里的 README\n",
		"docs/postmortem/api-key.md": "# 名字像密钥的复盘\n",
		"docs/notes.md":              "# 不在表里的文档\n",
		".env":                       "TOKEN=should-never-be-indexed\n",
		"docs/postmortem/secrets.md": "# 秘密\n",
	}
	for relative, body := range files {
		full := filepath.Join(root, filepath.FromSlash(relative))
		if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
			t.Fatalf("建目录失败 %s: %v", relative, err)
		}
		if err := os.WriteFile(full, []byte(body), 0o644); err != nil {
			t.Fatalf("写文件失败 %s: %v", relative, err)
		}
	}
	return root
}

// kbApp 用固定时钟构造 app：builtAt 可复算，索引重建前后才能逐字节比较。
func kbApp(t *testing.T, root string) *app {
	t.Helper()
	subject := newApp(root)
	fixed := time.Date(2024, 5, 6, 7, 8, 9, 0, time.UTC)
	subject.now = func() time.Time { return fixed }
	return subject
}

func writeFixture(t *testing.T, root, relative, body string) {
	t.Helper()
	full := filepath.Join(root, filepath.FromSlash(relative))
	if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
		t.Fatalf("建目录失败 %s: %v", relative, err)
	}
	if err := os.WriteFile(full, []byte(body), 0o644); err != nil {
		t.Fatalf("写文件失败 %s: %v", relative, err)
	}
}

func kbList(t *testing.T, subject *app) (kbListResponse, string) {
	t.Helper()
	recorder := call(t, subject, http.MethodGet, "/api/kb", "")
	expectStatus(t, recorder, http.StatusOK)
	var body kbListResponse
	decode(t, recorder, &body)
	return body, recorder.Body.String()
}

// 白名单容许集 + 排序 + title 两条生成路径。
func TestKBListWhitelistOrderAndTitles(t *testing.T) {
	root := kbRoot(t)
	subject := kbApp(t, root)

	body, _ := kbList(t, subject)

	wantPaths := []string{
		".agents/notes/implemented/alpha.md",
		".agents/notes/implemented/beta.md",
		"README.md",
		"apps/api-go/README.md",
		"docs/architecture.md",
		"docs/permissions.md",
		"docs/postmortem/README.md",
		"docs/postmortem/p1.md",
	}
	gotPaths := make([]string, 0, len(body.Items))
	wantGroups := []string{"notes", "notes", "module", "module", "docs", "docs", "postmortem", "postmortem"}
	wantTitles := []string{"Alpha 决策", "beta", "README", "apps/api-go · 平台后端", "架构地图", "权限矩阵", "README", "事故一"}
	for index, item := range body.Items {
		gotPaths = append(gotPaths, item.Path)
		if index >= len(wantGroups) {
			continue
		}
		if item.Group != wantGroups[index] {
			t.Errorf("第 %d 条 group = %q，想要 %q（path %s）", index, item.Group, wantGroups[index], item.Path)
		}
		if item.Title != wantTitles[index] {
			t.Errorf("第 %d 条 title = %q，想要 %q（path %s）", index, item.Title, wantTitles[index], item.Path)
		}
	}
	if strings.Join(gotPaths, ",") != strings.Join(wantPaths, ",") {
		t.Fatalf("排序/容许集不对:\n got  %v\n want %v", gotPaths, wantPaths)
	}
	if body.Count != len(wantPaths) {
		t.Fatalf("count = %d，想要 %d", body.Count, len(wantPaths))
	}
	if _, err := time.Parse(time.RFC3339, body.BuiltAt); err != nil {
		t.Fatalf("builtAt 不是 ISO8601: %q (%v)", body.BuiltAt, err)
	}
	if body.BuiltAt != "2024-05-06T07:08:09.000Z" {
		t.Fatalf("builtAt = %q，想要固定时钟的 2024-05-06T07:08:09.000Z", body.BuiltAt)
	}

	// sha256/bytes 与磁盘一致：逐条按磁盘字节复算，不用索引自己的值来自证。
	for _, item := range body.Items {
		payload, err := os.ReadFile(filepath.Join(root, filepath.FromSlash(item.Path)))
		if err != nil {
			t.Fatalf("读不到 %s: %v", item.Path, err)
		}
		if item.SHA256 != kbSum(payload) {
			t.Errorf("%s 的 sha256 与磁盘不符: %s != %s", item.Path, item.SHA256, kbSum(payload))
		}
		if len(item.SHA256) != 64 {
			t.Errorf("%s 的 sha256 不是 64 位 hex: %q", item.Path, item.SHA256)
		}
		if item.Bytes != int64(len(payload)) {
			t.Errorf("%s 的 bytes = %d，磁盘 %d", item.Path, item.Bytes, len(payload))
		}
	}
}

// 索引落 .agents/platform/kb.db，且是纯派生的：删掉之后同一个请求仍然 200 且内容逐字节一致。
func TestKBListSurvivesIndexDeletion(t *testing.T) {
	root := kbRoot(t)
	subject := kbApp(t, root)

	_, first := kbList(t, subject)

	indexPath := filepath.Join(root, filepath.FromSlash(kbIndexRel))
	if _, err := os.Stat(indexPath); err != nil {
		t.Fatalf("第一次 GET /api/kb 之后没有索引文件 %s: %v", indexPath, err)
	}
	if err := os.Remove(indexPath); err != nil {
		t.Fatalf("删索引失败: %v", err)
	}

	_, second := kbList(t, subject)
	if first != second {
		t.Fatalf("删索引前后响应不一致:\n first  %s\n second %s", first, second)
	}
	if _, err := os.Stat(indexPath); err != nil {
		t.Fatalf("重建后索引文件仍然缺失: %v", err)
	}
}

// 现盘一改，索引必须整份重建：sha256/bytes/count 都跟着变。
func TestKBListRebuildsOnDrift(t *testing.T) {
	root := kbRoot(t)
	subject := kbApp(t, root)

	before, _ := kbList(t, subject)
	var beforeItem kbRecord
	for _, item := range before.Items {
		if item.Path == "docs/architecture.md" {
			beforeItem = item
		}
	}
	if beforeItem.Path == "" {
		t.Fatal("样本里没有 docs/architecture.md")
	}

	writeFixture(t, root, "docs/architecture.md", "# 架构地图\n\n模块关系改过了。\n")
	after, _ := kbList(t, subject)

	var afterItem kbRecord
	for _, item := range after.Items {
		if item.Path == "docs/architecture.md" {
			afterItem = item
		}
	}
	if afterItem.SHA256 == beforeItem.SHA256 {
		t.Fatalf("文件改了，索引里的 sha256 没变: %s", afterItem.SHA256)
	}
	if afterItem.Bytes == beforeItem.Bytes {
		t.Fatalf("文件改长了，索引里的 bytes 没变: %d", afterItem.Bytes)
	}

	writeFixture(t, root, "docs/postmortem/p2.md", "# 事故二\n")
	grown, _ := kbList(t, subject)
	if grown.Count != before.Count+1 {
		t.Fatalf("新增文件后 count = %d，想要 %d", grown.Count, before.Count+1)
	}
}

// 索引文件被写坏也要自愈：它只是缓存，不该让接口 500。
func TestKBListHealsCorruptIndex(t *testing.T) {
	root := kbRoot(t)
	subject := kbApp(t, root)
	_, first := kbList(t, subject)

	indexPath := filepath.Join(root, filepath.FromSlash(kbIndexRel))
	if err := os.WriteFile(indexPath, []byte("this is not sqlite"), 0o644); err != nil {
		t.Fatalf("写坏索引失败: %v", err)
	}

	_, second := kbList(t, subject)
	if first != second {
		t.Fatalf("坏索引自愈后响应不一致:\n first  %s\n second %s", first, second)
	}
}

// 拒绝集：绝对路径、..、白名单外、deny 目录、名字像密钥、软链越界、目录、不存在。
func TestKBItemRejectsOutsideWhitelist(t *testing.T) {
	root := kbRoot(t)
	subject := kbApp(t, root)

	outside := filepath.Join(t.TempDir(), "outside.md")
	if err := os.WriteFile(outside, []byte("# 仓库外的文件\n"), 0o644); err != nil {
		t.Fatalf("写仓库外文件失败: %v", err)
	}
	if err := os.MkdirAll(filepath.Join(root, "modx"), 0o755); err != nil {
		t.Fatalf("建目录失败: %v", err)
	}
	if err := os.Symlink(outside, filepath.Join(root, "modx", "README.md")); err != nil {
		t.Fatalf("建软链失败: %v", err)
	}
	if err := os.MkdirAll(filepath.Join(root, "moddir", "README.md"), 0o755); err != nil {
		t.Fatalf("建目录失败: %v", err)
	}

	cases := []struct {
		name   string
		path   string
		status int
	}{
		{"空 path", "", http.StatusBadRequest},
		{"绝对路径", "/etc/passwd", http.StatusBadRequest},
		{"上层穿越", "../outside.md", http.StatusBadRequest},
		{"多层穿越", "../../etc/passwd", http.StatusBadRequest},
		{"中途穿越", "docs/../docs/architecture.md", http.StatusBadRequest},
		{"白名单外", "docs/notes.md", http.StatusBadRequest},
		{"deny 目录", "apps/api-go/dist/README.md", http.StatusBadRequest},
		{"依赖目录", "node_modules/pkg/README.md", http.StatusBadRequest},
		{"名字像密钥", "docs/postmortem/api-key.md", http.StatusBadRequest},
		{"脚本", "scripts/kb-export.mjs", http.StatusBadRequest},
		{"软链越界", "modx/README.md", http.StatusBadRequest},
		{"白名单内但不存在", "docs/audit-contract.md", http.StatusNotFound},
		{"白名单内但是目录", "moddir/README.md", http.StatusNotFound},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			target := "/api/kb/item?path=" + url.QueryEscape(testCase.path)
			recorder := call(t, subject, http.MethodGet, target, "")
			if recorder.Code != testCase.status {
				t.Fatalf("状态码 = %d，想要 %d（体 %s）", recorder.Code, testCase.status, recorder.Body.String())
			}
			var body errorBody
			decode(t, recorder, &body)
			if body.Code != "E_KB_PATH" {
				t.Fatalf("code = %q，想要 E_KB_PATH", body.Code)
			}
			if body.Message == "" {
				t.Fatal("message 是空的")
			}
		})
	}
}

// 正路：text 是原文，sha256/bytes 与磁盘一致。
func TestKBItemReturnsDiskBytes(t *testing.T) {
	root := kbRoot(t)
	subject := kbApp(t, root)

	recorder := call(t, subject, http.MethodGet, "/api/kb/item?path=docs/architecture.md", "")
	expectStatus(t, recorder, http.StatusOK)
	var body kbItemResponse
	decode(t, recorder, &body)

	payload, err := os.ReadFile(filepath.Join(root, "docs", "architecture.md"))
	if err != nil {
		t.Fatalf("读样本失败: %v", err)
	}
	if body.Path != "docs/architecture.md" {
		t.Fatalf("path = %q", body.Path)
	}
	if body.Text != string(payload) {
		t.Fatalf("text 与磁盘不一致:\n got  %q\n want %q", body.Text, string(payload))
	}
	if body.SHA256 != kbSum(payload) || body.Bytes != int64(len(payload)) {
		t.Fatalf("sha256/bytes 与磁盘不一致: %s/%d", body.SHA256, body.Bytes)
	}

	var keys map[string]any
	if err := json.Unmarshal(recorder.Body.Bytes(), &keys); err != nil {
		t.Fatalf("响应不是 JSON: %v", err)
	}
	for _, key := range []string{"path", "sha256", "bytes", "text"} {
		if _, ok := keys[key]; !ok {
			t.Fatalf("响应缺字段 %s: %v", key, keys)
		}
	}
}

// 白名单容许集/拒绝集的纯函数判据与 kb-export.mjs 同口径（这两条是契约，不只是实现细节）。
func TestKBWhitelistParityTable(t *testing.T) {
	allowed := map[string]string{
		".agents/notes/implemented/p01.md": "notes",
		"README.md":                        "module",
		"apps/api-go/README.md":            "module",
		"docs/architecture.md":             "docs",
		"docs/permissions.md":              "docs",
		"docs/audit-contract.md":           "docs",
		"docs/postmortem/p1.md":            "postmortem",
	}
	for relative, group := range allowed {
		got, ok := kbGroupOf(relative)
		if !ok || got != group {
			t.Errorf("%s 应在白名单内且 group=%s，实得 %q/%v", relative, group, got, ok)
		}
	}
	denied := []string{
		"node_modules/pkg/README.md",
		"apps/api-go/dist/README.md",
		"vendor/x/README.md",
		"tmp/README.md",
		"docs/postmortem/api-key.md",
		"docs/postmortem/secret-plan.md",
		".env",
		".agents/notes/implemented/../secrets.md",
		"docs/AGENTS.md",
		"scripts/kb-export.mjs",
		".agents/notes/draft.md",
		"docs/postmortem/nested/p1.md",
	}
	for _, relative := range denied {
		if _, ok := kbGroupOf(relative); ok {
			t.Errorf("%s 不该进白名单", relative)
		}
	}
}

// 单文件上限：超过 4MB 的条目在读出正文之前就被挡住，不进 JSON。
func TestKBItemRejectsOversize(t *testing.T) {
	root := kbRoot(t)
	subject := kbApp(t, root)
	huge := "# 超大复盘\n" + strings.Repeat("x", kbReadLimit)
	writeFixture(t, root, "docs/postmortem/huge.md", huge)

	recorder := call(t, subject, http.MethodGet, "/api/kb/item?path="+url.QueryEscape("docs/postmortem/huge.md"), "")
	expectStatus(t, recorder, http.StatusBadRequest)
	var payload struct {
		Code string `json:"code"`
	}
	decode(t, recorder, &payload)
	if payload.Code != "E_KB_PATH" {
		t.Fatalf("code = %q，想要 E_KB_PATH", payload.Code)
	}

	// 同一条目仍然出现在列表里：超限挡的是正文接口，不是索引。
	body, _ := kbList(t, subject)
	found := false
	for _, item := range body.Items {
		if item.Path == "docs/postmortem/huge.md" {
			found = true
		}
	}
	if !found {
		t.Fatalf("超大条目应当仍在列表里")
	}
}
