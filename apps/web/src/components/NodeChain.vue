<script setup lang="ts">
/**
 * 链路卡片（设计稿 A · 描边版）：**一整张卡片**。
 * 上半是横向圆形节点序列（52px 描边圆 + 带实心三角的直角连线），中间一条虚线，
 * 下半是「选中站」区域——由 NodeCard 渲染（动作按钮、评论时间线、评论输入都在同一张卡里）。
 * 点任意圆切换下方站点；默认选当前站（第一个还没通过的站）。
 *
 * 图标的取舍：对勾 / 叉 / 三角都用内联 SVG，不用图标字体——
 * 只有 SVG 能给出设计稿要的 stroke-width（勾 3px）与实心三角，字体图标的笔画粗细是字体里定死的。
 */
import { computed, ref, watch } from 'vue'
import NodeCard from './NodeCard.vue'
import type { Node, NodeAction } from '../types'
import { fmtNodeName, fmtState } from '../format'

const props = defineProps<{
  nodes: Node[]
  /** 当前站的下标；-1 表示整条链都已通过（没有「当前」） */
  currentIndex: number
  requirementState: string
  /** 当前项目 key 与我在这个项目里的权力：往下传给 NodeCard 决定按钮禁用与缺权提示。 */
  projectKey: string
  powers: string[]
  submit: (node: Node, action: NodeAction, text: string) => Promise<void>
  restart: (node: Node, reason: string) => Promise<void>
}>()

type Tone = 'done' | 'current' | 'failed' | 'todo'

/**
 * 四态优先级：被拒 > 当前 > 已通过 > 未到。
 * 被拒的当前站仍然着红，因为「被拒」更需要被看见；
 * 全部通过时 currentIndex 为 -1，圆点全部走 done，不把末站误标成「当前」。
 */
function toneOf(node: Node, index: number): Tone {
  if (node.state === 'rejected') return 'failed'
  if (index === props.currentIndex) return 'current'
  if (node.state === 'accepted') return 'done'
  return 'todo'
}

const items = computed(() =>
  props.nodes.map((node, index) => ({ node, index, tone: toneOf(node, index) })),
)

const totalComments = computed(() => props.nodes.reduce((sum, node) => sum + node.comments.length, 0))

/** 走过的那一段连线：前一站已通过就算走过（实线绿）。 */
function walked(index: number): boolean {
  return props.nodes[index]?.state === 'accepted'
}

/** 默认选中：第一个还没通过的站；全部通过时选最后一站（否则卡片下半是空的）。 */
function defaultKey(nodes: Node[]): string {
  const open = nodes.find((n) => n.state !== 'accepted')
  return (open ?? nodes[nodes.length - 1])?.key ?? ''
}

const selectedKey = ref('')

/**
 * 用 watch 而不是只算初值：需求详情是异步加载的，nodes 先空后有；
 * 一次操作（通过 / 重启）也会改节点状态——只要选中的站还在就不动它，
 * 免得用户正在看的那一站被自动换掉。
 */
watch(
  () => props.nodes,
  (nodes) => {
    if (!nodes.some((n) => n.key === selectedKey.value)) selectedKey.value = defaultKey(nodes)
  },
  { immediate: true },
)

const selected = computed(() => props.nodes.find((n) => n.key === selectedKey.value) ?? null)

function select(node: Node) {
  selectedKey.value = node.key
}

function submitSelected(action: NodeAction, text: string): Promise<void> {
  return selected.value ? props.submit(selected.value, action, text) : Promise.resolve()
}

function restartSelected(reason: string): Promise<void> {
  return selected.value ? props.restart(selected.value, reason) : Promise.resolve()
}

function ariaOf(node: Node, index: number, tone: Tone): string {
  return (
    '第 ' + (index + 1) + ' 站 ' + node.key + '，' + fmtNodeName(node.type) + '，' +
    fmtState(node.state) + '，' + node.comments.length + ' 条评论，' +
    (tone === 'current' ? '当前站' : '点开看这一站')
  )
}
</script>

<template>
  <section class="panel">
    <div class="panel__head">
      <h3>链路</h3>
      <span class="hint">
        <template v-if="totalComments">点圆点切换下方站点 · 共 {{ totalComments }} 条评论</template>
        <template v-else>点圆点切换下方站点 · 还没有评论</template>
      </span>
    </div>

    <div class="flow">
      <template v-for="(item, i) in items" :key="item.node.key">
        <button
          type="button"
          class="stop"
          :class="'stop--' + item.tone"
          :aria-pressed="selectedKey === item.node.key"
          :aria-label="ariaOf(item.node, i, item.tone)"
          @click="select(item.node)"
        >
          <span class="disc">
            <!-- 只有未到的站圆里写站号；已通过 / 当前 / 被拒用图标表达，不再压角标。 -->
            <span v-if="item.tone === 'todo'" class="disc__n">{{ i + 1 }}</span>
            <svg
              v-else-if="item.tone === 'done'"
              class="disc__ico"
              viewBox="0 0 24 24"
              aria-hidden="true"
            >
              <path d="M4.5 12.5 9.5 17.5 19.5 6.5" fill="none" stroke="#0e9f5d" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" />
            </svg>
            <svg
              v-else-if="item.tone === 'current'"
              class="disc__ico disc__ico--play"
              viewBox="0 0 24 24"
              aria-hidden="true"
            >
              <path d="M8 5.2 19 12 8 18.8z" fill="#4f46e5" />
            </svg>
            <svg v-else class="disc__ico" viewBox="0 0 24 24" aria-hidden="true">
              <path d="M7 7 17 17M17 7 7 17" fill="none" stroke="#e5484d" stroke-width="3" stroke-linecap="round" />
            </svg>
          </span>
          <span class="stop__name">{{ fmtNodeName(item.node.type) }}</span>
          <span class="stop__st">{{ fmtState(item.node.state) }}</span>
          <span class="stop__cmt">
            {{ item.node.comments.length ? item.node.comments.length + ' 条评论' : '还没有评论' }}
          </span>
        </button>
        <div v-if="i < items.length - 1" class="link" :class="{ 'link--walked': walked(i) }" aria-hidden="true">
          <span class="link__line" />
          <svg class="link__tri" viewBox="0 0 8 10"><path d="M0 0 8 5 0 10z" /></svg>
        </div>
      </template>
    </div>

    <!-- 图与选中站之间只有一条虚线：它们是同一张卡片的两半。 -->
    <div class="sep" aria-hidden="true" />

    <NodeCard
      v-if="selected"
      :node="selected"
      :current="selected.index === currentIndex"
      :requirement-state="requirementState"
      :project-key="projectKey"
      :powers="powers"
      :submit="submitSelected"
      :restart="restartSelected"
    />
    <div v-else class="sel__body">
      <p class="pane__hint" style="margin: 12px 0 0">这条需求还没有节点。</p>
    </div>
  </section>
</template>
