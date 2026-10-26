package engine

// JSON 解析器：不用 encoding/json，因为契约要求错误文案与 JSON.stringify/JSON.parse 的
// 键序行为一致，而 encoding/json 既丢键序也不给 V8 的报错措辞。
// 报错文案照抄 V8（Node）的句式，因为 E_INTENT_UNPARSABLE / E_EVENT_UNPARSABLE 会把
// error.message 原样拼进对外输出。

import (
	"fmt"
	"math"
	"strconv"
	"strings"
)

// ParseJSON 解析 JSON 文本，返回保序 Value。
func ParseJSON(text []byte) (*Value, error) {
	parser := &jsonParser{source: text}
	parser.skipSpace()
	value, err := parser.parseValue()
	if err != nil {
		return nil, err
	}
	parser.skipSpace()
	if parser.pos < len(parser.source) {
		return nil, parser.errorAt("Unexpected non-whitespace character after JSON", parser.pos)
	}
	return value, nil
}

type jsonParser struct {
	source []byte
	pos    int
}

func (p *jsonParser) errorAt(headline string, position int) error {
	line := 1
	column := position + 1
	for index := 0; index < position && index < len(p.source); index++ {
		if p.source[index] == '\n' {
			line++
			column = position - index
		}
	}
	return fmt.Errorf("%s at position %d (line %d column %d)", headline, position, line, column)
}

func (p *jsonParser) unexpectedToken(position int) error {
	character := p.source[position]
	return fmt.Errorf("Unexpected token '%c', %s is not valid JSON", rune(character), p.snippet())
}

// snippet 复刻 V8 的源码摘录：短输入整段引用，长输入只留最后 12 个字符并加前导 ...
func (p *jsonParser) snippet() string {
	const tail = 12
	if len(p.source) <= 20 {
		return "\"" + string(p.source) + "\""
	}
	return "...\"" + string(p.source[len(p.source)-tail:]) + "\""
}

func (p *jsonParser) skipSpace() {
	for p.pos < len(p.source) {
		switch p.source[p.pos] {
		case ' ', '\t', '\n', '\r':
			p.pos++
		default:
			return
		}
	}
}

func (p *jsonParser) parseValue() (*Value, error) {
	if p.pos >= len(p.source) {
		return nil, fmt.Errorf("Unexpected end of JSON input")
	}
	switch character := p.source[p.pos]; {
	case character == '{':
		return p.parseObject()
	case character == '[':
		return p.parseArray()
	case character == '"':
		text, err := p.parseString()
		if err != nil {
			return nil, err
		}
		return String(text), nil
	case character == 't':
		return p.parseLiteral("true", Bool(true))
	case character == 'f':
		return p.parseLiteral("false", Bool(false))
	case character == 'n':
		return p.parseLiteral("null", Null())
	case character == 'N':
		if p.hasPrefix("NaN") {
			p.pos += len("NaN")
			return nil, fmt.Errorf("%s is not valid JSON", p.snippet())
		}
		return nil, p.unexpectedToken(p.pos)
	case character == 'I':
		if p.hasPrefix("Infinity") {
			p.pos += len("Infinity")
			return nil, fmt.Errorf("%s is not valid JSON", p.snippet())
		}
		return nil, p.unexpectedToken(p.pos)
	case character == '-' || (character >= '0' && character <= '9'):
		return p.parseNumber()
	default:
		return nil, p.unexpectedToken(p.pos)
	}
}

func (p *jsonParser) hasPrefix(text string) bool {
	return strings.HasPrefix(string(p.source[p.pos:]), text)
}

func (p *jsonParser) parseLiteral(word string, value *Value) (*Value, error) {
	for offset := 0; offset < len(word); offset++ {
		if p.pos+offset >= len(p.source) {
			return nil, fmt.Errorf("Unexpected end of JSON input")
		}
		if p.source[p.pos+offset] != word[offset] {
			return nil, p.unexpectedToken(p.pos + offset)
		}
	}
	p.pos += len(word)
	return value, nil
}

func (p *jsonParser) parseObject() (*Value, error) {
	p.pos++ // '{'
	object := Object()
	p.skipSpace()
	if p.pos >= len(p.source) {
		return nil, p.errorAt("Expected property name or '}' in JSON", p.pos)
	}
	if p.source[p.pos] == '}' {
		p.pos++
		return object, nil
	}
	for {
		if p.pos >= len(p.source) || p.source[p.pos] != '"' {
			return nil, p.errorAt("Expected property name or '}' in JSON", p.pos)
		}
		key, err := p.parseString()
		if err != nil {
			return nil, err
		}
		p.skipSpace()
		if p.pos >= len(p.source) || p.source[p.pos] != ':' {
			return nil, p.errorAt("Expected ':' after property name in JSON", p.pos)
		}
		p.pos++
		p.skipSpace()
		value, err := p.parseValue()
		if err != nil {
			return nil, err
		}
		object.Set(key, value)
		p.skipSpace()
		if p.pos >= len(p.source) {
			return nil, p.errorAt("Expected ',' or '}' after property value in JSON", p.pos)
		}
		switch p.source[p.pos] {
		case ',':
			p.pos++
			p.skipSpace()
			if p.pos >= len(p.source) || p.source[p.pos] != '"' {
				return nil, p.errorAt("Expected double-quoted property name in JSON", p.pos)
			}
		case '}':
			p.pos++
			return object, nil
		default:
			return nil, p.errorAt("Expected ',' or '}' after property value in JSON", p.pos)
		}
	}
}

