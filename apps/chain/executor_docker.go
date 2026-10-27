package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"sort"
	"strings"
	"time"
)

// Template 是一个容器模板：用哪个镜像、镜像里执行什么。
// 六类节点的默认模板只是默认值——用户可以新增模板，不需要改代码。
type Template struct {
	Key     string   `json:"key"`
	Image   string   `json:"image"`
	Command []string `json:"command"`
}

// defaultTemplates 只给按键找到的默认值；镜像名是占位，本地没有这个镜像时会
// 以「容器没跑起来」落一条评论，而不是静默成功。
func defaultTemplateRegistry() map[string]Template {
	return map[string]Template{
		"deepseek-harness": {Key: "deepseek-harness", Image: "ai-native/deepseek-harness:latest", Command: []string{"chain-run"}},
		"codex":            {Key: "codex", Image: "ai-native/codex:latest", Command: []string{"chain-run"}},
		"claude":           {Key: "claude", Image: "ai-native/claude:latest", Command: []string{"chain-run"}},
	}
}

// LoadTemplates 读一份模板表；文件里的键覆盖默认值（不是整体替换），
// 这样加一个新模板只需要写增量。
func LoadTemplates(path string) (map[string]Template, error) {
	out := defaultTemplateRegistry()
	if path == "" {
		return out, nil
	}
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var extra map[string]Template
	if err := json.Unmarshal(b, &extra); err != nil {
		return nil, fmt.Errorf("模板表不是合法 JSON：%w", err)
	}
	for k, t := range extra {
		if t.Key == "" {
			t.Key = k
		}
		if t.Image == "" || len(t.Command) == 0 {
			return nil, fmt.Errorf("模板 %s 缺少 image 或 command", k)
		}
		out[k] = t
	}
	return out, nil
}

// DockerExecutor 用本机 docker 跑一次容器。接口保持不变：将来换 k3s 只是换实现。
type DockerExecutor struct {
	Templates map[string]Template
	Docker    string        // 默认为 docker
	Timeout   time.Duration // 单次执行上限，默认 10 分钟
	BaseURL   string        // 注入给容器的 BASE_URL
	Model     string        // 注入给容器的 model
	APIKeyEnv string        // 从哪个环境变量取 key（默认 CHAIN_MODEL_KEY）
	Network   string        // docker 网络模式，默认 bridge
	// Workspace 给出某条需求要在容器里看到的那个目录。返回空串表示这次不挂。
	// 它是接线层的责任：执行器自己不知道该去问谁要仓库路径。
	Workspace func(*Requirement) string
}

func (d DockerExecutor) name() string {
	if d.Docker == "" {
		return "docker"
	}
	return d.Docker
}

func (d DockerExecutor) timeout() time.Duration {
	if d.Timeout <= 0 {
		return 10 * time.Minute
	}
	return d.Timeout
}

func (d DockerExecutor) apiKeyEnv() string {
	if d.APIKeyEnv == "" {
		return "CHAIN_MODEL_KEY"
	}
	return d.APIKeyEnv
}

func (d DockerExecutor) network() string {
	if d.Network == "" {
		return "bridge"
	}
	return d.Network
}

