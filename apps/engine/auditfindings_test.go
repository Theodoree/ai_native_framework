package engine

// tests/audit-findings.test.mjs 的六组单元判据搬到这里（P-31 收尾：scripts/audit-findings.mjs 已删除，
// Node 侧再没有这份实现可 import，判据一条没丢，只换了层）。
//   validateResult      -> ValidateAuditResult
//   normalizeVerdict    -> NormalizeAuditVerdict（配合 AuditEffectiveVerdict）
//   compareFindings     -> CompareAuditFindings
//   toCheckConclusion   -> AuditCheckConclusion
//   workflowExitFor     -> AuditWorkflowExitFor
//   assess 跨槽不变式   -> AssessAudit
//   崩溃兜底（run 里抛异常） -> RunAuditFindings + 会 panic 的 stdout 替身
// 逐条映射见 /tmp/p31d2-t23.md。留在 Node 的那半（真跑引擎二进制、比 stdout/退出码/落盘文件）
// 由 tests/audit-findings.test.mjs 继续钉住 —— 入口面不进 Go 单测，那是另一层的事。

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const auditTestEvidence = `{"executor":"sandbox","agent":"review-a","model":"vendor/model-1","request_id":"req_8f2c1d"}`

const auditTestFinding = `{"path":"scripts/merge-gate.mjs","line":325,"severity":"high","criterion":"required check 只认 success","suggestion":"把 neutral 也算通过的判断去掉"}`

func auditJSON(t *testing.T, raw string) *Value {
	t.Helper()
	value, err := ParseJSON([]byte(raw))
	if err != nil {
		t.Fatalf("夹具不是合法 JSON：%v\n%s", err, raw)
	}
	return value
}

// auditRecordText 造一份结果记录；空参数走默认（pass / 无 findings / 合法 evidence）。
func auditRecordText(verdict, findingsJSON, evidenceJSON string) string {
	if verdict == "" {
		verdict = "pass"
	}
	if findingsJSON == "" {
		findingsJSON = "[]"
	}
	if evidenceJSON == "" {
		evidenceJSON = auditTestEvidence
	}
	return `{"verdict":"` + verdict + `","findings":` + findingsJSON + `,"evidence":` + evidenceJSON + `}`
}

func auditRecord(t *testing.T, verdict, findingsJSON, evidenceJSON string) *Value {
	t.Helper()
	return auditJSON(t, auditRecordText(verdict, findingsJSON, evidenceJSON))
}

// auditFindingText 造一条缺陷，overrides 形如 "severity":"critical" 的整段键值（可空）。
func auditFindingText(overrides string) string {
	if overrides == "" {
		return auditTestFinding
	}
	return `{"path":"scripts/merge-gate.mjs","line":325,` + overrides + `,"suggestion":"把 neutral 也算通过的判断去掉"}`
}

func auditErrorsJoin(problems []string) string { return strings.Join(problems, "\n") }

func TestValidateAuditResultAcceptsLegalResult(t *testing.T) {
	ok, problems := ValidateAuditResult(auditRecord(t, "", "["+auditTestFinding+"]", ""))
	if !ok {
		t.Fatalf("合法结果被判不合格：%v", problems)
	}
	if len(problems) != 0 {
		t.Fatalf("合法结果不该有问题，实际：%v", problems)
	}
}

func TestValidateAuditResultNamesMissingField(t *testing.T) {
	// 缺 suggestion：报错必须点名到 path.field，否则读者不知道补哪一格。
	finding := `{"path":"scripts/merge-gate.mjs","line":325,"severity":"high","criterion":"required check 只认 success"}`
	ok, problems := ValidateAuditResult(auditRecord(t, "", "["+finding+"]", ""))
	if ok {
		t.Fatalf("缺字段的结果被判合格")
	}
	if !strings.Contains(auditErrorsJoin(problems), "findings[0].suggestion") {
		t.Fatalf("报错要点名 findings[0].suggestion，实际：%v", problems)
	}
}

