/**
 * snow-token-ring 假 DOM 渲染自检（Chrome headless）
 *
 * 覆盖：
 *   - 浮层挂在输入区圆环内，hover 展开；
 *   - 「已使用 x% / 已用 / 上限」取自宿主真实 tokenUsage 与 maxContextTokens；
 *   - 分类行来自估算：系统提示词 / 技能 / MCP 工具 / 消息 / 未归类 / 可用空间；
 *   - 不再包含任何金额、单价入口；
 *   - 折叠可切换；
 *   - 180 / 280 / 380 / 480 容器宽度下不越出视口、无横向溢出。
 *
 * 运行：node snow-token-ring/dom-test.mjs
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(here, "snow-token-ring.user.js");
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";

const userScript = fs.readFileSync(SCRIPT, "utf8");

const LONG_MSG = "这是一段用于估算上下文占用的中文消息内容".repeat(40); // ≈ 720 字
const MOCK = {
  runtime: {
    domains: {
      runtime: {
        conversation: {
          conversationId: "conv-1",
          isStreaming: false,
          tokenUsage: {
            inputTokens: 10000,
            outputTokens: 2000,
            cacheCreationInputTokens: 0,
            cacheReadInputTokens: 0,
          },
        },
        chatInput: { conversationId: "conv-1", inputText: "", maxContextTokens: 200000 },
      },
    },
  },
  messages: {
    domains: {
      messages: {
        conversationId: "conv-1",
        items: Array.from({ length: 10 }, (_, i) => ({
          id: "m" + i,
          role: i % 2 === 0 ? "user" : "assistant",
          content: LONG_MSG,
          createdAt: "2026-11-01 10:0" + i + ":00",
          toolCallsJson: i === 3 ? '{"name":"read_file","arguments":{"path":"src/app.js"}}' : null,
        })),
      },
    },
  },
  usage: {
    domains: {
      usage: {
        records: {
          items: [
            { conversationId: "conv-1", inputTokens: 12000, outputTokens: 400, createdAt: "2026-11-01 10:05:00" },
            { conversationId: "conv-1", inputTokens: 9000, outputTokens: 300, createdAt: "2026-11-01 10:00:02" },
          ],
        },
      },
    },
  },
  mcp: {
    domains: {
      mcp: {
        servers: [{ serverId: "s1", name: "demo", enabled: true }],
        tools: [
          { name: "docs_search", description: "Search the documentation index", inputSchemaJson: '{"type":"object","properties":{"q":{"type":"string"},"limit":{"type":"number"}}}' },
          { name: "repo_tree", description: "列出仓库文件树", inputSchemaJson: '{"type":"object","properties":{"path":{"type":"string"}}}' },
          { name: "run_sql", description: "执行只读 SQL", inputSchemaJson: '{"type":"object","properties":{"sql":{"type":"string"}}}' },
        ],
        projectServersWithTools: [],
      },
    },
  },
  skills: {
    domains: {
      skills: {
        available: [
          { id: "a", name: "snow-plugin-dev", description: "面板插件与 OAuth 插件开发流程", allowedTools: ["filesystem-read"] },
          { id: "b", name: "reverse", description: "二进制逆向与协议还原", allowedTools: [] },
          { id: "c", name: "pentest", description: "Web 与内网渗透测试", allowedTools: [] },
        ],
      },
    },
  },
  personalization: {
    domains: { personalization: { filePath: "~/.snow/ROLE.md", content: "全局规则：全程中文回复，禁止 Emoji，代码保持原始格式。".repeat(3) } },
  },
  systemPrompts: {
    domains: {
      systemPrompts: [
        { promptId: "p1", name: "默认", content: "你是一个严谨的技术助手，回答要短。".repeat(4), isActive: true, scope: "global" },
      ],
    },
  },
};

const PROBE = `
(function () {
  function text(sel, root) {
    var n = root && root.querySelector(sel);
    return n ? n.textContent : null;
  }
  function report() {
    var out = { errors: window.__errors || [] };
    var pop = document.querySelector('[data-snow-anchor="chat.input"] .scb-pop');
    var tt = document.querySelector('.token-usage-tooltip');
    out.popExists = !!pop;
    out.openAfterHover = !!(pop && pop.classList.contains('is-open'));
    out.used = text('.scb-used', pop);
    out.ctx = text('.scb-ctx', pop);
    out.rows = pop ? pop.querySelectorAll('.scb-row').length : 0;
    out.rowTexts = pop
      ? Array.prototype.map.call(pop.querySelectorAll('.scb-row'), function (r) { return r.textContent; })
      : [];
    out.note = text('.scb-note', pop);
    out.nativeCount = pop ? pop.querySelectorAll('.scb-native-cell').length : 0;
    out.nativeText = pop
      ? Array.prototype.map.call(pop.querySelectorAll('.scb-native-cell'), function (c) { return c.textContent; }).join(" | ")
      : null;
    out.hasMoney = pop ? /[¥$]/.test(pop.textContent) : null;
    out.hasPriceUi = !!(pop && (pop.querySelector('.scb-link') || pop.querySelector('.scb-cost') || pop.querySelector('.scb-editor')));
    out.hostTooltipDisplay = tt ? getComputedStyle(tt).display : null;
    out.hostTooltipText = tt ? tt.textContent.replace(/\\s+/g, "") : null;
    if (tt) {
      var tr = tt.getBoundingClientRect();
      out.ttRect = { top: Math.round(tr.top), bottom: Math.round(tr.bottom), height: Math.round(tr.height) };
    }
    if (pop) {
      var rect = pop.getBoundingClientRect();
      out.popRect = { left: Math.round(rect.left), right: Math.round(rect.right), top: Math.round(rect.top), bottom: Math.round(rect.bottom), width: Math.round(rect.width) };
      out.withinViewport = rect.left >= -0.5 && rect.right <= window.innerWidth + 0.5;
      out.popOverflowsSelf = pop.scrollWidth > pop.clientWidth + 1;
      if (out.ttRect) out.overlapsHostTooltip = rect.bottom > out.ttRect.top + 1;
    }
    out.docOverflowX = document.documentElement.scrollWidth > window.innerWidth + 1;
    out.viewport = window.innerWidth;

    /* 折叠：点标题后明细行应消失，再点恢复 */
    var head = pop && pop.querySelector('.scb-head');
    if (head) {
      head.click();
      out.rowsAfterCollapse = pop.querySelectorAll('.scb-row').length;
      out.noteAfterCollapse = text('.scb-note', pop);
      head.click();
      out.rowsAfterExpand = pop.querySelectorAll('.scb-row').length;
    }

    document.getElementById('result').textContent = JSON.stringify(out);
  }

  /* 模拟宿主 hover 才渲染 tooltip 的时序：先不存在 -> hover -> 出现 */
  var ring = document.querySelector('.token-usage-ring-wrapper');
  var tt = document.querySelector('.token-usage-tooltip');
  if (tt) tt.style.display = 'none';
  if (ring) ring.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
  setTimeout(function () { if (tt) tt.style.display = ''; }, 60);
  setTimeout(report, 360);
})();
`;

const HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<title>scb dom test</title>
<style>
  html, body { margin: 0; padding: 0; }
  html { height: 100%; }
  body {
    min-height: 100%;
    display: flex;
    flex-direction: column;
    justify-content: flex-end;
    background: #1b1b1f; color: #ddd; font: 13px/1.5 system-ui, "Segoe UI", sans-serif;
    --border-light: #35353c;
    --bg-secondary: #232329;
    --island-shadow: 0 8px 24px rgba(0, 0, 0, .45);
    --radius-lg: 10px;
    --text-primary: #f2f2f4;
    --text-secondary: #c2c2ca;
    --text-tertiary: #8b8b95;
  }
  #stage { padding: 20px; box-sizing: border-box; width: 100%; }
  .chat-input-region {
    width: 100%;
    box-sizing: border-box;
    display: flex;
    justify-content: flex-end;
    align-items: center;
    gap: 8px;
    padding: 12px;
    border: 1px dashed #3a3a42;
    border-radius: 10px;
  }
  .token-usage-ring-wrapper { position: relative; display: inline-flex; align-items: center; justify-content: center; width: 28px; height: 28px; }
  .token-usage-ring { display: block; }
  .token-usage-ring-text { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; font-size: 8px; }
  .token-usage-tooltip { position: absolute; bottom: calc(100% + 8px); right: -4px; min-width: 172px; padding: 8px 10px; background: #232329; border: 1px solid #35353c; border-radius: 10px; font-size: 11px; line-height: 1.5; }
  .token-usage-tooltip-row { display: flex; gap: 6px; }
  .token-usage-dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: #3b82f6; }
  .token-usage-label { flex: 1; }
  .token-usage-value { font-variant-numeric: tabular-nums; }
</style>
</head>
<body>
<div id="stage">
  <div class="chat-input-region" data-snow-anchor="chat.input">
    <div class="token-usage-ring-wrapper">
      <svg class="token-usage-ring" width="28" height="28" viewBox="0 0 28 28"><circle cx="14" cy="14" r="12" fill="none" stroke="#35353c" stroke-width="2.5" /></svg>
      <span class="token-usage-ring-text">6%</span>
      <div class="token-usage-tooltip">
        <div class="token-usage-tooltip-row"><span class="token-usage-dot"></span><span class="token-usage-label">输入</span><span class="token-usage-value">10k</span></div>
        <div class="token-usage-tooltip-row"><span class="token-usage-dot"></span><span class="token-usage-label">输出</span><span class="token-usage-value">2k</span></div>
        <div class="token-usage-tooltip-row"><span class="token-usage-dot"></span><span class="token-usage-label">缓存命中</span><span class="token-usage-value">0</span></div>
        <div class="token-usage-tooltip-row"><span class="token-usage-dot"></span><span class="token-usage-label">合计</span><span class="token-usage-value">12k</span></div>
        <div class="token-usage-tooltip-row"><span class="token-usage-dot"></span><span class="token-usage-label">上下文</span><span class="token-usage-value">200k</span></div>
      </div>
    </div>
  </div>
</div>
<pre id="result">pending</pre>
<script>
/* 用 cw 参数模拟输入区不同宽度（真实场景由窗口 / 面板宽度决定） */
(function () {
  var cw = Number(new URLSearchParams(location.search).get('cw') || 0);
  if (!cw) return;
  var st = document.getElementById('stage');
  st.style.width = cw + 'px';
  st.style.boxSizing = 'border-box';
})();
</script>
<script>
window.__errors = [];
window.addEventListener('error', function (e) { window.__errors.push(String(e.message)); });
window.__meta = ${JSON.stringify(MOCK)};
/* ?nou 用于验证没有首轮记录时的退化口径 */
if (new URLSearchParams(location.search).get('nou')) delete window.__meta.usage;
window.GM_getValue = function (k, d) { return d; };
window.GM_setValue = function () {};
window.GM_addStyle = function (css) {
  var s = document.createElement('style');
  s.textContent = css;
  (document.head || document.documentElement).appendChild(s);
};
window.GM_registerMenuCommand = function () {};
window.snow = {
  context: { conversationId: 'conv-1', locale: 'zh-CN', projectId: 'local:test' },
  on: function () {},
  onCleanup: function (fn) { window.__cleanup = fn; },
  metadata: {
    subscribe: function () { return { unsubscribe: function () {} }; },
    get: function (domain) { return Promise.resolve(window.__meta[domain] || { domains: {} }); }
  }
};
</script>
<script>
${userScript}
</script>
<script>
${PROBE}
</script>
</body>
</html>
`;

