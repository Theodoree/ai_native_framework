<script setup lang="ts">
/**
 * 选中站（整张链路卡片的下半部分，外框由 NodeChain 提供，所以这里不再套一层卡片边框）。
 * 标题行：状态点 + 站名（中文）+ 类型/模板 · 审核方 · 状态 · N 条评论 + 右上动作按钮（重启节点 / 拒绝 / 通过，
 * 当前站处于待开始或被拒时另有「开始执行」）。
 * 下面依次是：重启理由行（点「重启节点」才出现）、错误与拒绝提示、执行记录、追加规则、评论时间线、产物、输入区。
 * 所有操作都在卡内输入，错误就地显示——不用 alert / confirm / prompt。
 */
import { computed, ref } from 'vue'
import { IconCheck, IconClose, IconPlayArrow, IconRefresh, IconRobot, IconSettings, IconUser } from '@arco-design/web-vue/es/icon'
import type { Node, NodeAction } from '../types'
import { fmtAuthorType, fmtMinute, fmtState, fmtTime, powerForNode, powerLabel } from '../format'

const props = defineProps<{
  node: Node
  current: boolean
  requirementState: string
  /** 当前项目 key：禁用提示要说出「你在哪个项目里没有哪个权力」。 */
  projectKey: string
  /** 我在这个项目里的权力并集（管理员四权齐全）；判定照后端 powersFor，跨项目授予不算。 */
  powers: string[]
  submit: (action: NodeAction, text: string) => Promise<void>
  restart: (reason: string) => Promise<void>
}>()

const active = computed(() => props.requirementState === 'active')
const reviewable = computed(() => ['running', 'awaiting_review', 'accepted'].includes(props.node.state))
const canRun = computed(
  () => active.value && props.current && (props.node.state === 'pending' || props.node.state === 'rejected'),
)
const canReview = computed(() => active.value && props.current && reviewable.value)
const canAnnotate = computed(() => active.value)
/** 已通过的站重启是破坏性的（后面基于它的站都要退回），理由必填——和后端 400 的判据一致。 */
const needsReason = computed(() => props.node.state === 'accepted')

const draft = ref('')
const reason = ref('')
const restartOpen = ref(false)
const busy = ref('')
const error = ref('')

const rejectComment = computed(() => props.node.comments.find((c) => c.verdict === 'reject'))
const lastAttempt = computed(() => props.node.attempts[props.node.attempts.length - 1] ?? null)

/**
 * 标题行的副信息只留「审核方 · 状态 · N 条评论」。
 * 站名不进这一行（只由左边圆节点承担），模板也不再回显（它在下面的执行记录里）——
 * 同一件事在同一个屏幕上只出现一次。
 */
const subLine = computed(() => {
  const parts: string[] = []
  parts.push(props.node.review === 'ai' ? 'AI 审核' : '人工审核')
  parts.push(fmtState(props.node.state))
  parts.push(props.node.comments.length + ' 条评论')
  return parts.join(' · ')
})

/** 这一站要的权力，以及我有没有；没有就禁用并说清缺哪个（按钮不隐藏）。 */
const needPower = computed(() => powerForNode(props.node.type, props.node.power))
const hasPower = computed(() => needPower.value !== '' && props.powers.includes(needPower.value))
const denyText = computed(
  () =>
    '你在 ' +
    (props.projectKey || '这个项目') +
    ' 里没有「' +
    powerLabel(needPower.value) +
    '（' +
    needPower.value +
    '）」权力，按不动这一站。' +
    '这是前端提前禁用；真要按，后端也会回 403 并给出原文。',
)

function whoOf(authorType: string, author: string): string {
  const name = author && author.trim() !== '' ? author : '匿名'
  if (authorType === 'human') return name
  return fmtAuthorType(authorType) + ' · ' + name
}

function emptyTextHint(action: NodeAction): string {
  if (action === 'accept') return '通过前先在输入框写下结论'
  if (action === 'reject') return '拒绝必须带理由'
  if (action === 'comment') return '评论不能为空'
  return '追加的规则不能为空'
}

async function act(action: NodeAction) {
  error.value = ''
  const text = draft.value.trim()
  if (action !== 'run' && text === '') {
    error.value = emptyTextHint(action)
    return
  }
  busy.value = action
  try {
    await props.submit(action, text)
    draft.value = ''
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    busy.value = ''
  }
}

function openRestart() {
  error.value = ''
  restartOpen.value = true
}

async function doRestart() {
  error.value = ''
  const text = reason.value.trim()
  if (needsReason.value && text === '') {
    error.value = '这一站已通过，重启必须写理由：写清为什么要退回它'
    return
  }
  busy.value = 'restart'
  try {
    await props.restart(text)
    restartOpen.value = false
    reason.value = ''
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    busy.value = ''
  }
}
</script>

