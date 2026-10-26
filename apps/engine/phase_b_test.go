package engine

import (
	"fmt"
	"math"
	"strings"
	"testing"
)

func TestResolveIssueRefs(t *testing.T) {
	cases := []struct {
		text string
		want []float64
	}{
		{"Fixes #12", []float64{12}},
		{"fixes: #12 and closes #7", []float64{12, 7}},
		{"Closes #3, closed #3, resolve #4", []float64{3, 4}},
		{"no reference here", nil},
		{"", nil},
		{"issue #5 without a verb", nil},
		{"fix #5 fix #5 fix #5", []float64{5}},
	}
	for _, c := range cases {
		got := ResolveIssueRefs(c.text)
		if fmt.Sprint(got) != fmt.Sprint(c.want) {
			t.Fatalf("ResolveIssueRefs(%q) = %v, want %v", c.text, got, c.want)
		}
	}
}

func TestMergeDate(t *testing.T) {
	ok := map[string]string{
		"2024-05-06T10:00:00Z": "2024-05-06",
		"2024-05-06 10:00:00":  "2024-05-06",
		"  2024-05-06  ":       "2024-05-06",
		"2024-05-06":           "2024-05-06",
	}
	for input, want := range ok {
		got, err := MergeDate(String(input))
		if err != nil {
			t.Fatalf("MergeDate(%q) 意外报错: %v", input, err)
		}
		if got != want {
			t.Fatalf("MergeDate(%q) = %q, want %q", input, got, want)
		}
	}
	for _, input := range []string{"2024-5-6", "May 6 2024", "", "2024-05-06x"} {
		if _, err := MergeDate(String(input)); err == nil {
			t.Fatalf("MergeDate(%q) 应报错", input)
		}
	}
}

func TestLastChangeWidthAndCell(t *testing.T) {
	widths := map[string]int{
		"abc":  3,
		"中文":   4,
		"—":    1,
		"":     0,
		"a中b":  4,
		"ｆｕｌｌ": 8,
	}
	for text, want := range widths {
		if got := LastChangeWidth(text); got != want {
			t.Fatalf("LastChangeWidth(%q) = %d, want %d", text, got, want)
		}
	}
	cells := map[string]string{
		"a\nb":     "a b",
		"a \r\n b": "a b",
		"a|b":      "a\\|b",
		"  x  ":    "x",
	}
	for input, want := range cells {
		if got := LastChangeCell(input); got != want {
			t.Fatalf("LastChangeCell(%q) = %q, want %q", input, got, want)
		}
	}
}

func TestReplaceLastChangeSection(t *testing.T) {
	section := LastChangeBlockBegin + "\n新\n" + LastChangeBlockEnd

	blocked := "前言\n\n" + LastChangeBlockBegin + "\n旧\n" + LastChangeBlockEnd + "\n\n## 其它\n尾\n"
	got := ReplaceLastChangeSection(blocked, section)
	want := "前言\n\n" + section + "\n\n## 其它\n尾\n"
	if got != want {
		t.Fatalf("覆盖已有区间:\n got %q\nwant %q", got, want)
	}

	heading := "前言\n\n## LAST-CHANGE\n手写\n\n## 其它\n尾\n"
	got = ReplaceLastChangeSection(heading, section)
	want = "前言\n\n" + section + "\n\n## 其它\n尾\n"
	if got != want {
		t.Fatalf("标题分支:\n got %q\nwant %q", got, want)
	}

	plain := "没有任何小节  \n\n"
	got = ReplaceLastChangeSection(plain, section)
	want = "没有任何小节\n\n" + section + "\n"
	if got != want {
		t.Fatalf("追加分支:\n got %q\nwant %q", got, want)
	}
}

func TestRecordBodyAndExitCode(t *testing.T) {
	allowed := ObjectOf("verdict", String("allowed"), "code", String("OK"), "message", String("允许"))
	if body, err := RecordBody(allowed); err != nil || body != nil {
		t.Fatalf("allowed 不该留痕: body=%v err=%v", body, err)
	}
	if code := RecordExitCode(allowed); code != 0 {
		t.Fatalf("allowed 退出码 = %d, want 0", code)
	}
	for _, kind := range []string{"rejected", "infra"} {
		verdict := ObjectOf("verdict", String(kind), "code", String("E_X"), "message", String("原因"))
		body, err := RecordBody(verdict)
		if err != nil {
			t.Fatalf("%s 意外报错: %v", kind, err)
		}
		want := "状态未被修改：" + strings.ToUpper(kind) + " E_X — 原因"
		if body == nil || *body != want {
			t.Fatalf("%s 留痕正文 = %v, want %q", kind, body, want)
		}
	}
	if code := RecordExitCode(ObjectOf("verdict", String("infra"))); code != 1 {
		t.Fatalf("infra 退出码 = %d, want 1", code)
	}
	if _, err := RecordBody(ObjectOf("verdict", String("weird"))); err == nil {
		t.Fatal("未知判定结果应报错")
	}
}

func TestJSNumberMatchesNumberSemantics(t *testing.T) {
	cases := []struct {
		value *Value
		want  float64
	}{
		{Null(), 0},
		{Bool(true), 1},
		{String(" 12 "), 12},
		{String(""), 0},
		{Array(), 0},
		{Array(Number(7)), 7},
		{String("0x10"), 16},
		{String("Infinity"), math.Inf(1)},
		{Undefined(), math.NaN()},
		{String("abc"), math.NaN()},
		{String("1 2"), math.NaN()},
	}
	for _, c := range cases {
		got := jsNumber(c.value)
		if math.IsNaN(c.want) {
			if !math.IsNaN(got) {
				t.Fatalf("jsNumber(%s) = %v, want NaN", c.value.EncodeString(), got)
			}
			continue
		}
		if got != c.want {
			t.Fatalf("jsNumber(%s) = %v, want %v", c.value.EncodeString(), got, c.want)
		}
	}
	if got := jsJSON(Number(math.NaN())); got != "null" {
		t.Fatalf("jsJSON(NaN) = %q, want null", got)
	}
	if got := jsJSON(Undefined()); got != "undefined" {
		t.Fatalf("jsJSON(undefined) = %q", got)
	}
}
