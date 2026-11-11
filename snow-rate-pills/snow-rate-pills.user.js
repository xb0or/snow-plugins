// ==UserScript==
// @name         用量胶囊
// @name:en      Rate Pills
// @namespace    kedou
// @version      0.9.2
// @description  把 RPD / TPD / RPM / ITPM / OTPM 五项用量指标显示成可自由拖放的胶囊，默认顶部居中，每颗可单独显示或隐藏，刷新速度可切到实时
// @author       kedou
// @license      MIT
// @icon         lucide:Gauge
// @snow-target  client
// @snow-scope   global
// @snow-privacy usage
// @run-at       document-idle
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// ==/UserScript==

/*
 * 用量胶囊（snow-rate-pills）—— Snow App 客户端脚本
 *
 * 与面板插件 com.seagull.rate-limits 同口径，只取五项指标：
 *   RPD  区间请求总数（跟随「范围」胶囊切换）
 *   TPD  区间输入 + 输出 token
 *   RPM  最近 60 秒请求数
 *   ITPM 最近 60 秒输入 token
 *   OTPM 最近 60 秒输出 token
 *
 * 形态：六颗独立胶囊（五项指标 + 一颗范围控制），默认在窗口顶部居中排布（放不下自动换行），
 *       可拖到任意位置；拖动过的记住坐标，没拖过的跟随窗口宽度重新居中。
 * 显示：逐颗控制。鼠标移到某颗胶囊上会在右侧出现一个 X，点一下只隐藏这一颗；
 *       隐藏的胶囊不再占用居中排布，其余胶囊自动重新居中；恢复在顶栏菜单里逐颗开关。
 * 入口：顶栏「待办列表」按钮右侧（与通知推送铃铛同一位置）的仪表按钮。
 * 动效：数值变化的那颗胶囊播放约 3.2 秒的彩色扫光 + 彩色数字 + 色相旋转描边。
 * 数据：snow.metadata.get(["usage"])，默认每 10 秒刷新一次；标签页隐藏时不刷新。
 */

