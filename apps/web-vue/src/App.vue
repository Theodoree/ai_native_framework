<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
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

const loading = computed<boolean>(
  () => state.boardLoading || state.eventsLoading || state.configLoading,
);

function refresh(): void {
  void reloadAll();
}

onMounted(() => {
  void reloadAll();
});
</script>

<template>
  <!-- 三视图是同级平铺，没有层级：用 app-bar + tabs，不用 navigation-drawer
       （抽屉要占一列宽度，看板本来就要横向空间，且只有三个入口，抽屉是浪费）。 -->
  <v-app>
    <v-app-bar flat density="compact" color="surface" class="px-2">
      <div class="d-flex align-baseline me-4">
        <span class="text-body-2 font-weight-bold">需求状态与证据</span>
        <span class="text-caption text-medium-emphasis ms-3 d-none d-md-inline">
          state:* 是唯一状态；前端只呈现，不判定
        </span>
      </div>
      <v-tabs v-model="view" color="primary" density="compact" aria-label="视图">
        <v-tab v-for="tab in tabs" :key="tab.key" :value="tab.key">{{ tab.label }}</v-tab>
      </v-tabs>
      <v-spacer />
      <span v-if="loading" class="text-caption text-medium-emphasis me-3">加载中…</span>
      <v-btn variant="tonal" size="small" class="me-2" :disabled="loading" @click="refresh">
        刷新全部
      </v-btn>
    </v-app-bar>
    <v-main>
      <BoardView v-if="view === 'board'" />
      <MachineView v-else-if="view === 'machine'" />
      <TimelineView v-else />
    </v-main>
  </v-app>
</template>
