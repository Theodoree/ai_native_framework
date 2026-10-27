package main

import (
	"embed"
	"flag"
	"log"
	"net/http"
)

//go:embed web/index.html
var webFS embed.FS

func main() {
	addr := flag.String("addr", "127.0.0.1:8099", "监听地址")
	data := flag.String("data", "data", "数据目录")
	flag.Parse()

	store, err := NewStore(*data)
	if err != nil {
		log.Fatal(err)
	}
	srv := NewServer(store, FakeExecutor{})
	mux := http.NewServeMux()
	srv.Routes(mux)
	log.Printf("链条平台已启动：http://%s （数据目录 %s）", *addr, *data)
	log.Fatal(http.ListenAndServe(*addr, mux))
}
