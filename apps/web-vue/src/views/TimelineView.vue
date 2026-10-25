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
  return ordered.value.filter((event) =>
    (event.id ?? "").toLowerCase().includes(needle),
  );
});

function flowText(event: { from: string | null; to: string | null }): string {
  return (event.from ?? "?") + " → " + (event.to ?? "?");
}

function refresh(): void {
  void reloadEvents();
}
</script>

<template>
  <v-container fluid class="pa-3">
    <v-card variant="flat">
      <v-card-title class="d-flex align-center text-body-2 py-2">
        <span class="font-weight-bold">事件时间线</span>
        <span class="text-caption text-medium-emphasis ms-2">
          共 {{ state.events.length }} 条 · 倒序 · 显示 {{ visible.length }} 条
        </span>
        <v-spacer />
        <v-text-field
          v-model="filter"
          class="filter"
          type="search"
          label="按 id 过滤，如 REQ-1"
          @keydown.enter.prevent
        />
        <v-btn
          size="small"
          variant="tonal"
          class="ms-2"
          :loading="state.eventsLoading"
          @click="refresh"
        >
          刷新
        </v-btn>
      </v-card-title>
      <v-card-text class="pa-3 pt-0">
        <FailureBanner :failure="state.eventsFailure" title="事件加载失败" />
        <p
          v-if="visible.length === 0"
          class="text-caption text-medium-emphasis"
        >
          没有匹配的事件。
        </p>
        <ol v-else class="timeline">
          <li
            v-for="(event, index) in visible"
            :key="(event.id ?? 'evt') + '-' + index"
            class="timeline-item"
          >
            <div class="timeline-head">
              <span class="text-caption font-weight-medium">{{
                event.id ?? "(无 id)"
              }}</span>
              <span class="flow">{{ flowText(event) }}</span>
              <v-chip size="x-small" variant="tonal" color="secondary">
                {{ event.by ?? "(无 by)" }}
              </v-chip>
              <v-chip
                v-if="event.flow !== null"
                size="x-small"
                variant="outlined"
              >
                flow={{ event.flow }}
              </v-chip>
              <time class="text-caption text-medium-emphasis">{{
                event.at ?? "(无时间)"
              }}</time>
            </div>
            <p class="comment">
              {{
                event.comment === null || event.comment === ""
                  ? "(无 comment)"
                  : event.comment
              }}
            </p>
          </li>
        </ol>
      </v-card-text>
    </v-card>
  </v-container>
</template>
