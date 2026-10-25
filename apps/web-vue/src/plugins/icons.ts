// 内联 SVG 图标集：界面只在「下拉箭头 / 关闭 / 展开」这几处需要图标。
// 为几个字形装 @mdi/font（字体文件百余 kB）不划算，这里手写 24×24 路径。
import { h, type FunctionalComponent } from "vue";

function glyph(path: string): FunctionalComponent {
  return () =>
    h("svg", { xmlns: "http://www.w3.org/2000/svg", viewBox: "0 0 24 24", "aria-hidden": "true" }, [
      h("path", { d: path, fill: "currentColor" }),
    ]);
}

const CHEVRON_DOWN = "M7 10l5 5 5-5z";
const CHEVRON_UP = "M7 14l5-5 5 5z";
const CHEVRON_LEFT = "M14 7l-5 5 5 5z";
const CHEVRON_RIGHT = "M10 7l5 5-5 5z";
const CLOSE = "M18.3 5.7 12 12l6.3 6.3-1.4 1.4L10.6 13.4 4.3 19.7 2.9 18.3 9.2 12 2.9 5.7 4.3 4.3l6.3 6.3 6.3-6.3z";
const CHECK = "M9 16.2 4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4z";
const INFO = "M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20m1 15h-2v-6h2zm0-8h-2V7h2z";
const WARNING = "M1 21h22L12 2zm12-3h-2v-2h2zm0-4h-2v-4h2z";
const ERROR = "M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20m3.5 13.1-1.4 1.4L12 14.4l-2.1 2.1-1.4-1.4L10.6 13l-2.1-2.1 1.4-1.4L12 11.6l2.1-2.1 1.4 1.4L13.4 13z";
const SQUARE = "M19 5v14H5V5h14m0-2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2";
const MENU = "M3 6h18v2H3zm0 5h18v2H3zm0 5h18v2H3z";
const DOT = "M12 6a2 2 0 1 0 0 4 2 2 0 0 0 0-4m0 6a2 2 0 1 0 0 4 2 2 0 0 0 0-4";

// 键名取自 Vuetify 的 IconAliases；多给几个是为了组件内部（chip 关闭、panel 展开）不落空。
export const glyphs = {
  dropdown: glyph(CHEVRON_DOWN),
  menu: glyph(MENU),
  expand: glyph(CHEVRON_DOWN),
  collapse: glyph(CHEVRON_UP),
  subgroup: glyph(CHEVRON_DOWN),
  treeviewExpand: glyph(CHEVRON_DOWN),
  treeviewCollapse: glyph(CHEVRON_UP),
  prev: glyph(CHEVRON_LEFT),
  next: glyph(CHEVRON_RIGHT),
  first: glyph(CHEVRON_LEFT),
  last: glyph(CHEVRON_RIGHT),
  close: glyph(CLOSE),
  clear: glyph(CLOSE),
  delete: glyph(CLOSE),
  cancel: glyph(CLOSE),
  complete: glyph(CHECK),
  success: glyph(CHECK),
  checkboxOn: glyph(CHECK),
  checkboxOff: glyph(SQUARE),
  checkboxIndeterminate: glyph(SQUARE),
  sortAsc: glyph(CHEVRON_UP),
  sortDesc: glyph(CHEVRON_DOWN),
  delimiter: glyph(DOT),
  info: glyph(INFO),
  warning: glyph(WARNING),
  error: glyph(ERROR),
};
