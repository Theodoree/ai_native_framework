<script setup lang="ts">
import { computed } from "vue";
import TransitionForm from "./TransitionForm.vue";
import { usePlatform } from "../stores/platform";

const { state, selectedItem } = usePlatform();

const fields = computed<{ key: string; value: string }[]>(() => {
  const item = selectedItem.value;
  if (item === null) return [];
  return [
    { key: "id", value: item.id ?? "(缺失)" },
    { key: "title", value: item.title },
    { key: "state / to", value: item.state ?? "none" },
    { key: "updatedAt", value: item.updatedAt ?? "(缺失)" },
    { key: "body", value: item.body === "" ? "(空)" : item.body },
  ];
});

const rawJson = computed<string>(() => {
  const item = selectedItem.value;
  if (item === null) return "";
  try {
    const text = JSON.stringify(item.raw, null, 2);
    return text === undefined ? "(无法序列化)" : text;
  } catch {
    return "(无法序列化)";
  }
});

function close(): void {
  state.selectedId = null;
}
</script>

<template>
  <section class="panel detail">
    <header class="panel-head">
      <h2>详情</h2>
      <button v-if="selectedItem" type="button" class="btn btn-ghost" @click="close">关闭</button>
    </header>
    <p v-if="selectedItem === null" class="muted">点左侧卡片查看详情。</p>
    <template v-else>
      <dl class="fields">
        <template v-for="field in fields" :key="field.key">
          <dt>{{ field.key }}</dt>
          <dd>{{ field.value }}</dd>
        </template>
      </dl>
      <details class="raw">
        <summary>完整 JSON（折叠结果原样）</summary>
        <pre>{{ rawJson }}</pre>
      </details>
      <TransitionForm :item="selectedItem" />
    </template>
  </section>
</template>
