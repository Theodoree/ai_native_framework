<script setup lang="ts">
import { computed, ref } from 'vue'
import Icon from './Icon.vue'
import StatusBadge from './StatusBadge.vue'
import { fmtAuthorType, fmtTime, fmtType } from '../format'
import type { Node, NodeAction } from '../types'

const props = defineProps<{
  node: Node
  current: boolean
  requirementState: string
  submit: (action: NodeAction, text: string) => Promise<void>
}>()

const CONTAINER_TYPES = ['create', 'assess', 'crosstest', 'release']

const draft = ref('')
const error = ref('')
const busy = ref<NodeAction | null>(null)

const isContainer = computed(() => CONTAINER_TYPES.includes(props.node.type))
const active = computed(() => props.requirementState === 'active')
const reviewable = computed(() => ['running', 'awaiting_review', 'accepted'].includes(props.node.state))
const canRun = computed(
  () => active.value && props.current && (props.node.state === 'pending' || props.node.state === 'rejected'),
)
const canReview = computed(() => active.value && props.current && reviewable.value)
const canAnnotate = computed(() => active.value)

const rejectComment = computed(() => props.node.comments.find((c) => c.verdict === 'reject'))
const lastAttempt = computed(() => props.node.attempts[props.node.attempts.length - 1] ?? null)

function actionState(): { key: NodeAction; label: string; needsText: boolean; enabled: boolean }[] {
  return [
    { key: 'run', label: '开始执行', needsText: false, enabled: canRun.value },
    { key: 'accept', label: '通过', needsText: true, enabled: canReview.value },
    { key: 'reject', label: '拒绝', needsText: true, enabled: canReview.value },
    { key: 'comment', label: '评论', needsText: true, enabled: canAnnotate.value },
    { key: 'rules', label: '追加规则', needsText: true, enabled: canAnnotate.value },
  ]
}

const buttons = computed(actionState)

async function act(action: NodeAction) {
  error.value = ''
  const needsText = action !== 'run'
  const text = draft.value.trim()
  if (needsText && text === '') {
    error.value =
      action === 'accept'
        ? '通过前先在输入框写下结论'
        : action === 'reject'
          ? '拒绝必须带理由'
          : action === 'comment'
            ? '评论不能为空'
            : '追加的规则不能为空'
    return
  }
  busy.value = action
  try {
    await props.submit(action, text)
    draft.value = ''
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    busy.value = null
  }
}
</script>

<template>
  <article
    class="node card"
    :class="[
      `node--${node.state}`,
      { 'node--container': isContainer, 'node--current': current, 'node--rejected': node.state === 'rejected' },
    ]"
  >
    <header class="node__head">
      <span class="node__index">{{ node.index + 1 }}</span>
      <div class="node__title">
        <span class="node__key">{{ node.key }}</span>
        <span class="node__tag">{{ fmtType(node.type) }}</span>
        <span class="node__tag node__tag--review">
          <Icon name="shield" :size="11" />
          {{ node.review === 'ai' ? 'AI 审核' : '人工审核' }}
        </span>
        <span v-if="isContainer" class="node__tag node__tag--box">容器</span>
        <span v-if="current" class="node__current">当前站</span>
      </div>
      <StatusBadge :state="node.state" />
    </header>

    <div class="node__body">
      <div v-if="lastAttempt" class="attempt">
        <span class="attempt__n mono">第 {{ lastAttempt.n }} 次执行</span>
        <span class="attempt__meta mono">
          {{ lastAttempt.template || '—' }} · exit {{ lastAttempt.exitCode }}
        </span>
        <span class="attempt__meta soft">
          {{ fmtTime(lastAttempt.startedAt) }} → {{ fmtTime(lastAttempt.endedAt) }}
        </span>
        <p v-if="lastAttempt.outcome" class="attempt__outcome">{{ lastAttempt.outcome }}</p>
      </div>

      <ul v-if="node.rules.length" class="rules">
        <li v-for="(rule, i) in node.rules" :key="i" class="rule">
          <span class="rule__tag">规则</span>
          <span>{{ rule }}</span>
        </li>
      </ul>

      <ul v-if="node.comments.length" class="comments">
        <li
          v-for="c in node.comments"
          :key="c.id"
          class="comment"
          :class="[`comment--${c.authorType}`, { 'comment--reject': c.verdict === 'reject' }]"
        >
          <div class="comment__meta">
            <span class="comment__author">{{ fmtAuthorType(c.authorType) }} · {{ c.author || '匿名' }}</span>
            <span v-if="c.verdict === 'reject'" class="comment__verdict">拒绝</span>
            <span v-else-if="c.verdict === 'approve'" class="comment__verdict comment__verdict--ok">通过</span>
            <time class="comment__time soft">{{ fmtTime(c.at) }}</time>
          </div>
          <p class="comment__body">{{ c.body }}</p>
        </li>
      </ul>

      <p v-else-if="!lastAttempt" class="node__empty">
        {{ node.state === 'pending' ? '这一站还没开始。' : '这一站还没有评论。' }}
      </p>

      <p v-else class="node__empty">这一站还没有评论。</p>

      <ul v-if="node.artifacts.length" class="artifacts">
        <li v-for="(a, i) in node.artifacts" :key="i" class="artifact mono">{{ a }}</li>
      </ul>

      <p v-if="rejectComment" class="node__reject-line">
        <Icon name="alert" :size="12" />
        这一站被拒：{{ rejectComment.body }}
      </p>
    </div>

    <footer class="node__actions">
      <label class="node__input">
        <span class="node__input-label">
          本卡操作说明（通过 / 拒绝 / 评论 / 规则都需要文字；开始执行可留空）
        </span>
        <textarea
          v-model="draft"
          class="textarea"
          rows="2"
          :disabled="!active"
          placeholder="写在这一站要做什么、结论是什么；提交后就地显示错误，不弹窗。"
        />
      </label>
      <p v-if="error" class="inline-error">{{ error }}</p>
      <div class="node__buttons">
        <button
          v-for="b in buttons"
          :key="b.key"
          class="btn"
          :class="{ 'btn--primary': b.key === 'accept', 'btn--danger': b.key === 'reject' }"
          type="button"
          :disabled="!b.enabled || busy !== null"
          @click="act(b.key)"
        >
          {{ busy === b.key ? '提交中…' : b.label }}
        </button>
      </div>
    </footer>
  </article>
