package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

// Template 是一个容器模板：用哪个镜像、镜像里执行什么、跑多久、额外环境变量。
// 六类节点的默认模板只是默认值——声明文件 deploy/nodes.yaml 里的才是准的。
type Template struct {
	Key string `json:"key"`
	// Image 是镜像仓库地址，可以不带 tag（如 ${APP}/agent-codex）；tag 由 Version 补。
	Image string `json:"image"`
	// Version 是镜像 tag，默认 latest；image 自己带 tag 时以 image 为准。
	Version string            `json:"version,omitempty"`
	Command []string          `json:"command"`
	Env     map[string]string `json:"env,omitempty"`
	Timeout time.Duration     `json:"timeout,omitempty"`
}

// ImageRef 给出真正传给 docker 的镜像引用。
// 规则只有一条：最后一段已经带 tag（含 `:`）就原样用，否则补 :<Version>；
// Version 为空补 latest。${APP} 占位符在这里再展开一次——加载时已经展开过，
// 这里是给直接构造 Template 的调用方（测试、内嵌表）兜底。
func (t Template) ImageRef() string {
	img := ExpandPlaceholders(strings.TrimSpace(t.Image))
	if img == "" {
		return ""
	}
	version := strings.TrimSpace(t.Version)
	if version == "" {
		version = defaultImageVersion
	}
	// 只看最后一段：registry.example.com:5000/agent 里的端口号不算 tag。
	last := img
	if i := strings.LastIndex(img, "/"); i >= 0 {
		last = img[i+1:]
	}
	if strings.Contains(last, ":") {
		return img
	}
	return img + ":" + version
}

