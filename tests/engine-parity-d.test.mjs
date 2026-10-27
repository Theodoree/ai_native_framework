import { defineParitySuite } from "./helpers/parity-suite.mjs";
import { suiteD } from "./goldens/parity-cases.mjs";

// P-31 迁移的验收闸门：**只跑 Go 引擎**，与 tests/goldens/ 里冻结的期望值逐字节比。
// 期望值来自 scripts/*.mjs 曾经的输出，冻结后就是数据 —— 本文件不执行任何 Node 侧脚本，
// 所以删掉 scripts/ 不再是这条闸门的障碍物。
// 重新冻结是显式动作：node tests/goldens/freeze.mjs d
defineParitySuite(suiteD);
