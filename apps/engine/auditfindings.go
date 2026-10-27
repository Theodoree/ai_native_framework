package engine

// auditfindings.go —— scripts/audit-findings.mjs 的行为复刻。
//
// 这里搬的是「口径层」：固定 schema 的校验、多执行器 verdict 的归一、两份 findings 的
// 逐条比对、verdict → Check conclusion 的翻译。文案是照抄的，因为契约是逐字节一致
// （tests/engine-parity-d.test.mjs 同时喂 JS 与 Go，比 stdout / stderr / 退出码 / 写出文件）。
//
// 三条不变式（docs/audit-contract.md 二、三）：
//   1. evidence.model / evidence.request_id 是占位符就等于「没跑到」——不许写成「跑到并通过」；
//   2. INFRA 不是「不合格」，但也绝不给绿：判不了就说判不了；
//   3. 两个执行器自报同一个「执行器 + 模型」时，双执行器独立比对的前提消失，整体回落 INFRA。

import (
	"errors"
	"fmt"
	"io"
	"io/fs"
	"math"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
)

// AuditVerdicts 是 verdict 的合法枚举，顺序即「允许 pass|needs_revision|reject|INFRA」里的文案。
var AuditVerdicts = []string{"pass", "needs_revision", "reject", "INFRA"}

// AuditSeverities 是 severity 的合法枚举。
var AuditSeverities = []string{"blocker", "high", "medium", "low"}

// AuditExecutors 是执行器的合法枚举。
var AuditExecutors = []string{"sandbox", "github"}

// auditPlaceholders 是占位符表：写成一份表，散在各处判断就一定会有一处漏掉。
var auditPlaceholders = map[string]bool{
	"":            true,
	"unknown":     true,
	"pending":     true,
	"todo":        true,
	"tbd":         true,
	"n/a":         true,
	"na":          true,
	"unset":       true,
	"none":        true,
	"null":        true,
	"nil":         true,
	"-":           true,
	"?":           true,
	"placeholder": true,
}

// auditPlaceholderPrefix 是本仓 routing.yml 自己声明的占位前缀（model: pending-review-a）。
const auditPlaceholderPrefix = "pending-"

// auditCrashReason 是崩溃兜底结论的理由前缀。
const auditCrashReason = "口径层崩溃，没有产出结论"

var auditLineBreakReplacer = strings.NewReplacer("\r", " ", "\n", " ", "\u2028", " ", "\u2029", " ")

func auditContains(list []string, value string) bool {
	for _, item := range list {
		if item == value {
			return true
		}
	}
	return false
}

// auditShow 复刻 show(value) = JSON.stringify(value === undefined ? null : value)。
func auditShow(value *Value) string {
	if value.Kind() == KindUndefined {
		return "null"
	}
	return value.EncodeString()
}

// auditIsText 复刻 isText：字符串且 trim 后非空。
func auditIsText(value *Value) bool {
	text, ok := value.StringValue()
	return ok && jsTrim(text) != ""
}

// auditIsPlaceholder 复刻 isPlaceholder：不是文本、或者 trim+小写后命中占位符表/前缀。
func auditIsPlaceholder(value *Value) bool {
	if !auditIsText(value) {
		return true
	}
	text, _ := value.StringValue()
	lowered := strings.ToLower(jsTrim(text))
	return auditPlaceholders[lowered] || strings.HasPrefix(lowered, auditPlaceholderPrefix)
}

// auditOneLine 复刻 oneLine：把来自输入的 CR/LF/U+2028/U+2029 压成空格。
func auditOneLine(line string) string { return auditLineBreakReplacer.Replace(line) }

// auditOutLine 是唯一的写出口：Actions 把行首双冒号当 workflow command，所以这里中和一次。
func auditOutLine(line string) string {
	safe := auditOneLine(line)
	if strings.HasPrefix(safe, "::") {
		return "audit-findings " + safe
	}
	return safe
}

