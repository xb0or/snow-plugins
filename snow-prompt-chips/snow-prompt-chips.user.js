// ==UserScript==
// @name         便捷提示词
// @name:en      Prompt Chips
// @namespace    kedou
// @version      1.0.2
// @description  在聊天输入框上方显示自定义的便捷提示词，点击即直接发送（可切换为仅填入输入框）；支持增删改与排序、JSON 备份导出导入
// @author       kedou
// @license      MIT
// @icon         lucide:Zap
// @snow-target  client
// @snow-scope   global
// @snow-privacy conversations
// @run-at       document-idle
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_setClipboard
// ==/UserScript==

/*
 * snow-prompt-chips —— Snow App 客户端脚本
 *
 * 作用：把用户自定义的若干条便捷提示词渲染成输入框上方的一行芯片按钮，
 *       点击任一芯片即以该条内容发送消息（或仅填入输入框，可在设置中切换）。
 *
 * 挂载位置（实测，Snow 0.5.8 / 窗口 1164px 输入区）：
 *   div.chat-input-region[data-snow-anchor="chat.input"]
 *     └ div.input-area > div.input-content
 *         ├ div.stream-metrics-bar            （流式运行指标，可能不存在）
 *         ├ div.snow-client-slot[data-snow-slot="chat.input.actions"]  ← 官方可写插槽
 *         └ div.input-box                     （输入框本体）
 *   插槽为 display:flex / flex-wrap:wrap，故条容器用 order:-1 + flex:1 1 auto 排在按钮行首
 *   （与其它插件按钮同行），即位于输入框正上方；不依赖任何内部 class 层级，
 *   插槽内容由宿主在脚本卸载时清理。
 *
 * 发送通道（宿主源码 + 实测）：
 *   snow.write.run("conversations.sendMessage", { conversationId, text })
 *     由宿主内部发送器直接投递到指定会话，不经过输入区，返回 { ok, data: { status } }
 *     （会话忙碌时 status 非 "started"，即已排队）。
 *   输入区若是新会话草稿（snow.context.conversationId 为空）：
 *     conversations.create({ directoryId, title, text, autoReply: true }) 建会话，再 activate 切过去。
 *   注意：snow.client.sendMessage / chatInput.sendMessage 在 Snow 0.5.8 上走的是
 *     「restoreContent 写入输入区 → 同 tick 调 handleSend("queue")」路径，React state 尚未提交，
 *     实测只把文本留在输入框、并未真正发出，故不再作为发送主路径；
 *     仅在上述通道失败时用 client.insertInputText 兜底填入，toast 如实提示「已填入输入框」。
 *
 * 数据：GM_getValue/GM_setValue 持久化，键 spc.prompts（提示词数组）与 spc.config（开关）。
 */

