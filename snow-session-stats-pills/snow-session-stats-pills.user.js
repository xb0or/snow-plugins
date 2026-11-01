// ==UserScript==
// @name         会话统计条
// @name:en      Session Stats Pills
// @namespace    kedou
// @version      1.0.3
// @description  在聊天输入框最下方显示当前会话的轮次与步数、首 token 与输出速度、缓存命中率、输入输出 token，以及按「成本核算看板」单价联动计算的会话成本
// @author       kedou
// @license      MIT
// @icon         lucide:Activity
// @snow-target  client
// @snow-scope   global
// @snow-privacy messages, usage
// @run-at       document-idle
// @grant        GM_getValue
// @grant        GM_setValue
// ==/UserScript==

/*
 * snow-session-stats-pills —— Snow App 客户端脚本
 *
 * 作用：把当前会话的「轮 · 步 / 速度 / 缓存命中 / 输入输出 / 成本」渲染成一行统计条，
 *       挂在输入框正下方（输入区最底部），点成本块弹出按模型拆分的浮层。
 *
 * 挂载位置（Snow 0.5.10 渲染层源码核对，ChatContent.js）：
 *   div.chat-input-region[data-snow-anchor="chat.input"]
 *     └ div.input-area > div.input-content          ← 与消息列同宽（max-width 1120，居中）
 *         ├ div.stream-metrics-bar                   （流式指标，条件渲染）
 *         ├ div.snow-client-slot[data-snow-slot="chat.input.actions"]  （官方可写插槽，位于输入框上方）
 *         └ div.input-box                            （输入框本体，最后一行是 toolbar）
 *   官方插槽只在输入框「上方」，输入框下方没有可写插槽，故本脚本把统计条 append 到
 *   .input-content 的末尾（= 输入框正下方）；该节点由 React 管理，重建时由 MutationObserver 重挂。
 *   找不到 .input-content 时退化为 append 到 [data-snow-anchor="chat.input"] 末尾。
 *
 * 数据来源（全部走宿主元数据域，不做 DOM 抓取）：
 *   runtime   （无隐私）  focus 会话实时流式状态：streamTokenCount / streamElapsedMs / streamTtftMs /
 *                         lastRunDurationMs，用于速度块与「是否正在流式」判断；
 *                         速度块用 3 秒滑动窗口的瞬时 TPS（streamTokenCount 采样增量 ÷ 实际跨度），
 *                         不再用「累计 token ÷ 累计时长」的平均口径；
 *                         tokenUsage 用于「缓存命中」药丸——与输入框右侧用量环同源同公式
 *                         （cacheRead = min(cacheReadInputTokens, input)，命中率 = cacheRead / input）。
 *                         注意：环是「当前上下文」口径，usage.records 是「全会话账单」口径，两者数值天然不同。
 *   usage     （敏感）    按 conversationId 分页取明细，逐条按模型聚合 token，成本口径与看板一致。
 *   messages  （敏感）    userMessages 数量 = 轮数（排除上下文压缩产生的伪消息）。
 *
 * 成本口径（与 snow-usage-cost「成本核算看板」逐项一致）：
 *   非缓存输入 = max(input - cacheRead, 0)；缓存读 = cacheRead；缓存写 = cacheWrite；输出 = output
 *   成本 = Σ(各桶 token × 对应单价) / 1e6，单价单位：货币 / 百万 token
 *   单价解析顺序：看板自定义单价 → 内置估算规则 → 默认价（2 / 0.2 / 4 / 6）
 *
 * 价格联动（单向读取，看板是唯一事实源）：
 *   snow-usage-cost 1.2.4+ 在价格加载与保存后把归一化后的价格表发布到
 *     script[data-snow-usage-cost-prices]（textContent = JSON）
 *     localStorage["snow.usageCost.prices.v1"]
 *   本脚本每次刷新时先读桥接快照，读不到才回落到同一套内置规则。
 *   限制：桥接快照由看板面板写入，因此需要至少打开过一次成本核算看板。
 */

