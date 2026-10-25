<script setup lang="ts">
import DivergenceNotice from "./DivergenceNotice.vue";
import PendingBadge from "./PendingBadge.vue";
import type { BoardItem } from "../types";

defineProps<{ item: BoardItem; selected: boolean }>();
const emit = defineEmits<{ select: [] }>();
</script>

<template>
  <v-card
    variant="outlined"
    :color="selected ? 'primary' : undefined"
    class="mb-2"
    role="button"
    tabindex="0"
    @click="emit('select')"
    @keydown.enter.prevent="emit('select')"
  >
    <v-card-text class="pa-2">
      <div class="d-flex align-center justify-space-between">
        <span class="text-caption font-weight-medium">{{
          item.id ?? "(无 id)"
        }}</span>
        <v-chip size="x-small" variant="tonal" color="secondary">{{
          item.state ?? "none"
        }}</v-chip>
      </div>
      <p class="text-body-2 my-1">{{ item.title }}</p>
      <!-- 漂移必须显式标出：远端态与账本态都写出来，不悄悄选一个。 -->
      <DivergenceNotice
        v-if="item.divergence"
        :current="item.current"
        :ledger-state="item.ledgerState"
        class="my-1"
      />
      <div v-if="item.pending" class="my-1">
        <PendingBadge :pending="item.pending" />
      </div>
      <p class="text-caption text-medium-emphasis">
        {{ item.updatedAt ?? "(无时间)" }}
      </p>
    </v-card-text>
  </v-card>
</template>
