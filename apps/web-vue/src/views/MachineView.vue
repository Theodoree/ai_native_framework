<script setup lang="ts">
import ConfigEditor from "../components/ConfigEditor.vue";
import StateMachineGraph from "../components/StateMachineGraph.vue";
import { usePlatform } from "../stores/platform";

const { state } = usePlatform();
</script>

<template>
  <v-container fluid class="pa-3">
    <v-card variant="flat" class="mb-3">
      <v-card-title class="text-body-2 py-2 font-weight-bold"
        >状态机图</v-card-title
      >
      <v-card-subtitle class="text-caption">
        由 config.states + config.transitions 生成（手写 SVG）；defaultFlow =
        {{ state.config.defaultFlow ?? "(未声明)" }} · labelPrefix =
        {{
          state.config.labelPrefix === "" ? "(空)" : state.config.labelPrefix
        }}
      </v-card-subtitle>
      <v-card-text class="pa-3">
        <StateMachineGraph
          :states="state.config.states"
          :transitions="state.config.transitions"
        />
      </v-card-text>
    </v-card>
    <ConfigEditor />
  </v-container>
</template>
