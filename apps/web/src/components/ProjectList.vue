<script setup lang="ts">
/**
 * 项目列表（左栏）：Arco Menu 一行一个项目——key + 名称 / 仓库 / 链条 / 需求数。
 * 点一项即切换当前项目；加载、错误、空态都在这块里说清楚，不留白屏。
 */
import { IconRefresh } from '@arco-design/web-vue/es/icon'
import type { Project } from '../types'

const props = withDefaults(
  defineProps<{
    projects: Project[]
    state: 'loading' | 'ready' | 'error'
    error: string
    current: string
    counts?: Record<string, number>
    /** 管理员看到空列表是「还没建」，非管理员是「还没被加进来」——两种空说两句不同的话。 */
    admin?: boolean
  }>(),
  { counts: () => ({}), admin: false },
)

const emit = defineEmits<{ (e: 'select', key: string): void; (e: 'retry'): void }>()

function chainPath(p: Project): string {
  const chain = p.chains[0]
  if (!chain) return '没有链条'
  return chain.nodes.map((n) => n.key).join(' → ')
}

/** 每条链的 key + 站数：开需求要按 key 选链，光有站点路径看不出该选哪条。 */
function chainList(p: Project): string {
  if (!p.chains.length) return ''
  return p.chains.map((c) => `${c.key} · ${c.nodes.length} 站`).join('　')
}

function countOf(key: string): number {
  return props.counts[key] ?? 0
}

function onClick(key: string) {
  emit('select', key)
}
</script>

<template>
  <section class="pane sider">
    <div class="pane__head">
      <h2 class="pane__title">项目<span class="pane__hint">{{ projects.length }}</span></h2>
      <a-button size="mini" type="text" aria-label="刷新项目" @click="emit('retry')">
        <template #icon><IconRefresh /></template>
      </a-button>
    </div>

    <div v-if="state === 'loading' && !projects.length" class="state">
      <a-spin :size="20" />
      <span>正在读项目…</span>
    </div>

    <div v-else-if="state === 'error'" class="state">
      <a-alert type="error">{{ error || '读不到项目列表。' }}</a-alert>
      <a-button size="small" @click="emit('retry')">重试</a-button>
    </div>

    <a-empty
      v-else-if="!projects.length"
      :description="admin ? '还没有项目。' : '你还没被加进任何项目。'"
    />

    <a-menu
      v-else
      class="sider__menu"
      :selected-keys="[current]"
      :default-selected-keys="[current]"
      @menu-item-click="onClick"
    >
      <a-menu-item v-for="p in projects" :key="p.key">
        <div class="proj">
          <div class="proj__top">
            <span class="mono proj__key">{{ p.key }}</span>
            <span class="proj__name">{{ p.name }}</span>
          </div>
          <div class="proj__repo mono">{{ p.repo }}</div>
          <div class="proj__chain mono">{{ chainPath(p) }}</div>
          <div v-if="p.chains.length" class="proj__chain mono">链：{{ chainList(p) }}</div>
          <div class="proj__count">{{ countOf(p.key) }} 条需求</div>
        </div>
      </a-menu-item>
    </a-menu>
  </section>
</template>
