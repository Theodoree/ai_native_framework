<script setup lang="ts">
/**
 * 事件流：默认收起，展开后是一张等宽表格（时间只到秒）。
 * 骨架用 Arco Collapse，数据用 Arco Table；表格里不写状态色块以外的装饰。
 */
import { ref } from 'vue'
import type { TableColumnData } from '@arco-design/web-vue'
import type { ChainEvent } from '../types'
import { fmtAction, fmtState, fmtTime, stateColor } from '../format'

const props = defineProps<{ events: ChainEvent[] }>()

/** 收起是默认：详情页的主角是链路，事件流是审计底稿，要时再展开。 */
const activeKeys = ref<(string | number)[]>([])

const columns: TableColumnData[] = [
  // 字号升到 16px 后，时间（19 个等宽字符 ≈ 165px）与中文动作都会换行成两截：
  // 前三列必须给足宽度且 nowrap，剩下的宽度留给「详情」。
  { title: '时间', dataIndex: 'at', slotName: 'at', width: 178 },
  { title: '节点', dataIndex: 'node', slotName: 'node', width: 96 },
  { title: '动作', dataIndex: 'action', slotName: 'action', width: 112 },
  { title: '状态变化', dataIndex: 'from', slotName: 'from', width: 168 },
  { title: '详情', dataIndex: 'detail', slotName: 'detail' },
]
</script>

<template>
  <a-collapse v-model:active-key="activeKeys" :bordered="true" class="events">
    <a-collapse-item key="events" :header="'事件流（' + props.events.length + '）'">
      <a-table
        :data="props.events"
        :columns="columns"
        :pagination="false"
        size="mini"
        :bordered="false"
      >
        <template #at="{ record }"><span class="mono events__time">{{ fmtTime(record.at) }}</span></template>
        <template #node="{ record }"><span class="mono events__cell">{{ record.node || '—' }}</span></template>
        <template #action="{ record }"><span class="events__cell">{{ fmtAction(record.action) }}</span></template>
        <template #from="{ record }">
          <span class="row" style="gap: 4px">
            <a-tag v-if="record.from" size="small" :color="stateColor(record.from)">{{ fmtState(record.from) }}</a-tag>
            <span v-if="record.from || record.to" class="pane__hint">→</span>
            <a-tag v-if="record.to" size="small" :color="stateColor(record.to)">{{ fmtState(record.to) }}</a-tag>
            <span v-if="!record.from && !record.to">—</span>
          </span>
        </template>
        <template #detail="{ record }">
          <span class="events__detail">{{ record.detail || '—' }}</span>
        </template>
        <template #empty>
          <span class="pane__hint">还没有事件。</span>
        </template>
      </a-table>
    </a-collapse-item>
  </a-collapse>
</template>
