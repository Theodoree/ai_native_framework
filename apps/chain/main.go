package main

import (
	"embed"
	"flag"
	"log"
	"net/http"
	"strings"
	"time"
)

//go:embed webui/dist
var webFS embed.FS

func main() {
	addr := flag.String("addr", "127.0.0.1:8099", "监听地址")
	driver := flag.String("db-driver", "sqlite", "存储驱动（目前只有 sqlite）")
	dbPath := flag.String("db", "data/chain.db", "数据库：sqlite 是文件路径")
	execKind := flag.String("exec", "fake", "执行器：fake（不连外部）或 docker（本机 docker）")
	templates := flag.String("templates", DefaultTemplateFile, "节点模板表（.yaml/.yml 按 YAML 读，其余按老 JSON；文件不存在回落内嵌默认表）")
	dockerBin := flag.String("docker", "docker", "docker 可执行文件")
	timeout := flag.Duration("timeout", 10*time.Minute, "单次容器执行上限")
	uploads := flag.String("uploads", "data/uploads", "需求图片落盘目录（不存在会按需创建）")
	baseURL := flag.String("base-url", "", "注入容器的 BASE_URL")
	model := flag.String("model", "", "注入容器的 model")
	flag.Parse()

	store, err := OpenStore(*driver, *dbPath)
	if err != nil {
		log.Fatal(err)
	}
	defer store.Close()

	var exec Executor = FakeExecutor{}
	if *execKind == "docker" {
		table, err := LoadTemplatesOrFallback(*templates, log.Printf)
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
