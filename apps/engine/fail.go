package engine

import "errors"

// Fail 是判定器/账本唯一的失败载体：kind 决定退出码（rejected→1，其它→3），
// code 是 E_* 契约，extra 是随 verdict 一起输出的附加字段（键序即输出顺序）。
type Fail struct {
	Kind    string
	Code    string
	Message string
	Extra   *Value
}

func (f *Fail) Error() string { return f.Message }

// Infra 表示「环境/配置/契约本身有问题」，不是业务判定。
func Infra(code, message string, extra *Value) *Fail {
	return &Fail{Kind: "infra", Code: code, Message: message, Extra: extra}
}

// Rejected 表示判定器明确拒绝这次意图。
func Rejected(code, message string, extra *Value) *Fail {
	return &Fail{Kind: "rejected", Code: code, Message: message, Extra: extra}
}

// ExitCode 复刻 JS 的退出码约定：allowed→0，rejected→1，其余（infra）→3。
func ExitCode(verdict string) int {
	switch verdict {
	case "allowed":
		return 0
	case "rejected":
		return 1
	default:
		return 3
	}
}

// AsFail 把任意错误归一成 *Fail（未知错误一律 infra + 给定兜底 code）。
func AsFail(err error, fallbackCode string) *Fail {
	if failure := (*Fail)(nil); errors.As(err, &failure) {
		return failure
	}
	return Infra(fallbackCode, err.Error(), nil)
}
