<script setup lang="ts">
import type { BoardItem } from "../types";

defineProps<{ item: BoardItem; selected: boolean }>();
const emit = defineEmits<{ select: [] }>();
</script>

<template>
  <article
    class="card"
    :class="{ selected }"
    role="button"
    tabindex="0"
    @click="emit('select')"
    @keydown.enter.prevent="emit('select')"
  >
    <div class="card-row">
      <span class="item-id">{{ item.id ?? "(无 id)" }}</span>
      <span class="item-state">{{ item.state ?? "none" }}</span>
    </div>
    <p class="card-title">{{ item.title }}</p>
    <p class="card-time">{{ item.updatedAt ?? "(无时间)" }}</p>
  </article>
</template>
