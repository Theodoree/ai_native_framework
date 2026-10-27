<script setup lang="ts">
/**
 * 需求详情：返回 + 需求元信息卡 + 链路卡片（图 + 选中站）+ 底部可折叠的事件流。
 * 节点不再是「一站一张卡」的纵向列表：整条链是一张卡，点圆切换下面的站点。
 */
import { computed } from 'vue'
import { IconLeft, IconRefresh } from '@arco-design/web-vue/es/icon'
import NodeChain from './NodeChain.vue'
import EventStream from './EventStream.vue'
import ImageStrip from './ImageStrip.vue'
import type { Node, NodeAction, RequirementDetail } from '../types'
import { fmtState, fmtTime, stateColor } from '../format'

const props = defineProps<{
  detail: RequirementDetail | null
  state: 'loading' | 'ready' | 'error'
  error: string
  /** 当前项目 key 与我的权力：一路传到 NodeCard，缺权时按钮禁用并说明缺哪个。 */
  projectKey: string
  powers: string[]
  submit: (node: Node, action: NodeAction, text: string) => Promise<void>
  restart: (node: Node, reason: string) => Promise<void>
  uploadImages: (files: File[]) => Promise<void>
  removeImage: (path: string) => Promise<void>
}>()

const emit = defineEmits<{ (e: 'back'): void; (e: 'retry'): void }>()

const requirement = computed(() => props.detail?.requirement ?? null)
const events = computed(() => props.detail?.events ?? [])
/** 当前站 = 第一个还没通过的节点；全部通过就没有「当前」（-1），不把最后一站误标成当前。 */
const currentIndex = computed(() => {
  const r = requirement.value
  if (!r) return -1
  return r.nodes.find((n) => n.state !== 'accepted')?.index ?? -1
})
</script>

<template>
  <div class="stack">
    <div class="row">
      <a-button size="small" type="text" @click="emit('back')">
        <template #icon><IconLeft /></template>
        返回需求列表
      </a-button>
    </div>

    <div v-if="state === 'loading' && !requirement" class="state">
      <a-spin :size="24" />
      <span>正在读这条需求…</span>
    </div>

    <div v-else-if="state === 'error'" class="state">
      <a-alert type="error">{{ error || '读不到这条需求。' }}</a-alert>
      <a-button size="small" @click="emit('retry')">
        <template #icon><IconRefresh /></template>
        重试
      </a-button>
    </div>

    <template v-else-if="requirement">
      <a-card class="meta-card" :bordered="true">
        <div class="row" style="gap: 8px; align-items: center">
          <span class="mono req-id">{{ requirement.id }}</span>
          <a-tag :color="stateColor(requirement.state)">{{ fmtState(requirement.state) }}</a-tag>
        </div>
        <div class="meta">
          <div class="meta__item">
            <span class="meta__label">分支</span>
            <span class="meta__value mono">{{ requirement.branch }}</span>
          </div>
          <div class="meta__item">
            <span class="meta__label">链条</span>
            <span class="meta__value mono">{{ requirement.chainKey }} v{{ requirement.chainVersion }}</span>
          </div>
          <div class="meta__item">
            <span class="meta__label">项目</span>
            <span class="meta__value mono">{{ requirement.projectKey }}</span>
          </div>
          <div class="meta__item">
            <span class="meta__label">来源</span>
            <span class="meta__value">{{ requirement.source }}</span>
          </div>
          <div class="meta__item">
            <span class="meta__label">更新于</span>
            <span class="meta__value mono">{{ fmtTime(requirement.updatedAt) }}</span>
          </div>
        </div>
        <p class="req-context">{{ requirement.context }}</p>

        <ImageStrip
          :images="requirement.images ?? []"
          :upload="props.uploadImages"
          :remove="props.removeImage"
        />
      </a-card>

      <NodeChain
        :nodes="requirement.nodes"
        :current-index="currentIndex"
        :requirement-state="requirement.state"
        :project-key="requirement.projectKey"
        :powers="powers"
        :submit="submit"
        :restart="restart"
      />

      <EventStream :events="events" />
    </template>
  </div>
</template>
