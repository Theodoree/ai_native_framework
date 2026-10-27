import type {
  NewProjectInput,
  NewRequirementInput,
  NodeAction,
  Project,
  Requirement,
  RequirementDetail,
} from './types'

/** 同源访问：生产由 Go 直接提供静态与 API，开发由 vite proxy 转发。 */
const API_ROOT = '/api'

export class ApiError extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers: Record<string, string> = {
    Accept: 'application/json',
  }
  if (init?.body) {
    headers['Content-Type'] = 'application/json'
  }
  let res: Response
  try {
    res = await fetch(API_ROOT + path, { ...init, headers })
  } catch {
    throw new ApiError(0, '连不上服务：请确认链条平台后端已启动（开发时先跑 Go 服务再开 dev server）')
  }
  const raw = await res.text()
  let data: unknown = null
  if (raw.length > 0) {
    try {
      data = JSON.parse(raw)
    } catch {
      data = raw
    }
  }
  if (!res.ok) {
    const fallback = `请求失败（HTTP ${res.status}）`
    if (data && typeof data === 'object' && 'error' in data) {
      const msg = (data as { error?: unknown }).error
      throw new ApiError(res.status, typeof msg === 'string' && msg.trim() !== '' ? msg : fallback)
    }
    throw new ApiError(res.status, fallback)
  }
  return data as T
}

export function listProjects(): Promise<Project[]> {
  return request<Project[]>('/projects')
}

export function createProject(input: NewProjectInput): Promise<Project> {
  return request<Project>('/projects', {
    method: 'POST',
    body: JSON.stringify({ key: input.key.trim(), name: input.name.trim(), repo: input.repo.trim() }),
  })
}

export function listRequirements(): Promise<Requirement[]> {
  return request<Requirement[]>('/requirements')
}

export function createRequirement(projectKey: string, input: NewRequirementInput): Promise<Requirement> {
  return request<Requirement>(`/p/${encodeURIComponent(projectKey)}/requirements`, {
    method: 'POST',
    body: JSON.stringify({
      context: input.context.trim(),
      source: input.source?.trim() || 'web',
      images: [],
    }),
  })
}

export function getRequirement(id: string): Promise<RequirementDetail> {
  return request<RequirementDetail>(`/requirements/${encodeURIComponent(id)}`)
}

/** 每个动作的 body 形状是后端定死的；多传字段会被 400（DisallowUnknownFields）。 */
export function nodeAction(
  requirementId: string,
  nodeKey: string,
  action: NodeAction,
  text: string,
): Promise<Requirement> {
  const path = `/requirements/${encodeURIComponent(requirementId)}/nodes/${encodeURIComponent(nodeKey)}/${action}`
  let body: Record<string, string> = {}
  if (action === 'accept') body = { comment: text }
  else if (action === 'reject') body = { reason: text }
  else if (action === 'comment') body = { body: text }
  else if (action === 'rules') body = { rule: text }
  return request<Requirement>(path, { method: 'POST', body: JSON.stringify(body) })
}
