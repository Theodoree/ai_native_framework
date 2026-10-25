// 所有请求都汇到这里：绝不抛异常，失败统一折成 ApiFailure，
// kind / code / message / extra 原样保留，交给界面照抄，不做翻译与改写。
import { asLoose, readString, type ApiFailure } from "../types";

export type ApiResult<T> = { ok: true; data: T } | { ok: false; failure: ApiFailure };

const BASE = "/api";

export interface VerdictInput {
  id: string;
  to: string;
  actor_role: string;
  comment: string;
}

function failureOf(status: number | null, payload: unknown, fallback: string): ApiFailure {
  const loose = asLoose(payload);
  return {
    kind: readString(loose, "kind") ?? (status === 409 ? "rejected" : "infra"),
    code: readString(loose, "code") ?? "E_UNKNOWN",
    message: readString(loose, "message") ?? fallback,
    extra: loose["extra"] === undefined ? null : loose["extra"],
    status,
  };
}

export async function request<T>(method: string, path: string, payload?: unknown): Promise<ApiResult<T>> {
  let response: Response;
  try {
    response = await fetch(BASE + path, {
      method,
      headers: payload === undefined ? {} : { "content-type": "application/json" },
      body: payload === undefined ? undefined : JSON.stringify(payload),
    });
  } catch (error) {
    return {
      ok: false,
      failure: {
        kind: "infra",
        code: "E_NETWORK",
        message: error instanceof Error ? error.message : "请求失败",
        extra: null,
        status: null,
      },
    };
  }

  const text = await response.text();
  let parsed: unknown = null;
  let isJson = false;
  if (text.trim() !== "") {
    try {
      parsed = JSON.parse(text) as unknown;
      isJson = true;
    } catch {
      parsed = null;
    }
  }

  if (!response.ok) {
    return {
      ok: false,
      failure: failureOf(response.status, parsed, "HTTP " + String(response.status)),
    };
  }
  if (!isJson && text.trim() !== "") {
    return {
      ok: false,
      failure: {
        kind: "infra",
        code: "E_NOT_JSON",
        message: "响应不是合法 JSON",
        extra: text.slice(0, 500),
        status: response.status,
      },
    };
  }
  return { ok: true, data: parsed as T };
}

export function getBoard(): Promise<ApiResult<unknown>> {
  return request<unknown>("GET", "/board");
}

export function getEvents(): Promise<ApiResult<unknown>> {
  return request<unknown>("GET", "/events");
}

export function getConfig(): Promise<ApiResult<unknown>> {
  return request<unknown>("GET", "/config");
}

export function putConfig(text: string): Promise<ApiResult<unknown>> {
  return request<unknown>("PUT", "/config", { text });
}

export function postItem(title: string, body: string): Promise<ApiResult<unknown>> {
  return request<unknown>("POST", "/item", { title, body });
}

export function postVerdict(input: VerdictInput): Promise<ApiResult<unknown>> {
  return request<unknown>("POST", "/verdict", {
    id: input.id,
    to: input.to,
    actor_role: input.actor_role,
    comment: input.comment,
  });
}

export function postVerify(): Promise<ApiResult<unknown>> {
  return request<unknown>("POST", "/verify", {});
}
