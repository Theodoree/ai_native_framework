package engine

// copy_dist.go —— scripts/copy-dist.mjs 的行为复刻。
//
// 前端产物进不进二进制由这里决定：产物在就整体替换，产物不在就只保留占位文件。
// 占位文件（README.md / .gitkeep）必须留在原地：删掉它们，没有前端产物时 go build 会失败。
//
// 与 JS 的唯一差别：JS 的 ROOT 取脚本所在目录的上一级（仓库根），这里取引擎进程的
// 当前工作目录。两个调用点（check:web / web:dist）都在仓库根跑，所以两者落在同一个目录。

import (
	"io"
	"os"
	"path/filepath"
)

// CopyDistKeep 是不参与清理的占位文件：删了它们，没有前端产物时 go build 会失败。
var CopyDistKeep = map[string]bool{"README.md": true, ".gitkeep": true}

// RunCopyDist 复刻 copyDist()：没有前端产物也退 0（go build 仍要能跑）。
func RunCopyDist(argv []string, stdout, stderr io.Writer, root string) int {
	source := filepath.Join(root, "apps", "web-vue", "dist")
	target := filepath.Join(root, "apps", "api-go", "dist")
	if err := os.MkdirAll(target, 0o777); err != nil {
		io.WriteString(stderr, "copy-dist: "+err.Error()+"\n")
		return 1
	}
	if _, err := os.Stat(filepath.Join(source, "index.html")); err != nil {
		io.WriteString(stdout, "copy-dist: 没有 apps/web-vue/dist，保留占位文件（go build 仍可跑，页面不进二进制）\n")
		return 0
	}
	clearGeneratedDist(target)
	if err := copyDistTree(source, target); err != nil {
		io.WriteString(stderr, "copy-dist: "+err.Error()+"\n")
		return 1
	}
	io.WriteString(stdout, "copy-dist: "+distRelative(root, source)+" → "+distRelative(root, target)+"\n")
	return 0
}

// distRelative 复刻 path.relative(ROOT, p) 的显示形式（POSIX 分隔符）。
func distRelative(root, path string) string {
	rel, err := filepath.Rel(root, path)
	if err != nil {
		return path
	}
	return filepath.ToSlash(rel)
}

// clearGeneratedDist 复刻 clearGenerated：只清理上一轮复制进来的产物，
// 占位文件与目标目录本身不动。
func clearGeneratedDist(target string) {
	entries, err := os.ReadDir(target)
	if err != nil {
		return
	}
	for _, entry := range entries {
		if CopyDistKeep[entry.Name()] {
			continue
		}
		os.RemoveAll(filepath.Join(target, entry.Name()))
	}
}

// copyDistTree 复刻 cpSync(SOURCE, TARGET, {recursive: true, force: true})：
// 目标目录已存在时把源目录的内容并进去，占位文件因此能活下来。
func copyDistTree(source, target string) error {
	entries, err := os.ReadDir(source)
	if err != nil {
		return err
	}
	for _, entry := range entries {
		sourcePath := filepath.Join(source, entry.Name())
		targetPath := filepath.Join(target, entry.Name())
		info, statErr := os.Lstat(sourcePath)
		if statErr != nil {
			return statErr
		}
		switch {
		case info.Mode()&os.ModeSymlink != 0:
			link, linkErr := os.Readlink(sourcePath)
			if linkErr != nil {
				return linkErr
			}
			os.RemoveAll(targetPath)
			if symlinkErr := os.Symlink(link, targetPath); symlinkErr != nil {
				return symlinkErr
			}
		case info.IsDir():
			if mkdirErr := os.MkdirAll(targetPath, info.Mode().Perm()); mkdirErr != nil {
				return mkdirErr
			}
			if copyErr := copyDistTree(sourcePath, targetPath); copyErr != nil {
				return copyErr
			}
		default:
			if copyErr := copyDistFile(sourcePath, targetPath, info.Mode().Perm()); copyErr != nil {
				return copyErr
			}
		}
	}
	return nil
}

func copyDistFile(source, target string, mode os.FileMode) error {
	data, err := os.ReadFile(source)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(target), 0o777); err != nil {
		return err
	}
	return os.WriteFile(target, data, mode)
}
