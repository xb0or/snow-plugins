/**
 * snow-rate-limits 口径自检
 *
 * 覆盖：
 *   1) 本地时间串与 epoch 互转、格式化；
 *   2) 时间范围预设（含跨月、跨年）与自定义日期校验；
 *   3) 峰值窗口判定、summary 口径、单位速率折算；
 *   4) 明细峰值（分钟桶最大输入/输出、同一秒最大请求数）；
 *   5) 视图归一化；
 *   6) 首帧渲染冒烟（最小 React 桩 + 假 api，五行指标各三格）。
 *
 * 运行：node snow-rate-limits/selftest.mjs
 */

import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const lib = await import("file:///" + path.join(here, "index.js").replace(/\\/g, "/"));

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

/* ---------- 1. 时间 ---------- */

eq("pad2 补零", lib.pad2(7), "07");

const now = new Date(2026, 10, 10, 18, 30, 0).getTime();
eq("formatLocal 格式", lib.formatLocal(now), "2026-11-10 18:30:00");
eq("parseLocal 回环", lib.parseLocal("2026-11-10 18:30:00"), now);
eq("parseLocal 容忍 T 分隔", lib.parseLocal("2026-11-10T18:30:00"), now);
eq("parseLocal 缺秒按 0", lib.parseLocal("2026-11-10 18:30"), new Date(2026, 10, 10, 18, 30, 0).getTime());
eq("parseLocal 非法返回 NaN", Number.isNaN(lib.parseLocal("not-a-time")), true);
eq("fmtClock", lib.fmtClock(now), "18:30:00");
eq("fmtDateTime", lib.fmtDateTime(now), "11-10 18:30");

/* ---------- 2. 时间范围 ---------- */

const today = lib.rangeFor("today", now);
eq("today 起点", today.sinceMs, new Date(2026, 10, 10).getTime());
eq("today 终点跟随现在", today.untilMs, now);

const yesterday = lib.rangeFor("yesterday", now);
eq("yesterday 起点", yesterday.sinceMs, new Date(2026, 10, 9).getTime());
eq("yesterday 终点", yesterday.untilMs, new Date(2026, 10, 9, 23, 59, 59).getTime());

eq("d7 起点", lib.rangeFor("d7", now).sinceMs, new Date(2026, 10, 4).getTime());
eq("d30 起点", lib.rangeFor("d30", now).sinceMs, new Date(2026, 9, 12).getTime());
eq("month 起点", lib.rangeFor("month", now).sinceMs, new Date(2026, 10, 1).getTime());

const lastMonth = lib.rangeFor("lastMonth", now);
eq("lastMonth 起点", lastMonth.sinceMs, new Date(2026, 9, 1).getTime());
eq("lastMonth 终点", lastMonth.untilMs, new Date(2026, 9, 31, 23, 59, 59).getTime());

const jan = new Date(2026, 0, 15, 9, 0, 0).getTime();
const lastDec = lib.rangeFor("lastMonth", jan);
eq("lastMonth 跨年起点", lastDec.sinceMs, new Date(2025, 11, 1).getTime());
eq("lastMonth 跨年终点", lastDec.untilMs, new Date(2025, 11, 31, 23, 59, 59).getTime());

eq("all 起点", lib.rangeFor("all", now).sinceMs, new Date(1970, 0, 1).getTime());
eq("未知预设回退 today", lib.rangeFor("nope", now).sinceMs, new Date(2026, 10, 10).getTime());

const custom = lib.customRange("2026-11-01", "2026-11-10");
eq("自定义范围解析", custom.ok, true);
eq("自定义起点取当天 00:00", custom.sinceMs, new Date(2026, 10, 1).getTime());
eq("自定义终点取当天 23:59:59", custom.untilMs, new Date(2026, 10, 10, 23, 59, 59).getTime());
eq("自定义起止倒置被拒", lib.customRange("2026-11-10", "2026-11-01").ok, false);
eq("自定义空值被拒", lib.customRange("", "").ok, false);
eq("自定义单边空值被拒", lib.customRange("2026-11-01", "").ok, false);

/* ---------- 3. 窗口、汇总与速率 ---------- */

eq("1 小时在峰值窗口内", lib.withinPeakWindow(now, now + 3600000), true);
eq("36 小时在峰值窗口内", lib.withinPeakWindow(now, now + 36 * 3600000), true);
eq("37 小时超出峰值窗口", lib.withinPeakWindow(now, now + 37 * 3600000), false);
eq("7 天超出峰值窗口", lib.withinPeakWindow(new Date(2026, 10, 4).getTime(), now), false);

const empty = lib.summarizeUsage(null);
eq("空 summary 请求数为 null", empty.requests, null);
eq("空 summary 合计为 null", empty.total, null);

const sum = lib.summarizeUsage({
  totalInputTokens: 1000,
  totalOutputTokens: 50,
  totalRequests: 3,
});
eq("请求数", sum.requests, 3);
eq("输入 token", sum.input, 1000);
eq("输出 token", sum.output, 50);
eq("合计 = 输入 + 输出", sum.total, 1050);

eq("单位速率：每小时 600 请求", lib.avgRate(600, 3600000, 3600000), 600);
eq("单位速率：每分钟", lib.avgRate(600, 10 * 60000, 60000), 60);
eq("单位速率：跨度为 0", lib.avgRate(10, 0, 60000), null);
eq("单位速率：数值缺失", lib.avgRate(null, 60000, 60000), null);

/* ---------- 4. 峰值 ---------- */

