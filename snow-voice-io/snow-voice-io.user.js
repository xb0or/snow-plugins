// ==UserScript==
// @name         语音输入与朗读
// @name:en      Voice Input & Read Aloud
// @namespace    kedou
// @version      1.5.3
// @description  语音输入（本地 Whisper 服务）+ AI 回复朗读（系统 TTS）
// @author       kedou
// @license      MIT
// @icon         lucide:Mic
// @snow-target  client
// @snow-scope   global
// @snow-privacy network
// @run-at       document-idle
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// ==/UserScript==

/*
 * snow-voice-io —— Snow App 客户端脚本
 *
 * 输入半身：点击输入栏麦克风按钮录音，PCM 降采样 16kHz 编码 WAV，
 *           base64 经 snow.fetch 发往本机 STT 服务（whisper.cpp），转写文本回填输入框。
 * 输出半身：snow.on('stream-end') 触发，读取最后一条 assistant 消息，系统 TTS 朗读。
 *
 * 说明：
 *  - 转写走本机回环 HTTP（snow.fetch 允许 loopback，实测确认），不依赖任何外部 API。
 *  - UI 配色全部走宿主主题 CSS 变量，自动跟随明暗主题；图标内嵌官方 Lucide SVG 路径。
 *  - 不读取应用元数据；snow.fetch 外发请求需声明 network 网络隐私域（@snow-privacy）。
 */