func TestValidateAuditResultReportsIllegalSeverityValue(t *testing.T) {
	ok, problems := ValidateAuditResult(auditRecord(t, "", "["+auditFindingText(`"severity":"critical","criterion":"required check 只认 success"`)+"]", ""))
	if ok {
		t.Fatalf("非法 severity 被判合格")
	}
	joined := auditErrorsJoin(problems)
	if !strings.Contains(joined, "findings[0].severity") {
		t.Fatalf("报错要点名 findings[0].severity，实际：%v", problems)
	}
	if !strings.Contains(joined, `"critical"`) {
		t.Fatalf("报错要报出实际值 \"critical\"，实际：%v", problems)
	}
}

func TestValidateAuditResultRequiresPositiveIntegerLine(t *testing.T) {
	ok, problems := ValidateAuditResult(auditRecord(t, "", "["+auditFindingText(`"line":"325","severity":"high","criterion":"c"`)+"]", ""))
	if ok {
		t.Fatalf("line 是字符串却被判合格")
	}
	if !strings.Contains(auditErrorsJoin(problems), "findings[0].line") {
		t.Fatalf("报错要点名 findings[0].line，实际：%v", problems)
	}
}

func TestValidateAuditResultRejectsIllegalVerdict(t *testing.T) {
	ok, problems := ValidateAuditResult(auditRecord(t, "ok", "", ""))
	if ok {
		t.Fatalf("非法 verdict 被判合格")
	}
	if !strings.Contains(auditErrorsJoin(problems), "verdict") {
		t.Fatalf("报错要点名 verdict，实际：%v", problems)
	}
}

func TestValidateAuditResultTreatsPlaceholderModelAsMissing(t *testing.T) {
	// pending-* 是本仓自己承认的占位值（见 .agents/platform/routing.yml）：
	// 漏了它，"没跑到" 就能写成 "跑到并通过"。
	for _, model := range []string{"", "unknown", "TODO", "n/a", "unset", "pending", "pending-review-a", "PENDING-impl"} {
		evidence := `{"executor":"sandbox","agent":"review-a","model":` + jsJSON(String(model)) + `,"request_id":"req_8f2c1d"}`
		ok, problems := ValidateAuditResult(auditRecord(t, "", "", evidence))
		if ok {
			t.Fatalf("占位符 model %q 被判合格", model)
		}
		if !strings.Contains(auditErrorsJoin(problems), "evidence.model") {
			t.Fatalf("model %q 的报错要点名 evidence.model，实际：%v", model, problems)
		}
	}
}

func TestValidateAuditResultCoversRoutingDeclaredPlaceholders(t *testing.T) {
	// 这一条不引用实现里的常量表：它读的是仓库声明里的占位值本身。
	// 表只覆盖「你想得到的那几个词」，真源覆盖「仓库实际在用的那几个」。
	raw, err := os.ReadFile(filepath.Join(repoRootAbs, DefaultRoutingPath))
	if err != nil {
		t.Fatalf("读不到 %s：%v", DefaultRoutingPath, err)
	}
	declaration, err := ParseYAML(raw)
	if err != nil {
		t.Fatalf("%s 不是合法 YAML：%v", DefaultRoutingPath, err)
	}
	routes := declaration.Get("routes")
	if !routes.IsArray() {
		t.Fatalf("%s 里没有 routes 数组", DefaultRoutingPath)
	}
	pending := make([]string, 0, 2)
	for index := 0; index < routes.Len(); index++ {
		model, ok := routes.At(index).Get("model").StringValue()
		if ok && strings.HasPrefix(strings.ToLower(model), "pending-") {
			pending = append(pending, model)
		}
	}
	if len(pending) == 0 {
		t.Fatalf("%s 里一条 pending-* 都没有，这条用例失去意义", DefaultRoutingPath)
	}
	for _, model := range pending {
		evidence := `{"executor":"sandbox","agent":"review-a","model":` + jsJSON(String(model)) + `,"request_id":"req_8f2c1d"}`
		declared := auditRecord(t, "", "", evidence)
		ok, problems := ValidateAuditResult(declared)
		if ok {
			t.Fatalf("声明里的占位符 %q 被判合格", model)
		}
		if !strings.Contains(auditErrorsJoin(problems), "evidence.model") {
			t.Fatalf("占位符 %q 的报错要点名 evidence.model，实际：%v", model, problems)
		}
		// 口径是「没判过」，不是「判成不合格」。
		if conclusion := AssessAudit(declared, nil).conclusion; conclusion != "action_required" {
			t.Fatalf("占位符 %q 的 conclusion 应当是 action_required，实际 %q", model, conclusion)
		}
	}
}

