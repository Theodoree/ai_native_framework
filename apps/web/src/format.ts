const STATE_LABELS: Record<string, string> = {
  pending: '待开始',
  running: '进行中',
  awaiting_review: '待审核',
  accepted: '已通过',
  rejected: '已拒绝',
  active: '进行中',
  done: '已完成',
}

const TYPE_LABELS: Record<string, string> = {
  create: '创建',
  assess: '评估',
  dev: '开发',
  crosstest: '交叉测试',
  merge: '合并',
  release: '上线',
  feature: '需求链',
}

const ACTION_LABELS: Record<string, string> = {
  create: '建立需求',
  run: '开始执行',
  finish: '执行完成',
  accept: '审核通过',
  reject: '审核拒绝',
  comment: '留言',
  rule: '追加规则',
}

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n)
}

/** 时间是 RFC3339；界面上只显示到秒，避免同一分钟的滚动让人误读。 */
export function fmtTime(iso: string | undefined | null): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

/** 评论表用分钟精度：审计记录里绝对时间可核对、可复制；相对时间会随时间漂移，截图里也读不出准点。 */
export function fmtMinute(iso: string | undefined | null): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export function fmtState(state: string): string {
  return STATE_LABELS[state] ?? state
}

export function fmtType(type: string): string {
  return TYPE_LABELS[type] ?? type
}

/** 链路圆形节点下方的站名（设计稿 v2 的固定说法：「需求评估」而不是短标签「评估」）。 */
const NODE_NAME_LABELS: Record<string, string> = {
  create: '创建',
  assess: '需求评估',
  dev: '开发',
  crosstest: '交叉测试',
  merge: '合并',
  release: '上线',
}

export function fmtNodeName(type: string): string {
  return NODE_NAME_LABELS[type] ?? fmtType(type)
}

export function fmtAction(action: string): string {
  return ACTION_LABELS[action] ?? action
}

export function excerpt(text: string, limit = 160): string {
  const oneLine = text.replace(/\s+/g, ' ').trim()
  if (oneLine.length <= limit) return oneLine
  return `${oneLine.slice(0, limit)}…`
}

export function fmtAuthorType(authorType: string): string {
  if (authorType === 'container') return '容器'
  if (authorType === 'human') return '人工'
  if (authorType === 'system') return '系统'
  return authorType
}

/**
 * 状态 → Arco Tag 的颜色档。颜色只是加强，徽章上的文字始终在（色盲与截图都读得懂）。
 * 需求级与节点级共用一张表：active 与 running 都是「正在走」，同色同字。
 */
export type TagColor = 'gray' | 'orange' | 'arcoblue' | 'green' | 'red'

export function stateColor(state: string): TagColor {
  if (state === 'running' || state === 'active') return 'orange'
  if (state === 'awaiting_review') return 'arcoblue'
  if (state === 'accepted' || state === 'done') return 'green'
  if (state === 'rejected') return 'red'
  return 'gray'
}

// ---------- 权力（后端 apps/chain/model.go:52-55 只有这四个，别自己发明词） ----------

export const POWERS = ['review', 'dev', 'test', 'release'] as const
export type Power = (typeof POWERS)[number]

/** 权力中文名：禁用按钮的 tooltip 要说人话。 */
export const POWER_LABELS: Record<string, string> = {
  review: '审核',
  dev: '开发',
  test: '测试',
  release: '上线',
}

/**
 * 节点类型 → 默认权力，照抄后端 apps/chain/model.go 的 defaultPower 表
 * （create→dev、assess→review、dev→dev、crosstest→test、merge→review、release→release）。
 * 节点上声明了 power 就以声明为准——那是进链时快照下来的，链条改版不该改判。
 */
const DEFAULT_POWER: Record<string, string> = {
  create: 'dev',
  assess: 'review',
  dev: 'dev',
  crosstest: 'test',
  merge: 'review',
  release: 'release',
}

/** 一站要哪个权力，与后端 PowerForNode 同判据；判不出来给空串（调用方按「判不了」处理）。 */
export function powerForNode(type: string, declared?: string): string {
  if (declared && declared.trim() !== '') return declared
  return DEFAULT_POWER[type] ?? ''
}

export function powerLabel(power: string): string {
  return POWER_LABELS[power] ?? power
}

