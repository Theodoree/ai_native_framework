// 把「后端给什么就收什么」的 JSON 折成可直接渲染的模型：缺字段给占位，绝不抛异常。
import {
  asLoose,
  readFlag,
  readList,
  readNumber,
  readString,
  readStringList,
  type BoardConfig,
  type BoardItem,
  type BoardState,
  type BoardTransition,
  type IndexRebuildReport,
  type OutboxEntry,
  type OutboxSnapshot,
  type OutboxTarget,
  type PendingAttempt,
  type PlatformEvent,
  type ReconcileReport,
  type RemoteIssue,
  type RemoteSnapshot,
  type SyncReport,
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

function normalizePending(raw: unknown): PendingAttempt | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const loose = asLoose(raw);
  return {
    attemptId: readString(loose, "attemptId"),
    from: readString(loose, "from"),
    to: readString(loose, "to"),
    status: readString(loose, "status"),
    requestedAt: readString(loose, "requestedAt"),
    attempts: readNumber(loose, "attempts"),
  };
}

function normalizeItem(raw: unknown): BoardItem {
  const loose = asLoose(raw);
  // 状态字段可能叫 state，也可能只有 to：两种都认，都缺就按「还没有状态」显示。
  const state = readString(loose, "state") ?? readString(loose, "to");
  return {
    id: readString(loose, "id"),
    title: readString(loose, "title") ?? "(未命名)",
    body: readString(loose, "body") ?? "",
    state,
    // current 缺失与「远端说 null」在界面上是同一件事：未知/无远端。
    current: readString(loose, "current"),
    ledgerState: readString(loose, "ledgerState") ?? state,
    // 只信后端给的布尔值，不在前端拿 current 与 ledgerState 相比。
    divergence: readFlag(loose, "divergence"),
    pending: normalizePending(loose["pending"]),
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
function normalizeTarget(raw: unknown): OutboxTarget {
  const loose = asLoose(raw);
  return { repo: readString(loose, "repo"), issue: readNumber(loose, "issue") };
}

function normalizeOutboxEntry(raw: unknown): OutboxEntry {
  const loose = asLoose(raw);
  return {
    attemptId: readString(loose, "attemptId"),
    item: readString(loose, "item"),
    from: readString(loose, "from"),
    to: readString(loose, "to"),
    by: readString(loose, "by"),
    label: readString(loose, "label"),
    target: normalizeTarget(loose["target"]),
    requestedAt: readString(loose, "requestedAt"),
    attempts: readNumber(loose, "attempts"),
    status: readString(loose, "status"),
    reason: readString(loose, "reason"),
    observedAt: readString(loose, "observedAt"),
    observedLabels: readStringList(loose["observedLabels"]),
    raw: loose,
  };
}

export function parseOutbox(payload: unknown): OutboxSnapshot {
  const loose = asLoose(payload);
  return {
    entries: readList(loose["entries"]).map(normalizeOutboxEntry),
    nextCheckAt: readString(loose, "nextCheckAt"),
    deadline: readString(loose, "deadline"),
    writeEnabled: readFlag(loose, "writeEnabled"),
    retried: readStringList(loose["retried"]),
  };
}

function normalizeRemoteIssue(raw: unknown): RemoteIssue {
  const loose = asLoose(raw);
  return {
    number: readNumber(loose, "number"),
    title: readString(loose, "title"),
    state: readString(loose, "state"),
    labels: readStringList(loose["labels"]),
    updatedAt: readString(loose, "updated_at") ?? readString(loose, "updatedAt"),
  };
}

export function parseRemote(payload: unknown): RemoteSnapshot {
  const loose = asLoose(payload);
  return {
    present: readFlag(loose, "present"),
    etag: readString(loose, "etag"),
    fetchedAt: readString(loose, "fetchedAt"),
    repo: readString(loose, "repo"),
    issues: readList(loose["issues"]).map(normalizeRemoteIssue),
  };
}

function normalizeReconciled(raw: unknown): ReconcileReport {
  const loose = asLoose(raw);
  return {
    applied: readNumber(loose, "applied"),
    conflict: readNumber(loose, "conflict"),
    pending: readNumber(loose, "pending"),
    raw: loose,
  };
}

export function parseSyncReport(payload: unknown): SyncReport {
  const loose = asLoose(payload);
  return {
    status: readString(loose, "status"),
    repo: readString(loose, "repo"),
    fetchedAt: readString(loose, "fetchedAt"),
    etag: readString(loose, "etag"),
    issues: readNumber(loose, "issues"),
    reconciled: normalizeReconciled(loose["reconciled"]),
  };
}

export function parseIndexRebuild(payload: unknown): IndexRebuildReport {
  const loose = asLoose(payload);
  return {
    ok: readFlag(loose, "ok"),
    schemaVersion: readString(loose, "schemaVersion"),
    path: readString(loose, "path"),
    items: readNumber(loose, "items"),
    events: readNumber(loose, "events"),
    remoteIssues: readNumber(loose, "remoteIssues"),
    outbox: readNumber(loose, "outbox"),
  };
}