func TestValidateAuditResultTreatsPlaceholderRequestIDAsMissing(t *testing.T) {
	for _, requestID := range []string{"", "unknown", "todo", "n/a", "unset"} {
		evidence := `{"executor":"sandbox","agent":"review-a","model":"vendor/model-1","request_id":` + jsJSON(String(requestID)) + `}`
		ok, problems := ValidateAuditResult(auditRecord(t, "", "", evidence))
		if ok {
			t.Fatalf("占位符 request_id %q 被判合格", requestID)
		}
		if !strings.Contains(auditErrorsJoin(problems), "evidence.request_id") {
			t.Fatalf("request_id %q 的报错要点名 evidence.request_id，实际：%v", requestID, problems)
		}
	}
}

func TestNormalizeAuditVerdictPrefersStrongest(t *testing.T) {
	cases := []struct {
		name     string
		verdicts []string
		want     string
	}{
		{"全 pass -> pass", []string{"pass", "pass"}, "pass"},
		{"任一 needs_revision -> needs_revision", []string{"pass", "needs_revision"}, "needs_revision"},
		{"任一 reject -> reject（压过 needs_revision）", []string{"pass", "needs_revision", "reject"}, "reject"},
		{"任一 INFRA -> INFRA（压过 reject）", []string{"reject", "INFRA"}, "INFRA"},
		{"没有结果也是 INFRA（空集合不读成通过）", nil, "INFRA"},
	}
	for _, one := range cases {
		t.Run(one.name, func(t *testing.T) {
			if got := NormalizeAuditVerdict(one.verdicts); got != one.want {
				t.Fatalf("归一结果应当是 %q，实际 %q", one.want, got)
			}
		})
	}
}

func TestNormalizeAuditVerdictCountsSchemaFailureAsInfra(t *testing.T) {
	// schema 不合格按 INFRA 计，绝不按 pass：否则「写坏了」会被记成「判过了」。
	broken := auditRecord(t, "", "["+auditFindingText(`"severity":"critical","criterion":"c"`)+"]", "")
	good := auditRecord(t, "", "", "")
	verdict := NormalizeAuditVerdict([]string{AuditEffectiveVerdict(broken), AuditEffectiveVerdict(good)})
	if verdict != "INFRA" {
		t.Fatalf("schema 不合格应当把结论压成 INFRA，实际 %q", verdict)
	}
}

// auditCompareFixture 是 compareFindings 那组用例的公共夹具：一条一致、各一条单边、
// 一条「同一条但严重度不一致」。
func auditCompareFixture(t *testing.T) (*Value, *Value) {
	t.Helper()
	left := auditJSON(t, `{"findings":[`+auditTestFinding+`,`+
		`{"path":"scripts/a.mjs","line":7,"severity":"high","criterion":"只有 A 看见","suggestion":"补"},`+
		`{"path":"scripts/c.mjs","line":3,"severity":"low","criterion":"严重度不一致","suggestion":"补"}]}`)
	right := auditJSON(t, `{"findings":[`+auditTestFinding+`,`+
		`{"path":"scripts/b.mjs","line":9,"severity":"high","criterion":"只有 B 看见","suggestion":"补"},`+
		`{"path":"scripts/c.mjs","line":3,"severity":"blocker","criterion":"严重度不一致","suggestion":"补"}]}`)
	return left, right
}

