# web/ · 平台页面

## 做什么

一个静态页 + 原生 JS：看板、提需求、裁决、看证据、改声明。**无框架、无构建、无打包器。**

## 契约

- 页面只经 JSON API 说话，不直接读文件；后端换实现不用改页面。
- 接口列表与错误形状见 `scripts/README.md` 与 `scripts/server.mjs`。
- 页面不做任何状态合法性判断：按钮能不能点由 API 的 409/500 决定，避免两份判定逻辑。

## 状态

active —— 与 `scripts/server.mjs` 同源部署，随 `npm run platform` 一起起。
