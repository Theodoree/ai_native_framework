<script setup lang="ts">
// 「同步」页：远端快照（GET /api/remote + POST /api/sync + POST /api/index/rebuild）
// 与在途台账（GET /api/outbox）同页，因为它们描述的是同一件事的两端。
import OutboxPanel from "../components/OutboxPanel.vue";
import RemotePanel from "../components/RemotePanel.vue";
</script>

<template>
  <v-container fluid class="pa-3">
    <RemotePanel />
    <OutboxPanel />
  </v-container>
</template>
