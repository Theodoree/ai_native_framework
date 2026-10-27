package engine

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// 这些用例逐条钉住原 scripts/copy-dist.mjs 的判据：参照物已随本批删除，且全仓
// 没有任何 Node 用例 import / spawn 过它，判据全部落在这里。
//
// 对应 tests/goldens/e/ 的 e-01 / e-02 / e-03（三条都是 argv ["copy-dist"]、退出码 0）。
// 夹具里的 sandboxScript:true 是 Node 的取样把戏（脚本按自身路径推 ROOT，所以要
// 拷进沙箱），不是判据；Go 侧的 RunCopyDist 直接收 root 参数，无需对应物。

const (
	// e-01 / e-02 的 stdout：源、目标都写成相对仓库根的 POSIX 路径。
	copyDistStdout = `copy-dist: apps/web-vue/dist → apps/api-go/dist` + "\n"
	// e-03 的 stdout：没有 dist 时的占位分支提示。
	copyDistPlaceholderStdout = `copy-dist: 没有 apps/web-vue/dist，保留占位文件（go build 仍可跑，页面不进二进制）` + "\n"
)

func copyDistCLI(t *testing.T, root string) (int, string, string) {
	t.Helper()
	var out, errOut bytes.Buffer
	code := Run([]string{"copy-dist"}, strings.NewReader(""), &out, &errOut, root)
	return code, out.String(), errOut.String()
}

func cdWrite(t *testing.T, root, rel, text string) {
	t.Helper()
	path := filepath.Join(root, filepath.FromSlash(rel))
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatalf("建目录失败 %s: %v", rel, err)
	}
	if err := os.WriteFile(path, []byte(text), 0o644); err != nil {
		t.Fatalf("写文件失败 %s: %v", rel, err)
	}
}

// cdDist 复刻 parity-cases.mjs:2414 的 DIST_TREE。
func cdDist(t *testing.T, root string) {
	t.Helper()
	cdWrite(t, root, "apps/web-vue/dist/index.html", "<html>hi</html>\n")
	cdWrite(t, root, "apps/web-vue/dist/assets/app.js", "console.log(1)\n")
	cdWrite(t, root, "apps/web-vue/dist/assets/app.css", "body{}\n")
}

// cdTarget 复刻 parity-cases.mjs:2420 的 TARGET_TREE：README.md 与 .gitkeep 是
// 目标目录里的占位文件，永远不参与清理。
func cdTarget(t *testing.T, root string, stale bool) {
	t.Helper()
	cdWrite(t, root, "apps/api-go/dist/README.md", "# placeholder\n")
	cdWrite(t, root, "apps/api-go/dist/.gitkeep", "")
	if stale {
		cdWrite(t, root, "apps/api-go/dist/stale.txt", "stale\n")
		cdWrite(t, root, "apps/api-go/dist/old/gone.js", "x\n")
	}
}

func cdWantFile(t *testing.T, root, rel, want string) {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join(root, filepath.FromSlash(rel)))
	if err != nil {
		t.Fatalf("读 %s 失败: %v", rel, err)
	}
	if string(raw) != want {
		t.Fatalf("%s = %q，期望 %q", rel, string(raw), want)
	}
}

func cdWantGone(t *testing.T, root, rel string) {
	t.Helper()
	_, err := os.Lstat(filepath.Join(root, filepath.FromSlash(rel)))
	if err == nil {
		t.Fatalf("%s 应被清掉，实际仍在", rel)
	}
	if !os.IsNotExist(err) {
		t.Fatalf("%s 检查失败: %v", rel, err)
	}
}

// e-01：把 dist 整棵铺进目标目录，占位文件原样保留。
func TestCopyDistCopiesTreeAndKeepsPlaceholders(t *testing.T) {
	root := t.TempDir()
	cdDist(t, root)
	cdTarget(t, root, false)
	code, stdout, stderr := copyDistCLI(t, root)
	if code != 0 {
		t.Fatalf("退出码 = %d，期望 0；stderr = %q", code, stderr)
	}
	if stderr != "" {
		t.Fatalf("stderr 应为空，实际 %q", stderr)
	}
	lgWant(t, stdout, copyDistStdout, "stdout")
	cdWantFile(t, root, "apps/api-go/dist/index.html", "<html>hi</html>\n")
	cdWantFile(t, root, "apps/api-go/dist/assets/app.js", "console.log(1)\n")
	cdWantFile(t, root, "apps/api-go/dist/assets/app.css", "body{}\n")
	cdWantFile(t, root, "apps/api-go/dist/README.md", "# placeholder\n")
	cdWantFile(t, root, "apps/api-go/dist/.gitkeep", "")
}

// e-02：上一轮残留（stale.txt、old/）必须被清掉，否则旧资源会跟着 go:embed 进二进制。
func TestCopyDistClearsPreviousLeftovers(t *testing.T) {
	root := t.TempDir()
	cdDist(t, root)
	cdTarget(t, root, true)
	code, stdout, stderr := copyDistCLI(t, root)
	if code != 0 {
		t.Fatalf("退出码 = %d，期望 0；stderr = %q", code, stderr)
	}
	lgWant(t, stdout, copyDistStdout, "stdout")
	cdWantFile(t, root, "apps/api-go/dist/index.html", "<html>hi</html>\n")
	cdWantFile(t, root, "apps/api-go/dist/assets/app.js", "console.log(1)\n")
	cdWantFile(t, root, "apps/api-go/dist/assets/app.css", "body{}\n")
	cdWantFile(t, root, "apps/api-go/dist/README.md", "# placeholder\n")
	cdWantFile(t, root, "apps/api-go/dist/.gitkeep", "")
	cdWantGone(t, root, "apps/api-go/dist/stale.txt")
	cdWantGone(t, root, "apps/api-go/dist/old/gone.js")
}

// e-03：没有 dist 走占位分支——只打印提示、退出 0，且一个字节都不动目标目录
// （e-03 的 golden files 是空数组，即「什么都没变」：连残留文件也要留着）。
func TestCopyDistPlaceholderBranchTouchesNothing(t *testing.T) {
	root := t.TempDir()
	cdTarget(t, root, true)
	code, stdout, stderr := copyDistCLI(t, root)
	if code != 0 {
		t.Fatalf("退出码 = %d，期望 0；stderr = %q", code, stderr)
	}
	if stderr != "" {
		t.Fatalf("stderr 应为空，实际 %q", stderr)
	}
	lgWant(t, stdout, copyDistPlaceholderStdout, "stdout")
	cdWantFile(t, root, "apps/api-go/dist/README.md", "# placeholder\n")
	cdWantFile(t, root, "apps/api-go/dist/.gitkeep", "")
	cdWantFile(t, root, "apps/api-go/dist/stale.txt", "stale\n")
	cdWantFile(t, root, "apps/api-go/dist/old/gone.js", "x\n")
}