const since = new Date(2026, 10, 10, 18, 0, 0).getTime();
const until = new Date(2026, 10, 10, 18, 2, 0).getTime();
const records = [
  { createdAt: "2026-11-10 18:00:10", inputTokens: 100, outputTokens: 10 },
  { createdAt: "2026-11-10 18:00:10", inputTokens: 50, outputTokens: 5 },
  { createdAt: "2026-11-10 18:01:20", inputTokens: 300, outputTokens: 20 },
  { createdAt: "2026-11-10 17:59:59", inputTokens: 999, outputTokens: 99 },
  { createdAt: "2026-11-10 18:02:01", inputTokens: 888, outputTokens: 88 },
  { createdAt: "bad-date", inputTokens: 777, outputTokens: 0 },
];
const peaks = lib.computePeaks(records, since, until);
eq("分钟请求峰值", peaks.rpm, 2);
eq("分钟输入峰值", peaks.itpm, 300);
eq("分钟输出峰值", peaks.otpm, 20);
eq("分钟序列长度", peaks.series.length, 2);
eq("序列首桶请求数", peaks.series[0].requests, 2);
eq("序列首桶输出合计", peaks.series[0].output, 15);
eq("窗口外记录不计入峰值", lib.computePeaks([{ createdAt: "2026-11-10 17:00:00", inputTokens: 5 }], since, until).itpm, 0);

const sparse = [
  { requests: 1 },
  { requests: 5 },
  { requests: 3 },
  { requests: 2 },
  { requests: 9 },
  { requests: 0 },
  { requests: 4 },
  { requests: 4 },
  { requests: 1 },
  { requests: 7 },
];
const pooled = lib.downsample(sparse, "requests", 4);
eq("降采样桶数", pooled.length, 4);
eq("降采样取桶内最大值", pooled.join(","), "5,9,4,7");
eq("空序列降采样", lib.downsample([], "requests", 4).length, 0);
const clamped = lib.downsample(sparse, "requests", 0);
eq("降采样目标小于 2 时压到两桶", clamped.length, 2);
eq("两桶各取最大值", clamped.join(","), "9,7");

/* ---------- 5. 格式化与视图 ---------- */

eq("fmtInt 千分位", lib.fmtInt(1234567), "1,234,567");
eq("fmtInt 空值", lib.fmtInt(null), "—");
eq("fmtCompact 千级", lib.fmtCompact(15000), "15k");
eq("fmtCompact 百万", lib.fmtCompact(1234567), "1.23M");
eq("fmtCompact 十亿", lib.fmtCompact(1000000000), "1B");
eq("fmtCompact 空值", lib.fmtCompact(null), "—");
eq("fmtRate 两位小数", lib.fmtRate(0.4167), "0.42");
eq("fmtRate 大数取整", lib.fmtRate(123.4), "123");
eq("fmtRate 空值", lib.fmtRate(null), "—");

const defaultView = lib.normalizeView(null);
eq("默认预设", defaultView.preset, "today");
eq("默认日期为空", defaultView.from, "");
eq("视图不含档案维度", Object.prototype.hasOwnProperty.call(defaultView, "profile"), false);

const loadedView = lib.normalizeView({ profile: "agent2api", preset: "custom", from: "2026-11-01", to: "2026-11-10" });
eq("读取预设", loadedView.preset, "custom");
eq("读取日期", loadedView.to, "2026-11-10");
eq("忽略历史档案字段", Object.prototype.hasOwnProperty.call(loadedView, "profile"), false);

const brokenView = lib.normalizeView({ preset: "nope", from: "2026/11/01", to: 5 });
eq("非法预设回退", brokenView.preset, "today");
eq("非法日期清空", brokenView.from, "");
eq("非字符串日期清空", brokenView.to, "");

/* ---------- 6. 首帧渲染冒烟 ---------- */

/* 用最小 React 桩执行组件函数体：Hooks 不调度，只验证首帧能建出元素树
   （TDZ、标识符拼错、渲染路径上误用 api 都会在这一步抛出）。 */
function element(type, props, ...children) {
  return { type, props: props || {}, children: children.flat(Infinity) };
}

const fakeReact = {
  createElement: element,
  useState: (init) => [typeof init === "function" ? init() : init, () => {}],
  useEffect: () => {},
  useRef: (init) => ({ current: init === undefined ? null : init }),
};

globalThis.window = globalThis;
globalThis.SnowAppPlugin = { React: fakeReact, icons: {} };

const fakeApi = {
  locale: "zh-CN",
  t: (key, options) => (options && options.defaultValue) || key,
  storage: {
    getJson: async () => null,
    setJson: async () => {},
  },
  metadata: {
    get: async () => ({ domains: {} }),
    subscribe: async () => ({ unsubscribe() {} }),
  },
};

let tree = null;
let renderError = null;
try {
  tree = lib.default({ api: fakeApi, isActive: true });
} catch (err) {
  renderError = err;
}

check("首帧渲染不抛错", renderError === null, renderError ? renderError.message : "");
eq("根节点类名", tree && tree.props.className, "srl-root");

function countByClass(node, className) {
  if (!node || typeof node !== "object") return 0;
  const own =
    node.props && typeof node.props.className === "string" && node.props.className.split(/\s+/).includes(className);
  let count = own ? 1 : 0;
  for (const child of node.children || []) count += countByClass(child, className);
  return count;
}

eq("五个指标带", countByClass(tree, "srl-band"), 5);
eq("十五个元数据格", countByClass(tree, "srl-meta-cell"), 15);
eq("五条迷你曲线", countByClass(tree, "srl-spark"), 5);
eq("范围预设八项", countByClass(tree, "srl-chip"), 8);
eq("不再渲染大标题", countByClass(tree, "srl-display"), 0);

/* ---------- 汇总 ---------- */

if (failures.length) {
  console.error("失败 " + failures.length + " 项：");
  for (const item of failures) console.error("  - " + item);
  process.exit(1);
}
console.log("全部通过：" + passed + " 项");