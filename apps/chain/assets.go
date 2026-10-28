package main

// assets.go —— 部署资产编进二进制，运行时展开到家目录。
//
// 为什么要把 deploy/ 挪进 apps/chain：go:embed 只能嵌本包目录（不能用 ../），
// 资产留在仓库根就永远进不了二进制，单文件发出去就没有镜像定义与入口脚本可用。
//
// 为什么展开到 ~/.<项目名>/：二进制要能脱离仓库独立跑。展开出来的目录结构保持
// agent-image/… + nodes.yaml，跑 agent-image/build-images.sh 就能直接烘镜像。
// 展开是幂等的：内容一样就不动（不改 mtime、不刷权限），内容变了才覆盖并报出来。

import (
	"bytes"
	"embed"
	"errors"
	"flag"
	"fmt"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"strings"
	"unicode/utf8"
)

//go:embed deploy/agent-image deploy/nodes.yaml
var assetsFS embed.FS

const (
	// assetsPrefix 是内嵌树里的前缀，展开到目标目录时会被去掉：目标目录本身就是 deploy 的位置。
	assetsPrefix = "deploy/"
	// assetsAgentImageDir 是镜像目录名（展开后在 <dir>/agent-image）。
	assetsAgentImageDir = "agent-image"
	// assetsNodesFile 是模板表文件名（展开后在 <dir>/nodes.yaml）。
	assetsNodesFile = "nodes.yaml"
	// assetsScriptMode / assetsFileMode 是展开后的权限位：脚本要能直接跑。
	assetsScriptMode fs.FileMode = 0o755
	assetsFileMode   fs.FileMode = 0o644
)

// AssetFile 是一个待展开的资产：相对路径（去掉 deploy/ 前缀）+ 权限位。
type AssetFile struct {
	Rel  string
	Mode fs.FileMode
}

// AssetFiles 列出全部内嵌资产，按路径排序（展开与打印都按这个顺序，输出才稳定）。
func AssetFiles() ([]AssetFile, error) {
	var out []AssetFile
	err := fs.WalkDir(assetsFS, "deploy", func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			return nil
		}
		rel := strings.TrimPrefix(p, assetsPrefix)
		mode := assetsFileMode
		if strings.HasSuffix(rel, ".sh") {
			mode = assetsScriptMode
		}
		out = append(out, AssetFile{Rel: rel, Mode: mode})
		return nil
	})
	if err != nil {
		return nil, err
	}
	return out, nil
}

// AssetPlan 给出「展开到 dest 会写哪些文件」的完整路径列表——dry-run 就是它。
func AssetPlan(dest string) ([]string, error) {
	files, err := AssetFiles()
	if err != nil {
		return nil, err
	}
	out := make([]string, 0, len(files))
	for _, f := range files {
		out = append(out, filepath.Join(dest, filepath.FromSlash(f.Rel)))
	}
	return out, nil
}

// ExpandAssets 把全部内嵌资产写到 dest；目录按需创建。
// written = 新写出的文件，overwritten = 已存在但内容不同、被覆盖的文件。
// 内容相同的一律跳过（幂等）：重复展开不该让任何东西看起来「刚改过」。
func ExpandAssets(dest string) (written, overwritten []string, err error) {
	if strings.TrimSpace(dest) == "" {
		return nil, nil, fmt.Errorf("展开目录不能为空")
	}
	files, err := AssetFiles()
	if err != nil {
		return nil, nil, err
	}
	for _, f := range files {
		body, err := assetsFS.ReadFile(path.Join("deploy", f.Rel))
		if err != nil {
			return written, overwritten, fmt.Errorf("读内嵌资产 %s：%w", f.Rel, err)
		}
		// 写出去的那一份是按当前项目名定好的：${APP} 在这里就换成真名，
		// 于是展开目录里的 nodes.yaml 与 build-images.sh 指向同一个镜像前缀，
		// 不用两处各改一次。非文本资产（utf8 不合法）原样写出。
		if utf8.Valid(body) {
			body = []byte(ExpandPlaceholders(string(body)))
		}
		target := filepath.Join(dest, filepath.FromSlash(f.Rel))
		if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
			return written, overwritten, fmt.Errorf("建目录 %s：%w", filepath.Dir(target), err)
		}
		old, readErr := os.ReadFile(target)
		exists := readErr == nil
		if exists && bytes.Equal(old, body) {
			// 内容一样：连权限都不动，避免每次展开都把 mtime 刷成「刚改过」。
			continue
		}
		if err := os.WriteFile(target, body, f.Mode); err != nil {
			return written, overwritten, fmt.Errorf("写 %s：%w", target, err)
		}
		// WriteFile 只在新建时用 mode 生效，已存在的文件要显式改权限位。
		if err := os.Chmod(target, f.Mode); err != nil {
			return written, overwritten, fmt.Errorf("改权限 %s：%w", target, err)
		}
		if exists {
			overwritten = append(overwritten, target)
			continue
		}
		written = append(written, target)
	}
	return written, overwritten, nil
}

// runAssetsCommand 实现 `chain assets [-dir 目录] [--dry-run] [-app 项目名]`。
//
// 为什么要有这条子命令：二进制脱离仓库之后，deploy/ 里的东西只剩二进制内嵌那一份，
// 想烘镜像、想改模板就得先把它们落到磁盘上。
func runAssetsCommand(args []string) int {
	fs := flag.NewFlagSet("assets", flag.ContinueOnError)
	app := fs.String("app", "", "项目名（覆盖 "+appEnvVar+" 与编译期默认）")
	dir := fs.String("dir", "", "展开目录（默认 $HOME/.<项目名>）")
	dry := fs.Bool("dry-run", false, "只打印会写哪些文件，不落盘")
	if err := fs.Parse(args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return 0
		}
		return 2
	}
	ResolveAppName(*app)
	dest := strings.TrimSpace(*dir)
	if dest == "" {
		dest = AppHome()
	}
	if dest == "" {
		fmt.Fprintln(os.Stderr, "找不到家目录：用 -dir 指定展开目录")
		return 3
	}
	plan, err := AssetPlan(dest)
	if err != nil {
		fmt.Fprintln(os.Stderr, "列出资产失败："+err.Error())
		return 1
	}
	if *dry {
		for _, p := range plan {
			fmt.Println(p)
		}
		fmt.Printf("--dry-run：以上 %d 个文件都没有写盘（目录 %s）\n", len(plan), dest)
		return 0
	}
	written, overwritten, err := ExpandAssets(dest)
	if err != nil {
		fmt.Fprintln(os.Stderr, "展开失败："+err.Error())
		return 1
	}
	skipped := len(plan) - len(written) - len(overwritten)
	fmt.Printf("已展开到 %s（项目名 %s）：新写 %d 个，覆盖 %d 个，跳过 %d 个\n", dest, CurrentAppName(), len(written), len(overwritten), skipped)
	for _, p := range overwritten {
		fmt.Println("  覆盖：" + p)
	}
	fmt.Println("下一步：")
	fmt.Printf("  1. 烘镜像：cd %s && sh build-images.sh（脚本里的默认前缀已经是 %s）\n", filepath.Join(dest, assetsAgentImageDir), CurrentAppName())
	fmt.Printf("  2. 或把它指给服务端：chain -templates %s\n", filepath.Join(dest, assetsNodesFile))
	fmt.Printf("  3. 改项目名：chain assets -app 别的名字（或构建时 -ldflags \"-X main.appName=别的名字\"）\n")
	return 0
}
