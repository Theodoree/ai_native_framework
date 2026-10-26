package engine

// 命令行层：参数解析与退出码。
// 参数语义必须与 scripts/state-validate.mjs（validator）和 scripts/ledger-cli.mjs（账本）
// 完全一致：--help 优先、flag 取「第一次出现的下一个参数」、退出码 0/1/3。

import (
	"io"
	"os"
	"strconv"
	"strings"
)

// ValidatorUsage 与 state-validate.mjs 的 USAGE 逐字一致（--help 输出被断言）。
const ValidatorUsage = `用法: state-validate [--config <path>] [--intent <file|->] [--json] [--check-config]

  --config <path>   状态机声明，默认 .agents/platform/state-machine.yml
  --intent <file>   意图 JSON（- 或缺省 = stdin）
  --json            机器可读输出（allowed 带 from/to/by/flow/event/guards）
  --check-config    只校验声明自洽
  --help            打印本用法

guards: 转换声明了 guards 时，意图必须在 guards 里给非空证据 —— 缺一个就拒绝。`

// LedgerUsage 与 ledger-cli.mjs 的用法行逐字一致。
const LedgerUsage = "用法: ledger-cli.mjs fold|events|next-id|append|entry|config [--json]\n"

// ConfigRel 是状态机声明的默认相对位置（与判定器默认值一致）。
const ConfigRel = ".agents/platform/state-machine.yml"

// EngineUsage 是本二进制自己的用法（新入口，没有 JS 对应物）。
const EngineUsage = `用法: engine <子命令> [参数]

  validate     判定一条意图（--intent <file|-> [--json] [--config <path>]）
  check-config 只校验声明自洽（[--config <path>] [--json]）
  consult      只读咨询：不评估 guards、不产出可落账本的结论（--intent <file|->）
  ledger       账本子命令（fold|events|next-id|append|entry|config [--json]）
  build-intent 宿主事件 → 状态机意图（[--resolve-issue]）
  last-change  门牌幂等重算（[--in <file>] [--out <file>]）
  writer-record 判定结果 → 留痕（[--verdict <file>] [--issue <n>]）

退出码：0 允许 / 0 成功 · 1 拒绝 · 2 用法错 · 3 INFRA`

// Run 是单二进制的多子命令入口。
func Run(argv []string, stdin io.Reader, stdout, stderr io.Writer, root string) int {
	if len(argv) == 0 {
		io.WriteString(stderr, EngineUsage+"\n")
		return 2
	}
	command := argv[0]
	rest := argv[1:]
	switch command {
	case "--help", "-h", "help":
		io.WriteString(stdout, EngineUsage+"\n")
		return 0
	case "validate":
		return RunValidator(rest, stdin, stdout)
	case "check-config":
		return RunValidator(append(append([]string{}, rest...), "--check-config"), stdin, stdout)
	case "consult":
		return RunConsult(rest, stdin, stdout)
	case "ledger":
		return RunLedger(rest, stdin, stdout, stderr, root)
	case "build-intent":
		return RunBuildIntent(rest, stdout, stderr)
	case "last-change":
		return RunLastChange(rest, stdout, stderr, root)
	case "writer-record":
		return RunWriterRecord(rest, stdout, stderr)
	default:
		io.WriteString(stderr, EngineUsage+"\n")
		return 2
	}
}

