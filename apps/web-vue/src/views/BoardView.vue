<script setup lang="ts">
import CreateItemForm from "../components/CreateItemForm.vue";
import FailureBanner from "../components/FailureBanner.vue";
import ItemCard from "../components/ItemCard.vue";
import ItemDetailPanel from "../components/ItemDetailPanel.vue";
import VerifyPanel from "../components/VerifyPanel.vue";
import { usePlatform } from "../stores/platform";

const { state, columns, selectItem } = usePlatform();
</script>

<template>
  <v-container fluid class="pa-3">
    <FailureBanner :failure="state.boardFailure" title="看板加载失败" />
    <CreateItemForm />
    <v-row dense>
      <v-col cols="12" lg="9">
        <p
          v-if="columns.length === 0"
          class="text-caption text-medium-emphasis mb-3"
        >
          声明里还没有 states。到「状态机」视图检查 state-machine.yml。
        </p>
        <!-- 一列一卡：九列状态不做成表格（列数不定、卡片要能点选），用栅格 + 卡片。 -->
        <v-row dense>
          <v-col
            v-for="column in columns"
            :key="column.key"
            cols="12"
            sm="6"
            md="4"
            xl="3"
          >
            <v-card variant="flat" class="d-flex flex-column h-100">
              <v-card-title class="d-flex align-center text-body-2 py-2">
                <span class="font-weight-bold">{{ column.label }}</span>
                <v-chip size="x-small" variant="tonal" class="ms-2">
                  {{ column.items.length }}
                </v-chip>
                <v-spacer />
                <v-chip
                  v-if="column.terminal"
                  size="x-small"
                  color="terminal"
                  variant="tonal"
                >
                  终态
                </v-chip>
              </v-card-title>
              <v-card-subtitle
                v-if="column.meaning !== ''"
                class="text-caption py-1"
              >
                {{ column.meaning }}
              </v-card-subtitle>
              <v-card-text class="pa-2 board-column-body">
                <ItemCard
                  v-for="(item, index) in column.items"
                  :key="(item.id ?? 'item') + '-' + index"
                  :item="item"
                  :selected="item.id !== null && item.id === state.selectedId"
                  @select="selectItem(item.id)"
                />
                <p
                  v-if="column.items.length === 0"
                  class="text-caption text-medium-emphasis"
                >
                  空
                </p>
              </v-card-text>
            </v-card>
          </v-col>
        </v-row>
      </v-col>
      <v-col cols="12" lg="3">
        <ItemDetailPanel />
        <VerifyPanel />
      </v-col>
    </v-row>
  </v-container>
</template>
