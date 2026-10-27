package engine

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// 这些用例逐条钉住原 ledger-cli.mjs / ledger.mjs 的判据：两个参照物
// （scripts/ledger-cli.mjs、scripts/ledger.mjs）已随本批删除。全仓 grep 的结论是
// 没有任何 Node 用例 import / spawn 过它们，所以「只钉它们的 Node 用例」一条也
// 没有，判据全部落在这里，一条不少。
//
// 每条用例对应 tests/goldens/a/ 的一个冻结夹具（见各用例注释的 a-NN），断言的
// stdout / stderr / 退出码 / 落盘字节与该夹具逐字节一致。夹具本身仍留在
// tests/goldens/a/，但参照物消失后它不再可重冻（tests/goldens/freeze.mjs 的
// missingReferences 会点名）——本文件就是那些夹具的可执行孪生体。
//
// 唯一不等价的是 a-44：Node 的 JSON 报错文案随 V8 版本漂移，golden 存的是
// withoutPosition 归一后的前半句，坐标后缀由夹具的 goStderrContains 单独声明
// （"at position 1 (line 1 column 2)"）。这里按 Go 自己的整句断言（更强，不弱）。

const (
	// goldenLedgerText 是 tests/goldens/parity-cases.mjs:387 的 aLedgerText：
	// suite a 里 fixture.ledger=true 的夹具都往临时目录写这份账本。
	goldenLedgerText = `{"id":"REQ-1","at":"2024-01-01T00:00:00Z","title":"甲","body":"","from":"none","to":"triage","by":"ci","flow":"manual","comment":""}
{"id":"REQ-1","at":"2024-01-02T00:00:00Z","from":"triage","to":"analyzing","by":"owner","flow":null,"comment":"看"}
{"id":"REQ-2","at":"2024-01-03T00:00:00Z","from":"none","to":"triage","by":"ci","flow":"manual","comment":""}` + "\n"

	// repoConfigRel 相对 apps/engine，指向仓库真实的状态机声明：suite a 的夹具就是
	// 把仓库这份配置 copy 进临时目录再跑 CLI 的。entry / config 的期望值因此与
	// tests/goldens/a/a-38.json、a-39.json 同源——改声明要同时重冻 golden 与这里的
	// 字面量，这是 golden 本来的耦合，不是这一批新增的。
	repoConfigRel = "../../.agents/platform/state-machine.yml"
)

// ledgerCLI 走 Run 的 case 表（而不是直接调 Fold / NextID），这样 stdout 的键序、
// 换行、退出码这些「CLI 形状」判据也一并被钉住。
func ledgerCLI(t *testing.T, root, stdin string, argv ...string) (int, string, string) {
	t.Helper()
	var out, errOut bytes.Buffer
	code := Run(append([]string{"ledger"}, argv...), strings.NewReader(stdin), &out, &errOut, root)
	return code, out.String(), errOut.String()
}

// ledgerSandbox 复刻 suite a 的 run()：临时目录 + 真实 state-machine.yml +
// PLATFORM_LEDGER 指到临时目录里的 ledger.jsonl。账本文件本身不预置，需要
// 「账本已存在」的用例自己调 ledgerSeed。
func ledgerSandbox(t *testing.T) (root, ledgerPath string) {
	t.Helper()
	root = t.TempDir()
	platform := filepath.Join(root, ".agents", "platform")
	if err := os.MkdirAll(platform, 0o755); err != nil {
		t.Fatalf("建配置目录失败: %v", err)
	}
	config, err := os.ReadFile(repoConfigRel)
	if err != nil {
		t.Fatalf("读仓库声明失败: %v", err)
	}
	if writeErr := os.WriteFile(filepath.Join(platform, "state-machine.yml"), config, 0o644); writeErr != nil {
		t.Fatalf("落声明失败: %v", writeErr)
	}
	ledgerPath = filepath.Join(root, "ledger.jsonl")
	t.Setenv("PLATFORM_LEDGER", ledgerPath)
	return root, ledgerPath
}

func ledgerSeed(t *testing.T, ledgerPath, text string) {
	t.Helper()
	if err := os.WriteFile(ledgerPath, []byte(text), 0o644); err != nil {
		t.Fatalf("写账本失败: %v", err)
	}
}

