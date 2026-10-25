<script setup lang="ts">
import ConfigEditor from "../components/ConfigEditor.vue";
import StateMachineGraph from "../components/StateMachineGraph.vue";
import { usePlatform } from "../stores/platform";

const { state } = usePlatform();
</script>

<template>
  <div class="stack-layout">
    <section class="panel">
      <header class="panel-head">
        <h2>状态机图</h2>
        <span class="muted">
          由 config.states + config.transitions 生成（手写 SVG）；defaultFlow =
          {{ state.config.defaultFlow ?? "(未声明)" }} · labelPrefix =
          {{ state.config.labelPrefix === "" ? "(空)" : state.config.labelPrefix }}
        </span>
      </header>
      <StateMachineGraph :states="state.config.states" :transitions="state.config.transitions" />
    </section>
    <ConfigEditor />
  </div>
</template>
