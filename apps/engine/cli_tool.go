package engine

// cli_tool.go —— scripts/cli.mjs 的行为复刻。
//
// 为什么这么薄：状态的唯一真相在账本与 issue label 上，判定器只有一份实现。
// 所以本子命令只做三件事：读参数、发 HTTP、把结果打到 stdout —— 不读账本、不落盘、
// 不判断状态转换；--to 原样交给后端，这里出现转换规则就是第二份真相。
//
// 退出码：0 成功 / 1 后端拒绝 / 2 用法错误 / 3 网络或后端故障 / 4 校验真红（仅 verify）。

import (
	"bytes"
	"errors"
	"io"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
)

const cliDefaultAPI = "http://127.0.0.1:4317"

const (
	cliExitOK           = 0
	cliExitRejected     = 1
	cliExitUsage        = 2
	cliExitInfra        = 3
	cliExitVerifyFailed = 4
)

var cliCommandFlags = map[string]map[string]bool{
	"board":   {},
	"new":     {"body": true},
	"verdict": {"id": true, "to": true, "role": true, "comment": true, "guard": true},
	"verify":  {},
	"outbox":  {},
}

// cliRepeatable 是可重复的选项：同一个 flag 收多次不覆盖，按出现顺序攒成数组。
var cliRepeatable = map[string]bool{"guard": true}

// CliUsage 与 scripts/cli.mjs 的 USAGE 逐字一致：--help 的输出被断言。
// 文案里保留 env 变量名与默认地址是刻意的；载体事实由 apps/engine/README.md 记录。
const CliUsage = "用法: cli <命令> [选项] [--api <url>] [--json]\n" +
	"\n" +
	"命令:\n" +
	"  board [--json]                                   列出条目（id / state / title / 漂移）\n" +
	"  new <title> [--body <text>] [--json]             新建需求，打印新 id 与落到的状态\n" +
	"  verdict --id <id> --to <state> [--role <role>] [--comment <text>]\n" +
	"          [--guard <name>=<evidence>]... [--json]\n" +
	"                                                   发起一次状态变更（--role 缺省 owner；\n" +
	"                                                   --guard 可重复，声明了守卫的转换必须带证据）\n" +
	"  verify [--json]                                  真跑校验，打印 exitCode 与输出尾部（判红则退出 4）\n" +
	"  outbox [--json]                                  列出在途条目（status/attempts/nextCheckAt）\n" +
	"\n" +
	"全局:\n" +
	"  --api <url>   后端地址，默认 \x60$PLATFORM_API\x60 或 " + cliDefaultAPI + "\n" +
	"  --json        机器可读输出（原样打印后端响应）\n" +
	"  --help        打印本用法\n" +
	"\n" +
	"退出码: 0 成功 / 1 后端拒绝（kind=rejected）/ 2 用法错误 / 3 网络或后端故障（kind=infra）\n"

// cliError 复刻 CliError：退出码与消息一起携带，main 才分得清「后端说不」和「命令写错了」。
type cliError struct {
	code    int
	message string
}

func (e *cliError) Error() string { return e.message }

func cliUsageError(message string) error { return &cliError{code: cliExitUsage, message: message} }
func cliInfraError(message string) error { return &cliError{code: cliExitInfra, message: message} }

// cliParsed 是 parseArgv 的产物。
type cliParsed struct {
	command     string
	hasCommand  bool
	help        bool
	json        bool
	api         string
	hasAPI      bool
	flags       map[string]string
	guardValues []string
	hasGuards   bool
	guards      map[string]string
	positionals []string
}

