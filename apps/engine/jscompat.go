package engine

// 这些小工具复刻 JS 侧那些「看着像语法糖、其实是判据」的语义：
// Number() 的字符串转换、JSON.stringify 的文本形式、Node 的 fs 报错文案。
// 在逐字节契约里它们不是细节，是输出的一部分。

import (
	"errors"
	"fmt"
	"io/fs"
	"math"
	"os"
	"regexp"
	"strconv"
	"strings"
)

// jsSpaceClass 是 JS 的 \s：Go 的 unicode.IsSpace 少了 \uFEFF、多了别的码点，不能直接借。
const jsSpaceClass = "[\t\n\x0b\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]"

var (
	jsTrailingSpaceRun = regexp.MustCompile(jsSpaceClass + "+$")
	jsNewlineRun       = regexp.MustCompile(jsSpaceClass + "*\r?\n" + jsSpaceClass + "*")
	jsSectionBreak     = regexp.MustCompile("\n## ")
)

func isJSSpace(character rune) bool {
	switch character {
	case '\t', '\n', '\x0b', '\f', '\r', ' ', 0x00a0, 0x1680, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff:
		return true
	}
	return character >= 0x2000 && character <= 0x200a
}

// jsTrim 复刻 String.prototype.trim。
func jsTrim(text string) string { return strings.TrimFunc(text, isJSSpace) }

// jsJSON 复刻 JSON.stringify(value) 的文本形式；undefined 在模板里显示成 "undefined"。
func jsJSON(v *Value) string {
	if v.Kind() == KindUndefined {
		return "undefined"
	}
	return v.EncodeString()
}

// jsNumber 复刻 Number(value)。
func jsNumber(v *Value) float64 {
	switch v.Kind() {
	case KindNull:
		return 0
	case KindBool:
		if v.b {
			return 1
		}
		return 0
	case KindNumber:
		return v.num
	case KindString:
		return jsParseNumber(v.str)
	case KindArray:
		// Number([]) === 0；单元素数组按 String(元素) 再转数字；其余 NaN。
		switch v.Len() {
		case 0:
			return 0
		case 1:
			return jsParseNumber(jsDisplay(v.At(0)))
		}
		return math.NaN()
	}
	return math.NaN()
}

// jsParseNumber 复刻 Number(string)：空串是 0，只认 JS 认的十进制与 0x 十六进制。
func jsParseNumber(text string) float64 {
	trimmed := jsTrim(text)
	if trimmed == "" {
		return 0
	}
	if len(trimmed) > 2 && (strings.HasPrefix(trimmed, "0x") || strings.HasPrefix(trimmed, "0X")) {
		if value, err := strconv.ParseUint(trimmed[2:], 16, 64); err == nil {
			return float64(value)
		}
		return math.NaN()
	}
	switch trimmed {
	case "Infinity", "+Infinity":
		return math.Inf(1)
	case "-Infinity":
		return math.Inf(-1)
	}
	value, err := strconv.ParseFloat(trimmed, 64)
	if err != nil {
		// 只有溢出还留着 Infinity；其余（"", "abc", "0x1p2", "NaN", "Inf"）JS 都给 NaN。
		if math.IsInf(value, 0) {
			return value
		}
		return math.NaN()
	}
	if math.IsNaN(value) || math.IsInf(value, 0) {
		return math.NaN()
	}
	return value
}

func isStringValue(v *Value, expected string) bool { return v.IsString() && v.str == expected }

// nodeOpenError 复刻 Node 的 fs 报错文案：ENOENT: no such file or directory, open '<path>'。
// 前半段的 errno 名与 libc 短语都取自同一套 errno，所以不必自己编一张表。
func nodeOpenError(path string, err error) string {
	code := "UNKNOWN"
	switch {
	case errors.Is(err, fs.ErrNotExist):
		code = "ENOENT"
	case errors.Is(err, fs.ErrPermission):
		code = "EACCES"
	case errors.Is(err, fs.ErrExist):
		code = "EEXIST"
	}
	reason := err.Error()
	var pathErr *fs.PathError
	if errors.As(err, &pathErr) {
		reason = pathErr.Err.Error()
	}
	return code + ": " + reason + ", open '" + path + "'"
}

// appendOutputLine 复刻 appendFileSync：$GITHUB_OUTPUT 不存在就是「本地直跑」，什么也不做。
func appendOutputLine(path, line string) error {
	if path == "" {
		return nil
	}
	file, err := os.OpenFile(path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o666)
	if err != nil {
		return fmt.Errorf("%s", nodeOpenError(path, err))
	}
	_, writeErr := file.WriteString(line)
	closeErr := file.Close()
	if writeErr != nil {
		return writeErr
	}
	return closeErr
}

// envOr 复刻 process.env.X ?? fallback：设成空串也算设了（与 ?? 一致，与 || 不同）。
func envOr(name, fallback string) string {
	if value, ok := os.LookupEnv(name); ok {
		return value
	}
	return fallback
}
