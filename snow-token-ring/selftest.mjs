/**
 * snow-token-ring 估算口径自检
 *
 * 覆盖：
 *   1) token 估算公式（CJK / 拉丁 / 空白）与格式化函数；
 *   2) 分解结果自洽：各分类估算 + 未归类 == 宿主真实总量；
 *   3) 估算超过真实总量时按比例归一；
 *   4) 无 tokenUsage 的空态、百分比格式化边界。
 *
 * 运行：node snow-token-ring/selftest.mjs
 */

import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(here, "snow-token-ring.user.js");
const src = fs.readFileSync(SCRIPT, "utf8");

/* ---------- 源码片段提取 ---------- */

function sliceFunction(source, name) {
  const marker = "function " + name + "(";
  const at = source.indexOf(marker);
  if (at < 0) throw new Error("未找到函数: " + name);
  let depth = 0;
  let inStr = null;
  for (let j = at; j < source.length; j++) {
    const ch = source[j];
    if (inStr) {
      if (ch === "\\") {
        j++;
        continue;
      }
      if (ch === inStr) inStr = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      inStr = ch;
      continue;
    }
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return source.slice(at, j + 1);
    }
  }
  throw new Error("函数体未闭合: " + name);
}

const FN_NAMES = [
  "num",
  "clamp0",
  "fmtTokens",
  "fmtLimit",
  "estimateTokens",
  "pad2",
  "fmtDbTime",
  "parseDbTime",
  "firstMessage",
  "firstMessageTokens",
  "firstRequestInput",
  "contextSnapshot",
  "buildBreakdown",
  "pctOf",
];

function buildAxis(mockState) {
  const code = [
    ...FN_NAMES.map((n) => sliceFunction(src, n)),
    "var state = " + JSON.stringify(mockState) + ";",
    "this.__out = { " + FN_NAMES.map((n) => n + ": " + n).join(", ") + " };",
  ].join("\n");
  const ctx = vm.createContext({});
  vm.runInContext(code, ctx);
  return ctx.__out;
}

/* ---------- 断言工具 ---------- */

let pass = 0;
const failures = [];

function check(name, fn) {
  try {
    fn();
    pass++;
    console.log("PASS  " + name);
  } catch (e) {
    failures.push(name + " -> " + e.message);
    console.log("FAIL  " + name + " -> " + e.message);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || "断言失败");
}

function near(actual, expected, eps = 1e-6, msg = "") {
  assert(Math.abs(actual - expected) <= eps, (msg ? msg + " " : "") + "期望 " + expected + "，实际 " + actual);
}

/* ---------- 1. token 估算 ---------- */

const base = buildAxis({});

check("CJK 按 1 token/字", () => {
  near(base.estimateTokens("你好世界"), 4);
});

check("拉丁按 0.28 token/字符", () => {
  near(base.estimateTokens("hello"), 5 * 0.28);
});

check("混合文本与空白", () => {
  near(base.estimateTokens("你好 hello"), 2 + 0.05 + 5 * 0.28);
});

check("JSON schema 片段估算", () => {
  const t = base.estimateTokens('{"type":"object","properties":{"q":{"type":"string"}}}');
  assert(t > 10 && t < 25, "估算值异常: " + t);
});

check("空值不产生 NaN", () => {
  for (const v of [null, undefined, "", 0, false]) near(base.estimateTokens(v), 0);
});

check("fmtTokens / fmtLimit", () => {
  assert(base.fmtTokens(140000) === "140k");
  assert(base.fmtTokens(1000000) === "1.0M");
  assert(base.fmtLimit(1000000) === "1M");
  assert(base.fmtLimit(200000) === "200k");
});

check("pctOf 边界", () => {
  assert(base.pctOf(14000, 1000000) === "1.4%", base.pctOf(14000, 1000000));
  assert(base.pctOf(0, 1000000) === "0.0%");
  assert(base.pctOf(10, 0) === "—");
  assert(base.pctOf(1, 1000000) === "<0.1%", base.pctOf(1, 1000000));
});

/* ---------- 2. 分解自洽 ---------- */