// RunValidator 复刻 state-validate.mjs 的 main。
func RunValidator(argv []string, stdin io.Reader, stdout io.Writer) int {
	if hasArg(argv, "--help") || hasArg(argv, "-h") {
		io.WriteString(stdout, ValidatorUsage+"\n")
		return 0
	}
	// 与 JS 一致：--config 后面没有值就是 undefined（消息里显示 "undefined"，JSON 里该键被丢弃）。
	configPath := Undefined()
	if value, ok := argAfter(argv, "--config"); ok {
		configPath = String(value)
	} else if !hasArg(argv, "--config") {
		configPath = String(ConfigRel)
	}
	emitter := cliEmitter{asJSON: hasArg(argv, "--json"), out: stdout}

	cfg, fail := LoadConfig(jsDisplay(configPath))
	if fail != nil {
		return emitter.emit("infra", fail.Code, fail.Message, ObjectOf("path", configPath))
	}
	if hasArg(argv, "--check-config") {
		return emitter.emit(
			"allowed",
			"OK_CONFIG",
			"配置自洽: "+strconv.Itoa(cfg.StateCount())+" 个状态 / "+strconv.Itoa(cfg.TransitionCount())+" 条转换",
			nil,
		)
	}
	intent, fail := readIntent(argv, stdin)
	if fail != nil {
		return emitter.emit(fail.Kind, fail.Code, fail.Message, fail.Extra)
	}
	result, fail := cfg.ValidateIntent(intent)
	if fail != nil {
		return emitter.emit(fail.Kind, fail.Code, fail.Message, fail.Extra)
	}
	from, _ := result.Get("from").StringValue()
	to, _ := result.Get("to").StringValue()
	by, _ := result.Get("by").StringValue()
	return emitter.emit("allowed", "OK", "允许 "+from+" → "+to+"（"+by+"）", result)
}

// RunConsult 是只读咨询入口：成功时输出 consult 对象，失败时输出与 validator 同形的错误信封。
func RunConsult(argv []string, stdin io.Reader, stdout io.Writer) int {
	configPath := ConfigRel
	if value, ok := argAfter(argv, "--config"); ok {
		configPath = value
	}
	cfg, fail := LoadConfig(configPath)
	if fail != nil {
		return writeConsult(stdout, nil, fail)
	}
	intent, fail := readIntent(argv, stdin)
	if fail != nil {
		return writeConsult(stdout, nil, fail)
	}
	result, fail := cfg.ConsultTransition(intent)
	if fail != nil {
		return writeConsult(stdout, nil, fail)
	}
	return writeConsult(stdout, result, nil)
}

func writeConsult(stdout io.Writer, result *Value, fail *Fail) int {
	payload := Object()
	if fail == nil {
		payload.Set("consult", result.Get("consult"))
		for _, key := range result.Keys() {
			if key == "consult" {
				continue
			}
			payload.Set(key, result.Get(key))
		}
		stdout.Write(append(payload.Encode(), '\n'))
		return 0
	}
	payload.Set("consult", Bool(false))
	payload.Set("kind", String(fail.Kind))
	payload.Set("code", String(fail.Code))
	payload.Set("message", String(fail.Message))
	if fail.Extra != nil && fail.Extra.IsObject() {
		payload.Set("extra", fail.Extra)
	} else {
		payload.Set("extra", Object())
	}
	stdout.Write(append(payload.Encode(), '\n'))
	return ExitCode(fail.Kind)
}

// readIntent 读取并解析意图：--intent <file> 或 stdin。
func readIntent(argv []string, stdin io.Reader) (*Value, *Fail) {
	intentPath := ""
	if value, ok := argAfter(argv, "--intent"); ok {
		intentPath = value
	}
	var raw []byte
	var err error
	if intentPath != "" && intentPath != "-" {
		raw, err = os.ReadFile(intentPath)
	} else {
		raw, err = io.ReadAll(stdin)
	}
	if err != nil {
		return nil, Infra("E_INTENT_MISSING", "读不到意图输入（--intent <file> 或 stdin）", nil)
	}
	if strings.TrimSpace(string(raw)) == "" {
		return nil, Infra("E_INTENT_EMPTY", "意图输入为空", nil)
	}
	intent, parseErr := ParseJSON(raw)
	if parseErr != nil {
		return nil, Infra("E_INTENT_UNPARSABLE", "意图不是合法 JSON: "+parseErr.Error(), nil)
	}
	return intent, nil
}

