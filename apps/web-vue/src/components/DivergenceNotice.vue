<script setup lang="ts">
// 漂移只显式呈现后端给的 current / ledgerState 两个值，不做「哪个是对的」的判断。
import { computed } from "vue";

const props = defineProps<{
  current: string | null;
  ledgerState: string | null;
}>();

const text = computed<string>(
  () =>
    "远端说 " +
    (props.current ?? "(缺失)") +
    "，账本说 " +
    (props.ledgerState ?? "(缺失)") +
    "（divergence=true）",
);
</script>

<template>
  <v-alert
    type="warning"
    density="compact"
    variant="tonal"
    class="divergence-notice py-1"
  >
    <span class="text-caption">{{ text }}</span>
  </v-alert>
</template>
