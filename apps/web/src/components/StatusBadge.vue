<script setup lang="ts">
import { computed } from 'vue'
import { fmtState } from '../format'

const props = defineProps<{ state: string }>()
const label = computed(() => fmtState(props.state))
</script>

<template>
  <span class="badge" :class="`badge--${state}`">{{ label }}</span>
</template>