// RunLedger 复刻 ledger-cli.mjs 的 main。
func RunLedger(argv []string, stdin io.Reader, stdout, stderr io.Writer, root string) int {
	command := ""
	for _, argument := range argv {
		if !strings.HasPrefix(argument, "--") {
			command = argument
			break
		}
	}
	ledgerPath := LedgerPath(root)
	var payload *Value
	var err error
	switch command {
	case "fold":
		payload, err = ledgerAction(ledgerPath, func(events *Value) (*Value, error) {
			return Fold(events), nil
		})
	case "events":
		payload, err = ledgerAction(ledgerPath, func(events *Value) (*Value, error) {
			return events, nil
		})
	case "next-id":
		payload, err = ledgerAction(ledgerPath, func(events *Value) (*Value, error) {
			return ObjectOf("id", String(NextID(events))), nil
		})
	case "append":
		payload, err = appendFromStdin(ledgerPath, stdin)
	case "entry":
		payload, err = ledgerAction(ledgerPath, func(events *Value) (*Value, error) {
			cfg, fail := LoadConfigAt(root, ConfigRel)
			if fail != nil {
				return nil, fail
			}
			picked, fail := cfg.ResolveEntry(nil)
			if fail != nil {
				return nil, fail
			}
			return ObjectOf("to", picked.Get("to"), "by", picked.Get("by")), nil
		})
	case "config":
		payload, err = ledgerAction(ledgerPath, func(events *Value) (*Value, error) {
			cfg, fail := LoadConfigAt(root, ConfigRel)
			if fail != nil {
				return nil, fail
			}
			return cfg.View(), nil
		})
	default:
		io.WriteString(stderr, LedgerUsage)
		return 3
	}
	if err != nil {
		io.WriteString(stderr, ledgerFailure(err).EncodeString()+"\n")
		return 3
	}
	stdout.Write(append(payload.Encode(), '\n'))
	return 0
}

func ledgerAction(ledgerPath string, action func(events *Value) (*Value, error)) (*Value, error) {
	events, err := ReadEvents(ledgerPath)
	if err != nil {
		return nil, err
	}
	return action(events)
}

func appendFromStdin(ledgerPath string, stdin io.Reader) (*Value, error) {
	raw, err := io.ReadAll(stdin)
	if err != nil {
		return nil, Infra("E_STDIN_UNREADABLE", "读不到 stdin: "+err.Error(), nil)
	}
	if strings.TrimSpace(string(raw)) == "" {
		return nil, Infra("E_STDIN_EMPTY", "stdin 为空：需要一个事件对象", nil)
	}
	event, parseErr := ParseJSON(raw)
	if parseErr != nil {
		return nil, Infra("E_EVENT_UNPARSABLE", "stdin 不是合法 JSON: "+parseErr.Error(), nil)
	}
	if !event.IsObject() {
		return nil, Infra("E_EVENT_SHAPE", "stdin 不是事件对象", nil)
	}
	return AppendEvent(ledgerPath, event)
}

// ledgerFailure 把任意错误摆成 ledger-cli 的 stderr 形状 {kind,code,message,extra}。
func ledgerFailure(err error) *Value {
	fail := AsFail(err, "E_CLI_FAILED")
	extra := Object()
	if fail.Extra != nil && fail.Extra.IsObject() {
		extra = fail.Extra
	}
	return ObjectOf(
		"kind", String(fail.Kind),
		"code", String(fail.Code),
		"message", String(fail.Message),
		"extra", extra,
	)
}

type cliEmitter struct {
	asJSON bool
	out    io.Writer
}

func (e cliEmitter) emit(verdict, code, message string, extra *Value) int {
	if e.asJSON {
		payload := ObjectOf("verdict", String(verdict), "code", String(code), "message", String(message))
		if extra != nil && extra.IsObject() {
			for _, key := range extra.Keys() {
				payload.Set(key, extra.Get(key))
			}
		}
		e.out.Write(append(payload.Encode(), '\n'))
	} else {
		io.WriteString(e.out, strings.ToUpper(verdict)+" "+code+" "+message+"\n")
	}
	return ExitCode(verdict)
}

func hasArg(argv []string, name string) bool {
	for _, argument := range argv {
		if argument == name {
			return true
		}
	}
	return false
}

// argAfter 复刻 JS 的 flag(name)：取第一次出现的下一个参数；没有下一个参数就是「没有值」。
func argAfter(argv []string, name string) (string, bool) {
	for index, argument := range argv {
		if argument != name {
			continue
		}
		if index+1 >= len(argv) {
			return "", false
		}
		return argv[index+1], true
	}
	return "", false
}
