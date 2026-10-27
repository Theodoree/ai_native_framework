export type NodeType = 'create' | 'assess' | 'dev' | 'crosstest' | 'merge' | 'release'
export type NodeState = 'pending' | 'running' | 'awaiting_review' | 'accepted' | 'rejected'
export type RequirementState = 'active' | 'done' | 'rejected'
export type ReviewSide = 'ai' | 'human'
export type NodeAction = 'run' | 'accept' | 'reject' | 'comment' | 'rules'

export interface ChainNodeDecl {
  key: string
  type: NodeType
  review: ReviewSide
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

export interface NewProjectInput {
  key: string
  name: string
  repo: string
}

export interface NewRequirementInput {
  context: string
  source?: string
}
