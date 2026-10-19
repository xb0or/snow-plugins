// ==UserScript==
// @name         回合结束通知中心
// @name:en      Turn-end Notifier
// @namespace    kedou
// @version      1.4.5
// @description  回合结束通知中心：多渠道推送（Server酱 / PushPlus / Bark / 钉钉 / 企业微信 / Telegram / 飞书）+ 提示音 + 应用内提示；支持后台会话（非当前打开会话）完成提醒
// @author       kedou
// @license      MIT
// @icon         lucide:BellRing
// @snow-target  client
// @snow-scope   global
// @snow-privacy messages, network
// @run-at       document-idle
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// ==/UserScript==

/*
 * snow-notify-hub —— Snow App 客户端脚本
 *
 * 触发：snow.on('stream-end')（当前会话一轮 AI 回复结束）+ 运行时快照监听（任意会话回合结束）。
 *       可选最短回合时长门槛与免打扰时段。
 * 动作：多选组合 —— 推送渠道（HTTP，经 snow.fetch）+ 提示音（Web Audio 合成）+ 应用内提示条。
 *
 * 说明：
 *  - stream-end 只覆盖「当前打开的会话」：切到别的会话后，原会话跑完不会触发该事件。
 *    因此额外订阅元数据 runtime 域（live，无需隐私声明），主信号是宿主维护的
 *    completedConversationIds（非焦点会话「已完成未读」集合），兜底是 streamingSessions
 *    集合变化，实现后台会话完成提醒。
 *  - 提示正文默认为会话名（来自运行时快照）；选「回复摘要」时前台读 DOM，
 *    后台读 messages 元数据域（需 @snow-privacy messages 声明）。
 *  - 推送全部走 snow.fetch（经主进程、无 CORS 限制）；凭据仅存本机 GM 值。
 *  - snow.fetch 外发请求需声明 network 网络隐私域（@snow-privacy）。
 *  - 提示音由 Web Audio 现场合成，无外部音频资源，21 种预设。
 *  - 系统级通知（GM_notification）在本构建中静默失效（实测），故提示条为应用内自绘，配色跟随宿主主题。
 *  - 图标内嵌官方 Lucide SVG 路径（客户端脚本环境无全局 lucide 对象）。
 */

