<script setup lang="ts">
/**
 * 需求列表：Arco Table 装数据（行点击进详情），新建需求走 Modal 表单，
 * 错误与空态都在界面里说清楚，不弹 window.alert。
 */
import { computed, ref } from 'vue'
import { IconPlus, IconRefresh, IconRight } from '@arco-design/web-vue/es/icon'
import type { TableColumnData } from '@arco-design/web-vue'
import type { Chain, NewRequirementInput, Requirement } from '../types'
import { excerpt, fmtNodeName, fmtState, fmtTime, stateColor } from '../format'

const props = defineProps<{
  requirements: Requirement[]
  state: 'loading' | 'ready' | 'error'
  error: string
  projectKey: string
  projectName: string
  /** 当前项目可选的链；开需求时挑一条，不挑就取第一条。 */
  chains: Chain[]
  create: ((input: NewRequirementInput) => Promise<void>) | null
}>()

const emit = defineEmits<{ (e: 'open', id: string): void; (e: 'retry'): void }>()

const dialogOpen = ref(false)
const context = ref('')
const source = ref('web')
const chain = ref('')
const busy = ref(false)
const error = ref('')

const columns: TableColumnData[] = [
  { title: '需求', dataIndex: 'id', slotName: 'req', width: 188 },
  { title: '状态', dataIndex: 'state', slotName: 'state', width: 96 },
  { title: '当前站', dataIndex: 'current', slotName: 'cur', width: 196 },
  // 正文列不给固定宽：Arco 会对无宽列按内容撑开，长正文会把表格顶出面板；
  // ellipsis + tooltip 让它吃剩余宽度并截断，悬停看全文。
  { title: '正文', dataIndex: 'context', slotName: 'body', ellipsis: true, tooltip: true },
  { title: '进度', dataIndex: 'progress', slotName: 'prog', width: 86 },
  { title: '更新于', dataIndex: 'updatedAt', slotName: 'time', width: 158 },
  { title: '', slotName: 'ops', width: 56 },
]

/** 当前站 = 第一个还没通过的节点；全通过就没有当前站。 */
function currentOf(r: Requirement) {
  return r.nodes.find((n) => n.state !== 'accepted') ?? null
}

function doneCount(r: Requirement): number {
  return r.nodes.filter((n) => n.state === 'accepted').length
}

const total = computed(() => props.requirements.length)
const chain2Path = (c: Chain) => c.nodes.map((n) => n.key).join(' → ')

function onRowClick(record: unknown) {
  emit('open', (record as Requirement).id)
}

function openDialog() {
  error.value = ''
  // 默认选项目的第一条链——和不开链字段时后端的取法一致（pickChain 空串取 Chains[0]）。
  chain.value = props.chains[0]?.key ?? ''
  dialogOpen.value = true
}

function closeDialog() {
  if (busy.value) return
  dialogOpen.value = false
  context.value = ''
  source.value = 'web'
  chain.value = ''
  error.value = ''
}

async function submit() {
  if (!props.create) return
  error.value = ''
  if (context.value.trim() === '') {
    error.value = '先写需求正文（context），它是整条链的输入'
    return
  }
  busy.value = true
  try {
    await props.create({ context: context.value, source: source.value, chain: chain.value })
    busy.value = false
    closeDialog()
  } catch (e) {
    busy.value = false
    error.value = e instanceof Error ? e.message : String(e)
  }
}
</script>

<template>
  <section class="pane">
    <div class="pane__head">
      <h2 class="pane__title">
        {{ projectName || projectKey }} 的需求
        <span class="pane__hint">（{{ total }} 条）</span>
      </h2>
      <a-space size="small">
        <a-button size="small" type="text" @click="emit('retry')">
          <template #icon><IconRefresh /></template>
          刷新
        </a-button>
        <a-button v-if="create" type="primary" size="small" @click="openDialog">
          <template #icon><IconPlus /></template>
          新建需求
        </a-button>
      </a-space>
    </div>

    <div v-if="state === 'loading' && !requirements.length" class="state">
      <a-spin :size="20" />
      <span>正在读需求列表…</span>
    </div>

    <div v-else-if="state === 'error'" class="state">
      <a-alert type="error">{{ error || '读不到需求列表。' }}</a-alert>
      <a-button size="small" @click="emit('retry')">重试</a-button>
    </div>

    <a-table
      v-else
      :data="requirements"
      :columns="columns"
      row-key="id"
      :pagination="false"
      :bordered="{ cell: true }"
      size="small"
      class="req-table"
      @row-click="onRowClick"
    >
      <template #req="{ record }">
        <div class="stack" style="gap: 2px">
          <span class="mono strong">{{ record.id }}</span>
          <span class="pane__hint mono">{{ record.branch }}</span>
        </div>
      </template>
      <template #state="{ record }">
        <a-tag :color="stateColor(record.state)">{{ fmtState(record.state) }}</a-tag>
      </template>
      <!-- 当前站只留站号 + 中文名：状态词左边「状态」列已经写过一次，这里再写一遍就是同屏重复。 -->
      <template #cur="{ record }">
        <div v-if="currentOf(record)" class="row" style="gap: 6px; align-items: baseline">
          <span class="cur-n mono">{{ currentOf(record)!.index + 1 }}</span>
          <span class="cur-name">{{ fmtNodeName(currentOf(record)!.type) }}</span>
        </div>
        <span v-else class="pane__hint">全部通过</span>
      </template>
      <template #body="{ record }">
        <span class="ellipsis">{{ excerpt(record.context, 96) }}</span>
      </template>
      <template #prog="{ record }">
        <span class="mono pane__hint">{{ doneCount(record) }}/{{ record.nodes.length }} 站</span>
      </template>
      <template #time="{ record }">
        <span class="mono pane__hint">{{ fmtTime(record.updatedAt) }}</span>
      </template>
      <template #ops="{ record }">
        <a-button size="mini" type="text" aria-label="打开这条需求" @click.stop="emit('open', record.id)">
          <template #icon><IconRight /></template>
        </a-button>
      </template>
      <template #empty>
        <a-empty description="这个项目还没有需求：点右上角「新建需求」写正文，链条会从第一站开始跑。" />
      </template>
    </a-table>

    <a-modal
      v-model:visible="dialogOpen"
      title="新建需求"
      :mask-closable="!busy"
      :ok-loading="busy"
      ok-text="建立需求"
      cancel-text="取消"
      @ok="submit"
      @cancel="closeDialog"
    >
      <a-form :model="{ context, source }" layout="vertical">
        <a-form-item label="需求正文（context）">
          <a-textarea
            v-model="context"
            :auto-size="{ minRows: 5, maxRows: 10 }"
            placeholder="写清楚要做什么、验收标准是什么。这条正文会作为整条链的输入。"
          />
        </a-form-item>
        <a-form-item label="链条">
          <a-select v-model="chain" :disabled="busy">
            <a-option v-for="c in props.chains" :key="c.key" :value="c.key">
              {{ c.key }} · {{ chain2Path(c) }}
            </a-option>
          </a-select>
          <div class="pane__hint" style="margin-top: 4px">
            需求按这条链一站一站往下走，登进详情就定了，之后不能换链。
          </div>
        </a-form-item>
        <a-form-item label="来源">
          <a-input v-model="source" placeholder="web" allow-clear />
        </a-form-item>
        <a-alert v-if="error" type="error">{{ error }}</a-alert>
      </a-form>
    </a-modal>
  </section>
</template>