const stateNormal = {
  runtime: {
    conversation: { tokenUsage: { inputTokens: 120000, outputTokens: 20000, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 } },
    chatInput: { maxContextTokens: 1000000 },
  },
  messages: {
    items: [
      { role: "user", content: "帮我看看这个脚本为什么启动就报错" },
      { role: "assistant", content: "先看日志，再定位挂载点。" },
      { role: "tool", content: '{"ok":true,"path":"src/app.js"}' },
    ],
  },
  mcp: {
    tools: [
      { name: "docs_search", description: "Search documentation", inputSchemaJson: '{"type":"object","properties":{"q":{"type":"string"}}}' },
      { name: "repo_tree", description: "列出仓库文件", inputSchemaJson: '{"type":"object","properties":{"path":{"type":"string"}}}' },
    ],
    projectServersWithTools: [
      { id: "s1", name: "demo", tools: [{ name: "demo_ping", description: "ping", inputSchemaJson: "{}" }] },
    ],
  },
  skills: {
    available: [
      { name: "snow-plugin-dev", description: "面板插件与 OAuth 插件开发", allowedTools: ["filesystem-read"] },
      { name: "reverse", description: "二进制逆向", allowedTools: [] },
    ],
  },
  personalization: { content: "全局规则：中文回复，禁止 Emoji。" },
  systemPrompts: [{ content: "你是技术助手。", isActive: true }, { content: "未启用", isActive: false }],
};

const axis = buildAxis(stateNormal);
const b1 = axis.buildBreakdown();

check("四类分类都算出正数", () => {
  const got = Object.fromEntries(b1.parts.map((p) => [p.key, p.tokens]));
  for (const k of ["systemPrompt", "skills", "mcpTools", "messages"]) {
    assert(got[k] > 0, k + " 估算为 0");
  }
});

check("分类 + 未归类 == 宿主真实总量", () => {
  const sum = b1.parts.reduce((s, p) => s + p.tokens, 0);
  near(sum + b1.other, b1.realTotal, 1e-6, "分解合计");
  assert(b1.other >= 0, "未归类不应为负: " + b1.other);
});

check("可用空间与分母来自宿主上限", () => {
  near(b1.free, 1000000 - 140000);
  near(b1.denom, 1000000);
  near(b1.realTotal, 140000);
  assert(b1.normalized === false, "本样例不应触发归一");
});

check("计数正确（技能 2 / MCP 工具 3 / 消息 3）", () => {
  const byKey = Object.fromEntries(b1.parts.map((p) => [p.key, p]));
  assert(byKey.skills.count === 2, "技能数 " + byKey.skills.count);
  assert(byKey.mcpTools.count === 3, "MCP 工具数 " + byKey.mcpTools.count);
  assert(byKey.messages.count === 3, "消息数 " + byKey.messages.count);
});

check("未激活的系统提示词不计入", () => {
  const onlyInactive = buildAxis({
    ...stateNormal,
    systemPrompts: [{ content: "很长的一段未启用提示词".repeat(200), isActive: false }],
  });
  const b = onlyInactive.buildBreakdown();
  const sys = b.parts.find((p) => p.key === "systemPrompt");
  assert(sys.tokens < 50, "未启用提示词被计入: " + sys.tokens);
});

/* ---------- 3. 归一口径 ---------- */

const stateHuge = {
  ...stateNormal,
  messages: { items: [{ role: "assistant", content: "x".repeat(2000000) }] },
};
const big = buildAxis(stateHuge).buildBreakdown();

check("估算超过真实总量时优先裁消息、固定项不变", () => {
  assert(big.normalized === true, "应标记为已归一");
  const sum = big.parts.reduce((s, p) => s + p.tokens, 0);
  near(sum, big.realTotal, 1e-6, "归一后合计应等于真实总量");
  near(big.other, 0);

  const norm = Object.fromEntries(b1.parts.map((p) => [p.key, p.tokens]));
  const huge = Object.fromEntries(big.parts.map((p) => [p.key, p.tokens]));
  for (const key of ["systemPrompt", "skills", "mcpTools"]) {
    near(huge[key], norm[key], 1e-6, key + " 不该被压缩");
  }
  assert(huge.messages > 0, "消息应保留剩余额度: " + huge.messages);
  near(huge.messages, big.realTotal - norm.systemPrompt - norm.skills - norm.mcpTools, 1e-6);
});

/* ---------- 4. 真实基线模式 ---------- */

const stateReal = {
  convId: "conv-1",
  runtime: {
    conversation: { tokenUsage: { inputTokens: 120000, outputTokens: 20000, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 } },
    chatInput: { maxContextTokens: 1000000 },
  },
  messages: {
    items: [
      { role: "user", content: "初始需求：帮我看一下这个报错", createdAt: "2026-11-01 10:00:00" },
      { role: "assistant", content: "好，先看日志。", createdAt: "2026-11-01 10:00:06" },
    ],
  },
  mcp: stateNormal.mcp,
  skills: stateNormal.skills,
  personalization: stateNormal.personalization,
  systemPrompts: stateNormal.systemPrompts,
  usage: {
    records: {
      items: [
        { conversationId: "conv-1", inputTokens: 45000, outputTokens: 800, createdAt: "2026-11-01 10:01:00" },
        { conversationId: "conv-1", inputTokens: 30000, outputTokens: 500, createdAt: "2026-11-01 10:00:03" },
        { conversationId: "conv-other", inputTokens: 99999, createdAt: "2026-11-01 10:00:01" },
        { conversationId: "conv-1", inputTokens: 12000, isSubAgent: 1, createdAt: "2026-11-01 09:59:00" },
      ],
    },
  },
};

