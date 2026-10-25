<script setup lang="ts">
// 在途徽标：状态与尝试次数都照抄后端给的 pending 对象。
// 颜色只是视觉区分（stalled / failed / conflict 各自可辨），文字一律用后端的原始 status。
import { computed } from "vue";
import type { PendingAttempt } from "../types";

const props = defineProps<{ pending: PendingAttempt }>();

const color = computed<string>(() => {
  switch (props.pending.status) {
    case "stalled":
      return "warning";
    case "failed":
    case "conflict":
      return "error";
    case "applied":
      return "success";
    default:
      return "info";
  }
});

const attemptsText = computed<string>(() =>
  props.pending.attempts === null ? "尝试 ? 次" : "尝试 " + String(props.pending.attempts) + " 次",
);
</script>

<template>
  <v-chip size="x-small" variant="tonal" :color="color" class="pending-chip">
    在途：{{ pending.status ?? "(无 status)" }} · {{ attemptsText }}
  </v-chip>
</template>
