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
	// Image 是镜像引用，原样交给 docker——要带 tag（如 ${APP}/agent-codex:latest）。
	// Version 不是 tag，见下面那行注释。
	Image string `json:"image"`
	// Version 是镜像里那个 agent CLI 的版本（默认 latest），不是镜像 tag。
	// 它与 Image 互不影响：换 CLI 版本不改镜像引用，见 ImageRef 的说明。
	Version string `json:"version,omitempty"`
	// Versions 是可以选的版本候选，只用于 /api/templates 的下拉框；缺省只有 latest。
	Versions []string          `json:"versions,omitempty"`
	Command  []string          `json:"command"`
	Env      map[string]string `json:"env,omitempty"`
	Timeout  time.Duration     `json:"timeout,omitempty"`
}

// ImageRef 给出真正传给 docker 的镜像引用：就是声明里写的那一个，原样使用。
//
// 为什么不拿 Version 去拼 tag：Version 是「镜像里那个 agent CLI 的版本」，
// 不是镜像 tag。镜像里已经装着运行时（npx 之类），换 CLI 版本不需要重烘镜像，
// 所以镜像引用与 CLI 版本是两件互不影响的事实。
//
// 将来若真把 harness 烘进镜像（image:tag = harness@version），再加一个显式的
// packaged 开关来拼 tag——本期不做，免得两个语义又混在一起。
//
// ${APP} 占位符在这里再展开一次：加载时已经展开过，这里是给直接构造 Template
// 的调用方（测试、内嵌表）兜底。
func (t Template) ImageRef() string {
	return ExpandPlaceholders(strings.TrimSpace(t.Image))
}

// defaultImageTag 是内嵌兜底表里镜像的 tag。它只是「本地 build 出来的那个 tag」，
// 与 Template.Version（agent CLI 版本）不是一回事——两个都恰好叫 latest 纯属巧合。
const defaultImageTag = "latest"

