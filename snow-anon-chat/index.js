// snow-anon-chat — Snow App 匿名聊天面板（hack.chat 后端）
//
// 数据源与链路（v0.2.0，Libera.Chat IRC -> hack.chat）：
//   服务       : hack.chat（第三方公共匿名聊天）
//   协议实现   : 官方 hackchat-engine 1.1.30（vendor/hackchat-engine.bundle.mjs，浏览器单文件
//                ESM bundle；esbuild 打包 + 三处 Node 依赖 shim：events/ws/node-fetch，
//                并带一行补丁 ws.skipConfigFetch 跳过浏览器分支的相对 config.json 拉取）
//   WS 端点    : wss://hack.chat/chat-ws
//   频道       : pcyokazlrbyb16e6v412ps7u（入口 https://hack.chat/?pcyokazlrbyb16e6v412ps7u，无密码）
//   改名       : engine myUser.changeUsername() -> 服务器 updateUser 确认（myUser.username 自动同步，
//                已真实服务器验证）；非法昵称回 warning
//   断线       : engine 无自动重连，由本适配层退避重连（3s*2^n，上限 5 次）
//
// 本地存储（api.storage，键 snowAnonChat.cfg）：免责声明确认、初始昵称、成员列表开关。
// 不读取任何应用元数据域；不持久化聊天记录（匿名不留痕）。

"use strict";

//__HC_ENGINE_INLINE__

// ------------------------- 常量 -------------------------
const WS_URL = "wss://hack.chat/chat-ws"; // 直连（受宿主 CSP 限制，通常不可用）
const BRIDGE_PORT_DEFAULT = 8799;
const PROXY_PROBE_PORTS = [7897, 7890, 7891, 10809, 10808, 1080, 8118, 8889];
const bridgeUrlFor = (port) => "ws://localhost:" + (Number(port) > 0 ? Number(port) : BRIDGE_PORT_DEFAULT);
const CHANNEL = "pcyokazlrbyb16e6v412ps7u";
const CHANNEL_PASS = ""; // 无密码频道（链接即准入）
const CHANNEL_LABEL = "?SNOW"; // 对外仅显示别名，隐藏真实频道名（入口链接不变）
const SERVICE_LABEL = "hack.chat";
const STORAGE_KEY = "snowAnonChat.cfg";
const MAX_MESSAGES = 500;
const MAX_TEXT_LEN = 2048;
const RECONNECT_MAX = 5;
const NICK_RE = /^[A-Za-z0-9_]{1,24}$/;
const TERM_COLS = 200;
const TERM_ROWS = 50;