// auditFindingsType 复刻那个报错里的 typeof：null 显示成 null，缺键显示成 undefined。
func auditFindingsType(value *Value) string {
	if value.Kind() == KindUndefined {
		return "undefined"
	}
	if value.Kind() == KindNull {
		return "null"
	}
	return typeofName(value)
}

func auditIsFindingObject(value *Value) bool { return value.IsObject() }

// auditFindingsOf 复刻 findingsOf：数组自身，或对象里的 findings 数组，否则空数组。
func auditFindingsOf(value *Value) []*Value {
	if value.IsArray() {
		return value.arr
	}
	if value.IsObject() {
		if findings := value.Get("findings"); findings.IsArray() {
			return findings.arr
		}
	}
	return nil
}

// ValidateAuditResult 复刻 validateResult，返回 (ok, errors)。
func ValidateAuditResult(input *Value) (bool, []string) {
	if !input.IsObject() {
		return false, []string{"结果必须是对象 {verdict, findings, evidence}"}
	}
	problems := make([]string, 0, 4)
	verdict, verdictOK := input.Get("verdict").StringValue()
	if !verdictOK || !auditContains(AuditVerdicts, verdict) {
		problems = append(problems, "verdict: 非法枚举 "+auditShow(input.Get("verdict"))+"（允许 "+strings.Join(AuditVerdicts, "|")+"）")
	}
	findings := input.Get("findings")
	if !findings.IsArray() {
		problems = append(problems, "findings: 必须是数组（实际 "+auditFindingsType(findings)+"）")
	} else {
		for index := 0; index < findings.Len(); index++ {
			finding := findings.At(index)
			at := "findings[" + strconv.Itoa(index) + "]"
			if !finding.IsObject() {
				problems = append(problems, at+": 必须是对象")
				continue
			}
			if !auditIsText(finding.Get("path")) {
				problems = append(problems, at+".path: 必须是非空字符串")
			}
			if !auditIsPositiveInteger(finding.Get("line")) {
				problems = append(problems, at+".line: 必须是 ≥1 的整数（实际 "+auditShow(finding.Get("line"))+"）")
			}
			severity, severityOK := finding.Get("severity").StringValue()
			if !severityOK || !auditContains(AuditSeverities, severity) {
				problems = append(problems, at+".severity: 非法枚举 "+auditShow(finding.Get("severity"))+"（允许 "+strings.Join(AuditSeverities, "|")+"）")
			}
			if !auditIsText(finding.Get("criterion")) {
				problems = append(problems, at+".criterion: 必须是非空字符串")
			}
			if !auditIsText(finding.Get("suggestion")) {
				problems = append(problems, at+".suggestion: 必须是非空字符串")
			}
		}
	}
	evidence := input.Get("evidence")
	if !evidence.IsObject() {
		problems = append(problems, "evidence: 缺失或不是对象")
	} else {
		executor, executorOK := evidence.Get("executor").StringValue()
		if !executorOK || !auditContains(AuditExecutors, executor) {
			problems = append(problems, "evidence.executor: 非法枚举 "+auditShow(evidence.Get("executor"))+"（允许 "+strings.Join(AuditExecutors, "|")+"）")
		}
		if !auditIsText(evidence.Get("agent")) {
			problems = append(problems, "evidence.agent: 必须是非空字符串（逻辑名 review-a / review-b）")
		}
		if auditIsPlaceholder(evidence.Get("model")) {
			problems = append(problems, "evidence.model: 占位符 "+auditShow(evidence.Get("model"))+" 不算证据 —— 没跑到不能写成跑到并通过")
		}
		if auditIsPlaceholder(evidence.Get("request_id")) {
			problems = append(problems, "evidence.request_id: 占位符 "+auditShow(evidence.Get("request_id"))+" 不算证据 —— 没有上游 request_id 就无法追溯")
		}
	}
	return len(problems) == 0, problems
}