func lgWant(t *testing.T, got, want, what string) {
	t.Helper()
	if got != want {
		t.Fatalf("%s 不等于冻结 golden\n  实际 = %q\n  期望 = %q", what, got, want)
	}
}

// a-35：events 原样吐出账本字节（不折叠、不排序、不补默认值）。
func TestLedgerCLIEventsPrintsLedgerBytes(t *testing.T) {
	root, ledgerPath := ledgerSandbox(t)
	ledgerSeed(t, ledgerPath, goldenLedgerText)
	code, stdout, stderr := ledgerCLI(t, root, "", "events", "--json")
	if code != 0 {
		t.Fatalf("退出码 = %d，期望 0；stderr = %q", code, stderr)
	}
	lgWant(t, stdout, `[{"id":"REQ-1","at":"2024-01-01T00:00:00Z","title":"甲","body":"","from":"none","to":"triage","by":"ci","flow":"manual","comment":""},{"id":"REQ-1","at":"2024-01-02T00:00:00Z","from":"triage","to":"analyzing","by":"owner","flow":null,"comment":"看"},{"id":"REQ-2","at":"2024-01-03T00:00:00Z","from":"none","to":"triage","by":"ci","flow":"manual","comment":""}]`+"\n", "stdout")
}

// a-36：fold 按 updatedAt 降序，字段序固定 id,title,body,state,history,updatedAt。
func TestLedgerCLIFoldSortsByUpdatedAt(t *testing.T) {
	root, ledgerPath := ledgerSandbox(t)
	ledgerSeed(t, ledgerPath, goldenLedgerText)
	code, stdout, stderr := ledgerCLI(t, root, "", "fold", "--json")
	if code != 0 {
		t.Fatalf("退出码 = %d，期望 0；stderr = %q", code, stderr)
	}
	lgWant(t, stdout, `[{"id":"REQ-2","title":"(未命名)","body":"","state":"triage","history":[{"id":"REQ-2","at":"2024-01-03T00:00:00Z","from":"none","to":"triage","by":"ci","flow":"manual","comment":""}],"updatedAt":"2024-01-03T00:00:00Z"},{"id":"REQ-1","title":"甲","body":"","state":"analyzing","history":[{"id":"REQ-1","at":"2024-01-01T00:00:00Z","title":"甲","body":"","from":"none","to":"triage","by":"ci","flow":"manual","comment":""},{"id":"REQ-1","at":"2024-01-02T00:00:00Z","from":"triage","to":"analyzing","by":"owner","flow":null,"comment":"看"}],"updatedAt":"2024-01-02T00:00:00Z"}]`+"\n", "stdout")
}

// a-37：next-id 从条数 + 1 起算（3 条事件之后是 REQ-4），不按 id 推。
func TestLedgerCLINextIDPrintsNextNumber(t *testing.T) {
	root, ledgerPath := ledgerSandbox(t)
	ledgerSeed(t, ledgerPath, goldenLedgerText)
	code, stdout, stderr := ledgerCLI(t, root, "", "next-id", "--json")
	if code != 0 {
		t.Fatalf("退出码 = %d，期望 0；stderr = %q", code, stderr)
	}
	lgWant(t, stdout, `{"id":"REQ-4"}`+"\n", "stdout")
}

// a-38：entry 取声明里的第一条转换（无标签 → accepted/platform）。
func TestLedgerCLIEntryReadsDeclaration(t *testing.T) {
	root, ledgerPath := ledgerSandbox(t)
	ledgerSeed(t, ledgerPath, goldenLedgerText)
	code, stdout, stderr := ledgerCLI(t, root, "", "entry", "--json")
	if code != 0 {
		t.Fatalf("退出码 = %d，期望 0；stderr = %q", code, stderr)
	}
	lgWant(t, stdout, `{"to":"accepted","by":"platform"}`+"\n", "stdout")
}

