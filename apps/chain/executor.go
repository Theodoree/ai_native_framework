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
	// TemplateKeys 是本执行器认得的 harness 键（容器模板名），升序。
	// 服务端在「建链」与 GET /api/templates 两处要用它：前者提前拒绝认不出的 harness，
	// 后者给前端渲染下拉框。放在接口上而不是让 http 层去摸具体实现。
	TemplateKeys() []string
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
	// Templates / Nodes 是声明的模板表（deploy/nodes.yaml 那份）。
	// 留空就用内嵌默认表：假执行器不接 docker，但前端下拉框与建链校验要用同一份声明，
	// 否则「-exec fake 启动时 /api/templates 只有 latest」会变成一条假事实。
	Templates map[string]Template
	Nodes     map[string]string
}

// tables 返回这个假执行器实际用的模板表：声明优先，没声明就用内嵌默认表。
func (f FakeExecutor) tables() map[string]Template {
	if len(f.Templates) > 0 {
		return f.Templates
	}
	return defaultTemplateRegistry()
}

// TemplateKeys 给假执行器也配上模板键：不接 docker 时前端仍要能列出下拉选项。
func (f FakeExecutor) TemplateKeys() []string { return sortedKeys(f.tables()) }

// fakeTemplateKeys 是内嵌默认表的三个键，给「只关心键名」的测试与桩用。
func fakeTemplateKeys() []string {
	return sortedKeys(defaultTemplateRegistry())
}

// TemplateList 让假执行器也能回镜像与版本：前端不接 docker 时照样要渲染下拉框。
func (f FakeExecutor) TemplateList() []Template {
	reg := f.tables()
	out := make([]Template, 0, len(reg))
	for _, k := range sortedKeys(reg) {
		out = append(out, reg[k])
	}
	return out
}

func (f FakeExecutor) Run(r *Requirement, n *Node, now time.Time) (Attempt, Comment, []string) {
	// 节点声明了 harness 就用它，否则按类型映射——与真执行器同一套选择顺序。
	tmpl := defaultTemplates[n.Type]
	if v, ok := f.Nodes[n.Type]; ok {
		tmpl = v
	}
	if h := strings.TrimSpace(n.Harness); h != "" {
		tmpl = h
	}
	body := strings.Join([]string{
		fmt.Sprintf("【假执行】模板 %s，节点 %s（%s）", tmpl, n.Key, n.Type),
		fmt.Sprintf("注入：BASE_URL、model、AGENTS.md（默认文件不改）"),
		fmt.Sprintf("需求：%s，分支 %s", r.ID, r.Branch),
		fmt.Sprintf("需求正文：%s", oneLine(r.Context)),
		agentsLine(n),
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

// agentsLine 是评论里「这一站有没有自定义 AGENTS.md」那一行。
// 有就报字节数与摘要前缀：人能从库里那份记录核对上，不必去翻家目录。
func agentsLine(n *Node) string {
	if n == nil || n.Agents == nil || strings.TrimSpace(n.Agents.Path) == "" {
		return "自定义 AGENTS.md：无（只有平台的默认职责与仓库策略指针）"
	}
	checksum := n.Agents.Checksum
	if len(checksum) > 12 {
		checksum = checksum[:12]
	}
	return fmt.Sprintf("自定义 AGENTS.md：%d 字节，%s…（%s）", n.Agents.Size, checksum, n.Agents.Path)
}

func oneLine(s string) string {
	s = strings.ReplaceAll(s, "\n", " ")
	if len(s) > 120 {
		return s[:120] + "…"
	}
	return s
}