// auditIsPositiveInteger 复刻 Number.isInteger(value) && value >= 1。
func auditIsPositiveInteger(value *Value) bool {
	number, ok := value.FloatValue()
	if !ok {
		return false
	}
	return !math.IsNaN(number) && !math.IsInf(number, 0) && number == math.Trunc(number) && number >= 1
}

// AuditEffectiveVerdict 复刻 effectiveVerdict：schema 不合格一律按 INFRA（不合格不能被信任）。
func AuditEffectiveVerdict(result *Value) string {
	if ok, _ := ValidateAuditResult(result); ok {
		verdict, _ := result.Get("verdict").StringValue()
		return verdict
	}
	return "INFRA"
}

// NormalizeAuditVerdict 复刻 normalizeVerdict，合并顺序即优先级：INFRA > reject > needs_revision > pass。
func NormalizeAuditVerdict(verdicts []string) string {
	if len(verdicts) == 0 {
		return "INFRA"
	}
	if auditContains(verdicts, "INFRA") {
		return "INFRA"
	}
	if auditContains(verdicts, "reject") {
		return "reject"
	}
	if auditContains(verdicts, "needs_revision") {
		return "needs_revision"
	}
	return "pass"
}

// auditKeyOf 复刻 keyOf：path + NUL + line + NUL + criterion（join 会把 null/undefined 变成空串）。
func auditKeyOf(finding *Value) string {
	return auditJoinPart(finding.Get("path")) + "\x00" + auditJoinPart(finding.Get("line")) + "\x00" + auditJoinPart(finding.Get("criterion"))
}

// auditJoinPart 复刻 Array.prototype.join 对单个元素的处理：null/undefined 是空串。
func auditJoinPart(value *Value) string {
	if value.IsNullish() {
		return ""
	}
	return jsDisplay(value)
}

// AuditComparison 是两份 findings 的逐条比对结果。
type AuditComparison struct {
	agreed           []*Value
	onlyA            []*Value
	onlyB            []*Value
	severityMismatch []*Value
	agreementRate    *float64
}

func (comparison *AuditComparison) total() int {
	return len(comparison.agreed) + len(comparison.onlyA) + len(comparison.onlyB) + len(comparison.severityMismatch)
}

func (comparison *AuditComparison) value() *Value {
	toValue := func(items []*Value) *Value {
		list := Array()
		list.Append(items...)
		return list
	}
	counts := ObjectOf(
		"agreed", Number(float64(len(comparison.agreed))),
		"onlyA", Number(float64(len(comparison.onlyA))),
		"onlyB", Number(float64(len(comparison.onlyB))),
		"severityMismatch", Number(float64(len(comparison.severityMismatch))),
	)
	rate := Null()
	if comparison.agreementRate != nil {
		rate = Number(*comparison.agreementRate)
	}
	return ObjectOf(
		"agreed", toValue(comparison.agreed),
		"onlyA", toValue(comparison.onlyA),
		"onlyB", toValue(comparison.onlyB),
		"severityMismatch", toValue(comparison.severityMismatch),
		"counts", counts,
		"agreementRate", rate,
	)
}