// cliParseArgv 复刻 parseArgv：没登记的选项一律按用法错误处理，不做「猜你要什么」。
func cliParseArgv(argv []string) (*cliParsed, error) {
	tokens := append([]string(nil), argv...)
	parsed := &cliParsed{flags: map[string]string{}}
	index := 0
	takeValue := func(flag string) (string, error) {
		if index >= len(tokens) {
			return "", cliUsageError("选项 " + flag + " 缺少取值")
		}
		value := tokens[index]
		index++
		return value, nil
	}

	for index < len(tokens) {
		token := tokens[index]
		index++
		switch {
		case token == "--help" || token == "-h":
			parsed.help = true
		case token == "--json":
			parsed.json = true
		case token == "--api":
			value, err := takeValue("--api")
			if err != nil {
				return nil, err
			}
			parsed.api = value
			parsed.hasAPI = true
		case strings.HasPrefix(token, "--api="):
			parsed.api = token[len("--api="):]
			parsed.hasAPI = true
		case strings.HasPrefix(token, "--"):
			name := token[2:]
			allowed := cliCommandFlags[parsed.command]
			if !parsed.hasCommand || !allowed[name] {
				if parsed.hasCommand {
					return nil, cliUsageError("命令 " + parsed.command + " 不认识选项 " + token)
				}
				return nil, cliUsageError("不认识全局选项 " + token)
			}
			value, err := takeValue(token)
			if err != nil {
				return nil, err
			}
			if cliRepeatable[name] {
				parsed.guardValues = append(parsed.guardValues, value)
			} else {
				parsed.flags[name] = value
			}
		default:
			if !parsed.hasCommand {
				parsed.command = token
				parsed.hasCommand = true
				continue
			}
			parsed.positionals = append(parsed.positionals, token)
		}
	}

	if parsed.help {
		return parsed, nil
	}
	if !parsed.hasCommand {
		return nil, cliUsageError("缺少命令")
	}
	if _, known := cliCommandFlags[parsed.command]; !known {
		return nil, cliUsageError("未知命令: " + parsed.command)
	}

	// 必填参数只查「给没给」；给了什么（哪怕是空串）都原样交给后端判定器。
	if parsed.command == "verdict" {
		for _, name := range []string{"id", "to"} {
			if _, given := parsed.flags[name]; !given {
				return nil, cliUsageError("命令 verdict 缺少必填选项 --" + name)
			}
		}
	}
	// --guard name=evidence：值是 name= 之后的全部内容（证据里可以再有 =）。
	// 形状不对就是用法错误 —— 在发请求之前拦住，别让后端去猜。
	if parsed.command == "verdict" && len(parsed.guardValues) > 0 {
		guards := map[string]string{}
		for _, entry := range parsed.guardValues {
			at := strings.Index(entry, "=")
			if at == -1 {
				return nil, cliUsageError("--guard 需要 name=evidence 形状: " + entry)
			}
			name := entry[:at]
			if name == "" {
				return nil, cliUsageError("--guard 的 name 不能为空: " + entry)
			}
			guards[name] = entry[at+1:]
		}
		parsed.guards = guards
		parsed.hasGuards = true
	}
	if parsed.command == "new" {
		if len(parsed.positionals) == 0 {
			return nil, cliUsageError("命令 new 缺少必填参数 <title>")
		}
		if len(parsed.positionals) > 1 {
			return nil, cliUsageError("命令 new 只收一个 <title>，多给了 " + strconv.Itoa(len(parsed.positionals)-1) + " 个")
		}
	} else if len(parsed.positionals) > 0 {
		return nil, cliUsageError("命令 " + parsed.command + " 不收位置参数: " + strings.Join(parsed.positionals, " "))
	}
	return parsed, nil
}

// cliOrigin 复刻 api.origin：只取协议+主机+端口。
func cliOrigin(api *url.URL) string {
	return api.Scheme + "://" + api.Host
}

// cliResolveAPI 复刻 resolveApi：--api ?? PLATFORM_API ?? 默认地址。
func cliResolveAPI(raw string, hasRaw bool) (*url.URL, error) {
	value := cliDefaultAPI
	if hasRaw {
		value = raw
	} else if env, ok := os.LookupEnv("PLATFORM_API"); ok {
		value = env
	}
	parsed, err := url.Parse(value)
	// Node 的 new URL() 只收绝对地址：没有 scheme/host 就算非法。
	if err != nil || parsed.Scheme == "" || parsed.Host == "" {
		return nil, cliUsageError("--api 不是合法 URL: " + value)
	}
	if parsed.Scheme != "http" && parsed.Scheme != "https" {
		return nil, cliUsageError("--api 只支持 http/https: " + value)
	}
	return parsed, nil
}

// cliEndpoint 复刻 endpoint：只取 origin，后端路径是固定的 ——
// --api 里带没带路径都不改变我们要打的接口。
func cliEndpoint(api *url.URL, pathname string) *url.URL {
	return &url.URL{Scheme: api.Scheme, Host: api.Host, Path: pathname}
}

