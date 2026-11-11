/**
 * snow-rate-pills 口径自检
 *
 * 只提取脚本里 `#region pure` 与 `#endregion pure` 之间的纯函数，在 vm 里执行，
 * 覆盖：时间格式化、七种范围预设（含跨年）、summary 归一、数字格式化、坐标夹取、光效档位、顶栏落位判定、状态归一。
 *
 * 运行：node snow-rate-pills/selftest.mjs
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.join(here, "snow-rate-pills.user.js"), "utf8");

const START = "/* #region pure */";
const END = "/* #endregion pure */";
const startAt = source.indexOf(START);
const endAt = source.indexOf(END);
if (startAt < 0 || endAt < 0) {
  console.error("未找到纯函数区标记");
  process.exit(1);
}

const code = source.slice(startAt + START.length, endAt);
const lib = new Function(
  code +
    "\nreturn { SRP_PRESETS, SRP_INTERVALS, SRP_TICK_LEVELS, SRP_DEFAULT_TICK_MS, METRIC_FORMAT, srpPad2, srpFormatLocal, srpRangeFor, srpSummarize, srpFmtInt, srpFmtCompact, srpClamp, srpClampPosition, srpLayoutPills, srpNeedsTopBarMove, srpNormalizeInterval, srpIntervalLabel, srpNormalizeTickMs, srpTweenMs, srpTickLabel, srpNormalizeState };",
)();

let passed = 0;
const failures = [];

function check(name, condition, detail) {
  if (condition) {
    passed += 1;
    return;
  }
  failures.push(name + (detail ? " — " + detail : ""));
}

function eq(name, actual, expected) {
  check(name, Object.is(actual, expected), "期望 " + String(expected) + "，实际 " + String(actual));
}

/* ---------- 时间 ---------- */

eq("pad2 补零", lib.srpPad2(7), "07");
const now = new Date(2026, 10, 10, 18, 30, 0).getTime();
eq("formatLocal 到分钟", lib.srpFormatLocal(now), "2026-11-10 18:30");

/* ---------- 范围预设 ---------- */

eq("预设数量", lib.SRP_PRESETS.length, 7);
eq("today 起点", lib.srpRangeFor("today", now).sinceMs, new Date(2026, 10, 10).getTime());
eq("today 终点跟随现在", lib.srpRangeFor("today", now).untilMs, now);
eq("yesterday 起点", lib.srpRangeFor("yesterday", now).sinceMs, new Date(2026, 10, 9).getTime());
eq("yesterday 终点", lib.srpRangeFor("yesterday", now).untilMs, new Date(2026, 10, 9, 23, 59, 59).getTime());
eq("d7 起点", lib.srpRangeFor("d7", now).sinceMs, new Date(2026, 10, 4).getTime());
eq("d30 起点", lib.srpRangeFor("d30", now).sinceMs, new Date(2026, 9, 12).getTime());
eq("month 起点", lib.srpRangeFor("month", now).sinceMs, new Date(2026, 10, 1).getTime());
eq("lastMonth 起点", lib.srpRangeFor("lastMonth", now).sinceMs, new Date(2026, 9, 1).getTime());
eq("lastMonth 终点", lib.srpRangeFor("lastMonth", now).untilMs, new Date(2026, 9, 31, 23, 59, 59).getTime());
eq("all 起点", lib.srpRangeFor("all", now).sinceMs, new Date(1970, 0, 1).getTime());
eq("未知预设回退 today", lib.srpRangeFor("nope", now).sinceMs, new Date(2026, 10, 10).getTime());

const jan = new Date(2026, 0, 15, 9, 0, 0).getTime();
const lastDec = lib.srpRangeFor("lastMonth", jan);
eq("跨年 lastMonth 起点", lastDec.sinceMs, new Date(2025, 11, 1).getTime());
eq("跨年 lastMonth 终点", lastDec.untilMs, new Date(2025, 11, 31, 23, 59, 59).getTime());

/* ---------- summary 与格式化 ---------- */

eq("空 summary 返回 null", lib.srpSummarize(null), null);
const sum = lib.srpSummarize({ totalRequests: 3, totalInputTokens: 1000, totalOutputTokens: 50 });
eq("请求数", sum.requests, 3);
eq("合计 = 输入 + 输出", sum.total, 1050);
const partial = lib.srpSummarize({ totalRequests: 1 });
eq("缺 token 字段按 0", partial.total, 0);

eq("fmtInt 千分位", lib.srpFmtInt(1234567), "1,234,567");
eq("fmtInt 空值", lib.srpFmtInt(null), "—");
eq("fmtCompact 千级", lib.srpFmtCompact(15000), "15k");
eq("fmtCompact 百万", lib.srpFmtCompact(1234567), "1.23M");
eq("fmtCompact 十亿", lib.srpFmtCompact(1000000000), "1B");
eq("fmtCompact 空值", lib.srpFmtCompact(null), "—");

/* ---------- 胶囊格式化映射（滚动动画每帧使用） ---------- */

