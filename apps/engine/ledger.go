package engine

// 账本：append-only，磁盘上没有状态字段，状态是折叠出来的投影。
// 行为对应 scripts/ledger.mjs；JSON 键序（id,title,body,state,history,updatedAt）是契约。

import (
	"errors"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
)

// DefaultLedgerRel 是账本的默认相对位置。
const DefaultLedgerRel = ".agents/platform/ledger.jsonl"

// LedgerPath 复刻 `resolve(process.env.PLATFORM_LEDGER ?? default)`。
func LedgerPath(root string) string {
	configured := os.Getenv("PLATFORM_LEDGER")
	if configured == "" {
		configured = DefaultLedgerRel
	}
	if filepath.IsAbs(configured) {
		return filepath.Clean(configured)
	}
	return filepath.Join(root, configured)
}

// ReadEvents 逐行读账本；坏行直接报错，绝不在坏账本上继续写。
func ReadEvents(path string) (*Value, error) {
	events := Array()
	raw, err := os.ReadFile(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return events, nil
		}
		return nil, err
	}
	for index, line := range strings.Split(string(raw), "\n") {
		text := strings.TrimSpace(line)
		if text == "" {
			continue
		}
		event, parseErr := ParseJSON([]byte(text))
		if parseErr != nil {
			return nil, errors.New("账本第 " + strconv.Itoa(index+1) + " 行不是合法 JSON，拒绝在坏账本上继续写")
		}
		events.Append(event)
	}
	return events, nil
}

// AppendEvent 追加一条事件（必要时建目录），返回事件本身。
func AppendEvent(path string, event *Value) (*Value, error) {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return nil, err
	}
	handle, err := os.OpenFile(path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
	if err != nil {
		return nil, err
	}
	defer handle.Close()
	if _, err := handle.WriteString(event.EncodeString() + "\n"); err != nil {
		return nil, err
	}
	return event, nil
}

// Fold 把一个 item 的当前状态折叠成它最后一条事件的 to。
func Fold(events *Value) *Value {
	order := make([]string, 0, events.Len())
	items := make(map[string]*Value, events.Len())
	for index := 0; index < events.Len(); index++ {
		event := events.At(index)
		key := mapKey(event.Get("id"))
		previous, seen := items[key]
		item := Object()
		item.Set("id", event.Get("id"))
		item.Set("title", coalesce(event.Get("title"), previousField(previous, "title"), String("(未命名)")))
		item.Set("body", coalesce(event.Get("body"), previousField(previous, "body"), String("")))
		if to, ok := event.Get("to").StringValue(); ok && to == None {
			item.Set("state", Null())
		} else {
			item.Set("state", event.Get("to"))
		}
		history := Array()
		if seen {
			previousHistory := previous.Get("history")
			for historyIndex := 0; historyIndex < previousHistory.Len(); historyIndex++ {
				history.Append(previousHistory.At(historyIndex))
			}
		}
		history.Append(event)
		item.Set("history", history)
		item.Set("updatedAt", event.Get("at"))
		items[key] = item
		if !seen {
			order = append(order, key)
		}
	}
	folded := make([]*Value, 0, len(order))
	for _, key := range order {
		folded = append(folded, items[key])
	}
	// Array.prototype.sort 是稳定的：先按 updatedAt 字符串降序，相等时保留插入顺序。
	sort.SliceStable(folded, func(left, right int) bool {
		return jsDisplay(folded[right].Get("updatedAt")) < jsDisplay(folded[left].Get("updatedAt"))
	})
	result := Array(folded...)
	return result
}

func previousField(previous *Value, key string) *Value {
	if previous == nil {
		return nil
	}
	return previous.Get(key)
}

// coalesce 复刻 `a ?? b ?? c`。
func coalesce(values ...*Value) *Value {
	for _, value := range values {
		if !value.IsNullish() {
			return value
		}
	}
	return Null()
}

// NextID 给出下一个可用需求号。
func NextID(events *Value) string {
	used := make(map[string]bool, events.Len())
	for index := 0; index < events.Len(); index++ {
		used[mapKey(events.At(index).Get("id"))] = true
	}
	number := events.Len() + 1
	for used["s:REQ-"+strconv.Itoa(number)] {
		number++
	}
	return "REQ-" + strconv.Itoa(number)
}

// mapKey 复刻 Map/Set 的键同一性（SameValueZero）：字符串与数字不同键，-0 与 0 同键。
func mapKey(value *Value) string {
	switch value.Kind() {
	case KindUndefined:
		return "undefined"
	case KindNull:
		return "null"
	case KindBool:
		if value.b {
			return "b:true"
		}
		return "b:false"
	case KindNumber:
		if value.num == 0 {
			return "n:0"
		}
		return "n:" + FormatNumber(value.num)
	case KindString:
		return "s:" + value.str
	default:
		return "o:" + value.EncodeString()
	}
}
