package engine

// 状态机声明的加载与校验：这里逐条对应 scripts/state-validate.mjs 的 loadConfig，
// 校验顺序、错误码与中文文案都必须一致 —— 顺序错了就会改变「同一份坏配置报哪个错」。

import (
	"os"
	"path/filepath"
)

// None 是保留起点：不是状态，只出现在入口转换的 from 里。
const None = "none"

// Config 是一份通过校验的状态机声明。
type Config struct {
	Raw         *Value
	States      *Value
	Roles       *Value
	Transitions *Value
	Prefix      string
	// DefaultFlow 为 nil/undefined 表示声明里没写 policy.default_flow。
	DefaultFlow *Value
}

// LoadConfig 读磁盘上的声明文件。
func LoadConfig(path string) (*Config, *Fail) {
	text, err := os.ReadFile(path)
	if err != nil {
		return nil, Infra("E_CONFIG_MISSING", "读不到状态机配置: "+path, nil)
	}
	return ParseConfig(text)
}

// LoadConfigAt 在给定根目录下读声明：错误消息里保留相对路径（与 CLI 文案一致），
// 而真正的读取发生在 root 下，进程工作目录因此不再影响判定。
func LoadConfigAt(root, relative string) (*Config, *Fail) {
	text, err := os.ReadFile(filepath.Join(root, relative))
	if err != nil {
		return nil, Infra("E_CONFIG_MISSING", "读不到状态机配置: "+relative, nil)
	}
	return ParseConfig(text)
}

// ParseConfig 解析并校验声明文本。
func ParseConfig(text []byte) (*Config, *Fail) {
	cfg, err := ParseYAML(text)
	if err != nil {
		return nil, Infra("E_CONFIG_UNPARSABLE", "状态机配置不是合法 YAML: "+err.Error(), nil)
	}
	if cfg.Kind() == KindNull || !cfg.IsObject() {
		// JavaScript 里数组也满足 typeof === "object"，会走到下一行报缺 states；
		// 这里保持同样的落点，避免同一份输入换一个错误码。
		if cfg.IsArray() {
			return nil, Infra("E_CONFIG_STATES", "配置缺少 states", nil)
		}
		return nil, Infra("E_CONFIG_EMPTY", "状态机配置为空", nil)
	}
	states := cfg.Get("states")
	if states == nil || !states.IsObject() || states.EntryCount() == 0 {
		return nil, Infra("E_CONFIG_STATES", "配置缺少 states", nil)
	}
	if states.Has(None) {
		return nil, Infra("E_CONFIG_STATES", None+" 是保留起点，不能定义成状态", nil)
	}
	roles := cfg.Get("roles")
	if roles == nil || !roles.IsObject() || roles.EntryCount() == 0 {
		return nil, Infra("E_CONFIG_ROLES", "配置缺少 roles", nil)
	}
	transitions := cfg.Get("transitions")
	if transitions == nil || !transitions.IsArray() {
		return nil, Infra("E_CONFIG_TRANSITIONS", "配置缺少 transitions 数组", nil)
	}
	prefixValue := cfg.Get("label_prefix")
	prefix, isString := prefixValue.StringValue()
	if !isString || prefix == "" {
		return nil, Infra("E_CONFIG_PREFIX", "配置缺少 label_prefix", nil)
	}
	defaultFlow := Undefined()
	if policy := cfg.Get("policy"); policy.IsObject() {
		if declared := policy.Get("default_flow"); declared != nil {
			if !declared.IsString() {
				return nil, Infra("E_CONFIG_POLICY", "policy.default_flow 必须是字符串", nil)
			}
			defaultFlow = declared
		}
	}
	for index := 0; index < transitions.Len(); index++ {
		transition := transitions.At(index)
		if declared := transition.Get("flow"); declared != nil && !declared.IsString() {
			return nil, Infra("E_CONFIG_TRANSITION_SHAPE", "转换的 flow 必须是字符串: "+transition.EncodeString(), nil)
		}
		for _, key := range []string{"from", "to", "by"} {
			if _, ok := transition.Get(key).StringValue(); !ok {
				return nil, Infra("E_CONFIG_TRANSITION_SHAPE", "转换缺少 "+key+": "+transition.EncodeString(), nil)
			}
		}
		from, _ := transition.Get("from").StringValue()
		to, _ := transition.Get("to").StringValue()
		by, _ := transition.Get("by").StringValue()
		if from != "*" && from != None && !states.Has(from) {
			return nil, Infra("E_CONFIG_UNKNOWN_STATE", "转换引用了未定义状态: "+from, nil)
		}
		if !states.Has(to) {
			return nil, Infra("E_CONFIG_UNKNOWN_STATE", "转换引用了未定义状态: "+to, nil)
		}
		if !roles.Has(by) {
			return nil, Infra("E_CONFIG_UNKNOWN_ROLE", "转换引用了未定义角色: "+by, nil)
		}
		if from != "*" && from != None && terminalOf(states.Get(from)) {
			return nil, Infra("E_CONFIG_TERMINAL_SOURCE", "终态不能作为起点: "+from, nil)
		}
		if from == "*" && !terminalOf(states.Get(to)) {
			return nil, Infra("E_CONFIG_WILDCARD_TARGET", "通配转换只能落到终态: "+to, nil)
		}
	}
	return &Config{
		Raw:         cfg,
		States:      states,
		Roles:       roles,
		Transitions: transitions,
		Prefix:      prefix,
		DefaultFlow: defaultFlow,
	}, nil
}

// HasState 对应 `name in states`。
func (c *Config) HasState(name string) bool { return c.States.Has(name) }

// StateTerminal 对应 `states[name]?.terminal` 的真值。
func (c *Config) StateTerminal(name string) bool { return terminalOf(c.States.Get(name)) }

// StateMeaning 对应 `meta?.meaning ?? ""`。
func (c *Config) StateMeaning(name string) *Value {
	meta := c.States.Get(name)
	if meta == nil {
		return String("")
	}
	meaning := meta.Get("meaning")
	if meaning.IsNullish() {
		return String("")
	}
	return meaning
}

func terminalOf(meta *Value) bool {
	if meta == nil {
		return false
	}
	return meta.Get("terminal").Truthy()
}

// TransitionList 返回声明里的转换（顺序即文件顺序）。
func (c *Config) TransitionList() []*Value {
	items := make([]*Value, 0, c.Transitions.Len())
	for index := 0; index < c.Transitions.Len(); index++ {
		items = append(items, c.Transitions.At(index))
	}
	return items
}

// StateCount 对应 `Object.keys(cfg.states).length`。
func (c *Config) StateCount() int { return c.States.EntryCount() }

// TransitionCount 对应 `cfg.transitions.length`。
func (c *Config) TransitionCount() int { return c.Transitions.Len() }

// View 产出 ledger config 的输出形状（键序即契约）。
func (c *Config) View() *Value {
	out := Object()
	if c.DefaultFlow != nil && !c.DefaultFlow.IsNullish() {
		out.Set("defaultFlow", c.DefaultFlow)
	} else {
		out.Set("defaultFlow", Null())
	}
	out.Set("labelPrefix", String(c.Prefix))
	states := Array()
	for _, name := range c.States.Keys() {
		states.Append(ObjectOf(
			"name", String(name),
			"terminal", Bool(c.StateTerminal(name)),
			"meaning", c.StateMeaning(name),
		))
	}
	out.Set("states", states)
	out.Set("transitions", c.Transitions)
	return out
}
