<script setup lang="ts">
import { computed, ref } from "vue";
import FailureBanner from "../components/FailureBanner.vue";
import { usePlatform } from "../stores/platform";

const { state, reloadEvents } = usePlatform();
const filter = ref("");

// 按时间倒序；同一时间戳时用「后写入的在前」，避免顺序抖动。
const ordered = computed(() => {
  const indexed = state.events.map((event, index) => ({ event, index }));
  indexed.sort((left, right) => {
    const atLeft = left.event.at ?? "";
    const atRight = right.event.at ?? "";
    if (atLeft !== atRight) return atRight.localeCompare(atLeft);
    return right.index - left.index;
  });
  return indexed.map((entry) => entry.event);
});

const visible = computed(() => {
  const needle = filter.value.trim().toLowerCase();
  if (needle === "") return ordered.value;
  return ordered.value.filter((event) => (event.id ?? "").toLowerCase().includes(needle));
});

function flowText(event: { from: string | null; to: string | null }): string {
  return (event.from ?? "?") + " → " + (event.to ?? "?");
}

function refresh(): void {
  void reloadEvents();
}
</script>

<template>
  <div class="stack-layout">
    <section class="panel">
      <header class="panel-head">
        <h2>事件时间线</h2>
        <span class="muted">共 {{ state.events.length }} 条 · 倒序 · 显示 {{ visible.length }} 条</span>
        <input v-model="filter" class="input filter" type="search" placeholder="按 id 过滤，如 REQ-1" />
        <button type="button" class="btn" :disabled="state.eventsLoading" @click="refresh">
          {{ state.eventsLoading ? "加载中…" : "刷新" }}
        </button>
      </header>
      <FailureBanner :failure="state.eventsFailure" title="事件加载失败" />
      <p v-if="visible.length === 0" class="muted empty">没有匹配的事件。</p>
      <ol v-else class="timeline">
        <li
          v-for="(event, index) in visible"
          :key="(event.id ?? 'evt') + '-' + index"
          class="timeline-item"
        >
          <div class="timeline-head">
            <span class="item-id">{{ event.id ?? "(无 id)" }}</span>
            <span class="flow">{{ flowText(event) }}</span>
            <span class="chip">{{ event.by ?? "(无 by)" }}</span>
            <span v-if="event.flow !== null" class="chip chip-muted">flow={{ event.flow }}</span>
            <time class="muted">{{ event.at ?? "(无时间)" }}</time>
          </div>
          <p class="comment">
            {{ event.comment === null || event.comment === "" ? "(无 comment)" : event.comment }}
          </p>
        </li>
      </ol>
    </section>
  </div>
</template>
