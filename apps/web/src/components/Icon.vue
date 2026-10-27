<script setup lang="ts">
withDefaults(defineProps<{ name: string; size?: number }>(), { size: 14 })
</script>

<template>
  <svg
    :width="size"
    :height="size"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
    focusable="false"
  >
    <template v-if="name === 'plus'"><path d="M12 5v14M5 12h14" /></template>
    <template v-else-if="name === 'refresh'">
      <path d="M20 12a8 8 0 1 1-2.3-5.6" />
      <path d="M20 4v5h-5" />
    </template>
    <template v-else-if="name === 'back'"><path d="M15 18l-6-6 6-6" /></template>
    <template v-else-if="name === 'branch'">
      <path d="M6 4v12" />
      <circle cx="18" cy="6" r="2.5" />
      <circle cx="6" cy="19" r="2.5" />
      <path d="M18 8.5a8 8 0 0 1-8 8" />
    </template>
    <template v-else-if="name === 'shield'">
      <path d="M12 3l7 3v6c0 4.2-3 7.4-7 9-4-1.6-7-4.8-7-9V6z" />
    </template>
    <template v-else-if="name === 'terminal'">
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M8 10l2.5 2.5L8 15M13.5 15H17" />
    </template>
    <template v-else-if="name === 'layers'">
      <path d="M12 3l9 4.5-9 4.5-9-4.5z" />
      <path d="M3 12.5L12 17l9-4.5" />
    </template>
    <template v-else-if="name === 'folder'">
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h6a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
    </template>
    <template v-else-if="name === 'dot'">
      <circle cx="12" cy="12" r="4" fill="currentColor" stroke="none" />
    </template>
    <template v-else-if="name === 'alert'">
      <path d="M12 8v5M12 16.5v.5" />
      <path d="M10.3 3.9L2.6 17a2 2 0 0 0 1.7 3h15.4a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />
    </template>
  </svg>
</template>