const realAxis = buildAxis(stateReal);
const firstInput = realAxis.firstRequestInput();
const firstMsgTokens = realAxis.firstMessageTokens();
const r1 = realAxis.buildBreakdown();

check("首轮 input 只取同会话、非子代理的最早记录", () => {
  near(firstInput, 30000);
});

check("首条用户消息 token 估算", () => {
  assert(firstMsgTokens > 10 && firstMsgTokens < 25, "估算异常: " + firstMsgTokens);
});

check("真实模式：基线 = 首轮 input - 首条消息", () => {
  assert(r1.mode === "real", "模式应为 real，实际 " + r1.mode);
  near(r1.baseline, 30000 - firstMsgTokens, 1e-9);
});

check("真实模式：消息量 = 当前上下文 - 基线（实测）", () => {
  const msg = r1.parts.find((p) => p.key === "messages");
  assert(msg, "缺少消息行");
  near(msg.tokens, 140000 - r1.baseline, 1e-9);
  assert(msg.estimated === false, "消息应为实测项");
});

check("真实模式：内置工具与框架 = 基线余量（实测）", () => {
  const builtin = r1.parts.find((p) => p.key === "builtin");
  assert(builtin, "缺少内置工具与框架行");
  assert(builtin.estimated === false, "内置开销应为实测项");
  const estSum = r1.parts.filter((p) => p.estimated).reduce((s, p) => s + p.tokens, 0);
  near(builtin.tokens, r1.baseline - estSum, 1e-9);
  assert(builtin.tokens > 0, "余量应为正: " + builtin.tokens);
});

check("真实模式：五项合计等于真实总量", () => {
  const sum = r1.parts.reduce((s, p) => s + p.tokens, 0);
  near(sum, r1.realTotal, 1e-6);
});

check("真实模式：只有三类带估算标记", () => {
  const est = r1.parts.filter((p) => p.estimated).map((p) => p.key);
  assert(est.length === 3, "估算项数量 " + est.length + " -> " + est.join(","));
  for (const k of ["systemPrompt", "skills", "mcpTools"]) assert(est.includes(k), k + " 应标记为估算");
});

check("真实模式：估算项超过基线时等比压缩，余量为 0", () => {
  const tiny = buildAxis({
    ...stateReal,
    usage: { records: { items: [{ conversationId: "conv-1", inputTokens: 20, createdAt: "2026-11-01 10:00:03" }] } },
  }).buildBreakdown();
  const builtin = tiny.parts.find((p) => p.key === "builtin");
  const estSum = tiny.parts.filter((p) => p.estimated).reduce((s, p) => s + p.tokens, 0);
  assert(tiny.mode === "real", "仍应是 real 模式");
  near(builtin.tokens, 0);
  near(estSum, tiny.baseline, 1e-6, "估算项应按基线压缩");
});

check("基线超过当前上下文时消息归零并标记裁剪", () => {
  const over = buildAxis({
    ...stateReal,
    usage: { records: { items: [{ conversationId: "conv-1", inputTokens: 500000, createdAt: "2026-11-01 10:00:03" }] } },
  }).buildBreakdown();
  assert(over.normalized === true, "应标记已裁剪");
  const msg = over.parts.find((p) => p.key === "messages");
  near(msg.tokens, 0);
  const sum = over.parts.reduce((s, p) => s + p.tokens, 0);
  near(sum, over.realTotal, 1e-6);
});

/* ---------- 5. 空态 ---------- */

const stateEmpty = {
  runtime: { conversation: { tokenUsage: null }, chatInput: { maxContextTokens: 1000000 } },
  messages: null,
  mcp: null,
  skills: null,
  personalization: null,
  systemPrompts: null,
};
const empty = buildAxis(stateEmpty).buildBreakdown();

check("无 tokenUsage 时 total 为 0、可用空间为上限", () => {
  assert(empty.snap === null, "snap 应为 null");
  near(empty.realTotal, 0);
  near(empty.free, 1000000);
  near(empty.denom, 1000000);
  for (const p of empty.parts) near(p.tokens, 0);
});

/* ---------- 汇总 ---------- */

console.log("");
console.log("通过 " + pass + " 项，失败 " + failures.length + " 项");
if (failures.length) {
  for (const f of failures) console.log("  - " + f);
  process.exit(1);
}
