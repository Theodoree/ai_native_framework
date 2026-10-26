package engine

// 判定器：resolveEntry / resolveTransition / validateIntent / consultTransition。
// 判定顺序就是契约：同一份输入报哪个错，取决于这些检查的先后。

import (
	"strconv"
	"strings"
)

// TransitionResult 是 resolveTransition 的产物（不导出 transition 之外的细节）。
type TransitionResult struct {
	From       string
	To         string
	By         string
	Flow       *Value
	Event      *Value
	Transition *Value
}

// ResolveEntry 解析入口转换：from=none 的适用转换必须恰好一条。
func (c *Config) ResolveEntry(flow *Value) (*Value, *Fail) {
	effective := Null()
	if !flow.IsNullish() {
		effective = flow
	} else if !c.DefaultFlow.IsNullish() {
		effective = c.DefaultFlow
	}
	var candidate *Value
	matched := 0
	for _, transition := range c.TransitionList() {
		from, ok := transition.Get("from").StringValue()
		if !ok || from != None {
			continue
		}
		declared := Null()
		if flow := transition.Get("flow"); !flow.IsNullish() {
			declared = flow
		}
		if declared.Kind() == KindNull || strictEqual(declared, effective) {
			matched++
			if candidate == nil {
				candidate = transition
			}
		}
	}
	if matched != 1 {
		return nil, Infra(
			"E_ENTRY_AMBIGUOUS",
			"flow="+jsDisplay(effective)+" 下入口转换命中 "+strconv.Itoa(matched)+" 条，必须恰好一条",
			ObjectOf("flow", effective, "matched", Number(float64(matched))),
		)
	}
	result := Object()
	for index, key := range candidate.Keys() {
		result.Set(key, candidate.vals[index])
	}
	result.Set("flow", effective)
	return result, nil
}