(function () {
  "use strict";

  var TAG = "[snow-prompt-chips]";
  var PREFIX = "spc";
  var LIST_KEY = "spc.prompts";
  var CFG_KEY = "spc.config";

  /* ============================ 配置 ============================ */

  var DEFAULT_CFG = {
    enabled: true,   /* 是否在输入框上方显示提示词条 */
    direct: true     /* true = 点击直接发送；false = 仅填入输入框 */
  };

  var cfg = loadJson(CFG_KEY, DEFAULT_CFG);
  var prompts = loadJson(LIST_KEY, []);

  function loadJson(key, fallback) {
    var raw;
    try {
      raw = GM_getValue(key, "");
    } catch (e) {
      log("读取配置失败：" + e);
      return clone(fallback);
    }
    if (!raw) return clone(fallback);
    try {
      var parsed = JSON.parse(raw);
      if (key === LIST_KEY && !Array.isArray(parsed)) {
        log("提示词数据不是数组，已忽略");
        return clone(fallback);
      }
      return parsed == null ? clone(fallback) : parsed;
    } catch (e) {
      log("配置解析失败（" + key + "）：" + e);
      return clone(fallback);
    }
  }

  function saveJson(key, value) {
    try {
      GM_setValue(key, JSON.stringify(value));
      return true;
    } catch (e) {
      log("保存失败（" + key + "）：" + e);
      return false;
    }
  }

  function clone(v) {
    return JSON.parse(JSON.stringify(v));
  }

  function log() {
    var args = Array.prototype.slice.call(arguments);
    args.unshift(TAG);
    try {
      if (typeof snow !== "undefined" && snow && typeof snow.log === "function") snow.log.apply(null, args);
      else console.log.apply(console, args);
    } catch (e) { /* ignore */ }
  }

  /* 归一化提示词条目：去掉空内容、补齐 id 与字段类型 */
  function normalizePrompts(list) {
    var out = [];
    if (!Array.isArray(list)) return out;
    for (var i = 0; i < list.length; i++) {
      var item = list[i];
      if (!item || typeof item !== "object") continue;
      var text = typeof item.text === "string" ? item.text : "";
      if (!text.trim()) continue;
      out.push({
        id: typeof item.id === "string" && item.id ? item.id : newId(),
        label: typeof item.label === "string" ? item.label : "",
        text: text
      });
    }
    return out;
  }

  function newId() {
    return "p" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  prompts = normalizePrompts(prompts);

  /* 配置字段兜底：旧数据或损坏数据回落到默认值 */
  cfg = (cfg && typeof cfg === "object") ? cfg : {};
  if (typeof cfg.enabled !== "boolean") cfg.enabled = DEFAULT_CFG.enabled;
  if (typeof cfg.direct !== "boolean") cfg.direct = DEFAULT_CFG.direct;

  /* ============================ Lucide 图标 ============================ */
  /* 官方 Lucide SVG 路径（viewBox 0 0 24 24，stroke=currentColor，fill=none）。
     客户端脚本环境没有全局 lucide 对象，故内嵌路径。 */

  var ICONS = {
    zap: '<path d="M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z"/>',
    settings: '<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>',
    x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
    plus: '<path d="M5 12h14"/><path d="M12 5v14"/>',
    trash: '<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" x2="10" y1="11" y2="17"/><line x1="14" x2="14" y1="11" y2="17"/>',
    "arrow-up": '<path d="m5 12 7-7 7 7"/><path d="M12 19V5"/>',
    "arrow-down": '<path d="M12 5v14"/><path d="m19 12-7 7-7-7"/>',
    check: '<path d="M20 6 9 17l-5-5"/>',
    "refresh-cw": '<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/>',
    clipboard: '<rect width="8" height="4" x="8" y="2" rx="1" ry="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/>',
    upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" x2="12" y1="3" y2="15"/>',
    "circle-alert": '<circle cx="12" cy="12" r="10"/><line x1="12" x2="12" y1="8" y2="12"/><line x1="12" x2="12.01" y1="16" y2="16"/>'
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
    el.innerHTML = inner;   /* 固定常量字符串，无外部输入，无注入面 */
    return el;
  }

  /* ============================ 样式（跟随宿主主题变量） ============================ */

  var CSS = [
    /* 输入框上方的提示词条：与其它插件按钮同处插槽行（order:-1 排在行首），不独占整行 */
    "." + PREFIX + "-bar{order:-1;flex:1 1 auto;min-width:0;max-width:100%;display:flex;flex-wrap:wrap;",
    "align-items:center;gap:6px;max-height:56px;overflow-y:auto;overflow-x:hidden;padding:0;}",
    "." + PREFIX + "-lead{display:inline-flex;align-items:center;gap:4px;flex:0 0 auto;",
    "color:var(--text-tertiary,inherit);font-size:11px;line-height:1;user-select:none;}",
    "." + PREFIX + "-chip{flex:0 1 auto;min-width:0;max-width:100%;height:26px;padding:0 10px;",
    "display:inline-flex;align-items:center;gap:5px;border:1px solid var(--border-color,rgba(127,127,127,.35));",
    "border-radius:999px;background:var(--bg-secondary,rgba(127,127,127,.06));color:var(--text-secondary,inherit);",
    "font-family:inherit;font-size:12px;line-height:1;cursor:pointer;white-space:nowrap;overflow:hidden;",
    "text-overflow:ellipsis;transition:background .15s,border-color .15s,color .15s;}",
    "." + PREFIX + "-chip>span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}",
    "." + PREFIX + "-chip:hover{background:var(--bg-hover,rgba(127,127,127,.12));color:var(--text-primary,inherit);",
    "border-color:var(--accent-blue,#3b82f6);}",
    "." + PREFIX + "-chip:focus-visible{outline:2px solid var(--accent-blue,#3b82f6);outline-offset:1px;}",
    "." + PREFIX + "-chip[disabled]{opacity:.45;cursor:not-allowed;}",
    "." + PREFIX + "-hint{flex:1 1 auto;min-width:0;color:var(--text-tertiary,inherit);font-size:11px;",
    "overflow-wrap:anywhere;}",
    "." + PREFIX + "-iconbtn{flex:0 0 auto;display:inline-flex;align-items:center;justify-content:center;",
    "width:26px;height:26px;padding:0;border:1px solid var(--border-color,rgba(127,127,127,.35));",
    "border-radius:var(--radius-sm,6px);background:transparent;color:var(--text-secondary,inherit);",
    "cursor:pointer;transition:background .15s,border-color .15s,color .15s;}",
    "." + PREFIX + "-iconbtn:hover{background:var(--bg-hover,rgba(127,127,127,.12));color:var(--text-primary,inherit);}",
    "." + PREFIX + "-iconbtn:focus-visible{outline:2px solid var(--accent-blue,#3b82f6);outline-offset:1px;}",

    /* 遮罩 + 弹层 */
    "." + PREFIX + "-mask{position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,.42);",
    "display:flex;align-items:center;justify-content:center;padding:16px;}",
    "." + PREFIX + "-modal{width:min(600px,100%);max-height:86vh;display:flex;flex-direction:column;",
    "background:var(--bg-primary,#fff);color:var(--text-primary,inherit);",
    "border:1px solid var(--border-color,rgba(127,127,127,.3));border-radius:var(--radius-lg,12px);",
    "box-shadow:0 18px 48px rgba(0,0,0,.28);overflow:hidden;font-family:var(--font-sans,inherit);}",
    "." + PREFIX + "-head{display:flex;align-items:center;gap:8px;padding:13px 15px;",
    "border-bottom:1px solid var(--border-color,rgba(127,127,127,.22));}",
    "." + PREFIX + "-head-title{flex:1;min-width:0;font-size:14px;font-weight:700;display:flex;align-items:center;gap:7px;}",
    "." + PREFIX + "-body{padding:12px 15px 15px;overflow-y:auto;flex:1;min-height:0;}",
    "." + PREFIX + "-foot{display:flex;align-items:center;gap:8px;padding:11px 15px;",
    "border-top:1px solid var(--border-color,rgba(127,127,127,.22));flex-wrap:wrap;}",
    "." + PREFIX + "-spacer{flex:1;}",
    "." + PREFIX + "-btn{display:inline-flex;align-items:center;justify-content:center;gap:5px;",
    "height:28px;padding:0 10px;border:1px solid var(--border-color,rgba(127,127,127,.35));",
    "border-radius:var(--radius-sm,6px);background:transparent;color:var(--text-secondary,inherit);",
    "cursor:pointer;font-family:inherit;font-size:12px;line-height:1;transition:background .15s,border-color .15s,color .15s;}",
    "." + PREFIX + "-btn:hover{background:var(--bg-hover,rgba(127,127,127,.12));color:var(--text-primary,inherit);}",
    "." + PREFIX + "-btn:focus-visible{outline:2px solid var(--accent-blue,#3b82f6);outline-offset:1px;}",
    "." + PREFIX + "-primary{background:var(--accent-color,#111827);color:var(--on-solid,#fff);border-color:var(--accent-color,#111827);}",
    "." + PREFIX + "-primary:hover{opacity:.9;background:var(--accent-color,#111827);color:var(--on-solid,#fff);}",
    "." + PREFIX + "-danger{border-color:var(--accent-red,#ef4444);color:var(--accent-red,#ef4444);}",
    "." + PREFIX + "-sec{font-size:12px;font-weight:700;color:var(--text-secondary,inherit);margin:2px 0 8px;",
    "display:flex;align-items:center;gap:6px;}",
    "." + PREFIX + "-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:4px 0;}",
    "." + PREFIX + "-row-label{flex:0 0 auto;font-size:12px;color:var(--text-secondary,inherit);}",
    "." + PREFIX + "-switch{position:relative;flex:0 0 auto;width:38px;height:22px;border-radius:11px;",
    "border:1px solid var(--border-color,rgba(127,127,127,.35));background:var(--bg-tertiary,rgba(127,127,127,.14));",
    "cursor:pointer;transition:background .15s,border-color .15s;padding:0;}",
    "." + PREFIX + "-switch::after{content:'';position:absolute;top:2px;left:2px;width:16px;height:16px;",
    "border-radius:50%;background:var(--bg-primary,#fff);box-shadow:0 1px 3px rgba(0,0,0,.3);transition:transform .15s;}",
    "." + PREFIX + "-switch[data-on='1']{background:var(--accent-blue,#3b82f6);border-color:var(--accent-blue,#3b82f6);}",
    "." + PREFIX + "-switch[data-on='1']::after{transform:translateX(16px);}",
    "." + PREFIX + "-switch:focus-visible{outline:2px solid var(--accent-blue,#3b82f6);outline-offset:2px;}",

    /* 提示词编辑列表 */
    "." + PREFIX + "-list{display:flex;flex-direction:column;gap:8px;margin:4px 0 8px;}",
    "." + PREFIX + "-item{border:1px solid var(--border-color,rgba(127,127,127,.28));",
    "border-radius:var(--radius-md,8px);padding:8px;background:var(--bg-secondary,rgba(127,127,127,.04));}",
    "." + PREFIX + "-item[data-pending='1']{border-color:var(--accent-red,#ef4444);}",
    "." + PREFIX + "-item-head{display:flex;align-items:center;gap:6px;flex-wrap:wrap;}",
    "." + PREFIX + "-item-name{flex:1 1 140px;min-width:0;}",
    "." + PREFIX + "-item-acts{display:flex;align-items:center;gap:4px;flex:0 0 auto;}",
    "." + PREFIX + "-input,." + PREFIX + "-area{width:100%;min-width:0;padding:6px 8px;font-size:12px;",
    "font-family:inherit;line-height:1.5;color:var(--text-primary,inherit);",
    "background:var(--bg-primary,#fff);border:1px solid var(--border-color,rgba(127,127,127,.3));",
    "border-radius:var(--radius-sm,6px);color-scheme:light dark;}",
    "." + PREFIX + "-area{margin-top:6px;min-height:56px;resize:vertical;}",
    "." + PREFIX + "-backup{min-height:104px;font-family:var(--font-mono,ui-monospace,SFMono-Regular,Menlo,Consolas,monospace);font-size:11px;}",
    "." + PREFIX + "-btnrow{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-top:6px;}",
    "." + PREFIX + "-input:focus,." + PREFIX + "-area:focus{outline:none;border-color:var(--accent-blue,#3b82f6);}",
    "." + PREFIX + "-empty{font-size:12px;color:var(--text-tertiary,inherit);padding:10px 0;overflow-wrap:anywhere;}",
    "." + PREFIX + "-tip{font-size:11px;line-height:1.7;color:var(--text-tertiary,inherit);margin-top:6px;overflow-wrap:anywhere;}",

    /* 轻提示 */
    "." + PREFIX + "-toast{position:fixed;left:50%;bottom:120px;transform:translateX(-50%);z-index:10000;",
    "max-width:80vw;padding:9px 15px;border-radius:var(--radius-md,8px);font-size:12px;",
    "font-family:var(--font-sans,inherit);background:var(--bg-primary,#fff);color:var(--text-primary,inherit);",
    "border:1px solid var(--border-color,rgba(127,127,127,.3));box-shadow:0 8px 26px rgba(0,0,0,.22);",
    "display:flex;align-items:center;gap:7px;overflow-wrap:anywhere;}",
    "." + PREFIX + "-toast-err{border-color:var(--accent-red,#ef4444);color:var(--accent-red,#ef4444);}",
    "." + PREFIX + "-toast-ok{border-color:var(--accent-green,#22c55e);}"
  ].join("");

  var styleEl = null;
  function injectStyle() {
    if (styleEl && styleEl.isConnected) return;
    styleEl = document.createElement("style");
    styleEl.setAttribute("data-snow-plugin", "snow-prompt-chips");
    styleEl.textContent = CSS;
    document.head.appendChild(styleEl);
  }

  /* ============================ 轻提示 ============================ */

  var toastEl = null;
  var toastTimer = null;

  function toast(message, kind) {
    if (toastEl && toastEl.parentNode) toastEl.parentNode.removeChild(toastEl);
    toastEl = document.createElement("div");
    toastEl.className = PREFIX + "-toast" + (kind === "err" ? " " + PREFIX + "-toast-err"
      : kind === "ok" ? " " + PREFIX + "-toast-ok" : "");
    toastEl.appendChild(svgIcon(kind === "err" ? "circle-alert" : "zap", 14));
    var span = document.createElement("span");
    span.textContent = message;
    toastEl.appendChild(span);
    document.body.appendChild(toastEl);
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      if (toastEl && toastEl.parentNode) toastEl.parentNode.removeChild(toastEl);
      toastEl = null;
      toastTimer = null;
    }, kind === "err" ? 4200 : 2200);
  }

  /* ============================ 发送 ============================ */

  /* 把内容填进输入框（两种模式共用；不依赖发送通道） */
  function fillInput(item) {
    if (snow.client && typeof snow.client.insertInputText === "function") {
      try {
        snow.client.insertInputText(item.text);
        return { ok: true };
      } catch (e) {
        return { ok: false, error: "填入输入框失败：" + e };
      }
    }
    return { ok: false, error: "当前宿主不支持填入输入框" };
  }

  function errText(res) {
    if (!res) return "未知原因";
    if (typeof res.error === "string" && res.error) return res.error;
    if (res.denied) {
      if (typeof res.denied === "string") return res.denied;
      try { return JSON.stringify(res.denied); } catch (e) { return "被宿主拒绝"; }
    }
    return "未知原因";
  }

  /* 写系统剪贴板：优先宿主写动作（免隐私声明），回退 GM_setClipboard */
  function writeClipboard(text) {
    if (snow.write && typeof snow.write.run === "function") {
      snow.write.run("system.writeClipboardText", { text: text }).then(function (res) {
        if (res && res.ok) toast("已复制到剪贴板", "ok");
        else toast("复制失败：" + errText(res), "err");
      }).catch(function (e) {
        toast("复制失败：" + e, "err");
      });
      return;
    }
    if (typeof GM_setClipboard === "function") {
      try {
        GM_setClipboard(text);
        toast("已复制到剪贴板", "ok");
      } catch (e) {
        toast("复制失败：" + e, "err");
      }
      return;
    }
    toast("当前环境不支持写剪贴板，请在上方文本框里手动全选复制", "err");
  }

  /* 直接投递到指定会话：走宿主内部发送通道，不经过输入区；会话忙碌时由宿主排队 */
  function sendToConversation(conversationId, item, cb) {
    snow.write.run("conversations.sendMessage", { conversationId: conversationId, text: item.text })
      .then(function (res) {
        if (res && res.ok) {
          var status = res.data && res.data.status;
          cb(true, "已发送：" + displayName(item) + (status && status !== "started" ? "（已排队）" : ""));
          return;
        }
        var fb = fillInput(item);
        cb(false, "发送失败（" + errText(res) + "）" + (fb.ok ? "，已改为填入输入框" : ""));
      })
      .catch(function (err) {
        var fb = fillInput(item);
        cb(false, "发送异常：" + err + (fb.ok ? "，已改为填入输入框" : ""));
      });
  }

  /* 输入区是新会话草稿（无 conversationId）：新建会话并投递，随后切过去 */
  function sendAsNewConversation(item, cb) {
    var ctx = snow.context || {};
    if (!ctx.projectId) {
      cb(false, "找不到当前项目，无法新建会话发送");
      return;
    }
    snow.write.run("conversations.create", {
      directoryId: ctx.projectId,
      title: displayName(item).slice(0, 40),
      text: item.text,
      autoReply: true
    }).then(function (res) {
      if (!res || !res.ok || !res.data || !res.data.conversationId) {
        cb(false, "新建会话失败：" + errText(res));
        return;
      }
      var cid = res.data.conversationId;
      snow.write.run("conversations.activate", { conversationId: cid }).then(function () {
        cb(true, "已在新会话发送：" + displayName(item));
      }).catch(function () {
        cb(true, "已在新会话发送：" + displayName(item));
      });
    }).catch(function (err) {
      cb(false, "新建会话失败：" + err);
    });
  }

  function displayName(item) {
    if (item.label && item.label.trim()) return item.label.trim();
    var t = item.text.replace(/\s+/g, " ").trim();
    return t.length > 18 ? t.slice(0, 18) + "…" : t;
  }

  function finish(ok, message) {
    toast(message, ok ? "ok" : "err");
  }

  function onChipClick(item) {
    if (!cfg.direct) {
      var r = fillInput(item);
      if (r.ok) toast("已填入输入框：" + displayName(item), "ok");
      else toast(r.error || "填入输入框失败", "err");
      return;
    }

    if (!(snow.write && typeof snow.write.run === "function")) {
      var r2 = fillInput(item);
      if (r2.ok) toast("当前宿主没有直接发送通道，已填入输入框，请手动发送", "err");
      else toast(r2.error || "发送失败", "err");
      return;
    }

    var ctx = snow.context || {};
    if (ctx.conversationId) sendToConversation(ctx.conversationId, item, finish);
    else sendAsNewConversation(item, finish);
  }

  /* ============================ 提示词条 ============================ */

  var bar = null;

  function findSlot() {
    return document.querySelector('[data-snow-slot="chat.input.actions"]');
  }

  function renderBar() {
    var el = document.createElement("div");
    el.className = PREFIX + "-bar";

    if (prompts.length === 0) {
      var lead = document.createElement("span");
      lead.className = PREFIX + "-lead";
      lead.appendChild(svgIcon("zap", 13));
      lead.appendChild(document.createTextNode("便捷提示词"));
      el.appendChild(lead);

      var hint = document.createElement("span");
      hint.className = PREFIX + "-hint";
      hint.textContent = "尚未配置，点右侧按钮添加";
      el.appendChild(hint);
    } else {
      for (var i = 0; i < prompts.length; i++) {
        el.appendChild(buildChip(prompts[i]));
      }
    }

    var gear = document.createElement("button");
    gear.type = "button";
    gear.className = PREFIX + "-iconbtn";
    gear.title = "便捷提示词设置";
    gear.setAttribute("aria-label", "便捷提示词设置");
    gear.appendChild(svgIcon("settings", 15));
    gear.addEventListener("click", openSettings);
    el.appendChild(gear);

    return el;
  }

  function buildChip(item) {
    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = PREFIX + "-chip";
    btn.title = item.text;
    btn.setAttribute("aria-label", (cfg.direct ? "发送：" : "填入输入框：") + item.text);
    var span = document.createElement("span");
    span.textContent = displayName(item);
    btn.appendChild(span);
    btn.addEventListener("click", function () { onChipClick(item); });
    return btn;
  }

  function refreshBar() {
    var slot = findSlot();
    if (!slot) return;
    if (!cfg.enabled) {
      if (bar && bar.parentNode) bar.parentNode.removeChild(bar);
      bar = null;
      return;
    }
    var next = renderBar();
    if (bar && bar.parentNode === slot) slot.replaceChild(next, bar);
    else slot.appendChild(next);
    bar = next;
  }

  function ensureMounted() {
    if (!cfg.enabled) return;
    var slot = findSlot();
    if (!slot) return;
    if (bar && bar.parentNode === slot && bar.isConnected) return;
    refreshBar();
  }

  /* ============================ 设置弹层 ============================ */

  var modalEl = null;
  var draft = null;
  var modalKeyHandler = null;

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = String(text);
    return n;
  }

  function iconBtn(iconName, title, onClick, extraCls) {
    var b = el("button", PREFIX + "-iconbtn" + (extraCls ? " " + extraCls : ""));
    b.type = "button";
    b.title = title;
    b.setAttribute("aria-label", title);
    b.appendChild(svgIcon(iconName, 14));
    if (typeof onClick === "function") b.addEventListener("click", onClick);
    return b;
  }

  function rowSwitch(labelText, getVal, setVal) {
    var row = el("div", PREFIX + "-row");
    row.appendChild(el("span", PREFIX + "-row-label", labelText));
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
    row.appendChild(sw);
    return row;
  }

  function closeSettings() {
    if (modalKeyHandler) {
      document.removeEventListener("keydown", modalKeyHandler, true);
      modalKeyHandler = null;
    }
    if (modalEl && modalEl.parentNode) modalEl.parentNode.removeChild(modalEl);
    modalEl = null;
    draft = null;
  }

  function openSettings() {
    injectStyle();
    closeSettings();
    draft = { enabled: cfg.enabled, direct: cfg.direct, items: clone(prompts) };

    var mask = el("div", PREFIX + "-mask");
    mask.addEventListener("click", function (e) { if (e.target === mask) closeSettings(); });

    var modal = el("div", PREFIX + "-modal");

    var head = el("div", PREFIX + "-head");
    var title = el("div", PREFIX + "-head-title");
    title.appendChild(svgIcon("zap", 16));
    title.appendChild(el("span", null, "便捷提示词设置"));
    head.appendChild(title);
    head.appendChild(iconBtn("x", "关闭", closeSettings));
    modal.appendChild(head);

    var body = el("div", PREFIX + "-body");

    body.appendChild(rowSwitch(
      "点击后直接发送",
      function () { return draft.direct; },
      function (v) { draft.direct = v; }
    ));
    body.appendChild(el("div", PREFIX + "-tip",
      "开启：点击提示词立即作为一条消息发送给当前会话。关闭：只把内容填入输入框，由你自己确认后发送。"));

    body.appendChild(rowSwitch(
      "在输入框上方显示提示词条",
      function () { return draft.enabled; },
      function (v) { draft.enabled = v; }
    ));

    var sec = el("div", PREFIX + "-sec");
    sec.appendChild(el("span", null, "提示词列表"));
    body.appendChild(sec);

    var list = el("div", PREFIX + "-list");
    body.appendChild(list);

    function renderList() {
      while (list.firstChild) list.removeChild(list.firstChild);
      if (draft.items.length === 0) {
        list.appendChild(el("div", PREFIX + "-empty", "还没有提示词，点下方「添加提示词」新建一条。"));
        return;
      }
      for (var i = 0; i < draft.items.length; i++) {
        list.appendChild(buildItem(draft.items[i], i, renderList));
      }
    }

    var addBtn = el("button", PREFIX + "-btn");
    addBtn.type = "button";
    addBtn.appendChild(svgIcon("plus", 14));
    addBtn.appendChild(el("span", null, "添加提示词"));
    addBtn.addEventListener("click", function () {
      draft.items.push({ id: newId(), label: "", text: "" });
      renderList();
      var areas = list.querySelectorAll("." + PREFIX + "-area");
      if (areas.length) areas[areas.length - 1].focus();
    });
    body.appendChild(addBtn);

    renderList();

    /* 备份与恢复：导入只替换草稿，点「保存」才写入脚本存储 */
    var backupTitle = el("div", PREFIX + "-sec");
    backupTitle.appendChild(el("span", null, "备份与恢复"));
    body.appendChild(backupTitle);

    var backupArea = el("textarea", PREFIX + "-area " + PREFIX + "-backup");
    backupArea.value = JSON.stringify(draft.items, null, 2);
    backupArea.spellcheck = false;
    backupArea.setAttribute("aria-label", "提示词 JSON 备份内容");
    body.appendChild(backupArea);

    var backupRow = el("div", PREFIX + "-btnrow");

    var genBtn = el("button", PREFIX + "-btn");
    genBtn.type = "button";
    genBtn.appendChild(svgIcon("refresh-cw", 14));
    genBtn.appendChild(el("span", null, "生成 JSON"));
    genBtn.addEventListener("click", function () {
      backupArea.value = JSON.stringify(draft.items, null, 2);
      toast("已按当前列表生成 JSON");
    });
    backupRow.appendChild(genBtn);

    var copyBtn = el("button", PREFIX + "-btn");
    copyBtn.type = "button";
    copyBtn.appendChild(svgIcon("clipboard", 14));
    copyBtn.appendChild(el("span", null, "复制"));
    copyBtn.addEventListener("click", function () {
      if (!backupArea.value) {
        toast("没有可复制的内容，先点「生成 JSON」", "err");
        return;
      }
      writeClipboard(backupArea.value);
    });
    backupRow.appendChild(copyBtn);

    var importBtn = el("button", PREFIX + "-btn");
    importBtn.type = "button";
    importBtn.appendChild(svgIcon("upload", 14));
    importBtn.appendChild(el("span", null, "导入到草稿"));
    importBtn.addEventListener("click", function () {
      var raw = backupArea.value.trim();
      if (!raw) {
        toast("请先粘贴备份 JSON", "err");
        return;
      }
      var parsed;
      try {
        parsed = JSON.parse(raw);
      } catch (e) {
        toast("JSON 解析失败：" + e, "err");
        return;
      }
      if (!Array.isArray(parsed)) {
        toast("备份格式不对：顶层应为数组", "err");
        return;
      }
      var cleaned = normalizePrompts(parsed);
      if (!cleaned.length) {
        toast("没有解析到有效提示词（每条需要非空 text）", "err");
        return;
      }
      draft.items = cleaned;
      renderList();
      backupArea.value = JSON.stringify(draft.items, null, 2);
      toast("已导入 " + cleaned.length + " 条到草稿，点「保存」生效", "ok");
    });
    backupRow.appendChild(importBtn);
    body.appendChild(backupRow);

    body.appendChild(el("div", PREFIX + "-tip",
      "「生成 JSON」按当前列表输出；「复制」写入系统剪贴板；「导入到草稿」用上方文本替换列表，点「保存」才会写入脚本存储（提示词只存在本机脚本存储里，换机或重装前先复制一份）。"));

    var foot = el("div", PREFIX + "-foot");
    var saveBtn = el("button", PREFIX + "-btn " + PREFIX + "-primary");
    saveBtn.type = "button";
    saveBtn.appendChild(svgIcon("check", 14));
    saveBtn.appendChild(el("span", null, "保存"));
    saveBtn.addEventListener("click", function () {
      var cleaned = normalizePrompts(draft.items);
      var dropped = draft.items.length - cleaned.length;
      if (!saveJson(LIST_KEY, cleaned)) {
        toast("保存失败，请查看控制台日志", "err");
        return;
      }
      cfg.enabled = draft.enabled;
      cfg.direct = draft.direct;
      if (!saveJson(CFG_KEY, cfg)) {
        toast("保存失败，请查看控制台日志", "err");
        return;
      }
      prompts = cleaned;
      refreshBar();
      closeSettings();
      toast("已保存 " + cleaned.length + " 条提示词" + (dropped > 0 ? "（忽略 " + dropped + " 条空内容）" : ""), "ok");
    });
    var cancelBtn = el("button", PREFIX + "-btn");
    cancelBtn.type = "button";
    cancelBtn.textContent = "取消";
    cancelBtn.addEventListener("click", closeSettings);

    foot.appendChild(addBtnSpacer());
    foot.appendChild(cancelBtn);
    foot.appendChild(saveBtn);
    modal.appendChild(body);
    modal.appendChild(foot);

    mask.appendChild(modal);
    document.body.appendChild(mask);
    modalEl = mask;

    modalKeyHandler = function (e) {
      if (e.key === "Escape") closeSettings();
    };
    document.addEventListener("keydown", modalKeyHandler, true);
  }

  function addBtnSpacer() {
    return el("div", PREFIX + "-spacer");
  }

  function buildItem(item, index, rerender) {
    var wrap = el("div", PREFIX + "-item");

    var head = el("div", PREFIX + "-item-head");
    var nameInput = el("input", PREFIX + "-input " + PREFIX + "-item-name");
    nameInput.type = "text";
    nameInput.placeholder = "显示名称（可留空，留空则显示内容前几个字）";
    nameInput.value = item.label || "";
    nameInput.addEventListener("input", function () { item.label = nameInput.value; });
    head.appendChild(nameInput);

    var acts = el("div", PREFIX + "-item-acts");
    acts.appendChild(iconBtn("arrow-up", "上移", function () {
      if (index <= 0) return;
      var moved = draft.items.splice(index, 1)[0];
      draft.items.splice(index - 1, 0, moved);
      rerender();
    }));
    acts.appendChild(iconBtn("arrow-down", "下移", function () {
      if (index >= draft.items.length - 1) return;
      var moved = draft.items.splice(index, 1)[0];
      draft.items.splice(index + 1, 0, moved);
      rerender();
    }));

    var delBtn = iconBtn("trash", "删除", null);
    var delTimer = null;
    delBtn.addEventListener("click", function () {
      if (wrap.getAttribute("data-pending") === "1") {
        if (delTimer) clearTimeout(delTimer);
        delBtn.title = "确认删除该条提示词";
        draft.items.splice(index, 1);
        rerender();
        return;
      }
      wrap.setAttribute("data-pending", "1");
      delBtn.classList.add(PREFIX + "-danger");
      delBtn.title = "再点一次确认删除";
      toast("再点一次「删除」确认移除该条提示词");
      delTimer = setTimeout(function () {
        wrap.removeAttribute("data-pending");
        delBtn.classList.remove(PREFIX + "-danger");
        delBtn.title = "删除";
      }, 3000);
    });
    acts.appendChild(delBtn);
    head.appendChild(acts);
    wrap.appendChild(head);

    var area = el("textarea", PREFIX + "-area");
    area.placeholder = "提示词内容（点击提示词后发送或填入输入框的完整文本）";
    area.value = item.text || "";
    area.addEventListener("input", function () { item.text = area.value; });
    wrap.appendChild(area);

    return wrap;
  }

  /* ============================ 挂载与监听 ============================ */

  var observer = null;
  var pending = null;

  function scheduleMount() {
    if (pending) return;
    pending = setTimeout(function () {
      pending = null;
      ensureMounted();
    }, 120);
  }

  function start() {
    injectStyle();
    ensureMounted();

    observer = new MutationObserver(function () {
      if (!bar || !bar.isConnected) scheduleMount();
    });
    observer.observe(document.body, { childList: true, subtree: true });

    if (typeof snow.on === "function") {
      snow.on("view-enter", scheduleMount);
      snow.on("conversation-change", scheduleMount);
    }

    if (typeof snow.onCleanup === "function") {
      snow.onCleanup(function () {
        if (observer) { observer.disconnect(); observer = null; }
        if (pending) { clearTimeout(pending); pending = null; }
        if (bar && bar.parentNode) bar.parentNode.removeChild(bar);
        bar = null;
        if (styleEl && styleEl.parentNode) styleEl.parentNode.removeChild(styleEl);
        styleEl = null;
        if (toastTimer) { clearTimeout(toastTimer); toastTimer = null; }
        if (toastEl && toastEl.parentNode) toastEl.parentNode.removeChild(toastEl);
        toastEl = null;
        closeSettings();
      });
    }

    log("已启动，提示词 " + prompts.length + " 条，模式 " + (cfg.direct ? "直接发送" : "填入输入框"));
  }

  start();
})();
