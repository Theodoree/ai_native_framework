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
    if (transition.to !== "" && !list.includes(transition.to)) list.push(transition.to);
  }
  return list;
});
const chosenHints = computed(() => candidates.value.filter((transition) => transition.to === target.value));

watch(
  targets,
  (list) => {
    if (!list.includes(target.value)) target.value = list.length > 0 ? list[0] : "";
  },
  { immediate: true },
);

// 角色是可手填的（datalist 只给建议）：合法的角色集合属于后端知识，前端不锁死。
watch(
  roles,
  (list) => {
    if (actorRole.value === "" && list.length > 0) actorRole.value = list[0];
  },
  { immediate: true },
);

// 选中目标后，把该条转换声明的 by 填进角色框作为建议——用户仍可改成别的，改坏了由后端拒绝。
watch(target, () => {
  const declared = chosenHints.value.find((transition) => transition.by !== "")?.by;
  if (declared !== undefined && declared !== "") actorRole.value = declared;
});

async function submit(): Promise<void> {
  const id = props.item.id;
  if (id === null) return;
  await submitVerdict({ id, to: target.value, actorRole: actorRole.value, comment: comment.value });
}
</script>

<template>
  <section class="transition">
    <h3>流转</h3>
    <p class="muted hint">
      目标状态取自声明的 transitions（含通配 *）。是否允许、为什么不允许，全部由后端回答。
    </p>
    <label class="field">
      <span>目标状态</span>
      <select v-model="target">
        <option v-for="to in targets" :key="to" :value="to">{{ to }}</option>
      </select>
    </label>
    <label class="field">
      <span>actor_role（可手填）</span>
      <input v-model="actorRole" list="role-options" placeholder="ci / platform / owner / proposer / agent" />
      <datalist id="role-options">
        <option v-for="role in roles" :key="role" :value="role"></option>
      </datalist>
    </label>
    <label class="field">
      <span>comment</span>
      <textarea v-model="comment" rows="3" placeholder="说明（声明要求时也别在本地拦，交给后端）"></textarea>
    </label>
    <ul v-if="chosenHints.length > 0" class="hints">
      <li v-for="(hint, index) in chosenHints" :key="index">
        {{ hint.from }} → {{ hint.to }} · by {{ hint.by === "" ? "(未声明)" : hint.by }}
        <span v-if="hint.event !== ''"> · {{ hint.event }}</span>
        <span v-if="hint.commentRequired" class="chip chip-warn">声明要求 comment</span>
      </li>
    </ul>
    <button
      type="button"
      class="btn btn-primary"
      :disabled="state.verdict.pending || item.id === null || target === ''"
      @click="submit"
    >
      {{ state.verdict.pending ? "提交中…" : "提交流转" }}
    </button>
    <p v-if="state.verdict.ok" class="ok">已写入：{{ state.verdict.ok }}</p>
    <FailureBanner :failure="state.verdict.failure" title="流转被拒绝（原样）" />
  </section>
</template>