// ResolveTransition 解析一次意图的转换（不含守卫证据）。
func (c *Config) ResolveTransition(intent *Value) (*TransitionResult, *Fail) {
	// JS 的判据是 typeof intent !== "object"，数组也满足它，因此落到下一条 labels 检查上。
	if intent.IsNullish() || (intent.Kind() != KindObject && intent.Kind() != KindArray) {
		return nil, Infra("E_INTENT_SHAPE", "意图不是对象", nil)
	}
	labels := intent.Get("labels")
	if !labels.IsArray() {
		return nil, Infra("E_INTENT_SHAPE", "意图缺少 labels 数组", nil)
	}
	to, hasTo := intent.Get("to").StringValue()
	if !hasTo {
		return nil, Infra("E_INTENT_SHAPE", "意图缺少目标状态 to", nil)
	}
	unresolved := intent.Get("unresolved")
	issue := intent.Get("issue")
	if unresolved.Truthy() || (issue != nil && issue.Kind() == KindNull) {
		reason := "issue 为空"
		if unresolved != nil {
			if declared := unresolved.Get("reason"); !declared.IsNullish() {
				reason = jsDisplay(declared)
			}
		}
		extra := Null()
		if !unresolved.IsNullish() {
			extra = unresolved
		}
		return nil, Infra(
			"E_ISSUE_UNRESOLVED",
			"意图没有归属的 issue（"+reason+"）——PR 号不作为 issue 号使用",
			ObjectOf("unresolved", extra),
		)
	}
	actorKey := jsDisplay(intent.Get("actor_role"))
	if !c.Roles.Has(actorKey) {
		return nil, Infra(
			"E_INTENT_SHAPE",
			"未知角色: "+actorKey+"（合法: "+strings.Join(c.Roles.Keys(), " / ")+"）",
			nil,
		)
	}
	actorRole, _ := intent.Get("actor_role").StringValue()

	stateLabels := Array()
	keptLabels := make([]string, 0, labels.Len())
	for index := 0; index < labels.Len(); index++ {
		label, ok := labels.At(index).StringValue()
		if ok && strings.HasPrefix(label, c.Prefix) {
			stateLabels.Append(String(label))
			keptLabels = append(keptLabels, label)
		}
	}
	if len(keptLabels) > 1 {
		return nil, Infra(
			"E_STATE_LABEL_COUNT",
			"issue 上最多只能有一个 "+c.Prefix+"* 标签，实际 "+strconv.Itoa(len(keptLabels))+" 个",
			ObjectOf("labels", stateLabels),
		)
	}
	from := None
	if len(keptLabels) == 1 {
		from = strings.TrimPrefix(keptLabels[0], c.Prefix)
	}
	if from != None && !c.HasState(from) {
		return nil, Infra("E_UNKNOWN_STATE", "当前状态未定义: "+from, nil)
	}
	if !c.HasState(to) {
		return nil, Infra("E_UNKNOWN_STATE", "目标状态未定义: "+to, nil)
	}
	if c.StateTerminal(from) {
		return nil, Rejected("E_TERMINAL_STATE", "终态 "+from+" 不能再转换", ObjectOf("from", String(from), "to", String(to)))
	}
	if actorRole == "agent" {
		return nil, Rejected("E_AGENT_CANNOT_WRITE", "agent 只能评论并建议，不能改状态", ObjectOf("from", String(from), "to", String(to)))
	}

	flow := Null()
	if declared := intent.Get("flow"); !declared.IsNullish() {
		flow = declared
	} else if !c.DefaultFlow.IsNullish() {
		flow = c.DefaultFlow
	}
	applicable := make([]*Value, 0, 1)
	for _, transition := range c.TransitionList() {
		transitionTo, _ := transition.Get("to").StringValue()
		transitionFrom, _ := transition.Get("from").StringValue()
		if transitionTo != to || (transitionFrom != from && transitionFrom != "*") {
			continue
		}
		declared := Null()
		if value := transition.Get("flow"); !value.IsNullish() {
			declared = value
		}
		if declared.Kind() == KindNull || strictEqual(declared, flow) {
			applicable = append(applicable, transition)
		}
	}
	if len(applicable) > 1 {
		return nil, Infra(
			"E_TRANSITION_AMBIGUOUS",
			from+" → "+to+" 在 flow="+jsDisplay(flow)+" 下命中 "+strconv.Itoa(len(applicable))+" 条转换，必须恰好一条",
			ObjectOf("from", String(from), "to", String(to), "flow", flow, "matched", Number(float64(len(applicable)))),
		)
	}
	var transition *Value
	if len(applicable) == 1 {
		transition = applicable[0]
	}
	if transition == nil {
		return nil, Rejected(
			"E_NO_TRANSITION",
			"没有从 "+from+" 到 "+to+" 的转换",
			ObjectOf("from", String(from), "to", String(to), "flow", flow),
		)
	}
	by, _ := transition.Get("by").StringValue()
	if by != actorRole {
		return nil, Rejected(
			"E_ROLE_MISMATCH",
			from+" → "+to+" 只能由 "+by+" 触发，实际是 "+actorKey,
			ObjectOf("from", String(from), "to", String(to), "required_role", String(by)),
		)
	}
	if transition.Get("comment_required").Truthy() && strings.TrimSpace(jsToString(intent.Get("comment"))) == "" {
		return nil, Rejected(
			"E_COMMENT_REQUIRED",
			from+" → "+to+" 必须带一条说明性评论",
			ObjectOf("from", String(from), "to", String(to)),
		)
	}
	event := Null()
	if declared := transition.Get("event"); !declared.IsNullish() {
		event = declared
	}
	// 结果里的 flow 是转换自己声明的 flow，不是本意图生效的 flow（JS: transition.flow ?? null）。
	transitionFlow := Null()
	if declared := transition.Get("flow"); !declared.IsNullish() {
		transitionFlow = declared
	}
	return &TransitionResult{
		From:       from,
		To:         to,
		By:         by,
		Flow:       transitionFlow,
		Event:      event,
		Transition: transition,
	}, nil
}