// Run 起一次容器，把它的输出变成评论。退出码原样记录：0 是成功，其余是失败。
func (d DockerExecutor) Run(r *Requirement, n *Node, now time.Time) (Attempt, Comment, []string) {
	tmplKey := defaultTemplates[n.Type]
	tmpl, ok := d.Templates[tmplKey]
	if !ok {
		return d.failed(r, n, now, tmplKey, fmt.Sprintf("没有这个容器模板：%s（模板表里只有 %s）", tmplKey, strings.Join(d.templateKeys(), "、")))
	}

	key := os.Getenv(d.apiKeyEnv())
	args := []string{"run", "--rm", "-i", "--init", "--network", d.network()}
	args = append(args, "--label", "chain.requirement="+r.ID, "--label", "chain.node="+n.Key)
	if repo := d.workspace(r); repo != "" {
		args = append(args, "--mount", "type=bind,source="+repo+",target=/work", "--workdir", "/work")
	}
	env := []string{
		"BASE_URL=" + d.BaseURL,
		"CHAIN_MODEL=" + d.Model,
		"CHAIN_AGENTS_MD=" + nodeAgents(n),
		"CHAIN_REQUIREMENT=" + r.ID,
		"CHAIN_NODE=" + n.Key,
		"CHAIN_BRANCH=" + r.Branch,
		"CHAIN_CONTEXT=" + r.Context,
	}
	for _, e := range env {
		args = append(args, "-e", e)
	}
	if key != "" {
		args = append(args, "-e", d.apiKeyEnv()+"="+key)
	}
	args = append(args, tmpl.Image)
	args = append(args, tmpl.Command...)

	ctx, cancel := context.WithTimeout(context.Background(), d.timeout())
	defer cancel()
	cmd := exec.CommandContext(ctx, d.name(), args...)
	out := &tailWriter{max: 8000}
	cmd.Stdout = out
	cmd.Stderr = out

	err := cmd.Run()
	exit := 0
	outcome := "succeeded"
	if err != nil {
		outcome = "failed"
		exit = 1
		var ee *exec.ExitError
		if errors.As(err, &ee) {
			exit = ee.ExitCode()
		}
		if ctx.Err() == context.DeadlineExceeded {
			outcome = "timeout"
			exit = 124
		}
	}

	shown := redact(strings.Join(append([]string{d.name()}, args...), " "), key)
	outText := redact(out.String(), key)
	log := "命令: " + shown + "\n---\n" + outText
	if err != nil {
		log = "命令: " + shown + "\n错误: " + redact(err.Error(), key) + "\n---\n" + outText
	}
	verdict, reason := parseVerdict(outText)
	body := strings.Join([]string{
		fmt.Sprintf("【容器执行】模板 %s（镜像 %s），节点 %s（%s）", tmpl.Key, tmpl.Image, n.Key, n.Type),
		fmt.Sprintf("分支 %s，退出码 %d，结论 %s", r.Branch, exit, outcome),
		verdictLine(n, verdict, reason),
		rulesLine(n.Rules),
		"--- 容器输出（尾部）---",
		outText,
	}, "\n")
	// 兜底：不管密钥从哪条路径进来，落库前都再抹一次。
	log = redact(log, key)
	body = redact(body, key)

	a := Attempt{
		StartedAt: now, EndedAt: time.Now(), ExitCode: exit, Template: tmpl.Key, Log: log, Outcome: outcome,
		Verdict: verdict, VerdictReason: reason,
	}
	c := Comment{ID: newID("c"), AuthorType: "container", Author: tmpl.Key, Body: body, At: now}
	return a, c, nil
}

// workspace 只挂本机目录：本地执行器不做 clone，远端仓库由节点自己处理。
func (d DockerExecutor) workspace(r *Requirement) string {
	if d.Workspace == nil {
		return ""
	}
	dir := d.Workspace(r)
	if dir == "" {
		return ""
	}
	if st, err := os.Stat(dir); err != nil || !st.IsDir() {
		return ""
	}
	return dir
}

func (d DockerExecutor) failed(r *Requirement, n *Node, now time.Time, tmplKey, reason string) (Attempt, Comment, []string) {
	body := fmt.Sprintf("【容器执行】模板 %s 无法执行：%s", tmplKey, reason)
	a := Attempt{StartedAt: now, EndedAt: now, ExitCode: 2, Template: tmplKey, Log: reason, Outcome: "failed"}
	c := Comment{ID: newID("c"), AuthorType: "container", Author: tmplKey, Body: body, At: now}
	return a, c, nil
}

func (d DockerExecutor) templateKeys() []string {
	out := make([]string, 0, len(d.Templates))
	for k := range d.Templates {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

// nodeAgents 是这一站交给容器的指令：默认文件 + 本站追加的规则。
// 追加只进容器，不改仓库里的默认文件。
// nl 用字节拼出来：源码里直接写转义会被这条工具链吃掉一层，见 README「已知边界」。
var nl = string([]byte{10})

func nodeAgents(n *Node) string {
	lines := []string{"你是链条上的一站：节点 " + n.Key + "（" + n.Type + "）。", "完成本节点职责后把结论写进评论。"}
	if len(n.Rules) > 0 {
		lines = append(lines, "本站追加规则："+nl+strings.Join(n.Rules, nl))
	}
	return strings.Join(lines, nl)
}

// redact 把密钥从要落盘的文本里抹掉：日志会进数据库、进页面，等于公开。
// 它必须作用在「最终要落盘的字符串」上——容器的 stdout 也会把密钥打出来。
func redact(s, secret string) string {
	if secret == "" {
		return s
	}
	return strings.ReplaceAll(s, secret, "***")
}

type tailWriter struct {
	max int
	buf []byte
}

func (t *tailWriter) Write(p []byte) (int, error) {
	t.buf = append(t.buf, p...)
	if len(t.buf) > t.max {
		t.buf = t.buf[len(t.buf)-t.max:]
	}
	return len(p), nil
}

func (t *tailWriter) String() string { return string(t.buf) }