const tmpDir = path.join(os.tmpdir(), "str-dom-test");
fs.mkdirSync(tmpDir, { recursive: true });
const htmlPath = path.join(tmpDir, "index.html");
fs.writeFileSync(htmlPath, HTML, "utf8");

const widths = [180, 280, 380, 480];
const results = [];
let failed = 0;

function run(cw, noUsage) {
  const stdout = execFileSync(
    CHROME,
    [
      "--headless=new",
      "--disable-gpu",
      "--no-sandbox",
      "--hide-scrollbars",
      "--allow-file-access-from-files",
      "--virtual-time-budget=1500",
      "--window-size=520,900",
      "--dump-dom",
      "file:///" + htmlPath.replace(/\\/g, "/") + "?cw=" + cw + (noUsage ? "&nou=1" : ""),
    ],
    { encoding: "utf8", timeout: 60000, maxBuffer: 32 * 1024 * 1024 }
  );
  const m = stdout.match(/<pre id="result">([\s\S]*?)<\/pre>/);
  if (!m) throw new Error("输入区宽度 " + cw + " 未取到 result 节点");
  return JSON.parse(m[1].replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">"));
}

function expect(cond, msg, width) {
  if (cond) return;
  failed++;
  console.log("FAIL  [" + width + "px] " + msg);
}

