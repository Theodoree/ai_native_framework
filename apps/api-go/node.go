package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

// 判定与折叠都是本机进程，30s 足够；卡住就是 infra，不是通过。
const nodeTimeout = 30 * time.Second

type cliFailure struct {
	Kind    string
	Verdict string
	Code    string
	Message string
	Extra   map[string]any
}

type intent struct {
	Labels    []string `json:"labels"`
	To        string   `json:"to"`
	ActorRole string   `json:"actor_role"`
	Comment   string   `json:"comment,omitempty"`
	// Guards 是写者给的守卫证据（名 → 证据字符串）。Go 只搬形状，不判内容：
	// 「这个守卫需要什么证据」只有声明说，「证据是真的」只有写者担保。
	Guards map[string]string `json:"guards,omitempty"`
}

type decision struct {
	From   string
	To     string
	By     string
	Flow   json.RawMessage
	Event  json.RawMessage
	Guards map[string]string
}

type ledgerEvent struct {
	ID      string          `json:"id"`
	At      string          `json:"at"`
	Title   *string         `json:"title,omitempty"`
	Body    *string         `json:"body,omitempty"`
	From    string          `json:"from"`
	To      string          `json:"to"`
	By      string          `json:"by"`
	Flow    json.RawMessage `json:"flow"`
	Comment string          `json:"comment"`
	// omitempty 是契约的一部分：没有证据的事件一个字节都不多出来，
	// 既有账本行的形状因此与改动前完全一致。
	Guards map[string]string `json:"guards,omitempty"`
}

type stateMeta struct {
	Name     string `json:"name"`
	Terminal bool   `json:"terminal"`
	Meaning  string `json:"meaning"`
}

type boardConfig struct {
	DefaultFlow *string         `json:"defaultFlow"`
	LabelPrefix string          `json:"labelPrefix"`
	States      []stateMeta     `json:"states"`
	Transitions json.RawMessage `json:"transitions"`
}

// runNode 是所有 Node 调用的唯一出口：工作目录固定仓库根，
// 两个入口的相对路径与账本默认位置才同时成立。
func (a *app) runNode(ctx context.Context, stdin []byte, script string, args ...string) ([]byte, error) {
	ctx, cancel := context.WithTimeout(ctx, nodeTimeout)
	defer cancel()
	commandArgs := append([]string{filepath.Join(a.root, "scripts", script)}, args...)
	cmd := exec.CommandContext(ctx, "node", commandArgs...)
	cmd.Dir = a.root
	if stdin != nil {
		cmd.Stdin = bytes.NewReader(stdin)
	}
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		return nil, nodeFailure(ctx, err, stdout.Bytes(), stderr.Bytes())
	}
	return stdout.Bytes(), nil
}

// nodeFailure: 判定器把结构化结果写在 stdout（退出码非 0 也是），ledger-cli 写在 stderr。
// 两边都认，但只搬 kind/code/message/extra，不重新分类。
func nodeFailure(ctx context.Context, err error, stdout, stderr []byte) error {
	failure, ok := parseCLIFailure(stdout)
	if !ok {
		failure, ok = parseCLIFailure(stderr)
	}
	if ok {
		// 判定器用 verdict 表达结论，ledger-cli 用 kind；两者都只当搬运工的输入。
		kind := failure.Kind
		if kind == "" {
			kind = failure.Verdict
		}
		if kind != "rejected" {
			kind = "infra"
		}
		return &apiError{Kind: kind, Code: failure.Code, Message: failure.Message, Extra: failure.Extra}
	}
	message := strings.TrimSpace(string(stderr))
	if message == "" {
		message = strings.TrimSpace(string(stdout))
	}
	code := "E_NODE_FAILED"
	if errors.Is(ctx.Err(), context.DeadlineExceeded) {
		code = "E_NODE_TIMEOUT"
		if message == "" {
			message = "Node 入口 30s 内没有返回"
		}
	}
	if message == "" {
		message = err.Error()
	}
	return infraErr(code, message)
}