func TestCompareAuditFindingsAgreedIsPathLineCriterion(t *testing.T) {
	left, right := auditCompareFixture(t)
	comparison := CompareAuditFindings(left, right)
	if len(comparison.agreed) != 1 {
		t.Fatalf("一致条目应当是 1 条，实际 %d", len(comparison.agreed))
	}
	if criterion, _ := comparison.agreed[0].Get("criterion").StringValue(); criterion != "required check 只认 success" {
		t.Fatalf("一致条目应当是共享的那条，实际 %q", criterion)
	}
}

func TestCompareAuditFindingsSplitsOnlyAAndOnlyB(t *testing.T) {
	left, right := auditCompareFixture(t)
	comparison := CompareAuditFindings(left, right)
	if len(comparison.onlyA) != 1 {
		t.Fatalf("onlyA 应当是 1 条，实际 %d", len(comparison.onlyA))
	}
	if criterion, _ := comparison.onlyA[0].Get("criterion").StringValue(); criterion != "只有 A 看见" {
		t.Fatalf("onlyA 认错了条目：%q", criterion)
	}
	if len(comparison.onlyB) != 1 {
		t.Fatalf("onlyB 应当是 1 条，实际 %d", len(comparison.onlyB))
	}
	if criterion, _ := comparison.onlyB[0].Get("criterion").StringValue(); criterion != "只有 B 看见" {
		t.Fatalf("onlyB 认错了条目：%q", criterion)
	}
}

func TestCompareAuditFindingsListsSeverityMismatchWithBothSides(t *testing.T) {
	left, right := auditCompareFixture(t)
	comparison := CompareAuditFindings(left, right)
	if len(comparison.severityMismatch) != 1 {
		t.Fatalf("severityMismatch 应当是 1 条，实际 %d", len(comparison.severityMismatch))
	}
	mismatch := comparison.severityMismatch[0]
	if path, _ := mismatch.Get("path").StringValue(); path != "scripts/c.mjs" {
		t.Fatalf("severityMismatch 的 path 不对：%q", path)
	}
	if line, ok := mismatch.Get("line").FloatValue(); !ok || line != 3 {
		t.Fatalf("severityMismatch 的 line 不对：%v", line)
	}
	if severityA, _ := mismatch.Get("severityA").StringValue(); severityA != "low" {
		t.Fatalf("severityA 应当是 low，实际 %q", severityA)
	}
	if severityB, _ := mismatch.Get("severityB").StringValue(); severityB != "blocker" {
		t.Fatalf("severityB 应当是 blocker，实际 %q", severityB)
	}
}

func TestCompareAuditFindingsCountsAndRateAgree(t *testing.T) {
	left, right := auditCompareFixture(t)
	counts := CompareAuditFindings(left, right).value().Get("counts")
	want := map[string]float64{"agreed": 1, "onlyA": 1, "onlyB": 1, "severityMismatch": 1}
	for key, expected := range want {
		got, _ := counts.Get(key).FloatValue()
		if got != expected {
			t.Fatalf("counts.%s 应当是 %v，实际 %v", key, expected, got)
		}
	}
	rate, _ := CompareAuditFindings(left, right).value().Get("agreementRate").FloatValue()
	if rate != 0.25 {
		t.Fatalf("同步率应当是 0.25，实际 %v", rate)
	}
}

func TestCompareAuditFindingsAcceptsBareFindingsArray(t *testing.T) {
	// 裸 findings 数组也是合法输入：两侧都吃数组或对象。
	bare := auditJSON(t, "["+auditTestFinding+"]")
	if got := len(CompareAuditFindings(bare, bare).agreed); got != 1 {
		t.Fatalf("裸 findings 数组应当比出 1 条一致，实际 %d", got)
	}
}

func TestCompareAuditFindingsIgnoresNonObjectElements(t *testing.T) {
	// null / 字符串 / 数组不是一条缺陷，也不许被解引用。
	left := auditJSON(t, `{"findings":[`+auditTestFinding+`,null,"x",["y"]]}`)
	right := auditJSON(t, `{"findings":[`+auditTestFinding+`]}`)
	comparison := CompareAuditFindings(left, right)
	if len(comparison.agreed) != 1 {
		t.Fatalf("一致条目应当是 1 条，实际 %d", len(comparison.agreed))
	}
	if comparison.total() != 1 {
		t.Fatalf("非对象元素不该参与比对，总数应当 1，实际 %d", comparison.total())
	}
}

