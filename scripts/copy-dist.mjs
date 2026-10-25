// copy-dist.mjs · 把前端产物复制进 Go 的内嵌目录；没有产物时保留占位文件，不失败。
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE = join(ROOT, "apps", "web-vue", "dist");
const TARGET = join(ROOT, "apps", "api-go", "dist");
// 占位文件必须留在原地：删掉它们，没有前端产物时 go build 会失败。
const KEEP = new Set(["README.md", ".gitkeep"]);

// 只清理上一轮复制进来的产物，占位文件与目标目录本身不动。
function clearGenerated() {
  if (!existsSync(TARGET)) return;
  for (const name of readdirSync(TARGET)) {
    if (KEEP.has(name)) continue;
    rmSync(join(TARGET, name), { recursive: true, force: true });
  }
}

export function copyDist() {
  mkdirSync(TARGET, { recursive: true });
  if (!existsSync(join(SOURCE, "index.html"))) {
    console.log(
      "copy-dist: 没有 apps/web-vue/dist，保留占位文件（go build 仍可跑，页面不进二进制）",
    );
    return false;
  }
  clearGenerated();
  cpSync(SOURCE, TARGET, { recursive: true, force: true });
  console.log(
    `copy-dist: ${relative(ROOT, SOURCE)} → ${relative(ROOT, TARGET)}`,
  );
  return true;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  copyDist();
}