</template>

<style scoped>
.node {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 0;
  overflow: hidden;
}

.node--current {
  border-color: #c7d2fe;
  box-shadow: 0 0 0 3px rgba(79, 70, 229, 0.08), var(--shadow);
}

.node--rejected {
  border-color: #fca5a5;
}

.node__head {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 14px;
  border-bottom: 1px solid var(--border);
  background: var(--surface);
}

.node__index {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  flex: 0 0 24px;
  border: 1px solid var(--border-strong);
  border-radius: 50%;
  background: var(--bg);
  color: var(--text-muted);
  font-size: var(--fs-small);
  font-weight: 700;
}

.node--current .node__index {
  border-color: var(--accent);
  background: var(--accent-soft);
  color: var(--accent);
}

.node--accepted .node__index {
  border-color: #86efac;
  background: var(--st-accepted-bg);
  color: var(--st-accepted-fg);
}

.node--rejected .node__index {
  border-color: #fca5a5;
  background: var(--st-rejected-bg);
  color: var(--st-rejected-fg);
}

.node__title {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.node__key {
  font-size: 14px;
  font-weight: 700;
}

.node__tag {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 0 6px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg);
  color: var(--text-muted);
  font-size: 11px;
}

.node__tag--box {
  border-color: #c7d2fe;
  background: var(--accent-soft);
  color: var(--accent);
}

.node__current {
  padding: 0 6px;
  border-radius: var(--radius-sm);
  background: var(--accent);
  color: #fff;
  font-size: 11px;
  font-weight: 600;
}

.node__head > :last-child {
  margin-left: auto;
}

.node__body {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px 14px;
}

.attempt {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg);
  font-size: var(--fs-small);
}

.attempt__n {
  font-weight: 700;
  color: var(--text);
}

.attempt__meta {
  color: var(--text-muted);
}

.attempt__outcome {
  width: 100%;
  color: var(--text-muted);
  font-family: var(--font-mono);
  font-size: 11px;
  overflow-wrap: anywhere;
}

.rules {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.rule {
  display: flex;
  gap: 8px;
  padding: 5px 10px;
  border-left: 2px solid #c7d2fe;
  background: var(--accent-soft);
  border-radius: 0 var(--radius-sm) var(--radius-sm) 0;
  font-size: var(--fs-small);
}

.rule__tag {
  flex: 0 0 auto;
  color: var(--accent);
  font-weight: 700;
}

.comments {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.comment {
  padding: 7px 10px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--surface);
}

.comment--container {
  border-left: 3px solid var(--accent);
  background: #fafaff;
}

.comment--human {
  border-left: 3px solid #94a3b8;
  background: var(--bg);
}

.comment--reject {
  border-color: #fca5a5;
  border-left-color: var(--danger);
  background: #fff7f7;
}

.comment__meta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  font-size: 11px;
  color: var(--text-muted);
}

.comment__author {
  font-weight: 700;
  color: var(--text);
}

.comment__verdict {
  padding: 0 6px;
  border-radius: 999px;
  background: var(--st-rejected-bg);
  color: var(--st-rejected-fg);
  font-weight: 600;
}

.comment__verdict--ok {
  background: var(--st-accepted-bg);
  color: var(--st-accepted-fg);
}

.comment__time {
  margin-left: auto;
}

.comment__body {
  margin-top: 2px;
  color: var(--text);
  overflow-wrap: anywhere;
}

.node__empty {
  color: var(--text-soft);
  font-size: var(--fs-small);
}

.artifacts {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.artifact {
  padding: 1px 6px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg);
  color: var(--text-muted);
  font-size: 11px;
}

.node__reject-line {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--danger);
  font-size: var(--fs-small);
}

.node__actions {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px 14px 12px;
  border-top: 1px solid var(--border);
  background: #fcfdff;
}

.node__input {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.node__input-label {
  color: var(--text-soft);
  font-size: 11px;
}

.node__buttons {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 6px;
}
</style>
