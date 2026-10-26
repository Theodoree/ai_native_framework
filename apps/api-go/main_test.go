package main

import (
	"os"
	"path/filepath"
	"testing"
)

// resolveRoot 的判据是「向上找到带声明的目录」，不是「找某个脚本」：搬走 Node 之后仍然要能找到仓库根。
func TestResolveRootFindsStateMachineDeclaration(t *testing.T) {
	root := t.TempDir()
	declaration := filepath.Join(root, ".agents", "platform", "state-machine.yml")
	if err := os.MkdirAll(filepath.Dir(declaration), 0o755); err != nil {
		t.Fatalf("建声明目录失败: %v", err)
	}
	if err := os.WriteFile(declaration, []byte("version: 1\n"), 0o644); err != nil {
		t.Fatalf("写声明失败: %v", err)
	}
	nested := filepath.Join(root, "apps", "api-go")
	if err := os.MkdirAll(nested, 0o755); err != nil {
		t.Fatalf("建子目录失败: %v", err)
	}

	t.Setenv("PLATFORM_ROOT", "")
	previous, err := os.Getwd()
	if err != nil {
		t.Fatalf("取不到工作目录: %v", err)
	}
	if err := os.Chdir(nested); err != nil {
		t.Fatalf("切不到子目录: %v", err)
	}
	t.Cleanup(func() {
		if err := os.Chdir(previous); err != nil {
			t.Fatalf("回不到原目录: %v", err)
		}
	})

	got, err := resolveRoot()
	if err != nil {
		t.Fatalf("定位仓库根失败: %v", err)
	}
	want := resolveSymlinks(t, root)
	if resolveSymlinks(t, got) != want {
		t.Fatalf("仓库根 = %q，想要 %q（判据是声明所在目录）", got, root)
	}
}

func resolveSymlinks(t *testing.T, path string) string {
	t.Helper()
	resolved, err := filepath.EvalSymlinks(path)
	if err != nil {
		t.Fatalf("解析软链失败 %s: %v", path, err)
	}
	return resolved
}
