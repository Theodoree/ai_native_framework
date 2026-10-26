package engine

// 这个包里的 `Value` 是「JSON/YAML 的保序值」：键的顺序就是文档顺序。
// 为什么不用 map[string]any：契约是逐字节一致，而 JSON.stringify 按插入顺序输出键，
// map 的随机顺序会在 `ledger fold` / `ledger config` / 判定器 extra 上直接破坏契约。

import (
	"bytes"
	"math"
	"strconv"
	"strings"
)

// Kind 是值的种类。KindUndefined 对应 JS 的 undefined：
// 对象里值为 undefined 的键在 stringify 时会被整键丢掉，数组里则变成 null。
type Kind uint8

const (
	KindUndefined Kind = iota
	KindNull
	KindBool
	KindNumber
	KindString
	KindArray
	KindObject
)

// Value 是一个 JSON 值；对象保留键的插入顺序。
type Value struct {
	kind Kind
	b    bool
	num  float64
	str  string
	arr  []*Value
	keys []string
	vals []*Value
}

func Undefined() *Value           { return &Value{kind: KindUndefined} }
func Null() *Value                { return &Value{kind: KindNull} }
func Bool(value bool) *Value      { return &Value{kind: KindBool, b: value} }
func Number(value float64) *Value { return &Value{kind: KindNumber, num: value} }
func String(value string) *Value  { return &Value{kind: KindString, str: value} }
func Array(values ...*Value) *Value {
	return &Value{kind: KindArray, arr: values}
}

func Object() *Value { return &Value{kind: KindObject} }

// ObjectOf 按给定顺序建对象，省掉一串 Set。
func ObjectOf(pairs ...any) *Value {
	object := Object()
	for index := 0; index+1 < len(pairs); index += 2 {
		object.Set(pairs[index].(string), pairs[index+1].(*Value))
	}
	return object
}

func (v *Value) Kind() Kind {
	if v == nil {
		return KindUndefined
	}
	return v.kind
}

func (v *Value) IsObject() bool  { return v.Kind() == KindObject }
func (v *Value) IsArray() bool   { return v.Kind() == KindArray }
func (v *Value) IsString() bool  { return v.Kind() == KindString }
func (v *Value) IsNullish() bool { return v.Kind() == KindNull || v.Kind() == KindUndefined }

// Get 取对象字段；不是对象或没有这个键都返回 nil（等价于 JS 的 undefined）。
func (v *Value) Get(key string) *Value {
	if !v.IsObject() {
		return nil
	}
	for index, name := range v.keys {
		if name == key {
			return v.vals[index]
		}
	}
	return nil
}

// Has 对应 JS 的 `key in object`（只看自有键；原型链上的名字没有对应语义）。
func (v *Value) Has(key string) bool { return v.IsObject() && v.Get(key) != nil }

// Set 覆盖已有键（位置不变，与 JSON.parse 对重复键的处理一致），否则追加到末尾。
func (v *Value) Set(key string, value *Value) {
	for index, name := range v.keys {
		if name == key {
			v.vals[index] = value
			return
		}
	}
	v.keys = append(v.keys, key)
	v.vals = append(v.vals, value)
}

func (v *Value) Delete(key string) {
	for index, name := range v.keys {
		if name == key {
			v.keys = append(v.keys[:index], v.keys[index+1:]...)
			v.vals = append(v.vals[:index], v.vals[index+1:]...)
			return
		}
	}
}

func (v *Value) Keys() []string {
	if !v.IsObject() {
		return nil
	}
	return v.keys
}

func (v *Value) EntryCount() int { return len(v.keys) }

func (v *Value) Len() int {
	if v.Kind() != KindArray {
		return 0
	}
	return len(v.arr)
}

func (v *Value) At(index int) *Value {
	if v.Kind() != KindArray || index < 0 || index >= len(v.arr) {
		return nil
	}
	return v.arr[index]
}

func (v *Value) Append(values ...*Value) {
	if v.Kind() == KindArray {
		v.arr = append(v.arr, values...)
	}
}

func (v *Value) BoolValue() (bool, bool) {
	if v.Kind() != KindBool {
		return false, false
	}
	return v.b, true
}

func (v *Value) StringValue() (string, bool) {
	if v.Kind() != KindString {
		return "", false
	}
	return v.str, true
}

func (v *Value) FloatValue() (float64, bool) {
	if v.Kind() != KindNumber {
		return 0, false
	}
	return v.num, true
}

// Truthy 是 JS 的真值规则：null/undefined/false/0/NaN/"" 为假，其余为真（含空数组与空对象）。
func (v *Value) Truthy() bool {
	switch v.Kind() {
	case KindUndefined, KindNull:
		return false
	case KindBool:
		return v.b
	case KindNumber:
		return v.num != 0 && !math.IsNaN(v.num)
	case KindString:
		return v.str != ""
	default:
		return true
	}
}

