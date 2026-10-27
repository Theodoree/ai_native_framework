package main

// assets_test.go —— 内嵌资产（deploy/**）展开、项目名解析、镜像引用拼装的判据。
//
// 这三件事都是「配置换了名字/版本就不该重编译」的支点：展开错一次，镜像就烘到
// 一个没人引用的 tag 上；项目名解析错一次，家目录和镜像前缀就分家；ImageRef 错一次，
// docker 会去找 latest 而实际 build 的是 dev。

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// withAppName 在测试期间定下项目名，结束时还原——appName 是包级变量。
func withAppName(t *testing.T, name string) {
	t.Helper()
	old := CurrentAppName()
	t.Cleanup(func() { ResolveAppName(old) })
	ResolveAppName(name)
}

// expandOnce 展开到一个新的临时目录。
func expandOnce(t *testing.T) (dest string, written, overwritten []string) {
	t.Helper()
	dest = t.TempDir()
	written, overwritten, err := ExpandAssets(dest)
	if err != nil {
		t.Fatalf("展开资产失败：%v", err)
	}
	return dest, written, overwritten
}

func TestExpandAssetsWritesEveryFileWithMode(t *testing.T) {
	dest, written, overwritten := expandOnce(t)
	files, err := AssetFiles()
	if err != nil {
		t.Fatal(err)
	}
	if len(written) != len(files) {
		t.Fatalf("第一次展开应当写出全部 %d 个文件，实际 %d 个", len(files), len(written))
	}
	if len(overwritten) != 0 {
		t.Fatalf("空目录里不该有覆盖，实际 %v", overwritten)
	}
	for _, f := range files {
		p := filepath.Join(dest, filepath.FromSlash(f.Rel))
		st, err := os.Stat(p)
		if err != nil {
			t.Fatalf("资产 %s 没写出来：%v", f.Rel, err)
		}
		if !st.Mode().IsRegular() {
			t.Fatalf("资产 %s 不是普通文件", f.Rel)
		}
		if got := st.Mode().Perm(); got != f.Mode {
			t.Fatalf("资产 %s 的权限位应当是 %o，实际 %o", f.Rel, f.Mode, got)
		}
	}
	// 脚本必须可执行，配置文件不该可执行——两条都点名，别只查一个方向。
	for _, name := range []string{"entrypoint.sh", "build-images.sh"} {
		st, err := os.Stat(filepath.Join(dest, "agent-image", name))
		if err != nil {
			t.Fatalf("%s 没展开：%v", name, err)
		}
		if st.Mode().Perm()&0o100 == 0 {
			t.Fatalf("%s 应当可执行，实际 %o", name, st.Mode().Perm())
		}
	}
	st, err := os.Stat(filepath.Join(dest, "nodes.yaml"))
	if err != nil {
		t.Fatalf("nodes.yaml 没展开：%v", err)
	}
	if st.Mode().Perm() != 0o644 {
		t.Fatalf("nodes.yaml 应当是 0644，实际 %o", st.Mode().Perm())
	}
}

func TestExpandAssetsIsIdempotent(t *testing.T) {
	dest, _, _ := expandOnce(t)
	before, err := os.Stat(filepath.Join(dest, "nodes.yaml"))
	if err != nil {
		t.Fatal(err)
	}
	written, overwritten, err := ExpandAssets(dest)
	if err != nil {
		t.Fatalf("第二次展开失败：%v", err)
	}
	if len(written) != 0 || len(overwritten) != 0 {
		t.Fatalf("内容没变时应当一个新写、零个覆盖，实际 written=%v overwritten=%v", written, overwritten)
	}
	after, err := os.Stat(filepath.Join(dest, "nodes.yaml"))
	if err != nil {
		t.Fatal(err)
	}
	// 内容一样就不该动文件：mtime 不变才谈得上「重复展开无副作用」。
	if !after.ModTime().Equal(before.ModTime()) {
		t.Fatalf("内容没变却改了 mtime：%v → %v", before.ModTime(), after.ModTime())
	}
}

