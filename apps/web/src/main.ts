import { createApp } from 'vue'
import ArcoVue from '@arco-design/web-vue'
import '@arco-design/web-vue/dist/arco.css'
// 自己的样式放在 arco.css 之后：主题变量与链路自绘都要压过组件默认值。
import './styles/app.css'
import App from './App.vue'

createApp(App).use(ArcoVue).mount('#app')
