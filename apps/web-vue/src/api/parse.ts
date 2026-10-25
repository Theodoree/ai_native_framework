// 把「后端给什么就收什么」的 JSON 折成可直接渲染的模型：缺字段给占位，绝不抛异常。
import {
  asLoose,
  readFlag,
  readList,
  readString,
  type BoardConfig,
  type BoardItem,
  type BoardState,
  type BoardTransition,
  type PlatformEvent,
} from "../types";

export interface BoardSnapshot {
  items: BoardItem[];
  config: BoardConfig;
}

export interface VerifySnapshot {
  exitCode: number | null;
  output: string;
}

function normalizeState(raw: unknown, index: number): BoardState {
  const loose = asLoose(raw);
  return {
    name: readString(loose, "name") ?? "state-" + String(index + 1),
    terminal: readFlag(loose, "terminal"),
    meaning: readString(loose, "meaning") ?? "",
  };
}

function normalizeTransition(raw: unknown): BoardTransition {
  const loose = asLoose(raw);
  return {
    from: readString(loose, "from") ?? "*",
    to: readString(loose, "to") ?? "",
    by: readString(loose, "by") ?? "",
    event: readString(loose, "event") ?? "",
    commentRequired: readFlag(loose, "comment_required") || readFlag(loose, "commentRequired"),
    raw: loose,
  };
}

function normalizeConfig(raw: unknown): BoardConfig {
  const loose = asLoose(raw);
  return {
    defaultFlow: readString(loose, "defaultFlow"),
    labelPrefix: readString(loose, "labelPrefix") ?? "",
    states: readList(loose["states"]).map(normalizeState),
    transitions: readList(loose["transitions"]).map(normalizeTransition),
  };
}

function normalizeItem(raw: unknown): BoardItem {
  const loose = asLoose(raw);
  return {
    id: readString(loose, "id"),
    title: readString(loose, "title") ?? "(未命名)",
    body: readString(loose, "body") ?? "",
    // 状态字段可能叫 state，也可能只有 to：两种都认，都缺就按「还没有状态」显示。
    state: readString(loose, "state") ?? readString(loose, "to"),
    updatedAt: readString(loose, "updatedAt") ?? readString(loose, "at"),
    raw: loose,
  };
}

function normalizeEvent(raw: unknown): PlatformEvent {
  const loose = asLoose(raw);
  return {
    id: readString(loose, "id"),
    at: readString(loose, "at"),
    from: readString(loose, "from"),
    to: readString(loose, "to"),
    by: readString(loose, "by"),
    comment: readString(loose, "comment"),
    flow: readString(loose, "flow"),
    raw: loose,
  };
}

export function parseBoard(payload: unknown): BoardSnapshot {
  if (Array.isArray(payload)) {
    return { items: payload.map(normalizeItem), config: normalizeConfig(null) };
  }
  const loose = asLoose(payload);
  return {
    items: readList(loose["items"]).map(normalizeItem),
    config: normalizeConfig(loose["config"]),
  };
}

export function parseEvents(payload: unknown): PlatformEvent[] {
  const source = Array.isArray(payload) ? payload : readList(asLoose(payload)["events"]);
  return source.map(normalizeEvent);
}

export function parseEvent(payload: unknown): PlatformEvent {
  return normalizeEvent(payload);
}

export function parseConfigText(payload: unknown): string {
  return readString(asLoose(payload), "text") ?? "";
}

export function parseVerify(payload: unknown): VerifySnapshot {
  const loose = asLoose(payload);
  const rawExit = loose["exitCode"];
  return {
    exitCode: typeof rawExit === "number" && Number.isFinite(rawExit) ? rawExit : null,
    output: readString(loose, "output") ?? "",
  };
}
