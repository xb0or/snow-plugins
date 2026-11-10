/*
 * 用量指标 (Rate Metrics) — Snow App 面板插件
 *
 * 只统计五个指标：RPD、TPD、RPM、ITPM、OTPM；不区分 API 档案，全部按本机合计。
 * 视觉层是数据海报：顶部信息条、等高线背景画布、每行迷你曲线、弹簧指示器。
 *
 * 数据源：usage 元数据域（summary / records，plugin.json 已声明 usage）
 *
 * 区间列
 *   RPD / TPD        区间总量（totalRequests / 输入+输出 token），日均 = 总量 ÷ 区间天数
 *   RPM / ITPM/OTPM  区间均值 = 请求数（输入 / 输出 token）÷ 区间分钟数；峰值 = 分钟分桶最大值（范围 ≤ 36 小时才有）
 *
 * 实时列
 *   RPD / TPD   今天 00:00 起到现在的累计（每 30 秒刷新）
 *   RPM         最近 60 秒请求数（每 5 秒刷新）
 *   ITPM/OTPM   最近 60 秒输入 / 输出 token（每 5 秒刷新）
 *
 * 口径与边界（界面底部有一行同义说明）：
 *   - 数值是本机 Snow App 侧的实际消耗，不含同一密钥下其它客户端的请求；
 *   - 明细在请求完成时落库，流式中的会话不计入滚动窗口，标题区单独显示在途会话；
 *   - 输入 token 含缓存读写；宿主 summary 直接提供，不做二次拆分。
 *
 * 配置：api.storage 键 "view"（{ preset, from, to }），仅记住界面选择。
 * 安全：全部文本经 React 文本节点渲染，不使用 innerHTML；画布只画装饰与曲线。
 */

const STORAGE_KEY = "view";
const TICK_MS = 5000;
const RANGE_REFRESH_MS = 30000;
const TODAY_REFRESH_MS = 30000;
const MINUTE_MS = 60000;
const DAY_MS = 86400000;
const RECORD_PAGE = 500;
const PEAK_RECORD_CAP = 2000;
const PEAK_MAX_SPAN_MS = 36 * 60 * MINUTE_MS;
const SPARK_POINTS = 96;
const PRESETS = ["today", "yesterday", "d7", "d30", "month", "lastMonth", "all", "custom"];

/* ---------- 纯函数（selftest.mjs 直接引用） ---------- */

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

export function pad2(n) {
  return (n < 10 ? "0" : "") + n;
}

/** epoch 毫秒 → 宿主 usage 接口要求的本地时间串 "YYYY-MM-DD HH:MM:SS" */
export function formatLocal(ms) {
  const d = new Date(ms);
  return (
    d.getFullYear() +
    "-" +
    pad2(d.getMonth() + 1) +
    "-" +
    pad2(d.getDate()) +
    " " +
    pad2(d.getHours()) +
    ":" +
    pad2(d.getMinutes()) +
    ":" +
    pad2(d.getSeconds())
  );
}

/** 本地时间串 → epoch 毫秒；容忍 "T" 分隔与缺秒，解析失败返回 NaN */
export function parseLocal(text) {
  if (typeof text === "number" && Number.isFinite(text)) return text;
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/.exec(String(text || ""));
  if (!m) return NaN;
  return new Date(
    Number(m[1]),
    Number(m[2]) - 1,
    Number(m[3]),
    Number(m[4]),
    Number(m[5]),
    m[6] ? Number(m[6]) : 0,
  ).getTime();
}

/** 预设时间范围 → { sinceMs, untilMs }，全部按本地时区的自然日边界 */
export function rangeFor(preset, nowMs) {
  const d = new Date(nowMs);
  const y = d.getFullYear();
  const m = d.getMonth();
  const day = d.getDate();
  const dayStart = new Date(y, m, day).getTime();
  switch (preset) {
    case "yesterday":
      return { sinceMs: new Date(y, m, day - 1).getTime(), untilMs: dayStart - 1000 };
    case "d7":
      return { sinceMs: new Date(y, m, day - 6).getTime(), untilMs: nowMs };
    case "d30":
      return { sinceMs: new Date(y, m, day - 29).getTime(), untilMs: nowMs };
    case "month":
      return { sinceMs: new Date(y, m, 1).getTime(), untilMs: nowMs };
    case "lastMonth":
      return {
        sinceMs: new Date(y, m - 1, 1).getTime(),
        untilMs: new Date(y, m, 0, 23, 59, 59).getTime(),
      };
    case "all":
      return { sinceMs: new Date(1970, 0, 1).getTime(), untilMs: nowMs };
    case "today":
    default:
      return { sinceMs: dayStart, untilMs: nowMs };
  }
}

