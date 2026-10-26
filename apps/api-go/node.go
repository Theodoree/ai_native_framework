package main

import (
	"context"
	"encoding/json"
	"errors"
	"path/filepath"

	"ai-native-framework/apps/engine"
)

// 判定与折叠由 apps/engine 直接以库的方式执行：没有子进程、没有中间 JSON 搬运，
// 也就没有「同一份判定逻辑的第二份实现」。这里只剩形状搬运与错误翻译。

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

// engineErr 把引擎的 Fail 原样搬成 apiError：kind/code/message/extra 一个都不改。
func engineErr(fail *engine.Fail) error {
	if fail == nil {
		return infraErr("E_ENGINE_FAILED", "引擎没有给出失败详情")
	}
	kind := fail.Kind
	if kind != "rejected" {
		kind = "infra"
	}
	return &apiError{Kind: kind, Code: fail.Code, Message: fail.Message, Extra: engineExtra(fail.Extra)}
}

func engineExtra(value *engine.Value) map[string]any {
	if value == nil {
		return map[string]any{}
	}
	converted, ok := value.Interface().(map[string]any)
	if !ok {
		return map[string]any{}
	}
	return converted
}

// loadConfig 读状态机声明：错误消息里的路径保持相对形式（与 CLI 的文案一致）。
func (a *app) loadConfig() (*engine.Config, error) {
	cfg, fail := engine.LoadConfigAt(a.root, configRel)
	if fail != nil {
		return nil, engineErr(fail)
	}
	return cfg, nil
}

func (a *app) loadConfigPath(path string) (*engine.Config, error) {
	var (
		cfg  *engine.Config
		fail *engine.Fail
	)
	if filepath.IsAbs(path) {
		cfg, fail = engine.LoadConfig(path)
	} else {
		cfg, fail = engine.LoadConfigAt(a.root, path)
	}
	if fail != nil {
		return nil, engineErr(fail)
	}
	return cfg, nil
}

func (a *app) readEvents() (*engine.Value, error) {
	events, err := engine.ReadEvents(a.ledgerPath())
	if err != nil {
		return nil, engineErr(engine.AsFail(err, "E_LEDGER_UNREADABLE"))
	}
	return events, nil
}

// decide 直接把意图交给引擎的写入口（先校验守卫证据形状，再解析转换）。
func (a *app) decide(ctx context.Context, in intent) (*decision, error) {
	payload, err := json.Marshal(in)
	if err != nil {
		return nil, infraErr("E_INTENT_ENCODE", err.Error())
	}
	intentValue, parseErr := engine.ParseJSON(payload)
	if parseErr != nil {
		return nil, infraErr("E_INTENT_ENCODE", parseErr.Error())
	}
	cfg, err := a.loadConfig()
	if err != nil {
		return nil, err
	}
	result, fail := cfg.ValidateIntent(intentValue)
	if fail != nil {
		return nil, engineErr(fail)
	}
	var guards map[string]string
	if declared := result.Get("guards"); declared != nil {
		guards, err = parseGuardObject(declared.Interface())
		if err != nil {
			return nil, infraErr("E_VALIDATOR_OUTPUT", "判定器回的 guards 形状不对: "+err.Error())
		}
	}
	return &decision{
		From:   stringOf(result.Get("from")),
		To:     stringOf(result.Get("to")),
		By:     stringOf(result.Get("by")),
		Flow:   rawOf(result.Get("flow")),
		Event:  rawOf(result.Get("event")),
		Guards: guards,
	}, nil
}

func (a *app) boardConfig(ctx context.Context) (*boardConfig, error) {
	cfg, err := a.loadConfig()
	if err != nil {
		return nil, err
	}
	var parsed boardConfig
	if err := json.Unmarshal(cfg.View().Encode(), &parsed); err != nil {
		return nil, infraErr("E_NODE_OUTPUT", "账本 config 输出不是 JSON: "+err.Error())
	}
	return &parsed, nil
}

func (a *app) ledgerJSON(ctx context.Context, command string) (json.RawMessage, error) {
	events, err := a.readEvents()
	if err != nil {
		return nil, err
	}
	var payload *engine.Value
	switch command {
	case "events":
		payload = events
	case "fold":
		payload = engine.Fold(events)
	default:
		return nil, infraErr("E_NODE_OUTPUT", "账本没有这条子命令: "+command)
	}
	return json.RawMessage(payload.Encode()), nil
}

func (a *app) nextID(ctx context.Context) (string, error) {
	events, err := a.readEvents()
	if err != nil {
		return "", err
	}
	id := engine.NextID(events)
	if id == "" {
		return "", infraErr("E_NODE_OUTPUT", "账本 next-id 没有给出 id")
	}
	return id, nil
}

func (a *app) resolveEntry(ctx context.Context) (string, string, error) {
	cfg, err := a.loadConfig()
	if err != nil {
		return "", "", err
	}
	picked, fail := cfg.ResolveEntry(nil)
	if fail != nil {
		return "", "", engineErr(fail)
	}
	to, by := stringOf(picked.Get("to")), stringOf(picked.Get("by"))
	if to == "" || by == "" {
		return "", "", infraErr("E_NODE_OUTPUT", "账本 entry 没有给出 {to,by}")
	}
	return to, by, nil
}

func (a *app) appendEvent(ctx context.Context, event ledgerEvent) (json.RawMessage, error) {
	payload, err := json.Marshal(event)
	if err != nil {
		return nil, infraErr("E_EVENT_ENCODE", err.Error())
	}
	value, parseErr := engine.ParseJSON(payload)
	if parseErr != nil {
		return nil, infraErr("E_EVENT_ENCODE", parseErr.Error())
	}
	stored, appendErr := engine.AppendEvent(a.ledgerPath(), value)
	if appendErr != nil {
		return nil, engineErr(engine.AsFail(appendErr, "E_EVENT_ENCODE"))
	}
	return json.RawMessage(stored.Encode()), nil
}

func (a *app) checkConfig(ctx context.Context, path string) error {
	_, err := a.loadConfigPath(path)
	return err
}

// stringOf 只取字符串值：非字符串一律当空。
func stringOf(value *engine.Value) string {
	if value == nil {
		return ""
	}
	text, _ := value.StringValue()
	return text
}

// rawOf 把引擎值原样编码：缺值是 null，保证落账本的 flow/event 形状不变。
func rawOf(value *engine.Value) json.RawMessage {
	if value == nil {
		return json.RawMessage("null")
	}
	return json.RawMessage(value.Encode())
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