// Interface 转成 encoding/json 能认的 Go 值（给 api-go 的 extra 用）。
func (v *Value) Interface() any {
	switch v.Kind() {
	case KindNull, KindUndefined:
		return nil
	case KindBool:
		return v.b
	case KindNumber:
		return v.num
	case KindString:
		return v.str
	case KindArray:
		items := make([]any, 0, len(v.arr))
		for _, item := range v.arr {
			items = append(items, item.Interface())
		}
		return items
	case KindObject:
		object := make(map[string]any, len(v.keys))
		for index, key := range v.keys {
			object[key] = v.vals[index].Interface()
		}
		return object
	}
	return nil
}

// Encode 生成与 JSON.stringify 一致的紧凑 JSON。
func (v *Value) Encode() []byte {
	var buffer bytes.Buffer
	writeValue(&buffer, v)
	return buffer.Bytes()
}

func (v *Value) EncodeString() string { return string(v.Encode()) }

func writeValue(buffer *bytes.Buffer, v *Value) {
	switch v.Kind() {
	case KindNull, KindUndefined:
		buffer.WriteString("null")
	case KindBool:
		if v.b {
			buffer.WriteString("true")
		} else {
			buffer.WriteString("false")
		}
	case KindNumber:
		buffer.WriteString(FormatNumber(v.num))
	case KindString:
		writeString(buffer, v.str)
	case KindArray:
		buffer.WriteByte('[')
		for index, item := range v.arr {
			if index > 0 {
				buffer.WriteByte(',')
			}
			writeValue(buffer, item)
		}
		buffer.WriteByte(']')
	case KindObject:
		buffer.WriteByte('{')
		wrote := false
		for index, key := range v.keys {
			value := v.vals[index]
			if value.Kind() == KindUndefined {
				continue
			}
			if wrote {
				buffer.WriteByte(',')
			}
			wrote = true
			writeString(buffer, key)
			buffer.WriteByte(':')
			writeValue(buffer, value)
		}
		buffer.WriteByte('}')
	}
}

// writeString 复刻 JSON.stringify 的转义：只有 " \ 与控制字符被转义，
// 非 ASCII（含中文）原样输出；\b \f 用短形式（encoding/json 会写成 \u0008，那是另一个字节序列）。
func writeString(buffer *bytes.Buffer, text string) {
	buffer.WriteByte('"')
	for index := 0; index < len(text); index++ {
		character := text[index]
		switch character {
		case '"':
			buffer.WriteString("\\\"")
		case '\\':
			buffer.WriteString("\\\\")
		case 8:
			buffer.WriteString("\\b")
		case 9:
			buffer.WriteString("\\t")
		case 10:
			buffer.WriteString("\\n")
		case 12:
			buffer.WriteString("\\f")
		case 13:
			buffer.WriteString("\\r")
		default:
			if character < 0x20 {
				buffer.WriteString("\\u")
				buffer.WriteString(strconv.FormatInt(int64(character)+0x10000, 16)[1:])
			} else {
				buffer.WriteByte(character)
			}
		}
	}
	buffer.WriteByte('"')
}

// FormatNumber 复刻 Number.prototype.toString 的十进制表示（JSON.stringify 用它）：
// 整数不带小数点，>=1e21 与 <1e-6 走指数形式，其余走定点。
func FormatNumber(value float64) string {
	if math.IsNaN(value) || math.IsInf(value, 0) {
		return "null"
	}
	if value == 0 {
		return "0"
	}
	sign := ""
	if value < 0 {
		sign = "-"
		value = -value
	}
	// 最短往返位数：'e' 形式给出 d[.ddd]e±XX。
	exponentForm := strconv.FormatFloat(value, 'e', -1, 64)
	mantissa, exponentText, _ := strings.Cut(exponentForm, "e")
	exponent, err := strconv.Atoi(exponentText)
	if err != nil {
		return sign + exponentForm
	}
	digits := strings.Replace(mantissa, ".", "", 1)
	length := len(digits)
	point := exponent + 1 // value = 0.<digits> × 10^point
	switch {
	case point >= 1 && point <= 21 && length <= point:
		return sign + digits + strings.Repeat("0", point-length)
	case point >= 1 && point <= 21:
		return sign + digits[:point] + "." + digits[point:]
	case point > -6 && point <= 0:
		return sign + "0." + strings.Repeat("0", -point) + digits
	default:
		mantissaText := digits[:1]
		if length > 1 {
			mantissaText += "." + digits[1:]
		}
		shift := point - 1
		suffix := "e+" + strconv.Itoa(shift)
		if shift < 0 {
			suffix = "e-" + strconv.Itoa(-shift)
		}
		return sign + mantissaText + suffix
	}
}