func (p *jsonParser) parseArray() (*Value, error) {
	p.pos++ // '['
	items := Array()
	p.skipSpace()
	if p.pos >= len(p.source) {
		return nil, fmt.Errorf("Unexpected end of JSON input")
	}
	if p.source[p.pos] == ']' {
		p.pos++
		return items, nil
	}
	for {
		value, err := p.parseValue()
		if err != nil {
			return nil, err
		}
		items.Append(value)
		p.skipSpace()
		if p.pos >= len(p.source) {
			return nil, p.errorAt("Expected ',' or ']' after array element in JSON", p.pos)
		}
		switch p.source[p.pos] {
		case ',':
			p.pos++
			p.skipSpace()
		case ']':
			p.pos++
			return items, nil
		default:
			return nil, p.errorAt("Expected ',' or ']' after array element in JSON", p.pos)
		}
	}
}

func (p *jsonParser) parseString() (string, error) {
	p.pos++ // '"'
	var builder strings.Builder
	for {
		if p.pos >= len(p.source) {
			return "", p.errorAt("Unterminated string in JSON", p.pos)
		}
		character := p.source[p.pos]
		switch {
		case character == '"':
			p.pos++
			return builder.String(), nil
		case character == '\\':
			p.pos++
			if p.pos >= len(p.source) {
				return "", p.errorAt("Unterminated string in JSON", p.pos)
			}
			escape := p.source[p.pos]
			switch escape {
			case '"', '\\', '/':
				builder.WriteByte(escape)
				p.pos++
			case 'b':
				builder.WriteByte(8)
				p.pos++
			case 'f':
				builder.WriteByte(12)
				p.pos++
			case 'n':
				builder.WriteByte(10)
				p.pos++
			case 'r':
				builder.WriteByte(13)
				p.pos++
			case 't':
				builder.WriteByte(9)
				p.pos++
			case 'u':
				unit, err := p.parseHexUnit()
				if err != nil {
					return "", err
				}
				builder.WriteString(string(rune(unit)))
			default:
				return "", p.errorAt("Bad escaped character in JSON", p.pos)
			}
		case character < 0x20:
			return "", p.errorAt("Bad control character in string literal in JSON", p.pos)
		default:
			builder.WriteByte(character)
			p.pos++
		}
	}
}

// parseHexUnit 读 \uXXXX；代理对在这里合并成单个码点。
func (p *jsonParser) parseHexUnit() (uint32, error) {
	p.pos++ // 'u'
	unit, ok := p.readHex4()
	if !ok {
		return 0, p.errorAt("Bad Unicode escape in JSON", p.pos)
	}
	if unit >= 0xD800 && unit <= 0xDBFF && p.pos+1 < len(p.source) && p.source[p.pos] == '\\' && p.source[p.pos+1] == 'u' {
		saved := p.pos
		p.pos += 2
		if low, ok := p.readHex4(); ok && low >= 0xDC00 && low <= 0xDFFF {
			return 0x10000 + ((unit - 0xD800) << 10) + (low - 0xDC00), nil
		}
		p.pos = saved
	}
	return unit, nil
}

func (p *jsonParser) readHex4() (uint32, bool) {
	var value uint32
	for index := 0; index < 4; index++ {
		if p.pos >= len(p.source) {
			return 0, false
		}
		digit, ok := hexValue(p.source[p.pos])
		if !ok {
			return 0, false
		}
		value = value*16 + digit
		p.pos++
	}
	return value, true
}

func hexValue(character byte) (uint32, bool) {
	switch {
	case character >= '0' && character <= '9':
		return uint32(character - '0'), true
	case character >= 'a' && character <= 'f':
		return uint32(character-'a') + 10, true
	case character >= 'A' && character <= 'F':
		return uint32(character-'A') + 10, true
	}
	return 0, false
}

func (p *jsonParser) parseNumber() (*Value, error) {
	start := p.pos
	if p.source[p.pos] == '-' {
		p.pos++
		if p.pos >= len(p.source) || p.source[p.pos] < '0' || p.source[p.pos] > '9' {
			return nil, p.errorAt("No number after minus sign in JSON", p.pos)
		}
	}
	if p.source[p.pos] == '0' {
		p.pos++
		if p.pos < len(p.source) && p.source[p.pos] >= '0' && p.source[p.pos] <= '9' {
			return nil, p.errorAt("Unexpected number in JSON", p.pos)
		}
	} else {
		for p.pos < len(p.source) && p.source[p.pos] >= '0' && p.source[p.pos] <= '9' {
			p.pos++
		}
	}
	if p.pos < len(p.source) && p.source[p.pos] == '.' {
		p.pos++
		if p.pos >= len(p.source) || p.source[p.pos] < '0' || p.source[p.pos] > '9' {
			return nil, p.errorAt("Unterminated fractional number in JSON", p.pos)
		}
		for p.pos < len(p.source) && p.source[p.pos] >= '0' && p.source[p.pos] <= '9' {
			p.pos++
		}
	}
	if p.pos < len(p.source) && (p.source[p.pos] == 'e' || p.source[p.pos] == 'E') {
		p.pos++
		if p.pos < len(p.source) && (p.source[p.pos] == '+' || p.source[p.pos] == '-') {
			p.pos++
		}
		if p.pos >= len(p.source) || p.source[p.pos] < '0' || p.source[p.pos] > '9' {
			return nil, p.errorAt("Exponent part is missing a number in JSON", p.pos)
		}
		for p.pos < len(p.source) && p.source[p.pos] >= '0' && p.source[p.pos] <= '9' {
			p.pos++
		}
	}
	number, err := strconv.ParseFloat(string(p.source[start:p.pos]), 64)
	if err != nil {
		// 溢出：JS 得到 Infinity，JSON.stringify 再输出 null。
		number = math.Inf(1)
		if p.source[start] == '-' {
			number = math.Inf(-1)
		}
	}
	return Number(number), nil
}