(function () {
  "use strict";

  var TAG = "[snow-session-stats-pills]";
  var PREFIX = "ssp";
  var CFG_KEY = "ssp.config";
  var BRIDGE_KEY = "snow.usageCost.prices.v1";
  var BRIDGE_SELECTOR = 'script[type="application/json"][data-snow-usage-cost-prices]';

  /* usage 明细分页参数：单页上限 500，最多翻 6 页（3000 条），超出后在浮层里标注「已截断」 */
  var PAGE = 500;
  var MAX_PAGES = 6;

  var RUNTIME_MS = 1000; /* 实时流式状态轮询 */
  var ROUNDS_MS = 30000; /* 轮数轮询（低频备份，主要靠事件触发） */

  /* 瞬时 TPS：用最近 3 秒窗口内 streamTokenCount 的增量 / 实际跨度，
     不再用「从流式开始累计 token ÷ 累计时长」的原始平均口径（长回复会被全程摊平）。 */
  var TPS_WINDOW_MS = 3000; /* 观察窗口 */
  var TPS_MIN_SPAN_MS = 700; /* 窗口内至少要有这么长的跨度才出数（避免一两个点算出爆表值） */
  var TPS_SAMPLE_KEEP_MS = 9000; /* 样本保留上限，够覆盖窗口 + 几次轮询 */

  /* ============================ 配置 ============================ */

  var DEFAULT_CFG = {
    showRounds: true, /* 轮次与步数 */
    showSpeed: true, /* 首 token / 输出速度 / 上轮耗时 */
    showCache: true, /* 缓存命中率 */
    showUsage: true, /* 输入 / 输出 token */
    showCost: true, /* 会话成本（联动看板单价） */
    intervalMs: 5000 /* usage 刷新间隔 */
  };

  var cfg = loadCfg();

  function loadCfg() {
    var out = {};
    var k;
    for (k in DEFAULT_CFG) {
      if (Object.prototype.hasOwnProperty.call(DEFAULT_CFG, k)) out[k] = DEFAULT_CFG[k];
    }
    var raw = null;
    try {
      raw = GM_getValue(CFG_KEY, "");
    } catch (e) {
      log("读取配置失败：" + e);
    }
    if (raw) {
      try {
        var parsed = JSON.parse(raw);
        if (parsed && typeof parsed === "object") {
          for (k in DEFAULT_CFG) {
            if (Object.prototype.hasOwnProperty.call(DEFAULT_CFG, k) && typeof parsed[k] === typeof DEFAULT_CFG[k]) {
              out[k] = parsed[k];
            }
          }
        }
      } catch (e) {
        log("解析配置失败：" + e);
      }
    }
    var iv = Number(out.intervalMs);
    out.intervalMs = isFinite(iv) && iv >= 2000 && iv <= 60000 ? Math.round(iv) : DEFAULT_CFG.intervalMs;
    return out;
  }

  function saveCfg() {
    try {
      GM_setValue(CFG_KEY, JSON.stringify(cfg));
      return true;
    } catch (e) {
      log("保存配置失败：" + e);
      return false;
    }
  }

  function log() {
    var args = Array.prototype.slice.call(arguments);
    args.unshift(TAG);
    try {
      if (typeof snow !== "undefined" && snow && typeof snow.log === "function") snow.log.apply(null, args);
      else console.log.apply(console, args);
    } catch (e) {
      /* ignore */
    }
  }

  /* == PURE-MATH-BEGIN == 与「成本核算看板」同一口径的单价表与成本计算（改动需两侧同步） */

  /* token 类别 → 价格字段：token 维度叫 nonCachedInput，价格表字段叫 input（必须分开，否则输入价不参与计费） */
  var CATS = [
    { key: "nonCachedInput", priceKey: "input" },
    { key: "cacheRead", priceKey: "cacheRead" },
    { key: "cacheWrite", priceKey: "cacheWrite" },
    { key: "output", priceKey: "output" }
  ];
  var ZERO_P = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
  /* 内置兜底单价（每 100 万 token）：仅作参考，看板里可按模型覆盖 */
  var BUILTIN_DEFAULT_PRICE = { input: 2, cacheRead: 0.2, cacheWrite: 4, output: 6 };
  var BUILTIN_PRICE_RULES = [
    { re: /glm-5\.3-flash|glm-5\.3-air|glm-5-flash/i, price: { input: 1, cacheRead: 0.1, cacheWrite: 2, output: 4 } },
    { re: /glm/i, price: { input: 8, cacheRead: 2, cacheWrite: 8, output: 28 } },
    { re: /deepseek-v4\.?-?pro/i, price: { input: 9, cacheRead: 0.3, cacheWrite: 9, output: 27 } },
    { re: /deepseek/i, price: { input: 2, cacheRead: 0.04, cacheWrite: 2, output: 8 } },
    { re: /qwen3\.8-max/i, price: { input: 14, cacheRead: 1.4, cacheWrite: 14, output: 42 } },
    { re: /fable/i, price: { input: 67, cacheRead: 1.7, cacheWrite: 84, output: 335 } },
    { re: /astra/i, price: { input: 67, cacheRead: 6.7, cacheWrite: 84, output: 335 } },
    { re: /luna/i, price: { input: 0.67, cacheRead: 0.07, cacheWrite: 0.84, output: 3.35 } },
    { re: /sol/i, price: { input: 13.4, cacheRead: 1.34, cacheWrite: 16.8, output: 67 } },
    { re: /mini|lite|nano|haiku|flash/i, price: { input: 0.5, cacheRead: 0.05, cacheWrite: 1, output: 2 } },
    { re: /claude|opus|sonnet/i, price: { input: 20, cacheRead: 2, cacheWrite: 25, output: 100 } },
    { re: /gpt-[567o]|^o[34]/i, price: { input: 13.4, cacheRead: 1.34, cacheWrite: 16.8, output: 67 } },
    { re: /qwen/i, price: { input: 2, cacheRead: 0.2, cacheWrite: 4, output: 9 } },
    { re: /spark|kimi|grok/i, price: { input: 1, cacheRead: 0.1, cacheWrite: 2, output: 4 } }
  ];

  function clamp0(n) {
    return typeof n === "number" && isFinite(n) && n > 0 ? n : 0;
  }

  /** token 类别拆分（近似口径）：缓存读是输入的子集 */
  function splitTokens(rec) {
    var ti = clamp0(rec.totalInputTokens);
    var cr = clamp0(rec.totalCacheReadInputTokens);
    var cw = clamp0(rec.totalCacheCreationInputTokens);
    var out = clamp0(rec.totalOutputTokens);
    return {
      nonCachedInput: Math.max(ti - cr, 0),
      cacheRead: cr,
      cacheWrite: cw,
      output: out
    };
  }

  /** 按单价（货币/百万 token）计算成本 */
  function costOf(rec, price) {
    var t = splitTokens(rec);
    var c = 0;
    var i;
    for (i = 0; i < CATS.length; i++) {
      var cat = CATS[i];
      c += t[cat.key] * (clamp0(price[cat.priceKey]) || 0);
    }
    return c / 1e6;
  }

  function builtinPriceFor(model) {
    var s = String(model || "").toLowerCase();
    var i;
    for (i = 0; i < BUILTIN_PRICE_RULES.length; i++) {
      if (BUILTIN_PRICE_RULES[i].re.test(s)) return BUILTIN_PRICE_RULES[i].price;
    }
    return null;
  }

  function defaultCurrencyFor(locale) {
    return /^zh/i.test(String(locale || "")) ? "¥" : "$";
  }

  function normalizePrices(raw, locale) {
    var num = function (v) {
      var n = Number(v);
      return isFinite(n) && n >= 0 ? n : 0;
    };
    var mp = function (o) {
      var r = {};
      var keys = ["input", "cacheRead", "cacheWrite", "output"];
      var i;
      for (i = 0; i < keys.length; i++) r[keys[i]] = num(o && o[keys[i]]);
      return r;
    };
    var models = {};
    if (raw && raw.models && typeof raw.models === "object") {
      for (var m in raw.models) {
        if (Object.prototype.hasOwnProperty.call(raw.models, m)) models[m] = mp(raw.models[m]);
      }
    }
    return {
      v: 1,
      currency: typeof (raw && raw.currency) === "string" && raw.currency ? raw.currency : defaultCurrencyFor(locale),
      defaultPrice: raw ? mp(raw.defaultPrice) : mp(BUILTIN_DEFAULT_PRICE),
      models: models
    };
  }

  function priceFor(prices, model) {
    var custom = prices.models && prices.models[model];
    if (custom) return { price: custom, source: "custom" };
    var builtin = builtinPriceFor(model);
    if (builtin) return { price: builtin, source: "builtin" };
    var d = prices.defaultPrice || ZERO_P;
    var hasAny = d.input || d.cacheRead || d.cacheWrite || d.output;
    return { price: hasAny ? d : BUILTIN_DEFAULT_PRICE, source: "default" };
  }

  /* == PURE-MATH-END == */

  /* ============================ 格式化 ============================ */

  function uiLocale() {
    try {
      if (typeof snow !== "undefined" && snow && snow.context && snow.context.locale) return String(snow.context.locale);
    } catch (e) {
      /* ignore */
    }
    return (navigator && navigator.language) || "zh-CN";
  }

  /** 人类可读 token：1.23B / 45.6M / 789k */
  function fmtTokens(n) {
    if (typeof n !== "number" || !isFinite(n)) return "0";
    if (n >= 1e9) return (n / 1e9).toFixed(2) + "B";
    if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
    if (n >= 1e3) return Math.round(n / 1e3) + "k";
    return String(Math.round(n));
  }

  /** 成本展示：小数值多保留几位，避免全是 0.00 */
  function fmtCost(cur, c) {
    if (typeof c !== "number" || !isFinite(c) || c <= 0) return cur + "0";
    var s;
    if (c < 0.01) s = c.toFixed(4);
    else if (c < 1) s = c.toFixed(3);
    else if (c < 100) s = c.toFixed(2);
    else s = c.toFixed(1);
    return cur + s;
  }

  /** 百分比：与宿主 token 环同款（四舍五入到 1 位小数，按界面语言分组） */
  function fmtPct(v) {
    if (typeof v !== "number" || !isFinite(v)) return "-";
    var rounded = Math.round(v * 10) / 10;
    try {
      return rounded.toLocaleString(uiLocale(), { maximumFractionDigits: 1 }) + "%";
    } catch (e) {
      return String(rounded) + "%";
    }
  }

  function fmtDuration(ms) {
    if (typeof ms !== "number" || !isFinite(ms) || ms <= 0) return "-";
    if (ms < 1000) return Math.round(ms) + "ms";
    if (ms < 60000) return (ms / 1000).toFixed(ms < 10000 ? 1 : 0) + "s";
    var m = Math.floor(ms / 60000);
    var s = Math.round((ms % 60000) / 1000);
    if (s === 60) {
      m += 1;
      s = 0;
    }
    return m + "m " + (s < 10 ? "0" + s : s) + "s";
  }

  function fmtClock(ts) {
    if (!ts) return "-";
    var d = new Date(ts);
    var p = function (x) {
      return String(x).padStart(2, "0");
    };
    return p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds());
  }

  /**
   * 缓存命中率：严格复刻宿主输入框右侧用量环的算法与数据源（runtime.conversation.tokenUsage），
   *   环：cacheRead = Math.min(cacheReadInputTokens, input)；命中率 = cacheRead / input
   * 用 usage.records 聚合会得到「全会话账单」口径，与环的「当前上下文」口径天然对不上。
   * 返回 null 表示运行时快照还没有 tokenUsage（环此时显示 "--"），药丸一并隐藏。
   */
  function ringCacheHit() {
    var rt = state.runtime;
    var tu = rt && rt.tokenUsage;
    if (!tu) return null;
    var input = clamp0(tu.inputTokens);
    if (!(input > 0)) return null;
    var cacheRead = Math.min(clamp0(tu.cacheReadInputTokens), input);
    var cacheWrite = Math.min(clamp0(tu.cacheCreationInputTokens), Math.max(input - cacheRead, 0));
    return {
      input: input,
      cacheRead: cacheRead,
      cacheWrite: cacheWrite,
      total: input + clamp0(tu.outputTokens),
      rate: (cacheRead / input) * 100
    };
  }

  /** 账单口径命中率（全会话所有请求的缓存读 ÷ 输入），仅用于浮层对照 */
  function billCacheHit() {
    var agg = state.agg;
    if (!agg || !(agg.totals.input > 0)) return null;
    return (agg.totals.cacheRead / agg.totals.input) * 100;
  }

  /** 模型名去掉厂商前缀，便于窄条显示 */
  function shortModel(name) {
    var s = String(name || "");
    var i = s.lastIndexOf("/");
    return i >= 0 ? s.slice(i + 1) : s;
  }

  function errText(res) {
    if (!res) return "未知原因";
    if (typeof res.error === "string" && res.error) return res.error;
    if (res.denied) {
      if (typeof res.denied === "string") return res.denied;
      try {
        return "宿主拒绝访问：" + JSON.stringify(res.denied);
      } catch (e) {
        return "宿主拒绝访问";
      }
    }
    return "未知原因";
  }

  /* ============================ Lucide 图标 ============================ */

  var ICONS = {
    activity: '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>',
    timer: '<path d="M12 22a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z"/><path d="M12 8v5l3 2"/>',
    database:
      '<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v14c0 1.66 3.58 3 8 3s8-1.34 8-3V5"/><path d="M4 12c0 1.66 3.58 3 8 3s8-1.34 8-3"/>',
    "arrow-down-up": '<path d="M8 3v18"/><path d="m4 17 4 4 4-4"/><path d="M16 21V3"/><path d="m12 7 4-4 4 4"/>',
    "circle-dollar-sign":
      '<circle cx="12" cy="12" r="10"/><path d="M16 8h-6a2 2 0 1 0 0 4h4a2 2 0 1 1 0 4H8"/><path d="M12 18V6"/>',
    "sliders-horizontal":
      '<path d="M21 4h-7"/><path d="M10 4H3"/><path d="M21 12h-9"/><path d="M8 12H3"/><path d="M21 20h-5"/><path d="M12 20H3"/><path d="M14 2v4"/><path d="M8 10v4"/><path d="M16 18v4"/>',
    "refresh-cw":
      '<path d="M3 12a9 9 0 0 1 15-6.7L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-15 6.7L3 16"/><path d="M3 21v-5h5"/>',
    "circle-alert": '<circle cx="12" cy="12" r="10"/><path d="M12 8v5"/><path d="M12 16h.01"/>',
    x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>'
  };

  function svgIcon(name, size) {
    var s = size || 13;
    var inner = ICONS[name] || ICONS["circle-alert"];
    var node = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    node.setAttribute("xmlns", "http://www.w3.org/2000/svg");
    node.setAttribute("width", String(s));
    node.setAttribute("height", String(s));
    node.setAttribute("viewBox", "0 0 24 24");
    node.setAttribute("fill", "none");
    node.setAttribute("stroke", "currentColor");
    node.setAttribute("stroke-width", "2");
    node.setAttribute("stroke-linecap", "round");
    node.setAttribute("stroke-linejoin", "round");
    node.setAttribute("aria-hidden", "true");
    node.setAttribute("class", "lucide lucide-" + name);
    node.innerHTML = inner; /* 固定常量字符串，无外部输入 */
    return node;
  }

  /* ============================ 样式（跟随宿主主题变量） ============================ */

  var CSS = [
    /* 统计条：输入框正下方的一行，与输入区同宽、整组水平居中；内容超宽时换行，超宽仍居中会裁切的一侧用 safe 退回起始对齐 */
    "." + PREFIX + "-row{display:flex;flex-wrap:wrap;align-items:center;justify-content:center;gap:6px;min-width:0;",
    "padding:6px 2px 8px;font-size:11.5px;line-height:1;color:var(--text-tertiary,inherit);",
    "user-select:none;-webkit-user-select:none;justify-content:safe center;}",
    "." + PREFIX + "-row[hidden]{display:none;}",
    "." + PREFIX + "-pill{display:inline-flex;align-items:center;gap:4px;min-width:0;max-width:100%;",
    "height:22px;padding:0 8px;border:1px solid var(--border-color,rgba(127,127,127,.3));",
    "border-radius:999px;background:var(--bg-secondary,rgba(127,127,127,.06));",
    "color:var(--text-secondary,inherit);font-family:inherit;font-size:11.5px;line-height:1;white-space:nowrap;}",
    "." + PREFIX + "-pill[hidden]{display:none;}",
    "." + PREFIX + "-pill>span{overflow:hidden;text-overflow:ellipsis;}",
    "." + PREFIX + "-pill>svg{flex:0 0 auto;opacity:.7;}",
    "button." + PREFIX + "-pill{cursor:pointer;transition:background .15s,border-color .15s,color .15s;}",
    "button." + PREFIX + "-pill:hover{background:var(--bg-hover,rgba(127,127,127,.12));color:var(--text-primary,inherit);}",
    "button." + PREFIX + "-pill:focus-visible{outline:2px solid var(--accent-blue,#3b82f6);outline-offset:1px;}",
    "." + PREFIX + "-pill." + PREFIX + "-cost{color:var(--text-primary,inherit);border-color:var(--border-subtle,rgba(127,127,127,.45));}",
    "." + PREFIX + "-pill." + PREFIX + "-warn{color:var(--text-tertiary,inherit);border-style:dashed;}",
    "." + PREFIX + "-gear{display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;",
    "padding:0;border:1px solid transparent;border-radius:999px;background:transparent;color:var(--text-tertiary,inherit);",
    "cursor:pointer;transition:background .15s,color .15s;}",
    "." + PREFIX + "-gear:hover{background:var(--bg-hover,rgba(127,127,127,.12));color:var(--text-primary,inherit);}",
    "." + PREFIX + "-gear:focus-visible{outline:2px solid var(--accent-blue,#3b82f6);outline-offset:1px;}",
    "." + PREFIX + "-end{flex:0 0 auto;display:flex;align-items:center;justify-content:center;min-width:0;}",

    /* 浮层 */
    "." + PREFIX + "-pop{position:fixed;z-index:4200;box-sizing:border-box;width:min(360px,calc(100vw - 20px));",
    "padding:10px 12px;border:1px solid var(--border-color,rgba(127,127,127,.3));border-radius:10px;",
    "background:var(--bg-primary,#fff);color:var(--text-primary,inherit);font-size:12px;line-height:1.45;",
    "box-shadow:0 10px 28px rgba(0,0,0,.18);max-height:min(70vh,520px);overflow:auto;}",
    "." + PREFIX + "-pop-head{display:flex;align-items:baseline;justify-content:space-between;gap:8px;margin-bottom:6px;}",
    "." + PREFIX + "-pop-title{font-size:12px;color:var(--text-secondary,inherit);}",
    "." + PREFIX + "-big{font-size:20px;font-weight:600;line-height:1.2;overflow-wrap:anywhere;}",
    "." + PREFIX + "-sub{margin:2px 0 8px;color:var(--text-tertiary,inherit);font-size:11.5px;overflow-wrap:anywhere;}",
    "." + PREFIX + "-model{display:flex;align-items:baseline;justify-content:space-between;gap:10px;",
    "padding:5px 0;border-top:1px solid var(--border-subtle,rgba(127,127,127,.28));min-width:0;}",
    "." + PREFIX + "-model:first-of-type{border-top:none;}",
    "." + PREFIX + "-model-main{min-width:0;flex:1 1 auto;}",
    "." + PREFIX + "-model-name{font-size:12px;color:var(--text-primary,inherit);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}",
    "." + PREFIX + "-model-meta{margin-top:2px;color:var(--text-tertiary,inherit);font-size:11px;overflow-wrap:anywhere;}",
    "." + PREFIX + "-model-cost{flex:0 0 auto;font-variant-numeric:tabular-nums;white-space:nowrap;}",
    "." + PREFIX + "-foot{margin-top:8px;padding-top:8px;border-top:1px solid var(--border-subtle,rgba(127,127,127,.28));",
    "color:var(--text-tertiary,inherit);font-size:11px;overflow-wrap:anywhere;}",
    "." + PREFIX + "-acts{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px;}",
    "." + PREFIX + "-btn{display:inline-flex;align-items:center;gap:5px;height:26px;padding:0 10px;",
    "border:1px solid var(--border-color,rgba(127,127,127,.3));border-radius:999px;",
    "background:var(--bg-secondary,rgba(127,127,127,.06));color:var(--text-secondary,inherit);",
    "font-family:inherit;font-size:11.5px;line-height:1;cursor:pointer;transition:background .15s,color .15s;}",
    "." + PREFIX + "-btn:hover{background:var(--bg-hover,rgba(127,127,127,.12));color:var(--text-primary,inherit);}",
    "." + PREFIX + "-btn:focus-visible{outline:2px solid var(--accent-blue,#3b82f6);outline-offset:1px;}",
    "." + PREFIX + "-rowline{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:5px 0;min-width:0;}",
    "." + PREFIX + "-rowline>span{min-width:0;overflow-wrap:anywhere;}",
    "." + PREFIX + "-switch{position:relative;flex:0 0 auto;width:32px;height:18px;padding:0;border-radius:999px;",
    "border:1px solid var(--border-color,rgba(127,127,127,.4));background:var(--bg-tertiary,rgba(127,127,127,.18));",
    "cursor:pointer;transition:background .15s,border-color .15s;}",
    "." + PREFIX + "-switch::after{content:\"\";position:absolute;top:2px;left:2px;width:12px;height:12px;border-radius:50%;",
    "background:var(--text-tertiary,#8a8f98);transition:transform .15s,background .15s;}",
    "." + PREFIX + "-switch[data-on=\"1\"]{background:var(--accent-blue,#3b82f6);border-color:transparent;}",
    "." + PREFIX + "-switch[data-on=\"1\"]::after{transform:translateX(14px);background:#fff;}",
    "." + PREFIX + "-switch:focus-visible{outline:2px solid var(--accent-blue,#3b82f6);outline-offset:1px;}",
    "." + PREFIX + "-seg{display:inline-flex;flex:0 0 auto;border:1px solid var(--border-color,rgba(127,127,127,.3));",
    "border-radius:999px;overflow:hidden;}",
    "." + PREFIX + "-seg>button{height:22px;padding:0 9px;border:none;background:transparent;",
    "color:var(--text-secondary,inherit);font-family:inherit;font-size:11px;line-height:1;cursor:pointer;}",
    "." + PREFIX + "-seg>button[data-on=\"1\"]{background:var(--bg-tertiary,rgba(127,127,127,.18));color:var(--text-primary,inherit);}",
    "." + PREFIX + "-seg>button:focus-visible{outline:2px solid var(--accent-blue,#3b82f6);outline-offset:-2px;}",

    /* 窄窗口：先砍次要指标，不整体缩放 */
    "@media (max-width:760px){." + PREFIX + "-pill[data-opt=\"rounds\"]{display:none;}}",
    "@media (max-width:620px){." + PREFIX + "-pill[data-opt=\"speed\"]{display:none;}",
    "." + PREFIX + "-row{padding:5px 2px 6px;}}"
  ].join("");

  var styleEl = null;

  function injectStyle() {
    if (styleEl && styleEl.isConnected) return;
    styleEl = document.createElement("style");
    styleEl.setAttribute("data-snow-plugin", "snow-session-stats-pills");
    styleEl.textContent = CSS;
    document.head.appendChild(styleEl);
  }

  /* ============================ DOM 工具 ============================ */

  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = String(text);
    return node;
  }

  function pill(optName, iconName, title) {
    var node = el("span", PREFIX + "-pill");
    node.setAttribute("data-opt", optName);
    if (title) node.title = title;
    node.appendChild(svgIcon(iconName, 12));
    var text = el("span");
    node.appendChild(text);
    return { node: node, text: text };
  }

  /* ============================ 状态 ============================ */

  var state = {
    conversationId: null,
    runtime: null,
    agg: null,
    rounds: 0,
    /* 流式 token 采样：[{ t, count }]，用于 3 秒窗口瞬时 TPS */
    samples: [],
    prices: null,
    priceSource: "builtin",
    pricesUpdatedAt: 0,
    loadingUsage: false,
    loadingRounds: false,
    lastError: null,
    updatedAt: 0
  };

  var root = null;
  var ui = null;
  var runtimeTimer = null;
  var usageTimer = null;
  var roundsTimer = null;
  var observer = null;
  var mountPending = null;
  var pop = null;
  var popCleanup = null;

  /* ============================ 数据获取 ============================ */

  function pickDomain(res, id) {
    if (!res) return null;
    var domains = res.domains;
    if (domains && Object.prototype.hasOwnProperty.call(domains, id)) return domains[id];
    return null;
  }

  function isDenied(res, id) {
    if (!res || !res.denied) return false;
    var d = res.denied;
    if (Array.isArray(d)) return d.indexOf(id) >= 0;
    if (typeof d === "object") return !!d[id];
    return false;
  }

  function currentConversationId() {
    /* 上下文显式给了 conversationId（含 null = 新会话草稿）时以它为准；
       老宿主没有该字段时再退回焦点会话运行时快照（快照可能是上一个会话，故只能兜底）。 */
    var ctx = null;
    try {
      if (typeof snow !== "undefined" && snow) ctx = snow.context || null;
    } catch (e) {
      ctx = null;
    }
    if (ctx && Object.prototype.hasOwnProperty.call(ctx, "conversationId")) {
      return ctx.conversationId ? String(ctx.conversationId) : null;
    }
    if (state.runtime && state.runtime.conversationId) return String(state.runtime.conversationId);
    return null;
  }

  function emptyAgg() {
    return {
      models: {},
      totals: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      requests: 0,
      errorRequests: 0,
      subAgentRequests: 0,
      truncated: false
    };
  }

  function accumulate(acc, rec) {
    if (!rec) return;
    var model = String(rec.model || "") || "unknown";
    var m = acc.models[model];
    if (!m) {
      m = { requests: 0, errorRequests: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
      acc.models[model] = m;
    }
    var input = clamp0(rec.inputTokens);
    var output = clamp0(rec.outputTokens);
    var cacheRead = clamp0(rec.cacheReadInputTokens);
    var cacheWrite = clamp0(rec.cacheCreationInputTokens);
    var isError = String(rec.status || "") === "error";

    m.requests += 1;
    m.input += input;
    m.output += output;
    m.cacheRead += cacheRead;
    m.cacheWrite += cacheWrite;
    acc.requests += 1;
    acc.totals.input += input;
    acc.totals.output += output;
    acc.totals.cacheRead += cacheRead;
    acc.totals.cacheWrite += cacheWrite;
    if (isError) {
      m.errorRequests += 1;
      acc.errorRequests += 1;
    }
    if (rec.isSubAgent) acc.subAgentRequests += 1;
  }

  function fetchUsage(cid) {
    var acc = emptyAgg();
    var offset = 0;
    var pages = 0;

    function next() {
      if (pages >= MAX_PAGES) {
        acc.truncated = true;
        return Promise.resolve(acc);
      }
      return snow.metadata
        .get(["usage"], { params: { conversationId: cid, limit: PAGE, offset: offset } })
        .then(function (res) {
          if (isDenied(res, "usage")) throw new Error("未声明或未授权的元数据域：usage");
          var usage = pickDomain(res, "usage");
          var items = usage && usage.records && Array.isArray(usage.records.items) ? usage.records.items : [];
          var i;
          for (i = 0; i < items.length; i++) accumulate(acc, items[i]);
          pages += 1;
          if (items.length < PAGE) return acc;
          offset += PAGE;
          return next();
        });
    }

    return next();
  }

  function fetchRounds(cid) {
    return snow.metadata.get(["messages"], { params: { conversationId: cid } }).then(function (res) {
      if (isDenied(res, "messages")) throw new Error("未声明或未授权的元数据域：messages");
      var d = pickDomain(res, "messages");
      var list = d && Array.isArray(d.userMessages) ? d.userMessages : [];
      var n = 0;
      var i;
      for (i = 0; i < list.length; i++) {
        if (!list[i] || !list[i].isContextCompaction) n += 1;
      }
      state.rounds = n;
    });
  }

  function fetchRuntime() {
    return snow.metadata.get(["runtime"]).then(function (res) {
      var d = pickDomain(res, "runtime");
      state.runtime = d && d.conversation ? d.conversation : null;
    });
  }

  /* ============================ 价格联动 ============================ */

  function readBridgeRaw() {
    try {
      var node = document.querySelector(BRIDGE_SELECTOR);
      if (node && node.textContent) return JSON.parse(node.textContent);
    } catch (e) {
      /* 桥接节点内容异常时继续尝试 localStorage */
    }
    try {
      var raw = window.localStorage.getItem(BRIDGE_KEY);
      if (raw) return JSON.parse(raw);
    } catch (e) {
      /* 隔离世界或受限 origin 下 localStorage 不可用，属预期 */
    }
    return null;
  }

  function refreshPrices() {
    var raw = readBridgeRaw();
    if (raw && typeof raw === "object") {
      state.prices = normalizePrices(raw, uiLocale());
      state.priceSource = "bridge";
      state.pricesUpdatedAt = Date.now();
    } else {
      state.prices = normalizePrices(null, uiLocale());
      state.priceSource = "builtin";
    }
  }

  function sumCost() {
    var prices = state.prices || normalizePrices(null, uiLocale());
    var agg = state.agg;
    var out = { total: 0, currency: prices.currency, list: [] };
    if (!agg) return out;
    var name;
    for (name in agg.models) {
      if (!Object.prototype.hasOwnProperty.call(agg.models, name)) continue;
      var m = agg.models[name];
      var rec = {
        totalInputTokens: m.input,
        totalOutputTokens: m.output,
        totalCacheReadInputTokens: m.cacheRead,
        totalCacheCreationInputTokens: m.cacheWrite
      };
      var pf = priceFor(prices, name);
      var cost = costOf(rec, pf.price);
      out.total += cost;
      out.list.push({
        model: name,
        requests: m.requests,
        errorRequests: m.errorRequests,
        tokens: splitTokens(rec),
        input: m.input,
        output: m.output,
        cost: cost,
        price: pf.price,
        source: pf.source
      });
    }
    out.list.sort(function (a, b) {
      return b.cost - a.cost;
    });
    return out;
  }

  /* ============================ 渲染 ============================ */

  function buildRow() {
    var row = el("div", PREFIX + "-row");
    row.setAttribute("data-snow-stats-pills", "1");

    var rounds = pill("rounds", "activity", "轮次 = 用户消息数；步数 = 模型请求数（含工具步）");
    var speed = pill("speed", "timer", "流式中显示首 token 与瞬时输出速度（最近 3 秒窗口内 token 增量 / 实际跨度）；空闲时显示上一轮耗时");
    var cache = pill("cache", "database", "缓存命中率：与输入框右侧用量环同源（当前上下文口径，缓存读 ÷ 输入）");
    var usage = pill("usage", "arrow-down-up", "本会话累计输入（含缓存读）与输出 token");
    var costBtn = el("button", PREFIX + "-pill " + PREFIX + "-cost");
    costBtn.type = "button";
    costBtn.setAttribute("data-opt", "cost");
    costBtn.title = "本会话预估成本，点击查看按模型拆分（单价与「成本核算看板」联动）";
    costBtn.appendChild(svgIcon("circle-dollar-sign", 12));
    var costText = el("span");
    costBtn.appendChild(costText);

    var end = el("div", PREFIX + "-end");
    var gear = el("button", PREFIX + "-gear");
    gear.type = "button";
    gear.title = "会话统计条设置";
    gear.setAttribute("aria-label", "会话统计条设置");
    gear.appendChild(svgIcon("sliders-horizontal", 14));
    end.appendChild(gear);

    row.appendChild(rounds.node);
    row.appendChild(speed.node);
    row.appendChild(cache.node);
    row.appendChild(usage.node);
    row.appendChild(costBtn);
    row.appendChild(end);

    ui = {
      row: row,
      rounds: rounds,
      speed: speed,
      cache: cache,
      usage: usage,
      costBtn: costBtn,
      costText: costText,
      gear: gear
    };

    costBtn.addEventListener("click", function (ev) {
      ev.stopPropagation();
      openCostPopover();
    });
    gear.addEventListener("click", function (ev) {
      ev.stopPropagation();
      openSettings();
    });

    return row;
  }

  function setPill(item, visible, text) {
    item.node.hidden = !visible;
    if (visible && item.text.textContent !== text) item.text.textContent = text;
  }

  function resetSpeedSamples() {
    state.samples = [];
  }

  /** 每次 runtime 轮询成功后记账：流式期间记录 (时间戳, 累计输出 token) */
  function pushSpeedSample(rt) {
    if (!rt || !rt.isStreaming) return;
    var count = clamp0(rt.streamTokenCount);
    var now = Date.now();
    var arr = state.samples;
    if (arr.length && count < arr[arr.length - 1].count) resetSpeedSamples(); /* 宿主重置计数（新一步）→ 重新起算 */
    arr = state.samples;
    arr.push({ t: now, count: count });
    while (arr.length > 2 && now - arr[0].t > TPS_SAMPLE_KEEP_MS) arr.shift();
  }

  /**
   * 瞬时 TPS：以最近一次采样为终点，回溯到 3 秒窗口内最早的一个样本，
   * 用 (token 增量 ÷ 实际跨度) 得速率——跨度略大于 3s（受 1s 轮询粒度影响）时速率本身仍然准确。
   * 样本不足（流式刚开始）返回 null，此时药丸只显示首 token。
   */
  function instantTps() {
    var arr = state.samples;
    if (!arr || arr.length < 2) return null;
    var newest = arr[arr.length - 1];
    var base = null;
    var i;
    for (i = arr.length - 1; i >= 0; i--) {
      if (newest.t - arr[i].t >= TPS_WINDOW_MS) {
        base = arr[i];
        break;
      }
    }
    if (!base) base = arr[0];
    var span = newest.t - base.t;
    if (span < TPS_MIN_SPAN_MS) return null;
    var delta = newest.count - base.count;
    if (delta < 0) return null;
    return delta / (span / 1000);
  }

  function speedInfo() {
    var rt = state.runtime;
    if (!rt) return null;
    if (rt.isStreaming) {
      var ttft = typeof rt.streamTtftMs === "number" && rt.streamTtftMs > 0 ? rt.streamTtftMs : null;
      return { streaming: true, ttft: ttft, tps: instantTps(), lastRun: null };
    }
    var last = typeof rt.lastRunDurationMs === "number" && rt.lastRunDurationMs > 0 ? rt.lastRunDurationMs : null;
    return { streaming: false, ttft: null, tps: null, lastRun: last };
  }

  function render() {
    if (!root || !ui) return;
    var cid = state.conversationId;
    root.hidden = !cid;
    if (!cid) return;

    var agg = state.agg;
    var sum = sumCost();
    var currency = sum.currency;

    /* 轮 · 步 */
    var roundsText;
    if (agg) roundsText = state.rounds + " 轮 · " + agg.requests + " 步";
    else roundsText = state.rounds > 0 ? state.rounds + " 轮 · 统计中" : "统计中";
    setPill(ui.rounds, !!cfg.showRounds, roundsText);

    /* 速度 */
    var sp = speedInfo();
    var speedVisible = false;
    var speedText = "";
    if (sp && sp.streaming) {
      var bits = [];
      if (sp.ttft != null) bits.push("首 token " + fmtDuration(sp.ttft));
      if (sp.tps != null) bits.push(sp.tps.toFixed(1) + " tok/s");
      if (bits.length) {
        speedVisible = true;
        speedText = bits.join(" · ");
      }
    } else if (sp && sp.lastRun != null) {
      speedVisible = true;
      speedText = "上轮 " + fmtDuration(sp.lastRun);
    }
    setPill(ui.speed, !!cfg.showSpeed && speedVisible, speedText);

    /* 缓存命中：与输入框右侧用量环同源同公式（runtime.tokenUsage，上下文口径） */
    var hint = ringCacheHit();
    setPill(ui.cache, !!cfg.showCache && !!hint, "缓存命中 " + fmtPct(hint ? hint.rate : null));

    /* 输入 / 输出 */
    var usageText = agg ? "输入 " + fmtTokens(agg.totals.input) + " · 输出 " + fmtTokens(agg.totals.output) : "输入 - · 输出 -";
    setPill(ui.usage, !!cfg.showUsage, usageText);

    /* 成本 */
    var costVisible = !!cfg.showCost;
    var costText = fmtCost(currency, sum.total);
    if (state.lastError && !agg) costText = "成本 -";
    ui.costBtn.hidden = !costVisible;
    if (costVisible && ui.costText.textContent !== costText) ui.costText.textContent = costText;
    ui.costBtn.classList.toggle(PREFIX + "-warn", !!state.lastError && !agg);
    if (state.lastError && !agg) ui.costBtn.title = "读取用量失败：" + state.lastError;
    else ui.costBtn.title = "本会话预估成本，点击查看按模型拆分（单价与「成本核算看板」联动）";
  }

  /* ============================ 浮层 ============================ */

  function closePopover() {
    if (popCleanup) {
      popCleanup();
      popCleanup = null;
    }
    if (pop && pop.parentNode) pop.parentNode.removeChild(pop);
    pop = null;
  }

  function placePopover(anchor) {
    if (!pop || !anchor) return;
    var r = anchor.getBoundingClientRect();
    var pr = pop.getBoundingClientRect();
    var gap = 8;
    var vw = window.innerWidth;
    var vh = window.innerHeight;
    var left = Math.min(Math.max(8, r.left), Math.max(8, vw - pr.width - 8));
    var top = r.top - pr.height - gap;
    if (top < 8) top = Math.min(vh - pr.height - 8, r.bottom + gap);
    if (top < 8) top = 8;
    pop.style.left = Math.round(left) + "px";
    pop.style.top = Math.round(top) + "px";
  }

  function mountPopover(anchor, node) {
    closePopover();
    pop = node;
    document.body.appendChild(node);
    placePopover(anchor);

    var onDocDown = function (ev) {
      if (pop && (pop.contains(ev.target) || (anchor && anchor.contains(ev.target)))) return;
      closePopover();
    };
    var onKey = function (ev) {
      if (ev.key === "Escape") closePopover();
    };
    var onScroll = function () {
      closePopover();
    };
    document.addEventListener("mousedown", onDocDown, true);
    document.addEventListener("keydown", onKey, true);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onScroll, true);

    popCleanup = function () {
      document.removeEventListener("mousedown", onDocDown, true);
      document.removeEventListener("keydown", onKey, true);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onScroll, true);
    };
  }

  function priceSourceLabel(source) {
    if (source === "custom") return "自定义";
    if (source === "builtin") return "内置估算";
    return "默认价";
  }

  function openCostPopover() {
    if (pop && pop.getAttribute("data-kind") === "cost") {
      closePopover();
      return;
    }
    var sum = sumCost();
    var agg = state.agg;
    var node = el("div", PREFIX + "-pop");
    node.setAttribute("data-kind", "cost");
    node.setAttribute("role", "dialog");
    node.setAttribute("aria-label", "本会话成本明细");

    var head = el("div", PREFIX + "-pop-head");
    head.appendChild(el("span", PREFIX + "-pop-title", "本会话成本"));
    var closeBtn = el("button", PREFIX + "-gear");
    closeBtn.type = "button";
    closeBtn.title = "关闭";
    closeBtn.setAttribute("aria-label", "关闭");
    closeBtn.appendChild(svgIcon("x", 13));
    closeBtn.addEventListener("click", closePopover);
    head.appendChild(closeBtn);
    node.appendChild(head);

    node.appendChild(el("div", PREFIX + "-big", fmtCost(sum.currency, sum.total)));

    var sub;
    if (agg) {
      sub = agg.requests + " 步 · 输入 " + fmtTokens(agg.totals.input) + "（缓存读 " + fmtTokens(agg.totals.cacheRead) + "）· 输出 " +
        fmtTokens(agg.totals.output);
      if (agg.errorRequests > 0) sub += " · 失败 " + agg.errorRequests + " 次";
      if (agg.truncated) sub += " · 记录已截断（仅统计最近 " + PAGE * MAX_PAGES + " 步）";
    } else if (state.lastError) {
      sub = "用量读取失败：" + state.lastError;
    } else {
      sub = "正在读取用量统计…";
    }
    node.appendChild(el("div", PREFIX + "-sub", sub));

    if (sum.list.length) {
      sum.list.forEach(function (item) {
        var row = el("div", PREFIX + "-model");
        var main = el("div", PREFIX + "-model-main");
        main.appendChild(el("div", PREFIX + "-model-name", shortModel(item.model) || "unknown"));
        var t = item.tokens;
        var meta = "非缓存 " + fmtTokens(t.nonCachedInput) + " · 缓存读 " + fmtTokens(t.cacheRead) +
          (t.cacheWrite > 0 ? " · 缓存写 " + fmtTokens(t.cacheWrite) : "") + " · 输出 " + fmtTokens(t.output) +
          " · " + item.requests + " 步";
        main.appendChild(el("div", PREFIX + "-model-meta", meta));
        main.appendChild(
          el(
            "div",
            PREFIX + "-model-meta",
            "单价 " + fmtPriceNum(item.price.input) + " / " + fmtPriceNum(item.price.cacheRead) + " / " +
              fmtPriceNum(item.price.cacheWrite) + " / " + fmtPriceNum(item.price.output) + " 每百万 token（" +
              priceSourceLabel(item.source) + "）"
          )
        );
        row.appendChild(main);
        row.appendChild(el("div", PREFIX + "-model-cost", fmtCost(sum.currency, item.cost)));
        node.appendChild(row);
      });
    } else if (!state.lastError) {
      node.appendChild(el("div", PREFIX + "-foot", "本会话还没有产生的用量记录。"));
    }

    var srcText = state.priceSource === "bridge"
      ? "单价来源：成本核算看板（联动快照 " + fmtClock(state.pricesUpdatedAt) + "）"
      : "单价来源：内置估算规则（未读到成本核算看板的价格快照，打开一次看板即可联动）";
    var foot = el("div", PREFIX + "-foot");
    foot.appendChild(el("div", null, srcText));
    var ringInfo = ringCacheHit();
    var billInfo = billCacheHit();
    foot.appendChild(
      el(
        "div",
        null,
        "命中率：药丸沿用输入框右侧用量环口径（runtime.tokenUsage，缓存读 ÷ 输入，上限 100%）" +
          (ringInfo
            ? "，当前 " + fmtPct(ringInfo.rate) + "（输入 " + fmtTokens(ringInfo.input) + " · 缓存读 " + fmtTokens(ringInfo.cacheRead) + "）"
            : "，运行时暂无快照") +
          "；全会话账单口径" + (billInfo != null ? "为 " + fmtPct(billInfo) : "暂无数据") + "。"
      )
    );
    foot.appendChild(el("div", null, "口径：非缓存输入 = 输入 − 缓存读；成本 = Σ(token × 单价) / 100 万。更新于 " + fmtClock(state.updatedAt) + "。"));
    node.appendChild(foot);

    var acts = el("div", PREFIX + "-acts");
    var refreshBtn = el("button", PREFIX + "-btn");
    refreshBtn.type = "button";
    refreshBtn.appendChild(svgIcon("refresh-cw", 12));
    refreshBtn.appendChild(el("span", null, "立即刷新"));
    refreshBtn.addEventListener("click", function () {
      refreshPrices();
      pollUsage(true).then(function () {
        closePopover();
        openCostPopover();
      });
    });
    acts.appendChild(refreshBtn);
    node.appendChild(acts);

    mountPopover(ui.costBtn, node);
  }

  function fmtPriceNum(v) {
    var n = typeof v === "number" && isFinite(v) ? v : 0;
    if (n === 0) return "0";
    if (n >= 100) return n.toFixed(0);
    if (n >= 10) return n.toFixed(1);
    if (n >= 1) return n.toFixed(2).replace(/0$/, "");
    return n.toFixed(3).replace(/0+$/, "").replace(/\.$/, "");
  }

  function switchRow(label, getter, setter) {
    var row = el("div", PREFIX + "-rowline");
    row.appendChild(el("span", null, label));
    var sw = el("button", PREFIX + "-switch");
    sw.type = "button";
    sw.setAttribute("role", "switch");
    sw.setAttribute("aria-label", label);
    var sync = function () {
      var on = !!getter();
      sw.setAttribute("data-on", on ? "1" : "0");
      sw.setAttribute("aria-checked", on ? "true" : "false");
    };
    sync();
    sw.addEventListener("click", function () {
      setter(!getter());
      saveCfg();
      sync();
      render();
    });
    row.appendChild(sw);
    return row;
  }

  function openSettings() {
    if (pop && pop.getAttribute("data-kind") === "settings") {
      closePopover();
      return;
    }
    var node = el("div", PREFIX + "-pop");
    node.setAttribute("data-kind", "settings");
    node.setAttribute("role", "dialog");
    node.setAttribute("aria-label", "会话统计条设置");

    var head = el("div", PREFIX + "-pop-head");
    head.appendChild(el("span", PREFIX + "-pop-title", "会话统计条设置"));
    var closeBtn = el("button", PREFIX + "-gear");
    closeBtn.type = "button";
    closeBtn.title = "关闭";
    closeBtn.setAttribute("aria-label", "关闭");
    closeBtn.appendChild(svgIcon("x", 13));
    closeBtn.addEventListener("click", closePopover);
    head.appendChild(closeBtn);
    node.appendChild(head);

    node.appendChild(switchRow("轮次与步数", function () { return cfg.showRounds; }, function (v) { cfg.showRounds = v; }));
    node.appendChild(switchRow("首 token 与速度", function () { return cfg.showSpeed; }, function (v) { cfg.showSpeed = v; }));
    node.appendChild(switchRow("缓存命中率", function () { return cfg.showCache; }, function (v) { cfg.showCache = v; }));
    node.appendChild(switchRow("输入与输出 token", function () { return cfg.showUsage; }, function (v) { cfg.showUsage = v; }));
    node.appendChild(switchRow("会话成本", function () { return cfg.showCost; }, function (v) { cfg.showCost = v; }));

    var ivRow = el("div", PREFIX + "-rowline");
    ivRow.appendChild(el("span", null, "用量刷新间隔"));
    var seg = el("div", PREFIX + "-seg");
    [3000, 5000, 10000].forEach(function (ms) {
      var b = el("button", null, ms / 1000 + "s");
      b.type = "button";
      b.setAttribute("data-on", cfg.intervalMs === ms ? "1" : "0");
      b.addEventListener("click", function () {
        cfg.intervalMs = ms;
        saveCfg();
        restartUsageTimer();
        var btns = seg.querySelectorAll("button");
        var i;
        for (i = 0; i < btns.length; i++) {
          btns[i].setAttribute("data-on", Number(btns[i].textContent.replace("s", "")) * 1000 === ms ? "1" : "0");
        }
      });
      seg.appendChild(b);
    });
    ivRow.appendChild(seg);
    node.appendChild(ivRow);

    var foot = el("div", PREFIX + "-foot");
    foot.appendChild(
      el(
        "div",
        null,
        state.priceSource === "bridge"
          ? "单价已与「成本核算看板」联动（快照 " + fmtClock(state.pricesUpdatedAt) + "）。"
          : "未读到看板价格快照，当前用内置估算规则；打开一次「成本核算看板」面板后自动联动。"
      )
    );
    foot.appendChild(el("div", null, "数据来自宿主的 usage 与 messages 元数据域，只在本机计算，不发网络请求。"));
    node.appendChild(foot);

    var acts = el("div", PREFIX + "-acts");
    var rb = el("button", PREFIX + "-btn");
    rb.type = "button";
    rb.appendChild(svgIcon("refresh-cw", 12));
    rb.appendChild(el("span", null, "立即刷新"));
    rb.addEventListener("click", function () {
      refreshPrices();
      pollUsage(true).then(function () {
        closePopover();
        openSettings();
      });
    });
    acts.appendChild(rb);
    node.appendChild(acts);

    mountPopover(ui.gear, node);
  }

  /* ============================ 轮询 ============================ */

  function pollRuntime() {
    if (!state.conversationId) return Promise.resolve();
    return fetchRuntime()
      .then(function () {
        pushSpeedSample(state.runtime);
        render();
      })
      .catch(function (e) {
        log("读取实时状态失败：" + e);
      });
  }

  var usageSeq = 0;

  function pollUsage(force) {
    var cid = state.conversationId;
    if (!cid) return Promise.resolve();
    if (state.loadingUsage && !force) return Promise.resolve();
    if (!force && typeof document !== "undefined" && document.hidden) return Promise.resolve();
    var seq = ++usageSeq;
    state.loadingUsage = true;
    refreshPrices();
    return fetchUsage(cid)
      .then(function (agg) {
        if (seq !== usageSeq || cid !== state.conversationId) return;
        state.agg = agg;
        state.lastError = null;
        state.updatedAt = Date.now();
        render();
      })
      .catch(function (e) {
        if (seq !== usageSeq) return;
        state.lastError = String((e && e.message) || e);
        log("读取用量失败：" + state.lastError);
        render();
      })
      .then(function () {
        if (seq === usageSeq) state.loadingUsage = false;
      });
  }

  function pollRounds(force) {
    var cid = state.conversationId;
    if (!cid) return Promise.resolve();
    if (state.loadingRounds && !force) return Promise.resolve();
    state.loadingRounds = true;
    return fetchRounds(cid)
      .then(function () {
        render();
      })
      .catch(function (e) {
        log("读取轮数失败：" + e);
      })
      .then(function () {
        state.loadingRounds = false;
      });
  }

  function restartUsageTimer() {
    if (usageTimer) clearInterval(usageTimer);
    usageTimer = setInterval(function () {
      pollUsage(false);
    }, cfg.intervalMs);
  }

  /* ============================ 会话切换与挂载 ============================ */

  function syncConversation(force) {
    var cid = currentConversationId();
    if (cid === state.conversationId && !force) return;
    state.conversationId = cid;
    state.agg = null;
    state.rounds = 0;
    state.lastError = null;
    state.updatedAt = 0;
    resetSpeedSamples();
    render();
    if (!cid) return;
    refreshPrices();
    pollRuntime();
    pollUsage(true);
    pollRounds(true);
  }

  function mountTarget() {
    var region = document.querySelector('[data-snow-anchor="chat.input"]');
    if (!region) return null;
    var content = region.querySelector(".input-content");
    return content || region;
  }

  function ensureMounted() {
    var host = mountTarget();
    if (!host) {
      if (root && root.parentNode) root.parentNode.removeChild(root);
      return false;
    }
    if (!root) root = buildRow();
    if (root.parentNode !== host || host.lastElementChild !== root) host.appendChild(root);
    return true;
  }

  function scheduleMount() {
    if (mountPending) return;
    mountPending = setTimeout(function () {
      mountPending = null;
      var ok = ensureMounted();
      if (ok) {
        var cid = currentConversationId();
        if (cid !== state.conversationId) syncConversation(false);
        else render();
      }
    }, 120);
  }

  function start() {
    injectStyle();
    ensureMounted();
    syncConversation(true);

    observer = new MutationObserver(function () {
      if (!root || !root.isConnected) scheduleMount();
    });
    observer.observe(document.body, { childList: true, subtree: true });

    runtimeTimer = setInterval(pollRuntime, RUNTIME_MS);
    roundsTimer = setInterval(function () {
      pollRounds(false);
    }, ROUNDS_MS);
    restartUsageTimer();

    if (typeof snow !== "undefined" && snow && typeof snow.on === "function") {
      snow.on("view-enter", function () {
        scheduleMount();
        syncConversation(true);
      });
      snow.on("conversation-change", function () {
        scheduleMount();
        syncConversation(true);
      });
      snow.on("stream-end", function () {
        resetSpeedSamples();
        pollRuntime();
        pollUsage(true);
        pollRounds(true);
      });
      snow.on("stream-start", function () {
        resetSpeedSamples();
        pollRuntime();
      });
    }

    if (typeof snow !== "undefined" && snow && typeof snow.onCleanup === "function") {
      snow.onCleanup(function () {
        if (observer) {
          observer.disconnect();
          observer = null;
        }
        if (mountPending) {
          clearTimeout(mountPending);
          mountPending = null;
        }
        if (runtimeTimer) {
          clearInterval(runtimeTimer);
          runtimeTimer = null;
        }
        if (usageTimer) {
          clearInterval(usageTimer);
          usageTimer = null;
        }
        if (roundsTimer) {
          clearInterval(roundsTimer);
          roundsTimer = null;
        }
        closePopover();
        if (root && root.parentNode) root.parentNode.removeChild(root);
        root = null;
        ui = null;
        if (styleEl && styleEl.parentNode) styleEl.parentNode.removeChild(styleEl);
        styleEl = null;
      });
    }

    log("已启动：统计条挂载在输入框下方，用量刷新间隔 " + cfg.intervalMs + "ms");
  }

  start();
})();
