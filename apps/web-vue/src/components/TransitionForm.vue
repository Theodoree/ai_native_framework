<script setup lang="ts">
import { computed, ref, watch } from "vue";
import FailureBanner from "./FailureBanner.vue";
import { usePlatform } from "../stores/platform";
import type { BoardItem } from "../types";

const props = defineProps<{ item: BoardItem }>();
const { state, transitionsFor, roles, submitVerdict } = usePlatform();

const target = ref("");
const actorRole = ref("");
const comment = ref("");

// 候选只来自声明：与当前状态相关的 transitions（含通配 *）。合法性由后端判定。
const candidates = computed(() => transitionsFor(props.item.state));
const targets = computed<string[]>(() => {
  const list: string[] = [];
  for (const transition of candidates.value) {
    if (transition.to !== "" && !list.includes(transition.to))
      list.push(transition.to);
  }
  return list;
});
const chosenHints = computed(() =>
  candidates.value.filter((transition) => transition.to === target.value),
);

watch(
  targets,
  (list) => {
    if (!list.includes(target.value))
      target.value = list.length > 0 ? list[0] : "";
  },
  { immediate: true },
);

// 角色框可手填（v-combobox 的 items 只是建议）：合法角色集合属于后端知识，前端不锁死。
watch(
  roles,
  (list) => {
    if (actorRole.value === "" && list.length > 0) actorRole.value = list[0];
  },
  { immediate: true },
);

// 选中目标后，把该条转换声明的 by 填进角色框作为建议——用户仍可改成别的，改坏了由后端拒绝。
watch(target, () => {
  const declared = chosenHints.value.find(
    (transition) => transition.by !== "",
  )?.by;
  if (declared !== undefined && declared !== "") actorRole.value = declared;
});

async function submit(): Promise<void> {
  const id = props.item.id;
  if (id === null) return;
  await submitVerdict({
    id,
    to: target.value,
    actorRole: actorRole.value,
    comment: comment.value,
  });
}
</script>

<template>
  <div class="transition">
    <h3 class="text-body-2 font-weight-bold mb-1">流转</h3>
    <p class="text-caption text-medium-emphasis mb-2">
      目标状态取自声明的 transitions（含通配
      *）。是否允许、为什么不允许，全部由后端回答。
    </p>
    <v-select v-model="target" :items="targets" label="目标状态" />
    <v-combobox
      v-model="actorRole"
      :items="roles"
      label="actor_role（可手填）"
      placeholder="形如 ci / platform / owner / agent"
    />
    <v-textarea
      v-model="comment"
      label="comment"
      rows="3"
      placeholder="说明（声明要求时也别在本地拦，交给后端）"
    />
    <ul v-if="chosenHints.length > 0" class="hints">
      <li v-for="(hint, index) in chosenHints" :key="index">
        {{ hint.from }} → {{ hint.to }} · by
        {{ hint.by === "" ? "(未声明)" : hint.by }}
        <span v-if="hint.event !== ''"> · {{ hint.event }}</span>
        <v-chip
          v-if="hint.commentRequired"
          size="x-small"
          color="warning"
          variant="tonal"
          class="ms-1"
        >
          声明要求 comment
        </v-chip>
      </li>
    </ul>
    <v-btn
      color="primary"
      class="mt-2"
      :loading="state.verdict.pending"
      :disabled="item.id === null || target === ''"
      @click="submit"
    >
      提交流转
    </v-btn>
    <v-alert
      v-if="state.verdict.ok"
      type="success"
      variant="tonal"
      density="compact"
      class="mt-2"
    >
      已写入：{{ state.verdict.ok }}
    </v-alert>
    <FailureBanner
      :failure="state.verdict.failure"
      title="流转被拒绝（原样）"
    />
  </div>
</template>
