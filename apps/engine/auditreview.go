package engine

// audit-review.mjs 的 Go 侧复刻：审计的执行器（GitHub 侧）——一个槽 -> 一次模型调用 -> 一份 findings JSON。
//
// verdict 由 severity 机械推出，模型只报缺陷；判不了就写 INFRA，绝不写 pass。

import (
	"bytes"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode/utf16"
)

const (
	// ReviewExecutor 是这条路径的执行器身份。
	ReviewExecutor = "github"
	// ReviewDefaultAPIBase 是默认上游。
	ReviewDefaultAPIBase = "https://api.deepseek.com"
	// ReviewMaxDiffChars 是送进模型的 diff 上限。
	ReviewMaxDiffChars = 120000
	// ReviewDefaultTimeoutMs 是上游调用超时。
	ReviewDefaultTimeoutMs = 180000

	reviewUsageText = "用法: node scripts/audit-review.mjs --slot review-a|review-b --diff <diff 文件> --out <输出 json> [--api-base <url>]"
)

// ReviewSlots 是允许的槽名。
var ReviewSlots = []string{"review-a", "review-b"}

// ReviewTruncatedNote 是截断说明。
var ReviewTruncatedNote = "（diff 超过 " + strconv.Itoa(ReviewMaxDiffChars) +
	" 字符，只送了前 " + strconv.Itoa(ReviewMaxDiffChars) + " 字符：已截断）"

const reviewSystemPrompt = "你是代码审计器：只审查给出的 git diff，不猜 diff 以外的文件。\n" +
	"只输出一个 JSON 对象：{\"findings\":[{\"path\",\"line\",\"severity\",\"criterion\",\"suggestion\"}]}，不要输出任何解释文字。\n" +
	"path 用 diff 里的仓库相对路径（去掉 a/ b/ 前缀）；line 用变更后（+ 侧）的行号，必须是 ≥1 的整数。\n" +
	"severity 只能是 blocker / high / medium / low。\n" +
	"criterion 写违反了哪条判据，suggestion 写怎么改；两者都不能为空。\n" +
	"没有缺陷就输出 {\"findings\":[]}。"

// reviewAPIBasePattern 与 JS 的 ^https?://[^/\s]+ 同一判定，空白类按 JS 的定义展开。
var reviewAPIBasePattern = regexp.MustCompile("^https?://[^/" +
	"\u0009\u000a\u000b\u000c\u000d\u0020\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff" +
	"]+")

type reviewOptions struct {
	slot    string
	diff    string
	out     string
	apiBase string
}

func reviewIsText(value string) bool { return jsTrim(value) != "" }

// reviewDescribe 复刻 describe(error)：Error -> message，undefined -> 未知错误。
func reviewDescribe(err error) string {
	if err == nil {
		return "未知错误"
	}
	return err.Error()
}

// ReviewRedact 把密钥换成占位词：诊断出口只有一处，脱敏也只做一处。
func ReviewRedact(text, secret string) string {
	if !reviewIsText(secret) {
		return text
	}
	return strings.ReplaceAll(text, secret, "[REDACTED]")
}