(function () {
  "use strict";

  if (typeof snow === "undefined" || !snow.metadata) return;

  var PREFIX = "srp";
  var STORAGE_KEY = "srp.state";
  var LIVE_WINDOW_MS = 60000;
  var TOP_OFFSET = 56;
  var PILL_GAP = 8;
  var LINE_HEIGHT = 30;
  var SIDE_PADDING = 8;
  var ICON_GAUGE =
    '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" ' +
    'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m12 14 4-4"/>' +
    '<path d="M3.34 19a10 10 0 1 1 17.32 0"/></svg>';
  var ICON_CLOSE =
    '<svg viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" stroke-width="2.6" ' +
    'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18"/>' +
    '<path d="m6 6 12 12"/></svg>';

  var PILLS = [
    { key: "rpd", abbr: "RPD", name: "每日请求" },
    { key: "tpd", abbr: "TPD", name: "每日 Token" },
    { key: "rpm", abbr: "RPM", name: "每分钟请求" },
    { key: "itpm", abbr: "ITPM", name: "输入 Token/分" },
    { key: "otpm", abbr: "OTPM", name: "输出 Token/分" },
  ];
  var KEYS = PILLS.map(function (pill) {
    return pill.key;
  }).concat(["range"]);

  /* #region pure */

  var SRP_PRESETS = [
    { key: "today", label: "今天" },
    { key: "yesterday", label: "昨天" },
    { key: "d7", label: "近 7 天" },
    { key: "d30", label: "近 30 天" },
    { key: "month", label: "本月" },
    { key: "lastMonth", label: "上月" },
    { key: "all", label: "全部" },
  ];

  function srpPad2(n) {
    return (n < 10 ? "0" : "") + n;
  }

  function srpFormatLocal(ms) {
    var d = new Date(ms);
    return (
      d.getFullYear() +
      "-" +
      srpPad2(d.getMonth() + 1) +
      "-" +
      srpPad2(d.getDate()) +
      " " +
      srpPad2(d.getHours()) +
      ":" +
      srpPad2(d.getMinutes())
    );
  }

  /** 预设范围：本地自然日边界，与面板插件一致 */
  function srpRangeFor(preset, nowMs) {
    var d = new Date(nowMs);
    var y = d.getFullYear();
    var m = d.getMonth();
    var day = d.getDate();
    var dayStart = new Date(y, m, day).getTime();
    if (preset === "yesterday") {
      return { sinceMs: new Date(y, m, day - 1).getTime(), untilMs: dayStart - 1000 };
    }
    if (preset === "d7") {
      return { sinceMs: new Date(y, m, day - 6).getTime(), untilMs: nowMs };
    }
    if (preset === "d30") {
      return { sinceMs: new Date(y, m, day - 29).getTime(), untilMs: nowMs };
    }
    if (preset === "month") {
      return { sinceMs: new Date(y, m, 1).getTime(), untilMs: nowMs };
    }
    if (preset === "lastMonth") {
      return {
        sinceMs: new Date(y, m - 1, 1).getTime(),
        untilMs: new Date(y, m, 0, 23, 59, 59).getTime(),
      };
    }
    if (preset === "all") {
      return { sinceMs: new Date(1970, 0, 1).getTime(), untilMs: nowMs };
    }
    return { sinceMs: dayStart, untilMs: nowMs };
  }

  function srpSummarize(summary) {
    if (!summary) return null;
    var input = Number(summary.totalInputTokens) || 0;
    var output = Number(summary.totalOutputTokens) || 0;
    return {
      requests: Number(summary.totalRequests) || 0,
      input: input,
      output: output,
      total: input + output,
    };
  }

  function srpFmtInt(value) {
    if (value === null || value === undefined || !isFinite(value)) return "—";
    return String(Math.round(value)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  }

  function srpFmtCompact(value) {
    if (value === null || value === undefined || !isFinite(value)) return "—";
    var abs = Math.abs(value);
    var trim = function (text) {
      return text.replace(/\.0+$/, "").replace(/(\.\d)0$/, "$1");
    };
    if (abs >= 1e9) return trim((value / 1e9).toFixed(2)) + "B";
    if (abs >= 1e6) return trim((value / 1e6).toFixed(2)) + "M";
    if (abs >= 1e4) return trim((value / 1e3).toFixed(1)) + "k";
    return srpFmtInt(value);
  }

  function srpClamp(value, min, max) {
    if (max < min) return min;
    return Math.min(Math.max(value, min), max);
  }

  /** 把胶囊坐标夹到视口内，留 8px 边距 */
  function srpClampPosition(x, y, width, height, viewportW, viewportH) {
    return {
      x: Math.round(srpClamp(x, 8, viewportW - width - 8)),
      y: Math.round(srpClamp(y, 8, viewportH - height - 8)),
    };
  }

  /**
   * 顶部居中排布：一行放不下自动换行，每行水平居中。
   * widths 为参与排布的胶囊宽度，返回 { 索引: { x, y } }。
   */
  function srpLayoutPills(widths, options) {
    var gap = options.gap;
    var top = options.top;
    var lineHeight = options.lineHeight;
    var pad = options.sidePadding;
    var viewportW = options.viewportWidth;
    var usable = Math.max(40, viewportW - pad * 2);
    var lines = [];
    var current = [];
    var currentWidth = 0;

    widths.forEach(function (width, index) {
      var extra = current.length ? gap + width : width;
      if (current.length && currentWidth + extra > usable) {
        lines.push({ items: current, width: currentWidth });
        current = [];
        currentWidth = 0;
        extra = width;
      }
      current.push(index);
      currentWidth += extra;
    });
    if (current.length) lines.push({ items: current, width: currentWidth });

    var spots = {};
    lines.forEach(function (line, lineIndex) {
      var x = Math.max(pad, Math.round((viewportW - line.width) / 2));
      var y = top + lineIndex * lineHeight;
      line.items.forEach(function (index, positionInLine) {
        if (positionInLine > 0) x += gap;
        spots[index] = { x: Math.round(x), y: y };
        x += widths[index];
      });
    });
    return spots;
  }

  /** 刷新速度选项（毫秒）；1000 = 实时档，宿主元数据轮询下限也是 1 秒 */
  var SRP_INTERVALS = [1000, 2000, 5000, 10000, 30000, 60000];
  var SRP_DEFAULT_INTERVAL = 10000;

  function srpNormalizeInterval(value) {
    var n = Number(value);
    for (var i = 0; i < SRP_INTERVALS.length; i++) {
      if (SRP_INTERVALS[i] === n) return n;
    }
    return SRP_DEFAULT_INTERVAL;
  }

  /** 刷新速度档位的显示写法：1000 → "实时 · 1 秒"，10000 → "10 秒" */
  function srpIntervalLabel(ms) {
    var value = srpNormalizeInterval(ms);
    return value === 1000 ? "实时 · 1 秒" : value / 1000 + " 秒";
  }

  /**
   * 状态归一：off 为逐颗隐藏集合（key → true）；intervalMs 为刷新速度。
   * 兼容旧版整体隐藏（布尔 hidden）：传入 allKeys 时把旧状态展开成「全部隐藏」。
   */
  /* 光效档位（毫秒）：0 表示持续不停，其余为一次播放的时长 */
  var SRP_TICK_LEVELS = [3000, 5000, 8000, 12000, 0];
  var SRP_DEFAULT_TICK_MS = 3000;
  var SRP_PERSIST_TICK_MS = 0;

  /** 光效档位校验：非数字回退默认档；其它值吸附到最近的档位，0 与负数都算持续不停 */
  function srpNormalizeTickMs(raw) {
    var value = Number(raw);
    if (!isFinite(value)) return SRP_DEFAULT_TICK_MS;
    if (value <= 0) return SRP_PERSIST_TICK_MS;
    var best = SRP_DEFAULT_TICK_MS;
    var bestGap = Infinity;
    for (var i = 0; i < SRP_TICK_LEVELS.length; i++) {
      var level = SRP_TICK_LEVELS[i];
      if (level <= 0) continue;
      var gap = Math.abs(level - value);
      if (gap < bestGap) {
        best = level;
        bestGap = gap;
      }
    }
    return best;
  }

  /** 数字滚动取光效时长的 35%；持续档按最短档 3 秒算，避免滚动时长变成 0 */
  function srpTweenMs(tickMs) {
    var ms = srpNormalizeTickMs(tickMs);
    return Math.round((ms || SRP_DEFAULT_TICK_MS) * 0.35);
  }

  /** 光效档位的显示写法：3000 → "3 秒"，0 → "持续不停" */
  function srpTickLabel(tickMs) {
    var ms = srpNormalizeTickMs(tickMs);
    return ms === 0 ? "持续不停" : ms / 1000 + " 秒";
  }

  function srpNormalizeState(raw, allKeys) {
    var src = raw && typeof raw === "object" ? raw : {};
    var preset = "today";
    for (var i = 0; i < SRP_PRESETS.length; i++) {
      if (SRP_PRESETS[i].key === src.range) preset = src.range;
    }
    var pos = {};
    if (src.pos && typeof src.pos === "object") {
      Object.keys(src.pos).forEach(function (key) {
        var entry = src.pos[key];
        if (!entry || typeof entry !== "object") return;
        var x = Number(entry.x);
        var y = Number(entry.y);
        if (!isFinite(x) || !isFinite(y)) return;
        pos[key] = { x: x, y: y, auto: entry.auto === true };
      });
    }
    var off = {};
    if (src.off && typeof src.off === "object") {
      Object.keys(src.off).forEach(function (key) {
        if (src.off[key] === true) off[key] = true;
      });
    } else if (src.hidden === true && allKeys && allKeys.length) {
      allKeys.forEach(function (key) {
        off[key] = true;
      });
    }
    return {
      range: preset,
      pos: pos,
      off: off,
      intervalMs: srpNormalizeInterval(src.intervalMs),
      tickMs: srpNormalizeTickMs(src.tickMs),
    };
  }

  /** 每颗指标胶囊的数值格式化：滚动动画每帧都用它重新渲染 */
  var METRIC_FORMAT = {
    rpd: srpFmtInt,
    tpd: srpFmtCompact,
    rpm: srpFmtInt,
    itpm: srpFmtCompact,
    otpm: srpFmtCompact,
  };

  /** 顶栏按钮是否需要重新落位：位置已经正确就不动 DOM——无谓的搬家会让按钮闪一下 */
  function srpNeedsTopBarMove(mode, currentParent, currentPrev, currentNext, host, hostParent) {
    if (mode === "before") return !(currentParent === hostParent && currentNext === host);
    if (mode === "after") return !(currentParent === hostParent && currentPrev === host);
    return currentParent !== host;
  }

  /* #endregion pure */

  var state = srpNormalizeState(safeGetJson(STORAGE_KEY), KEYS);
  var els = {};
  var widths = {};
  var layer = null;
  var topButton = null;
  var menuNode = null;
  var lastToggleAt = 0;
  var timer = 0;
  var refreshing = false;
  var disposed = false;
  var lastRaw = {};
  var tweens = {};
  var tickTimers = {};
  var tickUntil = {};
  var resizeTimer = 0;
  var observer = null;
  var attachQueued = false;

  function safeGetJson(key) {
    try {
      var raw = GM_getValue(key, "");
      if (!raw) return null;
      return typeof raw === "string" ? JSON.parse(raw) : raw;
    } catch (error) {
      return null;
    }
  }

  function persist() {
    try {
      GM_setValue(STORAGE_KEY, JSON.stringify(state));
    } catch (error) {
      /* 存储失败只影响下次位置与可见性恢复 */
    }
  }

  function isOff(key) {
    return state.off[key] === true;
  }

  /** 文本更新走 textNode.nodeValue 并去重：不产生 childList 变动，避免触发其它脚本的 MutationObserver */
  function setCellText(cell, text) {
    if (!cell || cell.value === text) return;
    cell.value = text;
    cell.node.nodeValue = text;
  }

  /** 属性写入去重：避免同一标题每秒重写一次造成 attributes 变动 */
  function setNodeTitle(node, text) {
    if (!node || node.title === text) return;
    node.title = text;
  }

  function rangeLabel() {
    for (var i = 0; i < SRP_PRESETS.length; i++) {
      if (SRP_PRESETS[i].key === state.range) return SRP_PRESETS[i].label;
    }
    return "今天";
  }

  function startTimer() {
    clearInterval(timer);
    timer = setInterval(refresh, state.intervalMs);
  }

  /** 拖动中：只切档位，不重启定时器（松手才真正生效，免得拖一次打爆元数据查询） */
  function previewInterval(value) {
    state.intervalMs = srpNormalizeInterval(value);
  }

  /** 真正应用刷新速度：重启定时器、立刻刷一次、落盘 */
  function applyInterval(value, persistNow) {
    state.intervalMs = srpNormalizeInterval(value);
    startTimer();
    refresh();
    if (persistNow !== false) persist();
  }

  function cycleInterval() {
    var index = 0;
    for (var i = 0; i < SRP_INTERVALS.length; i++) {
      if (SRP_INTERVALS[i] === state.intervalMs) index = i;
    }
    closeMenu();
    applyInterval(SRP_INTERVALS[(index + 1) % SRP_INTERVALS.length]);
  }

  function cycleRange() {
    var index = 0;
    for (var i = 0; i < SRP_PRESETS.length; i++) {
      if (SRP_PRESETS[i].key === state.range) index = i;
    }
    state.range = SRP_PRESETS[(index + 1) % SRP_PRESETS.length].key;
    persist();
    paintRange();
    refresh();
  }

  function paintRange() {
    if (!els.range) return;
    setCellText(els.range.text, rangeLabel());
    setNodeTitle(els.range.node, "统计范围：" + rangeLabel() + "，点击切换");
  }

  function styleOnce() {
    snow.style(
      [
        "." + PREFIX + "-pill{position:fixed;z-index:4300;display:inline-flex;align-items:center;",
        "border-radius:999px;box-sizing:border-box;",
        "font:600 11px/1 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;",
        "color:var(--text-primary,#e5e7eb);background:var(--bg-secondary,rgba(31,41,55,.92));",
        "border:1px solid var(--border-color,rgba(127,127,127,.35));box-shadow:0 2px 10px rgba(0,0,0,.22);",
        "backdrop-filter:blur(6px);cursor:grab;user-select:none;touch-action:none;",
        "font-variant-numeric:tabular-nums;",
        "transition:left .18s ease,top .18s ease,border-color .2s ease,background .2s ease,box-shadow .5s ease,",
        "transform .5s ease;}",
        "." + PREFIX + "-face{position:relative;display:inline-flex;align-items:center;gap:2px;height:22px;",
        "padding:0 9px;border-radius:999px;}",
        "." + PREFIX + "-pill:hover{border-color:var(--accent-color,#3b82f6);}",
        "." + PREFIX + "-pill:focus-visible{outline:1px solid var(--accent-color,#3b82f6);outline-offset:2px;}",
        "." + PREFIX + "-pill.is-dragging{cursor:grabbing;z-index:4400;background:var(--bg-primary,rgba(17,24,39,.96));",
        "transition:none;}",
        /* 刷新动效（Reactbits 风格）：边框光束绕行 + 文字高光扫过 + 数字滚动
           光束不使用 @property：旋转的锥形渐变大方块 + 内部遮盖，只留 2px 描边 */
        "." + PREFIX + "-beam{position:absolute;inset:-2px;border-radius:999px;overflow:hidden;",
        /* opacity 走过渡：动画被摘掉（换档、持续档结束）时也淡出，不会硬切 */
        "pointer-events:none;opacity:0;transition:opacity .55s ease;}",
        "." + PREFIX + "-pill.is-tick ." + PREFIX + "-beam{opacity:1;animation:" + PREFIX + "-beam-fade var(--" + PREFIX + "-tick-ms," + SRP_DEFAULT_TICK_MS + "ms) ease-out var(--" + PREFIX + "-tick-repeat,1);}",
        "." + PREFIX + "-beam-rotor{position:absolute;left:50%;top:50%;width:320%;aspect-ratio:1/1;",
        "background:conic-gradient(from 0deg,rgba(255,255,255,0) 0deg,rgba(255,255,255,.95) 26deg,",
        "var(--accent-color,#3b82f6) 50deg,#22d3ee 74deg,rgba(255,255,255,0) 112deg,rgba(255,255,255,0) 360deg);",
        "transform:translate(-50%,-50%) rotate(0deg);}",
        "." + PREFIX + "-pill.is-tick ." + PREFIX + "-beam-rotor{animation:" + PREFIX + "-spin var(--" + PREFIX + "-tick-ms," + SRP_DEFAULT_TICK_MS + "ms) linear var(--" + PREFIX + "-tick-repeat,1);}",
        "." + PREFIX + "-beam-cover{position:absolute;inset:2px;border-radius:999px;",
        "background:var(--bg-secondary,rgba(31,41,55,.92));}",
        "." + PREFIX + "-pill.is-tick{animation:" + PREFIX + "-lift var(--" + PREFIX + "-tick-ms," + SRP_DEFAULT_TICK_MS + "ms) cubic-bezier(.22,1,.36,1);}",
        "." + PREFIX + "-pill.is-tick ." + PREFIX + "-value{",
        "background:linear-gradient(100deg,currentColor 0%,currentColor 30%,#ffffff 48%,currentColor 66%,currentColor 100%);",
        /* 背景比元素宽 2.5 倍，位移只能落在 0%–100%：超出这个区间背景会整块滑出元素，
           文字用的是 background-clip:text + 透明字色，背景不在元素上就等于字看不见 */
        "background-size:250% 100%;background-position:0% 0;",
        "-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent;",
        "animation:" + PREFIX + "-shine calc(var(--" + PREFIX + "-tick-ms," + SRP_DEFAULT_TICK_MS + "ms) * 0.48) ease-in-out var(--" + PREFIX + "-tick-shine-repeat,2);}",
        "." + PREFIX + "-pill.is-tick ." + PREFIX + "-unit{opacity:1;}",
        "@keyframes " + PREFIX + "-spin{from{transform:translate(-50%,-50%) rotate(0deg);}",
        "to{transform:translate(-50%,-50%) rotate(360deg);}}",
        "@keyframes " + PREFIX + "-beam-fade{0%{opacity:0;}10%{opacity:1;}42%{opacity:1;}100%{opacity:0;}}",
        "@keyframes " + PREFIX + "-shine{from{background-position:0% 0;}to{background-position:100% 0;}}",
        "@keyframes " + PREFIX + "-lift{",
        "0%{transform:translateY(0) scale(1);box-shadow:0 2px 10px rgba(0,0,0,.22);}",
        "18%{transform:translateY(-3px) scale(1.045);box-shadow:0 8px 20px rgba(0,0,0,.3);}",
        "60%{transform:translateY(-1px) scale(1.012);}",
        "100%{transform:translateY(0) scale(1);box-shadow:0 2px 10px rgba(0,0,0,.22);}}",
        "." + PREFIX + "-abbr{opacity:.6;font-size:10px;letter-spacing:.06em;}",
        "." + PREFIX + "-value{font-weight:700;",
        "transition:-webkit-text-fill-color .4s ease,background-position .4s ease;}",
        "." + PREFIX + "-unit{opacity:.6;font-size:10px;}",
        "." + PREFIX + "-range{border-color:color-mix(in srgb,var(--accent-color,#3b82f6) 45%,transparent);}",
        "." + PREFIX + "-range ." + PREFIX + "-abbr{opacity:.75;}",
        /* 悬停 X：点一下只隐藏这一颗 */
        "." + PREFIX + "-close{position:absolute;left:calc(100% + 3px);top:50%;",
        "transform:translateY(-50%) scale(.7);display:inline-flex;align-items:center;justify-content:center;",
        "width:16px;height:16px;border-radius:50%;border:1px solid var(--border-color,rgba(127,127,127,.45));",
        "background:var(--bg-primary,rgba(17,24,39,.96));color:var(--text-secondary,inherit);cursor:pointer;",
        "opacity:0;transition:opacity .15s ease,transform .15s ease,color .15s ease,border-color .15s ease;}",
        "." + PREFIX + "-pill:hover ." + PREFIX + "-close,." + PREFIX + "-pill:focus-within ." + PREFIX + "-close{",
        "opacity:1;transform:translateY(-50%) scale(1);}",
        "." + PREFIX + "-close:hover{border-color:#ef4444;color:#ef4444;}",
        "." + PREFIX + "-top{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;",
        "padding:0;border:0;border-radius:6px;background:transparent;color:inherit;cursor:pointer;opacity:.72;",
        /* 顶栏是窗口拖拽区（宿主 .top-bar 上是 app-region:drag），不显式豁免时点击会被当成拖窗口吞掉 */
        "-webkit-app-region:no-drag;",
        "transition:background .15s ease,opacity .15s ease,color .45s ease;}",
        "." + PREFIX + "-top:hover{background:rgba(127,127,127,.16);opacity:1;}",
        "." + PREFIX + "-top:focus-visible{outline:1px solid var(--accent-color,#3b82f6);outline-offset:2px;}",
        "." + PREFIX + "-top.is-off{opacity:.4;}",
        "." + PREFIX + "-top.is-tick{color:var(--accent-color,#3b82f6);}",
        "." + PREFIX + "-menu{position:fixed;z-index:4450;min-width:210px;padding:4px;border-radius:8px;",
        "max-height:min(70vh,440px);overflow-y:auto;box-sizing:border-box;",
        "background:var(--bg-primary,#111827);border:1px solid var(--border-color,rgba(127,127,127,.35));",
        "box-shadow:0 10px 28px rgba(0,0,0,.3);}",
        "." + PREFIX + "-item{display:flex;width:100%;align-items:center;gap:8px;padding:6px 8px;border:0;",
        "border-radius:6px;background:transparent;color:inherit;font:500 12px/1.3 system-ui,-apple-system,sans-serif;",
        "text-align:left;cursor:pointer;}",
        "." + PREFIX + "-item:hover{background:rgba(127,127,127,.16);}",
        "." + PREFIX + "-item.is-on ." + PREFIX + "-item-state{color:var(--accent-color,#3b82f6);}",
        "." + PREFIX + "-item.is-off ." + PREFIX + "-item-label{opacity:.5;}",
        "." + PREFIX + "-item-hint{margin-left:auto;opacity:.55;font-size:11px;}",
        "." + PREFIX + "-item-state{margin-left:auto;font-size:11px;opacity:.75;}",
        /* 档位滑块行：标签与读数在上，滑块占满下一行 */
        "." + PREFIX + "-slider-row{display:grid;grid-template-columns:1fr auto;align-items:center;gap:4px 8px;",
        "padding:6px 8px;border-radius:6px;}",
        "." + PREFIX + "-slider-row:hover{background:rgba(127,127,127,.16);}",
        "." + PREFIX + "-slider-row ." + PREFIX + "-item-label{font:500 12px/1.3 system-ui,-apple-system,sans-serif;}",
        "." + PREFIX + "-slider{grid-column:1 / -1;width:100%;height:14px;margin:0;appearance:none;background:transparent;",
        "cursor:pointer;-webkit-app-region:no-drag;}",
        "." + PREFIX + "-slider::-webkit-slider-runnable-track{height:3px;border-radius:2px;",
        "background:color-mix(in srgb,currentColor 25%,transparent);}",
        "." + PREFIX + "-slider::-webkit-slider-thumb{appearance:none;width:12px;height:12px;margin-top:-4.5px;",
        "border-radius:50%;background:var(--accent-color,#3b82f6);border:0;}",
        "." + PREFIX + "-slider:focus-visible{outline:1px solid var(--accent-color,#3b82f6);outline-offset:2px;}",
        "." + PREFIX + "-sep{height:1px;margin:4px 2px;background:color-mix(in srgb,currentColor 14%,transparent);}",
        "@media (prefers-reduced-motion: reduce){." + PREFIX + "-pill.is-tick,." + PREFIX + "-top.is-tick,",
        "." + PREFIX + "-beam-rotor,." + PREFIX + "-pill.is-tick ." + PREFIX + "-value{animation:none;}",
        /* 动画被禁用时背景不会移动，透明字色会让整颗数值看不见，这里退回实色 */
        "." + PREFIX + "-pill.is-tick ." + PREFIX + "-value{background:none;-webkit-text-fill-color:currentColor;}}",
      ].join(""),
    );
  }

  function makePill(key, abbr, name) {
    var node = document.createElement("div");
    node.className = PREFIX + "-pill" + (key === "range" ? " " + PREFIX + "-range" : "");
    node.setAttribute("role", "group");
    node.setAttribute("aria-label", name);
    node.tabIndex = 0;
    node.style.visibility = "hidden";

    var beam = document.createElement("span");
    beam.className = PREFIX + "-beam";
    var rotor = document.createElement("span");
    rotor.className = PREFIX + "-beam-rotor";
    var cover = document.createElement("span");
    cover.className = PREFIX + "-beam-cover";
    beam.append(rotor, cover);

    var face = document.createElement("span");
    face.className = PREFIX + "-face";
    var abbrNode = document.createElement("span");
    abbrNode.className = PREFIX + "-abbr";
    abbrNode.textContent = abbr;
    var valueNode = document.createElement("span");
    valueNode.className = PREFIX + "-value";
    var valueText = document.createTextNode("—");
    valueNode.append(valueText);
    var unitNode = document.createElement("span");
    unitNode.className = PREFIX + "-unit";
    var unitText = document.createTextNode("");
    unitNode.append(unitText);
    face.append(abbrNode, valueNode, unitNode);

    var closeNode = document.createElement("span");
    closeNode.className = PREFIX + "-close";
    closeNode.setAttribute("role", "button");
    closeNode.setAttribute("aria-label", "隐藏这颗胶囊");
    closeNode.title = "隐藏这颗胶囊";
    closeNode.innerHTML = ICON_CLOSE;
    closeNode.addEventListener("pointerdown", function (event) {
      event.stopPropagation();
    });
    closeNode.addEventListener("click", function (event) {
      event.preventDefault();
      event.stopPropagation();
      setPillOff(key, true);
    });

    node.append(beam, face, closeNode);
    layer.append(node);
    els[key] = {
      node: node,
      value: valueNode,
      text: { node: valueText, value: "—" },
      unit: { node: unitText, value: "" },
      abbr: abbr,
      name: name,
    };
    return node;
  }

  /** 把胶囊需要的宽度记成只增不减的预留值（写成 min-width，避免滚动途中忽宽忽窄）；
      返回 true 表示这次比预留值更宽了，调用方要重排一次，否则会压到右边那颗。
      字体是等宽的，宽度基本只随字符数变化，所以先用字符数挡一道，避免每帧都强制同步布局 */
  function reserveWidth(key) {
    var entry = els[key];
    if (!entry) return false;
    var text = entry.text.value || "";
    if (text.length <= (entry.measuredLen || 0)) return false;
    entry.measuredLen = text.length;
    var width = Math.ceil(entry.node.getBoundingClientRect().width);
    if (width <= (widths[key] || 0)) return false;
    widths[key] = width;
    entry.node.style.minWidth = width + "px";
    return true;
  }

  function place(key, x, y) {
    var entry = els[key];
    if (!entry) return null;
    var rect = entry.node.getBoundingClientRect();
    var boxWidth = widths[key] || rect.width || 90;
    var spot = srpClampPosition(x, y, boxWidth, rect.height || 24, window.innerWidth, window.innerHeight);
    entry.node.style.left = spot.x + "px";
    entry.node.style.top = spot.y + "px";
    return spot;
  }

  function visibleKeys() {
    return KEYS.filter(function (key) {
      return els[key] && !isOff(key);
    });
  }

  /** 可见胶囊按「顶部居中」重排；手动拖过的沿用保存坐标 */
  function layoutPills() {
    var keys = visibleKeys();
    var measured = keys.map(function (key) {
      reserveWidth(key);
      return Math.max(56, widths[key] || 90);
    });
    var spots = srpLayoutPills(measured, {
      gap: PILL_GAP,
      top: TOP_OFFSET,
      lineHeight: LINE_HEIGHT,
      sidePadding: SIDE_PADDING,
      viewportWidth: window.innerWidth,
    });
    keys.forEach(function (key, index) {
      var saved = state.pos[key];
      if (saved && !saved.auto) {
        place(key, saved.x, saved.y);
        return;
      }
      var spot = spots[index];
      if (!spot) return;
      var placed = place(key, spot.x, spot.y);
      if (placed) state.pos[key] = { x: placed.x, y: placed.y, auto: true };
    });
    KEYS.forEach(function (key) {
      if (els[key]) els[key].node.style.visibility = "";
    });
    persist();
  }

  function resetLayout() {
    state.pos = {};
    KEYS.forEach(function (key) {
      var entry = els[key];
      if (!entry) return;
      entry.node.style.left = "";
      entry.node.style.top = "";
    });
    layoutPills();
  }

  function refreshTopButtonState() {
    if (!topButton) return;
    var visible = visibleKeys().length;
    topButton.classList.toggle("is-off", visible === 0);
    topButton.title = visible === 0 ? "用量胶囊已全部隐藏，点开菜单可逐颗恢复" : "用量胶囊";
  }

  function applyVisibility() {
    KEYS.forEach(function (key) {
      var entry = els[key];
      if (!entry) return;
      entry.node.style.display = isOff(key) ? "none" : "";
    });
    refreshTopButtonState();
  }

  function setPillOff(key, off) {
    if (off) state.off[key] = true;
    else delete state.off[key];
    persist();
    closeMenu();
    applyVisibility();
    layoutPills();
  }

  function togglePill(key) {
    setPillOff(key, !isOff(key));
  }

  function setAllOff(off) {
    KEYS.forEach(function (key) {
      if (off) state.off[key] = true;
      else delete state.off[key];
    });
    persist();
    closeMenu();
    applyVisibility();
    layoutPills();
  }

  function makeDraggable(key) {
    var entry = els[key];
    if (!entry) return;
    var node = entry.node;
    var dragging = false;
    var moved = false;
    var startX = 0;
    var startY = 0;
    var originX = 0;
    var originY = 0;
    var frame = 0;
    var nextX = 0;
    var nextY = 0;

    node.addEventListener("pointerdown", function (event) {
      if (event.button !== 0) return;
      var rect = node.getBoundingClientRect();
      dragging = true;
      moved = false;
      startX = event.clientX;
      startY = event.clientY;
      originX = rect.left;
      originY = rect.top;
      node.setPointerCapture(event.pointerId);
      node.classList.add("is-dragging");
      event.preventDefault();
    });

    node.addEventListener("pointermove", function (event) {
      if (!dragging) return;
      var dx = event.clientX - startX;
      var dy = event.clientY - startY;
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) moved = true;
      var rect = node.getBoundingClientRect();
      var spot = srpClampPosition(
        originX + dx,
        originY + dy,
        rect.width,
        rect.height,
        window.innerWidth,
        window.innerHeight,
      );
      nextX = spot.x;
      nextY = spot.y;
      if (!frame) {
        frame = requestAnimationFrame(function () {
          frame = 0;
          node.style.left = nextX + "px";
          node.style.top = nextY + "px";
        });
      }
    });

    function endDrag(event) {
      if (!dragging) return;
      dragging = false;
      node.classList.remove("is-dragging");
      if (node.hasPointerCapture && node.hasPointerCapture(event.pointerId)) {
        node.releasePointerCapture(event.pointerId);
      }
      if (moved) {
        var rect = node.getBoundingClientRect();
        var spot = srpClampPosition(
          rect.left,
          rect.top,
          rect.width,
          rect.height,
          window.innerWidth,
          window.innerHeight,
        );
        state.pos[key] = { x: spot.x, y: spot.y, auto: false };
        place(key, spot.x, spot.y);
        persist();
        node.dataset.skipClick = "1";
        setTimeout(function () {
          delete node.dataset.skipClick;
        }, 0);
      }
      if (frame) {
        cancelAnimationFrame(frame);
        frame = 0;
      }
    }

    node.addEventListener("pointerup", endDrag);
    node.addEventListener("pointercancel", endDrag);

    node.addEventListener("keydown", function (event) {
      if (key !== "range") return;
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      cycleRange();
    });

    node.addEventListener("click", function (event) {
      if (node.dataset.skipClick) {
        event.preventDefault();
        return;
      }
      if (key === "range") cycleRange();
    });
  }

  function menuItem(label, stateText, onClick) {
    var item = document.createElement("button");
    item.type = "button";
    item.className = PREFIX + "-item";
    var text = document.createElement("span");
    text.className = PREFIX + "-item-label";
    text.textContent = label;
    item.append(text);
    item.labelNode = text;
    if (stateText !== null && stateText !== undefined) {
      var stateNode = document.createElement("span");
      stateNode.className = PREFIX + "-item-state";
      stateNode.textContent = stateText;
      item.append(stateNode);
      item.stateNode = stateNode;
    }
    item.addEventListener("click", function () {
      onClick();
    });
    return item;
  }

  /** 档位滑块：滑块位置映射到档位数组，右侧显示当前档位；拖动即时生效，松手才落盘 */
  function menuSlider(label, levels, value, labelOf, onInput, onCommit) {
    var index = 0;
    for (var i = 0; i < levels.length; i++) {
      if (levels[i] === value) index = i;
    }
    var row = document.createElement("div");
    row.className = PREFIX + "-slider-row";
    var text = document.createElement("span");
    text.className = PREFIX + "-item-label";
    text.textContent = label;
    var readout = document.createElement("span");
    readout.className = PREFIX + "-item-state";
    readout.textContent = labelOf(levels[index]);
    var input = document.createElement("input");
    input.type = "range";
    input.className = PREFIX + "-slider";
    input.min = "0";
    input.max = String(levels.length - 1);
    input.step = "1";
    input.value = String(index);
    input.setAttribute("aria-label", label);
    input.setAttribute("aria-valuetext", labelOf(levels[index]));
    input.addEventListener("input", function () {
      var pick = levels[Number(input.value)];
      if (pick === undefined) return;
      readout.textContent = labelOf(pick);
      input.setAttribute("aria-valuetext", labelOf(pick));
      onInput(pick);
    });
    input.addEventListener("change", function () {
      var pick = levels[Number(input.value)];
      if (pick === undefined) return;
      onCommit(pick);
    });
    row.append(text, readout, input);
    return row;
  }

  function closeMenu() {
    if (menuNode && menuNode.parentNode) menuNode.remove();
    menuNode = null;
    document.removeEventListener("pointerdown", onDocumentPointerDown, true);
    document.removeEventListener("keydown", onDocumentKeyDown, true);
  }

  function pillLabel(key) {
    if (key === "range") return "范围 · " + rangeLabel();
    var entry = els[key];
    return entry ? entry.abbr + " · " + entry.name : key;
  }

  /** 顶栏菜单开合：click 与 pointerup 都会调用，300ms 内只处理一次，避免两条通道各切一次 */
  function toggleMenu(event) {
    if (event) {
      if (event.type === "pointerup" && event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
    }
    var now = Date.now();
    if (now - lastToggleAt < 300) return;
    lastToggleAt = now;
    if (menuNode) closeMenu();
    else openMenu();
  }

  function openMenu() {
    closeMenu();
    if (!topButton) return;
    var menu = document.createElement("div");
    menu.className = PREFIX + "-menu";
    menu.setAttribute("role", "menu");

    KEYS.forEach(function (key) {
      var off = isOff(key);
      var item = menuItem(pillLabel(key), off ? "已隐藏" : "显示中", function () {
        togglePill(key);
      });
      item.classList.add(off ? "is-off" : "is-on");
      item.dataset.pill = key;
      menu.append(item);
    });

    var sep = document.createElement("div");
    sep.className = PREFIX + "-sep";
    menu.append(sep);

    menu.append(menuItem("全部显示", null, function () {
      setAllOff(false);
    }));
    menu.append(menuItem("全部隐藏", null, function () {
      setAllOff(true);
    }));

    var sep2 = document.createElement("div");
    sep2.className = PREFIX + "-sep";
    menu.append(sep2);

    menu.append(menuItem("切换统计范围", rangeLabel(), cycleRange));
    menu.append(
      menuSlider("刷新速度", SRP_INTERVALS, state.intervalMs, srpIntervalLabel, previewInterval, applyInterval),
    );
    menu.append(
      menuSlider("光效时长", SRP_TICK_LEVELS, state.tickMs, srpTickLabel, previewTickMs, applyTickMs),
    );
    menu.append(menuItem("重置胶囊位置", null, resetLayout));
    menu.append(menuItem("立即刷新用量", null, refresh));

    document.body.append(menu);
    menuNode = menu;

    var rect = topButton.getBoundingClientRect();
    var width = menu.offsetWidth || 220;
    var left = Math.round(srpClamp(rect.right - width, 8, window.innerWidth - width - 8));
    var top = Math.round(rect.bottom + 6);
    if (top + menu.offsetHeight > window.innerHeight - 8) {
      top = Math.max(8, Math.round(rect.top - menu.offsetHeight - 6));
    }
    menu.style.left = left + "px";
    menu.style.top = top + "px";

    document.addEventListener("pointerdown", onDocumentPointerDown, true);
    document.addEventListener("keydown", onDocumentKeyDown, true);
  }

  function onDocumentPointerDown(event) {
    if (!menuNode) return;
    if (menuNode.contains(event.target)) return;
    if (topButton && topButton.contains(event.target)) return;
    closeMenu();
  }

  function onDocumentKeyDown(event) {
    if (event.key === "Escape") closeMenu();
  }

  function buildTopBar() {
    topButton = document.createElement("button");
    topButton.type = "button";
    topButton.className = PREFIX + "-top";
    topButton.title = "用量胶囊";
    topButton.innerHTML = ICON_GAUGE;
    /* click 与 pointerup 双通道：拖拽区里点击有时只派发 pointerup，click 被系统吞掉 */
    topButton.addEventListener("click", toggleMenu);
    topButton.addEventListener("pointerup", toggleMenu);
    attachTopBar();

    if (typeof MutationObserver !== "undefined") {
      observer = new MutationObserver(function () {
        if (attachQueued) return;
        attachQueued = true;
        requestAnimationFrame(function () {
          attachQueued = false;
          attachTopBar();
        });
      });
      observer.observe(document.body, { childList: true, subtree: true });
    }
  }

  /* 顶栏位置：宿主顶栏是 .top-bar-main > [header-title-group, top-bar-todo-menu, top-bar-main-trailing]，
     其中 top-bar-todo-menu 按会话状态动态创建与重建，节点放进去会随容器重建一起被丢掉。
     所以锚点取它的兄弟位置：待办区域左侧（通知铃铛取同一区域的右侧），容器还没出现时贴标题组右侧。 */
  function findTopBarHost() {
    var todoArea = document.querySelector(".top-bar-main .top-bar-todo-menu");
    if (todoArea && todoArea.parentNode) return { host: todoArea, mode: "before" };
    var titleGroup = document.querySelector(".top-bar-main .header-title-group");
    if (titleGroup && titleGroup.parentNode) return { host: titleGroup, mode: "after" };
    var slot = document.querySelector('[data-snow-slot="topbar.actions"]');
    if (slot) return { host: slot, mode: "append" };
    return null;
  }

  function attachTopBar() {
    if (!topButton || disposed) return;
    var target = findTopBarHost();
    /* 宿主顶栏重建的空窗期保持按钮原地：摘掉再挂回就是肉眼可见的闪，点击也会落空 */
    if (!target) return;
    var host = target.host;
    var move = srpNeedsTopBarMove(
      target.mode,
      topButton.parentNode,
      topButton.previousElementSibling,
      topButton.nextElementSibling,
      host,
      host.parentNode,
    );
    if (!move) return;
    if (target.mode === "before") host.insertAdjacentElement("beforebegin", topButton);
    else if (target.mode === "after") host.insertAdjacentElement("afterend", topButton);
    else host.append(topButton);
  }

  function prefersReducedMotion() {
    return (
      typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches
    );
  }

  function cancelTween(key) {
    if (!tweens[key]) return;
    cancelAnimationFrame(tweens[key]);
    delete tweens[key];
  }

  function cancelAllTweens() {
    Object.keys(tweens).forEach(cancelTween);
  }

  /** 数字滚动：从 from 缓动到 to，每帧按当前值重新格式化（Reactbits Count Up 的等价实现） */
  function startTween(key, from, to) {
    var format = METRIC_FORMAT[key] || srpFmtInt;
    cancelTween(key);
    if (prefersReducedMotion()) {
      if (els[key]) setCellText(els[key].text, format(to));
      return;
    }
    var duration = srpTweenMs(state.tickMs);
    var startAt = 0;
    /* 滚动途中只更新 min-width 保证不裁字；重排推迟到滚动结束，免得每帧都动位置 */
    var grew = false;
    var step = function (now) {
      var entry = els[key];
      if (disposed || !entry) return;
      if (!startAt) startAt = now;
      var progress = Math.min(1, (now - startAt) / duration);
      var eased = 1 - Math.pow(1 - progress, 3);
      setCellText(entry.text, format(from + (to - from) * eased));
      if (reserveWidth(key)) grew = true;
      if (progress < 1) {
        tweens[key] = requestAnimationFrame(step);
      } else {
        delete tweens[key];
        setCellText(entry.text, format(to));
        if (reserveWidth(key) || grew) layoutPills();
      }
    };
    tweens[key] = requestAnimationFrame(step);
  }

  /** 数值变化时播放边框光束 + 文字高光；档位为「持续不停」时常驻，不再重播：
      1 秒档下数值每秒都在变，逐帧重播会让胶囊一直抖 */
  function playTick(key) {
    var entry = els[key];
    if (!entry) return;
    var now = Date.now();
    if (tickUntil[key] && now < tickUntil[key]) return;
    var persistent = state.tickMs === SRP_PERSIST_TICK_MS;
    tickUntil[key] = persistent ? Infinity : now + state.tickMs;
    entry.node.classList.remove("is-tick");
    /* 强制重排，保证同一颗胶囊连续变化时动画能重放 */
    entry.node.getBoundingClientRect();
    entry.node.classList.add("is-tick");
    clearTimeout(tickTimers[key]);
    if (!persistent) {
      tickTimers[key] = setTimeout(function () {
        if (entry.node) entry.node.classList.remove("is-tick");
      }, state.tickMs + 100);
    }
  }

  /** 光效档位写进 CSS 变量：时长、循环次数（持续档 = infinite）、高光轮数 */
  function applyTickDuration() {
    var root = document.documentElement;
    var persistent = state.tickMs === SRP_PERSIST_TICK_MS;
    var ms = persistent ? SRP_DEFAULT_TICK_MS : state.tickMs;
    root.style.setProperty("--" + PREFIX + "-tick-ms", ms + "ms");
    root.style.setProperty("--" + PREFIX + "-tick-repeat", persistent ? "infinite" : "1");
    root.style.setProperty("--" + PREFIX + "-tick-shine-repeat", persistent ? "infinite" : "2");
  }

  /** 拖动中：只切档位与 CSS 变量，不重播也不落盘 */
  function previewTickMs(value) {
    state.tickMs = srpNormalizeTickMs(value);
    applyTickDuration();
  }

  /** 真正应用光效档位：清掉上一档留下的动画，按新档位重播一次，再落盘 */
  function applyTickMs(value, persistNow) {
    state.tickMs = srpNormalizeTickMs(value);
    applyTickDuration();
    Object.keys(tickUntil).forEach(function (key) {
      delete tickUntil[key];
    });
    KEYS.forEach(function (key) {
      var entry = els[key];
      if (!entry) return;
      clearTimeout(tickTimers[key]);
      entry.node.classList.remove("is-tick");
    });
    if (persistNow !== false) persist();
    previewTick();
  }

  function cycleTickMs() {
    var index = 0;
    for (var i = 0; i < SRP_TICK_LEVELS.length; i++) {
      if (SRP_TICK_LEVELS[i] === state.tickMs) index = i;
    }
    closeMenu();
    applyTickMs(SRP_TICK_LEVELS[(index + 1) % SRP_TICK_LEVELS.length]);
  }

  /** 换档后立即在可见的第一颗胶囊上放一次，直接看效果 */
  function previewTick() {
    var keys = visibleKeys();
    if (!keys.length) return;
    playTick(keys[0]);
  }

  function getUsage(sinceMs, untilMs) {
    return snow.metadata
      .get(["usage"], {
        params: { since: srpFormatLocal(sinceMs), until: srpFormatLocal(untilMs), limit: 1 },
      })
      .then(function (res) {
        if (res && res.denied && res.denied.usage) return { denied: true };
        var usage = (res && res.domains && res.domains.usage) || null;
        return { summary: usage ? usage.summary : null };
      })
      .catch(function () {
        return { summary: null };
      });
  }

  /** next 为原始数值（null 表示无数据）；数值变化时滚动 + 播放动效 */
  function paintMetric(key, next, unit) {
    var entry = els[key];
    if (!entry) return false;
    var previous = lastRaw[key];
    lastRaw[key] = next;
    setCellText(entry.unit, unit || "");
    if (next === null || next === undefined) {
      cancelTween(key);
      setCellText(entry.text, "—");
      return false;
    }
    var changed = previous !== undefined && previous !== null && previous !== next;
    if (!changed || isOff(key)) {
      cancelTween(key);
      setCellText(entry.text, (METRIC_FORMAT[key] || srpFmtInt)(next));
      if (reserveWidth(key)) layoutPills();
      return changed;
    }
    startTween(key, previous, next);
    playTick(key);
    return true;
  }

  function refresh() {
    if (refreshing || disposed || document.hidden) return;
    refreshing = true;
    var now = Date.now();
    var bounds = srpRangeFor(state.range, now);
    Promise.all([getUsage(bounds.sinceMs, bounds.untilMs), getUsage(now - LIVE_WINDOW_MS, now)])
      .then(function (results) {
        if (disposed) return;
        var rangeRes = results[0];
        var liveRes = results[1];
        if (rangeRes.denied || liveRes.denied) {
          PILLS.forEach(function (pill) {
            paintMetric(pill.key, null, "");
          });
          if (els.rpd) setNodeTitle(els.rpd.node, "usage 域未授权：脚本需要在 @snow-privacy 中声明 usage");
          return;
        }
        var range = srpSummarize(rangeRes.summary);
        var live = srpSummarize(liveRes.summary);
        var rangeText = srpFormatLocal(bounds.sinceMs) + " → " + srpFormatLocal(bounds.untilMs);

        var ticked = false;
        ticked = paintMetric("rpd", range ? range.requests : null, "") || ticked;
        ticked = paintMetric("tpd", range ? range.total : null, "") || ticked;
        ticked = paintMetric("rpm", live ? live.requests : null, "/分") || ticked;
        ticked = paintMetric("itpm", live ? live.input : null, "/分") || ticked;
        ticked = paintMetric("otpm", live ? live.output : null, "/分") || ticked;

        if (ticked && topButton) {
          topButton.classList.add("is-tick");
          clearTimeout(tickTimers.top);
          tickTimers.top = setTimeout(function () {
            if (topButton) topButton.classList.remove("is-tick");
          }, state.tickMs + 100);
        }

        if (els.rpd) setNodeTitle(els.rpd.node, "每日请求 · " + rangeLabel() + "：" + rangeText);
        if (els.tpd) setNodeTitle(els.tpd.node, "每日 Token · " + rangeLabel() + "：" + rangeText);
        if (els.rpm) setNodeTitle(els.rpm.node, "每分钟请求 · 最近 60 秒");
        if (els.itpm) setNodeTitle(els.itpm.node, "输入 Token/分 · 最近 60 秒");
        if (els.otpm) setNodeTitle(els.otpm.node, "输出 Token/分 · 最近 60 秒");
      })
      .finally(function () {
        refreshing = false;
      });
  }

  function mount() {
    styleOnce();
    applyTickDuration();
    layer = document.createElement("div");
    layer.className = PREFIX + "-layer";
    document.body.append(layer);

    PILLS.forEach(function (pill) {
      makePill(pill.key, pill.abbr, pill.name);
    });
    makePill("range", "范围", "统计范围");
    paintRange();

    KEYS.forEach(makeDraggable);
    applyVisibility();
    layoutPills();

    buildTopBar();

    refresh();
    startTimer();

    var onResize = function () {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(function () {
        layoutPills();
        visibleKeys().forEach(function (key) {
          var saved = state.pos[key];
          if (!saved || saved.auto) return;
          var rect = els[key].node.getBoundingClientRect();
          var spot = srpClampPosition(
            rect.left,
            rect.top,
            rect.width,
            rect.height,
            window.innerWidth,
            window.innerHeight,
          );
          els[key].node.style.left = spot.x + "px";
          els[key].node.style.top = spot.y + "px";
          state.pos[key] = { x: spot.x, y: spot.y, auto: false };
        });
        persist();
        if (menuNode) closeMenu();
      }, 200);
    };
    window.addEventListener("resize", onResize);

    var onVisible = function () {
      if (!document.hidden) refresh();
    };
    document.addEventListener("visibilitychange", onVisible);

    try {
      GM_registerMenuCommand("全部显示胶囊", function () {
        setAllOff(false);
      });
      GM_registerMenuCommand("全部隐藏胶囊", function () {
        setAllOff(true);
      });
      GM_registerMenuCommand("切换用量统计范围", cycleRange);
      GM_registerMenuCommand("切换刷新速度", cycleInterval);
      GM_registerMenuCommand("切换光效时长", cycleTickMs);
      GM_registerMenuCommand("重置胶囊位置", resetLayout);
      GM_registerMenuCommand("立即刷新用量", refresh);
    } catch (error) {
      /* 某些宿主不提供菜单命令，顶栏入口仍然可用 */
    }

    snow.onCleanup(function () {
      disposed = true;
      clearInterval(timer);
      clearTimeout(resizeTimer);
      Object.keys(tickTimers).forEach(function (key) {
        clearTimeout(tickTimers[key]);
      });
      tickUntil = {};
      window.removeEventListener("resize", onResize);
      document.removeEventListener("visibilitychange", onVisible);
      document.removeEventListener("pointerdown", onDocumentPointerDown, true);
      document.removeEventListener("keydown", onDocumentKeyDown, true);
      if (observer) observer.disconnect();
      closeMenu();
      if (topButton && topButton.parentNode) topButton.remove();
      if (layer && layer.parentNode) layer.remove();
      els = {};
      lastRaw = {};
      cancelAllTweens();
    });
  }

  if (document.body) mount();
  else window.addEventListener("DOMContentLoaded", mount, { once: true });
})();
