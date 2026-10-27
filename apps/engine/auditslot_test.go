package engine

// tests/audit-slot.test.mjs 的 6 条判据搬到这里（P-31 阶段 D2 收口：Node 套件删除，判据不丢）。
// 逐条映射见 /tmp/p31d2g-t17b-port.md：
//   1 自报身份与槽位一致：原样透传 -> TestAuditSlotPassthroughWhenIdentityMatches
//   2 一个执行器不许占两个槽 -> TestAuditSlotInfraWhenExecutorOccupiesTwoSlots
//   3 没注入就是 INFRA，不是空 findings 的 pass -> TestAuditSlotInfraWhenInputMissing
//   4 坏 JSON 原样交出去 -> TestAuditSlotPassesBadJSONThrough
//   5 evidence 缺失也算身份不符 -> TestAuditSlotInfraWhenEvidenceMissing
//   6 入口经软链调用也真跑 -> TestAuditSlotCLIRunsThroughSymlink

import (
	"bytes"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

func auditSlotOK(evidence string) string {
	return `{"verdict":"pass","findings":[],"evidence":` + evidence + `}`
}

func TestAuditSlotPassthroughWhenIdentityMatches(t *testing.T) {
	raw := auditSlotOK(`{"executor":"sandbox","agent":"review-a","model":"m","request_id":"r"}`)
	got := AuditSlotRecord("review-a", "sandbox", raw)
	if got != raw {
		t.Fatalf("身份一致时必须原样透传：want %q got %q", raw, got)
	}
}

func TestAuditSlotInfraWhenExecutorOccupiesTwoSlots(t *testing.T) {
	raw := auditSlotOK(`{"executor":"github","agent":"review-b","model":"m","request_id":"r"}`)
	record, err := ParseJSON([]byte(AuditSlotRecord("review-a", "sandbox", raw)))
	if err != nil {
		t.Fatalf("产出必须是合法 JSON: %v", err)
	}
	if verdict, _ := record.Get("verdict").StringValue(); verdict != "INFRA" {
		t.Fatalf("身份不符必须判 INFRA，得到 %q", verdict)
	}
	reason, _ := record.Get("reason").StringValue()
	if !strings.Contains(reason, "一个执行器不能占两个槽") {
		t.Fatalf("reason 必须点名「一个执行器不能占两个槽」，得到 %q", reason)
	}
	// 身份由「所在槽」定，不由输入自报定：记录里写的是 sandbox/review-a。
	want := `{"executor":"sandbox","agent":"review-a"}`
	if got := record.Get("evidence").EncodeString(); got != want {
		t.Fatalf("evidence 必须写所在槽的身份，得到 %s", got)
	}
}

func TestAuditSlotInfraWhenInputMissing(t *testing.T) {
	// 原用例对 ["", "   ", undefined] 逐个判：空串、全空白、根本没这个变量三种「没注入」。
	for _, item := range []struct {
		name  string
		value string
		unset bool
	}{
		{"空串", "", false},
		{"全空白", "   ", false},
		{"变量不存在", "", true},
	} {
		t.Run(item.name, func(t *testing.T) {
			t.Setenv("AUDIT_INPUT", item.value)
			if item.unset {
				// t.Setenv 先登记还原，再真的把变量删掉：这一步模拟 process.env 里没有它。
				if err := os.Unsetenv("AUDIT_INPUT"); err != nil {
					t.Fatalf("撤掉 AUDIT_INPUT 失败: %v", err)
				}
			}
			record, err := ParseJSON([]byte(auditSlotRecordViaCLI(t, "review-b", "github")))
			if err != nil {
				t.Fatalf("产出必须是合法 JSON: %v", err)
			}
			if verdict, _ := record.Get("verdict").StringValue(); verdict != "INFRA" {
				t.Fatalf("没注入必须判 INFRA，得到 %q", verdict)
			}
			findings := record.Get("findings")
			if findings == nil || !findings.IsArray() || findings.Len() != 0 {
				t.Fatalf("INFRA 的 findings 必须是空数组，得到 %s", findings.Encode())
			}
		})
	}
}

// auditSlotRecordViaCLI 走 RunAuditSlot 的 CLI 边界读回 --out 的内容：
// 「变量不存在」只有在进程环境上才分得出来。
func auditSlotRecordViaCLI(t *testing.T, slot, executor string) string {
	t.Helper()
	out := filepath.Join(t.TempDir(), "record.json")
	var stdout, stderr bytes.Buffer
	if code := RunAuditSlot([]string{"--slot", slot, "--executor", executor, "--out", out}, &stdout, &stderr); code != 0 {
		t.Fatalf("写入槽位记录应当退出 0，得到 %d（stderr=%s）", code, stderr.String())
	}
	raw, err := os.ReadFile(out)
	if err != nil {
		t.Fatalf("--out 没写出来: %v", err)
	}
	return string(raw)
}

func TestAuditSlotPassesBadJSONThrough(t *testing.T) {
	// 坏 JSON 不改写成 pass，也不在这里报错：交给口径层点名坏字段。
	if got := AuditSlotRecord("review-a", "sandbox", "{not json"); got != "{not json" {
		t.Fatalf("坏 JSON 必须原样交出，得到 %s", got)
	}
}

func TestAuditSlotInfraWhenEvidenceMissing(t *testing.T) {
	input := `{"verdict":"pass","findings":[]}`
	record, err := ParseJSON([]byte(AuditSlotRecord("review-a", "sandbox", input)))
	if err != nil {
		t.Fatalf("产出必须是合法 JSON: %v", err)
	}
	if verdict, _ := record.Get("verdict").StringValue(); verdict != "INFRA" {
		t.Fatalf("没有自报身份等于无法证明是谁，必须判 INFRA，得到 %q", verdict)
	}
}

// engineBinaryOnce 只构建一次：软链那条用例要真跑一个可执行文件。
var engineBinaryOnce struct {
	once sync.Once
	path string
	err  error
}

func engineBinaryForTest(t *testing.T) string {
	t.Helper()
	engineBinaryOnce.once.Do(func() {
		dir, err := os.MkdirTemp("", "engine-bin-")
		if err != nil {
			engineBinaryOnce.err = err
			return
		}
		bin := filepath.Join(dir, "engine")
		build := exec.Command("go", "build", "-o", bin, "./cmd/engine")
		// 引擎 module 在 apps/engine；go build 必须在 module 根目录跑。
		build.Dir = filepath.Join(repoRootAbs, "apps", "engine")
		output, err := build.CombinedOutput()
		if err != nil {
			engineBinaryOnce.err = err
			t.Logf("构建引擎失败: %v output=%s", err, string(output))
			return
		}
		engineBinaryOnce.path = bin
	})
	if engineBinaryOnce.err != nil {
		t.Fatalf("引擎没构建出来: %v", engineBinaryOnce.err)
	}
	return engineBinaryOnce.path
}

// TestAuditSlotCLIRunsThroughSymlink 钉的是「入口判定不能按字面路径比较」：
// 检出目录常年在软链后面（worktree / npm link / CI 挂载点 / macOS 的 /tmp），
// 字面比较在那类环境里既不执行也不报错，exit 0 而 --out 根本没写 ——
// 对门来说「没跑到」长得跟「跑过并通过」一模一样。
func TestAuditSlotCLIRunsThroughSymlink(t *testing.T) {
	bin := engineBinaryForTest(t)
	root := t.TempDir()
	linkDir := filepath.Join(root, "linked")
	if err := os.Mkdir(linkDir, 0o755); err != nil {
		t.Fatalf("建软链目录失败: %v", err)
	}
	shim := filepath.Join(linkDir, "engine")
	if err := os.Symlink(bin, shim); err != nil {
		t.Fatalf("建软链失败: %v", err)
	}
	// 前提自检：这确实是一条与真身不同的字面路径，且指向同一个文件。
	if shim == bin {
		t.Fatalf("软链路径与真身路径不该相同")
	}
	realShim, err := filepath.EvalSymlinks(shim)
	if err != nil {
		t.Fatalf("解析软链失败: %v", err)
	}
	realBin, err := filepath.EvalSymlinks(bin)
	if err != nil {
		t.Fatalf("解析真身失败: %v", err)
	}
	if realShim != realBin {
		t.Fatalf("软链必须指向同一个文件：%s vs %s", realShim, realBin)
	}

	out := filepath.Join(root, ".audit", "review-a.json")
	command := exec.Command(shim, "audit-slot", "--slot", "review-a", "--executor", "sandbox", "--out", out)
	command.Env = []string{
		"PATH=" + os.Getenv("PATH"),
		"HOME=" + os.Getenv("HOME"),
		"AUDIT_INPUT=" + auditSlotOK(`{"executor":"sandbox","agent":"review-a","model":"m","request_id":"r"}`),
	}
	var stdout, stderr bytes.Buffer
	command.Stdout = &stdout
	command.Stderr = &stderr
	if err := command.Run(); err != nil {
		t.Fatalf("软链路径调用必须成功，得到 %v（stderr=%s）", err, stderr.String())
	}
	if stderr.String() != "" {
		t.Fatalf("成功路径不该有 stderr，得到 %q", stderr.String())
	}
	// 字面路径比较的实现在这里是红的：exit 0 但文件不存在。
	raw, err := os.ReadFile(out)
	if err != nil {
		t.Fatalf("exit 0 却没有写出 --out：这是「没跑到」被记成「跑过」的形态: %v", err)
	}
	record, err := ParseJSON(raw)
	if err != nil {
		t.Fatalf("写出的记录不是合法 JSON: %v", err)
	}
	if verdict, _ := record.Get("verdict").StringValue(); verdict != "pass" {
		t.Fatalf("身份一致的记录应当原样落盘（verdict=pass），得到 %q", verdict)
	}
}