// parseCLIFailure 从末尾往前找第一条带 code 的 JSON：Node 入口把自己的结论放在那里，
// 中间层原样搬运，不重新解释；verdict/code/message 之外的键都收进 extra。
func parseCLIFailure(out []byte) (cliFailure, bool) {
	lines := strings.Split(strings.TrimSpace(string(out)), "\n")
	for index := len(lines) - 1; index >= 0; index-- {
		var parsed map[string]any
		if json.Unmarshal([]byte(lines[index]), &parsed) != nil {
			continue
		}
		failure := cliFailure{Extra: map[string]any{}}
		for key, value := range parsed {
			switch key {
			case "kind":
				failure.Kind = anyString(value)
			case "verdict":
				failure.Verdict = anyString(value)
			case "code":
				failure.Code = anyString(value)
			case "message":
				failure.Message = anyString(value)
			case "extra":
				if nested, ok := value.(map[string]any); ok {
					for nestedKey, nestedValue := range nested {
						failure.Extra[nestedKey] = nestedValue
					}
				}
			default:
				failure.Extra[key] = value
			}
		}
		if failure.Code != "" {
			return failure, true
		}
	}
	return cliFailure{}, false
}

// decide 把意图原样交给判定器：--intent - 表示从 stdin 读，走管道而不是 /dev/stdin。
func (a *app) decide(ctx context.Context, in intent) (*decision, error) {
	payload, err := json.Marshal(in)
	if err != nil {
		return nil, infraErr("E_INTENT_ENCODE", err.Error())
	}
	out, err := a.runNode(ctx, payload, validatorCLI, "--json", "--intent", "-")
	if err != nil {
		return nil, err
	}
	line, err := firstJSONLine(out)
	if err != nil {
		return nil, infraErr("E_VALIDATOR_OUTPUT", err.Error())
	}
	var parsed map[string]any
	if err := json.Unmarshal(line, &parsed); err != nil {
		return nil, infraErr("E_VALIDATOR_OUTPUT", "判定器输出不是 JSON 对象: "+shorten(string(line)))
	}
	verdict, _ := parsed["verdict"].(string)
	code, _ := parsed["code"].(string)
	message, _ := parsed["message"].(string)
	extra := map[string]any{}
	for key, value := range parsed {
		switch key {
		case "verdict", "code", "message":
			continue
		}
		extra[key] = value
	}
	if code == "" {
		code = "E_VALIDATOR_OUTPUT"
	}
	switch verdict {
	case "allowed":
		guards, guardErr := parseGuardObject(extra["guards"])
		if guardErr != nil {
			return nil, infraErr("E_VALIDATOR_OUTPUT", "判定器回的 guards 形状不对: "+guardErr.Error())
		}
		return &decision{
			From:   anyString(extra["from"]),
			To:     anyString(extra["to"]),
			By:     anyString(extra["by"]),
			Flow:   rawOrNull(extra["flow"]),
			Event:  rawOrNull(extra["event"]),
			Guards: guards,
		}, nil
	case "rejected":
		return nil, &apiError{Kind: "rejected", Code: code, Message: message, Extra: extra}
	case "infra":
		return nil, &apiError{Kind: "infra", Code: code, Message: message, Extra: extra}
	default:
		return nil, infraErr("E_VALIDATOR_OUTPUT", "判定器没有给出 verdict: "+shorten(string(line)))
	}
}

func (a *app) boardConfig(ctx context.Context) (*boardConfig, error) {
	out, err := a.runNode(ctx, nil, ledgerCLI, "config", "--json")
	if err != nil {
		return nil, err
	}
	var cfg boardConfig
	if err := json.Unmarshal(bytes.TrimSpace(out), &cfg); err != nil {
		return nil, infraErr("E_NODE_OUTPUT", "ledger-cli config 输出不是 JSON: "+err.Error())
	}
	return &cfg, nil
}