// a-39：config 吐声明视图（states 带 terminal/meaning，transitions 保持原序）。
func TestLedgerCLIConfigPrintsDeclaration(t *testing.T) {
	root, ledgerPath := ledgerSandbox(t)
	ledgerSeed(t, ledgerPath, goldenLedgerText)
	code, stdout, stderr := ledgerCLI(t, root, "", "config", "--json")
	if code != 0 {
		t.Fatalf("退出码 = %d，期望 0；stderr = %q", code, stderr)
	}
	lgWant(t, stdout, `{"defaultFlow":"auto","labelPrefix":"state:","states":[{"name":"triage","terminal":false,"meaning":"已入库，未分发"},{"name":"analyzing","terminal":false,"meaning":"分析中，可含交叉验证"},{"name":"needs-info","terminal":false,"meaning":"等提议人补信息"},{"name":"rejected","terminal":true,"meaning":"不受理（owner 裁决）"},{"name":"accepted","terminal":false,"meaning":"受理，等认领"},{"name":"in-progress","terminal":false,"meaning":"有 PR 在途"},{"name":"blocked","terminal":false,"meaning":"需修订后重提"},{"name":"done","terminal":true,"meaning":"已合并且 merge gate 守卫通过"},{"name":"cancelled","terminal":true,"meaning":"放弃或关闭未合并"}],"transitions":[{"from":"none","to":"triage","by":"ci","event":"issues.opened","flow":"manual"},{"from":"none","to":"accepted","by":"platform","event":"issues.opened","flow":"auto"},{"from":"triage","to":"analyzing","by":"ci","event":"issues.labeled"},{"from":"analyzing","to":"accepted","by":"owner","comment_required":true},{"from":"analyzing","to":"rejected","by":"owner","comment_required":true},{"from":"analyzing","to":"needs-info","by":"owner","comment_required":true},{"from":"needs-info","to":"analyzing","by":"proposer","comment_required":true},{"from":"accepted","to":"rejected","by":"owner","comment_required":true},{"from":"accepted","to":"needs-info","by":"owner","comment_required":true},{"from":"accepted","to":"in-progress","by":"ci","event":"pull_request.opened"},{"from":"in-progress","to":"blocked","by":"owner","comment_required":true},{"from":"blocked","to":"in-progress","by":"ci","event":"pull_request.synchronize"},{"from":"in-progress","to":"done","by":"ci","event":"pull_request.closed(merged)","guards":["merge-gate"]},{"from":"*","to":"cancelled","by":"owner","comment_required":true}]}`+"\n", "stdout")
}

// a-40：账本文件不存在时 fold 得空数组，不是报错。
func TestLedgerCLIEmptyLedgerFoldsToEmptyArray(t *testing.T) {
	root, _ := ledgerSandbox(t)
	code, stdout, stderr := ledgerCLI(t, root, "", "fold", "--json")
	if code != 0 {
		t.Fatalf("退出码 = %d，期望 0；stderr = %q", code, stderr)
	}
	lgWant(t, stdout, `[]`+"\n", "stdout")
}

// a-41：append 回显 stdin 事件，且落盘字节与回显一致（单行 + 换行）。
func TestLedgerCLIAppendEchoesAndPersists(t *testing.T) {
	root, ledgerPath := ledgerSandbox(t)
	code, stdout, stderr := ledgerCLI(t, root, `{"id":"REQ-9","at":"2024-02-01T00:00:00Z","from":"none","to":"triage","by":"ci","flow":"manual","comment":""}`, "append", "--json")
	if code != 0 {
		t.Fatalf("退出码 = %d，期望 0；stderr = %q", code, stderr)
	}
	lgWant(t, stdout, `{"id":"REQ-9","at":"2024-02-01T00:00:00Z","from":"none","to":"triage","by":"ci","flow":"manual","comment":""}`+"\n", "stdout")
	raw, err := os.ReadFile(ledgerPath)
	if err != nil {
		t.Fatalf("读回账本失败: %v", err)
	}
	lgWant(t, string(raw), `{"id":"REQ-9","at":"2024-02-01T00:00:00Z","from":"none","to":"triage","by":"ci","flow":"manual","comment":""}`+"\n", "落盘字节")
}

// a-42：空白 stdin 判 E_STDIN_EMPTY（不是「解析失败」），且失败时不落账。
func TestLedgerCLIAppendRejectsEmptyStdin(t *testing.T) {
	root, ledgerPath := ledgerSandbox(t)
	code, stdout, stderr := ledgerCLI(t, root, "  \n", "append", "--json")
	if code != 3 {
		t.Fatalf("退出码 = %d，期望 3", code)
	}
	lgWant(t, stdout, "", "stdout")
	lgWant(t, stderr, `{"kind":"infra","code":"E_STDIN_EMPTY","message":"stdin 为空：需要一个事件对象","extra":{}}`+"\n", "stderr")
	if _, err := os.Stat(ledgerPath); !os.IsNotExist(err) {
		t.Fatalf("失败时不应落账: %v", err)
	}
}

