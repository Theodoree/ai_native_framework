import type {
  APIKeyRow,
  CreatedKey,
  Credentials,
  Me,
  NewProjectInput,
  NewRequirementInput,
  NodeAction,
  Project,
  Requirement,
  RequirementDetail,
  Role,
  SessionUser,
  UserRow,
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

/**
 * 401 的订阅点：App 订阅后立刻退回登录页。
 * 登录 / 注册 / 启动时探 /me 这三条自己的 401 是「你还没登录」的正常答复，不算会话过期，
 * 否则一打开页面就会先弹一句「会话已过期」。
 */
type UnauthorizedHandler = () => void
let unauthorizedHandler: UnauthorizedHandler | null = null
const SELF_401_PATHS = new Set(['/login', '/signup', '/me'])

export function onUnauthorized(fn: UnauthorizedHandler): void {
  unauthorizedHandler = fn
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers: Record<string, string> = {
    Accept: 'application/json',
  }
  // FormData 必须让浏览器自己带 boundary：这里设成 json 会让 multipart 直接坏掉。
  if (init?.body && !(init.body instanceof FormData)) {
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
    if (res.status === 401 && !SELF_401_PATHS.has(path) && unauthorizedHandler) {
      unauthorizedHandler()
    }
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
  const body: Record<string, unknown> = {
    key: input.key.trim(),
    name: input.name.trim(),
    repo: input.repo.trim(),
  }
  // 没有自定义链就不发 chains：后端见到非空数组才验链，缺省时它补默认链（feature 三站）。
  // 只发 {key, nodes} 两层的约定字段——后端 DisallowUnknownFields，多一个字段就 400。
  if (input.chains && input.chains.length > 0) {
    body.chains = input.chains.map((c) => ({
      key: c.key.trim(),
      nodes: c.nodes.map((n) => ({
        key: n.key.trim(),
        type: n.type,
        review: n.review,
        ...(n.power ? { power: n.power } : {}),
      })),
    }))
  }
  return request<Project>('/projects', { method: 'POST', body: JSON.stringify(body) })
}

export function listRequirements(): Promise<Requirement[]> {
  return request<Requirement[]>('/requirements')
}

export function createRequirement(projectKey: string, input: NewRequirementInput): Promise<Requirement> {
  return request<Requirement>(`/p/${encodeURIComponent(projectKey)}/requirements`, {
    method: 'POST',
    body: JSON.stringify({
      context: input.context.trim(),
      chain: input.chain?.trim() ?? '',
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

/**
 * 重启一站：POST /api/requirements/{id}/nodes/{key}/restart，body 只认 reason（或 body）。
 * 已通过的站必须给理由（后端 400），其余状态可以直接重启；还没轮到 / 整条需求已被拒是 409。
 */
export function restartNode(requirementId: string, nodeKey: string, reason: string): Promise<Requirement> {
  const path = `/requirements/${encodeURIComponent(requirementId)}/nodes/${encodeURIComponent(nodeKey)}/restart`
  const trimmed = reason.trim()
  return request<Requirement>(path, {
    method: 'POST',
    body: JSON.stringify(trimmed === '' ? {} : { reason: trimmed }),
  })
}

// ---------- 需求图片 ----------

/**
 * 上传需求图片：字段名必须叫 files（后端 images.go 只认这个），一次 ≤5 张、单张 ≤5MB，
 * 格式按文件头判（png/jpeg/webp/gif）。后端校验失败会带原文回来，这里原样抛出，由调用处就地显示。
 */
export function uploadRequirementImages(requirementId: string, files: File[]): Promise<Requirement> {
  const form = new FormData()
  for (const f of files) form.append('files', f)
  return request<Requirement>(`/requirements/${encodeURIComponent(requirementId)}/images`, {
    method: 'POST',
    body: form,
  })
}

/** 删一张图：传后端给的相对路径（/api/requirements/<id>/images/<文件名>），request 自己补 /api 前缀。 */
export function deleteRequirementImage(path: string): Promise<Requirement> {
  const suffix = path.startsWith('/api/') ? path.slice(4) : path
  return request<Requirement>(suffix, { method: 'DELETE' })
}

// ---------- 账号与会话 ----------
// 全部同源：fetch 默认就带 Cookie（credentials 默认 same-origin），这里不要写 omit。

export function signup(input: Credentials): Promise<SessionUser> {
  return request<SessionUser>('/signup', {
    method: 'POST',
    body: JSON.stringify({ username: input.username.trim(), password: input.password }),
  })
}

export function login(input: Credentials): Promise<SessionUser> {
  return request<SessionUser>('/login', {
    method: 'POST',
    body: JSON.stringify({ username: input.username.trim(), password: input.password }),
  })
}

export function logout(): Promise<unknown> {
  return request<unknown>('/logout', { method: 'POST' })
}

export function me(): Promise<Me> {
  return request<Me>('/me')
}

export function changePassword(oldPassword: string, newPassword: string): Promise<SessionUser> {
  return request<SessionUser>('/me/password', {
    method: 'PUT',
    body: JSON.stringify({ oldPassword, newPassword }),
  })
}
// ---------- 账号管理（仅管理员） ----------

export function listUsers(): Promise<UserRow[]> {
  return request<UserRow[]>('/users')
}

export function createUser(input: Credentials): Promise<UserRow> {
  return request<UserRow>('/users', {
    method: 'POST',
    body: JSON.stringify({ username: input.username.trim(), password: input.password }),
  })
}

/** 管理员重置别人的密码：只需要新密码，不需要旧密码。 */
export function resetUserPassword(id: string, password: string): Promise<UserRow> {
  return request<UserRow>(`/users/${encodeURIComponent(id)}/password`, {
    method: 'POST',
    body: JSON.stringify({ password }),
  })
}

// ---------- 我的 API 密钥 ----------

export function listKeys(): Promise<APIKeyRow[]> {
  return request<APIKeyRow[]>('/keys')
}

/** 这里拿到的 secret 是全生命周期里唯一一份原文，之后任何接口都不再回传。 */
export function createKey(name: string): Promise<CreatedKey> {
  return request<CreatedKey>('/keys', { method: 'POST', body: JSON.stringify({ name: name.trim() }) })
}

export function deleteKey(id: string): Promise<unknown> {
  return request<unknown>(`/keys/${encodeURIComponent(id)}`, { method: 'DELETE' })
}

// ---------- 项目角色与成员（仅管理员） ----------

export function listRoles(projectKey: string): Promise<Role[]> {
  return request<Role[]>(`/p/${encodeURIComponent(projectKey)}/roles`)
}

export function createRole(projectKey: string, name: string, powers: string[]): Promise<Role> {
  return request<Role>(`/p/${encodeURIComponent(projectKey)}/roles`, {
    method: 'POST',
    body: JSON.stringify({ name: name.trim(), powers }),
  })
}

export function deleteRole(projectKey: string, roleId: string): Promise<unknown> {
  return request<unknown>(`/p/${encodeURIComponent(projectKey)}/roles/${encodeURIComponent(roleId)}`, {
    method: 'DELETE',
  })
}

/** 成员列表是一串用户名（后端 listMembers 返回 []string），不是对象。 */
export function listMembers(projectKey: string, roleId: string): Promise<string[]> {
  return request<string[]>(`/p/${encodeURIComponent(projectKey)}/roles/${encodeURIComponent(roleId)}/members`)
}

export function addMember(projectKey: string, roleId: string, username: string): Promise<unknown> {
  return request<unknown>(`/p/${encodeURIComponent(projectKey)}/roles/${encodeURIComponent(roleId)}/members`, {
    method: 'POST',
    body: JSON.stringify({ username: username.trim() }),
  })
}

export function removeMember(projectKey: string, roleId: string, username: string): Promise<unknown> {
  const path = `/p/${encodeURIComponent(projectKey)}/roles/${encodeURIComponent(roleId)}/members/${encodeURIComponent(username)}`
  return request<unknown>(path, { method: 'DELETE' })
}
