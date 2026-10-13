/*
 * 本地语音服务 (Local Speech Service) — Snow App ESM 面板插件
 *
 * 用途：启动 / 停止 / 状态检测「本地语音服务」客户端脚本使用的本地 whisper.cpp 转写服务，并可下载识别模型。
 *
 * 实现要点（均为实测确认的能力）：
 *  - 状态检测：api.net.fetch 请求 http://127.0.0.1:<port>/ping（回环 HTTP，面板运行时同样可用）。
 *  - 启动/停止：经 terminal 写动作创建一个临时终端执行命令，命令下发后等待其执行完再关闭终端。
 *    服务以分离进程启动（Start-Process -WindowStyle Hidden），因此不会常驻终端标签页。
 *  - 切换模型：把选中的模型路径经 SNOW_WHISPER_MODEL 传给服务进程，重启后生效。
 *  - 下载模型：由服务端后台线程下载（面板的 net.fetch 有 5MB 响应上限，无法直接下大文件），
 *    面板通过 /models/catalog 取清单、/models/download 触发、/models/status 轮询进度。
 *  - 配色全部走宿主主题 CSS 变量（style.css），图标内嵌官方 Lucide SVG。
 *
 * privacy：terminal（创建终端会话执行启动/停止命令）。
 */

const DEFAULT_PORT = 8791;
/* 服务目录没有可用的默认值：stt-service 不随插件分发，必须由用户在「服务目录」中指定。
   留空时启动动作会被拦截并提示，避免写死任何本机绝对路径。 */
const DEFAULT_DIR = "";
const STORAGE_KEY = "stt-launcher.config";

/* 终端命令执行后的等待时长：PowerShell 首次启动 + 加载 profile 需要时间，
   等待过短会在命令生效前就把终端关掉（曾导致"点停止无反应"）。 */
const SHELL_SETTLE_MS = 4000;

/* 官方 Lucide SVG 路径（viewBox 0 0 24 24，stroke=currentColor，fill=none） */
const ICON_PATHS = {
  play: '<polygon points="6 3 20 12 6 21 6 3"/>',
  square: '<rect width="18" height="18" x="3" y="3" rx="2"/>',
  refresh: '<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/>',
  "rotate-cw": '<path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/>',
  copy: '<rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
  server: '<rect width="20" height="8" x="2" y="2" rx="2" ry="2"/><rect width="20" height="8" x="2" y="14" rx="2" ry="2"/><line x1="6" x2="6.01" y1="6" y2="6"/><line x1="6" x2="6.01" y1="18" y2="18"/>',
  settings: '<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>',
  "loader-circle": '<path d="M21 12a9 9 0 1 1-6.219-8.56"/>',
  "circle-check": '<circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/>',
  "circle-x": '<circle cx="12" cy="12" r="10"/><path d="m15 9-6 6"/><path d="m9 9 6 6"/>',
  "circle-alert": '<circle cx="12" cy="12" r="10"/><line x1="12" x2="12" y1="8" y2="12"/><line x1="12" x2="12.01" y1="16" y2="16"/>',
  activity: '<path d="M22 12h-2.48a2 2 0 0 0-1.93 1.46l-2.35 8.36a.25.25 0 0 1-.48 0L9.24 2.18a.25.25 0 0 0-.48 0l-2.35 8.36A2 2 0 0 1 4.49 12H2"/>',
  info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" x2="12" y1="15" y2="3"/>',
  box: '<path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/><path d="m3.3 7 8.7 5 8.7-5"/><path d="M12 22V12"/>',
  trash: '<path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/><line x1="10" x2="10" y1="11" y2="17"/><line x1="14" x2="14" y1="11" y2="17"/>'
};

function makeIcon(R, name, size) {
  return R.createElement("svg", {
    width: size || 16, height: size || 16, viewBox: "0 0 24 24",
    fill: "none", stroke: "currentColor", strokeWidth: 2,
    strokeLinecap: "round", strokeLinejoin: "round",
    className: "stl-icon", "aria-hidden": "true",
    dangerouslySetInnerHTML: { __html: ICON_PATHS[name] || ICON_PATHS["circle-alert"] }
  });
}