// ------------------------- 工具 -------------------------
function randomNick() {
  return "snow_" + Math.random().toString(36).slice(2, 6);
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// 服务器 color 为 6 位 hex（无 #）；非法值回退到昵称哈希色
function userColor(nick, serverColor) {
  if (typeof serverColor === "string" && /^[0-9a-fA-F]{6}$/.test(serverColor)) {
    return "#" + serverColor;
  }
  let h = 0;
  for (let i = 0; i < nick.length; i++) h = (h * 31 + nick.charCodeAt(i)) >>> 0;
  return "hsl(" + (h % 360) + ", 58%, 46%)";
}

// ------------------------- 简易事件器 -------------------------
class Emitter {
  constructor() { this._h = new Map(); }
  on(ev, fn) {
    if (!this._h.has(ev)) this._h.set(ev, new Set());
    this._h.get(ev).add(fn);
    return () => { this._h.get(ev)?.delete(fn); };
  }
  emit(ev, ...args) {
    const set = this._h.get(ev);
    if (set) for (const fn of [...set]) {
      try { fn(...args); } catch (e) { /* 监听器异常不熔断协议层 */ }
    }
  }
}

// ------------------------- hack.chat 客户端（本地桥传输） -------------------------
// 传输：优先连本地桥 ws://localhost:PORT（宿主 CSP 放行），桥用 Node 侧连外网；
//       桥不可用时回退直连 wss://hack.chat（通常被 CSP 拦截，错误信息用于诊断）。
// 生命周期: idle -> connecting -> connected(onlineSet) -> disconnecting -> idle
class HackChatClient extends Emitter {
  constructor(cfg) {
    super();
    this.cfg = cfg || {};
    this.ws = null;
    this.state = "idle";
    this.myNick = "";
    this.myUserid = null;
    this.joined = false;
    this.members = new Map(); // userid -> {nick, color}
    this.viaBridge = false;
    this._userQuit = false;
    this._reconnectAttempt = 0;
    this._reconnectTimer = null;
    this._joinTimer = null;
    this._joinedOnce = false;
  }

  _setState(s) { this.state = s; this.emit("state", s); }

  connect() {
    this._userQuit = false;
    this._reconnectAttempt = 0;
    this._joinedOnce = false;
    this._connectOnce();
  }

  _teardownSocket() {
    if (this.ws) {
      const ws = this.ws;
      ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null;
      try { ws.close(); } catch (e) { /* 忽略 */ }
      this.ws = null;
    }
  }

  // 建立传输：先桥后直连
  _openTransport() {
    const tryUrl = (url, label) => new Promise((resolve, reject) => {
      let ws;
      try {
        ws = new WebSocket(url);
      } catch (e) {
        reject(new Error(label + " construct: " + String(e && e.message || e)));
        return;
      }
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try { ws.close(); } catch (e) { /* 忽略 */ }
        reject(new Error(label + " timeout"));
      }, 8000);
      ws.onopen = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(ws);
      };
      ws.onerror = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new Error(label + " unreachable"));
      };
      ws.onclose = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new Error(label + " closed"));
      };
    });

    return tryUrl(bridgeUrlFor(this.cfg && this.cfg.bridgePort), "bridge").then((ws) => {
      this.viaBridge = true;
      try { ws.send(JSON.stringify({ t: "hello", proxy: String((this.cfg && this.cfg.proxyUrl) || "").trim() })); } catch (e) { /* 忽略 */ }
      return ws;
    }).catch((bridgeErr) => tryUrl(WS_URL, "direct").then((ws) => {
      this.viaBridge = false;
      return ws;
    }).catch((directErr) => {
      throw new Error(bridgeErr.message + " / " + directErr.message);
    }));
  }

  _connectOnce() {
    this._teardownSocket();
    clearTimeout(this._joinTimer);
    this.joined = false;
    this.members.clear();
    this._setState("connecting");
    // 昵称解析：用户设定 > 已持久化的生成昵称 > 新生成（生成后通过 nickAssigned 让 UI 持久化）
    let nick;
    if (this.cfg.nick && NICK_RE.test(this.cfg.nick)) {
      nick = this.cfg.nick;
    } else if (this.cfg.generatedNick && NICK_RE.test(this.cfg.generatedNick)) {
      nick = this.cfg.generatedNick;
    } else {
      nick = randomNick();
      this.emit("nickAssigned", { nick, generated: true });
    }
    this.myNick = nick;
    this._nickRetry = 0;
    let regSent = false;
    const sendJoin = () => {
      if (!this.ws) return;
      try { this.ws.send(JSON.stringify({ cmd: "join", nick: this.myNick, channel: CHANNEL })); } catch (e) { /* 忽略 */ }
    };
    this._sendJoin = sendJoin;

    this._openTransport().then((ws) => {
      if (this._userQuit) { try { ws.close(); } catch (e) { /* 忽略 */ } return; }
      this.ws = ws;
      this.emit("transport", { viaBridge: this.viaBridge });
      regSent = false;
      const doJoin = () => {
        if (regSent || !this.ws) return;
        regSent = true;
        sendJoin();
      };

      ws.onmessage = (ev) => {
        const raw = typeof ev.data === "string" ? ev.data : String(ev.data || "");
        let j = null;
        try { j = JSON.parse(raw); } catch (e) { return; }
        if (!j || typeof j !== "object") return;
        // 桥控制帧
        if (j.t === "upstream-open") { doJoin(); return; }
        if (j.t === "upstream-error") { this.emit("upstreamError", { error: String(j.error || "upstream error") }); return; }
        if (j.t === "upstream-close") { this.joined = false; return; }
        if (typeof j.t === "string") return;
        // 直连模式下没有桥控制帧：收到 session 即代表链路可用，此时补发 join
        if (typeof j.cmd === "string") {
          if (j.cmd === "session" && !this.viaBridge) doJoin();
          this._handleEvent(j, doJoin);
        }
      };
      ws.onerror = () => { /* 关闭走 onclose */ };
      ws.onclose = () => {
        clearTimeout(this._joinTimer);
        this.joined = false;
        if (this._userQuit) { this._setState("idle"); this.emit("wsClosed"); return; }
        this.emit("wsClosedUnexpect");
        this._scheduleReconnect();
      };

      // join 看门狗
      this._joinTimer = setTimeout(() => {
        if (!this.joined) {
          this.emit("wsError", { error: "join timeout (" + (this.viaBridge ? "bridge" : "direct") + ")" });
          try { ws.close(); } catch (e) { /* 忽略 */ }
        }
      }, 20000);
    }).catch((err) => {
      this.emit("wsError", { error: String(err && err.message || err) });
      this._scheduleReconnect();
    });
  }

  _scheduleReconnect() {
    if (this._userQuit) return;
    if (this._reconnectAttempt >= RECONNECT_MAX) {
      this._setState("error");
      this.emit("reconnectGiveup");
      return;
    }
    this._reconnectAttempt += 1;
    const delay = 2000 * Math.pow(2, this._reconnectAttempt - 1);
    this._setState("reconnecting");
    this.emit("reconnectAttempt", { n: this._reconnectAttempt, max: RECONNECT_MAX });
    clearTimeout(this._reconnectTimer);
    this._reconnectTimer = setTimeout(() => { this._connectOnce(); }, delay);
  }

  // hack.chat 事件（与官方协议一致）
  _handleEvent(j, sendJoin) {
    switch (j.cmd) {
      case "session": {
        if (typeof j.userid !== "undefined") this.myUserid = j.userid;
        if (typeof j.nick === "string" && j.nick) this.myNick = j.nick;
        // 重连后服务器可能恢复频道；未恢复则 1.5s 后重新 join 兜底
        if (this._joinedOnce && !this.joined) {
          setTimeout(() => { if (!this.joined && !this._userQuit) sendJoin(); }, 1500);
        }
        return;
      }
      case "onlineSet": {
        if (j.channel !== CHANNEL) return;
        clearTimeout(this._joinTimer);
        this.members.clear();
        for (const u of j.users || []) {
          if (u && typeof u.nick === "string" && u.nick) {
            this.members.set(u.userid, { nick: u.nick, color: u.color || "" });
            if (u.isme) { this.myUserid = u.userid; this.myNick = u.nick; }
          }
        }
        if (!this.joined) {
          this.joined = true;
          this._joinedOnce = true;
          this._reconnectAttempt = 0;
          this._setState("connected");
          this.emit("joined", { count: this.members.size });
        }
        return;
      }
      case "chat": {
        if (j.channel !== CHANNEL) return;
        this.emit("message", {
          nick: j.nick || "?",
          text: String(j.text || ""),
          color: j.color || "",
          self: this.myUserid != null && j.userid === this.myUserid,
        });
        return;
      }
      case "emote": {
        if (j.channel !== CHANNEL) return;
        let text = String(j.text || "");
        const prefix = "@" + (j.nick || "") + " ";
        if (j.nick && text.startsWith(prefix)) text = text.slice(prefix.length);
        this.emit("message", {
          nick: j.nick || "?",
          text,
          color: j.color || "",
          self: this.myUserid != null && j.userid === this.myUserid,
          isAction: true,
        });
        return;
      }
      case "onlineAdd": {
        if (j.channel !== CHANNEL || !j.nick) return;
        this.members.set(j.userid, { nick: j.nick, color: j.color || "" });
        if (this.myUserid != null && j.userid === this.myUserid) {
          if (j.nick !== this.myNick) { this.myNick = j.nick; this.emit("youNickChanged", { nick: j.nick }); }
        } else {
          this.emit("userJoined", { nick: j.nick });
        }
        return;
      }
      case "onlineRemove": {
        this.members.delete(j.userid);
        if (this.myUserid == null || j.userid !== this.myUserid) this.emit("userLeft", { nick: j.nick || "" });
        return;
      }
      case "updateUser": {
        if (!j.nick) return;
        if (this.myUserid != null && j.userid === this.myUserid) {
          if (j.nick !== this.myNick) { this.myNick = j.nick; this.emit("youNickChanged", { nick: j.nick }); }
        }
        if (this.members.has(j.userid)) {
          this.members.set(j.userid, { nick: j.nick, color: j.color || "" });
          this.emit("membersChanged");
        }
        return;
      }
      case "info": {
        if (j.channel && j.channel !== CHANNEL) return;
        this.emit("info", { text: String(j.text || "") });
        return;
      }
      case "warn": {
        // 昵称占用（id=33, args.channel）：自动加后缀重试，避免重连时名字反复变化
        if (j.id === 33 && !this.joined) {
          const retry = (this._nickRetry || 0) + 1;
          this._nickRetry = retry;
          if (retry <= 8) {
            // 剥离上一次加的数字后缀，保证是 base_1 / base_2 而不是 base_1_2
            const base = this.myNick.replace(/_\d+$/, "").replace(/_+$/, "").slice(0, 20) || "snow";
            this.myNick = (base + "_" + retry).slice(0, 24);
            this.emit("nickAssigned", { nick: this.myNick, generated: true });
            if (this._sendJoin) this._sendJoin();
            return;
          }
        }
        if (j.channel && j.channel !== CHANNEL) return;
        this.emit("warn", { text: String(j.text || "") });
        return;
      }
      case "captcha": {
        this.emit("warn", { text: "captcha required; open https://hack.chat in a browser to verify" });
        return;
      }
      default:
        return;
    }
  }

  // ---- 对外动作 ----
  say(text) {
    if (!this.ws || !this.joined) return true;
    const t = text.slice(0, MAX_TEXT_LEN);
    try { this.ws.send(JSON.stringify({ cmd: "chat", channel: CHANNEL, text: t })); } catch (e) { /* 忽略 */ }
    return t !== text;
  }

  action(text) {
    if (!this.ws || !this.joined) return true;
    const t = text.slice(0, MAX_TEXT_LEN);
    try { this.ws.send(JSON.stringify({ cmd: "emote", channel: CHANNEL, text: t })); } catch (e) { /* 忽略 */ }
    return t !== text;
  }

  rename(newNick) {
    if (!NICK_RE.test(newNick)) return "invalid";
    if (newNick === this.myNick) return "same";
    if (!this.joined || !this.ws) return "not-connected";
    try { this.ws.send(JSON.stringify({ cmd: "changenick", nick: newNick, channel: CHANNEL })); } catch (e) { return "not-connected"; }
    return "pending";
  }

  quit() {
    this._userQuit = true;
    clearTimeout(this._reconnectTimer);
    clearTimeout(this._joinTimer);
    this._setState("disconnecting");
    try {
      if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify({ cmd: "leave", channel: CHANNEL }));
    } catch (e) { /* 忽略 */ }
    const ws = this.ws;
    setTimeout(() => { try { ws && ws.close(); } catch (e) { /* 忽略 */ } }, 400);
  }
}
export { HackChatClient, NICK_RE, userColor, escapeRegExp };

