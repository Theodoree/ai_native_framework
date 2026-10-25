// 唯一的状态家：所有视图从这里读，所有写操作也从这里发。
// 前端不做任何状态合法性判断：目标状态只从声明的 transitions 里取候选，
// 提交后是否有结果、被拒绝的原因，一律照抄后端返回。
import { computed, reactive } from "vue";
import {
  getBoard,
  getConfig,
  getEvents,
  postItem,
  postVerify,
  postVerdict,
  putConfig,
} from "../api/client";
import { parseBoard, parseConfigText, parseEvent, parseEvents, parseVerify } from "../api/parse";
import {
  emptyConfig,
  type ApiFailure,
  type BoardConfig,
  type BoardItem,
  type BoardTransition,
  type PlatformEvent,
} from "../types";

export interface BoardColumn {
  key: string;
  label: string;
  terminal: boolean;
  meaning: string;
  items: BoardItem[];
}

interface VerdictPanelState {
  pending: boolean;
  failure: ApiFailure | null;
  ok: string | null;
}

interface VerifyPanelState {
  running: boolean;
  ranAt: string | null;
  exitCode: number | null;
  output: string;
  failure: ApiFailure | null;
}

interface PlatformState {
  items: BoardItem[];
  config: BoardConfig;
  boardLoading: boolean;
  boardFailure: ApiFailure | null;
  events: PlatformEvent[];
  eventsLoading: boolean;
  eventsFailure: ApiFailure | null;
  selectedId: string | null;
  configText: string;
  configLoading: boolean;
  configFailure: ApiFailure | null;
  configSaving: boolean;
  configSaveFailure: ApiFailure | null;
  configSaveOk: string | null;
  createPending: boolean;
  createFailure: ApiFailure | null;
  createOk: string | null;
  verdict: VerdictPanelState;
  verify: VerifyPanelState;
}

const state = reactive<PlatformState>({
  items: [],
  config: emptyConfig(),
  boardLoading: false,
  boardFailure: null,
  events: [],
  eventsLoading: false,
  eventsFailure: null,
  selectedId: null,
  configText: "",
  configLoading: false,
  configFailure: null,
  configSaving: false,
  configSaveFailure: null,
  configSaveOk: null,
  createPending: false,
  createFailure: null,
  createOk: null,
  verdict: { pending: false, failure: null, ok: null },
  verify: { running: false, ranAt: null, exitCode: null, output: "", failure: null },
});

const selectedItem = computed<BoardItem | null>(() => {
  const id = state.selectedId;
  if (id === null) return null;
  return state.items.find((item) => item.id === id) ?? null;
});

// 列的来源是 config.states 的顺序；items 只按「状态值相等」落列。
// 状态为 null 或不在声明里的项，落到末尾一列，不猜它是哪个状态。
const columns = computed<BoardColumn[]>(() => {
  const declared = state.config.states;
  const names = new Set(declared.map((entry) => entry.name));
  const result: BoardColumn[] = declared.map((entry) => ({
    key: entry.name,
    label: entry.name,
    terminal: entry.terminal,
    meaning: entry.meaning,
    items: state.items.filter((item) => item.state === entry.name),
  }));
  const orphans = state.items.filter((item) => item.state === null || !names.has(item.state));
  if (orphans.length > 0) {
    result.push({
      key: "__orphan__",
      label: "未归属（none / 声明外状态）",
      terminal: false,
      meaning: "折叠结果里没有可对应的声明状态",
      items: orphans,
    });
  }
  return result;
});

// 与当前状态相关的转换（含通配 *）。这里只是把声明读出来给选择框用。
function transitionsFor(currentState: string | null): BoardTransition[] {
  const key = currentState === null ? "none" : currentState;
  return state.config.transitions.filter(
    (transition) => transition.from === key || transition.from === "*",
  );
}

const roles = computed<string[]>(() => {
  const list: string[] = [];
  for (const transition of state.config.transitions) {
    if (transition.by !== "" && !list.includes(transition.by)) list.push(transition.by);
  }
  if (list.length === 0) list.push("owner");
  return list;
});

