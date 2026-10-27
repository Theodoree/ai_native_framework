<script setup lang="ts">
import Icon from './Icon.vue'

withDefaults(
  defineProps<{ title: string; hint?: string; icon?: string }>(),
  { hint: '', icon: 'layers' },
)
</script>

<template>
  <div class="empty">
    <span class="empty__icon"><Icon :name="icon" :size="18" /></span>
    <p class="empty__title">{{ title }}</p>
    <p v-if="hint" class="empty__hint">{{ hint }}</p>
    <slot />
  </div>
</template>

<style scoped>
.empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  padding: 44px 24px;
  border: 1px dashed var(--border-strong);
  border-radius: var(--radius);
  background: var(--surface);
  text-align: center;
}

.empty__icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 34px;
  border-radius: 50%;
  background: var(--accent-soft);
  color: var(--accent);
}

.empty__title {
  font-size: 15px;
  font-weight: 600;
  color: var(--text);
}

.empty__hint {
  max-width: 44ch;
  color: var(--text-muted);
  font-size: var(--fs-body);
}
</style>
