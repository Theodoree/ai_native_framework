package main

import (
	"embed"
	"flag"
	"log"
	"net/http"
	"os"
	"strings"
	"time"
)

//go:embed webui/dist
var webFS embed.FS

func main() {
	// 子命令只有一条：chain assets —— 把内嵌的部署资产展开到磁盘。
	// 放在 flag.Parse 之前，是因为子命令有自己的 flag 集合（-dir / --dry-run）。
	if len(os.Args) > 1 && os.Args[1] == "assets" {
		os.Exit(runAssetsCommand(os.Args[2:]))
	}
	addr := flag.String("addr", "127.0.0.1:8099", "监听地址")
	driver := flag.String("db-driver", "sqlite", "存储驱动（目前只有 sqlite）")
	dbPath := flag.String("db", "data/chain.db", "数据库：sqlite 是文件路径")
	execKind := flag.String("exec", "fake", "执行器：fake（不连外部）或 docker（本机 docker）")
	templates := flag.String("templates", "", "节点模板表；空 = 按三级回落找（仓库 deploy/nodes.yaml → $HOME/.<项目名>/nodes.yaml → 内嵌默认表）")
	app := flag.String("app", "", "项目名（覆盖 "+appEnvVar+" 与编译期默认）：决定镜像前缀与展开目录 $HOME/.<项目名>")
	dockerBin := flag.String("docker", "docker", "docker 可执行文件")
	timeout := flag.Duration("timeout", 10*time.Minute, "单次容器执行上限")
	uploads := flag.String("uploads", "data/uploads", "需求图片落盘目录（不存在会按需创建）")
	baseURL := flag.String("base-url", "", "注入容器的 BASE_URL")
	model := flag.String("model", "", "注入容器的 model")
	flag.Parse()

	// 项目名要在任何路径/镜像名的计算之前定下来（-app > CHAIN_APP > 编译期默认）。
	log.Printf("项目名：%s（展开目录 %s）", ResolveAppName(*app), orNone(AppHome(), "（拿不到家目录）"))

	store, err := OpenStore(*driver, *dbPath)
	if err != nil {
		log.Fatal(err)
	}
	defer store.Close()

	var exec Executor = FakeExecutor{}
	if *execKind == "docker" {
		// 三级回落：仓库里的 → 家目录展开的 → 内嵌默认表。ResolveTemplateFile 会说清楚用了哪个。
		path := strings.TrimSpace(*templates)
		if path == "" {
			path = ResolveTemplateFile(log.Printf)
		}
		table, err := LoadTemplatesOrFallback(path, log.Printf)
		if err != nil {
			log.Fatal(err)
		}
		log.Printf("节点模板表：%s（模板 %s）", orNone(table.Source, "内嵌默认"), strings.Join(sortedKeys(table.Templates), "、"))
		exec = DockerExecutor{
			Templates: table.Templates,
			Nodes:     table.Nodes,
			Docker:    *dockerBin,
			Timeout:   *timeout,
			BaseURL:   *baseURL,
			Model:     *model,
			Repo: func(r *Requirement) string {
				p, err := store.Project(r.ProjectKey)
				if err != nil {
					return ""
				}
				return strings.TrimSpace(p.Repo)
			},
		}
	} else if *execKind != "fake" {
		log.Fatalf("不认识的执行器：%s（只有 fake 与 docker）", *execKind)
	}

	srv := NewServer(store, exec).WithUploadDir(*uploads)
	log.Printf("链条平台已启动：http://%s （数据库 %s:%s，执行器 %s）", *addr, *driver, *dbPath, *execKind)
	log.Fatal(http.ListenAndServe(*addr, srv.Handler()))
}