// defaultTemplateRegistry 是内嵌兜底表（没有任何声明文件时用它）。
// 镜像名指向 deploy/agent-image/ 里本地 build 的 tag：没 build 过就以
// 「容器没跑起来」落一条评论，而不是静默成功。
func defaultTemplateRegistry() map[string]Template {
	return map[string]Template{
		"deepseek-harness": {Key: "deepseek-harness", Image: appPlaceholder + "/agent-deepseek-harness", Version: defaultImageVersion, Command: []string{"/opt/agent/entrypoint.sh"}},
		"codex":            {Key: "codex", Image: appPlaceholder + "/agent-codex", Version: defaultImageVersion, Command: []string{"/opt/agent/entrypoint.sh"}},
		"claude":           {Key: "claude", Image: appPlaceholder + "/agent-claude", Version: defaultImageVersion, Command: []string{"/opt/agent/entrypoint.sh"}},
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
		t.Image = ExpandPlaceholders(t.Image)
		if t.Version == "" {
			t.Version = defaultImageVersion
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
	// Nodes 是节点类型 → 模板键的声明（deploy/nodes.yaml 的 nodes 段）。
	// 没声明的节点类型退回 defaultTemplates。
	Nodes map[string]string
	// Repo 给出这条需求的仓库地址：HTTP(S)/SSH 地址就交给容器自己 clone；
	// 只有本机绝对路径目录才挂进去（开发捷径）。空串表示没配仓库。
	Repo func(*Requirement) string
}

// nodeTemplateKey：声明优先，没声明退回内嵌默认值。
func (d DockerExecutor) nodeTemplateKey(nodeType string) string {
	if v, ok := d.Nodes[nodeType]; ok {
		return v
	}
	return defaultTemplates[nodeType]
}

// repoOf 拿这条需求的仓库地址；没接线就是空串。
func (d DockerExecutor) repoOf(r *Requirement) string {
	if d.Repo == nil {
		return ""
	}
	return strings.TrimSpace(d.Repo(r))
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
	// 空节点（dev / merge）由人动手，不起容器。正常流程不会走到这里：
	// http 层用 IsContainer 先拦一道，这道是纵深防御。
	if !IsContainer(n.Type) {
		return d.failed(r, n, now, "", fmt.Sprintf("节点 %s（%s）是空节点，不跑容器", n.Key, n.Type))
	}
	tmplKey := d.nodeTemplateKey(n.Type)
	tmpl, ok := d.Templates[tmplKey]
	if !ok {
		return d.failed(r, n, now, tmplKey, fmt.Sprintf("没有这个容器模板：%s（模板表里只有 %s）", tmplKey, strings.Join(d.templateKeys(), "、")))
	}

	key := os.Getenv(d.apiKeyEnv())
	// 默认 clone：容器自己拉代码，宿主不碰工作区。
	// 只有仓库写成本机绝对路径（开发时）才挂进去——那是捷径，不是常态。
	repo := d.repoOf(r)
	mountDir := ""
	if repo != "" && filepath.IsAbs(repo) {
		if st, err := os.Stat(repo); err == nil && st.IsDir() {
			mountDir = repo
		}
	}
	workspaceMode := workspaceClone
	if mountDir != "" {
		workspaceMode = workspaceMount
	}
	args := []string{"run", "--rm", "-i", "--init", "--network", d.network()}
	args = append(args, "--label", "chain.requirement="+r.ID, "--label", "chain.node="+n.Key)
	if mountDir != "" {
		args = append(args, "--mount", "type=bind,source="+mountDir+",target=/work", "--workdir", "/work")
	}
	env := []string{
		"BASE_URL=" + d.BaseURL,
		"CHAIN_MODEL=" + d.Model,
		"CHAIN_AGENTS_MD=" + nodeAgents(n),
		"CHAIN_REQUIREMENT=" + r.ID,
		"CHAIN_NODE=" + n.Key,
		"CHAIN_REPO=" + repo,
		"CHAIN_BRANCH=" + r.Branch,
		"CHAIN_WORKSPACE_MODE=" + workspaceMode,
		"CHAIN_CONTEXT=" + r.Context,
	}
	// 模板自己声明的环境变量（如 AGENT_NAME）排在最后，允许它们覆盖上面的默认值。
	for _, k := range sortedKeys(tmpl.Env) {
		env = append(env, k+"="+tmpl.Env[k])
	}
	for _, e := range env {
		args = append(args, "-e", e)
	}
	if key != "" {
		args = append(args, "-e", d.apiKeyEnv()+"="+key)
	}
	args = append(args, tmpl.ImageRef())
	args = append(args, tmpl.Command...)

	// 模板里声明的 timeout 优先；没声明才用执行器自己的默认（10 分钟）。
	limit := d.timeout()
	if tmpl.Timeout > 0 {
		limit = tmpl.Timeout
	}
	ctx, cancel := context.WithTimeout(context.Background(), limit)
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
	workspaceLine := fmt.Sprintf("工作区 clone：%s（容器自己 clone 这条分支）", orNone(repo, "（没配仓库）"))
	if mountDir != "" {
		workspaceLine = fmt.Sprintf("工作区 mount：%s（开发捷径：挂本机目录，不 clone）", mountDir)
	}
	body := strings.Join([]string{
		fmt.Sprintf("【容器执行】模板 %s（镜像 %s），节点 %s（%s）", tmpl.Key, tmpl.ImageRef(), n.Key, n.Type),
		fmt.Sprintf("分支 %s，退出码 %d，结论 %s", r.Branch, exit, outcome),
		workspaceLine,
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

// orNone 只是让评论里那句「工作区 …」不至于打印成空。
func orNone(s, fallback string) string {
	if s == "" {
		return fallback
	}
	return s
}

func (d DockerExecutor) failed(r *Requirement, n *Node, now time.Time, tmplKey, reason string) (Attempt, Comment, []string) {
	body := fmt.Sprintf("【容器执行】模板 %s 无法执行：%s", tmplKey, reason)
	if tmplKey == "" {
		body = "【容器执行】无法执行：" + reason
	}
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
