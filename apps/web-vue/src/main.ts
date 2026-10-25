import { createApp } from "vue";
import { vuetify } from "./plugins/vuetify";
import App from "./App.vue";
import "./styles/main.css";

// 顺序有意为之：vuetify/styles 在插件里先加载，main.css 只写 Vuetify 不管的少量样式。
createApp(App).use(vuetify).mount("#app");