func TestExpandAssetsOnlyOverwritesChangedFiles(t *testing.T) {
	dest, _, _ := expandOnce(t)
	target := filepath.Join(dest, "nodes.yaml")
	if err := os.WriteFile(target, []byte("version: 1\n# 本地改过\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	written, overwritten, err := ExpandAssets(dest)
	if err != nil {
		t.Fatal(err)
	}
	if len(written) != 0 {
		t.Fatalf("文件都在了，不该有新写的，实际 %v", written)
	}
	if len(overwritten) != 1 || overwritten[0] != target {
		t.Fatalf("只有改过的那一个应当被覆盖，实际 %v", overwritten)
	}
	body, err := os.ReadFile(target)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(body), "version: 1") || strings.Contains(string(body), "本地改过") {
		t.Fatalf("覆盖后应当恢复成内嵌内容，实际 %q", string(body))
	}
}

func TestResolveAppNamePrefersFlagThenEnvThenDefault(t *testing.T) {
	old := CurrentAppName()
	t.Cleanup(func() { ResolveAppName(old) })
	ResolveAppName("") // 先回到编译期默认，避免上一条用例的残留
	if got := CurrentAppName(); got != "ai_native_framework" {
		t.Fatalf("没有 flag、没有环境变量时应当是编译期默认 ai_native_framework，实际 %q", got)
	}
	t.Setenv(appEnvVar, "from_env")
	if got := ResolveAppName(""); got != "from_env" {
		t.Fatalf("环境变量应当生效，实际 %q", got)
	}
	if got := ResolveAppName("from_flag"); got != "from_flag" {
		t.Fatalf("-app 应当压过环境变量，实际 %q", got)
	}
	t.Setenv(appEnvVar, "   ")
	if got := ResolveAppName(""); got != "ai_native_framework" {
		t.Fatalf("空白环境变量不算配置，应当回落到默认，实际 %q", got)
	}
}

func TestAppHomeJoinsHomeAndDotAppName(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	withAppName(t, "demo_app")
	if got, want := AppHome(), filepath.Join(home, ".demo_app"); got != want {
		t.Fatalf("AppHome 应当是 %s，实际 %s", want, got)
	}
}

func TestImageRefForms(t *testing.T) {
	withAppName(t, "demo_app")
	cases := []struct {
		name string
		tmpl Template
		want string
	}{
		{"不带 tag 补 latest", Template{Image: "demo_app/agent-codex"}, "demo_app/agent-codex:latest"},
		{"带 tag 原样", Template{Image: "registry.example.com:5000/agent/codex:1.2.3", Version: "latest"}, "registry.example.com:5000/agent/codex:1.2.3"},
		{"占位符替换后补 latest", Template{Image: appPlaceholder + "/agent-claude"}, "demo_app/agent-claude:latest"},
		{"手动指定版本", Template{Image: "demo_app/agent-deepseek-harness", Version: "0.9.0"}, "demo_app/agent-deepseek-harness:0.9.0"},
		{"registry 端口不算 tag", Template{Image: "registry.example.com:5000/agent/codex", Version: "1.0"}, "registry.example.com:5000/agent/codex:1.0"},
	}
	for _, c := range cases {
		if got := c.tmpl.ImageRef(); got != c.want {
			t.Fatalf("%s：ImageRef 应当是 %s，实际 %s", c.name, c.want, got)
		}
	}
}

func TestAssetsDryRunWritesNothing(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "not-created")
	if code := runAssetsCommand([]string{"-dir", dir, "--dry-run"}); code != 0 {
		t.Fatalf("--dry-run 应当退 0，实际 %d", code)
	}
	if _, err := os.Stat(dir); !os.IsNotExist(err) {
		t.Fatalf("--dry-run 不该建目录 %s（err=%v）", dir, err)
	}
	plan, err := AssetPlan(dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(plan) == 0 {
		t.Fatal("计划里应当至少有一个文件")
	}
}

func TestAssetsCommandExpandsToAppHome(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	// 这条用例让 runAssetsCommand 自己解析项目名（-app demo_app），
	// 结束后必须还原，否则包级项目名会漏给后面的用例。
	old := CurrentAppName()
	t.Cleanup(func() { ResolveAppName(old) })
	if code := runAssetsCommand([]string{"-app", "demo_app"}); code != 0 {
		t.Fatalf("assets 应当退 0，实际 %d", code)
	}
	base := filepath.Join(home, ".demo_app")
	nodes := filepath.Join(base, "nodes.yaml")
	body, err := os.ReadFile(nodes)
	if err != nil {
		t.Fatalf("应当展开出 %s：%v", nodes, err)
	}
	// 展开出去的那一份是按当前项目名定好的：占位符已经换掉，脚本与模板指向同一个前缀。
	if !strings.Contains(string(body), "demo_app/agent-codex") {
		t.Fatalf("展开的 nodes.yaml 应当写成 demo_app/agent-codex，实际 %q", string(body))
	}
	if strings.Contains(string(body), appPlaceholder) {
		t.Fatalf("展开的 nodes.yaml 不该再留占位符，实际 %q", string(body))
	}
	// 展开出来的模板表按当前项目名解析成镜像引用。
	table, err := LoadTemplateFile(nodes)
	if err != nil {
		t.Fatalf("展开的模板表应当能读：%v", err)
	}
	if got := table.Templates["codex"].ImageRef(); got != "demo_app/agent-codex:latest" {
		t.Fatalf("展开后的镜像引用应当是 demo_app/agent-codex:latest，实际 %s", got)
	}
	script, err := os.ReadFile(filepath.Join(base, "agent-image", "build-images.sh"))
	if err != nil {
		t.Fatalf("应当展开出 build-images.sh：%v", err)
	}
	for _, want := range []string{"APP_NAME:-demo_app", "VERSION:-latest"} {
		if !strings.Contains(string(script), want) {
			t.Fatalf("build-images.sh 里应当有 %q，实际 %q", want, string(script))
		}
	}
}

func TestResolveTemplateFileThreeLevels(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	withAppName(t, "demo_app")
	work := t.TempDir()
	t.Chdir(work)

	// 第三级：哪儿都没有 → 空串（调用方回落内嵌默认表）。
	if got := ResolveTemplateFile(nil); got != "" {
		t.Fatalf("哪儿都没有时应当返回空串，实际 %q", got)
	}
	// 第二级：家目录展开态。
	expanded := filepath.Join(home, ".demo_app")
	if _, _, err := ExpandAssets(expanded); err != nil {
		t.Fatal(err)
	}
	if got, want := ResolveTemplateFile(nil), filepath.Join(expanded, "nodes.yaml"); got != want {
		t.Fatalf("应当找到家目录那份 %s，实际 %q", want, got)
	}
	// 第一级：仓库里那份优先（开发态改了就该生效）。
	if err := os.MkdirAll("deploy", 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(DefaultTemplateFile, []byte("version: 1\ntemplates: {}\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if got := ResolveTemplateFile(nil); got != DefaultTemplateFile {
		t.Fatalf("仓库里那份应当优先，实际 %q", got)
	}
}