func TestAuditCheckConclusionNeverGreensInfra(t *testing.T) {
	// GitHub 只把 success / skipped / neutral 算通过；neutral 会放行 required check，所以 INFRA 不能用它。
	passing := []string{"success", "skipped", "neutral"}
	if got := AuditCheckConclusion("pass"); got != "success" {
		t.Fatalf("pass 应当是 success，实际 %q", got)
	}
	for _, verdict := range []string{"needs_revision", "reject"} {
		if got := AuditCheckConclusion(verdict); got != "failure" {
			t.Fatalf("%s 应当是 failure，实际 %q", verdict, got)
		}
	}
	infra := AuditCheckConclusion("INFRA")
	if infra != "action_required" {
		t.Fatalf("INFRA 应当是 action_required，实际 %q", infra)
	}
	if auditContains(passing, infra) {
		t.Fatalf("INFRA 的 conclusion %q 落在通过集合里", infra)
	}
	if auditContains(passing, AuditCheckConclusion("whatever")) {
		t.Fatalf("认不出的 verdict 也不许给绿")
	}
}

func TestAuditExitCodeMapsVerdictToProcessExit(t *testing.T) {
	// 进程退出码是调用方唯一读得到的东西：判不了（INFRA）必须与「代码不合格」分开 —— 混成 0 就是
	// 把「没判过」当成「过了」，混成 1 就是把「没判过」说成「代码坏了」。这条不经 golden，直接钉函数。
	cases := []struct {
		verdict string
		want    int
	}{
		{"pass", 0},
		{"INFRA", 3},
		{"needs_revision", 1},
		{"reject", 1},
	}
	for _, c := range cases {
		if got := AuditExitCode(c.verdict); got != c.want {
			t.Fatalf("verdict %q 的进程退出码应当是 %d，实际 %d", c.verdict, c.want, got)
		}
	}
	// 认不出的 verdict 不许落到 0：未知不是通过。
	if got := AuditExitCode("verdict-from-the-future"); got == 0 {
		t.Fatalf("认不出的 verdict 不许回 0（通过），实际 %d", got)
	}
}
func TestAuditWorkflowExitForKeepsJobGreenForInfra(t *testing.T) {
	// job 级 check 不是第二个结论写者：只有 failure 让 job 红，action_required 不染 job，
	// 否则「未判过」会被说成「代码不合格」。
	if got := AuditWorkflowExitFor("success"); got != 0 {
		t.Fatalf("success 应当让 job 绿，实际 %d", got)
	}
	if got := AuditWorkflowExitFor("action_required"); got != 0 {
		t.Fatalf("action_required 不该染红 job，实际 %d", got)
	}
	if got := AuditWorkflowExitFor("failure"); got != 1 {
		t.Fatalf("failure 应当让 job 红，实际 %d", got)
	}
}

func TestAssessAuditInfraWhenTwoSlotsShareExecutorAndModel(t *testing.T) {
	// 一份意见不许记成两票：两个槽自报同一个执行器与同一个模型时，独立比对的前提消失。
	same := auditRecord(t, "", "", `{"executor":"github","agent":"review-b","model":"vendor/model-1","request_id":"req_8f2c1d"}`)
	result := AssessAudit(same, same)
	if result.verdict != "INFRA" {
		t.Fatalf("两个槽同执行器同模型应当判 INFRA，实际 %q", result.verdict)
	}
	if result.conclusion != "action_required" {
		t.Fatalf("conclusion 应当是 action_required，实际 %q", result.conclusion)
	}
	reasons := make([]string, 0, len(result.executors))
	for _, executor := range result.executors {
		if executor.reason != nil {
			reasons = append(reasons, *executor.reason)
		}
	}
	joined := strings.Join(reasons, "\n")
	if !strings.Contains(joined, "同一个执行器") {
		t.Fatalf("理由要点名「同一个执行器」，实际：%s", joined)
	}
	if !strings.Contains(joined, "与同一个模型 vendor/model-1") {
		t.Fatalf("理由要点名同一个模型，实际：%s", joined)
	}
}

