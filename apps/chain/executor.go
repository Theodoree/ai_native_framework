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

// 容器表达自审结论的唯一方式：在输出里单独打一行
//
//	CHAIN_VERDICT: pass
//	CHAIN_VERDICT: reject 原因写在这里
//
// 取最后一条出现的标记；取值认不出、整段没有标记，都算 unknown——
// 不许把「没说话」猜成「通过」。
const verdictMarker = "CHAIN_VERDICT:"

// NL 单独写：这个工具链会吃掉一层反斜杠转义，直接写 "\n" 会变成真换行。
var NL = string([]byte{10})

func parseVerdict(out string) (verdict string, reason string) {
	verdict = VerdictUnknown
	for _, line := range strings.Split(out, NL) {
		s := strings.TrimSpace(line)
		if !strings.HasPrefix(s, verdictMarker) {
			continue
		}
		rest := strings.TrimSpace(strings.TrimPrefix(s, verdictMarker))
		word, tail := rest, ""
		if i := strings.IndexAny(rest, " \t"); i >= 0 {
			word, tail = rest[:i], strings.TrimSpace(rest[i+1:])
		}
		switch strings.ToLower(word) {
		case VerdictPass:
			verdict, reason = VerdictPass, tail
		case VerdictReject:
			verdict, reason = VerdictReject, tail
		default:
			verdict, reason = VerdictUnknown, tail
		}
	}
	return verdict, reason
}

// FakeExecutor 不依赖网络：注入的环境变量只记录名字，密钥不回显。
//
// AIVerdict 让假执行器也能演容器自审：留空时对 review=ai 的节点回 pass，
// 想演不通过就填 reject 并配 AIReason。
type FakeExecutor struct {
	AIVerdict string
	AIReason  string
}

func (f FakeExecutor) Run(r *Requirement, n *Node, now time.Time) (Attempt, Comment, []string) {
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
	if n.Review == ReviewAI {
		a.Verdict = f.AIVerdict
		if a.Verdict == "" {
			a.Verdict = VerdictPass
		}
		a.VerdictReason = f.AIReason
	}
	c := Comment{ID: newID("c"), AuthorType: "container", Author: tmpl, Body: body, At: now}
	return a, c, []string{fmt.Sprintf("%s.artifact", n.Key)}
}

// verdictLine 是人读评论时第一眼要看到的那行：这一站到底自己认没认。
func verdictLine(n *Node, verdict, reason string) string {
	if n.Review != ReviewAI {
		return "审核方：人工（容器不给结论）"
	}
	if reason == "" {
		return "审核方：AI 自审，结论 " + verdict
	}
	return "审核方：AI 自审，结论 " + verdict + "：" + reason
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