eq("RPD 用千分位", lib.METRIC_FORMAT.rpd(1234567), "1,234,567");
eq("TPD 用紧凑", lib.METRIC_FORMAT.tpd(15000), "15k");
eq("RPM 用千分位", lib.METRIC_FORMAT.rpm(42), "42");
eq("ITPM 用紧凑", lib.METRIC_FORMAT.itpm(1234567), "1.23M");
eq("OTPM 用紧凑", lib.METRIC_FORMAT.otpm(870), "870");
eq("映射覆盖五颗指标", Object.keys(lib.METRIC_FORMAT).length, 5);

/* ---------- 坐标夹取 ---------- */

eq("clamp 区间内", lib.srpClamp(50, 0, 100), 50);
eq("clamp 下界", lib.srpClamp(-5, 0, 100), 0);
eq("clamp 上界", lib.srpClamp(120, 0, 100), 100);
eq("clamp 上限小于下限时取下限", lib.srpClamp(5, 10, 4), 10);

const inside = lib.srpClampPosition(100, 80, 90, 24, 1200, 800);
eq("位置保持不变", inside.x + "," + inside.y, "100,80");
const negative = lib.srpClampPosition(-40, -10, 90, 24, 1200, 800);
eq("负坐标夹到 8", negative.x + "," + negative.y, "8,8");
const overflow = lib.srpClampPosition(5000, 5000, 90, 24, 1200, 800);
eq("超出视口夹回", overflow.x + "," + overflow.y, "1102,768");
const small = lib.srpClampPosition(10, 10, 200, 40, 150, 30);
eq("视口小于胶囊时贴左上", small.x + "," + small.y, "8,8");

/* ---------- 顶部居中排布 ---------- */

const sixWidths = [100, 100, 100, 100, 100, 100];
const wide = lib.srpLayoutPills(sixWidths, {
  gap: 8,
  top: 56,
  lineHeight: 30,
  sidePadding: 8,
  viewportWidth: 1200,
});
eq("宽窗口排成一行", Object.keys(wide).length, 6);
eq("首颗水平居中", wide[0].x, 280);
eq("同行同一 y", wide[0].y, 56);
eq("末颗 x 累加间距", wide[5].x, 820);
eq("行高不叠加", wide[5].y, 56);

const narrow = lib.srpLayoutPills(sixWidths, {
  gap: 8,
  top: 56,
  lineHeight: 30,
  sidePadding: 8,
  viewportWidth: 400,
});
eq("窄窗口换行成两排", narrow[0].y + "," + narrow[3].y, "56,86");
eq("第一排居中", narrow[0].x, 42);
eq("第二排独立居中", narrow[3].x, 42);

const single = lib.srpLayoutPills([90], {
  gap: 8,
  top: 40,
  lineHeight: 30,
  sidePadding: 8,
  viewportWidth: 300,
});
eq("单颗居中", single[0].x + "," + single[0].y, "105,40");

const tooWide = lib.srpLayoutPills([600, 600], {
  gap: 8,
  top: 56,
  lineHeight: 30,
  sidePadding: 8,
  viewportWidth: 320,
});
eq("超宽胶囊各自成行", tooWide[0].y + "," + tooWide[1].y, "56,86");
eq("超宽时贴左边距", tooWide[0].x, 8);

/* ---------- 刷新速度 ---------- */

const ALL_KEYS = ["rpd", "tpd", "rpm", "itpm", "otpm", "range"];

eq("速度档位数量", lib.SRP_INTERVALS.length, 6);
eq("最快档是 1 秒", lib.SRP_INTERVALS[0], 1000);
eq("默认速度 10 秒", lib.srpNormalizeInterval(undefined), 10000);
eq("接受合法档位", lib.srpNormalizeInterval(2000), 2000);
eq("接受实时档", lib.srpNormalizeInterval(1000), 1000);
eq("非法档位回退默认", lib.srpNormalizeInterval(777), 10000);
eq("数字字符串按数值接受", lib.srpNormalizeInterval("5000"), 5000);
eq("状态里带速度", lib.srpNormalizeState({ intervalMs: 5000 }, ALL_KEYS).intervalMs, 5000);
eq("状态缺速度时用默认", lib.srpNormalizeState(null, ALL_KEYS).intervalMs, 10000);

/* ---------- 状态归一 ---------- */

const fallback = lib.srpNormalizeState(null, ALL_KEYS);
eq("默认范围", fallback.range, "today");
eq("默认无坐标", Object.keys(fallback.pos).length, 0);
eq("默认全部显示", Object.keys(fallback.off).length, 0);

