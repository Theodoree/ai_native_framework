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

export function fmtState(state: string): string {
  return STATE_LABELS[state] ?? state
}

export function fmtType(type: string): string {
  return TYPE_LABELS[type] ?? type
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