// ------------------------- React UI -------------------------
const { React } = window.SnowAppPlugin;
const h = React.createElement;
const { useState, useEffect, useRef, useCallback } = React;

function iconEl(name, size) {
  const C = window.SnowAppPlugin.icons && window.SnowAppPlugin.icons[name];
  if (!C) return null;
  return h(C, { size: size || 14 });
}

function fmtTime(ts) {
  const d = new Date(ts);
  return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
}

const DEFAULT_CFG = {
  agreed: false,
  nick: "",
  generatedNick: "", // 首次自动生成的昵称，持久化后重连复用，避免每次换名
  membersOpen: true,
  autoConnect: false, // 打开面板自动连接
  bridgePort: "", // 空 = 默认 8799
  proxyUrl: "", // 空 = 自动检测；none = 直连
};

// ---- 免责声明浮层 ----
function DisclaimerGate({ api, onAccept, onDecline }) {
  const [checked, setChecked] = useState(false);
  const t = (k, dv) => api.t(k, { defaultValue: dv });
  return h("div", { className: "sacx-overlay" },
    h("div", { className: "sacx-modal" },
      h("h3", null, iconEl("ShieldAlert", 16), t("disclaimer.title", "免责声明")),
      h("div", { className: "sacx-modal-body" },
        h("p", null, t("disclaimer.intro", "")),
        h("ul", null,
          h("li", null, t("disclaimer.item1", "")),
          h("li", null, t("disclaimer.item2", "")),
          h("li", null, t("disclaimer.item3", "")),
          h("li", null, t("disclaimer.item4", "")),
          h("li", null, t("disclaimer.item5", ""))),
        h("label", { className: "sacx-check-row" },
          h("input", { type: "checkbox", checked, onChange: (e) => setChecked(e.target.checked) }),
          h("span", null, t("disclaimer.agree", "")))),
      h("div", { className: "sacx-modal-actions" },
        h("button", { className: "sacx-btn", onClick: onDecline }, t("disclaimer.decline", "")),
        h("button", {
          className: "sacx-btn sacx-btn-primary",
          disabled: !checked,
          onClick: onAccept,
        }, t("disclaimer.accept", "")))));
}