async function reloadBoard(): Promise<void> {
  state.boardLoading = true;
  const result = await getBoard();
  if (result.ok) {
    const snapshot = parseBoard(result.data);
    state.items = snapshot.items;
    state.config = snapshot.config;
    state.boardFailure = null;
  } else {
    state.boardFailure = result.failure;
  }
  state.boardLoading = false;
}

async function reloadEvents(): Promise<void> {
  state.eventsLoading = true;
  const result = await getEvents();
  if (result.ok) {
    state.events = parseEvents(result.data);
    state.eventsFailure = null;
  } else {
    state.eventsFailure = result.failure;
  }
  state.eventsLoading = false;
}

async function reloadConfig(): Promise<void> {
  state.configLoading = true;
  const result = await getConfig();
  if (result.ok) {
    state.configText = parseConfigText(result.data);
    state.configFailure = null;
  } else {
    state.configFailure = result.failure;
  }
  state.configLoading = false;
}

async function reloadAll(): Promise<void> {
  await Promise.all([reloadBoard(), reloadEvents(), reloadConfig()]);
}

function selectItem(id: string | null): void {
  state.selectedId = id;
  state.verdict.failure = null;
  state.verdict.ok = null;
}

// 不在前端拦空标题：交给后端判定，409 原样呈现。
async function createItem(title: string, body: string): Promise<boolean> {
  state.createPending = true;
  state.createFailure = null;
  state.createOk = null;
  const result = await postItem(title, body);
  state.createPending = false;
  if (!result.ok) {
    state.createFailure = result.failure;
    return false;
  }
  const event = parseEvent(result.data);
  state.createOk =
    (event.id ?? "(无 id)") + " 已落 " + (event.to ?? "(无 to)") + "（by " + (event.by ?? "?") + "）";
  await Promise.all([reloadBoard(), reloadEvents()]);
  return true;
}

async function submitVerdict(input: {
  id: string;
  to: string;
  actorRole: string;
  comment: string;
}): Promise<boolean> {
  state.verdict.pending = true;
  state.verdict.failure = null;
  state.verdict.ok = null;
  const result = await postVerdict({
    id: input.id,
    to: input.to,
    actor_role: input.actorRole,
    comment: input.comment,
  });
  state.verdict.pending = false;
  if (!result.ok) {
    // 409 的 code / message / extra 原样留在面板上，不吞、不翻译、不改写。
    state.verdict.failure = result.failure;
    return false;
  }
  const event = parseEvent(result.data);
  state.verdict.ok =
    (event.from ?? "?") + " → " + (event.to ?? "?") + "（by " + (event.by ?? "?") + "）";
  await Promise.all([reloadBoard(), reloadEvents()]);
  return true;
}

// 保存声明 = 交给后端自检；前端不解析 YAML、不判断合法性。
async function saveConfig(text: string): Promise<boolean> {
  state.configSaving = true;
  state.configSaveFailure = null;
  state.configSaveOk = null;
  const result = await putConfig(text);
  state.configSaving = false;
  if (!result.ok) {
    state.configSaveFailure = result.failure;
    return false;
  }
  state.configSaveOk = "已保存（后端已接受这份声明）";
  await Promise.all([reloadConfig(), reloadBoard()]);
  return true;
}

async function runVerify(): Promise<void> {
  state.verify.running = true;
  state.verify.failure = null;
  state.verify.ranAt = null;
  const result = await postVerify();
  state.verify.running = false;
  if (!result.ok) {
    state.verify.failure = result.failure;
    return;
  }
  const snapshot = parseVerify(result.data);
  state.verify.exitCode = snapshot.exitCode;
  state.verify.output = snapshot.output;
  state.verify.ranAt = new Date().toISOString();
}

export function usePlatform() {
  return {
    state,
    selectedItem,
    columns,
    roles,
    transitionsFor,
    reloadBoard,
    reloadEvents,
    reloadConfig,
    reloadAll,
    selectItem,
    createItem,
    submitVerdict,
    saveConfig,
    runVerify,
  };
}