for (const w of widths) {
  let r;
  try {
    r = run(w);
  } catch (e) {
    failed++;
    console.log("FAIL  [" + w + "px] 渲染失败: " + e.message);
    continue;
  }
  results.push(r);
  console.log("---- " + w + "px ---- " + JSON.stringify(r));

  const joined = (r.rowTexts || []).join(" | ");

  expect(r.errors.length === 0, "页面报错: " + JSON.stringify(r.errors), w);
  expect(r.popExists === true, "浮层未挂载", w);
  expect(r.openAfterHover === true, "hover 后浮层未展开", w);
  expect(r.used === "已使用 6%", "占用率应为「已使用 6%」，实际 " + r.used, w);
  expect(r.ctx === "12k / 200k", "总量文本应为 12k / 200k，实际 " + r.ctx, w);
  expect(r.rows >= 5, "分类行过少: " + r.rows, w);

  expect(/系统提示词/.test(joined), "缺少系统提示词行", w);
  expect(/技能清单 · 3/.test(joined), "技能清单行异常: " + joined, w);
  expect(/MCP 工具 · 3/.test(joined), "MCP 工具行异常: " + joined, w);
  expect(/消息 · 10/.test(joined), "消息行异常: " + joined, w);
  expect(/内置工具与框架/.test(joined), "缺少实测的内置开销行: " + joined, w);
  expect(!/未归类/.test(joined), "真实模式不应再有未归类行: " + joined, w);
  expect(/可用空间/.test(joined), "缺少可用空间行", w);
  expect(/188k/.test(joined), "可用空间应为 188k: " + joined, w);
  expect(/94\.0%/.test(joined), "可用空间占比应为 94.0%: " + joined, w);
  expect(/≈/.test(joined), "估算项应带 ≈ 前缀: " + joined, w);

  expect(r.note && /实测/.test(r.note), "缺少实测口径说明: " + r.note, w);
  expect(r.hasMoney === false, "浮层仍包含金额符号", w);
  expect(r.hasPriceUi === false, "浮层仍有单价 / 成本元素", w);
  expect(r.hostTooltipDisplay === "none", "宿主原生 tooltip 未隐藏（会造成两块浮层）: " + r.hostTooltipDisplay, w);
  expect(r.nativeCount >= 5, "面板内原生用量行不足: " + r.nativeCount, w);
  expect(r.nativeText && /输入/.test(r.nativeText) && /合计/.test(r.nativeText) && /上下文/.test(r.nativeText), "原生用量信息丢失: " + r.nativeText, w);

  expect(r.rowsAfterCollapse === 0, "折叠后明细未隐藏: " + r.rowsAfterCollapse, w);
  expect(r.noteAfterCollapse === null || r.noteAfterCollapse === "", "折叠后口径说明未隐藏", w);
  expect(r.rowsAfterExpand === r.rows, "再次展开行数不一致: " + r.rowsAfterExpand + " vs " + r.rows, w);

  expect(r.withinViewport === true, "浮层越出视口: " + JSON.stringify(r.popRect), w);
  expect(r.popOverflowsSelf === false, "浮层内容横向溢出", w);
  expect(r.docOverflowX === false, "页面出现横向滚动", w);
}

/* 没有首轮 usage 记录时退化为纯估算口径 */
try {
  const fb = run(380, true);
  const joined = (fb.rowTexts || []).join(" | ");
  console.log("---- 退化口径（无首轮记录）---- " + JSON.stringify(fb));
  expect(/未归类/.test(joined), "退化模式应出现未归类行: " + joined, "nou");
  expect(/内置工具与框架/.test(joined) === false, "退化模式不应出现实测行: " + joined, "nou");
  expect(fb.note && /估算/.test(fb.note), "退化模式说明文案异常: " + fb.note, "nou");
  expect(fb.used === "已使用 6%", "退化模式占用率异常: " + fb.used, "nou");
} catch (e) {
  failed++;
  console.log("FAIL  [nou] 渲染失败: " + e.message);
}

console.log("");
console.log("宽度覆盖：" + widths.join(" / "));
if (widths.length !== results.length) {
  failed++;
  console.log("FAIL  有宽度未产出结果");
}
console.log(failed === 0 ? "DOM 自检全部通过" : "DOM 自检失败 " + failed + " 项");
process.exit(failed === 0 ? 0 : 1);