// CompareAuditFindings 复刻 compareFindings：同一条 = path + line + criterion；
// severity 只决定「算不算一致」，不参与「是不是同一条」。
func CompareAuditFindings(a, b *Value) *AuditComparison {
	type slotEntry struct{ a, b *Value }
	order := make([]string, 0, 8)
	entries := make(map[string]*slotEntry, 8)
	take := func(finding *Value, isLeft bool) {
		if !auditIsFindingObject(finding) {
			return
		}
		key := auditKeyOf(finding)
		entry, ok := entries[key]
		if !ok {
			entry = &slotEntry{}
			entries[key] = entry
			order = append(order, key)
		}
		if isLeft {
			entry.a = finding
		} else {
			entry.b = finding
		}
	}
	for _, finding := range auditFindingsOf(a) {
		take(finding, true)
	}
	for _, finding := range auditFindingsOf(b) {
		take(finding, false)
	}
	comparison := &AuditComparison{}
	for _, key := range order {
		entry := entries[key]
		left, right := entry.a, entry.b
		switch {
		case left != nil && right != nil:
			if strictEqual(left.Get("severity"), right.Get("severity")) {
				comparison.agreed = append(comparison.agreed, left)
				continue
			}
			mismatch := Object()
			for _, name := range []string{"path", "line", "criterion"} {
				if value := left.Get(name); value != nil {
					mismatch.Set(name, value)
				}
			}
			if value := left.Get("severity"); value != nil {
				mismatch.Set("severityA", value)
			}
			if value := right.Get("severity"); value != nil {
				mismatch.Set("severityB", value)
			}
			comparison.severityMismatch = append(comparison.severityMismatch, mismatch)
		case left != nil:
			comparison.onlyA = append(comparison.onlyA, left)
		default:
			comparison.onlyB = append(comparison.onlyB, right)
		}
	}
	if total := comparison.total(); total != 0 {
		rate := float64(len(comparison.agreed)) / float64(total)
		comparison.agreementRate = &rate
	}
	return comparison
}

// AuditCheckConclusion 复刻 toCheckConclusion：INFRA 用 action_required（neutral 会让 required check 变绿）。
func AuditCheckConclusion(verdict string) string {
	switch verdict {
	case "pass":
		return "success"
	case "needs_revision", "reject":
		return "failure"
	}
	return "action_required"
}

// AuditExitCode 复刻 exitCodeFor：pass 0 / INFRA 3 / 其余 1。
func AuditExitCode(verdict string) int {
	switch verdict {
	case "pass":
		return 0
	case "INFRA":
		return 3
	}
	return 1
}

// AuditWorkflowExitFor 复刻 workflowExitFor：job 级只回答「这个 job 有没有跑错」，INFRA 由 Check Run 去红。
func AuditWorkflowExitFor(conclusion string) int {
	if conclusion == "failure" {
		return 1
	}
	return 0
}

// auditAccount 是一个执行器的账面：申报了什么、schema 过没过、按什么算、为什么没结论。
type auditAccount struct {
	slot      string
	declared  *Value
	effective string
	valid     bool
	errors    []string
	reason    *string
	evidence  *Value // nil 等价于 JS 的 undefined：result.json 里该键会被整键丢掉
	findings  []*Value
}

func (account *auditAccount) value() *Value {
	object := Object()
	object.Set("slot", String(account.slot))
	if account.declared == nil || account.declared.IsNullish() {
		object.Set("declared", Null())
	} else {
		object.Set("declared", account.declared)
	}
	object.Set("effective", String(account.effective))
	object.Set("valid", Bool(account.valid))
	problems := Array()
	for _, message := range account.errors {
		problems.Append(String(message))
	}
	object.Set("errors", problems)
	if account.reason != nil {
		object.Set("reason", String(*account.reason))
	} else {
		object.Set("reason", Null())
	}
	if account.evidence != nil {
		object.Set("evidence", account.evidence)
	}
	findings := Array()
	findings.Append(account.findings...)
	object.Set("findings", findings)
	return object
}

func auditAccountFor(slot string, raw *Value) *auditAccount {
	if raw.IsObject() {
		if readError, ok := raw.Get("__readError").StringValue(); ok {
			return &auditAccount{
				slot:      slot,
				declared:  Null(),
				effective: "INFRA",
				valid:     false,
				errors:    []string{"读不到输入：" + readError},
				evidence:  Null(),
			}
		}
	}
	ok, problems := ValidateAuditResult(raw)
	account := &auditAccount{slot: slot, valid: ok, errors: problems}
	if raw.IsObject() || raw.IsArray() {
		if verdict := raw.Get("verdict"); verdict != nil {
			account.declared = verdict
		}
	}
	if ok {
		verdict, _ := raw.Get("verdict").StringValue()
		account.effective = verdict
	} else {
		account.effective = "INFRA"
	}
	if reason, isReason := raw.Get("reason").StringValue(); isReason {
		account.reason = &reason
	}
	if raw.IsObject() || raw.IsArray() {
		account.evidence = raw.Get("evidence") // 可能是 nil（undefined）：键会被丢掉
	} else {
		account.evidence = Null()
	}
	account.findings = auditFindingsOf(raw)
	return account
}