// ValidateIntent 是唯一的写入口：形状→转换→守卫证据（fail-closed）。
func (c *Config) ValidateIntent(intent *Value) (*Value, *Fail) {
	supplied, fail := guardEvidence(intent)
	if fail != nil {
		return nil, fail
	}
	resolved, fail := c.ResolveTransition(intent)
	if fail != nil {
		return nil, fail
	}
	declared := Array()
	if guards := resolved.Transition.Get("guards"); guards.IsArray() {
		declared = guards
	}
	missing := Array()
	missingNames := make([]string, 0, declared.Len())
	for index := 0; index < declared.Len(); index++ {
		name := jsToString(declared.At(index))
		evidence := supplied.Get(name)
		if strings.TrimSpace(jsToString(evidence)) != "" {
			continue
		}
		missing.Append(String(name))
		missingNames = append(missingNames, name)
	}
	if len(missingNames) > 0 {
		return nil, Rejected(
			"E_GUARD_MISSING",
			resolved.From+" → "+resolved.To+" 需要守卫证据："+strings.Join(missingNames, "、"),
			ObjectOf("from", String(resolved.From), "to", String(resolved.To), "guards", missing),
		)
	}
	result := ObjectOf(
		"from", String(resolved.From),
		"to", String(resolved.To),
		"by", String(resolved.By),
		"flow", resolved.Flow,
		"event", resolved.Event,
	)
	if declared.Len() > 0 {
		evidence := Object()
		for index := 0; index < declared.Len(); index++ {
			name := jsToString(declared.At(index))
			evidence.Set(name, supplied.Get(name))
		}
		result.Set("guards", evidence)
	}
	return result, nil
}

// ConsultTransition 是只读咨询入口：不评估守卫，也不产出可落账本的结论。
func (c *Config) ConsultTransition(intent *Value) (*Value, *Fail) {
	resolved, fail := c.ResolveTransition(intent)
	if fail != nil {
		return nil, fail
	}
	return ObjectOf(
		"consult", Bool(true),
		"from", String(resolved.From),
		"to", String(resolved.To),
		"by", String(resolved.By),
		"flow", resolved.Flow,
	), nil
}

// guardEvidence 先判形状：形状不对属「没判过」（INFRA），不是「拒绝」。
func guardEvidence(intent *Value) (*Value, *Fail) {
	supplied := intent.Get("guards")
	if supplied.IsNullish() {
		return Null(), nil
	}
	if !supplied.IsObject() {
		actual := "object"
		if supplied.IsArray() {
			actual = "数组"
		} else {
			actual = typeofName(supplied)
		}
		return nil, Infra(
			"E_GUARD_SHAPE",
			"意图的 guards 必须是对象（{ \"<guard 名>\": \"<证据>\" }），实际是 "+actual,
			nil,
		)
	}
	for index, name := range supplied.Keys() {
		value := supplied.vals[index]
		if !value.IsString() {
			return nil, Infra("E_GUARD_SHAPE", "守卫证据 "+name+" 必须是字符串，实际是 "+typeofName(value), nil)
		}
	}
	return supplied, nil
}

// jsDisplay 复刻模板字符串 ${value} 的字符串化。
func jsDisplay(v *Value) string {
	switch v.Kind() {
	case KindUndefined:
		return "undefined"
	case KindNull:
		return "null"
	case KindBool:
		if v.b {
			return "true"
		}
		return "false"
	case KindNumber:
		if v.num != v.num {
			return "NaN"
		}
		if v.num > 1.7976931348623157e308 {
			return "Infinity"
		}
		if v.num < -1.7976931348623157e308 {
			return "-Infinity"
		}
		return FormatNumber(v.num)
	case KindString:
		return v.str
	case KindArray:
		parts := make([]string, 0, len(v.arr))
		for _, item := range v.arr {
			if item.IsNullish() {
				parts = append(parts, "")
				continue
			}
			parts = append(parts, jsDisplay(item))
		}
		return strings.Join(parts, ",")
	default:
		return "[object Object]"
	}
}

// jsToString 复刻 String(value)（含 null/undefined → ""，这是 `?? ""` 之后的语义）。
func jsToString(v *Value) string {
	if v.IsNullish() {
		return ""
	}
	return jsDisplay(v)
}

func typeofName(v *Value) string {
	switch v.Kind() {
	case KindUndefined:
		return "undefined"
	case KindNull:
		return "object" // JS 的历史遗留：typeof null === "object"
	case KindBool:
		return "boolean"
	case KindNumber:
		return "number"
	case KindString:
		return "string"
	default:
		return "object"
	}
}

// strictEqual 复刻 ===（这里只用于 flow 的 null/字符串比较）。
func strictEqual(left, right *Value) bool {
	if left.Kind() != right.Kind() {
		return false
	}
	switch left.Kind() {
	case KindNull, KindUndefined:
		return true
	case KindBool:
		return left.b == right.b
	case KindNumber:
		return left.num == right.num
	case KindString:
		return left.str == right.str
	case KindArray, KindObject:
		return left == right
	}
	return false
}
