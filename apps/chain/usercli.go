package main

// usercli.go —— 账号从命令行建：chain user add。
//
// 为什么要有它：这个平台是内网部署，没有「首次注册」这回事——账号一律由管理员分配。
// 那第一个管理员从哪来？只能从命令行来：库还是空的时候没有任何人能登录，
// 也就没人有资格调建账号的接口。服务启动时如果库里一个账号都没有，会打一行提示指着这条命令。
//
// 为什么复用 createUser 而不是自己写一遍：口令规则（至少 8 个字符）与 argon2id 参数
// 只能有一处实现，否则「命令行能建、接口建不了」这种分家迟早出现。

import (
	"errors"
	"flag"
	"fmt"
	"os"
	"time"
)

const userUsage = `用法：chain user <子命令>

子命令：
  add    建一个账号（第一个管理员就用它）

例：
  ./chain user add -username admin -password 至少八个字符 -admin
  ./chain user add -username 张三 -password zhangsan-pass1 -db data/chain.db

add 的选项（默认值与服务端一致，所以同一个工作目录下不用重复写）：
  -username    账号名（必填，同一个库里不能重名）
  -password    口令（必填，至少 8 个字符）
  -admin       建出来的是管理员（默认普通账号）
  -db-driver   存储驱动（默认 sqlite）
  -db          数据库：sqlite 是文件路径（默认 data/chain.db）`

// runUserCommand 是 chain user 这一层：只做子命令分派，干活在各 add 里。
func runUserCommand(args []string) int {
	if len(args) == 0 {
		fmt.Fprintln(os.Stderr, userUsage)
		return 2
	}
	switch args[0] {
	case "add":
		return runUserAddCommand(args[1:])
	case "help", "-h", "--help":
		fmt.Println(userUsage)
		return 0
	}
	fmt.Fprintf(os.Stderr, "不认识的 user 子命令：%s\n\n%s\n", args[0], userUsage)
	return 2
}

// runUserAddCommand 建一个账号。退出码：0 建成、1 建不成（重名、口令太短、库打不开）、2 参数不对。
func runUserAddCommand(args []string) int {
	fs := flag.NewFlagSet("user add", flag.ContinueOnError)
	username := fs.String("username", "", "账号名（必填）")
	password := fs.String("password", "", "口令（必填，至少 8 个字符）")
	admin := fs.Bool("admin", false, "建出来的是管理员")
	driver := fs.String("db-driver", "sqlite", "存储驱动（目前只有 sqlite）")
	dbPath := fs.String("db", "data/chain.db", "数据库：sqlite 是文件路径")
	if err := fs.Parse(args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return 0
		}
		return 2
	}
	store, err := OpenStore(*driver, *dbPath)
	if err != nil {
		fmt.Fprintln(os.Stderr, "打开库失败："+err.Error())
		return 1
	}
	defer store.Close()
	u, why := createUser(store, *username, *password, *admin, time.Now())
	if why != "" {
		fmt.Fprintln(os.Stderr, "建账号失败："+why)
		return 1
	}
	role := "普通账号"
	if u.Admin {
		role = "管理员"
	}
	fmt.Printf("已建账号：%s（%s，库 %s）\n", u.Username, role, *dbPath)
	if u.Admin {
		fmt.Println("下一步：用这个账号登录页面，再在「用户」页建其余账号。")
	}
	return 0
}