// auditResult 是一次判定的完整结果。
type auditResult struct {
	verdict    string
	conclusion string
	exitCode   int
	executors  []*auditAccount
	comparison *AuditComparison
	reason     *string
}

// AssessAudit 复刻 assess({a, b})；nil 表示该槽没有输入（JS 的 undefined）。
func AssessAudit(a, b *Value) *auditResult {
	executors := make([]*auditAccount, 0, 2)
	if a != nil {
		executors = append(executors, auditAccountFor("a", a))
	}
	if b != nil {
		executors = append(executors, auditAccountFor("b", b))
	}
	// 槽内已经校验「自报的执行器 == 所在槽」，但槽间没有人管：两个槽都自报同一个
	// 「执行器 + 模型」时，双执行器独立比对的前提就没了 —— 一份意见会被记成两票。
	claimants := make([]string, 0, 2)
	for _, executor := range executors {
		evidence := executor.evidence
		name, nameOK := evidence.Get("executor").StringValue()
		model, modelOK := evidence.Get("model").StringValue()
		if nameOK && modelOK && name != "" && model != "" {
			claimants = append(claimants, name+"\x00"+model)
		}
	}
	duplicated := ""
	for index := 0; index < len(claimants) && duplicated == ""; index++ {
		for earlier := 0; earlier < index; earlier++ {
			if claimants[earlier] == claimants[index] {
				duplicated = claimants[index]
				break
			}
		}
	}
	if duplicated != "" {
		name, model, _ := strings.Cut(duplicated, "\x00")
		reason := "两个槽自报同一个执行器 " + name + " 与同一个模型 " + model + "：双执行器独立比对的前提消失"
		for _, executor := range executors {
			executor.effective = "INFRA"
			executor.reason = &reason
		}
	}
	verdicts := make([]string, 0, len(executors))
	for _, executor := range executors {
		verdicts = append(verdicts, executor.effective)
	}
	verdict := NormalizeAuditVerdict(verdicts)
	result := &auditResult{
		verdict:    verdict,
		conclusion: AuditCheckConclusion(verdict),
		exitCode:   AuditExitCode(verdict),
		executors:  executors,
	}
	if a != nil && b != nil {
		result.comparison = CompareAuditFindings(a, b)
	}
	return result
}

// auditFindingLine 渲染一条 finding。字段可能缺，有值就必须是一行（换行的中和服务在 auditOutLine）。
func auditFindingLine(finding *Value, middle string) string {
	parts := []string{
		auditShownOr(finding.Get("path"), "?"),
		":" + auditShownOr(finding.Get("line"), "?"),
		auditShownOr(finding.Get("severity"), "?"),
		middle,
		auditShownOr(finding.Get("criterion"), "?"),
	}
	kept := make([]string, 0, len(parts))
	for _, part := range parts {
		if part != "" {
			kept = append(kept, part)
		}
	}
	return strings.Join(kept, " ")
}

// auditShownOr 复刻「value ?? fallback」之后的字符串化。
func auditShownOr(value *Value, fallback string) string {
	if value.IsNullish() {
		return fallback
	}
	return jsDisplay(value)
}

type auditPaths struct {
	a *string
	b *string
}

func auditDash(value *string) string {
	if value == nil {
		return "-"
	}
	return *value
}