// a-43：合法 JSON 但不是对象判 E_EVENT_SHAPE（数组也不行）。
func TestLedgerCLIAppendRejectsNonObject(t *testing.T) {
	root, _ := ledgerSandbox(t)
	code, stdout, stderr := ledgerCLI(t, root, "[1]", "append", "--json")
	if code != 3 {
		t.Fatalf("退出码 = %d，期望 3", code)
	}
	lgWant(t, stdout, "", "stdout")
	lgWant(t, stderr, `{"kind":"infra","code":"E_EVENT_SHAPE","message":"stdin 不是事件对象","extra":{}}`+"\n", "stderr")
}

// a-44：非 JSON 判 E_EVENT_UNPARSABLE，message 保留 Go 自己的解析文案（含坐标）。
func TestLedgerCLIAppendRejectsUnparsableJSON(t *testing.T) {
	root, _ := ledgerSandbox(t)
	code, stdout, stderr := ledgerCLI(t, root, "{oops", "append", "--json")
	if code != 3 {
		t.Fatalf("退出码 = %d，期望 3", code)
	}
	lgWant(t, stdout, "", "stdout")
	lgWant(t, stderr, `{"kind":"infra","code":"E_EVENT_UNPARSABLE","message":"stdin 不是合法 JSON: Expected property name or '}' in JSON at position 1 (line 1 column 2)","extra":{}}`+"\n", "stderr")
}

// a-45：账本里有一行坏 JSON 时 fold 整体拒绝继续（E_CLI_FAILED，不静默跳过）。
func TestLedgerCLIRejectsBrokenLedger(t *testing.T) {
	root, ledgerPath := ledgerSandbox(t)
	ledgerSeed(t, ledgerPath, "{\"id\":\"REQ-1\"}\nnot-json\n")
	code, stdout, stderr := ledgerCLI(t, root, "", "fold", "--json")
	if code != 3 {
		t.Fatalf("退出码 = %d，期望 3", code)
	}
	lgWant(t, stdout, "", "stdout")
	lgWant(t, stderr, `{"kind":"infra","code":"E_CLI_FAILED","message":"账本第 2 行不是合法 JSON，拒绝在坏账本上继续写","extra":{}}`+"\n", "stderr")
}

// a-46：未知子命令只打印用法，退出码 3（2 留给 engine 自己的未知子命令）。
func TestLedgerCLIUnknownCommandPrintsUsage(t *testing.T) {
	root, _ := ledgerSandbox(t)
	code, stdout, stderr := ledgerCLI(t, root, "", "nope")
	if code != 3 {
		t.Fatalf("退出码 = %d，期望 3", code)
	}
	lgWant(t, stdout, "", "stdout")
	lgWant(t, stderr, `用法: ledger-cli.mjs fold|events|next-id|append|entry|config [--json]`+"\n", "stderr")
}

// next-id 的边界：起点是条数 + 1，撞上已在用的号要继续往后跳。这是 CLI 形状
// 抓不住的那部分（a-37 的账本里没有空洞），只能在函数级补一条。
func TestLedgerNextIDSkipsUsedIDs(t *testing.T) {
	events, err := ParseJSON([]byte(`[
		{"id":"REQ-1","at":"2024-01-01T00:00:00Z","from":"none","to":"triage","by":"ci"},
		{"id":"REQ-2","at":"2024-01-02T00:00:00Z","from":"none","to":"triage","by":"ci"},
		{"id":"REQ-4","at":"2024-01-03T00:00:00Z","from":"none","to":"triage","by":"ci"}
	]`))
	if err != nil {
		t.Fatalf("事件不是合法 JSON: %v", err)
	}
	// 3 条事件 → 从 REQ-4 起算；REQ-4 已被占用 → 跳到 REQ-5。
	if id := NextID(events); id != "REQ-5" {
		t.Fatalf("next-id = %s，期望 REQ-5（REQ-4 已被占用）", id)
	}
}
