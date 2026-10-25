<script setup lang="ts">
import { onMounted, ref } from "vue";
import BoardView from "./views/BoardView.vue";
import MachineView from "./views/MachineView.vue";
import TimelineView from "./views/TimelineView.vue";
import { usePlatform } from "./stores/platform";

type ViewKey = "board" | "machine" | "timeline";

const tabs: { key: ViewKey; label: string }[] = [
  { key: "board", label: "看板" },
  { key: "machine", label: "状态机" },
  { key: "timeline", label: "时间线" },
];

const { state, reloadAll } = usePlatform();
const view = ref<ViewKey>("board");

function refresh(): void {
  void reloadAll();
}

onMounted(() => {
  void reloadAll();
});
</script>

<template>
  <div class="app">
    <header class="topbar">
      <div class="brand">
        <span class="brand-title">需求状态与证据</span>
        <span class="brand-sub">state:* 是唯一状态；前端只呈现，不判定</span>
      </div>
      <nav class="tabs" aria-label="视图">
        <button
          v-for="tab in tabs"
          :key="tab.key"
          type="button"
          class="tab"
          :class="{ active: view === tab.key }"
          :aria-current="view === tab.key ? 'page' : undefined"
          @click="view = tab.key"
        >
          {{ tab.label }}
        </button>
      </nav>
      <div class="toolbar">
        <span v-if="state.boardLoading || state.eventsLoading || state.configLoading" class="muted">
          加载中…
        </span>
        <button type="button" class="btn" @click="refresh">刷新全部</button>
      </div>
    </header>
    <main class="content">
      <BoardView v-if="view === 'board'" />
      <MachineView v-else-if="view === 'machine'" />
      <TimelineView v-else />
    </main>
  </div>
</template>