// cliSend 复刻 send：body 一律 JSON 化，无 body 时只带 content-length: 0，
// 每次请求一个独立连接（命令结束即断连，进程不留 keep-alive 句柄）。
func cliSend(method string, target *url.URL, body *Value) (int, string, error) {
	var payload []byte
	if body != nil && !body.IsNullish() {
		payload = body.Encode()
	}
	request, requestErr := http.NewRequest(method, target.String(), bytes.NewReader(payload))
	if requestErr != nil {
		return 0, "", requestErr
	}
	request.Header.Set("content-length", strconv.Itoa(len(payload)))
	if payload != nil {
		request.Header.Set("content-type", "application/json")
	}
	client := &http.Client{Transport: &http.Transport{Proxy: nil, DisableKeepAlives: true}}
	response, responseErr := client.Do(request)
	if responseErr != nil {
		// Node 的 error.cause.message 优先，其次 error.message。
		var urlErr *url.Error
		if errors.As(responseErr, &urlErr) && urlErr.Err != nil {
			return 0, "", errors.New(cliNetworkReason(urlErr.Err.Error()))
		}
		return 0, "", errors.New(cliNetworkReason(responseErr.Error()))
	}
	defer response.Body.Close()
	text, readErr := io.ReadAll(response.Body)
	if readErr != nil {
		return 0, "", errors.New(cliNetworkReason(readErr.Error()))
	}
	return response.StatusCode, string(text), nil
}

// cliNetworkReason 复刻 networkReason 的兜底分支：文案随网络栈而变
// （Node 走 undici/uv，Go 走 net），这是登记在 README 里的例外，不追求逐字一致。
func cliNetworkReason(message string) string {
	if jsTrim(message) == "" {
		return "未知网络错误"
	}
	return message
}

// cliBackendError 复刻 backendError：后端错误形状是 {kind, code, message, extra}，
// kind 优先，状态码兜底。
func cliBackendError(status int, payload *Value) error {
	kind := ""
	code := ""
	message := "HTTP " + strconv.Itoa(status)
	if payload != nil && payload.IsObject() {
		if value, ok := payload.Get("kind").StringValue(); ok {
			kind = value
		}
		if value, ok := payload.Get("code").StringValue(); ok {
			code = value
		}
		if value, ok := payload.Get("message").StringValue(); ok {
			message = value
		}
	}
	detail := message
	if code != "" {
		detail = code + ": " + message
	}
	statusText := strconv.Itoa(status)
	switch {
	case kind == "rejected":
		return &cliError{code: cliExitRejected, message: "后端拒绝（HTTP " + statusText + "）: " + detail}
	case kind == "infra":
		return cliInfraError("后端故障（HTTP " + statusText + "）: " + detail)
	case status >= 500:
		return cliInfraError("后端故障（HTTP " + statusText + "）: " + detail)
	case status >= 400:
		return &cliError{code: cliExitRejected, message: "后端拒绝（HTTP " + statusText + "）: " + detail}
	}
	return cliInfraError("后端回应无法理解（HTTP " + statusText + "）: " + detail)
}

// cliRequest 复刻 request。
func cliRequest(api *url.URL, pathname string, method string, body *Value) (*Value, error) {
	status, text, sendErr := cliSend(method, cliEndpoint(api, pathname), body)
	if sendErr != nil {
		return nil, cliInfraError("连不上后端 " + cliOrigin(api) + ": " + sendErr.Error())
	}
	payload, parseErr := ParseJSON([]byte(text))
	if status >= 200 && status < 300 {
		if parseErr != nil || payload.IsNullish() {
			return nil, cliInfraError("后端返回的不是 JSON（HTTP " + strconv.Itoa(status) + "）")
		}
		return payload, nil
	}
	if parseErr != nil {
		payload = nil
	}
	return nil, cliBackendError(status, payload)
}

// cliRenderJSON 复刻 renderJson：两空格缩进 + 结尾换行。
func cliRenderJSON(payload *Value) string {
	return string(payload.EncodeIndent(2)) + "\n"
}

// cliCell 复刻 cell：null/undefined/空串打成 "-"，其余按 String()。
func cliCell(value *Value) string {
	if value == nil || value.IsNullish() {
		return "-"
	}
	switch value.Kind() {
	case KindString:
		if value.str == "" {
			return "-"
		}
		return value.str
	case KindNumber:
		return FormatNumber(value.num)
	case KindBool:
		if value.b {
			return "true"
		}
		return "false"
	case KindArray:
		parts := make([]string, 0, value.Len())
		for index := 0; index < value.Len(); index++ {
			parts = append(parts, cliCell(value.At(index)))
		}
		return strings.Join(parts, ",")
	}
	return "[object Object]"
}