func reviewParseArgs(argv []string, root string) (*reviewOptions, string) {
	values := map[string]string{}
	seen := map[string]bool{}
	for index := 0; index < len(argv); index++ {
		token := argv[index]
		key := ""
		switch token {
		case "--slot":
			key = "slot"
		case "--diff":
			key = "diff"
		case "--out":
			key = "out"
		case "--api-base":
			key = "apiBase"
		default:
			return nil, "认不出的参数 " + jsJSON(String(token))
		}
		if index+1 >= len(argv) {
			return nil, token + " 缺少取值"
		}
		value := argv[index+1]
		if strings.HasPrefix(value, "--") {
			return nil, token + " 缺少取值"
		}
		if seen[token] {
			return nil, token + " 重复给出"
		}
		seen[token] = true
		values[key] = value
		index++
	}
	opts := &reviewOptions{apiBase: ReviewDefaultAPIBase}
	if text, ok := values["apiBase"]; ok {
		opts.apiBase = text
	}
	slot, hasSlot := values["slot"]
	if !hasSlot {
		return nil, "--slot 必填（" + strings.Join(ReviewSlots, "|") + "）"
	}
	validSlot := false
	for _, candidate := range ReviewSlots {
		if candidate == slot {
			validSlot = true
		}
	}
	if !validSlot {
		return nil, "--slot 只接受 " + strings.Join(ReviewSlots, "|") + "，收到 " + jsJSON(String(slot))
	}
	opts.slot = slot
	outValue, hasOut := values["out"]
	if !hasOut {
		return nil, "--out 必填（该槽的 findings JSON 文件）"
	}
	// 目录不存在就报错，不替调用方创建：--out 指错路径时，悄悄造一份记录比失败更坏。
	outPath := outValue
	if !filepath.IsAbs(outPath) {
		outPath = filepath.Join(root, outValue)
	}
	outDir := filepath.Dir(outPath)
	if info, err := os.Stat(outDir); err != nil || !info.IsDir() {
		return nil, "--out 的目录不存在：" + outDir + "（本脚本不创建目录）"
	}
	opts.out = outPath
	diffValue, hasDiff := values["diff"]
	if !hasDiff {
		return nil, "--diff 必填（调用方生成的 git diff 文本）"
	}
	diffPath := diffValue
	if !filepath.IsAbs(diffPath) {
		diffPath = filepath.Join(root, diffValue)
	}
	if _, err := os.Stat(diffPath); err != nil {
		return nil, "--diff 文件不存在：" + diffValue
	}
	if info, err := os.Stat(diffPath); err != nil || info.IsDir() {
		return nil, "--diff 不是文件：" + diffValue
	}
	raw, readErr := os.ReadFile(diffPath)
	if readErr != nil {
		return nil, "--diff 读不出来：" + auditErrnoCode(readErr)
	}
	opts.diff = string(raw)
	if !reviewAPIBasePattern.MatchString(opts.apiBase) {
		return nil, "--api-base 必须是 http(s) URL，收到 " + jsJSON(String(opts.apiBase))
	}
	opts.apiBase = strings.TrimRight(opts.apiBase, "/")
	return opts, ""
}

// reviewFence 是围栏标记（三反引号），用转义写法避免源码里出现裸反引号。
const reviewFence = "\x60\x60\x60"

// ReviewBuildPrompt 把 diff 送成两条消息：超上限就截断并在 prompt 里说明。
func ReviewBuildPrompt(diffText string) *Value {
	truncated := len(utf16Units(diffText)) > ReviewMaxDiffChars
	body := diffText
	if truncated {
		body = utf16Slice(diffText, ReviewMaxDiffChars)
	}
	userContent := reviewFence + "diff\n" + body + "\n" + reviewFence
	if truncated {
		userContent = ReviewTruncatedNote + "\n\n" + userContent
	}
	messages := Array()
	messages.Append(ObjectOf("role", String("system"), "content", String(reviewSystemPrompt)))
	messages.Append(ObjectOf("role", String("user"), "content", String(userContent)))
	return messages
}

// ReviewVerdictFor 是 verdict 的唯一来源：有 blocker -> reject，有其它缺陷 -> needs_revision，没有 -> pass。
func ReviewVerdictFor(findings *Value) string {
	if findings == nil || !findings.IsArray() || findings.Len() == 0 {
		return "pass"
	}
	for i := 0; i < findings.Len(); i++ {
		finding := findings.At(i)
		if finding == nil || !finding.IsObject() {
			continue
		}
		if severity, ok := finding.Get("severity").StringValue(); ok && severity == "blocker" {
			return "reject"
		}
	}
	return "needs_revision"
}

func reviewStripFence(text string) string {
	trimmed := jsTrim(text)
	if !strings.HasPrefix(trimmed, reviewFence) {
		return trimmed
	}
	firstBreak := strings.Index(trimmed, "\n")
	if firstBreak == -1 {
		return trimmed
	}
	rest := trimmed[firstBreak+1:]
	end := strings.LastIndex(rest, reviewFence)
	if end == -1 {
		return jsTrim(rest)
	}
	return jsTrim(rest[:end])
}

