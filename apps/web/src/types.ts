export type NodeType = 'create' | 'assess' | 'dev' | 'crosstest' | 'merge' | 'release'
export type NodeState = 'pending' | 'running' | 'awaiting_review' | 'accepted' | 'rejected'
export type RequirementState = 'active' | 'done' | 'rejected'
export type ReviewSide = 'ai' | 'human'
export type NodeAction = 'run' | 'accept' | 'reject' | 'comment' | 'rules'

export interface ChainNodeDecl {
  key: string
  type: NodeType
  review: ReviewSide
  /** 这一站用哪个 agent 运行时；不写后端按节点类型的默认模板。空节点（dev/merge）不能声明。 */
  harness?: string
  /** 镜像里 agent CLI 的版本（不是镜像 tag）；不写后端定成 latest。空节点不能声明。 */
  version?: string
}

/** GET /api/templates 的一项：harness 的 key + 它跑的镜像 + 可选 agent 版本（latest 第一，倒序最多 10 个）。 */
export interface TemplateView {
  key: string
  image: string
  version: string
  versions: string[]
  timeout?: string
}

export interface Chain {
  key: string
  type: string
  version: number
  nodes: ChainNodeDecl[]
}

export interface Project {
  key: string
  name: string
  repo: string
  defaultBranch: string
  chains: Chain[]
  createdAt: string
}

export interface Attempt {
  n: number
  startedAt: string
  endedAt: string
  exitCode: number
  template: string
  log: string
  outcome: string
}

export interface Comment {
  id: string
  authorType: string
  author: string
  body: string
  verdict: string
  at: string
}

export interface Node {
  key: string
  type: NodeType
  review: ReviewSide
  /** 进链时快照的 agent 运行时；空节点（dev/merge）没有这一项。 */
  harness?: string
  /** 进链时快照的 agent CLI 版本（不是镜像 tag）；空节点上后端也会写一个，展示时忽略。 */
  version?: string
  /** 0 基下标：展示成「第 N 站」要 +1。 */
  index: number
  state: NodeState
  attempts: Attempt[]
  comments: Comment[]
  rules: string[]
  artifacts: string[]
  rev: number
}

export interface Requirement {
  id: string
  projectKey: string
  chainKey: string
  chainVersion: number
  context: string
  images: string[]
  source: string
  branch: string
  state: RequirementState
  nodes: Node[]
  rev: number
  createdAt: string
  updatedAt: string
}

export interface ChainEvent {
  at: string
  requirement: string
  node: string
  action: string
  from: string
  to: string
  detail: string
}

export interface RequirementDetail {
  requirement: Requirement
  events: ChainEvent[]
  eventsTruncated?: boolean
}

/** 建项目时自带的链条声明：头必须是 assess、尾必须是 release（后端 ValidateChain）。 */
export interface NewChainInput {
  key: string
  nodes: ChainNodeDecl[]
}

export interface NewProjectInput {
  key: string
  name: string
  repo: string
  /** 不传就让后端给默认链（key=feature，三站）。 */
  chains?: NewChainInput[]
}

export interface NewRequirementInput {
  context: string
  source?: string
  /** 链的 key 字符串（不是链条对象）；留空时后端取这个项目的第一条链。 */
  chain?: string
}

/** GET /api/me 里的当前登录人：与 User 同形，密码哈希后端从不外发。 */
export interface SessionUser {
  id: string
  username: string
  admin: boolean
  createdAt: string
}

/** GET /api/me 里的一条授权：字段名以后端 JSON 为准（project / role / roleId / powers）。 */
export interface Membership {
  project: string
  role: string
  roleId?: string
  powers: string[]
}

/** GET /api/me 的完整响应：是 { user, memberships }，不是扁平的 user。 */
export interface Me {
  user: SessionUser
  memberships: Membership[]
}

export interface Credentials {
  username: string
  password: string
}
// ---------- 后台三页：账号 / 项目角色 / 我的密钥 ----------

/** GET /api/users 一行，与 SessionUser 同形（User 的 PasswordHash 是 json:"-"）。 */
export type UserRow = SessionUser

/** 项目级角色：powers 只能是 review / dev / test / release（后端 ValidPower 定死）。 */
export interface Role {
  id: string
  projectKey: string
  name: string
  powers: string[]
  createdAt?: string
}

/** GET /api/keys 一行：后端只回名字与时间，密钥原文永不出现在列表里。 */
export interface APIKeyRow {
  id: string
  name: string
  createdAt: string
  lastUsedAt?: string | null
}

/** POST /api/keys 的 201：secret 只在这一个响应里出现一次。 */
export interface CreatedKey {
  key: APIKeyRow
  secret: string
}