(function () {
  "use strict";

  var TAG = "[snow-voice-io]";
  var CFG_KEY = "svo.config";
  var PREFIX = "svo";

  /* ============================ 配置 ============================ */

  var DEFAULT_CFG = {
    // 语音输入
    inputEnabled: true,
    sttEndpoint: "http://127.0.0.1:8791/transcribe",
    sttLang: "zh",
    maxRecordSeconds: 60,
    autoInsertSpace: false,
    // 静音自动停止（能量式 VAD，无需服务端配合）
    vadAutoStop: true,
    silenceMs: 1500,
    vadThreshold: 0.012,
    // 分段实时出字：在静音边界把已录语音切段送识别，边录边插入
    streamMode: false,
    streamMaxSegmentMs: 15000,
    // 快捷键：默认留空，避免与宿主自带快捷键冲突；可设组合键，也可设单键。
    // 组合键用 event.code 记录（与键盘布局无关）。
    hotkeyEnabled: true,
    hotkeyRecord: "",
    hotkeyStopSpeak: "",
    // 语音朗读
    ttsEnabled: true,
    autoSpeak: true,
    voiceName: "",
    rate: 1.0,
    volume: 1.0,
    ttsLang: "zh-CN",
    skipCodeBlocks: true,
    maxSpeakChars: 3000
  };

  var cfg = loadCfg();

  function loadCfg() {
    var out = {};
    for (var k in DEFAULT_CFG) if (Object.prototype.hasOwnProperty.call(DEFAULT_CFG, k)) out[k] = DEFAULT_CFG[k];
    try {
      var raw = GM_getValue(CFG_KEY, "");
      if (raw) {
        var parsed = JSON.parse(raw);
        for (var j in parsed) if (Object.prototype.hasOwnProperty.call(parsed, j)) out[j] = parsed[j];
      }
    } catch (e) { log("读取配置失败，使用默认值", e); }
    return out;
  }

  function saveCfg() {
    try { GM_setValue(CFG_KEY, JSON.stringify(cfg)); }
    catch (e) { log("保存配置失败", e); }
  }

  function log() {
    var args = Array.prototype.slice.call(arguments);
    args.unshift(TAG);
    try { console.log.apply(console, args); } catch (e) { /* ignore */ }
  }

  /* ============================ Lucide 图标 ============================ */
  /* 官方 Lucide SVG 路径（viewBox 0 0 24 24，stroke=currentColor，fill=none）。
     内嵌而非依赖运行时 API —— 客户端脚本环境无全局 lucide 对象（实测确认）。 */

  var ICONS = {
    mic: '<path d="M12 19v3"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><rect x="9" y="2" width="6" height="13" rx="3"/>',
    "mic-off": '<line x1="2" x2="22" y1="2" y2="22"/><path d="M18.89 13.23A7.12 7.12 0 0 0 19 12v-2"/><path d="M5 10v2a7 7 0 0 0 12 5"/><path d="M15 9.34V5a3 3 0 0 0-5.68-1.33"/><path d="M9 9v3a3 3 0 0 0 5.12 2.12"/><line x1="12" x2="12" y1="19" y2="22"/>',
    square: '<rect width="18" height="18" x="3" y="3" rx="2"/>',
    settings: '<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>',
    x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
    "volume-2": '<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/>',
    "volume-x": '<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><line x1="22" x2="16" y1="9" y2="15"/><line x1="16" x2="22" y1="9" y2="15"/>',
    play: '<polygon points="6 3 20 12 6 21 6 3"/>',
    check: '<path d="M20 6 9 17l-5-5"/>',
    "circle-alert": '<circle cx="12" cy="12" r="10"/><line x1="12" x2="12" y1="8" y2="12"/><line x1="12" x2="12.01" y1="16" y2="16"/>',
    "refresh-cw": '<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/>',
    info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>',
    "loader-circle": '<path d="M21 12a9 9 0 1 1-6.219-8.56"/>',
    activity: '<path d="M22 12h-2.48a2 2 0 0 0-1.93 1.46l-2.35 8.36a.25.25 0 0 1-.48 0L9.24 2.18a.25.25 0 0 0-.48 0l-2.35 8.36A2 2 0 0 1 4.49 12H2"/>',
    "circle-stop": '<circle cx="12" cy="12" r="10"/><rect x="9" y="9" width="6" height="6" rx="1"/>',
    eraser: '<path d="m7 21-4.3-4.3c-1-1-1-2.5 0-3.4l9.6-9.6c1-1 2.5-1 3.4 0l5.6 5.6c1 1 1 2.5 0 3.4L13 21"/><path d="M22 21H7"/><path d="m5 11 9 9"/>'
  };

  function svgIcon(name, size) {
    var s = size || 16;
    var inner = ICONS[name] || ICONS["circle-alert"];
    var el = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    el.setAttribute("xmlns", "http://www.w3.org/2000/svg");
    el.setAttribute("width", String(s));
    el.setAttribute("height", String(s));
    el.setAttribute("viewBox", "0 0 24 24");
    el.setAttribute("fill", "none");
    el.setAttribute("stroke", "currentColor");
    el.setAttribute("stroke-width", "2");
    el.setAttribute("stroke-linecap", "round");
    el.setAttribute("stroke-linejoin", "round");
    el.setAttribute("class", "lucide lucide-" + name);
    el.setAttribute("aria-hidden", "true");
    // 固定常量字符串，无外部输入，无注入面
    el.innerHTML = inner;
    return el;
  }

  /* ============================ 快捷键 ============================ */

  /* 组合键统一用 event.code（物理键位）记录，因此换键盘布局也不会错位。
     录制中的回调：字符串 = 已录到组合键；"" = 用户按 Esc 取消；null = 用户要清除。 */
  var hotkeyCapture = null;

  var MODIFIER_CODES = {
    ControlLeft: 1, ControlRight: 1, ShiftLeft: 1, ShiftRight: 1,
    AltLeft: 1, AltRight: 1, MetaLeft: 1, MetaRight: 1
  };

  /* 由键盘事件生成规范组合键串；按下的是纯修饰键时返回 ""（继续等待真实按键） */
  function comboFromEvent(e) {
    var base = e.code || e.key || "";
    if (!base || MODIFIER_CODES[base]) return "";
    var parts = [];
    if (e.ctrlKey) parts.push("ctrl");
    if (e.altKey) parts.push("alt");
    if (e.shiftKey) parts.push("shift");
    if (e.metaKey) parts.push("meta");
    parts.push(base);
    return parts.join("+");
  }

  /* 单键（不含修饰键）快捷键在输入框里会被当成打字，因此仅在非编辑状态下触发 */
  function isSingleKey(combo) {
    return combo.split("+").length === 1;
  }

  function inEditableContext() {
    var el = document.activeElement;
    if (!el) return false;
    var tag = el.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
    return !!el.isContentEditable;
  }

  function comboLabel(combo) {
    if (!combo) return "";
    var named = {
      Space: "空格", Enter: "回车", Escape: "Esc", Tab: "Tab", Backspace: "退格",
      Delete: "Del", Insert: "Ins", Home: "Home", End: "End", PageUp: "PgUp", PageDown: "PgDn",
      ArrowUp: "↑", ArrowDown: "↓", ArrowLeft: "←", ArrowRight: "→",
      Backquote: "`", Minus: "-", Equal: "=", BracketLeft: "[", BracketRight: "]",
      Backslash: "\\", Semicolon: ";", Quote: "'", Comma: ",", Period: ".", Slash: "/"
    };
    return combo.split("+").map(function (p) {
      if (p === "ctrl") return "Ctrl";
      if (p === "alt") return "Alt";
      if (p === "shift") return "Shift";
      if (p === "meta") return "Win";
      if (p.indexOf("Key") === 0) return p.slice(3);
      if (p.indexOf("Digit") === 0) return p.slice(5);
      if (p.indexOf("Numpad") === 0) return "小键盘" + p.slice(6);
      if (named[p]) return named[p];
      return p;
    }).join(" + ");
  }

  /* 全局按键处理。录制模式下拦截一切按键；否则匹配已设置的快捷键并阻止事件继续传递 */
  function onHotkeyDown(e) {
    if (hotkeyCapture) {
      e.preventDefault();
      e.stopPropagation();
      if (e.code === "Escape") { var c1 = hotkeyCapture; hotkeyCapture = null; c1(""); return; }
      if (e.code === "Backspace" || e.code === "Delete") { var c2 = hotkeyCapture; hotkeyCapture = null; c2(null); return; }
      var captured = comboFromEvent(e);
      if (!captured) return;   /* 只按下了修饰键，继续等 */
      var cb = hotkeyCapture;
      hotkeyCapture = null;
      cb(captured);
      return;
    }
    if (!cfg.hotkeyEnabled) return;
    if (e.isComposing || e.repeat) return;   /* 中文输入法组字中 / 长按重复都不触发 */
    var combo = comboFromEvent(e);
    if (!combo) return;
    /* 单键：正在输入框打字、或设置弹层开着时放行，避免吃掉正常输入 */
    var blocked = isSingleKey(combo) && (inEditableContext() || !!modalEl);
    if (cfg.hotkeyRecord && combo === cfg.hotkeyRecord) {
      if (blocked) return;
      e.preventDefault();
      e.stopPropagation();
      if (!cfg.inputEnabled) { toast("语音输入已关闭", true); return; }
      if (rec.active) { stopRecording(); } else { startRecording(); }
      return;
    }
    if (cfg.hotkeyStopSpeak && combo === cfg.hotkeyStopSpeak) {
      if (blocked) return;
      e.preventDefault();
      e.stopPropagation();
      stopSpeaking();
    }
  }

  /* ============================ 样式（跟随宿主主题变量） ============================ */

  var CSS = [
    "." + PREFIX + "-btn{display:inline-flex;align-items:center;justify-content:center;gap:5px;",
    "height:28px;min-width:28px;padding:0 7px;border:1px solid var(--border-color,rgba(127,127,127,.35));",
    "border-radius:var(--radius-sm,6px);background:transparent;color:var(--text-secondary,inherit);",
    "cursor:pointer;font-size:12px;line-height:1;transition:background .15s,border-color .15s,color .15s;}",
    "." + PREFIX + "-btn:hover{background:var(--bg-hover,rgba(127,127,127,.12));color:var(--text-primary,inherit);}",
    "." + PREFIX + "-btn:focus-visible{outline:2px solid var(--accent-blue,#3b82f6);outline-offset:1px;}",
    "." + PREFIX + "-btn[disabled]{opacity:.45;cursor:not-allowed;}",
    "." + PREFIX + "-btn-rec{border-color:var(--accent-red,#ef4444);color:var(--accent-red,#ef4444);",
    "background:color-mix(in srgb,var(--accent-red,#ef4444) 12%,transparent);}",
    "." + PREFIX + "-btn-rec:hover{background:color-mix(in srgb,var(--accent-red,#ef4444) 20%,transparent);color:var(--accent-red,#ef4444);}",
    "." + PREFIX + "-pulse{animation:" + PREFIX + "-pulse 1.2s ease-in-out infinite;}",
    "@keyframes " + PREFIX + "-pulse{0%,100%{opacity:1}50%{opacity:.35}}",
    "." + PREFIX + "-spin{animation:" + PREFIX + "-spin .8s linear infinite;}",
    "@keyframes " + PREFIX + "-spin{to{transform:rotate(360deg)}}",

    /* 遮罩 + 弹层 */
    "." + PREFIX + "-mask{position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,.42);",
    "display:flex;align-items:center;justify-content:center;padding:16px;}",
    "." + PREFIX + "-modal{width:min(560px,100%);max-height:86vh;display:flex;flex-direction:column;",
    "background:var(--bg-primary,#fff);color:var(--text-primary,inherit);",
    "border:1px solid var(--border-color,rgba(127,127,127,.3));border-radius:var(--radius-lg,12px);",
    "box-shadow:0 18px 48px rgba(0,0,0,.28);overflow:hidden;font-family:var(--font-sans,inherit);}",
    "." + PREFIX + "-head{display:flex;align-items:center;gap:8px;padding:13px 15px;",
    "border-bottom:1px solid var(--border-color,rgba(127,127,127,.22));}",
    "." + PREFIX + "-head-title{flex:1;font-size:14px;font-weight:700;display:flex;align-items:center;gap:7px;}",
    "." + PREFIX + "-body{padding:6px 15px 15px;overflow-y:auto;flex:1;}",
    "." + PREFIX + "-sec{padding:12px 0;border-bottom:1px solid var(--border-light,rgba(127,127,127,.16));}",
    "." + PREFIX + "-sec:last-child{border-bottom:none;}",
    "." + PREFIX + "-sec-title{display:flex;align-items:center;gap:6px;font-size:12px;font-weight:700;",
    "color:var(--text-secondary,inherit);margin-bottom:9px;letter-spacing:.02em;}",
    "." + PREFIX + "-row{display:flex;align-items:center;gap:10px;min-height:30px;padding:3px 0;flex-wrap:wrap;}",
    "." + PREFIX + "-row>.svo-label{flex:0 0 108px;font-size:12px;color:var(--text-secondary,inherit);}",
    "." + PREFIX + "-row>.svo-field{flex:1;min-width:150px;display:flex;align-items:center;gap:8px;}",
    "." + PREFIX + "-hint{font-size:11px;line-height:1.6;color:var(--text-tertiary,inherit);margin-top:5px;}",
    "." + PREFIX + "-status{font-size:11px;display:inline-flex;align-items:center;gap:5px;}",
    "." + PREFIX + "-ok{color:var(--accent-green,#22c55e);}",
    "." + PREFIX + "-err{color:var(--accent-red,#ef4444);}",
    "." + PREFIX + "-muted{color:var(--text-tertiary,inherit);}",

    /* 表单控件 */
    "." + PREFIX + "-input,." + PREFIX + "-select{flex:1;min-width:0;height:28px;padding:0 8px;font-size:12px;",
    "color:var(--text-primary,inherit);background:var(--bg-secondary,rgba(127,127,127,.06));",
    "border:1px solid var(--border-color,rgba(127,127,127,.3));border-radius:var(--radius-sm,6px);",
    "color-scheme:light dark;}",
    "." + PREFIX + "-input:focus,." + PREFIX + "-select:focus{outline:none;border-color:var(--accent-blue,#3b82f6);}",
    "." + PREFIX + "-range{flex:1;min-width:120px;accent-color:var(--accent-blue,#3b82f6);}",
    /* 快捷键录制按钮：平时显示当前组合键，录制中高亮提示 */
    "." + PREFIX + "-key{flex:1;min-width:0;height:28px;padding:0 9px;font-size:12px;text-align:left;",
    "color:var(--text-primary,inherit);background:var(--bg-secondary,rgba(127,127,127,.06));",
    "border:1px solid var(--border-color,rgba(127,127,127,.3));border-radius:var(--radius-sm,6px);",
    "cursor:pointer;font-family:inherit;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}",
    "." + PREFIX + "-key:hover{background:var(--bg-hover,rgba(127,127,127,.12));}",
    "." + PREFIX + "-key:focus-visible{outline:2px solid var(--accent-blue,#3b82f6);outline-offset:1px;}",
    "." + PREFIX + "-key-empty{color:var(--text-tertiary,inherit);}",
    "." + PREFIX + "-key[data-capturing='1']{border-color:var(--accent-blue,#3b82f6);",
    "color:var(--accent-blue,#3b82f6);background:color-mix(in srgb,var(--accent-blue,#3b82f6) 10%,transparent);}",
    "." + PREFIX + "-key[data-single='1']{border-color:var(--accent-red,#ef4444);}",
    "." + PREFIX + "-rangeval{flex:0 0 44px;text-align:right;font-size:11px;font-variant-numeric:tabular-nums;",
    "color:var(--text-secondary,inherit);}",
    "." + PREFIX + "-switch{position:relative;flex:0 0 auto;width:38px;height:22px;border-radius:11px;",
    "border:1px solid var(--border-color,rgba(127,127,127,.35));background:var(--bg-tertiary,rgba(127,127,127,.14));",
    "cursor:pointer;transition:background .15s,border-color .15s;padding:0;}",
    "." + PREFIX + "-switch::after{content:'';position:absolute;top:2px;left:2px;width:16px;height:16px;",
    "border-radius:50%;background:var(--bg-primary,#fff);box-shadow:0 1px 3px rgba(0,0,0,.3);transition:transform .15s;}",
    "." + PREFIX + "-switch[data-on='1']{background:var(--accent-blue,#3b82f6);border-color:var(--accent-blue,#3b82f6);}",
    "." + PREFIX + "-switch[data-on='1']::after{transform:translateX(16px);}",
    "." + PREFIX + "-switch:focus-visible{outline:2px solid var(--accent-blue,#3b82f6);outline-offset:2px;}",
    "." + PREFIX + "-foot{display:flex;align-items:center;gap:8px;padding:11px 15px;",
    "border-top:1px solid var(--border-color,rgba(127,127,127,.22));}",
    "." + PREFIX + "-foot>.svo-spacer{flex:1;}",
    "." + PREFIX + "-primary{background:var(--accent-color,#111827);color:var(--on-solid,#fff);",
    "border-color:var(--accent-color,#111827);}",
    "." + PREFIX + "-primary:hover{opacity:.9;background:var(--accent-color,#111827);color:var(--on-solid,#fff);}",
    "." + PREFIX + "-ghost{border-color:transparent;background:transparent;}",

    /* 录音浮标 */
    "." + PREFIX + "-recbar{position:fixed;left:50%;bottom:96px;transform:translateX(-50%);z-index:9998;",
    "display:flex;align-items:center;gap:9px;padding:8px 14px;border-radius:999px;",
    "background:var(--bg-primary,#fff);color:var(--text-primary,inherit);",
    "border:1px solid var(--border-color,rgba(127,127,127,.3));box-shadow:0 8px 26px rgba(0,0,0,.22);",
    "font-size:12px;font-family:var(--font-sans,inherit);}",
    "." + PREFIX + "-dot{width:8px;height:8px;border-radius:50%;background:var(--accent-red,#ef4444);}",
    "." + PREFIX + "-timer{font-variant-numeric:tabular-nums;min-width:34px;text-align:right;color:var(--text-secondary,inherit);}",

    /* 轻提示 */
    "." + PREFIX + "-toast{position:fixed;left:50%;bottom:150px;transform:translateX(-50%);z-index:10000;",
    "padding:9px 15px;border-radius:var(--radius-md,8px);font-size:12px;max-width:80vw;",
    "background:var(--bg-primary,#fff);color:var(--text-primary,inherit);",
    "border:1px solid var(--border-color,rgba(127,127,127,.3));box-shadow:0 8px 26px rgba(0,0,0,.22);",
    "display:flex;align-items:center;gap:7px;font-family:var(--font-sans,inherit);}",
    "." + PREFIX + "-toast-err{border-color:var(--accent-red,#ef4444);color:var(--accent-red,#ef4444);}",
    "." + PREFIX + "-toast-ok{border-color:var(--accent-green,#22c55e);}"
  ].join("");

  var styleEl = null;
  function injectStyle() {
    if (styleEl) return;
    styleEl = document.createElement("style");
    styleEl.setAttribute("data-snow-plugin", "snow-voice-io");
    styleEl.textContent = CSS;
    document.head.appendChild(styleEl);
  }

  /* ============================ 录音 + WAV 编码 ============================ */

  var rec = {
    active: false,
    stream: null,
    ctx: null,
    source: null,
    processor: null,
    gain: null,
    chunks: [],
    startedAt: 0,
    timer: null,
    sampleRate: 48000,
    // VAD / 分段状态
    lastVoiceAt: 0,
    lastVoiceChunk: 0,
    silenceStartAt: 0,
    spoke: false,
    segChunk: 0,
    segStartAt: 0,
    pending: 0
  };

  /* 分段切点要求的最小静音时长：短于此值不切，避免把一个词切两半 */
  var STREAM_CUT_SILENCE_MS = 600;

  function downSample(buffer, inRate, outRate) {
    if (outRate >= inRate) return buffer;
    var ratio = inRate / outRate;
    var outLen = Math.round(buffer.length / ratio);
    var out = new Float32Array(outLen);
    var i = 0;
    for (var j = 0; j < outLen; j++) {
      var next = Math.round((j + 1) * ratio);
      var sum = 0, cnt = 0;
      for (; i < next && i < buffer.length; i++) { sum += buffer[i]; cnt++; }
      out[j] = cnt ? sum / cnt : 0;
    }
    return out;
  }

  function mergeChunks(chunks) {
    var total = 0;
    for (var i = 0; i < chunks.length; i++) total += chunks[i].length;
    var out = new Float32Array(total);
    var off = 0;
    for (var j = 0; j < chunks.length; j++) { out.set(chunks[j], off); off += chunks[j].length; }
    return out;
  }

  function encodeWav(samples, sampleRate) {
    var buf = new ArrayBuffer(44 + samples.length * 2);
    var v = new DataView(buf);
    function ws(off, str) { for (var i = 0; i < str.length; i++) v.setUint8(off + i, str.charCodeAt(i)); }
    ws(0, "RIFF"); v.setUint32(4, 36 + samples.length * 2, true); ws(8, "WAVE");
    ws(12, "fmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, sampleRate, true); v.setUint32(28, sampleRate * 2, true);
    v.setUint16(32, 2, true); v.setUint16(34, 16, true);
    ws(36, "data"); v.setUint32(40, samples.length * 2, true);
    var off = 44;
    for (var i = 0; i < samples.length; i++) {
      var s = Math.max(-1, Math.min(1, samples[i]));
      v.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      off += 2;
    }
    return new Blob([v], { type: "audio/wav" });
  }

  function blobToBase64(blob) {
    return new Promise(function (resolve, reject) {
      var fr = new FileReader();
      fr.onload = function () {
        var s = String(fr.result || "");
        var idx = s.indexOf(",");
        resolve(idx >= 0 ? s.slice(idx + 1) : s);
      };
      fr.onerror = function () { reject(new Error("读取录音数据失败")); };
      fr.readAsDataURL(blob);
    });
  }

  function startRecording() {
    if (rec.active) return;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      toast("当前环境不支持录音（getUserMedia 不可用）", true);
      return;
    }
    navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true }
    }).then(function (stream) {
      var AC = window.AudioContext || window.webkitAudioContext;
      var ctx = new AC();
      var source = ctx.createMediaStreamSource(stream);
      var processor = ctx.createScriptProcessor(4096, 1, 1);
      var gain = ctx.createGain();
      gain.gain.value = 0;
      rec.chunks = [];
      rec.segChunk = 0;
      rec.segStartAt = Date.now();
      rec.pending = 0;
      rec.spoke = false;
      rec.silenceStartAt = 0;
      rec.lastVoiceAt = 0;
      rec.lastVoiceChunk = 0;
      rec.sampleRate = ctx.sampleRate || 48000;
      processor.onaudioprocess = function (e) {
        if (!rec.active) return;
        var buf = e.inputBuffer.getChannelData(0);
        rec.chunks.push(new Float32Array(buf));
        if (cfg.vadAutoStop || cfg.streamMode) trackVoice(buf);
      };
      source.connect(processor);
      processor.connect(gain);
      gain.connect(ctx.destination);
      rec.active = true;
      rec.stream = stream;
      rec.ctx = ctx;
      rec.source = source;
      rec.processor = processor;
      rec.gain = gain;
      rec.startedAt = Date.now();
      renderMicButton();
      showRecBar();
      var limit = Math.max(5, Number(cfg.maxRecordSeconds) || 60);
      rec.timer = setInterval(function () {
        var secs = Math.floor((Date.now() - rec.startedAt) / 1000);
        updateRecTimer(secs);
        if (secs >= limit) { toast("已达最长录音时长，自动结束", false); stopRecording(); }
      }, 500);
    }).catch(function (e) {
      toast("无法访问麦克风：" + (e && e.message ? e.message : e), true);
    });
  }

  function stopRecording() {
    if (!rec.active) return Promise.resolve();
    rec.active = false;
    if (rec.timer) { clearInterval(rec.timer); rec.timer = null; }
    var chunks = rec.chunks;
    var sampleRate = rec.sampleRate || (rec.ctx ? rec.ctx.sampleRate : 48000);
    try { if (rec.processor && rec.source) rec.source.disconnect(rec.processor); } catch (e) { /* ignore */ }
    try { if (rec.gain) rec.gain.disconnect(); } catch (e) { /* ignore */ }
    try { if (rec.processor) rec.processor.disconnect(); } catch (e) { /* ignore */ }
    try { if (rec.stream) rec.stream.getTracks().forEach(function (t) { t.stop(); }); } catch (e) { /* ignore */ }
    try { if (rec.ctx) rec.ctx.close(); } catch (e) { /* ignore */ }
    rec.stream = rec.ctx = rec.source = rec.processor = rec.gain = null;
    hideRecBar();
    renderMicButton();

    if (!chunks.length) { toast("没有录到音频", true); return Promise.resolve(); }

    /* 分段实时出字：已切出去的分段已经插入过，这里只处理剩余音频 */
    if (cfg.streamMode) {
      flushSegment(true);
      if (rec.pending) log("等待分段识别完成", { pending: rec.pending });
      return waitPending();
    }

    setMicState("busy");
    var target = 16000;
    var slice = takeAudio();
    if (!slice) { toast("没有录到音频", true); setMicState("idle"); return Promise.resolve(); }
    var pcm = downSample(mergeChunks(slice), sampleRate, target);
    var wav = encodeWav(pcm, target);
    log("录音结束", { seconds: ((Date.now() - rec.startedAt) / 1000).toFixed(1), bytes: wav.size });
    return transcribeBlob(wav).then(function (text) {
      insertText(text);
    }).catch(function (e) {
      toast((e && e.message) || String(e), true);
      log("转写失败", e);
    }).then(function () {
      setMicState("idle");
    });
  }

  /* ============================ 静音检测 / 分段切点 ============================ */

  function rmsOf(buf) {
    var sum = 0;
    for (var i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
    return Math.sqrt(sum / buf.length);
  }

  function vadActive() {
    return !!(cfg.vadAutoStop || cfg.streamMode);
  }

  /* 能量式 VAD：维护"最后一次有效人声"与"静音起点"，供自动结束、分段切点与去尾静音使用 */
  function trackVoice(buf) {
    var now = Date.now();
    var level = rmsOf(buf);
    if (level >= (Number(cfg.vadThreshold) || 0.012)) {
      rec.lastVoiceAt = now;
      rec.lastVoiceChunk = rec.chunks.length;
      rec.spoke = true;
      rec.silenceStartAt = 0;
    } else if (!rec.silenceStartAt) {
      rec.silenceStartAt = now;
    }

    if (cfg.vadAutoStop && rec.silenceStartAt) {
      var quietMs = now - rec.silenceStartAt;
      /* 说过话：静音超过设定时长即结束；一直没说话：给更长的思考时间再收工 */
      var limit = rec.spoke
        ? Math.max(400, Number(cfg.silenceMs) || 1500)
        : Math.max(8000, (Number(cfg.silenceMs) || 1500) * 4);
      if (quietMs >= limit) {
        toast((rec.spoke ? "静音 " + (quietMs / 1000).toFixed(1) + " 秒" : "长时间没有语音输入") + "，自动结束录音", false);
        setTimeout(function () { stopRecording(); }, 0);
        return;
      }
    }
    maybeCutSegment();
  }

  /* 取出本次要识别的音频：从上次切点开始，末尾纯静音截掉
     （whisper 对成片静音会凭空编出文本，实测 0.7 s 静音也能产出整句话） */
  function takeAudio() {
    var from = rec.segChunk;
    var to = rec.chunks.length;
    if (vadActive() && rec.spoke) {
      /* 这一段里始终没有人声：整段静音不送识别 */
      if (rec.lastVoiceChunk <= from) return null;
      if (rec.lastVoiceChunk + 3 < to) to = rec.lastVoiceChunk + 3;  /* 4096 帧 ≈ 85 ms，留约 250 ms 尾音余量 */
    }
    if (to <= from) return null;
    var slice = rec.chunks.slice(from, to);
    rec.segChunk = to;
    return slice;
  }

  /* 在静音边界切段；上一段还没识别完就继续攒着，避免识别任务堆积 */
  function maybeCutSegment() {
    if (!cfg.streamMode || rec.pending > 0 || !rec.spoke) return;
    var now = Date.now();
    var speechMs = now - rec.segStartAt;
    var quietMs = rec.silenceStartAt ? (now - rec.silenceStartAt) : 0;
    var maxMs = Math.max(5000, Number(cfg.streamMaxSegmentMs) || 15000);
    if (quietMs < STREAM_CUT_SILENCE_MS && speechMs < maxMs) return;
    flushSegment(false);
  }

  /* 把当前这段音频送识别并插入 */
  function flushSegment(final) {
    var slice = takeAudio();
    rec.segStartAt = Date.now();
    if (!slice) return;
    var target = 16000;
    var pcm = downSample(mergeChunks(slice), rec.sampleRate || 48000, target);
    var seconds = pcm.length / target;
    if (seconds < 0.25) {  /* 太短的碎片不送识别，避免凭空猜出文本 */
      if (final) toast("录音太短，未识别", true);
      return;
    }
    var wav = encodeWav(pcm, target);
    log("分段送识别", { seconds: seconds.toFixed(1), bytes: wav.size, final: !!final });
    rec.pending++;
    transcribeBlob(wav).then(function (text) {
      insertText(text);
    }).catch(function (e) {
      toast((e && e.message) || String(e), true);
      log("分段转写失败", e);
    }).then(function () {
      rec.pending = Math.max(0, rec.pending - 1);
    });
  }

  /* 等待所有在途分段识别完成后再恢复麦克风按钮状态 */
  function waitPending() {
    if (!rec.pending) { setMicState("idle"); return Promise.resolve(); }
    setMicState("busy");
    return new Promise(function (resolve) {
      var timer = setInterval(function () {
        if (!rec.pending) {
          clearInterval(timer);
          setMicState("idle");
          resolve();
        }
      }, 200);
    });
  }

  /* ============================ 转写（本机服务） ============================ */

  /* 插入前的兜底清理：服务端已做规范化，这里只防意外。
     注意 \s 在 JS 里包含 \f \v \u00a0 \u2000-\u200a \u202f \u205f \ufeff，
     只替换 [\r\n\t] 会漏掉这些"看不见"的空白，所以统一按 \s 处理。 */
  function cleanInsertText(raw) {
    var t = String(raw == null ? "" : raw);
    t = t.replace(/\s+/g, " ");
    return t.trim();
  }

  /* App 的 insertInputText 是"追加"语义：current ? current + text : text。
     输入框里若残留纯空白草稿（App 会按会话持久化草稿），拼上去就会变成
     "先一个回车再一个空格 + 文字"。插入前把纯空白草稿清掉。 */
  function chatInputEl() {
    var host = document.querySelector('[data-snow-anchor="chat.input"]');
    if (!host) return null;
    if (host.isContentEditable || host.tagName === "TEXTAREA") return host;
    return host.querySelector('[contenteditable="true"]') ||
      host.querySelector("textarea") ||
      host.querySelector('input[type="text"]');
  }

  function clearBlankDraft() {
    try {
      var el = chatInputEl();
      if (!el) return;
      var isEditable = !!el.isContentEditable;
      var cur = isEditable ? (el.textContent || "") : (el.value || "");
      if (!cur || cur.trim()) return;   /* 空或已有实际内容：不动 */
      if (isEditable) {
        el.innerHTML = "";
        el.dispatchEvent(new Event("input", { bubbles: true }));
      } else {
        var proto = (el.tagName === "TEXTAREA") ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        var desc = Object.getOwnPropertyDescriptor(proto, "value");
        if (desc && desc.set) {
          desc.set.call(el, "");
          el.dispatchEvent(new Event("input", { bubbles: true }));
        }
      }
      log("已清理空白草稿");
    } catch (e) { log("清理草稿失败", e); }
  }

  function insertText(raw) {
    var text = cleanInsertText(raw);
    if (!text) { toast("未识别到内容", true); return false; }
    clearBlankDraft();
    var prefix = cfg.autoInsertSpace ? " " : "";
    snow.client.insertInputText(prefix + text);
    log("插入文本", JSON.stringify(prefix + text));
    toast("已插入：" + text.slice(0, 30) + (text.length > 30 ? "…" : ""), false);
    return true;
  }

  /* 只负责拿回文本，不碰 UI 与插入，供单次模式与分段模式共用 */
  function transcribeBlob(wavBlob) {
    return blobToBase64(wavBlob).then(function (b64) {
      return snow.fetch(cfg.sttEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ audio_b64: b64, lang: cfg.sttLang || "auto" })
      });
    }).then(function (res) {
      if (!res || !res.ok) {
        throw new Error("转写服务返回 " + (res ? res.status : "无响应"));
      }
      return res.json();
    }).then(function (data) {
      return data && data.text ? String(data.text) : "";
    }).catch(function (e) {
      var msg = e && e.message ? e.message : String(e);
      if (msg.indexOf("Failed to fetch") >= 0 || msg.indexOf("NetworkError") >= 0) {
        msg = "无法连接本机转写服务，请确认服务已启动（" + cfg.sttEndpoint + "）";
      }
      throw new Error(msg);
    });
  }

  /* ============================ 朗读（系统 TTS） ============================ */

  var voiceCache = [];

  function refreshVoices() {
    try { voiceCache = speechSynthesis.getVoices() || []; }
    catch (e) { voiceCache = []; }
    return voiceCache;
  }

  function pickVoice() {
    var list = refreshVoices();
    if (!list.length) return null;
    if (cfg.voiceName) {
      for (var i = 0; i < list.length; i++) if (list[i].name === cfg.voiceName) return list[i];
    }
    var lang = (cfg.ttsLang || "zh-CN").toLowerCase();
    for (var j = 0; j < list.length; j++) if (String(list[j].lang || "").toLowerCase().indexOf(lang.slice(0, 2)) === 0) return list[j];
    return list[0] || null;
  }

  function cleanForSpeech(raw) {
    var t = String(raw || "");
    if (cfg.skipCodeBlocks) {
      t = t.replace(/```[\s\S]*?```/g, "（代码块）");
      t = t.replace(/`[^`\n]+`/g, "");
    }
    t = t.replace(/!\[[^\]]*\]\([^)]*\)/g, "");
    t = t.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");
    t = t.replace(/^\s{0,3}#{1,6}\s+/gm, "");
    t = t.replace(/^\s{0,3}[-*+]\s+/gm, "");
    t = t.replace(/^\s{0,3}>\s?/gm, "");
    t = t.replace(/\*\*([^*]+)\*\*/g, "$1").replace(/\*([^*]+)\*/g, "$1");
    t = t.replace(/~~([^~]+)~~/g, "$1");
    t = t.replace(/^\s*\|.*\|\s*$/gm, "");
    t = t.replace(/^\s*[-:| ]{3,}\s*$/gm, "");
    t = t.replace(/\s+/g, " ").trim();
    var max = Math.max(100, Number(cfg.maxSpeakChars) || 3000);
    if (t.length > max) t = t.slice(0, max) + "，内容过长已截断。";
    return t;
  }

  function lastAssistantText() {
    var nodes = document.querySelectorAll('[data-snow-anchor="chat.message"]');
    for (var i = nodes.length - 1; i >= 0; i--) {
      var el = nodes[i];
      if (el.getAttribute("data-snow-message-role") === "assistant") {
        return el.innerText || el.textContent || "";
      }
    }
    return "";
  }

  function speak(text) {
    if (!cfg.ttsEnabled) return;
    var clean = cleanForSpeech(text);
    if (!clean) return;
    try {
      speechSynthesis.cancel();
      var u = new SpeechSynthesisUtterance(clean);
      var v = pickVoice();
      if (v) { u.voice = v; u.lang = v.lang || cfg.ttsLang; } else { u.lang = cfg.ttsLang; }
      u.rate = Math.min(3, Math.max(0.5, Number(cfg.rate) || 1));
      u.volume = Math.min(1, Math.max(0, Number(cfg.volume) == null ? 1 : Number(cfg.volume)));
      speechSynthesis.speak(u);
      log("开始朗读", clean.slice(0, 40));
    } catch (e) { log("朗读失败", e); }
  }

  function stopSpeaking() {
    try { speechSynthesis.cancel(); } catch (e) { /* ignore */ }
  }

  /* ============================ 输入栏按钮 ============================ */

  var micBtn = null;
  var gearBtn = null;
  var micState = "idle"; // idle | busy

  function setMicState(s) {
    micState = s;
    renderMicButton();
  }

  function renderMicButton() {
    if (!micBtn) return;
    micBtn.replaceChildren();
    var name, title, cls = PREFIX + "-btn";
    var hk = (cfg.hotkeyEnabled && cfg.hotkeyRecord) ? "（" + comboLabel(cfg.hotkeyRecord) + "）" : "";
    if (rec.active) { name = "square"; title = "停止录音" + hk; cls += " " + PREFIX + "-btn-rec"; }
    else if (micState === "busy") { name = "loader-circle"; title = "识别中…"; cls += " " + PREFIX + "-spin"; }
    else { name = "mic"; title = "语音输入（点击开始录音）" + hk; }
    micBtn.className = cls;
    micBtn.title = title;
    micBtn.setAttribute("aria-label", title);
    micBtn.appendChild(svgIcon(name, 15));
    micBtn.disabled = micState === "busy";
  }

  function ensureButtons() {
    var slot = document.querySelector('[data-snow-slot="chat.input.actions"]');
    if (!slot) return;
    if (micBtn && micBtn.isConnected) return;

    micBtn = document.createElement("button");
    micBtn.type = "button";
    micBtn.addEventListener("click", function () {
      if (rec.active) { stopRecording(); } else { startRecording(); }
    });
    renderMicButton();

    gearBtn = document.createElement("button");
    gearBtn.type = "button";
    gearBtn.className = PREFIX + "-btn";
    gearBtn.title = "语音设置";
    gearBtn.setAttribute("aria-label", "语音设置");
    gearBtn.appendChild(svgIcon("settings", 15));
    gearBtn.addEventListener("click", openSettings);

    slot.appendChild(micBtn);
    slot.appendChild(gearBtn);
    log("输入栏按钮已挂载");
  }

  /* ============================ 录音浮标 / 轻提示 ============================ */

  var recBar = null;
  function showRecBar() {
    hideRecBar();
    recBar = document.createElement("div");
    recBar.className = PREFIX + "-recbar";
    var dot = document.createElement("span");
    dot.className = PREFIX + "-dot " + PREFIX + "-pulse";
    var label = document.createElement("span");
    label.textContent = "录音中";
    var timer = document.createElement("span");
    timer.className = PREFIX + "-timer";
    timer.textContent = "0:00";
    var stop = document.createElement("button");
    stop.type = "button";
    stop.className = PREFIX + "-btn " + PREFIX + "-btn-rec";
    stop.title = "停止并识别";
    stop.appendChild(svgIcon("square", 14));
    stop.addEventListener("click", function () { stopRecording(); });
    recBar.appendChild(dot);
    recBar.appendChild(label);
    recBar.appendChild(timer);
    recBar.appendChild(stop);
    document.body.appendChild(recBar);
  }

  function updateRecTimer(secs) {
    if (!recBar) return;
    var t = recBar.querySelector("." + PREFIX + "-timer");
    if (!t) return;
    var m = Math.floor(secs / 60);
    var s = secs % 60;
    t.textContent = m + ":" + (s < 10 ? "0" : "") + s;
  }

  function hideRecBar() {
    if (recBar && recBar.parentNode) recBar.parentNode.removeChild(recBar);
    recBar = null;
  }

  var toastEl = null, toastTimer = null;
  function toast(msg, isErr) {
    if (toastEl && toastEl.parentNode) toastEl.parentNode.removeChild(toastEl);
    toastEl = document.createElement("div");
    toastEl.className = PREFIX + "-toast " + (isErr ? PREFIX + "-toast-err" : PREFIX + "-toast-ok");
    toastEl.appendChild(svgIcon(isErr ? "circle-alert" : "check", 15));
    var span = document.createElement("span");
    span.textContent = String(msg);
    toastEl.appendChild(span);
    document.body.appendChild(toastEl);
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      if (toastEl && toastEl.parentNode) toastEl.parentNode.removeChild(toastEl);
      toastEl = null;
    }, isErr ? 5200 : 2800);
  }

  /* ============================ 设置弹层 ============================ */

  var modalEl = null;

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = String(text);
    return n;
  }

  function rowSwitch(labelText, getVal, setVal) {
    var row = el("div", PREFIX + "-row");
    row.appendChild(el("span", "svo-label", labelText));
    var field = el("div", "svo-field");
    var sw = el("button", PREFIX + "-switch");
    sw.type = "button";
    sw.setAttribute("role", "switch");
    sw.setAttribute("data-on", getVal() ? "1" : "0");
    sw.setAttribute("aria-checked", getVal() ? "true" : "false");
    sw.addEventListener("click", function () {
      var next = sw.getAttribute("data-on") !== "1";
      sw.setAttribute("data-on", next ? "1" : "0");
      sw.setAttribute("aria-checked", next ? "true" : "false");
      setVal(next);
    });
    field.appendChild(sw);
    row.appendChild(field);
    return row;
  }

  function rowText(labelText, value, placeholder, onChange) {
    var row = el("div", PREFIX + "-row");
    row.appendChild(el("span", "svo-label", labelText));
    var field = el("div", "svo-field");
    var input = el("input", PREFIX + "-input");
    input.type = "text";
    input.value = value == null ? "" : String(value);
    if (placeholder) input.placeholder = placeholder;
    input.addEventListener("change", function () { onChange(input.value); });
    field.appendChild(input);
    row.appendChild(field);
    return row;
  }

  function rowSelect(labelText, options, value, onChange) {
    var row = el("div", PREFIX + "-row");
    row.appendChild(el("span", "svo-label", labelText));
    var field = el("div", "svo-field");
    var sel = el("select", PREFIX + "-select");
    for (var i = 0; i < options.length; i++) {
      var o = el("option", null, options[i].label);
      o.value = options[i].value;
      if (options[i].value === value) o.selected = true;
      sel.appendChild(o);
    }
    sel.addEventListener("change", function () { onChange(sel.value); });
    field.appendChild(sel);
    row.appendChild(field);
    return row;
  }

  function rowRange(labelText, value, min, max, step, onChange, decimals) {
    var dig = (decimals == null) ? (step < 1 ? 1 : 0) : decimals;
    var row = el("div", PREFIX + "-row");
    row.appendChild(el("span", "svo-label", labelText));
    var field = el("div", "svo-field");
    var r = el("input", PREFIX + "-range");
    r.type = "range"; r.min = String(min); r.max = String(max); r.step = String(step);
    r.value = String(value);
    var val = el("span", PREFIX + "-rangeval", Number(value).toFixed(dig));
    r.addEventListener("input", function () {
      val.textContent = Number(r.value).toFixed(dig);
    });
    r.addEventListener("change", function () { onChange(Number(r.value)); });
    field.appendChild(r);
    field.appendChild(val);
    row.appendChild(field);
    return row;
  }

  /* 快捷键录制行：点按钮进入录制，按 Esc 取消、Del/退格 清除 */
  function rowHotkey(labelText, getVal, setVal) {
    var row = el("div", PREFIX + "-row");
    row.appendChild(el("span", "svo-label", labelText));
    var field = el("div", "svo-field");

    var keyBtn = el("button", PREFIX + "-key");
    keyBtn.type = "button";
    function render() {
      var v = getVal();
      keyBtn.textContent = v ? comboLabel(v) : "点击后按键（支持单键）";
      keyBtn.className = PREFIX + "-key" + (v ? "" : " " + PREFIX + "-key-empty");
      keyBtn.setAttribute("aria-label", labelText + "：" + (v ? comboLabel(v) : "未设置"));
      /* 单键提示：只会在非输入状态下生效，且可能被宿主先拦截 */
      if (v && isSingleKey(v)) {
        keyBtn.setAttribute("data-single", "1");
        keyBtn.title = "单键快捷键：仅在焦点不在输入框时生效；若与 Snow App 自带快捷键冲突，请换一个";
      } else {
        keyBtn.removeAttribute("data-single");
        keyBtn.title = "点击后直接按键即可改键";
      }
    }
    render();
    keyBtn.addEventListener("click", function () {
      hotkeyCapture = function (combo) {
        keyBtn.removeAttribute("data-capturing");
        if (combo === null) { setVal(""); render(); return; }   /* 清除 */
        if (combo === "") { render(); return; }                 /* Esc 取消 */
        setVal(combo);
        render();
      };
      keyBtn.setAttribute("data-capturing", "1");
      keyBtn.textContent = "请按键…（Esc 取消）";
    });

    var clearBtn = el("button", PREFIX + "-btn");
    clearBtn.type = "button";
    clearBtn.title = "清除快捷键";
    clearBtn.setAttribute("aria-label", labelText + "：清除");
    clearBtn.appendChild(svgIcon("eraser", 14));
    clearBtn.addEventListener("click", function () {
      hotkeyCapture = null;
      setVal("");
      keyBtn.removeAttribute("data-capturing");
      render();
    });

    field.appendChild(keyBtn);
    field.appendChild(clearBtn);
    row.appendChild(field);
    return row;
  }

  function section(iconName, titleText, rows) {
    var sec = el("div", PREFIX + "-sec");
    var h = el("div", PREFIX + "-sec-title");
    h.appendChild(svgIcon(iconName, 14));
    h.appendChild(el("span", null, titleText));
    sec.appendChild(h);
    for (var i = 0; i < rows.length; i++) sec.appendChild(rows[i]);
    return sec;
  }

  function closeSettings() {
    hotkeyCapture = null;   /* 关掉弹层时取消未完成的快捷键录制 */
    if (modalEl && modalEl.parentNode) modalEl.parentNode.removeChild(modalEl);
    modalEl = null;
  }

  function openSettings() {
    injectStyle();
    closeSettings();
    var mask = el("div", PREFIX + "-mask");
    mask.addEventListener("click", function (e) { if (e.target === mask) closeSettings(); });
    var modal = el("div", PREFIX + "-modal");

    var head = el("div", PREFIX + "-head");
    var ht = el("div", PREFIX + "-head-title");
    ht.appendChild(svgIcon("mic", 16));
    ht.appendChild(el("span", null, "语音输入 / 朗读设置"));
    head.appendChild(ht);
    var closeBtn = el("button", PREFIX + "-btn " + PREFIX + "-ghost");
    closeBtn.type = "button";
    closeBtn.title = "关闭";
    closeBtn.setAttribute("aria-label", "关闭");
    closeBtn.appendChild(svgIcon("x", 16));
    closeBtn.addEventListener("click", closeSettings);
    head.appendChild(closeBtn);

    var body = el("div", PREFIX + "-body");

    /* 状态区 */
    var statusSec = el("div", PREFIX + "-sec");
    var statusTitle = el("div", PREFIX + "-sec-title");
    statusTitle.appendChild(svgIcon("activity", 14));
    statusTitle.appendChild(el("span", null, "引擎状态"));
    statusSec.appendChild(statusTitle);
    var sttStatus = el("div", PREFIX + "-status " + PREFIX + "-muted");
    sttStatus.appendChild(svgIcon("loader-circle", 13));
    sttStatus.appendChild(el("span", null, "转写服务：未检测"));
    var ttsStatus = el("div", PREFIX + "-status " + PREFIX + "-muted");
    ttsStatus.appendChild(svgIcon("loader-circle", 13));
    ttsStatus.appendChild(el("span", null, "朗读引擎：未检测"));
    var checkRow = el("div", PREFIX + "-row");
    var cf = el("div", "svo-field");
    var checkBtn = el("button", PREFIX + "-btn");
    checkBtn.type = "button";
    checkBtn.appendChild(svgIcon("refresh-cw", 14));
    checkBtn.appendChild(el("span", null, "检测"));
    checkBtn.addEventListener("click", function () { runChecks(sttStatus, ttsStatus); });
    cf.appendChild(checkBtn);
    checkRow.appendChild(el("span", "svo-label", "检测"));
    checkRow.appendChild(cf);
    statusSec.appendChild(sttStatus);
    statusSec.appendChild(ttsStatus);
    statusSec.appendChild(checkRow);
    var hint = el("div", PREFIX + "-hint", "转写依赖本机 whisper.cpp 服务（默认 127.0.0.1:8791）；朗读使用系统语音引擎。");
    statusSec.appendChild(hint);
    body.appendChild(statusSec);

    /* 语音输入 */
    body.appendChild(section("mic", "语音输入", [
      rowSwitch("启用语音输入", function () { return cfg.inputEnabled; }, function (v) { cfg.inputEnabled = v; saveCfg(); refreshButtonVisibility(); }),
      rowText("转写服务地址", cfg.sttEndpoint, "http://127.0.0.1:8791/transcribe", function (v) { cfg.sttEndpoint = v.trim(); saveCfg(); }),
      rowSelect("识别语言", [
        { value: "zh", label: "中文" },
        { value: "en", label: "英文" },
        { value: "ja", label: "日文" },
        { value: "ko", label: "韩文" },
        { value: "auto", label: "自动检测" }
      ], cfg.sttLang, function (v) { cfg.sttLang = v; saveCfg(); }),
      rowRange("最长录音秒数", cfg.maxRecordSeconds, 5, 300, 5, function (v) { cfg.maxRecordSeconds = v; saveCfg(); }),
      rowSwitch("静音自动停止", function () { return cfg.vadAutoStop; }, function (v) { cfg.vadAutoStop = v; saveCfg(); }),
      rowRange("静音判定秒数", Number(cfg.silenceMs) / 1000, 0.5, 5, 0.5, function (v) { cfg.silenceMs = Math.round(v * 1000); saveCfg(); }),
      rowRange("静音阈值", Number(cfg.vadThreshold), 0.004, 0.06, 0.002, function (v) { cfg.vadThreshold = v; saveCfg(); }, 3),
      rowSwitch("分段实时出字", function () { return cfg.streamMode; }, function (v) { cfg.streamMode = v; saveCfg(); }),
      rowRange("单段最长秒数", Number(cfg.streamMaxSegmentMs) / 1000, 5, 30, 1, function (v) { cfg.streamMaxSegmentMs = Math.round(v * 1000); saveCfg(); }),
      rowSwitch("插入前加空格", function () { return cfg.autoInsertSpace; }, function (v) { cfg.autoInsertSpace = v; saveCfg(); }),
      rowSwitch("启用快捷键", function () { return cfg.hotkeyEnabled; }, function (v) { cfg.hotkeyEnabled = v; saveCfg(); }),
      rowHotkey("录音快捷键", function () { return cfg.hotkeyRecord; }, function (v) { cfg.hotkeyRecord = v; saveCfg(); renderMicButton(); }),
      el("div", PREFIX + "-hint", "快捷键：点按钮后直接按键即可改键（Esc 取消、Del 或橡皮按钮清除）。默认留空以免与 Snow App 自带快捷键冲突。支持单键（如 F2、`）：单键只在焦点不在输入框时生效，不会吃掉正常打字；若仍与宿主快捷键冲突，换一个即可——部分宿主快捷键是系统级的，脚本无法覆盖。"),
      el("div", PREFIX + "-hint", "静音自动停止：识别到人声后，连续静音超过「静音判定秒数」即自动结束并转写；环境噪声大时把「静音阈值」调高。"),
      el("div", PREFIX + "-hint", "分段实时出字：在静音边界把已录语音切段送识别，边录边插入，不必等整段结束；识别速度取决于模型，large-v3-turbo 单段约 7 秒，small-q5_1 约 1.5 秒。")
    ]));

    /* 语音朗读 */
    body.appendChild(section("volume-2", "语音朗读", [
      rowSwitch("启用朗读", function () { return cfg.ttsEnabled; }, function (v) { cfg.ttsEnabled = v; saveCfg(); refreshButtonVisibility(); }),
      rowSwitch("回合结束自动朗读", function () { return cfg.autoSpeak; }, function (v) { cfg.autoSpeak = v; saveCfg(); }),
      rowSelect("音色", buildVoiceOptions(), cfg.voiceName, function (v) { cfg.voiceName = v; saveCfg(); }),
      rowRange("语速", cfg.rate, 0.5, 2.5, 0.1, function (v) { cfg.rate = v; saveCfg(); }),
      rowRange("音量", cfg.volume, 0, 1, 0.05, function (v) { cfg.volume = v; saveCfg(); }),
      rowSwitch("跳过代码块", function () { return cfg.skipCodeBlocks; }, function (v) { cfg.skipCodeBlocks = v; saveCfg(); }),
      rowRange("最长朗读字数", cfg.maxSpeakChars, 200, 8000, 100, function (v) { cfg.maxSpeakChars = v; saveCfg(); }),
      rowHotkey("停止朗读快捷键", function () { return cfg.hotkeyStopSpeak; }, function (v) { cfg.hotkeyStopSpeak = v; saveCfg(); })
    ]));

    var foot = el("div", PREFIX + "-foot");
    var testSpeak = el("button", PREFIX + "-btn");
    testSpeak.type = "button";
    testSpeak.appendChild(svgIcon("play", 14));
    testSpeak.appendChild(el("span", null, "试听"));
    testSpeak.addEventListener("click", function () {
      speak("你好，这是 snow 语音朗读的试听效果。");
    });
    var stopSpeak = el("button", PREFIX + "-btn");
    stopSpeak.type = "button";
    stopSpeak.appendChild(svgIcon("volume-x", 14));
    stopSpeak.appendChild(el("span", null, "停止朗读"));
    stopSpeak.addEventListener("click", stopSpeaking);
    var spacer = el("div", "svo-spacer");
    var done = el("button", PREFIX + "-btn " + PREFIX + "-primary");
    done.type = "button";
    done.appendChild(svgIcon("check", 14));
    done.appendChild(el("span", null, "完成"));
    done.addEventListener("click", closeSettings);
    foot.appendChild(testSpeak);
    foot.appendChild(stopSpeak);
    foot.appendChild(spacer);
    foot.appendChild(done);

    modal.appendChild(head);
    modal.appendChild(body);
    modal.appendChild(foot);
    mask.appendChild(modal);
    document.body.appendChild(mask);
    modalEl = mask;

    runChecks(sttStatus, ttsStatus);
  }

  function buildVoiceOptions() {
    var list = refreshVoices();
    var opts = [{ value: "", label: "自动（优先中文）" }];
    for (var i = 0; i < list.length; i++) {
      opts.push({ value: list[i].name, label: list[i].name + " · " + (list[i].lang || "") });
    }
    if (!list.length) opts.push({ value: "", label: "（暂未检测到系统音色）" });
    return opts;
  }

  function runChecks(sttStatusEl, ttsStatusEl) {
    /* 转写服务探测 */
    sttStatusEl.className = PREFIX + "-status " + PREFIX + "-muted";
    sttStatusEl.replaceChildren();
    sttStatusEl.appendChild(svgIcon("loader-circle", 13));
    sttStatusEl.appendChild(el("span", null, "转写服务：检测中…"));
    var pingUrl = String(cfg.sttEndpoint || "").replace(/\/transcribe\s*$/, "/ping");
    var timer = setTimeout(function () {
      sttStatusEl.className = PREFIX + "-status " + PREFIX + "-err";
      sttStatusEl.replaceChildren();
      sttStatusEl.appendChild(svgIcon("circle-alert", 13));
      sttStatusEl.appendChild(el("span", null, "转写服务：连接超时"));
    }, 6000);
    snow.fetch(pingUrl, { method: "GET" }).then(function (res) {
      clearTimeout(timer);
      sttStatusEl.replaceChildren();
      if (res && res.ok) {
        sttStatusEl.className = PREFIX + "-status " + PREFIX + "-ok";
        sttStatusEl.appendChild(svgIcon("check", 13));
        sttStatusEl.appendChild(el("span", null, "转写服务：可用"));
      } else {
        sttStatusEl.className = PREFIX + "-status " + PREFIX + "-err";
        sttStatusEl.appendChild(svgIcon("circle-alert", 13));
        sttStatusEl.appendChild(el("span", null, "转写服务：返回 " + (res ? res.status : "无响应")));
      }
    }).catch(function () {
      clearTimeout(timer);
      sttStatusEl.className = PREFIX + "-status " + PREFIX + "-err";
      sttStatusEl.replaceChildren();
      sttStatusEl.appendChild(svgIcon("circle-alert", 13));
      sttStatusEl.appendChild(el("span", null, "转写服务：不可用（请先启动本地服务）"));
    });

    /* 朗读引擎探测 */
    var voices = refreshVoices();
    ttsStatusEl.replaceChildren();
    if (voices.length) {
      var zh = 0;
      for (var i = 0; i < voices.length; i++) if (String(voices[i].lang || "").toLowerCase().indexOf("zh") === 0) zh++;
      ttsStatusEl.className = PREFIX + "-status " + PREFIX + "-ok";
      ttsStatusEl.appendChild(svgIcon("check", 13));
      ttsStatusEl.appendChild(el("span", null, "朗读引擎：可用（共 " + voices.length + " 个音色，中文 " + zh + " 个）"));
    } else {
      ttsStatusEl.className = PREFIX + "-status " + PREFIX + "-err";
      ttsStatusEl.appendChild(svgIcon("circle-alert", 13));
      ttsStatusEl.appendChild(el("span", null, "朗读引擎：未检测到系统音色"));
    }
  }

  function refreshButtonVisibility() {
    if (!micBtn) return;
    micBtn.style.display = cfg.inputEnabled ? "" : "none";
  }

  /* ============================ 事件接线 ============================ */

  function onStreamEnd() {
    if (!cfg.ttsEnabled || !cfg.autoSpeak) return;
    /* 等 DOM 落定再取文本 */
    setTimeout(function () {
      var raw = lastAssistantText();
      if (raw) speak(raw);
    }, 400);
  }

  function wire() {
    injectStyle();
    ensureButtons();

    try {
      snow.on("stream-end", onStreamEnd);
      snow.on("view-enter", function () { ensureButtons(); refreshButtonVisibility(); });
      snow.on("theme-change", function () { /* 主题变量自动生效，无需处理 */ });
    } catch (e) { log("事件订阅失败", e); }

    /* React 重渲染可能重建插槽，用 MutationObserver 兜底重挂 */
    var mo = new MutationObserver(function () {
      if (!micBtn || !micBtn.isConnected) ensureButtons();
    });
    try { mo.observe(document.body, { childList: true, subtree: true }); } catch (e) { /* ignore */ }

    /* 快捷键：捕获阶段监听，才能在输入框把按键吃掉之前拦下来 */
    try {
      document.addEventListener("keydown", onHotkeyDown, true);
    } catch (e) { log("快捷键注册失败", e); }

    /* 语音列表异步加载 */
    try {
      speechSynthesis.onvoiceschanged = function () { refreshVoices(); };
    } catch (e) { /* ignore */ }

    snow.onCleanup(function () {
      try { mo.disconnect(); } catch (e) { /* ignore */ }
      try { document.removeEventListener("keydown", onHotkeyDown, true); } catch (e) { /* ignore */ }
      hotkeyCapture = null;
      stopSpeaking();
      if (rec.active) stopRecording();
      hideRecBar();
      closeSettings();
      if (styleEl && styleEl.parentNode) styleEl.parentNode.removeChild(styleEl);
      if (toastEl && toastEl.parentNode) toastEl.parentNode.removeChild(toastEl);
    });

    try {
      GM_registerMenuCommand("语音输入 / 朗读设置", openSettings);
    } catch (e) { /* ignore */ }

    refreshVoices();
    log("已就绪", {
      input: cfg.inputEnabled, tts: cfg.ttsEnabled, voices: voiceCache.length,
      hotkey: cfg.hotkeyEnabled ? cfg.hotkeyRecord : "(已关闭)"
    });
  }

  wire();
})();