func (a *app) ledgerJSON(ctx context.Context, command string) (json.RawMessage, error) {
	out, err := a.runNode(ctx, nil, ledgerCLI, command, "--json")
	if err != nil {
		return nil, err
	}
	trimmed := bytes.TrimSpace(out)
	if !json.Valid(trimmed) {
		return nil, infraErr("E_NODE_OUTPUT", "ledger-cli "+command+" 输出不是合法 JSON")
	}
	return json.RawMessage(trimmed), nil
}

func (a *app) nextID(ctx context.Context) (string, error) {
	out, err := a.runNode(ctx, nil, ledgerCLI, "next-id", "--json")
	if err != nil {
		return "", err
	}
	var parsed struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal(bytes.TrimSpace(out), &parsed); err != nil || parsed.ID == "" {
		return "", infraErr("E_NODE_OUTPUT", "ledger-cli next-id 没有给出 id")
	}
	return parsed.ID, nil
}

func (a *app) resolveEntry(ctx context.Context) (string, string, error) {
	out, err := a.runNode(ctx, nil, ledgerCLI, "entry", "--json")
	if err != nil {
		return "", "", err
	}
	var parsed struct {
		To string `json:"to"`
		By string `json:"by"`
	}
	if err := json.Unmarshal(bytes.TrimSpace(out), &parsed); err != nil || parsed.To == "" || parsed.By == "" {
		return "", "", infraErr("E_NODE_OUTPUT", "ledger-cli entry 没有给出 {to,by}")
	}
	return parsed.To, parsed.By, nil
}

func (a *app) appendEvent(ctx context.Context, event ledgerEvent) (json.RawMessage, error) {
	payload, err := json.Marshal(event)
	if err != nil {
		return nil, infraErr("E_EVENT_ENCODE", err.Error())
	}
	out, err := a.runNode(ctx, payload, ledgerCLI, "append", "--json")
	if err != nil {
		return nil, err
	}
	trimmed := bytes.TrimSpace(out)
	if !json.Valid(trimmed) {
		return nil, infraErr("E_NODE_OUTPUT", "ledger-cli append 没有回显落盘事件")
	}
	return json.RawMessage(trimmed), nil
}

func (a *app) checkConfig(ctx context.Context, path string) error {
	_, err := a.runNode(ctx, nil, validatorCLI, "--json", "--check-config", "--config", path)
	return err
}

func firstJSONLine(out []byte) ([]byte, error) {
	for _, line := range bytes.Split(out, []byte("\n")) {
		trimmed := bytes.TrimSpace(line)
		if len(trimmed) > 0 {
			return trimmed, nil
		}
	}
	return nil, errors.New("判定器没有任何输出")
}

func rawOrNull(value any) json.RawMessage {
	if value == nil {
		return json.RawMessage("null")
	}
	raw, err := json.Marshal(value)
	if err != nil {
		return json.RawMessage("null")
	}
	return raw
}

func anyString(value any) string {
	text, _ := value.(string)
	return text
}

// parseGuardObject 只搬形状：对象且每个值都是字符串才收下，nil 表示「没有证据」。
// 这里刻意不判「证据够不够/真不真」—— 那是判定器与写者各自的事，Go 重判就是第二份判定。
func parseGuardObject(value any) (map[string]string, error) {
	if value == nil {
		return nil, nil
	}
	object, ok := value.(map[string]any)
	if !ok {
		return nil, errors.New("guards 必须是对象（守卫名 → 证据字符串）")
	}
	guards := make(map[string]string, len(object))
	for name, evidence := range object {
		text, ok := evidence.(string)
		if !ok {
			return nil, errors.New("守卫证据 " + name + " 不是字符串")
		}
		guards[name] = text
	}
	return guards, nil
}

func shorten(text string) string {
	runes := []rune(text)
	if len(runes) <= 500 {
		return text
	}
	return string(runes[:500]) + "…"
}