/** 自定义日期（YYYY-MM-DD）→ 范围；起止顺序非法或日期不可解析时 ok=false */
export function customRange(fromText, toText) {
  const from = parseLocal(String(fromText || "").trim() + " 00:00:00");
  const to = parseLocal(String(toText || "").trim() + " 23:59:59");
  if (!Number.isFinite(from) || !Number.isFinite(to) || from > to) return { ok: false };
  return { ok: true, sinceMs: from, untilMs: to };
}

/** 范围 ≤ 36 小时才拉明细算分钟/秒峰值与迷你曲线 */
export function withinPeakWindow(sinceMs, untilMs) {
  return untilMs - sinceMs <= PEAK_MAX_SPAN_MS;
}

/** usage.summary → 展示用数值；summary 缺失时各字段为 null（区别于真实的 0） */
export function summarizeUsage(summary) {
  if (!summary) {
    return { requests: null, input: null, output: null, total: null };
  }
  const input = num(summary.totalInputTokens);
  const output = num(summary.totalOutputTokens);
  return {
    requests: num(summary.totalRequests),
    input,
    output,
    total: input + output,
  };
}

/** 单位时间速率：total ÷ (span ÷ unit)；跨度非正或数值缺失时返回 null */
export function avgRate(total, spanMs, unitMs) {
  if (total === null || total === undefined || !Number.isFinite(total)) return null;
  if (!Number.isFinite(spanMs) || spanMs <= 0 || !Number.isFinite(unitMs) || unitMs <= 0) return null;
  return total / (spanMs / unitMs);
}

/** 明细：分钟桶峰值（请求 / 输入 / 输出）与分钟序列 */
export function computePeaks(records, sinceMs, untilMs) {
  const minutes = Math.max(1, Math.ceil((untilMs - sinceMs) / MINUTE_MS));
  const series = [];
  for (let i = 0; i < minutes; i++) {
    series.push({ t: sinceMs + i * MINUTE_MS, requests: 0, input: 0, output: 0, total: 0 });
  }
  const items = Array.isArray(records) ? records : [];
  for (const record of items) {
    const t = parseLocal(record && record.createdAt);
    if (!Number.isFinite(t) || t < sinceMs || t > untilMs) continue;
    const minuteIndex = Math.floor((t - sinceMs) / MINUTE_MS);
    if (minuteIndex >= 0 && minuteIndex < minutes) {
      const bucket = series[minuteIndex];
      const input = num(record.inputTokens);
      const output = num(record.outputTokens);
      bucket.requests += 1;
      bucket.input += input;
      bucket.output += output;
      bucket.total += input + output;
    }
  }
  return {
    rpm: series.reduce((max, item) => (item.requests > max ? item.requests : max), 0),
    itpm: series.reduce((max, item) => (item.input > max ? item.input : max), 0),
    otpm: series.reduce((max, item) => (item.output > max ? item.output : max), 0),
    series,
  };
}

/** 分钟序列 → 定长数组（逐桶取最大值，保留尖峰） */
export function downsample(series, key, target) {
  const items = Array.isArray(series) ? series : [];
  if (!items.length) return [];
  const size = Number.isFinite(target) ? Math.max(2, Math.floor(target)) : SPARK_POINTS;
  const step = Math.max(1, Math.ceil(items.length / size));
  const out = [];
  for (let i = 0; i < items.length; i += step) {
    let peak = 0;
    for (let j = i; j < Math.min(i + step, items.length); j++) {
      const value = Number(items[j] && items[j][key]) || 0;
      if (value > peak) peak = value;
    }
    out.push(peak);
  }
  return out;
}