const loaded = lib.srpNormalizeState(
  {
    range: "d30",
    off: { rpd: true, tpd: false },
    pos: { rpd: { x: 10, y: 20, auto: true }, tpd: { x: "bad", y: 1 }, broken: null },
  },
  ALL_KEYS,
);
eq("读取范围", loaded.range, "d30");
eq("读取逐颗隐藏", loaded.off.rpd, true);
eq("false 不入隐藏集合", Object.prototype.hasOwnProperty.call(loaded.off, "tpd"), false);
eq("读取有效坐标", loaded.pos.rpd.x + "," + loaded.pos.rpd.y, "10,20");
eq("保留自动排布标记", loaded.pos.rpd.auto, true);
eq("丢弃非法坐标", Object.prototype.hasOwnProperty.call(loaded.pos, "tpd"), false);
eq("丢弃空条目", Object.prototype.hasOwnProperty.call(loaded.pos, "broken"), false);
eq(
  "非法 auto 视为手动",
  lib.srpNormalizeState({ pos: { rpd: { x: 1, y: 2, auto: "yes" } } }, ALL_KEYS).pos.rpd.auto,
  false,
);

const legacy = lib.srpNormalizeState({ hidden: true }, ALL_KEYS);
eq("旧整体隐藏展开成逐颗", legacy.off.rpd === true && legacy.off.range === true, true);
eq("无 keys 时忽略旧隐藏字段", Object.keys(lib.srpNormalizeState({ hidden: true }).off).length, 0);

eq("非法范围回退", lib.srpNormalizeState({ range: "nope" }, ALL_KEYS).range, "today");
eq("非对象输入回退", lib.srpNormalizeState("bad", ALL_KEYS).range, "today");

/* ---------- 顶栏落位判定 ---------- */

const hostA = { id: "a" };
const hostB = { id: "b" };
eq("位置已对不搬动（before）", lib.srpNeedsTopBarMove("before", hostA, null, hostB, hostB, hostA), false);
eq("锚点换成别的兄弟才搬动（before）", lib.srpNeedsTopBarMove("before", hostA, null, hostB, hostA, hostA), true);
eq("父级不同要搬动（before）", lib.srpNeedsTopBarMove("before", hostB, null, hostA, hostB, hostA), true);
eq("位置已对不搬动（after）", lib.srpNeedsTopBarMove("after", hostA, hostB, null, hostB, hostA), false);
eq("锚点被换掉后要重新落位（after）", lib.srpNeedsTopBarMove("after", hostA, null, null, hostB, hostA), true);
eq("插槽内已存在不重复追加", lib.srpNeedsTopBarMove("append", hostA, null, null, hostA, hostB), false);
eq("插槽换容器才搬动", lib.srpNeedsTopBarMove("append", hostA, null, null, hostB, hostA), true);

/* ---------- 刷新速度档位 ---------- */

eq("实时档读数", lib.srpIntervalLabel(1000), "实时 · 1 秒");
eq("秒档读数", lib.srpIntervalLabel(10000), "10 秒");
eq("非法值回退默认档读数", lib.srpIntervalLabel(1234), "10 秒");

/* ---------- 光效档位 ---------- */

eq("档位共 5 档", lib.SRP_TICK_LEVELS.length, 5);
eq("最短档 3 秒", lib.SRP_TICK_LEVELS[0], 3000);
eq("最高档为持续", lib.SRP_TICK_LEVELS[lib.SRP_TICK_LEVELS.length - 1], 0);
eq("默认档 3 秒", lib.SRP_DEFAULT_TICK_MS, 3000);
eq("缺省走默认档", lib.srpNormalizeTickMs(undefined), 3000);
eq("非数字走默认档", lib.srpNormalizeTickMs("abc"), 3000);
eq("合法档位原样保留", lib.srpNormalizeTickMs(8000), 8000);
eq("0 表示持续不停", lib.srpNormalizeTickMs(0), 0);
eq("负数也算持续", lib.srpNormalizeTickMs(-100), 0);
eq("低于最短档吸附到 3 秒", lib.srpNormalizeTickMs(1200), 3000);
eq("中间值吸附到最近档", lib.srpNormalizeTickMs(4200), 5000);
eq("超过最高时长吸附到 12 秒", lib.srpNormalizeTickMs(99999), 12000);
eq("滚动时长取 35%", lib.srpTweenMs(5000), 1750);
eq("持续档滚动时长按 3 秒算", lib.srpTweenMs(0), 1050);
eq("读数（秒）", lib.srpTickLabel(5000), "5 秒");
eq("读数（持续）", lib.srpTickLabel(0), "持续不停");
eq("状态读取档位", lib.srpNormalizeState({ tickMs: 8000 }, ALL_KEYS).tickMs, 8000);
eq("状态里 0 为持续", lib.srpNormalizeState({ tickMs: 0 }, ALL_KEYS).tickMs, 0);
eq("旧状态无该字段走默认档", lib.srpNormalizeState({ range: "today" }, ALL_KEYS).tickMs, 3000);
eq("状态里非法值回退默认档", lib.srpNormalizeState({ tickMs: "x" }, ALL_KEYS).tickMs, 3000);

/* ---------- 汇总 ---------- */

if (failures.length) {
  console.error("失败 " + failures.length + " 项：");
  for (const item of failures) console.error("  - " + item);
  process.exit(1);
}
console.log("全部通过：" + passed + " 项");