// cliIsWide 复刻 isWide：中文在终端占两列。
func cliIsWide(code rune) bool {
	return (code >= 0x1100 && code <= 0x115f) ||
		(code >= 0x2e80 && code <= 0xa4cf) ||
		(code >= 0xac00 && code <= 0xd7a3) ||
		(code >= 0xf900 && code <= 0xfaff) ||
		(code >= 0xfe30 && code <= 0xfe6f) ||
		(code >= 0xff00 && code <= 0xff60) ||
		(code >= 0xffe0 && code <= 0xffe6) ||
		(code >= 0x1f300 && code <= 0x1f64f) ||
		(code >= 0x1f900 && code <= 0x1f9ff)
}

// cliDisplayWidth 复刻 displayWidth：按显示宽度而不是码点数补空格，表才不会歪。
func cliDisplayWidth(text string) int {
	total := 0
	for _, character := range text {
		if cliIsWide(character) {
			total += 2
			continue
		}
		total++
	}
	return total
}

// cliPad 复刻 pad。
func cliPad(text string, width int) string {
	padding := width - cliDisplayWidth(text)
	if padding < 0 {
		padding = 0
	}
	return text + strings.Repeat(" ", padding)
}

// cliRenderTable 复刻 renderTable：列间两空格，行末 trimEnd，行间换行（结尾不带换行）。
func cliRenderTable(headers []string, rows [][]string) string {
	cells := make([][]string, 0, len(rows))
	for _, row := range rows {
		joined := make([]string, 0, len(row))
		for _, value := range row {
			joined = append(joined, cliCell(String(value)))
		}
		cells = append(cells, joined)
	}
	widths := make([]int, len(headers))
	for index, header := range headers {
		widths[index] = cliDisplayWidth(header)
		for _, row := range cells {
			if index < len(row) && cliDisplayWidth(row[index]) > widths[index] {
				widths[index] = cliDisplayWidth(row[index])
			}
		}
	}
	line := func(values []string) string {
		parts := make([]string, 0, len(values))
		for index, value := range values {
			width := widths[index]
			parts = append(parts, cliPad(value, width))
		}
		return jsTrimEnd(strings.Join(parts, "  "))
	}
	lines := make([]string, 0, len(cells)+2)
	lines = append(lines, line(headers))
	dashes := make([]string, 0, len(widths))
	for _, width := range widths {
		dashes = append(dashes, strings.Repeat("-", width))
	}
	lines = append(lines, line(dashes))
	for _, row := range cells {
		lines = append(lines, line(row))
	}
	return strings.Join(lines, "\n")
}

// jsTrimEnd 复刻 String.prototype.trimEnd（JS 的空白集合，含全角空格）。
func jsTrimEnd(text string) string {
	return strings.TrimRightFunc(text, isJSSpace)
}

// cliContext 是 handler 的入参。
type cliContext struct {
	api         *url.URL
	json        bool
	flags       map[string]string
	guards      map[string]string
	hasGuards   bool
	positionals []string
}

// cliHandler 返回 stdout 文本与可选的自带退出码（hasCode=false 时按成功 0）。
type cliOutcome struct {
	stdout  string
	hasCode bool
	code    int
}

