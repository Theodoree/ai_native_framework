<script setup lang="ts">
import { computed } from 'vue'
import EmptyState from './EmptyState.vue'
import EventStream from './EventStream.vue'
import Icon from './Icon.vue'
import NodeCard from './NodeCard.vue'
import StatusBadge from './StatusBadge.vue'
import { fmtTime } from '../format'
import type { Node, NodeAction, RequirementDetail } from '../types'

const props = defineProps<{
  detail: RequirementDetail | null
  state: 'loading' | 'ready' | 'error'
  error: string
  submit: (node: Node, action: NodeAction, text: string) => Promise<void>
}>()

const emit = defineEmits<{ (e: 'back'): void; (e: 'retry'): void }>()

const requirement = computed(() => props.detail?.requirement ?? null)
const events = computed(() => props.detail?.events ?? [])
const currentIndex = computed(() => {
  const r = requirement.value
  if (!r) return -1
  return r.nodes.length === 0 ? -1 : r.nodes.find((n) => n.state !== 'accepted')?.index ?? -1
})

function submitNode(node: Node, action: NodeAction, text: string): Promise<void> {
  return props.submit(node, action, text)
}
</script>

<template>
  <section class="detail">
    <button class="btn btn--ghost detail__back" type="button" @click="emit('back')">
      <Icon name="back" :size="13" />
      返回需求列表
    </button>

    <p v-if="state === 'loading'" class="detail__note">正在加载需求详情…</p>

    <div v-else-if="state === 'error'" class="detail__note detail__note--error">
      <span><Icon name="alert" :size="13" /> {{ error }}</span>
      <button class="btn btn--ghost" type="button" @click="emit('retry')">重试</button>
    </div>

    <EmptyState
      v-else-if="!requirement"
      title="没有选中需求"
      hint="从左侧需求列表点一条进来，这里会显示它的链条与每一站的状态。"
    />

    <template v-else>
      <header class="meta card">
        <div class="meta__line">
          <span class="meta__id mono">{{ requirement.id }}</span>
          <StatusBadge :state="requirement.state" />
        </div>
        <div class="meta__facts">
          <span class="fact">
            <span class="fact__label">分支</span>
            <span class="fact__value mono">{{ requirement.branch }}</span>
          </span>
          <span class="fact">
            <span class="fact__label">链条</span>
            <span class="fact__value mono">{{ requirement.chainKey }} v{{ requirement.chainVersion }}</span>
          </span>
          <span class="fact">
            <span class="fact__label">项目</span>
            <span class="fact__value mono">{{ requirement.projectKey }}</span>
          </span>
          <span class="fact">
            <span class="fact__label">更新</span>
            <span class="fact__value">{{ fmtTime(requirement.updatedAt) }}</span>
          </span>
          <span class="fact">
            <span class="fact__label">来源</span>
            <span class="fact__value">{{ requirement.source || 'api' }}</span>
          </span>
        </div>
        <p class="meta__context">{{ requirement.context }}</p>
        <p v-if="requirement.images.length" class="meta__images soft">
          附件：{{ requirement.images.join('、') }}
        </p>
      </header>

      <ol class="timeline">
        <li v-for="node in requirement.nodes" :key="node.key" class="timeline__item">
          <span class="timeline__rail" aria-hidden="true" />
          <NodeCard
            :node="node"
            :current="node.index === currentIndex"
            :requirement-state="requirement.state"
            :submit="(action, text) => submitNode(node, action, text)"
          />
        </li>
      </ol>

      <EventStream :events="events" />
    </template>
  </section>
</template>

<style scoped>
.detail {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.detail__back {
  align-self: flex-start;
  padding-left: 4px;
  color: var(--text-muted);
}

.detail__note {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 12px 14px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--surface);
  color: var(--text-muted);
}

.detail__note--error {
  border-color: #fecaca;
  color: var(--danger);
}

.meta {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 14px 16px;
}

.meta__line {
  display: flex;
  align-items: center;
  gap: 10px;
}

.meta__id {
  font-size: var(--fs-title);
  font-weight: 700;
}

.meta__facts {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 18px;
  font-size: var(--fs-small);
}

.fact {
  display: inline-flex;
  align-items: baseline;
  gap: 6px;
}

.fact__label {
  color: var(--text-soft);
}

.fact__value {
  color: var(--text);
  font-weight: 600;
}

.meta__context {
  padding-top: 6px;
  border-top: 1px solid var(--border);
  color: var(--text);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.meta__images {
  font-size: var(--fs-small);
}

.timeline {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.timeline__item {
  position: relative;
  display: block;
  padding-left: 18px;
}

.timeline__rail {
  position: absolute;
  top: 6px;
  bottom: -10px;
  left: 5px;
  width: 2px;
  border-radius: 1px;
  background: var(--border);
}

.timeline__item:last-child .timeline__rail {
  bottom: 50%;
  opacity: 0;
}

.timeline__item > *:not(.timeline__rail) {
  position: relative;
  z-index: 1;
}

@media (max-width: 900px) {
  .timeline__item {
    padding-left: 0;
  }

  .timeline__rail {
    display: none;
  }
}
</style>