export function fmtInt(value) {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return String(Math.round(value)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

export function fmtCompact(value) {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  const abs = Math.abs(value);
  const trim = (text) => text.replace(/\.0+$/, "").replace(/(\.\d)0$/, "$1");
  if (abs >= 1e9) return trim((value / 1e9).toFixed(2)) + "B";
  if (abs >= 1e6) return trim((value / 1e6).toFixed(2)) + "M";
  if (abs >= 1e4) return trim((value / 1e3).toFixed(1)) + "k";
  return fmtInt(value);
}

export function fmtRate(value, digits) {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  const d = Number.isFinite(digits) ? digits : 2;
  return value >= 100 ? Math.round(value).toString() : value.toFixed(d);
}

export function fmtClock(ms) {
  const d = new Date(ms);
  return pad2(d.getHours()) + ":" + pad2(d.getMinutes()) + ":" + pad2(d.getSeconds());
}

export function fmtDateTime(ms) {
  const d = new Date(ms);
  return (
    pad2(d.getMonth() + 1) + "-" + pad2(d.getDate()) + " " + pad2(d.getHours()) + ":" + pad2(d.getMinutes())
  );
}

/** 视图选择归一化（只记住界面状态，不含任何数据） */
export function normalizeView(raw) {
  const src = raw && typeof raw === "object" ? raw : {};
  const preset = PRESETS.includes(src.preset) ? src.preset : "today";
  const isDate = (text) => /^\d{4}-\d{2}-\d{2}$/.test(String(text || ""));
  return {
    preset,
    from: isDate(src.from) ? src.from : "",
    to: isDate(src.to) ? src.to : "",
  };
}

/* ---------- 画布绘制 ---------- */

function readInk(root) {
  let style = null;
  try {
    style = window.getComputedStyle(root);
  } catch {
    style = null;
  }
  const text = (style && style.color) || "";
  const accent = (style && style.getPropertyValue("--accent-color").trim()) || "";
  return { text: text || "#888888", accent: accent || text || "#888888" };
}

/** 面板背景：等高线场，低透明度，不参与交互 */
function drawField(ctx, width, height, time, pointer, ink) {
  ctx.clearRect(0, 0, width, height);
  ctx.strokeStyle = ink.text;
  ctx.lineWidth = 1;
  ctx.globalAlpha = 0.055;
  const lines = 8;
  const amp = 5 + 7 * (0.5 + 0.5 * Math.sin(time * 0.00018));
  for (let i = 1; i <= lines; i++) {
    const base = (height * i) / (lines + 1);
    ctx.beginPath();
    for (let x = 0; x <= width; x += 6) {
      const phase = x * 0.014 + time * 0.00028 + i * 0.55 + pointer.x * 1.4;
      const y = base + Math.sin(phase) * amp + Math.sin(phase * 0.41 + pointer.y * 2.1) * amp * 0.45;
      if (x === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
}

/** 每行迷你曲线：面积 + 折线；guide 为光标所在点索引 */
function drawSpark(canvas, points, ink, strong, guide) {
  const rect = canvas.getBoundingClientRect();
  const width = Math.max(1, Math.round(rect.width));
  const height = Math.max(1, Math.round(rect.height));
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const pxWidth = Math.round(width * dpr);
  const pxHeight = Math.round(height * dpr);
  if (canvas.width !== pxWidth || canvas.height !== pxHeight) {
    canvas.width = pxWidth;
    canvas.height = pxHeight;
  }
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);
  if (!Array.isArray(points) || points.length < 2) return;
  const max = points.reduce((peak, value) => (value > peak ? value : peak), 1);
  const stepX = width / (points.length - 1);
  const pointY = (value) => height - 1 - (value / max) * (height - 4);
  ctx.beginPath();
  points.forEach((value, index) => {
    const x = index * stepX;
    const y = pointY(value);
    if (index === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.strokeStyle = ink.accent;
  ctx.lineWidth = strong ? 1.6 : 1;
  ctx.lineJoin = "round";
  ctx.globalAlpha = strong ? 0.9 : 0.5;
  ctx.stroke();
  ctx.lineTo(width, height);
  ctx.lineTo(0, height);
  ctx.closePath();
  ctx.globalAlpha = strong ? 0.15 : 0.08;
  ctx.fillStyle = ink.accent;
  ctx.fill();

  if (Number.isInteger(guide) && guide >= 0 && guide < points.length) {
    const gx = guide * stepX;
    const gy = pointY(points[guide]);
    ctx.globalAlpha = 0.35;
    ctx.strokeStyle = ink.text;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(gx, 0);
    ctx.lineTo(gx, height);
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.beginPath();
    ctx.arc(gx, gy, 2.4, 0, Math.PI * 2);
    ctx.fillStyle = ink.accent;
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}

/* ---------- 主组件 ---------- */

export default function RateMetricsPanel({ api, isActive }) {
  const React = window.SnowAppPlugin.React;
  const h = React.createElement;
  const { useState, useEffect, useRef } = React;

  const T = (key, def, values) => api.t(key, { defaultValue: def, values });
  const icons = window.SnowAppPlugin.icons || {};
  const icon = (name, size) => {
    const C = icons[name] || icons[name + "Icon"];
    return C ? h(C, { size: size || 15, strokeWidth: 1.8, "aria-hidden": "true" }) : null;
  };

  const [view, setView] = useState(() => normalizeView(null));
  const [storageReady, setStorageReady] = useState(false);
  const [live, setLive] = useState({ minute: null, at: 0 });
  const [today, setToday] = useState(null);
  const [range, setRange] = useState({ summary: null, peaks: null, spans: null, at: 0 });
  const [rangeState, setRangeState] = useState("loading");
  const [truncated, setTruncated] = useState(0);
  const [inflight, setInflight] = useState({ count: 0, tokens: 0 });
  const [status, setStatus] = useState("loading");
  const [errMsg, setErrMsg] = useState("");
  const [reloadKey, setReloadKey] = useState(0);
  const [focus, setFocus] = useState("rpd");
  const [cursor, setCursor] = useState(null);
  const [panelWidth, setPanelWidth] = useState(0);

  const rootRef = useRef(null);
  const bgRef = useRef(null);
  const trackRef = useRef(null);
  const barRef = useRef(null);
  const sparkRefs = useRef({});

  const { preset, from, to } = view;
  const patchView = (patch) => setView((prev) => ({ ...prev, ...patch }));

  /* 界面状态加载 */
  useEffect(() => {
    let alive = true;
    api.storage
      .getJson(STORAGE_KEY, null)
      .then((raw) => {
        if (!alive) return;
        setView(normalizeView(raw));
        setStorageReady(true);
      })
      .catch(() => {
        if (alive) setStorageReady(true);
      });
    return () => {
      alive = false;
    };
  }, []);

  /* 记住界面选择 */
  useEffect(() => {
    if (!storageReady) return;
    api.storage.setJson(STORAGE_KEY, view).catch(() => {});
  }, [view, storageReady]);

  /* 在途会话（runtime 域实时推送） */
  useEffect(() => {
    let alive = true;
    let sub = null;
    api.metadata
      .subscribe("runtime", (res) => {
        if (!alive) return;
        const runtime = (res && res.domains && res.domains.runtime) || null;
        const sessions = (runtime && runtime.streamingSessions) || [];
        const running = sessions.filter((s) => s && s.isStreaming && !s.isPaused);
        setInflight({
          count: running.length,
          tokens: running.reduce((sum, s) => sum + num(s.tokenCount), 0),
        });
      })
      .then((created) => {
        if (alive) sub = created;
        else created.unsubscribe();
      })
      .catch(() => {});
    return () => {
      alive = false;
      if (sub) sub.unsubscribe();
    };
  }, []);

  /* 实时列：最近 60 秒与 10 秒 */
  useEffect(() => {
    if (isActive === false || !storageReady) return undefined;
    let cancelled = false;
    let busy = false;

    const query = (sinceMs, nowMs) =>
      api.metadata.get(["usage"], {
        params: { since: formatLocal(sinceMs), until: formatLocal(nowMs), limit: 1 },
      });

    const run = async () => {
      if (busy || cancelled) return;
      busy = true;
      const now = Date.now();
      try {
        const res = await query(now - MINUTE_MS, now);
        if (cancelled) return;
        if (res && res.denied && res.denied.usage) {
          setStatus("denied");
          return;
        }
        const usage = res && res.domains && res.domains.usage;
        setLive({ minute: usage ? usage.summary : null, at: now });
        setStatus("ok");
        setErrMsg("");
      } catch (err) {
        if (!cancelled) {
          setStatus("error");
          setErrMsg(String((err && err.message) || err));
        }
      } finally {
        busy = false;
      }
    };

    run();
    const id = setInterval(run, TICK_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [isActive, storageReady, reloadKey]);

  /* 今日累计：RPD / TPD 的实时列 */
  useEffect(() => {
    if (isActive === false || !storageReady) return undefined;
    let cancelled = false;
    let busy = false;

    const run = async () => {
      if (busy || cancelled) return;
      busy = true;
      try {
        const bounds = rangeFor("today", Date.now());
        const res = await api.metadata.get(["usage"], {
          params: { since: formatLocal(bounds.sinceMs), until: formatLocal(bounds.untilMs), limit: 1 },
        });
        if (cancelled) return;
        if (res && res.denied && res.denied.usage) {
          setStatus("denied");
          return;
        }
        const usage = (res && res.domains && res.domains.usage) || null;
        setToday(usage ? usage.summary : null);
      } catch {
        /* 今日累计失败时保留上一次结果，主区仍可用 */
      } finally {
        busy = false;
      }
    };

    run();
    const id = setInterval(run, TODAY_REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [isActive, storageReady, reloadKey]);

  /* 区间列：汇总 + 峰值 + 分钟序列 */
  useEffect(() => {
    if (isActive === false || !storageReady) return undefined;
    let cancelled = false;
    let busy = false;
    let peakCache = null;

    const fetchRecords = async (sinceText, untilText, cap) => {
      const items = [];
      let total = 0;
      let offset = 0;
      while (offset < cap && !cancelled) {
        const params = {
          since: sinceText,
          until: untilText,
          limit: Math.min(RECORD_PAGE, cap - offset),
          offset,
        };
        const res = await api.metadata.get(["usage"], { params });
        if (res && res.denied && res.denied.usage) return { denied: true };
        const usage = (res && res.domains && res.domains.usage) || null;
        const records = usage && usage.records;
        const page = (records && records.items) || [];
        if (records && Number.isFinite(records.total)) total = records.total;
        for (const item of page) items.push(item);
        offset += page.length;
        if (!page.length || items.length >= total) break;
      }
      return { items, total, truncated: total > items.length };
    };

    const run = async () => {
      if (busy || cancelled) return;
      busy = true;
      const now = Date.now();
      try {
        const bounds =
          preset === "custom"
            ? customRange(from, to)
            : Object.assign({ ok: true }, rangeFor(preset, now));
        if (!bounds.ok) {
          setRangeState("invalid");
          setRange({ summary: null, peaks: null, spans: null, at: now });
          return;
        }

        const sinceText = formatLocal(bounds.sinceMs);
        const untilText = formatLocal(bounds.untilMs);
        const res = await api.metadata.get(["usage"], {
          params: { since: sinceText, until: untilText, limit: 1 },
        });
        if (cancelled) return;
        if (res && res.denied && res.denied.usage) {
          setStatus("denied");
          return;
        }

        const usage = (res && res.domains && res.domains.usage) || null;
        const summary = usage ? usage.summary : null;

        let peaks = null;
        let trunc = 0;
        if (withinPeakWindow(bounds.sinceMs, bounds.untilMs)) {
          const pastRange = bounds.untilMs < now - 5 * MINUTE_MS;
          if (!pastRange || !peakCache) {
            const records = await fetchRecords(sinceText, untilText, PEAK_RECORD_CAP);
            if (cancelled) return;
            if (records.denied) {
              setStatus("denied");
              return;
            }
            peakCache = {
              peaks: computePeaks(records.items, bounds.sinceMs, bounds.untilMs),
              truncated: records.truncated ? records.items.length : 0,
            };
          }
          peaks = peakCache.peaks;
          trunc = peakCache.truncated;
        }

        setRange({ summary, peaks, spans: bounds, at: now });
        setTruncated(trunc);
        setRangeState("ok");
        setStatus("ok");
        setErrMsg("");
      } catch (err) {
        if (!cancelled) {
          setRangeState("error");
          setStatus("error");
          setErrMsg(String((err && err.message) || err));
        }
      } finally {
        busy = false;
      }
    };

    run();
    const id = setInterval(run, RANGE_REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [preset, from, to, isActive, storageReady, reloadKey]);

  /* 面板宽度：迷你曲线按实际像素重绘 */
  useEffect(() => {
    const root = rootRef.current;
    if (!root || typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver((entries) => {
      const width = Math.round(entries[0].contentRect.width);
      setPanelWidth((prev) => (prev === width ? prev : width));
    });
    observer.observe(root);
    return () => observer.disconnect();
  }, []);

  /* 背景画布：等高线场 + 指针竖线 */
  useEffect(() => {
    if (isActive === false) return undefined;
    const canvas = bgRef.current;
    const root = rootRef.current;
    if (!canvas || !root) return undefined;
    const ctx = canvas.getContext("2d");
    if (!ctx) return undefined;

    let width = 0;
    let height = 0;
    let raf = 0;
    let running = true;
    const pointer = { x: 0.5, y: 0.4 };
    const ink = readInk(root);
    const reduce =
      typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      width = Math.max(1, Math.round(rect.width));
      height = Math.max(1, Math.round(rect.height));
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      if (reduce) drawField(ctx, width, height, 0, pointer, ink);
    };

    const loop = (time) => {
      if (!running) return;
      drawField(ctx, width, height, time, pointer, ink);
      raf = requestAnimationFrame(loop);
    };

    const onPointer = (event) => {
      const rect = canvas.getBoundingClientRect();
      pointer.x = Math.min(1, Math.max(0, (event.clientX - rect.left) / Math.max(1, rect.width)));
      pointer.y = Math.min(1, Math.max(0, (event.clientY - rect.top) / Math.max(1, rect.height)));
      if (reduce) drawField(ctx, width, height, 0, pointer, ink);
    };

    resize();
    if (!reduce) raf = requestAnimationFrame(loop);
    root.addEventListener("pointermove", onPointer);
    let observer = null;
    if (typeof ResizeObserver !== "undefined") {
      observer = new ResizeObserver(resize);
      observer.observe(canvas);
    }
    return () => {
      running = false;
      cancelAnimationFrame(raf);
      root.removeEventListener("pointermove", onPointer);
      if (observer) observer.disconnect();
    };
  }, [isActive]);

  /* 范围指示器：弹簧跟随激活项 */
  useEffect(() => {
    const track = trackRef.current;
    const bar = barRef.current;
    if (!track || !bar) return undefined;
    let raf = 0;
    let currentX = null;
    let currentW = null;

    const reduce =
      typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    const measure = () => {
      const chip = track.querySelector('[data-active="true"]');
      if (!chip) return;
      const targetX = chip.offsetLeft;
      const targetW = chip.offsetWidth;
      cancelAnimationFrame(raf);
      if (reduce) {
        bar.style.transform = "translateX(" + targetX + "px)";
        bar.style.width = targetW + "px";
        currentX = targetX;
        currentW = targetW;
        return;
      }
      let x = currentX === null ? targetX : currentX;
      let w = currentW === null ? targetW : currentW;
      let vx = 0;
      let vw = 0;
      let last = 0;
      const step = (now) => {
        if (!last) last = now;
        const dt = Math.min(32, now - last) / 16.667;
        last = now;
        vx = (vx + (targetX - x) * 0.24 * dt) * 0.74;
        vw = (vw + (targetW - w) * 0.24 * dt) * 0.74;
        x += vx;
        w += vw;
        bar.style.transform = "translateX(" + x + "px)";
        bar.style.width = w + "px";
        currentX = x;
        currentW = w;
        if (Math.abs(targetX - x) > 0.4 || Math.abs(targetW - w) > 0.4) {
          raf = requestAnimationFrame(step);
        }
      };
      raf = requestAnimationFrame(step);
    };

    measure();
    let observer = null;
    if (typeof ResizeObserver !== "undefined") {
      observer = new ResizeObserver(measure);
      observer.observe(track);
    }
    return () => {
      cancelAnimationFrame(raf);
      if (observer) observer.disconnect();
    };
  }, [preset, storageReady]);

  /* ---------- 派生值 ---------- */

  const rangeSum = summarizeUsage(range.summary);
  const todaySum = summarizeUsage(today);
  const minuteSum = summarizeUsage(live.minute);
  const spans = range.spans;
  const spanMs = spans ? spans.untilMs - spans.sinceMs : 0;
  const peaks = range.peaks;
  const series = peaks ? peaks.series : null;

  const perMinute = T("unit.perMinute", "/分");
  const perDay = T("unit.perDay", "/日");
  const withUnit = (text, unit) => (text === "—" ? text : text + unit);
  const perDayValue = (value) => (value === null ? "—" : fmtInt(value) + perDay);

  const rows = [
    {
      key: "rpd",
      abbr: "RPD",
      name: T("metric.rpd", "每日请求"),
      primary: fmtInt(rangeSum.requests),
      unit: "",
      seriesKey: "requests",
      cursorFormat: (value) => fmtInt(value),
      meta: [
        { label: T("cell.perDay", "日均"), value: perDayValue(avgRate(rangeSum.requests, spanMs, DAY_MS)) },
        { label: T("cell.today", "今日"), value: fmtInt(todaySum.requests) },
      ],
    },
    {
      key: "tpd",
      abbr: "TPD",
      name: T("metric.tpd", "每日 Token"),
      primary: fmtCompact(rangeSum.total),
      unit: "",
      seriesKey: "total",
      cursorFormat: (value) => fmtCompact(value),
      meta: [
        { label: T("cell.perDay", "日均"), value: perDayValue(avgRate(rangeSum.total, spanMs, DAY_MS)) },
        { label: T("cell.today", "今日"), value: fmtCompact(todaySum.total) },
      ],
    },
    {
      key: "rpm",
      abbr: "RPM",
      name: T("metric.rpm", "每分钟请求"),
      primary: fmtRate(avgRate(rangeSum.requests, spanMs, MINUTE_MS)),
      unit: perMinute,
      seriesKey: "requests",
      cursorFormat: (value) => withUnit(fmtInt(value), perMinute),
      meta: [
        { label: T("cell.peak", "峰值"), value: withUnit(fmtInt(peaks ? peaks.rpm : null), perMinute) },
        { label: T("cell.live", "实时"), value: withUnit(fmtInt(minuteSum.requests), perMinute) },
      ],
    },
    {
      key: "itpm",
      abbr: "ITPM",
      name: T("metric.itpm", "输入 Token/分"),
      primary: fmtCompact(avgRate(rangeSum.input, spanMs, MINUTE_MS)),
      unit: perMinute,
      seriesKey: "input",
      cursorFormat: (value) => withUnit(fmtCompact(value), perMinute),
      meta: [
        { label: T("cell.peak", "峰值"), value: withUnit(fmtCompact(peaks ? peaks.itpm : null), perMinute) },
        { label: T("cell.live", "实时"), value: withUnit(fmtCompact(minuteSum.input), perMinute) },
      ],
    },
    {
      key: "otpm",
      abbr: "OTPM",
      name: T("metric.otpm", "输出 Token/分"),
      primary: fmtCompact(avgRate(rangeSum.output, spanMs, MINUTE_MS)),
      unit: perMinute,
      seriesKey: "output",
      cursorFormat: (value) => withUnit(fmtCompact(value), perMinute),
      meta: [
        { label: T("cell.peak", "峰值"), value: withUnit(fmtCompact(peaks ? peaks.otpm : null), perMinute) },
        { label: T("cell.live", "实时"), value: withUnit(fmtCompact(minuteSum.output), perMinute) },
      ],
    },
  ];

  /* 指针光标：把 x 位置映射到分钟序列索引，各指标同时读出该点数值 */
  const sparkByKey = {};
  if (series) {
    for (const row of rows) sparkByKey[row.key] = downsample(series, row.seriesKey, SPARK_POINTS);
  }
  const cursorIndex = cursor ? cursor.index : -1;
  for (const row of rows) {
    const points = sparkByKey[row.key];
    const value = points && cursorIndex >= 0 ? points[cursorIndex] : undefined;
    row.meta.push({
      label: T("cell.cursor", "光标"),
      value: value === undefined ? "—" : row.cursorFormat(value),
    });
  }

  const cursorPoints = sparkByKey.rpd ? sparkByKey.rpd.length : 0;
  const cursorStepMs =
    series && series.length ? Math.max(1, Math.ceil(series.length / SPARK_POINTS)) * MINUTE_MS : 0;

  const handlePointer = (event) => {
    const canvas = sparkRefs.current.rpd;
    if (!series || !canvas || !cursorPoints) return;
    const rect = canvas.getBoundingClientRect();
    if (!rect.width) return;
    const ratio = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
    const index = Math.round(ratio * (cursorPoints - 1));
    setCursor((prev) =>
      prev && prev.index === index ? prev : { index, time: series[0].t + index * cursorStepMs },
    );
  };

  const clearPointer = () => setCursor(null);

  /* 迷你曲线：画在每行的画布上，光标位置带竖线与圆点 */
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const ink = readInk(root);
    for (const row of rows) {
      const canvas = sparkRefs.current[row.key];
      if (!canvas) continue;
      drawSpark(canvas, sparkByKey[row.key] || [], ink, row.key === focus, cursorIndex);
    }
  }, [range.peaks, focus, panelWidth, cursor]);

  const rangeText = spans ? fmtDateTime(spans.sinceMs) + " → " + fmtDateTime(spans.untilMs) : "";

  const banner = () => {
    if (status === "denied") {
      return h(
        "div",
        { className: "srl-banner", key: "denied" },
        icon("TriangleAlert", 14),
        h(
          "span",
          null,
          T("state.denied", 'usage 域读取被拒：请在 plugin.json 的 privacy 中声明 "usage" 后重新安装插件。'),
        ),
      );
    }
    if (status === "error") {
      return h(
        "div",
        { className: "srl-banner srl-banner-bad", key: "error" },
        icon("TriangleAlert", 14),
        h("span", null, T("state.error", "读取用量失败：{{error}}", { error: errMsg || "unknown" })),
        h(
          "button",
          { className: "srl-retry", onClick: () => setReloadKey((key) => key + 1) },
          T("state.retry", "重试"),
        ),
      );
    }
    return null;
  };

  return h(
    "div",
    { className: "srl-root", ref: rootRef },
    h("canvas", { className: "srl-bg", ref: bgRef, "aria-hidden": "true" }),
    h("div", { className: "srl-veil", "aria-hidden": "true" }),
    h(
      "div",
      { className: "srl-flow" },
      h(
        "header",
        { className: "srl-head", "aria-label": T("header.title", "用量指标") },
        h(
          "div",
          { className: "srl-eyebrow" },
          h("span", null, T("poster.kicker", "本机用量")),
          h("span", { className: "srl-eyebrow-sep" }, "/"),
          h(
            "span",
            { className: "srl-eyebrow-range" },
            rangeText || T("state.loading", "正在读取用量…"),
          ),
        ),
        h(
          "div",
          { className: "srl-status" },
          h("span", { className: "srl-pulse" + (inflight.count ? " is-hot" : ""), "aria-hidden": "true" }),
          h(
            "span",
            { className: "srl-status-text" },
            inflight.count
              ? T("header.inflight", "在途 {{count}} 会话 · {{tokens}} tok", {
                  count: inflight.count,
                  tokens: fmtCompact(inflight.tokens),
                })
              : T("header.inflightNone", "无在途会话"),
          ),
          h(
            "button",
            {
              className: "srl-refresh",
              onClick: () => setReloadKey((key) => key + 1),
              title: T("header.refresh", "刷新"),
              "aria-label": T("header.refresh", "刷新"),
            },
            icon("RefreshCw", 13),
          ),
        ),
      ),
      banner(),
      h(
        "div",
        { className: "srl-rail" },
        h(
          "div",
          { className: "srl-rail-track", ref: trackRef, role: "group", "aria-label": T("range.title", "统计范围") },
          h("span", { className: "srl-rail-bar", ref: barRef, "aria-hidden": "true" }),
          PRESETS.map((key) =>
            h(
              "button",
              {
                key,
                className: "srl-chip",
                "data-active": preset === key ? "true" : "false",
                "aria-pressed": preset === key,
                onClick: () => {
                  if (key === "custom" && (!from || !to)) {
                    const todayText = formatLocal(Date.now()).slice(0, 10);
                    patchView({ preset: key, from: from || todayText, to: to || todayText });
                    return;
                  }
                  patchView({ preset: key });
                },
              },
              T("range." + key, key),
            ),
          ),
        ),
        preset === "custom"
          ? h(
              "div",
              { className: "srl-dates" },
              h(
                "label",
                { className: "srl-field" },
                h("span", { className: "srl-field-label" }, T("range.from", "起始日期")),
                h("input", {
                  className: "srl-input",
                  type: "date",
                  value: from,
                  onChange: (event) => patchView({ from: event.target.value }),
                }),
              ),
              h(
                "label",
                { className: "srl-field" },
                h("span", { className: "srl-field-label" }, T("range.to", "结束日期")),
                h("input", {
                  className: "srl-input",
                  type: "date",
                  value: to,
                  onChange: (event) => patchView({ to: event.target.value }),
                }),
              ),
            )
          : null,
      ),
      h(
        "div",
        { className: "srl-cursor" },
        h("span", { className: "srl-cursor-label" }, T("cell.cursor", "光标")),
        h("span", { className: "srl-cursor-time" }, cursor ? fmtClock(cursor.time).slice(0, 5) : "—"),
      ),
      rangeState === "invalid"
        ? h(
            "div",
            { className: "srl-hint srl-hint-bad" },
            T("range.invalid", "请选择合法的日期范围：起始日期不能晚于结束日期。"),
          )
        : null,
      h(
        "ol",
        { className: "srl-bands", onPointerMove: handlePointer, onPointerLeave: clearPointer },
        rows.map((row, index) =>
          h(
            "li",
            {
              key: row.key,
              className: "srl-band" + (row.key === focus ? " is-focus" : ""),
              onPointerEnter: () => setFocus(row.key),
            },
            h(
              "button",
              {
                className: "srl-band-main",
                onClick: () => setFocus(row.key),
                "aria-pressed": row.key === focus,
              },
              h("span", { className: "srl-band-index" }, pad2(index + 1)),
              h("span", { className: "srl-band-abbr" }, row.abbr),
              h("span", { className: "srl-band-name" }, row.name),
              h(
                "span",
                { className: "srl-band-value" },
                row.primary,
                row.unit ? h("i", { className: "srl-band-unit" }, row.unit) : null,
              ),
            ),
            h(
              "div",
              { className: "srl-band-meta" },
              row.meta.map((cell) =>
                h(
                  "span",
                  { className: "srl-meta-cell", key: cell.label },
                  h("em", null, cell.label),
                  h("b", null, cell.value),
                ),
              ),
            ),
            h("canvas", {
              className: "srl-spark",
              "aria-hidden": "true",
              ref: (element) => {
                sparkRefs.current[row.key] = element;
              },
            }),
          ),
        ),
      ),
      !peaks && rangeState === "ok"
        ? h("div", { className: "srl-hint" }, T("hint.noPeaks", "范围超过 36 小时，不计算分钟与秒峰值。"))
        : null,
      truncated
        ? h(
            "div",
            { className: "srl-hint" },
            T("hint.truncated", "明细超过 {{n}} 条，峰值为已拉取记录的下界。", { n: fmtInt(truncated) }),
          )
        : null,
      h(
        "footer",
        { className: "srl-foot" },
        h("span", null, T("footer.note", "区间均值按选定跨度折算；按请求完成时刻记账，同一密钥下其它客户端的请求不计入。")),
        h("span", { className: "srl-foot-mark" }, "SNOW / LOCAL"),
      ),
    ),
  );
}