func cliBoard(context *cliContext) (cliOutcome, error) {
	payload, err := cliRequest(context.api, "/api/board", "GET", nil)
	if err != nil {
		return cliOutcome{}, err
	}
	if context.json {
		return cliOutcome{stdout: cliRenderJSON(payload)}, nil
	}
	items := payload.Get("items")
	if items == nil || !items.IsArray() {
		return cliOutcome{}, cliInfraError("board 响应里没有 items 数组")
	}
	if items.Len() == 0 {
		return cliOutcome{stdout: "（没有条目）\n"}, nil
	}
	drifted := false
	for index := 0; index < items.Len(); index++ {
		if flag, ok := items.At(index).Get("divergence").BoolValue(); ok && flag {
			drifted = true
		}
	}
	headers := []string{"ID", "STATE", "TITLE"}
	if drifted {
		headers = append(headers, "漂移")
	}
	rows := make([][]string, 0, items.Len())
	for index := 0; index < items.Len(); index++ {
		item := items.At(index)
		state := "-"
		if item.Get("state").Kind() == KindNull {
			state = "none"
		} else {
			state = cliCell(item.Get("state"))
		}
		title := ""
		if value, ok := item.Get("title").StringValue(); ok {
			title = value
		}
		row := []string{cliCell(item.Get("id")), state, title}
		if drifted {
			mark := ""
			if flag, ok := item.Get("divergence").BoolValue(); ok && flag {
				mark = "远端漂移"
			}
			row = append(row, mark)
		}
		rows = append(rows, row)
	}
	return cliOutcome{stdout: cliRenderTable(headers, rows) + "\n"}, nil
}

func cliCreateItem(context *cliContext) (cliOutcome, error) {
	title := ""
	if len(context.positionals) > 0 {
		title = context.positionals[0]
	}
	body := ""
	if value, ok := context.flags["body"]; ok {
		body = value
	}
	created, err := cliRequest(context.api, "/api/item", "POST", ObjectOf(
		"title", String(title),
		"body", String(body),
	))
	if err != nil {
		return cliOutcome{}, err
	}
	if context.json {
		return cliOutcome{stdout: cliRenderJSON(created)}, nil
	}
	return cliOutcome{stdout: "新需求: " + cliCell(created.Get("id")) + "\n" +
		"落到状态: " + cliCell(created.Get("to")) + "\n"}, nil
}

func cliVerdict(context *cliContext) (cliOutcome, error) {
	// actor_role 的缺省值只在这里出现一次（后端约定 owner），这里不校验取值合法性。
	role := "owner"
	if value, ok := context.flags["role"]; ok {
		role = value
	}
	comment := ""
	if value, ok := context.flags["comment"]; ok {
		comment = value
	}
	payload := ObjectOf(
		"id", String(context.flags["id"]),
		"to", String(context.flags["to"]),
		"actor_role", String(role),
		"comment", String(comment),
	)
	// 一次 --guard 都没给就不带这个字段：请求形状与改动前逐字节一致。
	if context.hasGuards {
		guards := Object()
		for _, name := range sortedKeys(context.guards) {
			guards.Set(name, String(context.guards[name]))
		}
		payload.Set("guards", guards)
	}
	created, err := cliRequest(context.api, "/api/verdict", "POST", payload)
	if err != nil {
		return cliOutcome{}, err
	}
	if context.json {
		return cliOutcome{stdout: cliRenderJSON(created)}, nil
	}
	return cliOutcome{stdout: cliCell(created.Get("id")) + ": " + cliCell(created.Get("from")) +
		" -> " + cliCell(created.Get("to")) + "（by " + cliCell(created.Get("by")) + "）\n"}, nil
}

// sortedKeys 让 guards 的键序稳定（Object 插入序来自 map，先排序再落）。
func sortedKeys(values map[string]string) []string {
	keys := make([]string, 0, len(values))
	for key := range values {
		keys = append(keys, key)
	}
	for left := 0; left < len(keys); left++ {
		for right := left + 1; right < len(keys); right++ {
			if keys[right] < keys[left] {
				keys[left], keys[right] = keys[right], keys[left]
			}
		}
	}
	return keys
}

// cliVerifyCode 复刻 verifyCode：0 绿 / 4 真红 / 3 拿不到可信结果。
func cliVerifyCode(exitCode *Value) int {
	number, ok := exitCode.FloatValue()
	if !ok || number != float64(int(number)) {
		return cliExitInfra
	}
	if number == 0 {
		return cliExitOK
	}
	return cliExitVerifyFailed
}

func cliVerify(context *cliContext) (cliOutcome, error) {
	result, err := cliRequest(context.api, "/api/verify", "POST", nil)
	if err != nil {
		return cliOutcome{}, err
	}
	code := cliVerifyCode(result.Get("exitCode"))
	if context.json {
		return cliOutcome{stdout: cliRenderJSON(result), hasCode: true, code: code}, nil
	}
	exitCode := "null（超时或被杀，不可信）"
	if !result.Get("exitCode").IsNullish() {
		exitCode = cliCell(result.Get("exitCode"))
	}
	output := ""
	if value, ok := result.Get("output").StringValue(); ok {
		output = value
	}
	lines := []string{}
	if output != "" {
		lines = strings.Split(output, "\n")
	}
	if len(lines) > 20 {
		lines = lines[len(lines)-20:]
	}
	header := "exitCode: " + exitCode
	text := header + "\n（输出为空）\n"
	if len(lines) > 0 {
		text = header + "\n--- 输出尾部（最多 20 行，--json 看全文）---\n" + strings.Join(lines, "\n") + "\n"
	}
	return cliOutcome{stdout: text, hasCode: true, code: code}, nil
}