// ---- 设置浮层 ----
function SettingsModal({ api, cfg, connected, onSave, onClose, onDisconnect, onReconnect, onViewDisclaimer, onResetNick }) {
  const [nick, setNick] = useState(cfg.nick || "");
  const [bridgePort, setBridgePort] = useState(String(cfg.bridgePort || ""));
  const [proxyUrl, setProxyUrl] = useState(cfg.proxyUrl || "");
  const [autoConnect, setAutoConnect] = useState(!!cfg.autoConnect);
  const [saved, setSaved] = useState(false);
  const [err, setErr] = useState("");
  const t = (k, dv, values) => api.t(k, { defaultValue: dv, values });
  const save = () => {
    const p = parseInt(bridgePort, 10);
    if (bridgePort.trim() !== "" && (!Number.isFinite(p) || p < 1024 || p > 65535)) {
      setErr(t("settings.portInvalid", ""));
      return;
    }
    const pu = proxyUrl.trim();
    if (pu !== "" && !/^https?:\/\/.+:/.test(pu)) {
      setErr(t("settings.proxyInvalid", ""));
      return;
    }
    setErr("");
    onSave({ nick: nick.trim(), bridgePort: bridgePort.trim() === "" ? "" : p, proxyUrl: pu, autoConnect });
    setSaved(true);
    setTimeout(() => setSaved(false), 2500);
  };
  return h("div", { className: "sacx-overlay", onClick: (e) => { if (e.target === e.currentTarget) onClose(); } },
    h("div", { className: "sacx-modal" },
      h("h3", null, iconEl("Settings2", 16), t("settings.title", "设置")),
      h("div", { className: "sacx-modal-body" },
        h("div", { className: "sacx-section" },
          h("label", { className: "sacx-field-label" }, t("settings.nick", "固定昵称")),
          h("input", { value: nick, onChange: (e) => setNick(e.target.value), placeholder: "snow_XXXX", maxLength: 24 }),
          h("div", { className: "sacx-field-help" }, t("settings.nickHelp", "")),
          !cfg.nick && cfg.generatedNick
            ? h("div", { className: "sacx-field-help" },
                t("settings.generatedNick", "", { nick: cfg.generatedNick }),
                h("button", {
                  className: "sacx-btn",
                  style: { marginLeft: 8, padding: "2px 10px", fontSize: 11 },
                  onClick: onResetNick,
                }, t("settings.resetNick", "")))
            : null),
        h("div", { className: "sacx-section" },
          h("label", { className: "sacx-field-label" }, t("settings.sectionConnection", "连接")),
          h("label", { className: "sacx-check-row" },
            h("input", { type: "checkbox", checked: autoConnect, onChange: (e) => setAutoConnect(e.target.checked) }),
            h("span", null, t("settings.autoConnect", ""))),
          h("div", { className: "sacx-field" },
            h("label", { className: "sacx-field-label" }, t("settings.bridgePort", "")),
            h("input", { value: bridgePort, onChange: (e) => setBridgePort(e.target.value), placeholder: "8799", inputMode: "numeric" }),
            h("div", { className: "sacx-field-help" }, t("settings.bridgePortHelp", ""))),
          h("div", { className: "sacx-field" },
            h("label", { className: "sacx-field-label" }, t("settings.proxyUrl", "")),
            h("input", { value: proxyUrl, onChange: (e) => setProxyUrl(e.target.value), placeholder: "http://127.0.0.1:7897", spellCheck: false }),
            h("div", { className: "sacx-field-help" }, t("settings.proxyUrlHelp", "")))),
        h("div", { className: "sacx-section" },
          connected
            ? h("button", { className: "sacx-btn sacx-btn-danger", onClick: onDisconnect }, t("settings.disconnect", "断开"))
            : h("button", { className: "sacx-btn", onClick: onReconnect }, t("settings.reconnect", "重连"))),
        h("div", { className: "sacx-section" },
          h("button", { className: "sacx-btn", onClick: onViewDisclaimer }, t("settings.viewDisclaimer", "查看免责声明")))),
      err ? h("div", { className: "sacx-rename-error" }, err) : null,
      h("div", { className: "sacx-modal-actions" },
        saved ? h("span", { style: { alignSelf: "center", fontSize: 11, opacity: 0.7 } }, t("settings.saved", "")) : null,
        h("button", { className: "sacx-btn", onClick: onClose }, t("rename.cancel", "取消")),
        h("button", { className: "sacx-btn sacx-btn-primary", onClick: save }, t("settings.save", "保存")))));
}