(function () {
  "use strict";

  var TAG = "[snow-notify-hub]";
  var CFG_KEY = "snh.config";
  var BOOT_KEY = "snh.boot";   /* 注入心跳：脚本每次运行写一次，用于确认脚本是否真的被注入 */
  var DIAG_KEY = "snh.diag";   /* 诊断环形日志：仅在 cfg.diag 打开时写 */
  var PREFIX = "snh";

  /* ============================ 配置 ============================ */

  var DEFAULT_CFG = {
    enabled: true,
    // 触发规则
    minStreamSeconds: 0,
    quietEnabled: false,
    quietStart: "23:00",
    quietEnd: "07:00",
    // 提示正文：title = 会话名（默认）；excerpt = 回复摘要
    bodyMode: "title",
    excerptChars: 120,
    // 后台会话（非当前打开的会话）
    backgroundWatch: true,
    // 诊断
    diag: false,
    // 动作开关
    soundEnabled: true,
    soundId: "chime-01",
    soundVolume: 0.5,
    toastEnabled: true,
    toastSeconds: 5,
    // 渠道
    channels: {
      serverchan: { enabled: false, sendKey: "" },
      pushplus: { enabled: false, token: "" },
      bark: { enabled: false, server: "https://api.day.app", key: "" },
      dingtalk: { enabled: false, webhook: "", secret: "" },
      wecom: { enabled: false, webhook: "" },
      telegram: { enabled: false, botToken: "", chatId: "" },
      feishu: { enabled: false, webhook: "" }
    }
  };

  var cfg = loadCfg();

  function deepMerge(base, patch) {
    for (var k in patch) {
      if (!Object.prototype.hasOwnProperty.call(patch, k)) continue;
      if (base[k] && typeof base[k] === "object" && !Array.isArray(base[k]) && patch[k] && typeof patch[k] === "object") {
        deepMerge(base[k], patch[k]);
      } else {
        base[k] = patch[k];
      }
    }
    return base;
  }

  function loadCfg() {
    var out = JSON.parse(JSON.stringify(DEFAULT_CFG));
    try {
      var raw = GM_getValue(CFG_KEY, "");
      if (raw) deepMerge(out, JSON.parse(raw));
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

  /* ---- 诊断：确认脚本是否被注入、事件是否到达、各判断分支走向 ---- */

  function diag(event, data) {
    if (!cfg.diag) return;
    try {
      var arr = JSON.parse(GM_getValue(DIAG_KEY, "[]"));
      if (!Array.isArray(arr)) arr = [];
      arr.push({ t: Date.now(), ev: event, d: data || null });
      if (arr.length > 120) arr = arr.slice(arr.length - 120);
      GM_setValue(DIAG_KEY, JSON.stringify(arr));
    } catch (e) { /* ignore */ }
  }

  function ctxBrief() {
    try {
      return {
        view: snow.context.view,
        conv: snow.context.conversationId || "",
        isStreaming: !!snow.context.isStreaming,
        appReady: !!snow.context.appReady
      };
    } catch (e) { return null; }
  }

  /* 注入心跳：每次脚本运行写一次，用于确认脚本是否真的被注入并执行 */
  function bootStamp() {
    var version = "";
    try {
      if (typeof GM_info !== "undefined" && GM_info.script && GM_info.script.version) version = GM_info.script.version;
    } catch (e) { /* ignore */ }
    try {
      GM_setValue(BOOT_KEY, JSON.stringify({
        t: Date.now(),
        version: version,
        sandbox: (function () { try { return !!snow.isSandbox; } catch (e) { return null; } })(),
        hasMetadata: !!(snow && snow.metadata && typeof snow.metadata.subscribe === "function"),
        cfg: {
          enabled: cfg.enabled, sound: cfg.soundEnabled, toast: cfg.toastEnabled,
          bgWatch: cfg.backgroundWatch, bodyMode: cfg.bodyMode,
          minSec: cfg.minStreamSeconds, quiet: cfg.quietEnabled, diag: cfg.diag
        },
        ctx: ctxBrief(),
        menubtn: (function () { try { return !!menuBtn; } catch (e) { return null; } })()
      }));
    } catch (e) { /* ignore */ }
  }

  /* ============================ Lucide 图标 ============================ */

  var ICONS = {
    bell: '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>',
    "bell-ring": '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/><path d="M4 2C2.8 3.7 2 5.7 2 8"/><path d="M22 8c0-2.3-.8-4.3-2-6"/>',
    send: '<path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/>',
    "message-circle": '<path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z"/>',
    smartphone: '<rect width="14" height="20" x="5" y="2" rx="2" ry="2"/><path d="M12 18h.01"/>',
    bot: '<path d="M12 8V4H8"/><rect width="16" height="12" x="4" y="8" rx="2"/><path d="M2 14h2"/><path d="M20 14h2"/><path d="M15 13v2"/><path d="M9 13v2"/>',
    monitor: '<rect width="20" height="14" x="2" y="3" rx="2"/><line x1="8" x2="16" y1="21" y2="21"/><line x1="12" x2="12" y1="17" y2="21"/>',
    "sliders-horizontal": '<line x1="21" x2="14" y1="4" y2="4"/><line x1="10" x2="3" y1="4" y2="4"/><line x1="21" x2="12" y1="12" y2="12"/><line x1="8" x2="3" y1="12" y2="12"/><line x1="21" x2="16" y1="20" y2="20"/><line x1="12" x2="3" y1="20" y2="20"/><line x1="14" x2="14" y1="2" y2="6"/><line x1="8" x2="8" y1="10" y2="14"/><line x1="16" x2="16" y1="18" y2="22"/>',
    settings: '<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>',
    x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
    check: '<path d="M20 6 9 17l-5-5"/>',
    play: '<polygon points="6 3 20 12 6 21 6 3"/>',
    "volume-2": '<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/>',
    "circle-alert": '<circle cx="12" cy="12" r="10"/><line x1="12" x2="12" y1="8" y2="12"/><line x1="12" x2="12.01" y1="16" y2="16"/>',
    "loader-circle": '<path d="M21 12a9 9 0 1 1-6.219-8.56"/>'
  };

  function svgIcon(name, size) {
    var s = size || 16;
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
    el.innerHTML = ICONS[name] || ICONS["circle-alert"]; // 固定常量，无注入面
    return el;
  }

  /* ============================ 提示音（Web Audio 合成，21 种） ============================ */

  var SOUNDS = [
    { id: "chime-01", name: "清脆提示", notes: [{ f: 880, t: 0, d: 0.18 }, { f: 1174, t: 0.1, d: 0.24 }] },
    { id: "chime-02", name: "柔和双音", notes: [{ f: 523, t: 0, d: 0.28 }, { f: 659, t: 0.14, d: 0.3 }] },
    { id: "chime-03", name: "上行三音", notes: [{ f: 523, t: 0, d: 0.14 }, { f: 659, t: 0.12, d: 0.14 }, { f: 784, t: 0.24, d: 0.2 }] },
    { id: "chime-04", name: "下行三音", notes: [{ f: 784, t: 0, d: 0.14 }, { f: 659, t: 0.12, d: 0.14 }, { f: 523, t: 0.24, d: 0.2 }] },
    { id: "chime-05", name: "叮咚", notes: [{ f: 988, t: 0, d: 0.16 }, { f: 659, t: 0.16, d: 0.3 }] },
    { id: "chime-06", name: "双响提示", notes: [{ f: 880, t: 0, d: 0.1 }, { f: 880, t: 0.16, d: 0.1 }] },
    { id: "chime-07", name: "钟声", notes: [{ f: 440, t: 0, d: 0.9, wave: "triangle" }, { f: 660, t: 0.02, d: 0.7, g: 0.16, wave: "triangle" }] },
    { id: "chime-08", name: "鸟鸣", notes: [{ f: 1600, t: 0, d: 0.08 }, { f: 2000, t: 0.08, d: 0.08 }, { f: 1750, t: 0.18, d: 0.1 }] },
    { id: "chime-09", name: "木鱼", notes: [{ f: 320, t: 0, d: 0.09, wave: "square", g: 0.2 }, { f: 300, t: 0.1, d: 0.09, wave: "square", g: 0.18 }] },
    { id: "chime-10", name: "电子音", notes: [{ f: 1200, t: 0, d: 0.06, wave: "sawtooth", g: 0.14 }, { f: 1500, t: 0.06, d: 0.06, wave: "sawtooth", g: 0.14 }] },
    { id: "chime-11", name: "和弦", notes: [{ f: 523, t: 0, d: 0.5 }, { f: 659, t: 0, d: 0.5, g: 0.2 }, { f: 784, t: 0, d: 0.5, g: 0.18 }] },
    { id: "chime-12", name: "快速三连", notes: [{ f: 1046, t: 0, d: 0.07 }, { f: 1046, t: 0.09, d: 0.07 }, { f: 1046, t: 0.18, d: 0.09 }] },
    { id: "chime-13", name: "低沉提示", notes: [{ f: 262, t: 0, d: 0.4, wave: "sine" }, { f: 330, t: 0.12, d: 0.4, g: 0.2 }] },
    { id: "chime-14", name: "高音轻响", notes: [{ f: 1760, t: 0, d: 0.12 }, { f: 2093, t: 0.08, d: 0.16, g: 0.2 }] },
    { id: "chime-15", name: "气泡音", notes: [{ f: 700, t: 0, d: 0.06 }, { f: 1000, t: 0.05, d: 0.06 }, { f: 1400, t: 0.1, d: 0.08 }] },
    { id: "chime-16", name: "玻璃音", notes: [{ f: 2637, t: 0, d: 0.18 }, { f: 3520, t: 0.02, d: 0.14, g: 0.14 }] },
    { id: "chime-17", name: "完成音", notes: [{ f: 659, t: 0, d: 0.12 }, { f: 784, t: 0.1, d: 0.12 }, { f: 1046, t: 0.2, d: 0.3 }] },
    { id: "chime-18", name: "警告音", notes: [{ f: 440, t: 0, d: 0.16, wave: "square", g: 0.16 }, { f: 349, t: 0.18, d: 0.24, wave: "square", g: 0.16 }] },
    { id: "chime-19", name: "悠远回响", notes: [{ f: 392, t: 0, d: 1.1, wave: "triangle" }, { f: 587, t: 0.06, d: 0.9, g: 0.14, wave: "triangle" }] },
    { id: "chime-20", name: "短促滴答", notes: [{ f: 1318, t: 0, d: 0.05, wave: "square", g: 0.12 }] },
    { id: "chime-21", name: "上扬收尾", notes: [{ f: 587, t: 0, d: 0.12 }, { f: 740, t: 0.1, d: 0.12 }, { f: 880, t: 0.2, d: 0.12 }, { f: 1174, t: 0.3, d: 0.34 }] }
  ];

  function soundById(id) {
    for (var i = 0; i < SOUNDS.length; i++) if (SOUNDS[i].id === id) return SOUNDS[i];
    return SOUNDS[0];
  }

  function playSound(id, volume) {
    var preset = soundById(id);
    var AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    var ctx;
    try { ctx = new AC(); } catch (e) { return; }
    var vol = Math.min(1, Math.max(0, volume == null ? 0.5 : Number(volume)));
    var now = ctx.currentTime;
    var endMs = 0;
    for (var i = 0; i < preset.notes.length; i++) {
      var n = preset.notes[i];
      var osc = ctx.createOscillator();
      var g = ctx.createGain();
      osc.type = n.wave || "sine";
      osc.frequency.value = n.f;
      var peak = (n.g == null ? 0.3 : n.g) * vol;
      var t0 = now + n.t;
      var t1 = t0 + n.d;
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), t0 + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, t1);
      osc.connect(g);
      g.connect(ctx.destination);
      osc.start(t0);
      osc.stop(t1 + 0.03);
      endMs = Math.max(endMs, (n.t + n.d) * 1000);
    }
    setTimeout(function () { try { ctx.close(); } catch (e) { /* ignore */ } }, endMs + 400);
  }

  /* ============================ 推送渠道 ============================ */

  var CHANNELS = [
    {
      id: "serverchan", name: "Server酱", icon: "send",
      hint: "SendKey（形如 SCT…）",
      field: "sendKey", placeholder: "SCTxxxxxxxxxxxx",
      build: function (c, msg) {
        if (!c.sendKey) return null;
        return {
          url: "https://sctapi.ftqq.com/" + encodeURIComponent(c.sendKey) + ".send",
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: msg.title, desp: msg.body })
        };
      }
    },
    {
      id: "pushplus", name: "PushPlus", icon: "send",
      hint: "Token",
      field: "token", placeholder: "32 位 token",
      build: function (c, msg) {
        if (!c.token) return null;
        return {
          url: "https://www.pushplus.plus/send",
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token: c.token, title: msg.title, content: msg.body, template: "txt" })
        };
      }
    },
    {
      id: "bark", name: "Bark", icon: "smartphone",
      hint: "设备 Key；可自定义服务器",
      field: "key", placeholder: "设备 Key",
      extra: { key: "server", placeholder: "https://api.day.app" },
      build: function (c, msg) {
        if (!c.key) return null;
        var base = (c.server || "https://api.day.app").replace(/\/+$/, "");
        return {
          url: base + "/" + encodeURIComponent(c.key),
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: msg.title, body: msg.body, group: "Snow App" })
        };
      }
    },
    {
      id: "dingtalk", name: "钉钉", icon: "message-circle",
      hint: "机器人 Webhook 完整地址（含 access_token）",
      field: "webhook", placeholder: "https://oapi.dingtalk.com/robot/send?access_token=…",
      build: function (c, msg) {
        if (!c.webhook) return null;
        return {
          url: c.webhook,
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ msgtype: "text", text: { content: msg.title + "\n" + msg.body } })
        };
      }
    },
    {
      id: "wecom", name: "企业微信", icon: "message-circle",
      hint: "群机器人 Webhook 完整地址（含 key）",
      field: "webhook", placeholder: "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=…",
      build: function (c, msg) {
        if (!c.webhook) return null;
        return {
          url: c.webhook,
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ msgtype: "text", text: { content: msg.title + "\n" + msg.body } })
        };
      }
    },
    {
      id: "telegram", name: "Telegram", icon: "bot",
      hint: "Bot Token + Chat ID",
      field: "botToken", placeholder: "123456:ABC-DEF…",
      extra: { key: "chatId", placeholder: "Chat ID，如 123456789" },
      build: function (c, msg) {
        if (!c.botToken || !c.chatId) return null;
        return {
          url: "https://api.telegram.org/bot" + c.botToken + "/sendMessage",
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chat_id: c.chatId, text: msg.title + "\n" + msg.body })
        };
      }
    },
    {
      id: "feishu", name: "飞书", icon: "message-circle",
      hint: "自定义机器人 Webhook 完整地址",
      field: "webhook", placeholder: "https://open.feishu.cn/open-apis/bot/v2/hook/…",
      build: function (c, msg) {
        if (!c.webhook) return null;
        return {
          url: c.webhook,
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ msg_type: "text", content: { text: msg.title + "\n" + msg.body } })
        };
      }
    }
  ];

  function channelById(id) {
    for (var i = 0; i < CHANNELS.length; i++) if (CHANNELS[i].id === id) return CHANNELS[i];
    return null;
  }

  function sendChannel(id, msg) {
    var ch = channelById(id);
    if (!ch) return Promise.resolve({ ok: false, error: "未知渠道" });
    var conf = cfg.channels[id] || {};
    var req = ch.build(conf, msg);
    if (!req) return Promise.resolve({ ok: false, error: "未配置凭据" });
    return snow.fetch(req.url, { method: req.method, headers: req.headers, body: req.body })
      .then(function (res) {
        if (!res) return { ok: false, error: "无响应" };
        if (!res.ok) return { ok: false, error: "HTTP " + res.status };
        return res.text().then(function (t) {
          /* 常见网关在 HTTP 200 内返回业务错误码 */
          var bad = false, detail = "";
          try {
            var j = JSON.parse(t);
            if (j && typeof j === "object") {
              if (j.code != null && j.code !== 0 && j.code !== "0") { bad = true; detail = "code " + j.code; }
              if (j.errcode != null && j.errcode !== 0) { bad = true; detail = "errcode " + j.errcode; }
            }
          } catch (e) { /* 非 JSON，按成功处理 */ }
          return bad ? { ok: false, error: detail || "业务错误" } : { ok: true };
        });
      })
      .catch(function (e) {
        return { ok: false, error: e && e.message ? e.message : String(e) };
      });
  }

  /* ============================ 样式（跟随宿主主题） ============================ */

  var CSS = [
    "." + PREFIX + "-mask{position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,.42);",
    "display:flex;align-items:center;justify-content:center;padding:16px;}",
    "." + PREFIX + "-modal{width:min(600px,100%);max-height:88vh;display:flex;flex-direction:column;",
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
    "." + PREFIX + "-row>.snh-label{flex:0 0 108px;font-size:12px;color:var(--text-secondary,inherit);}",
    "." + PREFIX + "-row>.snh-field{flex:1;min-width:150px;display:flex;align-items:center;gap:8px;}",
    "." + PREFIX + "-hint{font-size:11px;line-height:1.6;color:var(--text-tertiary,inherit);margin-top:5px;}",
    "." + PREFIX + "-muted{color:var(--text-tertiary,inherit);}",
    "." + PREFIX + "-ok{color:var(--accent-green,#22c55e);}",
    "." + PREFIX + "-err{color:var(--accent-red,#ef4444);}",
    "." + PREFIX + "-status{font-size:11px;display:inline-flex;align-items:center;gap:5px;}",

    /* 渠道卡 */
    "." + PREFIX + "-ch{border:1px solid var(--border-color,rgba(127,127,127,.28));border-radius:var(--radius-md,8px);",
    "padding:10px 11px;margin-bottom:8px;background:var(--bg-secondary,rgba(127,127,127,.04));}",
    "." + PREFIX + "-ch-head{display:flex;align-items:center;gap:8px;}",
    "." + PREFIX + "-ch-name{flex:1;display:flex;align-items:center;gap:6px;font-size:12px;font-weight:600;}",
    "." + PREFIX + "-ch-body{margin-top:8px;display:flex;flex-direction:column;gap:6px;}",
    "." + PREFIX + "-ch-field{display:flex;align-items:center;gap:7px;}",
    "." + PREFIX + "-ch-field>span{flex:0 0 auto;font-size:11px;color:var(--text-tertiary,inherit);}",

    /* 控件 */
    "." + PREFIX + "-input,." + PREFIX + "-select{flex:1;min-width:0;height:28px;padding:0 8px;font-size:12px;",
    "color:var(--text-primary,inherit);background:var(--bg-primary,rgba(127,127,127,.06));",
    "border:1px solid var(--border-color,rgba(127,127,127,.3));border-radius:var(--radius-sm,6px);color-scheme:light dark;}",
    "." + PREFIX + "-input:focus,." + PREFIX + "-select:focus{outline:none;border-color:var(--accent-blue,#3b82f6);}",
    "." + PREFIX + "-range{flex:1;min-width:110px;accent-color:var(--accent-blue,#3b82f6);}",
    "." + PREFIX + "-rangeval{flex:0 0 46px;text-align:right;font-size:11px;font-variant-numeric:tabular-nums;color:var(--text-secondary,inherit);}",
    "." + PREFIX + "-switch{position:relative;flex:0 0 auto;width:38px;height:22px;border-radius:11px;",
    "border:1px solid var(--border-color,rgba(127,127,127,.35));background:var(--bg-tertiary,rgba(127,127,127,.14));",
    "cursor:pointer;transition:background .15s,border-color .15s;padding:0;}",
    "." + PREFIX + "-switch::after{content:'';position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;",
    "background:var(--bg-primary,#fff);box-shadow:0 1px 3px rgba(0,0,0,.3);transition:transform .15s;}",
    "." + PREFIX + "-switch[data-on='1']{background:var(--accent-blue,#3b82f6);border-color:var(--accent-blue,#3b82f6);}",
    "." + PREFIX + "-switch[data-on='1']::after{transform:translateX(16px);}",
    "." + PREFIX + "-switch:focus-visible{outline:2px solid var(--accent-blue,#3b82f6);outline-offset:2px;}",
    "." + PREFIX + "-btn{display:inline-flex;align-items:center;justify-content:center;gap:5px;height:28px;padding:0 10px;",
    "font-size:12px;line-height:1;cursor:pointer;color:var(--text-secondary,inherit);",
    "border:1px solid var(--border-color,rgba(127,127,127,.35));border-radius:var(--radius-sm,6px);background:transparent;",
    "transition:background .15s,border-color .15s,color .15s;}",
    "." + PREFIX + "-btn:hover{background:var(--bg-hover,rgba(127,127,127,.12));color:var(--text-primary,inherit);}",
    "." + PREFIX + "-btn:focus-visible{outline:2px solid var(--accent-blue,#3b82f6);outline-offset:1px;}",
    "." + PREFIX + "-btn[disabled]{opacity:.5;cursor:not-allowed;}",
    "." + PREFIX + "-btn-sm{height:24px;padding:0 8px;font-size:11px;}",
    "." + PREFIX + "-ghost{border-color:transparent;background:transparent;}",
    "." + PREFIX + "-primary{background:var(--accent-color,#111827);color:var(--on-solid,#fff);border-color:var(--accent-color,#111827);}",
    "." + PREFIX + "-primary:hover{opacity:.9;background:var(--accent-color,#111827);color:var(--on-solid,#fff);}",
    "." + PREFIX + "-foot{display:flex;align-items:center;gap:8px;padding:11px 15px;",
    "border-top:1px solid var(--border-color,rgba(127,127,127,.22));}",
    "." + PREFIX + "-spacer{flex:1;}",

    /* 应用内提示条 */
    "." + PREFIX + "-toastwrap{position:fixed;top:14px;right:14px;z-index:10000;display:flex;flex-direction:column;gap:8px;",
    "pointer-events:none;font-family:var(--font-sans,inherit);}",

    /* 顶栏菜单按钮（待办列表旁的小铃铛） */
    "." + PREFIX + "-menubtn{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;padding:0;",
    "cursor:pointer;background:transparent;border:1px solid transparent;border-radius:var(--radius-sm,6px);",
    "color:var(--text-secondary,inherit);transition:background .15s,color .15s;}",
    "." + PREFIX + "-menubtn:hover{background:var(--bg-hover,rgba(127,127,127,.12));color:var(--text-primary,inherit);}",
    "." + PREFIX + "-menubtn:focus-visible{outline:2px solid var(--accent-blue,#3b82f6);outline-offset:1px;}",
    "." + PREFIX + "-menubtn svg{display:block;}",

    /* 浮层（tooltip 式设置面板） */
    "." + PREFIX + "-pop{position:fixed;z-index:10000;width:min(420px,calc(100vw - 16px));max-height:min(76vh,640px);",
    "display:flex;flex-direction:column;background:var(--bg-primary,#fff);color:var(--text-primary,inherit);",
    "border:1px solid var(--border-color,rgba(127,127,127,.3));border-radius:var(--radius-lg,12px);",
    "box-shadow:0 18px 48px rgba(0,0,0,.28);overflow:hidden;overflow-wrap:break-word;",
    "font-family:var(--font-sans,inherit);animation:" + PREFIX + "-fadein .14s ease-out;}",
    "@keyframes " + PREFIX + "-fadein{from{opacity:0;transform:translateY(-4px)}to{opacity:1;transform:none}}",
    "." + PREFIX + "-pop-head{display:flex;align-items:center;gap:8px;padding:10px 12px;",
    "border-bottom:1px solid var(--border-color,rgba(127,127,127,.22));}",
    "." + PREFIX + "-pop-title{flex:1;font-size:13px;font-weight:700;display:flex;align-items:center;gap:7px;}",
    "." + PREFIX + "-toast{pointer-events:auto;width:300px;max-width:78vw;display:flex;gap:9px;padding:11px 12px;",
    "border-radius:var(--radius-md,8px);background:var(--bg-primary,#fff);color:var(--text-primary,inherit);",
    "border:1px solid var(--border-color,rgba(127,127,127,.3));box-shadow:0 10px 30px rgba(0,0,0,.24);",
    "animation:" + PREFIX + "-slidein .18s ease-out;}",
    "@keyframes " + PREFIX + "-slidein{from{opacity:0;transform:translateX(18px)}to{opacity:1;transform:none}}",
    "." + PREFIX + "-toast-icon{flex:0 0 auto;color:var(--accent-blue,#3b82f6);margin-top:1px;}",
    "." + PREFIX + "-toast-main{flex:1;min-width:0;}",
    "." + PREFIX + "-toast-title{font-size:12px;font-weight:700;margin-bottom:2px;}",
    "." + PREFIX + "-toast-body{font-size:11px;line-height:1.5;color:var(--text-secondary,inherit);",
    "display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden;word-break:break-word;}",
    "." + PREFIX + "-toast-close{flex:0 0 auto;background:transparent;border:none;color:var(--text-tertiary,inherit);",
    "cursor:pointer;padding:0;height:18px;display:inline-flex;align-items:center;}",
    "." + PREFIX + "-toast-close:hover{color:var(--text-primary,inherit);}"
  ].join("");

  var styleEl = null;
  function injectStyle() {
    if (styleEl) return;
    styleEl = document.createElement("style");
    styleEl.setAttribute("data-snow-plugin", "snow-notify-hub");
    styleEl.textContent = CSS;
    document.head.appendChild(styleEl);
  }

  /* ============================ 应用内提示条 ============================ */

  var toastWrap = null;
  function showToast(title, body, seconds) {
    if (!toastWrap || !toastWrap.isConnected) {
      toastWrap = document.createElement("div");
      toastWrap.className = PREFIX + "-toastwrap";
      document.body.appendChild(toastWrap);
    }
    var box = document.createElement("div");
    box.className = PREFIX + "-toast";
    var ic = document.createElement("span");
    ic.className = PREFIX + "-toast-icon";
    ic.appendChild(svgIcon("bell-ring", 16));
    var main = document.createElement("div");
    main.className = PREFIX + "-toast-main";
    var t = document.createElement("div");
    t.className = PREFIX + "-toast-title";
    t.textContent = String(title || "Snow App");
    var b = document.createElement("div");
    b.className = PREFIX + "-toast-body";
    b.textContent = String(body || "");
    main.appendChild(t);
    main.appendChild(b);
    var close = document.createElement("button");
    close.className = PREFIX + "-toast-close";
    close.type = "button";
    close.title = "关闭";
    close.setAttribute("aria-label", "关闭");
    close.appendChild(svgIcon("x", 14));
    var kill = function () { if (box.parentNode) box.parentNode.removeChild(box); };
    close.addEventListener("click", kill);
    box.appendChild(ic);
    box.appendChild(main);
    box.appendChild(close);
    toastWrap.appendChild(box);
    var secs = Math.max(1, Math.min(60, Number(seconds) || 5));
    setTimeout(kill, secs * 1000);
  }

  /* ============================ 触发逻辑 ============================ */

  var streamStartedAt = 0;
  var focusStreamingId = ""; /* 最近一次进入流式的焦点会话 id，用于识别「切会话」产生的假 stream-end */

  /* 后台会话监听状态（数据源：元数据 runtime 域，live 推送） */
  var bg = {
    sub: null,        /* metadata 订阅句柄 */
    starting: false,
    streaming: {},    /* conversationId -> { startedAt, title }：最近一次快照中处于流式的会话 */
    completed: {},    /* conversationId -> true：宿主标记的「非焦点会话已完成未读」集合 */
    titles: {},       /* conversationId -> 会话名（来自运行时快照，用于提示正文） */
    lastNotified: {}  /* conversationId -> 通知时间戳，用于去重 */
  };
  var NOTIFY_DEDUP_MS = 30000; /* 同一会话 30 秒内只提醒一次，覆盖「切回已完成会话」等边界 */

  function inQuietHours() {
    if (!cfg.quietEnabled) return false;
    var now = new Date();
    var cur = now.getHours() * 60 + now.getMinutes();
    var parse = function (s) {
      var m = /^(\d{1,2}):(\d{2})$/.exec(String(s || ""));
      if (!m) return null;
      return (parseInt(m[1], 10) % 24) * 60 + (parseInt(m[2], 10) % 60);
    };
    var a = parse(cfg.quietStart), b = parse(cfg.quietEnd);
    if (a == null || b == null) return false;
    if (a === b) return false;
    if (a < b) return cur >= a && cur < b;
    return cur >= a || cur < b; /* 跨零点 */
  }

  /* 取回复摘要：仅摘要模式使用；当前打开的会话读 DOM（后台会话走 messages 元数据域） */
  function excerptFromLast() {
    var nodes = document.querySelectorAll('[data-snow-anchor="chat.message"]');
    for (var i = nodes.length - 1; i >= 0; i--) {
      if (nodes[i].getAttribute("data-snow-message-role") === "assistant") {
        var txt = (nodes[i].innerText || nodes[i].textContent || "").replace(/\s+/g, " ").trim();
        var max = Math.max(20, Number(cfg.excerptChars) || 120);
        return txt.length > max ? txt.slice(0, max) + "…" : txt;
      }
    }
    return "";
  }

  function focusConversationId() {
    try { return (snow.context && snow.context.conversationId) || ""; } catch (e) { return ""; }
  }

  /* 会话名缓存：来源是运行时快照的 streamingSessions[].title。
     会话结束前一刻它仍在快照里，因此结束事件到达时标题已在手，无需额外声明 conversations 隐私域。 */
  function rememberTitle(convId, title) {
    if (!convId) return;
    var t = title ? String(title).trim() : "";
    if (!t) return;
    bg.titles[convId] = t;
    var keys = Object.keys(bg.titles);
    if (keys.length > 80) delete bg.titles[keys[0]]; /* 简单限长，防止无限增长 */
  }

  function titleOf(convId) {
    return (convId && bg.titles[convId]) || "";
  }

  /* 生成提示正文：会话名（默认）或回复摘要 */
  function buildBody(convId, isBackground, onDone) {
    if (cfg.bodyMode === "excerpt") {
      if (isBackground) fetchBackgroundExcerpt(convId, onDone);
      else onDone(excerptFromLast());
      return;
    }
    onDone(titleOf(convId));
  }

  function onStreamStart(ctx) {
    streamStartedAt = Date.now();
    focusStreamingId = (ctx && ctx.conversationId) || focusConversationId();
    diag("stream-start", { ctxConv: (ctx && ctx.conversationId) || "", focusId: focusStreamingId });
  }

  /* 统一发送入口：音效 + 应用内提示 + 渠道推送 */
  function deliver(title, body) {
    var msg = { title: title, body: body || "（无正文）" };
    diag("deliver", {
      title: title, bodyLen: (body || "").length,
      sound: cfg.soundEnabled, toast: cfg.toastEnabled,
      channels: Object.keys(cfg.channels).filter(function (k) { return cfg.channels[k].enabled; })
    });

    /* 音效 */
    if (cfg.soundEnabled) {
      try { playSound(cfg.soundId, cfg.soundVolume); } catch (e) { log("播放提示音失败", e); }
    }
    /* 应用内提示 */
    if (cfg.toastEnabled) {
      showToast(title, body || "本轮回复已结束", cfg.toastSeconds);
    }
    /* 推送渠道 */
    var sent = 0, failed = 0;
    CHANNELS.forEach(function (ch) {
      var conf = cfg.channels[ch.id];
      if (!conf || !conf.enabled) return;
      sendChannel(ch.id, msg).then(function (r) {
        if (r && r.ok) sent++;
        else { failed++; log("渠道推送失败", ch.id, r && r.error); }
      });
    });
    setTimeout(function () {
      if (sent || failed) log("推送完成", { sent: sent, failed: failed });
    }, 6000);
  }

  /* 同一会话 30 秒内只提醒一次：stream-end 与后台监听可能同时命中同一次结束 */
  function claimNotify(convId) {
    var key = convId || "__focus__";
    var now = Date.now();
    if (bg.lastNotified[key] && now - bg.lastNotified[key] < NOTIFY_DEDUP_MS) return false;
    bg.lastNotified[key] = now;
    return true;
  }

  function passThreshold(durMs, label) {
    var minMs = Math.max(0, Number(cfg.minStreamSeconds) || 0) * 1000;
    if (minMs > 0 && durMs > 0 && durMs < minMs) { log(label + "低于时长门槛，跳过", durMs); return false; }
    if (inQuietHours()) { log("免打扰时段，跳过" + label); return false; }
    return true;
  }

  function onStreamEnd(ctx) {
    var durMs = streamStartedAt ? Date.now() - streamStartedAt : 0;
    streamStartedAt = 0;
    var convId = (ctx && ctx.conversationId) || focusConversationId();
    if (!cfg.enabled) { diag("stream-end", { conv: convId, action: "disabled" }); return; }
    /* 宿主按「当前会话的流式状态」派发该事件：切换到别的会话也会触发一次假 stream-end。
       若结束的会话不是最近进入流式的那个，说明是切换造成，交给后台监听判定。 */
    if (focusStreamingId && convId && convId !== focusStreamingId) {
      diag("stream-end", { conv: convId, focusId: focusStreamingId, action: "ignore-switch" });
      log("忽略会话切换产生的 stream-end", convId);
      return;
    }
    focusStreamingId = "";
    /* 没有对应的 stream-start（durMs 为 0）说明这一轮不是本脚本观察到开始的：
       典型是「切回一个已完成的会话」——宿主按焦点会话的 isStreaming 由 true 变 false 派发，
       属于假结束，不能据此提醒（否则点进通知会再响一次）。 */
    if (!durMs) { diag("stream-end", { conv: convId, action: "no-start" }); return; }
    if (!passThreshold(durMs, "回合")) { diag("stream-end", { conv: convId, durMs: durMs, action: "blocked" }); return; }
    if (!claimNotify(convId)) { diag("stream-end", { conv: convId, action: "dedup" }); return; }
    diag("stream-end", { conv: convId, durMs: durMs, action: "deliver" });
    buildBody(convId, false, function (body) {
      deliver("AI 回复已完成", body);
    });
  }

  /* ============================ 后台会话监听 ============================ */

  function startBackgroundWatch() {
    if (bg.sub || bg.starting) return;
    if (!cfg.backgroundWatch) return;
    if (!snow || !snow.metadata || typeof snow.metadata.subscribe !== "function") {
      log("当前环境不支持元数据订阅，后台会话监听未启用");
      return;
    }
    bg.starting = true;
    try {
      snow.metadata.subscribe("runtime", onRuntimeSnapshot, {})
        .then(function (sub) {
          bg.starting = false;
          bg.sub = sub;
          diag("bg-sub", { ok: true });
          log("后台会话监听已启动");
        })
        .catch(function (e) {
          bg.starting = false;
          diag("bg-sub", { ok: false, err: String((e && e.message) || e) });
          log("订阅 runtime 域失败", e);
        });
    } catch (e) {
      bg.starting = false;
      diag("bg-sub", { ok: false, err: "throw: " + String((e && e.message) || e) });
      log("订阅 runtime 域异常", e);
    }
  }

  function stopBackgroundWatch() {
    if (bg.sub && typeof bg.sub.unsubscribe === "function") {
      try { bg.sub.unsubscribe(); } catch (e) { /* ignore */ }
    }
    bg.sub = null;
    bg.starting = false;
    bg.streaming = {};
    bg.completed = {};
  }

  /* 两个 id 集合是否包含完全相同的键 */
  function sameKeys(a, b) {
    var ka = Object.keys(a), kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    for (var i = 0; i < ka.length; i++) {
      if (!Object.prototype.hasOwnProperty.call(b, ka[i])) return false;
    }
    return true;
  }

  /* runtime 域（live）推送：与当前打开哪个会话无关，用于识别非焦点会话的回合结束 */
  function onRuntimeSnapshot(payload) {
    var rt = payload && payload.domains ? payload.domains.runtime : null;
    if (!rt) return;
    var conv = rt.conversation || {};

    /* 本轮仍在流式的会话（含标题与起点），用于时长门槛与提示文案 */
    var cur = {};
    var list = Array.isArray(rt.streamingSessions) ? rt.streamingSessions : [];
    for (var i = 0; i < list.length; i++) {
      var s = list[i];
      if (!s || !s.conversationId || !s.isStreaming) continue;
      cur[s.conversationId] = {
        startedAt: Number(s.startedAt) || 0,
        title: s.title ? String(s.title) : ""
      };
      rememberTitle(s.conversationId, s.title);
    }

    /* 宿主维护的「非焦点会话已完成未读」集合（实测为数组）。
       宿主只在会话「正常跑完且不是当前打开会话」时加入，取消/中断不会加入，语义精确。 */
    var curCompleted = {};
    var arrCompleted = conv.completedConversationIds;
    if (Array.isArray(arrCompleted)) {
      for (var c = 0; c < arrCompleted.length; c++) curCompleted[String(arrCompleted[c])] = true;
    }

    var prev = bg.streaming;
    var prevCompleted = bg.completed;
    bg.streaming = cur;
    bg.completed = curCompleted;

    /* 仅在集合发生变化时记录，避免流式期间的高频推送刷爆诊断日志 */
    if (!sameKeys(prev, cur) || !sameKeys(prevCompleted, curCompleted)) {
      diag("bg-push", {
        streaming: Object.keys(cur),
        completed: Object.keys(curCompleted),
        prevStreaming: Object.keys(prev),
        prevCompleted: Object.keys(prevCompleted)
      });
    }

    if (!cfg.enabled) return;

    /* 主信号：completedConversationIds 新增（宿主只在「非焦点会话正常完成」时加入）。
       注意只判「新增」——切到该会话时宿主会把它移除，移除不代表新一轮完成。 */
    for (var cid in curCompleted) {
      if (!Object.prototype.hasOwnProperty.call(curCompleted, cid)) continue;
      if (prevCompleted[cid]) continue;
      handleBackgroundEnd(cid, cur[cid] || prev[cid] || {});
    }
    /* 兜底：从流式集合消失的会话（覆盖被取消等 completed 不记录的情况） */
    for (var sid in prev) {
      if (!Object.prototype.hasOwnProperty.call(prev, sid)) continue;
      if (cur[sid]) continue;
      handleBackgroundEnd(sid, prev[sid]);
    }
  }

  function handleBackgroundEnd(convId, info) {
    /* 当前打开的会话由 stream-end 负责，避免重复 */
    var focus = focusConversationId();
    if (convId === focus) { diag("bg-end", { conv: convId, action: "is-focus" }); return; }
    var durMs = info && info.startedAt ? Date.now() - info.startedAt : 0;
    if (!passThreshold(durMs, "后台回合")) { diag("bg-end", { conv: convId, durMs: durMs, action: "blocked" }); return; }
    if (!claimNotify(convId)) { diag("bg-end", { conv: convId, action: "dedup" }); return; }
    diag("bg-end", { conv: convId, durMs: durMs, action: "deliver" });
    /* 完成瞬间会话仍在快照里，把标题补进缓存，保证正文拿得到会话名 */
    if (info && info.title) rememberTitle(convId, info.title);
    buildBody(convId, true, function (body) {
      deliver("AI 回复已完成", body);
    });
  }

  /* 后台会话读不到 DOM，摘要模式改读 messages 元数据域；未声明 / 被拒 / 超时均降级为空 */
  function fetchBackgroundExcerpt(convId, cb) {
    var finish = once(cb);
    if (cfg.bodyMode !== "excerpt") { finish(""); return; }
    if (!snow || !snow.metadata || typeof snow.metadata.get !== "function") { finish(""); return; }
    var timer = setTimeout(function () { finish(""); }, 5000);
    snow.metadata.get("messages", { params: { conversationId: convId } }).then(function (res) {
      clearTimeout(timer);
      var d = res && res.domains ? res.domains.messages : null;
      var items = d && Array.isArray(d.items) ? d.items : null;
      if (!items) { finish(""); return; }
      var max = Math.max(20, Number(cfg.excerptChars) || 120);
      for (var i = items.length - 1; i >= 0; i--) {
        var m = items[i];
        if (!m || m.role !== "assistant") continue;
        var txt = String(m.content || "").replace(/\s+/g, " ").trim();
        if (!txt) continue;
        finish(txt.length > max ? txt.slice(0, max) + "…" : txt);
        return;
      }
      finish("");
    }).catch(function (e) {
      clearTimeout(timer);
      log("读取后台会话摘要失败", e);
      finish("");
    });
  }

  function once(fn) {
    var done = false;
    return function (value) {
      if (done) return;
      done = true;
      fn(value);
    };
  }

  /* ============================ UI 构建工具 ============================ */

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = String(text);
    return n;
  }

  function rowSwitch(labelText, getVal, setVal) {
    var row = el("div", PREFIX + "-row");
    row.appendChild(el("span", "snh-label", labelText));
    var field = el("div", "snh-field");
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
    row.appendChild(el("span", "snh-label", labelText));
    var field = el("div", "snh-field");
    var input = el("input", PREFIX + "-input");
    input.type = "text";
    input.value = value == null ? "" : String(value);
    if (placeholder) input.placeholder = placeholder;
    input.addEventListener("change", function () { onChange(input.value); });
    field.appendChild(input);
    row.appendChild(field);
    return row;
  }

  function rowRange(labelText, value, min, max, step, onChange, unit) {
    var row = el("div", PREFIX + "-row");
    row.appendChild(el("span", "snh-label", labelText));
    var field = el("div", "snh-field");
    var r = el("input", PREFIX + "-range");
    r.type = "range"; r.min = String(min); r.max = String(max); r.step = String(step); r.value = String(value);
    var val = el("span", PREFIX + "-rangeval", Number(value).toFixed(step < 1 ? 2 : 0) + (unit || ""));
    r.addEventListener("input", function () { val.textContent = Number(r.value).toFixed(step < 1 ? 2 : 0) + (unit || ""); });
    r.addEventListener("change", function () { onChange(Number(r.value)); });
    field.appendChild(r);
    field.appendChild(val);
    row.appendChild(field);
    return row;
  }

  function rowSelect(labelText, options, getVal, onChange) {
    var row = el("div", PREFIX + "-row");
    row.appendChild(el("span", "snh-label", labelText));
    var field = el("div", "snh-field");
    var sel = el("select", PREFIX + "-select");
    for (var i = 0; i < options.length; i++) {
      var o = el("option", null, options[i].label);
      o.value = options[i].value;
      if (options[i].value === getVal()) o.selected = true;
      sel.appendChild(o);
    }
    sel.addEventListener("change", function () { onChange(sel.value); });
    field.appendChild(sel);
    row.appendChild(field);
    return row;
  }

  function section(iconName, titleText) {
    var sec = el("div", PREFIX + "-sec");
    var h = el("div", PREFIX + "-sec-title");
    h.appendChild(svgIcon(iconName, 14));
    h.appendChild(el("span", null, titleText));
    sec.appendChild(h);
    return sec;
  }

  function buildChannelCard(ch) {
    var conf = cfg.channels[ch.id];
    var card = el("div", PREFIX + "-ch");
    var head = el("div", PREFIX + "-ch-head");
    var name = el("div", PREFIX + "-ch-name");
    name.appendChild(svgIcon(ch.icon, 14));
    name.appendChild(el("span", null, ch.name));
    var sw = el("button", PREFIX + "-switch");
    sw.type = "button";
    sw.setAttribute("role", "switch");
    sw.setAttribute("data-on", conf.enabled ? "1" : "0");
    sw.setAttribute("aria-checked", conf.enabled ? "true" : "false");
    sw.addEventListener("click", function () {
      var next = sw.getAttribute("data-on") !== "1";
      sw.setAttribute("data-on", next ? "1" : "0");
      sw.setAttribute("aria-checked", next ? "true" : "false");
      conf.enabled = next;
      saveCfg();
    });
    head.appendChild(name);
    head.appendChild(sw);
    card.appendChild(head);

    var body = el("div", PREFIX + "-ch-body");
    /* 主凭据字段 */
    var f1 = el("div", PREFIX + "-ch-field");
    f1.appendChild(el("span", null, ch.hint));
    var in1 = el("input", PREFIX + "-input");
    in1.type = "text";
    in1.value = conf[ch.field] || "";
    in1.placeholder = ch.placeholder || "";
    in1.addEventListener("change", function () { conf[ch.field] = in1.value.trim(); saveCfg(); });
    f1.appendChild(in1);
    body.appendChild(f1);
    /* 额外字段 */
    if (ch.extra) {
      var f2 = el("div", PREFIX + "-ch-field");
      f2.appendChild(el("span", null, "服务器 / 附加"));
      var in2 = el("input", PREFIX + "-input");
      in2.type = "text";
      in2.value = conf[ch.extra.key] || "";
      in2.placeholder = ch.extra.placeholder || "";
      in2.addEventListener("change", function () { conf[ch.extra.key] = in2.value.trim(); saveCfg(); });
      f2.appendChild(in2);
      body.appendChild(f2);
    }
    /* 测试按钮 */
    var f3 = el("div", PREFIX + "-ch-field");
    var test = el("button", PREFIX + "-btn " + PREFIX + "-btn-sm");
    test.type = "button";
    test.appendChild(svgIcon("send", 13));
    test.appendChild(el("span", null, "测试推送"));
    var result = el("span", PREFIX + "-status " + PREFIX + "-muted", "");
    test.addEventListener("click", function () {
      result.className = PREFIX + "-status " + PREFIX + "-muted";
      result.replaceChildren();
      result.appendChild(svgIcon("loader-circle", 12));
      result.appendChild(el("span", null, "发送中…"));
      sendChannel(ch.id, { title: "Snow App 测试", body: "这是一条来自 snow-notify-hub 的测试消息。" })
        .then(function (r) {
          result.replaceChildren();
          if (r && r.ok) {
            result.className = PREFIX + "-status " + PREFIX + "-ok";
            result.appendChild(svgIcon("check", 12));
            result.appendChild(el("span", null, "已发送"));
          } else {
            result.className = PREFIX + "-status " + PREFIX + "-err";
            result.appendChild(svgIcon("circle-alert", 12));
            result.appendChild(el("span", null, "失败：" + (r && r.error ? r.error : "未知")));
          }
        });
    });
    f3.appendChild(test);
    f3.appendChild(result);
    body.appendChild(f3);
    card.appendChild(body);
    return card;
  }

  /* ============================ 设置弹层 ============================ */

  var modalEl = null;

  function closeSettings() {
    if (modalEl && modalEl.parentNode) modalEl.parentNode.removeChild(modalEl);
    modalEl = null;
  }

  /* 设置内容共用：输入栏按钮（浮层）与脚本菜单（弹窗）两个入口渲染同一份 */
  function buildSettingsBody() {
    var body = el("div", PREFIX + "-body");

    /* 总开关与触发规则 */
    var secBasic = section("sliders-horizontal", "触发规则");
    secBasic.appendChild(rowSwitch("启用通知中心", function () { return cfg.enabled; }, function (v) { cfg.enabled = v; saveCfg(); }));
    secBasic.appendChild(rowRange("最短回合时长", cfg.minStreamSeconds, 0, 120, 1, function (v) { cfg.minStreamSeconds = v; saveCfg(); }, " 秒"));
    secBasic.appendChild(el("div", PREFIX + "-hint", "仅当一轮回复耗时达到该秒数才通知；0 表示不限制。"));
    secBasic.appendChild(rowSwitch("免打扰时段", function () { return cfg.quietEnabled; }, function (v) { cfg.quietEnabled = v; saveCfg(); }));
    secBasic.appendChild(rowText("开始时间", cfg.quietStart, "23:00", function (v) { cfg.quietStart = v.trim(); saveCfg(); }));
    secBasic.appendChild(rowText("结束时间", cfg.quietEnd, "07:00", function (v) { cfg.quietEnd = v.trim(); saveCfg(); }));
    secBasic.appendChild(rowSelect("提示正文", [
      { value: "title", label: "会话名" },
      { value: "excerpt", label: "回复摘要" }
    ], function () { return cfg.bodyMode; }, function (v) { cfg.bodyMode = v; saveCfg(); }));
    secBasic.appendChild(el("div", PREFIX + "-hint", "提示条与推送的正文内容：会话名，或该轮回复的文字摘要。"));
    secBasic.appendChild(rowRange("摘要字数", cfg.excerptChars, 20, 500, 10, function (v) { cfg.excerptChars = v; saveCfg(); }, " 字"));
    secBasic.appendChild(el("div", PREFIX + "-hint", "仅「回复摘要」模式生效。"));
    secBasic.appendChild(rowSwitch("后台会话提醒", function () { return cfg.backgroundWatch; }, function (v) {
      cfg.backgroundWatch = v;
      saveCfg();
      if (v) startBackgroundWatch(); else stopBackgroundWatch();
    }));
    secBasic.appendChild(el("div", PREFIX + "-hint", "开启后，切到其他会话时，正在运行的会话回复完成同样会提醒（订阅运行时快照，不受当前打开的会话限制）。"));
    secBasic.appendChild(rowSwitch("诊断日志", function () { return cfg.diag; }, function (v) { cfg.diag = v; saveCfg(); }));
    secBasic.appendChild(el("div", PREFIX + "-hint", "打开后把运行轨迹（事件到达、判断分支、订阅状态）写入本机存储，用于排查「不提醒」问题；排查完请关闭。"));
    body.appendChild(secBasic);

    /* 应用内提示 */
    var secToast = section("monitor", "应用内提示");
    secToast.appendChild(rowSwitch("显示提示条", function () { return cfg.toastEnabled; }, function (v) { cfg.toastEnabled = v; saveCfg(); }));
    secToast.appendChild(rowRange("停留时长", cfg.toastSeconds, 2, 30, 1, function (v) { cfg.toastSeconds = v; saveCfg(); }, " 秒"));
    var testToast = el("div", PREFIX + "-row");
    var tf = el("div", "snh-field");
    var tb = el("button", PREFIX + "-btn " + PREFIX + "-btn-sm");
    tb.type = "button";
    tb.appendChild(svgIcon("bell", 13));
    tb.appendChild(el("span", null, "预览提示条"));
    tb.addEventListener("click", function () { showToast("AI 回复已完成", "这是一条提示条预览。", cfg.toastSeconds); });
    tf.appendChild(tb);
    testToast.appendChild(el("span", "snh-label", "预览"));
    testToast.appendChild(tf);
    secToast.appendChild(testToast);
    secToast.appendChild(el("div", PREFIX + "-hint", "系统级通知（Windows 通知中心）在当前应用版本中不可用，故使用应用内提示条；配色跟随主题。"));
    body.appendChild(secToast);

    /* 提示音 */
    var secSound = section("volume-2", "提示音");
    secSound.appendChild(rowSwitch("启用提示音", function () { return cfg.soundEnabled; }, function (v) { cfg.soundEnabled = v; saveCfg(); }));
    var soundRow = el("div", PREFIX + "-row");
    soundRow.appendChild(el("span", "snh-label", "音效"));
    var sf = el("div", "snh-field");
    var sel = el("select", PREFIX + "-select");
    for (var i = 0; i < SOUNDS.length; i++) {
      var o = el("option", null, SOUNDS[i].name);
      o.value = SOUNDS[i].id;
      if (SOUNDS[i].id === cfg.soundId) o.selected = true;
      sel.appendChild(o);
    }
    sel.addEventListener("change", function () { cfg.soundId = sel.value; saveCfg(); playSound(cfg.soundId, cfg.soundVolume); });
    sf.appendChild(sel);
    soundRow.appendChild(sf);
    secSound.appendChild(soundRow);
    secSound.appendChild(rowRange("音量", cfg.soundVolume, 0, 1, 0.05, function (v) { cfg.soundVolume = v; saveCfg(); }));
    var playRow = el("div", PREFIX + "-row");
    var pf = el("div", "snh-field");
    var pb = el("button", PREFIX + "-btn " + PREFIX + "-btn-sm");
    pb.type = "button";
    pb.appendChild(svgIcon("play", 13));
    pb.appendChild(el("span", null, "试听"));
    pb.addEventListener("click", function () { playSound(cfg.soundId, cfg.soundVolume); });
    pf.appendChild(pb);
    playRow.appendChild(el("span", "snh-label", "试听"));
    playRow.appendChild(pf);
    secSound.appendChild(playRow);
    secSound.appendChild(el("div", PREFIX + "-hint", "共 " + SOUNDS.length + " 种音效，全部由 Web Audio 实时合成，无外部音频文件。"));
    body.appendChild(secSound);

    /* 推送渠道 */
    var secCh = section("send", "推送渠道");
    for (var c = 0; c < CHANNELS.length; c++) secCh.appendChild(buildChannelCard(CHANNELS[c]));
    secCh.appendChild(el("div", PREFIX + "-hint", "凭据仅保存在本机插件存储中，不会上传。HTTP 请求经应用网络栈发出（受系统代理设置影响）。"));
    body.appendChild(secCh);

    return body;
  }

  function buildFooter(onClose) {
    var foot = el("div", PREFIX + "-foot");
    var testAll = el("button", PREFIX + "-btn");
    testAll.type = "button";
    testAll.appendChild(svgIcon("send", 14));
    testAll.appendChild(el("span", null, "测试全部已启用渠道"));
    testAll.addEventListener("click", function () {
      var n = 0;
      CHANNELS.forEach(function (ch) {
        var conf = cfg.channels[ch.id];
        if (conf && conf.enabled) { n++; sendChannel(ch.id, { title: "Snow App 测试", body: "批量测试消息" }); }
      });
      showToast("测试推送", n ? "已向 " + n + " 个渠道发送测试消息" : "没有已启用的渠道", 4);
    });
    var spacer = el("div", PREFIX + "-spacer");
    var done = el("button", PREFIX + "-btn " + PREFIX + "-primary");
    done.type = "button";
    done.appendChild(svgIcon("check", 14));
    done.appendChild(el("span", null, "完成"));
    done.addEventListener("click", onClose);
    foot.appendChild(testAll);
    foot.appendChild(spacer);
    foot.appendChild(done);
    return foot;
  }

  /* 脚本菜单入口：居中弹窗（输入栏按钮不可用时的兜底） */
  function openSettings() {
    injectStyle();
    closeSettings();
    closePopover();
    var mask = el("div", PREFIX + "-mask");
    mask.addEventListener("click", function (e) { if (e.target === mask) closeSettings(); });
    var modal = el("div", PREFIX + "-modal");

    var head = el("div", PREFIX + "-head");
    var ht = el("div", PREFIX + "-head-title");
    ht.appendChild(svgIcon("bell-ring", 16));
    ht.appendChild(el("span", null, "通知推送设置"));
    head.appendChild(ht);
    var closeBtn = el("button", PREFIX + "-btn " + PREFIX + "-ghost");
    closeBtn.type = "button";
    closeBtn.title = "关闭";
    closeBtn.setAttribute("aria-label", "关闭");
    closeBtn.appendChild(svgIcon("x", 16));
    closeBtn.addEventListener("click", closeSettings);
    head.appendChild(closeBtn);

    modal.appendChild(head);
    modal.appendChild(buildSettingsBody());
    modal.appendChild(buildFooter(closeSettings));
    mask.appendChild(modal);
    document.body.appendChild(mask);
    modalEl = mask;
  }

  /* ============================ 顶栏菜单按钮 + 浮层（tooltip 式） ============================ */

  var menuBtn = null;
  var popoverEl = null;
  var popDocListeners = [];
  var slotObserver = null;
  var slotCheckTimer = 0;

  function closePopover() {
    if (popoverEl && popoverEl.parentNode) popoverEl.parentNode.removeChild(popoverEl);
    popoverEl = null;
    for (var i = 0; i < popDocListeners.length; i++) {
      document.removeEventListener(popDocListeners[i].type, popDocListeners[i].fn, true);
    }
    popDocListeners = [];
    if (menuBtn) menuBtn.setAttribute("aria-expanded", "false");
  }

  function openPopover(anchor) {
    injectStyle();
    closePopover();
    closeSettings();
    var panel = el("div", PREFIX + "-pop");
    var head = el("div", PREFIX + "-pop-head");
    var ht = el("div", PREFIX + "-pop-title");
    ht.appendChild(svgIcon("bell-ring", 14));
    ht.appendChild(el("span", null, "通知推送设置"));
    var closeBtn = el("button", PREFIX + "-btn " + PREFIX + "-ghost " + PREFIX + "-btn-sm");
    closeBtn.type = "button";
    closeBtn.title = "关闭";
    closeBtn.setAttribute("aria-label", "关闭");
    closeBtn.appendChild(svgIcon("x", 14));
    closeBtn.addEventListener("click", closePopover);
    head.appendChild(ht);
    head.appendChild(closeBtn);
    panel.appendChild(head);
    panel.appendChild(buildSettingsBody());
    panel.appendChild(buildFooter(closePopover));
    panel.style.left = "-9999px";
    document.body.appendChild(panel);

    /* 定位：优先在按钮下方、右对齐；放不下翻到上方；始终夹在视口内。
       fixed 的包含块可能被宿主祖先的 transform 替换，故宽度用 min() 封顶防塌陷。 */
    var r = anchor.getBoundingClientRect();
    var w = panel.offsetWidth, h = panel.offsetHeight;
    var vw = window.innerWidth, vh = window.innerHeight;
    var left = r.right - w;
    if (left < 8) left = 8;
    if (left + w > vw - 8) left = Math.max(8, vw - 8 - w);
    var top = r.bottom + 8;
    if (top + h > vh - 8) top = r.top - h - 8;
    if (top < 8) top = 8;
    panel.style.left = left + "px";
    panel.style.top = top + "px";
    popoverEl = panel;
    anchor.setAttribute("aria-expanded", "true");

    /* 点击浮层与按钮以外区域、或按 Esc 关闭 */
    function onDoc(e) {
      if (popoverEl && popoverEl.contains(e.target)) return;
      if (anchor && anchor.contains(e.target)) return;
      closePopover();
    }
    document.addEventListener("click", onDoc, true);
    popDocListeners.push({ type: "click", fn: onDoc });
    function onKey(e) { if (e.key === "Escape") closePopover(); }
    document.addEventListener("keydown", onKey, true);
    popDocListeners.push({ type: "keydown", fn: onKey });
  }

  /* 注入菜单按钮：优先放在顶栏「待办列表」按钮旁（小铃铛图标）。
     待办按钮在会话没有待办（sessionId 为空）时由宿主直接不渲染，此时锚点改用标题组
     —— 待办按钮原本就紧跟在标题组之后，两者在顶栏的位置一致。
     设置页、团队页、功能页没有聊天头部，锚点为 null，铃铛收起，回到聊天视图后重挂。 */
  function findTodoButton() {
    var cand = document.querySelector(".top-bar-todo-btn");
    if (cand) return cand;
    cand = document.querySelector('button[aria-label="待办列表"]');
    if (cand) return cand;
    cand = document.querySelector('button[title^="待办列表"]');
    if (cand) return cand;
    return null;
  }

  function findTopBarAnchor() {
    var todoBtn = findTodoButton();
    if (todoBtn) return todoBtn;

    var titleGroup = document.querySelector(".top-bar-main .header-title-group");
    if (!titleGroup) return null;
    /* 非聊天视图：设置页 / 团队页 / 功能页 */
    if (titleGroup.classList.contains("is-settings-page")) return null;
    if (titleGroup.classList.contains("is-team-page")) return null;
    if (document.querySelector(".top-bar-main .feature-page-close-btn")) return null;
    return titleGroup;
  }

  function injectMenuButton() {
    var anchor = findTopBarAnchor();
    var existing = document.querySelector("." + PREFIX + "-menubtn");

    /* 设置页 / 团队页 / 功能页：收起铃铛并关闭浮层；回到聊天视图由观察器重新挂回 */
    if (!anchor) {
      if (existing) {
        closePopover();
        if (existing.parentNode) existing.parentNode.removeChild(existing);
      }
      menuBtn = null;
      return;
    }

    /* 全局只保留一个按钮：已存在则复用；锚点变化（待办按钮出现或消失）时搬迁 */
    if (existing) {
      if (existing.previousElementSibling !== anchor && existing.nextElementSibling !== anchor) {
        if (popoverEl) closePopover();
        anchor.insertAdjacentElement("afterend", existing);
      }
      menuBtn = existing;
      return;
    }

    var btn = el("button", PREFIX + "-menubtn");
    btn.type = "button";
    btn.title = "通知推送设置";
    btn.setAttribute("aria-label", "通知推送设置");
    btn.setAttribute("aria-haspopup", "dialog");
    btn.setAttribute("aria-expanded", "false");
    btn.appendChild(svgIcon("bell", 16));
    btn.addEventListener("click", function (e) {
      e.stopPropagation();
      if (popoverEl) closePopover();
      else openPopover(btn);
    });
    anchor.insertAdjacentElement("afterend", btn);
    menuBtn = btn;
    diag("menubtn", {
      injected: true,
      host: anchor.classList.contains("header-title-group") ? "topbar-title" : "topbar-todo"
    });
  }

  /* 顶栏随视图切换重建（待办按钮出现/消失）：MutationObserver + 250ms 防抖重挂 */
  function watchMenuSlot() {
    if (slotObserver) return;
    slotObserver = new MutationObserver(function () {
      if (slotCheckTimer) return;
      slotCheckTimer = window.setTimeout(function () { slotCheckTimer = 0; injectMenuButton(); }, 250);
    });
    slotObserver.observe(document.body, { childList: true, subtree: true });
  }

  /* ============================ 接线 ============================ */

  function wire() {
    injectStyle();
    injectMenuButton();
    watchMenuSlot();
    bootStamp();
    diag("wire", { ctx: ctxBrief() });
    try {
      snow.on("stream-start", onStreamStart);
      snow.on("stream-end", onStreamEnd);
    } catch (e) { log("事件订阅失败", e); }

    snow.onCleanup(function () {
      stopBackgroundWatch();
      if (slotObserver) { slotObserver.disconnect(); slotObserver = null; }
      if (slotCheckTimer) { window.clearTimeout(slotCheckTimer); slotCheckTimer = 0; }
      closePopover();
      closeSettings();
      var liveBtn = document.querySelector("." + PREFIX + "-menubtn");
      if (liveBtn && liveBtn.parentNode) liveBtn.parentNode.removeChild(liveBtn);
      menuBtn = null;
      if (toastWrap && toastWrap.parentNode) toastWrap.parentNode.removeChild(toastWrap);
      if (styleEl && styleEl.parentNode) styleEl.parentNode.removeChild(styleEl);
    });

    try { GM_registerMenuCommand("通知推送设置", openSettings); } catch (e) { /* ignore */ }

    startBackgroundWatch();

    log("已就绪", {
      enabled: cfg.enabled,
      sound: cfg.soundEnabled,
      toast: cfg.toastEnabled,
      backgroundWatch: cfg.backgroundWatch,
      channels: Object.keys(cfg.channels).filter(function (k) { return cfg.channels[k].enabled; })
    });
  }

  wire();
})();