// defaultTemplateRegistry 是内嵌兜底表（没有任何声明文件时用它）。
// 镜像名指向 deploy/agent-image/ 里本地 build 的 tag：没 build 过就以
// 「容器没跑起来」落一条评论，而不是静默成功。
func defaultTemplateRegistry() map[string]Template {
	return map[string]Template{
		"deepseek-harness": {Key: "deepseek-harness", Image: appPlaceholder + "/agent-deepseek-harness:" + defaultImageTag, Version: defaultAgentVersion, Command: []string{"/opt/agent/entrypoint.sh"}},
		"codex":            {Key: "codex", Image: appPlaceholder + "/agent-codex:" + defaultImageTag, Version: defaultAgentVersion, Command: []string{"/opt/agent/entrypoint.sh"}},
		"claude":           {Key: "claude", Image: appPlaceholder + "/agent-claude:" + defaultImageTag, Version: defaultAgentVersion, Command: []string{"/opt/agent/entrypoint.sh"}},
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
			t.Version = defaultAgentVersion
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
	// Source 是仓库在工作区里的子目录名（默认 repo）。
	// 工作区根放平台写的 AGENTS.md，仓库必须待在子目录里：
	// 这样「平台这份」与「仓库自带那份」是两个文件，谁也不动谁。
	Source string
}

// defaultSourceDir 是仓库在工作区里的默认目录名。
const defaultSourceDir = "repo"

// sourceDir 是这一次用的仓库子目录名。
func (d DockerExecutor) sourceDir() string {
	if s := strings.TrimSpace(d.Source); s != "" {
		return s
	}
	return defaultSourceDir
}

// nodeTemplateKey 决定这一站用哪个模板，顺序是：
//  1. 节点自己声明的 harness（配置节点时选的 agent 运行时）
//  2. deploy/nodes.yaml 的 nodes 段（节点类型 → 模板）
//  3. 内嵌默认表 defaultTemplates
//
// 三层都空 = 这一站不跑容器（空节点），由人动手。
func (d DockerExecutor) nodeTemplateKey(n *Node) string {
	if h := strings.TrimSpace(n.Harness); h != "" {
		return h
	}
	if v, ok := d.Nodes[n.Type]; ok {
		return v
	}
	return defaultTemplates[n.Type]
}

// agentVersion 是这一站要跑的 agent CLI 版本：节点声明优先，其次模板声明，最后 latest。
// 它只影响容器里的 CLI，不影响镜像引用。
func agentVersion(n *Node, tmpl Template) string {
	if v := strings.TrimSpace(n.Version); v != "" {
		return v
	}
	if v := strings.TrimSpace(tmpl.Version); v != "" {
		return v
	}
	return defaultAgentVersion
}

// TemplateKeys 是这台执行器认得的 harness 键，升序——建链校验与前端下拉框都读它。
func (d DockerExecutor) TemplateKeys() []string { return d.templateKeys() }

// TemplateList 把整张模板表按 key 升序交出去：GET /api/templates 用它拼下拉框。
func (d DockerExecutor) TemplateList() []Template {
	out := make([]Template, 0, len(d.Templates))
	for _, k := range d.templateKeys() {
		out = append(out, d.Templates[k])
	}
	return out
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
	tmplKey := d.nodeTemplateKey(n)
	tmpl, ok := d.Templates[tmplKey]
	if !ok {
		return d.failed(r, n, now, tmplKey, fmt.Sprintf("没有这个容器模板：%s（模板表里只有 %s）", tmplKey, strings.Join(d.templateKeys(), "、")))
	}
	// 自定义 AGENTS.md：注入前重算摘要与库里比对，对不上这一站就不跑。
	// 不一致的内容绝不进容器 —— 那等于让容器跑一份没人知道是什么的指令。
	appendText, err := ReadNodeAgents(n)
	if err != nil {
		return d.failed(r, n, now, tmplKey, agentsDriftComment(err))
	}
	source := d.sourceDir()
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
	// 挂载点也是工作区里的那个子目录：工作区根留给平台写的 AGENTS.md。
	if mountDir != "" {
		args = append(args, "--mount", "type=bind,source="+mountDir+",target="+workspaceRoot+"/"+source, "--workdir", workspaceRoot)
	}
	env := []string{
		"BASE_URL=" + d.BaseURL,
		"CHAIN_MODEL=" + d.Model,
		// 整份 AGENTS.md 的正文 + 站在工作区里的仓库子目录名。
		// 追加内容另外再给一份：有的 agent 不读文件，prompt 是保底。
		"CHAIN_AGENTS_MD=" + agentsDocText(n, source, appendText),
		"CHAIN_AGENTS_APPEND=" + appendText,
		"CHAIN_SOURCE=" + source,
		"CHAIN_REQUIREMENT=" + r.ID,
		"CHAIN_NODE=" + n.Key,
		"CHAIN_REPO=" + repo,
		"CHAIN_BRANCH=" + r.Branch,
		"CHAIN_WORKSPACE_MODE=" + workspaceMode,
		// 哪个 agent CLI、什么版本：entrypoint 靠这两个决定跑什么。
		// version 是自由输入（前端 allow-create），这里只负责原样交过去，不做白名单。
		"CHAIN_AGENT=" + tmplKey,
		"CHAIN_AGENT_VERSION=" + agentVersion(n, tmpl),
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

	err = cmd.Run()
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
	workspaceLine := fmt.Sprintf("工作区 clone：%s（容器自己 clone 到 %s/%s）", orNone(repo, "（没配仓库）"), workspaceRoot, source)
	if mountDir != "" {
		workspaceLine = fmt.Sprintf("工作区 mount：%s（开发捷径：挂本机目录，不 clone）", mountDir)
	}
	body := strings.Join([]string{
		fmt.Sprintf("【容器执行】模板 %s（镜像 %s），节点 %s（%s）", tmpl.Key, tmpl.ImageRef(), n.Key, n.Type),
		fmt.Sprintf("分支 %s，退出码 %d，结论 %s", r.Branch, exit, outcome),
		workspaceLine,
		verdictLine(n, verdict, reason),
		agentsLine(n),
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

// workspaceRoot 是容器里的工作区根：AGENTS.md 在根上，仓库是它的子目录（见 Source）。
const workspaceRoot = "/work"

// nl 用字节拼出来：源码里直接写转义会被这条工具链吃掉一层，见 README「已知边界」。
var nl = string([]byte{10})

// agentsDocText 拼出整份 $WORKSPACE/AGENTS.md 的正文：默认职责 + 仓库策略指针 + 本站追加。
//
// 每次都整份重写，所以这份文件是我们自己的；仓库自带的 AGENTS.md 在 <source>/AGENTS.md，
// 一个字都不动（用户原话：「不是改原始 AGENTS.md」）。没有追加内容时不留空小节。
func agentsDocText(n *Node, source, appendText string) string {
	lines := []string{
		"你是链条上的一站：节点 " + n.Key + "（" + n.Type + "）。",
		"完成本节点职责后把结论写进评论；想自审表态就打一行 CHAIN_VERDICT: pass 或 CHAIN_VERDICT: reject 原因。",
		"仓库自带的策略在 " + source + "/AGENTS.md，存在就先读它，与本文冲突时以本文为准。",
	}
	doc := strings.Join(lines, nl)
	if strings.TrimSpace(appendText) == "" {
		return doc
	}
	return doc + nl + nl + "## 本站临时追加" + nl + nl + strings.TrimRight(appendText, nl) + nl
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