// ---- 改名浮层 ----
function RenamePopover({ api, current, onApply, onClose }) {
  const [val, setVal] = useState(current || "");
  const [err, setErr] = useState("");
  const t = (k, dv, values) => api.t(k, { defaultValue: dv, values });
  const apply = () => {
    const r = onApply(val.trim());
    if (r === "pending") { onClose(); return; }
    if (r === "invalid") setErr(t("sys.nickInvalid", "", { nick: val.trim() || "-" }));
    else if (r === "same") setErr(t("sys.renameSame", ""));
    else if (r === "not-connected") setErr(t("sys.renameNotConnected", ""));
    else setErr(String(r));
  };
  return h("div", { className: "sacx-rename-popover" },
    h("div", { className: "sacx-field-label" }, t("rename.title", "修改昵称")),
    h("input", {
      value: val,
      onChange: (e) => { setVal(e.target.value); setErr(""); },
      onKeyDown: (e) => { if (e.key === "Enter") apply(); if (e.key === "Escape") onClose(); },
      maxLength: 24,
      autoFocus: true,
      placeholder: "snow_XXXX",
      spellCheck: false,
    }),
    h("div", { className: "sacx-rename-error" }, err),
    h("div", { className: "sacx-modal-actions" },
      h("button", { className: "sacx-btn", onClick: onClose }, t("rename.cancel", "取消")),
      h("button", { className: "sacx-btn sacx-btn-primary", onClick: apply }, t("rename.apply", "应用"))));
}

