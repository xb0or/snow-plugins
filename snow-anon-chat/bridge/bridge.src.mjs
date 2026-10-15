// snow-anon-chat 本地桥（构建为 bridge.cjs 零依赖单文件）
// 面板受宿主 CSP 限制（connect-src 仅 ws://localhost:*），由本桥负责外网连接。
//
// 代理来源（优先级）：hello 握手帧 {t:"hello", proxy:"http://..."} > CLI --proxy > 直连。
// hello 携带空字符串或 "none"/"direct" 表示直连。代理经握手下发，改代理无需重启桥。
import { WebSocketServer, WebSocket as UpstreamWS } from "ws";
import { HttpsProxyAgent } from "https-proxy-agent";

const argv = process.argv.slice(2);
const arg = (name, dv) => {
  const i = argv.indexOf("--" + name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dv;
};
const PORT = Number(arg("port", "8799"));
const UPSTREAM = arg("upstream", "wss://hack.chat/chat-ws");
const CLI_PROXY = arg("proxy", "none"); // "none"/"direct"/"" → 直连

const log = (...a) => console.log("[" + new Date().toISOString().slice(11, 19) + "]", ...a);

// 双栈监听回环：面板必须用 ws://localhost:PORT（宿主 CSP 限制）
const servers = [];
for (const host of ["127.0.0.1", "::1"]) {
  try {
    const wss = new WebSocketServer({ host, port: PORT });
    servers.push(wss);
    wss.on("error", (e) => log("server[" + host + "] error: " + (e && e.message)));
    wss.on("connection", (panel, req) => handlePanel(panel, req));
    log("listening ws://" + host + ":" + PORT);
  } catch (e) {
    log("listen " + host + " failed: " + (e && e.message));
  }
}
if (!servers.length) { log("FATAL: no socket"); process.exit(1); }
log("upstream " + UPSTREAM + " | default proxy: " + (CLI_PROXY === "none" ? "direct" : CLI_PROXY));

function handlePanel(panel, req) {
  log("panel connected " + (req.socket.remoteAddress || "?"));
  let upstream = null;
  let closed = false;
  let connProxy = CLI_PROXY; // 每个面板连接可独立指定代理

  const toPanel = (obj) => {
    if (closed) return;
    try { panel.send(JSON.stringify(obj)); } catch (e) { /* 忽略 */ }
  };

  const openUpstream = () => {
    if (upstream) return;
    const useProxy = connProxy && connProxy !== "none" && connProxy !== "direct";
    const opts = useProxy ? { agent: new HttpsProxyAgent(connProxy) } : {};
    log("upstream connecting " + UPSTREAM + (useProxy ? " via " + connProxy : " direct"));
    try {
      upstream = new UpstreamWS(UPSTREAM, opts);
    } catch (e) {
      toPanel({ t: "upstream-error", error: "construct: " + String(e && e.message || e) });
      return;
    }
    upstream.on("open", () => { log("upstream open"); toPanel({ t: "upstream-open" }); });
    upstream.on("message", (data) => {
      if (closed) return;
      try { panel.send(typeof data === "string" ? data : data.toString("utf8")); } catch (e) { /* 忽略 */ }
    });
    upstream.on("close", (code) => {
      log("upstream close " + code);
      toPanel({ t: "upstream-close", code: code || 0, reason: "" });
    });
    upstream.on("error", (err) => {
      log("upstream error: " + (err && err.message));
      toPanel({ t: "upstream-error", error: String(err && err.message || err) });
    });
  };

  panel.on("message", (raw) => {
    let msg = null;
    try { msg = JSON.parse(String(raw)); } catch (e) { return; }
    if (msg && msg.t === "ping") { toPanel({ t: "pong", ts: Date.now() }); return; }
    if (msg && msg.t === "hello") {
      if (typeof msg.proxy === "string") connProxy = msg.proxy;
      openUpstream();
      return;
    }
    if (upstream && upstream.readyState === 1) upstream.send(JSON.stringify(msg));
  });

  panel.on("close", () => {
    closed = true;
    log("panel disconnected");
    try { upstream && upstream.close(); } catch (e) { /* 忽略 */ }
  });
  panel.on("error", () => { /* 走 close */ });
}