// reportAuditFindings 是唯一的写出口：所有来自输入的字段都从这里出去。
func reportAuditFindings(paths auditPaths, result *auditResult, stdout io.Writer) {
	writeLine := func(line string) { io.WriteString(stdout, auditOutLine(line)+"\n") }
	writeLine("audit-findings a=" + auditDash(paths.a) + " b=" + auditDash(paths.b))
	if result.reason != nil {
		writeLine("audit-findings reason - " + *result.reason)
	}
	for _, executor := range result.executors {
		evidence := executor.evidence
		who := "无 evidence"
		if evidence != nil && evidence.Truthy() {
			who = strings.Join([]string{
				auditJoinPart(evidence.Get("executor")),
				auditJoinPart(evidence.Get("agent")),
				auditShow(evidence.Get("model")),
				auditShow(evidence.Get("request_id")),
			}, "/")
		}
		schema := "不合格"
		if executor.valid {
			schema = "ok"
		}
		writeLine("audit-findings executor " + executor.slot +
			" 申报=" + auditShow(executor.declared) +
			" 计入=" + executor.effective +
			" schema=" + schema +
			" findings=" + strconv.Itoa(len(executor.findings)) +
			" evidence=" + who)
		for _, message := range executor.errors {
			writeLine("audit-findings schema " + executor.slot + " " + message)
		}
		if executor.reason != nil {
			writeLine("audit-findings reason " + executor.slot + " " + *executor.reason)
		}
	}
	if result.comparison != nil {
		comparison := result.comparison
		rate := "n/a"
		if comparison.agreementRate != nil {
			rate = strconv.FormatFloat(*comparison.agreementRate, 'f', 2, 64)
		}
		writeLine("audit-findings compare agreed=" + strconv.Itoa(len(comparison.agreed)) +
			" onlyA=" + strconv.Itoa(len(comparison.onlyA)) +
			" onlyB=" + strconv.Itoa(len(comparison.onlyB)) +
			" severityMismatch=" + strconv.Itoa(len(comparison.severityMismatch)) +
			" 同步率=" + rate)
		for _, finding := range comparison.onlyA {
			writeLine("audit-findings onlyA " + auditFindingLine(finding, ""))
		}
		for _, finding := range comparison.onlyB {
			writeLine("audit-findings onlyB " + auditFindingLine(finding, ""))
		}
		for _, finding := range comparison.severityMismatch {
			writeLine("audit-findings severityMismatch " + auditFindingLine(finding,
				"a="+jsDisplay(finding.Get("severityA"))+" b="+jsDisplay(finding.Get("severityB"))))
		}
	} else {
		writeLine("audit-findings compare skipped（只跑了一个执行器）")
	}
	writeLine("audit-findings verdict=" + result.verdict + " conclusion=" + result.conclusion + " exit=" + strconv.Itoa(result.exitCode))
}

// auditErrnoCode 复刻 Node fs 报错的 error.code（readFileSync 失败时 result.json 里只记 code）。
func auditErrnoCode(err error) string {
	switch {
	case errors.Is(err, fs.ErrNotExist):
		return "ENOENT"
	case errors.Is(err, fs.ErrPermission):
		return "EACCES"
	case errors.Is(err, fs.ErrExist):
		return "EEXIST"
	case errors.Is(err, syscall.EISDIR):
		return "EISDIR"
	case errors.Is(err, syscall.ENOTDIR):
		return "ENOTDIR"
	}
	return "EUNKNOWN"
}

// loadAuditResult 复刻 loadResult：读不到 / 解析不了都记成 __readError（没拿到结论，不是这一笔不合格）。
func loadAuditResult(path string) *Value {
	raw, err := os.ReadFile(path)
	if err != nil {
		return ObjectOf("__readError", String(path+": "+auditErrnoCode(err)))
	}
	parsed, parseErr := ParseJSON(raw)
	if parseErr != nil {
		return ObjectOf("__readError", String(path+": "+parseErr.Error()))
	}
	return parsed
}