// ---- 主面板 ----
export default function Panel({ api }) {
  const [cfg, setCfg] = useState(DEFAULT_CFG);
  const [cfgLoaded, setCfgLoaded] = useState(false);
  const [showDisclaimer, setShowDisclaimer] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showRename, setShowRename] = useState(false);
  const [status, setStatus] = useState("idle");
  const [messages, setMessages] = useState([]);
  const [members, setMembers] = useState([]);
  const [myNick, setMyNick] = useState("");
  const [input, setInput] = useState("");
  const [bridgeBusy, setBridgeBusy] = useState(false);
  const clientRef = useRef(null);
  const cfgRef = useRef(DEFAULT_CFG);
  const listRef = useRef(null);
  const nearBottomRef = useRef(true);
  const msgIdRef = useRef(0);

  const t = useCallback((k, dv, values) => api.t(k, { defaultValue: dv, values }), [api]);

  const appendMsg = useCallback((msg) => {
    setMessages((prev) => {
      const next = prev.concat(Object.assign({ id: ++msgIdRef.current, ts: Date.now() }, msg));
      return next.length > MAX_MESSAGES ? next.slice(next.length - MAX_MESSAGES) : next;
    });
  }, []);

  const sysMsg = useCallback((i18nKey, params, kind) => {
    appendMsg({ kind: kind || "system", i18nKey, params: params || {} });
  }, [appendMsg]);

  // ---- 初始化：读配置 + 建 client + 绑事件 ----
  useEffect(() => {
    let disposed = false;
    const offs = [];
    (async () => {
      let saved = null;
      try { saved = await api.storage.getJson(STORAGE_KEY); } catch (e) { saved = null; }
      const merged = Object.assign({}, DEFAULT_CFG, saved || {});
      cfgRef.current = merged;
      if (!disposed) { setCfg(merged); setCfgLoaded(true); }
    })();

    const client = new HackChatClient(cfgRef.current);
    clientRef.current = client;

    offs.push(client.on("state", (s) => setStatus(s)));

    offs.push(client.on("joined", ({ count }) => {
      setMyNick(client.myNick);
      sysMsg("sys.joined", { count });
      setMembers(snapshotMembers(client));
    }));
    offs.push(client.on("youNickChanged", ({ nick }) => {
      setMyNick(nick);
      sysMsg("sys.youNickChanged", { nick });
      setMembers(snapshotMembers(client));
    }));

    offs.push(client.on("message", (m) => appendMsg({
      kind: "msg", nick: m.nick, text: m.text, self: m.self,
      color: m.color, isAction: !!m.isAction,
    })));

    offs.push(client.on("info", ({ text }) => appendMsg({ kind: "system", rawText: text })));
    offs.push(client.on("warn", ({ text }) => appendMsg({ kind: "error", rawText: text })));

    // 系统事件 -> i18n 消息；成员变化事件刷新快照
    const sysKeys = {
      userJoined: "sys.userJoined", userLeft: "sys.userLeft",
      wsClosed: "sys.wsClosed", wsClosedUnexpect: "sys.wsClosedUnexpect",
      reconnectAttempt: "sys.reconnectAttempt", reconnectGiveup: "sys.reconnectGiveup",
    };
    for (const evName of Object.keys(sysKeys)) {
      offs.push(client.on(evName, (params) => {
        appendMsg({ kind: "system", i18nKey: sysKeys[evName], params: params || {} });
        if (evName === "userJoined" || evName === "userLeft") setMembers(snapshotMembers(client));
      }));
    }
    // WS 错误：传输层失败（桥/直连连不上）
    offs.push(client.on("wsError", ({ error }) => {
      appendMsg({ kind: "error", i18nKey: "sys.wsError", params: { error } });
    }));
    // 上游错误：桥到 hack.chat 连不上（通常是代理问题）
    offs.push(client.on("upstreamError", ({ error }) => {
      appendMsg({ kind: "error", i18nKey: "sys.upstreamError", params: { error } });
      if (!String(cfgRef.current.proxyUrl || "").trim()) {
        sysMsg("sys.proxyHint", {}, "system");
      }
    }));
    // 其他用户改名（updateUser）时刷新成员列表
    offs.push(client.on("membersChanged", () => setMembers(snapshotMembers(client))));
    // 传输通道提示（桥 / 直连）
    offs.push(client.on("transport", ({ viaBridge }) => {
      if (!viaBridge) sysMsg("sys.viaDirect", {}, "system");
    }));
    // 生成昵称后持久化，重连复用同一昵称（不再每次随机）
    offs.push(client.on("nickAssigned", ({ nick, generated }) => {
      if (!generated) return;
      const next = Object.assign({}, cfgRef.current, { generatedNick: nick });
      cfgRef.current = next;
      setCfg(next);
      if (clientRef.current) clientRef.current.cfg = next;
      api.storage.setJson(STORAGE_KEY, next).catch(() => {});
    }));

    return () => {
      disposed = true;
      for (const off of offs) { try { off(); } catch (e) { /* 忽略 */ } }
      try { client.quit(); } catch (e) { /* 忽略 */ }
    };
  }, [api, appendMsg, sysMsg]);

  // 自动滚动：贴底时跟随
  useEffect(() => {
    if (nearBottomRef.current && listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight;
    }
  }, [messages]);

  const onListScroll = useCallback(() => {
    const el = listRef.current;
    if (!el) return;
    nearBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
  }, []);

  // ---- 动作 ----
  const doConnect = useCallback(() => {
    const client = clientRef.current;
    if (client) client.connect();
  }, []);

  // ---- 代理探测：遍历常见本地代理端口，CSP 放行 http://localhost:* ----
  const detectLocalProxy = useCallback(async () => {
    for (const port of PROXY_PROBE_PORTS) {
      const ok = await new Promise((resolve) => {
        const ctrl = new AbortController();
        const timer = setTimeout(() => { ctrl.abort(); resolve(false); }, 1500);
        fetch("http://localhost:" + port + "/", { signal: ctrl.signal })
          .then(() => { clearTimeout(timer); resolve(true); })
          .catch(() => { clearTimeout(timer); resolve(false); });
      });
      if (ok) return "http://127.0.0.1:" + port;
    }
    return "";
  }, []);

  // ---- 启动本地桥：优先已在跑，否则 terminal 写动作拉起 ----
  // 桥路径从 api.installPath 动态取（安装目录），命令全平台兼容 node "<完整路径>"
  // 代理经 hello 握手下发（见 _openTransport），CLI 不传 --proxy（默认直连兜底）
  const startBridge = useCallback(async () => {
    const cfgNow = cfgRef.current;
    const port = Number(cfgNow.bridgePort) > 0 ? Number(cfgNow.bridgePort) : BRIDGE_PORT_DEFAULT;
    const url = bridgeUrlFor(port);
    const probe = (u, timeout) => new Promise((resolve) => {
      let ws;
      try { ws = new WebSocket(u); } catch (e) { resolve(false); return; }
      const timer = setTimeout(() => { try { ws.close(); } catch (e) { /* 忽略 */ } resolve(false); }, timeout || 3000);
      ws.onopen = () => { clearTimeout(timer); try { ws.close(); } catch (e) { /* 忽略 */ } resolve(true); };
      ws.onerror = () => { clearTimeout(timer); resolve(false); };
      ws.onclose = () => { clearTimeout(timer); resolve(false); };
    });

    // 1) 桥已在跑：直接连
    if (await probe(url)) { sysMsg("sys.bridgeRunning", {}, "system"); doConnect(); return; }

    // 2) 代理探测（仅未配置时）
    if (!String(cfgNow.proxyUrl || "").trim()) {
      const detected = await detectLocalProxy();
      if (detected) {
        const next = Object.assign({}, cfgRef.current, { proxyUrl: detected });
        cfgRef.current = next;
        setCfg(next);
        if (clientRef.current) clientRef.current.cfg = next;
        api.storage.setJson(STORAGE_KEY, next).catch(() => {});
        sysMsg("sys.proxyDetected", { proxy: detected }, "system");
      } else {
        sysMsg("sys.proxyNone", {}, "system");
      }
    }

    // 3) 用终端拉起
    const bridgePath = (api.installPath || "").replace(/[\\/]+$/, "") + "/bridge/bridge.cjs";
    const cmd = 'node "' + bridgePath + '" --port ' + port;
    const r = await api.write.run("terminal.create", { cwd: api.installPath || ".", cols: TERM_COLS, rows: TERM_ROWS });
    if (!r || !r.ok) {
      sysMsg("sys.bridgeStartFail", { error: String((r && r.error) || "terminal unavailable") }, "error");
      return;
    }
    const terminalId = r.data && r.data.terminalId;
    if (!terminalId) { sysMsg("sys.bridgeStartFail", { error: "no terminalId" }, "error"); return; }
    const w = await api.write.run("terminal.write", { terminalId, data: cmd + "\r\n" });
    if (!w || !w.ok) {
      sysMsg("sys.bridgeStartFail", { error: String((w && w.error) || "write failed") }, "error");
      return;
    }
    sysMsg("sys.bridgeStarting", {}, "system");

    // 4) 轮询等待桥就绪（最多 15s）
    for (let i = 0; i < 30; i++) {
      await new Promise((r2) => setTimeout(r2, 500));
      if (await probe(url, 2000)) { sysMsg("sys.bridgeReady", {}, "system"); doConnect(); return; }
    }
    sysMsg("sys.bridgeNodeHint", { cmd }, "error");
  }, [api, sysMsg, doConnect, detectLocalProxy]);

  const doDisconnect = useCallback(() => {
    clientRef.current && clientRef.current.quit();
    setShowSettings(false);
  }, []);

  // 连接入口：先确保桥在跑，再连频道
  const onConnectClick = useCallback(async () => {
    setBridgeBusy(true);
    try { await startBridge(); } finally { setBridgeBusy(false); }
  }, [startBridge]);

  // 自动连接：面板打开后若已同意且启用了自动连接，自动触发一次
  const autoConnectFired = useRef(false);
  useEffect(() => {
    if (!cfgLoaded || autoConnectFired.current) return;
    autoConnectFired.current = true;
    const c = cfgRef.current;
    if (c && c.agreed && c.autoConnect) onConnectClick();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cfgLoaded]);

  const handleSend = useCallback(() => {
    const client = clientRef.current;
    const text = input.trim();
    if (!text || !client || !client.joined) return;
    if (text.startsWith("/")) {
      const sp = text.indexOf(" ");
      const cmd = (sp === -1 ? text.slice(1) : text.slice(1, sp)).toLowerCase();
      const rest = sp === -1 ? "" : text.slice(sp + 1).trim();
      if (cmd === "me") {
        if (!rest) sysMsg("cmd.meUsage", {});
        else {
          client.action(rest);
        }
      } else if (cmd === "nick") {
        if (!rest) sysMsg("cmd.nickUsage", {});
        else {
          const r = client.rename(rest);
          if (r === "invalid") sysMsg("sys.nickInvalid", { nick: rest });
          else if (r === "same") sysMsg("sys.renameSame", {});
          else if (r === "not-connected") sysMsg("sys.renameNotConnected", {});
          // pending: 等 onlineAdd/warn 事件
        }
      } else if (cmd === "help") {
        sysMsg("cmd.help", {});
      } else {
        sysMsg("cmd.unknown", { cmd });
      }
      setInput("");
      return;
    }
    const truncated = client.say(text);
    if (truncated) sysMsg("msg.tooLong", {});
    setInput("");
  }, [input, sysMsg]);

  const handleRenameApply = useCallback((newNick) => {
    const client = clientRef.current;
    if (!client) return "not-connected";
    return client.rename(newNick);
  }, []);

  const saveSettings = useCallback(async (partial) => {
    const next = Object.assign({}, cfgRef.current, partial);
    cfgRef.current = next;
    setCfg(next);
    if (clientRef.current) clientRef.current.cfg = next;
    try { await api.storage.setJson(STORAGE_KEY, next); } catch (e) { /* 存储失败不阻塞 UI */ }
    sysMsg("settings.savedHint", {}, "system");
  }, [api, sysMsg]);

  // 重置自动昵称：下次连接重新生成一个
  const resetGeneratedNick = useCallback(async () => {
    const next = Object.assign({}, cfgRef.current, { generatedNick: "" });
    cfgRef.current = next;
    setCfg(next);
    if (clientRef.current) clientRef.current.cfg = next;
    try { await api.storage.setJson(STORAGE_KEY, next); } catch (e) { /* 忽略 */ }
    sysMsg("settings.nickReset", {}, "system");
  }, [api, sysMsg]);

  const acceptDisclaimer = useCallback(async () => {
    const next = Object.assign({}, cfgRef.current, { agreed: true });
    cfgRef.current = next;
    setCfg(next);
    try { await api.storage.setJson(STORAGE_KEY, next); } catch (e) { /* 忽略 */ }
    setShowDisclaimer(false);
  }, [api]);

  const toggleMembers = useCallback(() => {
    const next = !cfgRef.current.membersOpen;
    const merged = Object.assign({}, cfgRef.current, { membersOpen: next });
    cfgRef.current = merged; setCfg(merged);
    api.storage.setJson(STORAGE_KEY, merged).catch(() => {});
  }, [api]);

  // ---- 渲染 ----
  const connected = status === "connected";
  const dotClass = connected ? "is-connected"
    : (status === "error" ? "is-error"
      : (["connecting", "reconnecting", "disconnecting"].includes(status) ? "is-connecting" : ""));
  const statusKey = {
    idle: "status.offline", connecting: "status.connecting", connected: "status.connected",
    reconnecting: "status.reconnecting", disconnecting: "status.disconnecting", error: "status.error",
  }[status] || "status.offline";

  const mentionRe = myNick ? new RegExp("(^|[^A-Za-z0-9_])" + escapeRegExp(myNick) + "($|[^A-Za-z0-9_])", "i") : null;

  const rootChildren = [];

  // 头部
  rootChildren.push(h("div", { key: "header", className: "sacx-header" },
    h("span", { className: "sacx-status-dot " + dotClass, title: t(statusKey, "") }),
    h("span", { className: "sacx-channel-name", title: CHANNEL_LABEL }, CHANNEL_LABEL),
    h("span", { className: "sacx-header-server" }, SERVICE_LABEL),
    h("span", { className: "sacx-header-spacer" }),
    h("button", {
      className: "sacx-member-count",
      title: t("header.showMembers", ""),
      onClick: toggleMembers,
    }, iconEl("Users", 12), t("header.memberCount", "", { count: members.length })),
    h("button", {
      className: "sacx-nick-btn",
      title: t("header.rename", ""),
      onClick: () => setShowRename(true),
    }, iconEl("PencilLine", 12), myNick || t("status.offline", "")),
    h("button", {
      className: "sacx-icon-btn" + (showSettings ? " is-active" : ""),
      title: t("header.settings", ""),
      onClick: () => setShowSettings(true),
    }, iconEl("Settings2", 15))));

  // 主体
  if (status === "idle" || status === "error") {
    rootChildren.push(h("div", { key: "idle", className: "sacx-idle" },
      iconEl("MessagesSquare", 28),
      h("div", { className: "sacx-idle-title" }, t("idle.title", "")),
      h("div", { className: "sacx-idle-sub" }, t("idle.sub", "")),
      h("div", { className: "sacx-idle-sub" }, t("idle.bridgeHint", "")),
      h("button", {
        className: "sacx-connect-btn",
        disabled: !cfg.agreed || bridgeBusy,
        onClick: onConnectClick,
      }, iconEl("Plug", 14), bridgeBusy ? t("idle.connecting", "") : t("idle.connect", ""))));
  } else {
    const bodyChildren = [];
    bodyChildren.push(h("div", {
      key: "msgs", className: "sacx-messages", ref: listRef, onScroll: onListScroll,
    }, messages.map((m) => renderMessage(m))));
    if (cfg.membersOpen) {
      bodyChildren.push(h("div", { key: "members", className: "sacx-memberlist" },
        h("div", { className: "sacx-memberlist-title" }, t("members.title", "")),
        members.length === 0
          ? h("div", { className: "sacx-memberlist-title" }, t("members.empty", ""))
          : members.map((m) => h("div", {
              key: m.nick,
              className: "sacx-member" + (m.nick === myNick ? " is-self" : ""),
              title: m.nick,
            }, h("span", {
              className: "sacx-member-dot",
              style: { background: userColor(m.nick, m.color) },
            }), m.nick))));
    }
    rootChildren.push(h("div", { key: "body", className: "sacx-body" }, bodyChildren));
  }

  // 输入区
  if (status !== "idle" && status !== "error") {
    rootChildren.push(h("div", { key: "footer", className: "sacx-footer" },
      h("input", {
        className: "sacx-input",
        value: input,
        disabled: !connected,
        placeholder: connected ? t("input.placeholder", "") : t("input.notConnected", ""),
        onChange: (e) => setInput(e.target.value),
        onKeyDown: (e) => { if (e.key === "Enter" && !e.nativeEvent.isComposing) handleSend(); },
        spellCheck: false,
      }),
      h("button", {
        className: "sacx-send-btn",
        disabled: !connected,
        title: t("input.send", ""),
        onClick: handleSend,
      }, iconEl("SendHorizonal", 15))));
  }

  // 浮层
  if (cfgLoaded && (!cfg.agreed || showDisclaimer)) {
    rootChildren.push(h(DisclaimerGate, {
      key: "disclaimer", api,
      onAccept: showDisclaimer ? () => setShowDisclaimer(false) : acceptDisclaimer,
      onDecline: showDisclaimer ? () => setShowDisclaimer(false) : () => {},
    }));
  }
  if (showSettings) {
    rootChildren.push(h(SettingsModal, {
      key: "settings", api, cfg, connected,
      onSave: saveSettings,
      onClose: () => setShowSettings(false),
      onDisconnect: doDisconnect,
      onReconnect: () => { setShowSettings(false); doConnect(); },
      onViewDisclaimer: () => { setShowSettings(false); setShowDisclaimer(true); },
      onResetNick: resetGeneratedNick,
    }));
  }
  if (showRename && connected) {
    rootChildren.push(h(RenamePopover, {
      key: "rename", api, current: myNick,
      onApply: handleRenameApply,
      onClose: () => setShowRename(false),
    }));
  }

  return h("div", { className: "sacx-root" }, rootChildren);

  // ---- 消息行渲染 ----
  function renderMessage(m) {
    if (m.kind === "system" || m.kind === "error") {
      const text = m.rawText !== undefined ? m.rawText : t(m.i18nKey, "", m.params);
      return h("div", {
        key: m.id,
        className: "sacx-msg " + (m.kind === "error" ? "is-error" : "is-system"),
      },
        h("span", { className: "sacx-msg-time" }, fmtTime(m.ts)),
        h("span", { className: "sacx-msg-text" }, text));
    }
    const isMention = mentionRe && !m.self && mentionRe.test(m.text);
    return h("div", {
      key: m.id,
      className: "sacx-msg" + (isMention ? " is-mention" : ""),
    },
      h("span", { className: "sacx-msg-time" }, fmtTime(m.ts)),
      h("span", {
        className: "sacx-msg-nick" + (m.self ? " is-self" : ""),
        style: { color: userColor(m.nick, m.color) },
        title: m.nick,
      }, m.nick),
      h("span", { className: "sacx-msg-text" + (m.isAction ? " is-action" : "") },
        m.isAction ? h("i", null, m.text) : m.text));
  }
}

function snapshotMembers(client) {
  return [...client.members.values()]
    .map((m) => ({ nick: m.nick, color: m.color }))
    .sort((a, b) => a.nick.localeCompare(b.nick));
}
