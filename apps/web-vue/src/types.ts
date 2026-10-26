// 契约是宽松的：字段形状由后端决定，前端只做容错读取与展示。
// 这里不定义「合法/非法状态」，也不做任何状态判定——判定只发生在后端。
export type Loose = Record<string, unknown>;

export interface BoardState {
  name: string;
  terminal: boolean;
  meaning: string;
}

export interface BoardTransition {
  from: string;
  to: string;
  by: string;
  event: string;
  commentRequired: boolean;
  // guards 是这条转换声明的守卫名（如 merge-gate）：原样取，缺省 []，非字符串丢弃。
  // 前端只据此收集证据，够不够由后端判定（E_GUARD_MISSING），这里不做任何守卫判断。
  guards: string[];
  raw: Loose;
}

export interface BoardConfig {
  defaultFlow: string | null;
  labelPrefix: string;
  states: BoardState[];
  transitions: BoardTransition[];
}

export interface PendingAttempt {
  attemptId: string | null;
  from: string | null;
  to: string | null;
  status: string | null;
  requestedAt: string | null;
  attempts: number | null;
}

export interface BoardItem {
  id: string | null;
  title: string;
  body: string;
  // state 就是账本折叠态（后端同时给了 ledgerState 别名，这里保留旧字段给看板列用）。
  state: string | null;
  // current 是远端 label 推出的当前态，null = 未知/无远端。
  current: string | null;
  ledgerState: string | null;
  // divergence 只照抄后端布尔值：前端不比较 current 与 ledgerState 得出它。
  divergence: boolean;
  pending: PendingAttempt | null;
  updatedAt: string | null;
  raw: Loose;
}

export interface PlatformEvent {
  id: string | null;
  at: string | null;
  from: string | null;
  to: string | null;
  by: string | null;
  comment: string | null;
  flow: string | null;
  raw: Loose;
}

export interface ApiFailure {
  kind: string;
  code: string;
  message: string;
  extra: unknown;
  status: number | null;
}

export function emptyConfig(): BoardConfig {
  return { defaultFlow: null, labelPrefix: "", states: [], transitions: [] };
}

export function asLoose(value: unknown): Loose {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Loose;
  }
  return {};
}

export function readString(source: Loose, key: string): string | null {
  const value = source[key];
  return typeof value === "string" ? value : null;
}

export function readFlag(source: Loose, key: string): boolean {
  return source[key] === true;
}

export function readList(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
export interface OutboxTarget {
  repo: string | null;
  issue: number | null;
}

export interface OutboxEntry {
  attemptId: string | null;
  item: string | null;
  from: string | null;
  to: string | null;
  by: string | null;
  label: string | null;
  target: OutboxTarget;
  requestedAt: string | null;
  attempts: number | null;
  status: string | null;
  reason: string | null;
  observedAt: string | null;
  observedLabels: string[];
  raw: Loose;
}

export interface OutboxSnapshot {
  entries: OutboxEntry[];
  // null = 当前零在途请求（后端只在有下一轮巡检时间时给值）。
  nextCheckAt: string | null;
  deadline: string | null;
  writeEnabled: boolean;
  // 重试接口额外回的 attemptId 清单；GET /outbox 时为 []。
  retried: string[];
}

export interface RemoteIssue {
  number: number | null;
  title: string | null;
  state: string | null;
  labels: string[];
  updatedAt: string | null;
}

export interface RemoteSnapshot {
  // present=false 是「还没同步过」，不是「空仓库」。
  present: boolean;
  etag: string | null;
  fetchedAt: string | null;
  repo: string | null;
  issues: RemoteIssue[];
}

export interface ReconcileReport {
  applied: number | null;
  conflict: number | null;
  pending: number | null;
  raw: Loose;
}

export interface SyncReport {
  status: string | null;
  repo: string | null;
  fetchedAt: string | null;
  etag: string | null;
  issues: number | null;
  reconciled: ReconcileReport;
}

export interface IndexRebuildReport {
  ok: boolean;
  schemaVersion: string | null;
  path: string | null;
  items: number | null;
  events: number | null;
  remoteIssues: number | null;
  outbox: number | null;
}

export function emptyOutbox(): OutboxSnapshot {
  return {
    entries: [],
    nextCheckAt: null,
    deadline: null,
    writeEnabled: false,
    retried: [],
  };
}

export function emptyRemote(): RemoteSnapshot {
  return {
    present: false,
    etag: null,
    fetchedAt: null,
    repo: null,
    issues: [],
  };
}

export function readNumber(source: Loose, key: string): number | null {
  const value = source[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function readStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string");
}

// 知识库：列表条目（GET /api/kb 的 items 形状）、列表快照与单篇正文（GET /api/kb/item）。
// 组的先后与组内顺序是后端给的，前端不重排——这里只做原样承载。
export interface KnowledgeEntry {
  path: string;
  title: string;
  sha256: string;
  bytes: number | null;
  group: string;
  raw: Loose;
}

export interface KnowledgeGroup {
  key: string;
  label: string;
  entries: KnowledgeEntry[];
}

export interface KnowledgeIndex {
  entries: KnowledgeEntry[];
  count: number | null;
  builtAt: string | null;
}

export interface KnowledgeDocument {
  path: string;
  sha256: string;
  bytes: number | null;
  text: string;
  raw: Loose;
}
