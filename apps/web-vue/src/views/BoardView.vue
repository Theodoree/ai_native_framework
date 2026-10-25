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
  <div class="board-layout">
    <section class="board-main">
      <FailureBanner :failure="state.boardFailure" title="看板加载失败" />
      <CreateItemForm />
      <div class="board-scroll">
        <p v-if="columns.length === 0" class="muted empty">
          声明里还没有 states。到「状态机」视图检查 state-machine.yml。
        </p>
        <div
          v-for="column in columns"
          :key="column.key"
          class="column"
          :class="{ terminal: column.terminal }"
        >
          <header class="column-head">
            <span class="column-name">{{ column.label }}</span>
            <span class="count">{{ column.items.length }}</span>
            <span v-if="column.terminal" class="chip chip-terminal">终态</span>
          </header>
          <p v-if="column.meaning !== ''" class="column-meaning">{{ column.meaning }}</p>
          <ItemCard
            v-for="(item, index) in column.items"
            :key="(item.id ?? 'item') + '-' + index"
            :item="item"
            :selected="item.id !== null && item.id === state.selectedId"
            @select="selectItem(item.id)"
          />
          <p v-if="column.items.length === 0" class="column-empty">空</p>
        </div>
      </div>
    </section>
    <aside class="side">
      <ItemDetailPanel />
      <VerifyPanel />
    </aside>
  </div>
</template>