func cliOutbox(context *cliContext) (cliOutcome, error) {
	payload, err := cliRequest(context.api, "/api/outbox", "GET", nil)
	if err != nil {
		return cliOutcome{}, err
	}
	if context.json {
		return cliOutcome{stdout: cliRenderJSON(payload)}, nil
	}
	entries := payload.Get("entries")
	if entries == nil || !entries.IsArray() {
		return cliOutcome{}, cliInfraError("outbox 响应里没有 entries 数组")
	}
	nextCheckAt := "无（在途为空）"
	if !payload.Get("nextCheckAt").IsNullish() {
		nextCheckAt = cliCell(payload.Get("nextCheckAt"))
	}
	if entries.Len() == 0 {
		return cliOutcome{stdout: "（没有在途条目）\n下次巡检: " + nextCheckAt + "\n"}, nil
	}
	rows := make([][]string, 0, entries.Len())
	for index := 0; index < entries.Len(); index++ {
		entry := entries.At(index)
		rows = append(rows, []string{
			cliCell(entry.Get("attemptId")),
			cliCell(entry.Get("item")),
			cliCell(entry.Get("from")),
			cliCell(entry.Get("to")),
			cliCell(entry.Get("status")),
			cliCell(entry.Get("attempts")),
		})
	}
	table := cliRenderTable([]string{"ATTEMPT", "ITEM", "FROM", "TO", "STATUS", "ATTEMPTS"}, rows)
	return cliOutcome{stdout: table + "\n下次巡检: " + nextCheckAt + "\n"}, nil
}

// cliFail 复刻 main 的 catch 分支：用法错误附上 USAGE，其它只留一行原因。
func cliFail(err error, stderr io.Writer) int {
	var typed *cliError
	if errors.As(err, &typed) {
		io.WriteString(stderr, "cli: "+typed.message+"\n")
		if typed.code == cliExitUsage {
			io.WriteString(stderr, "\n"+CliUsage)
		}
		return typed.code
	}
	// 兜底不打印原始堆栈：堆栈会把退出码约定淹掉，调用方只需要一行原因。
	message := "unknown error"
	if err != nil {
		message = err.Error()
	}
	io.WriteString(stderr, "cli: 内部错误: "+message+"\n")
	return cliExitInfra
}

// RunCli 复刻 cli.mjs 的 main。用法文案与 JS 逐字一致。
func RunCli(argv []string, stdout, stderr io.Writer, root string) int {
	parsed, parseErr := cliParseArgv(argv)
	if parseErr != nil {
		return cliFail(parseErr, stderr)
	}
	if parsed.help {
		io.WriteString(stdout, CliUsage)
		return cliExitOK
	}
	api, apiErr := cliResolveAPI(parsed.api, parsed.hasAPI)
	if apiErr != nil {
		return cliFail(apiErr, stderr)
	}
	context := &cliContext{
		api:         api,
		json:        parsed.json,
		flags:       parsed.flags,
		guards:      parsed.guards,
		hasGuards:   parsed.hasGuards,
		positionals: parsed.positionals,
	}
	handlers := map[string]func(*cliContext) (cliOutcome, error){
		"board":   cliBoard,
		"new":     cliCreateItem,
		"verdict": cliVerdict,
		"verify":  cliVerify,
		"outbox":  cliOutbox,
	}
	handler, known := handlers[parsed.command]
	if !known {
		return cliFail(cliUsageError("未知命令: "+parsed.command), stderr)
	}
	outcome, runErr := handler(context)
	if runErr != nil {
		return cliFail(runErr, stderr)
	}
	if outcome.stdout != "" {
		io.WriteString(stdout, outcome.stdout)
	}
	if outcome.hasCode {
		return outcome.code
	}
	return cliExitOK
}