function psQuote(s) {
  return "'" + String(s == null ? "" : s).replace(/'/g, "''") + "'";
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function fmtSize(bytes) {
  if (!bytes || bytes <= 0) return "";
  const mb = bytes / (1024 * 1024);
  if (mb < 1024) return mb.toFixed(1) + " MB";
  return (mb / 1024).toFixed(2) + " GB";
}

export default function Panel({ api }) {
  const R = window.SnowAppPlugin.React;
  const { useState, useEffect, useRef, useCallback } = R;

  const [port, setPort] = useState(DEFAULT_PORT);
  const [dir, setDir] = useState(DEFAULT_DIR);
  const [modelPath, setModelPath] = useState("");
  const [mirror, setMirror] = useState("official");
  const [proxy, setProxy] = useState("");
  const [customUrl, setCustomUrl] = useState("");
  const [customName, setCustomName] = useState("");
  const [status, setStatus] = useState("unknown");
  const [info, setInfo] = useState(null);
  const [catalog, setCatalog] = useState([]);
  const [downloads, setDownloads] = useState({});
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState(null);
  const [backends, setBackends] = useState(null);
  const [backendMode, setBackendMode] = useState("auto");
  const loadedRef = useRef(false);

  const t = useCallback((key, fallback) => {
    try { return api.t(key, { defaultValue: fallback }); }
    catch (e) { return fallback; }
  }, [api]);

  /* ---------- 配置加载 ---------- */
  useEffect(() => {
    if (loadedRef.current) return;
    loadedRef.current = true;
    (async () => {
      let usePort = DEFAULT_PORT, useDir = DEFAULT_DIR, useModel = "", useMirror = "official", useProxy = "", useBackend = "auto";
      try {
        const raw = await api.storage.get(STORAGE_KEY);
        if (raw) {
          const cfg = JSON.parse(raw);
          if (cfg && typeof cfg.port === "number") usePort = cfg.port;
          if (cfg && typeof cfg.dir === "string" && cfg.dir) useDir = cfg.dir;
          if (cfg && typeof cfg.modelPath === "string") useModel = cfg.modelPath;
          if (cfg && typeof cfg.mirror === "string" && cfg.mirror) useMirror = cfg.mirror;
          if (cfg && typeof cfg.proxy === "string") useProxy = cfg.proxy;
          if (cfg && typeof cfg.backendMode === "string" && cfg.backendMode) useBackend = cfg.backendMode;
        }
      } catch (e) { /* 使用默认值 */ }
      setPort(usePort); setDir(useDir); setModelPath(useModel); setMirror(useMirror); setProxy(useProxy); setBackendMode(useBackend);
      void doCheck(usePort);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function persist(patch) {
    const next = Object.assign({
      port: port, dir: dir, modelPath: modelPath, mirror: mirror, proxy: proxy, backendMode: backendMode
    }, patch || {});
    try { api.storage.set(STORAGE_KEY, JSON.stringify(next)); }
    catch (e) { /* ignore */ }
  }

  /* ---------- 后端信息 ---------- */
  const loadBackends = useCallback(async (p) => {
    const usePort = typeof p === "number" ? p : port;
    try {
      const res = await api.net.fetch("http://127.0.0.1:" + usePort + "/backends", { method: "GET", timeoutMs: 15000 });
      if (res && res.ok) setBackends(JSON.parse(res.body));
    } catch (e) { /* 服务未运行时忽略 */ }
  }, [api, port]);

  /* ---------- 状态检测 ---------- */
  const doCheck = useCallback(async (p) => {
    const usePort = typeof p === "number" ? p : port;
    setStatus("checking");
    try {
      const res = await api.net.fetch("http://127.0.0.1:" + usePort + "/ping", { method: "GET", timeoutMs: 6000 });
      if (res && res.ok && res.status === 200) {
        setStatus("running");
        try { setInfo(JSON.parse(res.body)); } catch (e) { setInfo(null); }
        void loadCatalog(usePort);
        void loadBackends(usePort);
      } else if (res && res.ok) {
        setStatus("stopped");
        setInfo(null);
      } else {
        const errText = String((res && res.error) || "");
        if (/ECONNREFUSED|ECONNRESET|refused/i.test(errText)) { setStatus("stopped"); setInfo(null); }
        else { setStatus("blocked"); setInfo(null); setMessage({ kind: "warn", text: errText || t("hint.blocked", "") }); }
      }
    } catch (e) {
      const errText = String((e && e.message) || e);
      if (/ECONNREFUSED|ECONNRESET|refused/i.test(errText)) { setStatus("stopped"); setInfo(null); }
      else { setStatus("blocked"); setInfo(null); setMessage({ kind: "warn", text: errText || t("hint.blocked", "") }); }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, port, t, loadBackends]);

  const checkNow = useCallback(async () => {
    setBusy("check");
    setMessage(null);
    try { await doCheck(port); } finally { setBusy(""); }
  }, [doCheck, port]);

  /* ---------- 模型清单 / 下载 ---------- */
  const loadCatalog = useCallback(async (p) => {
    const usePort = typeof p === "number" ? p : port;
    try {
      const res = await api.net.fetch("http://127.0.0.1:" + usePort + "/models/catalog", { method: "GET", timeoutMs: 5000 });
      if (res && res.ok) {
        const data = JSON.parse(res.body);
        setCatalog(Array.isArray(data.catalog) ? data.catalog : []);
      }
    } catch (e) { /* 服务未运行时忽略 */ }
  }, [api, port]);

  const refreshDownloads = useCallback(async (p) => {
    const usePort = typeof p === "number" ? p : port;
    try {
      const res = await api.net.fetch("http://127.0.0.1:" + usePort + "/models/status", { method: "GET", timeoutMs: 5000 });
      if (res && res.ok) {
        const data = JSON.parse(res.body);
        const next = data.downloads || {};
        setDownloads(next);
        return next;
      }
    } catch (e) { /* ignore */ }
    return null;
  }, [api, port]);

  const startDownload = useCallback(async (name) => {
    setMessage(null);
    try {
      const res = await api.net.fetch("http://127.0.0.1:" + port + "/models/download", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name, mirror: mirror, proxy: proxy })
      });
      if (!res || !res.ok) {
        let detail = res ? "HTTP " + res.status : "无响应";
        try { const j = JSON.parse(res.body); if (j && j.error) detail = j.error; } catch (e) { /* ignore */ }
        throw new Error(detail);
      }
      setMessage({ kind: "ok", text: t("msg.downloadStarted", "已开始下载：") + name });
      await refreshDownloads(port);
    } catch (e) {
      setMessage({ kind: "error", text: String((e && e.message) || e) });
    }
  }, [api, port, mirror, refreshDownloads, t]);

  const startCustomDownload = useCallback(async () => {
    const u = customUrl.trim();
    if (!u) return;
    setMessage(null);
    try {
      const res = await api.net.fetch("http://127.0.0.1:" + port + "/models/download-custom", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: u, name: customName.trim(), proxy: proxy })
      });
      if (!res || !res.ok) {
        let detail = res ? "HTTP " + res.status : "无响应";
        try { const j = JSON.parse(res.body); if (j && j.error) detail = j.error; } catch (e) { /* ignore */ }
        throw new Error(detail);
      }
      const data = JSON.parse(res.body);
      setMessage({ kind: "ok", text: t("msg.downloadStarted", "已开始下载：") + (data && data.name ? data.name : "") });
      setCustomUrl("");
      setCustomName("");
      await refreshDownloads(port);
    } catch (e) {
      setMessage({ kind: "error", text: String((e && e.message) || e) });
    }
  }, [api, port, proxy, customUrl, customName, refreshDownloads, t]);

  const deleteModel = useCallback(async (name) => {
    const ok = window.confirm(t("confirm.delete", "确定删除模型 ") + name + t("confirm.delete2", " ？此操作不可恢复。"));
    if (!ok) return;
    setMessage(null);
    try {
      const res = await api.net.fetch("http://127.0.0.1:" + port + "/models/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name })
      });
      if (!res || !res.ok) {
        let detail = res ? "HTTP " + res.status : "无响应";
        try { const j = JSON.parse(res.body); if (j && j.error) detail = j.error; } catch (e) { /* ignore */ }
        throw new Error(detail);
      }
      setMessage({ kind: "ok", text: t("msg.deleted", "已删除：") + name });
      await doCheck(port);
    } catch (e) {
      setMessage({ kind: "error", text: String((e && e.message) || e) });
    }
  }, [api, port, doCheck, t]);

  /* 下载中时轮询进度；全部完成后刷新状态与模型列表 */
  useEffect(() => {
    const active = Object.keys(downloads).filter((k) => downloads[k] && downloads[k].state === "downloading");
    if (!active.length) return;
    let cancelled = false;
    const timer = setInterval(async () => {
      const next = await refreshDownloads(port);
      if (cancelled || !next) return;
      const still = Object.keys(next).filter((k) => next[k] && next[k].state === "downloading");
      if (!still.length) {
        clearInterval(timer);
        void doCheck(port); /* 刷新已安装模型列表 */
      }
    }, 1200);
    return () => { cancelled = true; clearInterval(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [downloads, port]);

  /* ---------- 在临时终端里执行命令 ---------- */
  const runInTerminal = useCallback(async (command) => {
    const created = await api.write.run("terminal.create", { cwd: dir, cols: 100, rows: 24 });
    if (!created || !created.ok || !created.data || !created.data.terminalId) {
      throw new Error((created && created.error) || t("err.terminalCreate", "无法创建终端"));
    }
    const terminalId = created.data.terminalId;
    try {
      const written = await api.write.run("terminal.write", { terminalId: terminalId, data: command });
      if (!written || !written.ok) {
        throw new Error((written && written.error) || t("err.terminalWrite", "终端写入失败"));
      }
      await sleep(SHELL_SETTLE_MS);
    } finally {
      try { await api.write.run("terminal.kill", { terminalId: terminalId }); } catch (e) { /* ignore */ }
    }
  }, [api, dir, t]);

  /* ---------- 启动 / 停止 / 重启 ---------- */
  /* 三个动作共用 startCore / stopCore（不含 busy 状态管理），
     重启 = 先停 → 等端口真正释放 → 再起，避免新旧进程抢同一端口。
     模型与后端偏好在这里通过环境变量下发给服务进程，因此未启动时也能先选好。 */
  const startCore = useCallback(async (p, d, mp, bm) => {
    const envParts = [];
    if (mp) envParts.push("$env:SNOW_WHISPER_MODEL=" + psQuote(mp));
    envParts.push("$env:SNOW_STT_BACKEND=" + psQuote(bm || "auto"));
    const cmd = envParts.join("; ") + "; " +
      "Start-Process -FilePath 'python' -ArgumentList @('stt_server.py'," + psQuote(String(p)) + ") " +
      "-WorkingDirectory " + psQuote(d) + " -WindowStyle Hidden\r\n";
    await runInTerminal(cmd);
    await sleep(1800);
    await doCheck(p);
  }, [runInTerminal, doCheck]);

  const stopCore = useCallback(async (p) => {
    const cmd =
      "$targets = netstat -ano | Select-String '" + p + "\\s' | Select-String 'LISTENING'; " +
      "$procIds = $targets | ForEach-Object { ($_.ToString().Trim() -split '\\s+')[-1] } | Select-Object -Unique; " +
      "foreach ($procId in $procIds) { if ($procId -match '^\\d+$') { Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue } }\r\n";
    await runInTerminal(cmd);
    await sleep(1000);
    await doCheck(p);
  }, [runInTerminal, doCheck]);

  /* 轮询等待端口不再响应 /ping，返回是否已释放 */
  const waitPortFree = useCallback(async (p, waitMs) => {
    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline) {
      let up = false;
      try {
        const res = await api.net.fetch("http://127.0.0.1:" + p + "/ping", { method: "GET", timeoutMs: 1500 });
        up = !!(res && res.ok && res.status === 200);
      } catch (e) { up = false; }
      if (!up) return true;
      await sleep(500);
    }
    return false;
  }, [api]);

  const startService = useCallback(async () => {
    if (!String(dir || "").trim()) {
      setMessage({ kind: "error", text: t("err.noDir", "请先填写「服务目录」（包含 stt_server.py 的目录）") });
      return;
    }
    setBusy("start");
    setMessage(null);
    try {
      await startCore(port, dir, modelPath, backendMode);
    } catch (e) {
      setMessage({ kind: "error", text: String((e && e.message) || e) });
    } finally { setBusy(""); }
  }, [port, dir, modelPath, backendMode, startCore, t]);

  const stopService = useCallback(async () => {
    setBusy("stop");
    setMessage(null);
    try {
      await stopCore(port);
    } catch (e) {
      setMessage({ kind: "error", text: String((e && e.message) || e) });
    } finally { setBusy(""); }
  }, [port, stopCore]);

  const restartService = useCallback(async () => {
    if (!String(dir || "").trim()) {
      setMessage({ kind: "error", text: t("err.noDir", "请先填写「服务目录」（包含 stt_server.py 的目录）") });
      return;
    }
    setBusy("restart");
    setMessage(null);
    const p = port, d = dir, mp = modelPath, bm = backendMode;
    try {
      await stopCore(p);
      await waitPortFree(p, 8000);
      await startCore(p, d, mp, bm);
      setMessage({ kind: "ok", text: t("msg.restarted", "服务已重启") });
    } catch (e) {
      setMessage({ kind: "error", text: String((e && e.message) || e) });
    } finally { setBusy(""); }
  }, [port, dir, modelPath, backendMode, stopCore, startCore, waitPortFree, t]);

  /* 切换模型：落盘后自动重启服务；服务没在跑就只保存，等下次启动生效 */
  const onModelChange = useCallback(async (mp) => {
    setModelPath(mp);
    persist({ modelPath: mp });
    if (status !== "running") {
      setMessage({ kind: "ok", text: t("msg.modelSaved", "已保存模型选择，启动服务后生效") });
      return;
    }
    await restartService();
    const label = mp ? String(mp).split(/[\\/]/).pop() : t("model.auto", "自动");
    setMessage({ kind: "ok", text: t("msg.modelSwitched", "已切换模型并重启服务：") + label });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, persist, restartService, t]);

  /* 切换推理后端：未启动时只保存（启动时经环境变量下发）；
     服务在跑则调服务端接口，它会重新探测并重启常驻推理进程（最坏十几秒，故放宽超时） */
  const switchBackend = useCallback(async (mode) => {
    setBackendMode(mode);
    persist({ backendMode: mode });
    setMessage(null);
    if (status !== "running") {
      setMessage({ kind: "ok", text: t("msg.backendSaved", "已保存后端选择，启动服务后生效") });
      return;
    }
    setBusy("backend");
    try {
      const res = await api.net.fetch("http://127.0.0.1:" + port + "/backends", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: mode }),
        timeoutMs: 120000
      });
      if (!res || !res.ok) {
        let detail = res ? "HTTP " + res.status : "无响应";
        try { const j = JSON.parse(res.body); if (j && j.error) detail = j.error; } catch (e) { /* ignore */ }
        throw new Error(detail);
      }
      const data = JSON.parse(res.body);
      if (data && data.status) setBackends(data.status);
      setMessage({
        kind: "ok",
        text: t("msg.backendSwitched", "推理后端已切换：") +
          ((data && data.status && data.status.activeLabel) || mode)
      });
      await doCheck(port);
    } catch (e) {
      setMessage({ kind: "error", text: String((e && e.message) || e) });
    } finally { setBusy(""); }
  }, [api, port, status, doCheck, persist, t]);

  /* ---------- 渲染 ---------- */
  const statusText = t("status." + status, status);
  const endpoint = "http://127.0.0.1:" + port;
  const isRunning = status === "running";

  /* 后端提示：显示当前实际生效的后端；探测是异步的，期间如实说明 */
  const backendHint = () => {
    if (!backends) return t("hint.backendUnknown", "后端信息不可用（服务未运行或版本较旧）。");
    const name = backends.activeLabel || backends.active;
    if (name) {
      return t("hint.backendActive", "当前使用：") + name
        + (backends.probing ? t("hint.backendProbing", "（正在后台探测其它后端）") : "");
    }
    return backends.probing
      ? t("hint.backendProbing2", "正在探测可用后端…")
      : t("hint.backendNone", "没有可用的推理后端（已尝试 GPU 与 CPU）。");
  };

  const statusIcon =
    status === "running" ? "circle-check" :
    status === "stopped" ? "circle-x" :
    status === "checking" ? "loader-circle" : "circle-alert";
  const statusClass =
    status === "running" ? "stl-ok" :
    status === "stopped" ? "stl-off" :
    status === "checking" ? "stl-muted" : "stl-warn";

  const installedNames = (info && Array.isArray(info.models)) ? info.models.map((m) => m.name) : [];
  const modelOptions = (info && Array.isArray(info.models)) ? info.models : [];
  const effModels = modelOptions.length ? modelOptions
    : (modelPath ? [{ name: String(modelPath).split(/[\\/]/).pop(), path: modelPath }] : []);

  const modelRows = catalog.map((m) => {
    const installed = installedNames.indexOf(m.name) >= 0;
    const dl = downloads[m.name];
    const downloading = dl && dl.state === "downloading";
    const failed = dl && dl.state === "error";
    let pct = 0;
    if (downloading && dl.total > 0) pct = Math.min(100, Math.round((dl.received / dl.total) * 100));
    return R.createElement("div", { className: "stl-mrow", key: m.name },
      R.createElement("div", { className: "stl-mrow-main" },
        R.createElement("div", { className: "stl-mrow-name" },
          R.createElement("span", { title: m.name }, m.name),
          installed ? R.createElement("span", { className: "stl-tag stl-tag-ok" }, t("tag.installed", "已安装")) : null
        ),
        R.createElement("div", { className: "stl-mrow-sub" }, m.size + " · " + m.note)
      ),
      downloading
        ? R.createElement("div", { className: "stl-mrow-progress" },
            R.createElement("div", { className: "stl-bar" },
              R.createElement("div", { className: "stl-bar-fill", style: { width: pct + "%" } })
            ),
            R.createElement("span", { className: "stl-pct" },
              dl.total > 0 ? pct + "%  " + fmtSize(dl.received) + " / " + fmtSize(dl.total) : fmtSize(dl.received))
          )
        : failed
          ? R.createElement("div", { className: "stl-mrow-actions" },
              R.createElement("span", { className: "stl-msg-error stl-inline-err", title: String(dl.error || "") }, t("tag.failed", "失败")),
              R.createElement("button", {
                className: "stl-btn stl-btn-sm", type: "button",
                onClick: () => startDownload(m.name)
              }, makeIcon(R, "download", 13), R.createElement("span", null, t("btn.retry", "重试")))
            )
          : R.createElement("div", { className: "stl-mrow-actions" },
              installed ? R.createElement("button", {
                className: "stl-btn stl-btn-sm stl-btn-danger", type: "button",
                title: t("btn.delete", "删除"),
                onClick: () => deleteModel(m.name)
              }, makeIcon(R, "trash", 13), R.createElement("span", null, t("btn.delete", "删除"))) : null,
              R.createElement("button", {
                className: "stl-btn stl-btn-sm", type: "button",
                disabled: !isRunning,
                onClick: () => startDownload(m.name)
              }, makeIcon(R, "download", 13), R.createElement("span", null, installed ? t("btn.redownload", "重新下载") : t("btn.download", "下载")))
            )
    );
  });

  return R.createElement(
    "div", { className: "stl-root" },

    /* 头部 */
    R.createElement("div", { className: "stl-header" },
      R.createElement("div", { className: "stl-title" },
        makeIcon(R, "server", 18),
        R.createElement("span", null, t("title", "本地语音服务"))
      ),
      R.createElement("div", { className: "stl-status " + statusClass },
        R.createElement("span", { className: status === "checking" ? "stl-spin" : "" }, makeIcon(R, statusIcon, 15)),
        R.createElement("span", null, statusText)
      )
    ),

    /* 服务 */
    R.createElement("div", { className: "stl-section" },
      R.createElement("div", { className: "stl-section-title" },
        makeIcon(R, "activity", 14),
        R.createElement("span", null, t("section.service", "服务"))
      ),

      R.createElement("div", { className: "stl-row" },
        R.createElement("span", { className: "stl-label" }, t("row.endpoint", "访问端点")),
        R.createElement("code", { className: "stl-code" }, endpoint)
      ),

      info ? R.createElement("div", { className: "stl-meta" },
        info.cli ? R.createElement("div", { className: "stl-meta-row" },
          R.createElement("span", { className: "stl-meta-k" }, t("engine.cli", "whisper 程序")),
          R.createElement("span", { className: "stl-meta-v", title: String(info.cli) }, String(info.cli))
        ) : null,
        info.model ? R.createElement("div", { className: "stl-meta-row" },
          R.createElement("span", { className: "stl-meta-k" }, t("engine.model", "模型")),
          R.createElement("span", { className: "stl-meta-v" }, String(info.model))
        ) : null,
        info.threads ? R.createElement("div", { className: "stl-meta-row" },
          R.createElement("span", { className: "stl-meta-k" }, t("engine.threads", "线程数")),
          R.createElement("span", { className: "stl-meta-v" }, String(info.threads))
        ) : null,
        info.backendLabel ? R.createElement("div", { className: "stl-meta-row" },
          R.createElement("span", { className: "stl-meta-k" }, t("engine.device", "推理设备")),
          R.createElement("span", { className: "stl-meta-v" }, String(info.backendLabel))
        ) : null,
        info.server ? R.createElement("div", { className: "stl-meta-row" },
          R.createElement("span", { className: "stl-meta-k" }, t("engine.resident", "推理进程")),
          R.createElement("span", { className: "stl-meta-v" },
            info.resident
              ? t("engine.residentOn", "常驻 whisper-server（模型只加载一次）")
              : t("engine.residentOff", "whisper-cli（每次请求重新加载模型）"))
        ) : null
      ) : null,

      /* 当前模型：切换即自动重启，让改动立刻生效 */
      R.createElement("div", { className: "stl-row" },
        R.createElement("span", { className: "stl-label" }, t("row.model", "当前模型")),
        R.createElement("select", {
          className: "stl-select", value: modelPath, disabled: !!busy,
          onChange: (e) => onModelChange(e.target.value)
        },
          R.createElement("option", { value: "" }, t("model.auto", "自动（取目录中第一个 ggml 模型）")),
          effModels.map((m) => R.createElement("option", { key: m.path, value: m.path }, m.name))
        )
      ),
      R.createElement("div", { className: "stl-hint" },
        modelOptions.length
          ? t("hint.modelPick", "切换模型会自动重启服务使其生效；服务未启动时只保存选择。")
          : t("hint.modelEmpty", "启动服务后可在此选择已安装的 ggml 模型。")),

      /* 推理后端：默认自动择优（cuda > vulkan > cpu），也可手动强制。
         未启动时也可选，选择会在启动时通过环境变量下发给服务进程。 */
      R.createElement("div", { className: "stl-row" },
        R.createElement("span", { className: "stl-label" }, t("row.backend", "推理后端")),
        R.createElement("select", {
          className: "stl-select",
          value: isRunning && backends ? (backends.preference || "auto") : backendMode,
          disabled: !!busy,
          onChange: (e) => switchBackend(e.target.value)
        },
          R.createElement("option", { value: "auto" }, t("backend.auto", "自动（GPU 优先，CPU 兜底）")),
          (backends && Array.isArray(backends.backends) ? backends.backends : []).map((b) =>
            R.createElement("option", { key: b.name, value: b.name },
              b.label + (b.installed ? "" : t("backend.notInstalled", "（未安装）"))))
        )
      ),
      R.createElement("div", { className: "stl-hint" }, backendHint()),

      R.createElement("div", { className: "stl-actions" },
        R.createElement("button", {
          className: "stl-btn stl-primary", type: "button", disabled: !!busy || isRunning,
          onClick: startService
        },
          R.createElement("span", { className: busy === "start" ? "stl-spin" : "" }, makeIcon(R, busy === "start" ? "loader-circle" : "play", 15)),
          R.createElement("span", null, busy === "start" ? t("btn.starting", "启动中…") : t("btn.start", "启动"))
        ),
        R.createElement("button", {
          className: "stl-btn stl-danger", type: "button", disabled: !!busy || !isRunning,
          onClick: stopService
        },
          R.createElement("span", { className: busy === "stop" ? "stl-spin" : "" }, makeIcon(R, busy === "stop" ? "loader-circle" : "square", 15)),
          R.createElement("span", null, busy === "stop" ? t("btn.stopping", "停止中…") : t("btn.stop", "停止"))
        ),
        R.createElement("button", {
          className: "stl-btn", type: "button", disabled: !!busy,
          title: t("btn.restartHint", "重启：重新加载模型与代码变更，识别较慢时也可用来回收常驻进程"),
          onClick: restartService
        },
          R.createElement("span", { className: busy === "restart" ? "stl-spin" : "" }, makeIcon(R, busy === "restart" ? "loader-circle" : "rotate-cw", 15)),
          R.createElement("span", null, busy === "restart" ? t("btn.restarting", "重启中…") : t("btn.restart", "重启"))
        ),
        R.createElement("button", {
          className: "stl-btn", type: "button", disabled: !!busy,
          onClick: checkNow
        },
          R.createElement("span", { className: busy === "check" || status === "checking" ? "stl-spin" : "" }, makeIcon(R, "refresh", 15)),
          R.createElement("span", null, t("btn.check", "检测"))
        ),
        R.createElement("button", {
          className: "stl-btn stl-ghost", type: "button",
          onClick: () => {
            try {
              api.write.run("system.writeClipboardText", { text: endpoint });
              setMessage({ kind: "ok", text: t("msg.copied", "端点已复制到剪贴板") });
            } catch (e) { /* ignore */ }
          }
        }, makeIcon(R, "copy", 15), R.createElement("span", null, t("btn.copy", "复制端点")))
      ),

      message ? R.createElement("div", {
        className: "stl-msg " + (message.kind === "error" ? "stl-msg-error" : message.kind === "ok" ? "stl-msg-ok" : "stl-msg-warn")
      },
        makeIcon(R, message.kind === "error" ? "circle-alert" : message.kind === "ok" ? "circle-check" : "info", 14),
        R.createElement("span", null, message.text)
      ) : null,

      R.createElement("div", { className: "stl-hint" }, t("hint.start", "启动会在后台运行 python stt_server.py，随后自动回报状态。"))
    ),

    /* 模型库 */
    R.createElement("div", { className: "stl-section" },
      R.createElement("div", { className: "stl-section-title" },
        makeIcon(R, "box", 14),
        R.createElement("span", null, t("section.models", "模型库"))
      ),
      R.createElement("div", { className: "stl-row" },
        R.createElement("span", { className: "stl-label" }, t("row.mirror", "下载源")),
        R.createElement("select", {
          className: "stl-select", value: mirror,
          onChange: (e) => { setMirror(e.target.value); persist({ mirror: e.target.value }); }
        },
          R.createElement("option", { value: "official" }, t("mirror.official", "官方 huggingface.co")),
          R.createElement("option", { value: "hf-mirror" }, t("mirror.hfmirror", "镜像 hf-mirror.com（国内更快）")),
          R.createElement("option", { value: "modelscope" }, t("mirror.modelscope", "魔搭 ModelScope（国内直连，无需代理）"))
        )
      ),
      R.createElement("div", { className: "stl-row" },
        R.createElement("span", { className: "stl-label" }, t("row.proxy", "下载代理")),
        R.createElement("input", {
          className: "stl-input", type: "text", value: proxy,
          placeholder: "http://127.0.0.1:7897",
          onChange: (e) => { setProxy(e.target.value); persist({ proxy: e.target.value }); }
        })
      ),
      catalog.length
        ? R.createElement("div", { className: "stl-mlist" }, modelRows)
        : R.createElement("div", { className: "stl-hint" }, isRunning ? t("hint.catalogEmpty", "未取到模型清单。") : t("hint.catalogOffline", "启动服务后即可在此下载模型。")),
      R.createElement("div", { className: "stl-row" },
        R.createElement("span", { className: "stl-label" }, t("row.customUrl", "自定义模型")),
        R.createElement("input", {
          className: "stl-input", type: "text", value: customUrl,
          placeholder: "https://.../ggml-xxx.bin",
          onChange: (e) => setCustomUrl(e.target.value)
        })
      ),
      R.createElement("div", { className: "stl-row" },
        R.createElement("span", { className: "stl-label" }, t("row.customName", "保存为")),
        R.createElement("input", {
          className: "stl-input", type: "text", value: customName,
          placeholder: t("ph.customName", "留空则按 URL 文件名"),
          onChange: (e) => setCustomName(e.target.value)
        }),
        R.createElement("button", {
          className: "stl-btn stl-btn-sm", type: "button",
          disabled: !isRunning || !customUrl.trim(),
          onClick: startCustomDownload
        }, makeIcon(R, "download", 13), R.createElement("span", null, t("btn.download", "下载")))
      ),
      R.createElement("div", { className: "stl-hint" }, t("hint.custom", "可填任意 ggml 模型地址（.bin）；下载完成后会出现在「当前模型」下拉中。")),
      R.createElement("div", { className: "stl-hint" }, t("hint.modelNote", "模型下载到服务目录的 whisper/ 下。代理留空时自动使用 Snow App 的代理设置。"))
    ),

    /* 设置 */
    R.createElement("div", { className: "stl-section" },
      R.createElement("div", { className: "stl-section-title" },
        makeIcon(R, "settings", 14),
        R.createElement("span", null, t("section.settings", "设置"))
      ),
      R.createElement("div", { className: "stl-row" },
        R.createElement("span", { className: "stl-label" }, t("row.port", "端口")),
        R.createElement("input", {
          className: "stl-input stl-input-sm", type: "number", min: 1, max: 65535, value: port,
          onChange: (e) => { const v = parseInt(e.target.value, 10); if (!isNaN(v)) { setPort(v); persist({ port: v }); } }
        })
      ),
      R.createElement("div", { className: "stl-row stl-row-col" },
        R.createElement("span", { className: "stl-label" }, t("row.dir", "服务目录")),
        R.createElement("input", {
          className: "stl-input", type: "text", value: dir,
          onChange: (e) => { setDir(e.target.value); persist({ dir: e.target.value }); }
        }),
        R.createElement("div", { className: "stl-hint" }, t("hint.dir", "包含 stt_server.py 的目录（whisper 运行时位于其 whisper/ 子目录）。"))
      )
    ),

    /* 说明 */
    R.createElement("div", { className: "stl-note" },
      R.createElement("div", { className: "stl-note-title" },
        makeIcon(R, "info", 13),
        R.createElement("span", null, t("note.title", "说明"))
      ),
      R.createElement("div", { className: "stl-note-body" }, t("note.body", ""))
    )
  );
}