// writeAuditResult 复刻 writeResult：键序 verdict, conclusion, exit_code, exit, executors, comparison, reason。
func writeAuditResult(out string, result *auditResult) error {
	directory := filepath.Dir(out)
	if err := os.MkdirAll(directory, 0o777); err != nil {
		return fmt.Errorf("%s", nodeOpenError(directory, err))
	}
	executors := Array()
	for _, executor := range result.executors {
		executors.Append(executor.value())
	}
	comparison := Null()
	if result.comparison != nil {
		comparison = result.comparison.value()
	}
	reason := Null()
	if result.reason != nil {
		reason = String(*result.reason)
	}
	payload := ObjectOf(
		"verdict", String(result.verdict),
		"conclusion", String(result.conclusion),
		"exit_code", Number(float64(result.exitCode)),
		"exit", Number(float64(AuditWorkflowExitFor(result.conclusion))),
		"executors", executors,
		"comparison", comparison,
		"reason", reason,
	)
	content := append(payload.EncodeIndent(2), '\n')
	if err := os.WriteFile(out, content, 0o666); err != nil {
		return fmt.Errorf("%s", nodeOpenError(out, err))
	}
	return nil
}

// AuditFindingsExplain 是 audit-findings 的自证：它读什么、写什么、退出码各是什么。
//
// 判定步在 workflow 里是编译产物，文本扫描看不见它读写了哪些路径 —— 这份声明就是被
// 「可扫描文本」顶替掉的那部分证据。所以它两侧都要被钉住
// （tests/audit-findings.test.mjs）：声明 == workflow 实际传的参数，声明 == 实现
// （每个声明的退出码都真的能跑出来，没声明的跑不出来）。
func AuditFindingsExplain() *Value {
	return ObjectOf(
		"subcommand", String("audit-findings"),
		"args", Array(String("--a"), String("--b"), String("--out")),
		"reads", Array(String("--a"), String("--b")),
		"writes", Array(String("--out")),
		// 这一格是编译产物的源码模块：文本层读不到产物，但要能指出「产物背后是哪份实现」，
		// 判据据此把产出者本体的字段名豁免绑到同一处声明上，而不是手写文件名。
		"source", Array(String("scripts/audit-findings.mjs")),
		"exitCodes", ObjectOf(
			"0", String("有结论且结论是 pass"),
			"1", String("有结论且结论是 needs_revision / reject"),
			"3", String("判不了（INFRA）：输入不合格、读不出、写不出、崩了"),
		),
	)
}

// RunAuditFindings 复刻 audit-findings.mjs 的 run。
func RunAuditFindings(argv []string, stdout, stderr io.Writer) int {
	// --explain 只回答「这个子命令读什么/写什么/退出码是什么」，不读输入也不写输出：
	// 判据用它来替代「扫文本看得出来」这件事。
	if hasArg(argv, "--explain") {
		io.WriteString(stdout, string(AuditFindingsExplain().EncodeIndent(2))+"\n")
		return 0
	}
	paths := auditPaths{}
	if value, ok := argAfter(argv, "--a"); ok {
		paths.a = &value
	}
	if value, ok := argAfter(argv, "--b"); ok {
		paths.b = &value
	}
	out, hasOut := argAfter(argv, "--out")

	var result *auditResult
	func() {
		defer func() {
			if recovered := recover(); recovered != nil {
				message := fmt.Sprint(recovered)
				reason := auditCrashReason + "：" + message
				result = &auditResult{
					verdict:    "INFRA",
					conclusion: "action_required",
					exitCode:   3,
					executors:  []*auditAccount{},
					reason:     &reason,
				}
				io.WriteString(stderr, "audit-findings crash: "+message+"\n")
				func() {
					defer func() { _ = recover() }()
					reportAuditFindings(paths, result, stdout)
				}()
			}
		}()
		var left, right *Value
		if paths.a != nil && *paths.a != "" {
			left = loadAuditResult(*paths.a)
		}
		if paths.b != nil && *paths.b != "" {
			right = loadAuditResult(*paths.b)
		}
		result = AssessAudit(left, right)
		reportAuditFindings(paths, result, stdout)
	}()
	if hasOut && out != "" {
		if err := writeAuditResult(out, result); err != nil {
			io.WriteString(stderr, "audit-findings 写不出 "+out+"："+err.Error()+"\n")
			return 3
		}
	}
	return result.exitCode
}
