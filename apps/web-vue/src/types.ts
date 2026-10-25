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
  raw: Loose;
}

export interface BoardConfig {
  defaultFlow: string | null;
  labelPrefix: string;
  states: BoardState[];
  transitions: BoardTransition[];
}

export interface BoardItem {
  id: string | null;
  title: string;
  body: string;
  state: string | null;
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
