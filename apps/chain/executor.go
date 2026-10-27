package main

import (
	"fmt"
	"strings"
	"time"
)

// Executor 起一次容器执行。默认实现是假执行器：不连外部、不起 docker，
// 只把「这一站要做的事」写成一条评论与一份产物，好让状态机先跑通。
type Executor interface {
	Run(r *Requirement, n *Node, now time.Time) (Attempt, Comment, []string)
}

// 六类节点各自默认的容器模板：可新增模板，这里只记下默认三种。
var defaultTemplates = map[string]string{
	TypeCreate:    "deepseek-harness",
	TypeAssess:    "deepseek-harness",
	TypeCrossTest: "codex",
	TypeRelease:   "claude",
}

// FakeExecutor 不依赖网络：注入的环境变量只记录名字，密钥不回显。
type FakeExecutor struct{}

func (FakeExecutor) Run(r *Requirement, n *Node, now time.Time) (Attempt, Comment, []string) {
	tmpl := defaultTemplates[n.Type]
	body := strings.Join([]string{
		fmt.Sprintf("【假执行】模板 %s，节点 %s（%s）", tmpl, n.Key, n.Type),
		fmt.Sprintf("注入：BASE_URL、model、AGENTS.md（默认文件不改）"),
		fmt.Sprintf("需求：%s，分支 %s", r.ID, r.Branch),
		fmt.Sprintf("需求正文：%s", oneLine(r.Context)),
		rulesLine(n.Rules),
		fmt.Sprintf("本次调用没有连任何外部服务。"),
	}, "\n")
	a := Attempt{
		StartedAt: now,
		EndedAt:   now.Add(time.Second),
		ExitCode:  0,
		Template:  tmpl,
		Log:       "fake executor: no container was started",
		Outcome:   "succeeded",
	}
	c := Comment{ID: newID("c"), AuthorType: "container", Author: tmpl, Body: body, At: now}
	return a, c, []string{fmt.Sprintf("%s.artifact", n.Key)}
}

func rulesLine(rules []string) string {
	if len(rules) == 0 {
		return "追加规则：无"
	}
	return "追加规则：" + strings.Join(rules, "；")
}

func oneLine(s string) string {
	s = strings.ReplaceAll(s, "\n", " ")
	if len(s) > 120 {
		return s[:120] + "…"
	}
	return s
}
