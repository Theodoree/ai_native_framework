package engine

// auditslot.go —— scripts/audit-slot.mjs 的行为复刻。
//
// 一个执行器不能占两个槽：上游给的是「一份自称是谁的 JSON」，这里知道的是「它在哪个槽」，
// 两者不交叉校验时，同一份 {executor:"github", agent:"review-b"} 填进两个槽就会被记成
// 两个执行器、两票独立结论 —— 双执行器比对的前提当场消失。
//
// 口径与 audit-findings 同源：判不了写 INFRA 记录，绝不写 pass。

import (
	"io"
	"os"
	"path/filepath"
)

// AuditSlots 是槽位的合法枚举。
var AuditSlots = []string{"review-a", "review-b"}

// auditSlotInfra 是「判不了」记录：键序 verdict, findings, evidence{executor, agent}, reason。
func auditSlotInfra(slot, executor, reason string) string {
	return ObjectOf(
		"verdict", String("INFRA"),
		"findings", Array(),
		"evidence", ObjectOf("executor", String(executor), "agent", String(slot)),
		"reason", String(reason),
	).EncodeString()
}

// AuditSlotRecord 复刻 slotRecord：注入为空 / 解析不了 / 自报身份不符，各有各的落法。
func AuditSlotRecord(slot, executor, input string) string {
	raw := jsTrim(input)
	if raw == "" {
		return auditSlotInfra(slot, executor, "上游未注入 findings（"+slot+"）：判不了，不是通过")
	}
	parsed, err := ParseJSON([]byte(raw))
	if err != nil {
		// 解析不了就原样交给口径层：它会把不合格 schema 判 INFRA，并点名哪个字段坏了。
		return raw
	}
	var evidence *Value
	if parsed.IsObject() {
		evidence = parsed.Get("evidence")
	}
	var claimed *Value
	if evidence != nil && (evidence.IsObject() || evidence.IsArray()) {
		claimed = evidence
	}
	matched := false
	if claimed != nil && claimed.IsObject() {
		if name, ok := claimed.Get("executor").StringValue(); ok && name == executor {
			if agent, ok := claimed.Get("agent").StringValue(); ok && agent == slot {
				matched = true
			}
		}
	}
	if !matched {
		shown := "null"
		if claimed != nil {
			shown = claimed.EncodeString()
		}
		return auditSlotInfra(slot, executor, "evidence 自报身份与所在槽位不符：该槽是 "+executor+"/"+slot+"，输入自称 "+shown+"。一个执行器不能占两个槽。")
	}
	return raw
}

// auditSlotArg 复刻 main 里的 arg(name)：argv.indexOf("--name") 的下一个参数；没有就是空。
func auditSlotArg(argv []string, name string) string {
	flag := "--" + name
	for index, argument := range argv {
		if argument != flag {
			continue
		}
		if index+1 >= len(argv) {
			return ""
		}
		return argv[index+1]
	}
	return ""
}

// RunAuditSlot 复刻 audit-slot.mjs 的 main。用法文案与 JS 逐字一致（parity 比的是 stderr 字节）。
func RunAuditSlot(argv []string, stdout, stderr io.Writer) int {
	slot := auditSlotArg(argv, "slot")
	executor := auditSlotArg(argv, "executor")
	out := auditSlotArg(argv, "out")
	if !auditContains(AuditSlots, slot) || executor == "" || out == "" {
		io.WriteString(stderr, "用法: audit-slot.mjs --slot review-a|review-b --executor sandbox|github --out <文件>\n")
		return 1
	}
	body := AuditSlotRecord(slot, executor, os.Getenv("AUDIT_INPUT"))
	directory := filepath.Dir(out)
	if err := os.MkdirAll(directory, 0o777); err != nil {
		io.WriteString(stderr, nodeOpenError(directory, err)+"\n")
		return 1
	}
	if err := os.WriteFile(out, []byte(body), 0o666); err != nil {
		io.WriteString(stderr, nodeOpenError(out, err)+"\n")
		return 1
	}
	return 0
}