<template>
  <div class="sel">
    <header class="sel__head">
      <span class="sel__dot" :class="'sel__dot--' + node.state" aria-hidden="true" />
      <span class="sel__name">第 {{ node.index + 1 }} 站</span>
      <span class="sel__sub">{{ subLine }}</span>
      <div class="sel__acts">
        <a-tooltip :content="denyText" :disabled="hasPower" position="top">
          <span class="tipwrap">
            <a-button size="small" :loading="busy === 'restart'" :disabled="!hasPower || !active || busy !== ''" @click="openRestart">
              <template #icon><IconRefresh /></template>
              重启节点
            </a-button>
          </span>
        </a-tooltip>
        <a-tooltip v-if="canRun" :content="denyText" :disabled="hasPower" position="top">
          <span class="tipwrap">
            <a-button
              size="small"
              type="outline"
              :loading="busy === 'run'"
              :disabled="!hasPower || busy !== ''"
              @click="act('run')"
            >
              <template #icon><IconPlayArrow /></template>
              开始执行
            </a-button>
          </span>
        </a-tooltip>
        <a-tooltip :content="denyText" :disabled="hasPower" position="top">
          <span class="tipwrap">
            <a-button
              size="small"
              status="danger"
              :loading="busy === 'reject'"
              :disabled="!hasPower || !canReview || busy !== ''"
              @click="act('reject')"
            >
              <template #icon><IconClose /></template>
              拒绝
            </a-button>
          </span>
        </a-tooltip>
        <a-tooltip :content="denyText" :disabled="hasPower" position="top">
          <span class="tipwrap">
            <a-button
              size="small"
              type="primary"
              :loading="busy === 'accept'"
              :disabled="!hasPower || !canReview || busy !== ''"
              @click="act('accept')"
            >
              <template #icon><IconCheck /></template>
              通过
            </a-button>
          </span>
        </a-tooltip>
      </div>
    </header>

    <div v-if="restartOpen" class="restart">
      <span class="restart__label">{{ needsReason ? '重启已通过的站必须写理由' : '重启理由（可选）' }}</span>
      <div class="restart__row">
        <a-input
          v-model="reason"
          size="small"
          allow-clear
          :placeholder="needsReason ? '为什么要退回这一站？例如：评估漏了迁移步骤' : '不写也能重启；写了会记进这一站的历史'"
        />
        <a-button
          size="small"
          type="primary"
          status="warning"
          :loading="busy === 'restart'"
          :disabled="(needsReason && reason.trim() === '') || busy !== ''"
          @click="doRestart"
        >
          确认重启
        </a-button>
        <a-button size="small" type="text" :disabled="busy !== ''" @click="restartOpen = false">取消</a-button>
      </div>
      <p class="pane__hint" style="margin: 4px 0 0">
        {{
          needsReason
            ? '空着不能提交（后端 400：重启已通过的站必须说明理由）；重启会把后面基于它的站一起退回待开始'
            : '其它状态可以直接重启；后端仍可能 409（还没到这一站，或整条需求已被拒）'
        }}
      </p>
    </div>

    <div class="sel__body">
      <a-alert v-if="error" type="error" class="sel__alert">{{ error }}</a-alert>
      <a-alert v-if="rejectComment" type="error" class="sel__alert">这一站被拒：{{ rejectComment.body }}</a-alert>

      <div v-if="lastAttempt" class="attempt">
        <div class="attempt__head">
          <span class="mono">第 {{ lastAttempt.n }} 次执行</span>
          <span class="mono">{{ lastAttempt.template || '—' }} · exit {{ lastAttempt.exitCode }}</span>
          <span>{{ fmtTime(lastAttempt.startedAt) }} → {{ fmtTime(lastAttempt.endedAt) }}</span>
        </div>
        <p v-if="lastAttempt.outcome" style="margin: 4px 0 0">{{ lastAttempt.outcome }}</p>
      </div>

      <div v-if="node.rules.length" class="blk">
        <span class="blk__title">追加规则</span>
        <div class="row" style="flex-wrap: wrap; gap: 6px">
          <span v-for="(rule, i) in node.rules" :key="i" class="rule">{{ rule }}</span>
        </div>
      </div>

      <div class="cmts">
        <div v-for="c in node.comments" :key="c.id" class="cmt" :class="'cmt--' + c.authorType">
          <span class="ava" :class="'ava--' + c.authorType" aria-hidden="true">
            <IconSettings v-if="c.authorType === 'container'" />
            <IconRobot v-else-if="c.authorType === 'system'" />
            <IconUser v-else />
          </span>
          <div class="cmt__main">
            <div class="cmt__meta">
              <span class="cmt__who">{{ whoOf(c.authorType, c.author) }}</span>
              <a-tag v-if="c.verdict === 'reject'" size="small" color="red">拒绝</a-tag>
              <a-tag v-else-if="c.verdict === 'approve'" size="small" color="green">通过</a-tag>
              <time class="cmt__time mono">{{ fmtMinute(c.at) }}</time>
            </div>
            <p class="cmt__body">{{ c.body }}</p>
          </div>
        </div>
        <p v-if="!node.comments.length" class="pane__hint" style="margin: 0">
          {{ node.state === 'pending' ? '这一站还没开始。' : '这一站还没有评论。' }}
        </p>
      </div>

      <div v-if="node.artifacts.length" class="blk">
        <span class="blk__title">产物</span>
        <span v-for="(a, i) in node.artifacts" :key="i" class="mono pane__hint">{{ a }}</span>
      </div>

      <div class="composer">
        <a-textarea
          v-model="draft"
          :auto-size="{ minRows: 2, maxRows: 8 }"
          :disabled="!active"
          placeholder="给这一站留句话：通过 / 拒绝 / 评论 / 追加规则都读这一格（开始执行和重启不用它）。错误就地显示，不弹窗。"
        />
        <div class="composer__foot">
          <a-button size="small" :loading="busy === 'comment'" :disabled="!canAnnotate || busy !== ''" @click="act('comment')">
            留下评论
          </a-button>
          <a-button
            size="small"
            type="text"
            :loading="busy === 'rules'"
            :disabled="!canAnnotate || busy !== ''"
            @click="act('rules')"
          >
            追加规则
          </a-button>
          <span class="pane__hint">评论不改状态；通过 / 拒绝也读这一格</span>
        </div>
      </div>
    </div>
  </div>
</template>