// ReviewParseModelJson 剥掉传输围栏后解析：剥完还不是 JSON 就按「输出不合契约」判 INFRA。
func ReviewParseModelJson(content string) (*Value, string) {
	text := reviewStripFence(content)
	if text == "" {
		return nil, "模型回复是空的"
	}
	value, err := ParseJSON([]byte(text))
	if err != nil {
		return nil, "模型回复不是合法 JSON：" + err.Error()
	}
	return value, ""
}

type reviewCallResult struct {
	ok        bool
	content   string
	requestID string
	reason    string
}

// ReviewRequestChat 是网络层唯一出口：POST <apiBase>/chat/completions。
func ReviewRequestChat(apiBase, apiKey, model string, messages *Value) reviewCallResult {
	url := strings.TrimRight(apiBase, "/") + "/chat/completions"
	body := Object()
	body.Set("model", String(model))
	body.Set("messages", messages)
	body.Set("stream", Bool(false))
	body.Set("temperature", Number(0))
	request, err := http.NewRequest("POST", url, bytes.NewReader(body.Encode()))
	if err != nil {
		return reviewCallResult{reason: "调用上游失败（没拿到响应）：" + fmtErrorText(err)}
	}
	request.Header.Set("content-type", "application/json")
	request.Header.Set("authorization", "Bearer "+apiKey)
	client := &http.Client{Timeout: time.Duration(ReviewDefaultTimeoutMs) * time.Millisecond}
	response, err := client.Do(request)
	if err != nil {
		return reviewCallResult{reason: "调用上游失败（没拿到响应）：" + fmtErrorText(err)}
	}
	defer response.Body.Close()
	raw, readErr := io.ReadAll(response.Body)
	text := string(raw)
	if readErr != nil {
		text = ""
	}
	if response.StatusCode != 200 {
		return reviewCallResult{reason: "上游 HTTP " + strconv.Itoa(response.StatusCode) + "：" + collectClip(text, 200)}
	}
	payload, parseErr := ParseJSON([]byte(text))
	if parseErr != nil {
		return reviewCallResult{reason: "上游响应体不是 JSON：" + collectClip(text, 200)}
	}
	var content *Value
	requestID := ""
	if payload != nil && payload.IsObject() {
		choices := payload.Get("choices")
		if choices != nil && choices.IsArray() && choices.Len() > 0 {
			first := choices.At(0)
			if first != nil && first.IsObject() {
				message := first.Get("message")
				if message != nil && message.IsObject() {
					content = message.Get("content")
				}
			}
		}
		if id, ok := payload.Get("id").StringValue(); ok {
			requestID = id
		}
	}
	contentText, contentOK := "", false
	if content != nil {
		contentText, contentOK = content.StringValue()
	}
	if !contentOK {
		return reviewCallResult{reason: "上游响应里没有 choices[0].message.content"}
	}
	return reviewCallResult{ok: true, content: contentText, requestID: requestID}
}

func fmtErrorText(err error) string {
	if err == nil {
		return "未知错误"
	}
	return err.Error()
}

func reviewEvidenceFor(slot, model, requestID string) *Value {
	evidence := Object()
	evidence.Set("executor", String(ReviewExecutor))
	evidence.Set("agent", String(slot))
	if reviewIsText(model) {
		evidence.Set("model", String(model))
	}
	if reviewIsText(requestID) {
		evidence.Set("request_id", String(requestID))
	}
	return evidence
}

func reviewInfra(slot, model, requestID, reason string, findings *Value) *Value {
	record := Object()
	record.Set("verdict", String("INFRA"))
	if findings != nil && findings.IsArray() {
		record.Set("findings", findings)
	} else {
		record.Set("findings", Array())
	}
	record.Set("evidence", reviewEvidenceFor(slot, model, requestID))
	record.Set("reason", String(reason))
	return record
}