func TestAssessAuditKeepsIndependenceWhenModelsDiffer(t *testing.T) {
	// 两位审查者都跑在 GitHub Actions 里，执行器必然都是 github；
	// 若只按执行器认重，自动产出 findings 这条路永远拿不到结论。
	a := auditRecord(t, "", "", `{"executor":"github","agent":"review-a","model":"deepseek-chat","request_id":"req_a"}`)
	b := auditRecord(t, "", "", `{"executor":"github","agent":"review-b","model":"deepseek-reasoner","request_id":"req_b"}`)
	result := AssessAudit(a, b)
	if result.verdict != "pass" {
		t.Fatalf("执行器相同而模型不同应当成立，实际 %q", result.verdict)
	}
	effective := make([]string, 0, 2)
	for _, executor := range result.executors {
		effective = append(effective, executor.effective)
	}
	if strings.Join(effective, ",") != "pass,pass" {
		t.Fatalf("两个执行器都应当计入 pass，实际 %v", effective)
	}
}

func TestAssessAuditUnaffectedByDifferentExecutors(t *testing.T) {
	other := auditRecord(t, "", "", `{"executor":"github","agent":"review-b","model":"vendor/model-1","request_id":"req_8f2c1d"}`)
	if got := AssessAudit(auditRecord(t, "", "", ""), other).verdict; got != "pass" {
		t.Fatalf("不同执行器不该被牵连，实际 %q", got)
	}
}

// auditPanickingWriter 复刻原用例的 stdout.write 抛异常：Go 侧同一条崩溃面。
type auditPanickingWriter struct{ message string }

func (writer auditPanickingWriter) Write(p []byte) (int, error) { panic(writer.message) }

func TestRunAuditFindingsCrashStillWritesInfraResult(t *testing.T) {
	// 崩溃面最容易被忽略的一处：结论已经算出来了，死在把它写出去的路上。
	// 宁可写一条 INFRA，也不许留空 —— 没有 result.json，workflow 既写不出 Check Run
	// 也没有 INFRA 留痕，上一个 sha 上的 success 会原样留着。
	dir := t.TempDir()
	a := filepath.Join(dir, "a.json")
	if err := os.WriteFile(a, []byte(auditRecordText("", "", "")), 0o644); err != nil {
		t.Fatalf("写夹具失败：%v", err)
	}
	out := filepath.Join(dir, "result.json")
	var stderr bytes.Buffer
	code := RunAuditFindings([]string{"--a", a, "--out", out}, auditPanickingWriter{message: "stdout 挂了"}, &stderr)
	if code != 3 {
		t.Fatalf("崩溃兜底应当退 3，实际 %d（stderr：%s）", code, stderr.String())
	}
	raw, err := os.ReadFile(out)
	if err != nil {
		t.Fatalf("崩溃后没有写出 result.json：%v", err)
	}
	parsed, err := ParseJSON(raw)
	if err != nil {
		t.Fatalf("result.json 不是合法 JSON：%v", err)
	}
	if conclusion, _ := parsed.Get("conclusion").StringValue(); conclusion != "action_required" {
		t.Fatalf("崩溃兜底的 conclusion 应当是 action_required，实际 %q", conclusion)
	}
	if exitCode, _ := parsed.Get("exit_code").FloatValue(); exitCode != 3 {
		t.Fatalf("exit_code 应当是 3，实际 %v", exitCode)
	}
	if jobExit, _ := parsed.Get("exit").FloatValue(); jobExit != 0 {
		t.Fatalf("job 级 exit 应当是 0（红由 Check Run 承载），实际 %v", jobExit)
	}
	reason, _ := parsed.Get("reason").StringValue()
	if !strings.Contains(reason, "口径层崩溃") {
		t.Fatalf("reason 要点名口径层崩溃，实际 %q", reason)
	}
	if !strings.Contains(reason, "stdout 挂了") {
		t.Fatalf("reason 要带上原始异常，实际 %q", reason)
	}
}