// RunAuditReview 是 audit-review 子命令。退出码：0 写出可用记录 / 2 用法错 / 3 判不了。
func RunAuditReview(argv []string, stdout, stderr io.Writer, root string) (code int) {
	code = ExitUnknown
	defer func() {
		if recovered := recover(); recovered != nil {
			fmt.Fprintln(stderr, "audit-review 崩溃: "+fmt.Sprint(recovered))
			code = ExitUnknown
		}
	}()
	logLine := func(line string) { fmt.Fprintln(stdout, line) }
	warn := func(line string) { fmt.Fprintln(stderr, line) }

	// Node 的 process.cwd() 是物理路径（uv_cwd 走 getcwd），Go 的 os.Getwd 会优先回 $PWD。
	// 先按物理路径归一，--out 打印出来的路径才与 JS 逐字节一致。
	if resolved, err := filepath.EvalSymlinks(root); err == nil {
		root = resolved
	}
	opts, argError := reviewParseArgs(argv, root)
	if argError != "" {
		warn("audit-review " + argError)
		warn(reviewUsageText)
		return ExitUsage
	}
	apiKey := ""
	if raw, ok := os.LookupEnv("DEEPSEEK_API_KEY"); ok {
		apiKey = jsTrim(raw)
	}

	finish := func(record *Value) int {
		if err := os.WriteFile(opts.out, append(record.EncodeIndent(2), '\n'), 0o644); err != nil {
			warn("audit-review 写不出 " + opts.out + "：" + reviewDescribe(err))
			return ExitUnknown
		}
		verdict, _ := record.Get("verdict").StringValue()
		codeValue := ExitPass
		if verdict == "INFRA" {
			codeValue = ExitUnknown
		}
		findings := record.Get("findings")
		count := 0
		if findings != nil && findings.IsArray() {
			count = findings.Len()
		}
		logLine("audit-review slot=" + opts.slot + " verdict=" + verdict +
			" findings=" + strconv.Itoa(count) + " exit=" + strconv.Itoa(codeValue) +
			" out=" + opts.out)
		if reason, ok := record.Get("reason").StringValue(); ok && reason != "" {
			warn("audit-review " + ReviewRedact(reason, apiKey))
		}
		return codeValue
	}

	// 模型名的真源。读不到就不许猜一个模型去调 —— 那会把「配置坏了」变成一次假运行。
	cfg, routingErr := LoadRouting(DefaultRoutingPath, root)
	if routingErr != nil {
		return finish(reviewInfra(opts.slot, "", "", "取不到模型真源（"+DefaultRoutingPath+"）："+routingErr.Error(), nil))
	}
	_, model, routeErr := ResolveRouting(opts.slot, cfg)
	if routeErr != nil {
		return finish(reviewInfra(opts.slot, "", "", "取不到模型真源（"+DefaultRoutingPath+"）："+routeErr.Error(), nil))
	}

	if apiKey == "" {
		return finish(reviewInfra(opts.slot, model, "", "没有 DEEPSEEK_API_KEY：判不了，不是通过", nil))
	}

	call := ReviewRequestChat(opts.apiBase, apiKey, model, ReviewBuildPrompt(opts.diff))
	if !call.ok {
		return finish(reviewInfra(opts.slot, model, "", ReviewRedact(call.reason, apiKey), nil))
	}
	// request_id 是「真跑过」的凭据：拿不到就不编，直接按判不了处理。
	if !reviewIsText(call.requestID) {
		return finish(reviewInfra(opts.slot, model, "", "上游没有回 request_id：没有它就无法追溯，不拿占位符凑数", nil))
	}
	parsedJSON, parseErr := ReviewParseModelJson(call.content)
	if parseErr != "" {
		return finish(reviewInfra(opts.slot, model, call.requestID, parseErr, nil))
	}
	findings := parsedJSON.Get("findings")
	if findings == nil || !findings.IsArray() {
		return finish(reviewInfra(opts.slot, model, call.requestID, "模型输出的 JSON 里没有 findings 数组", nil))
	}
	record := Object()
	record.Set("verdict", String(ReviewVerdictFor(findings)))
	record.Set("findings", findings)
	record.Set("evidence", reviewEvidenceFor(opts.slot, model, call.requestID))
	// 判据只问口径层要，不在这里抄第二份。
	if ok, errors := ValidateAuditResult(record); !ok {
		return finish(reviewInfra(opts.slot, model, call.requestID, "模型输出不合 schema："+strings.Join(errors, "；"), nil))
	}
	return finish(record)
}

func utf16Units(text string) []uint16 { return utf16.Encode([]rune(text)) }

func utf16Slice(text string, max int) string {
	units := utf16Units(text)
	if max >= len(units) {
		return text
	}
	return string(utf16.Decode(units[:max]))
}
