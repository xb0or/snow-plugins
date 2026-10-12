/*
 * 成本核算看板 (Usage Cost) — Snow App 面板插件
 *
 * 数据源：usage 元数据域（summary / daily / models）+ projects 域（项目下拉选项）。
 * 时间筛选对齐官方用量页口径：起始日 00:00:00 ~ 结束日 23:59:59，预设今天/昨天/近7天/近30天/本月/上月/自定义。
 * 成本口径（daily/models 维度无 effective 拆分，采用近似）：
 *   非缓存输入 = totalInputTokens - totalCacheReadInputTokens（不足为 0）
 *   缓存读     = totalCacheReadInputTokens
 *   缓存写     = totalCacheCreationInputTokens
 *   输出       = totalOutputTokens
 *   单价单位：元 / 百万 token
 *   每日成本按各 token 类别的全期混合单价近似折算（daily 无按模型拆分）。
 * 价格持久化：api.storage 键 "prices"（JSON：currency / defaultPrice / models）。
 * 安全：全部内容经 React 文本节点渲染，不使用 innerHTML，无 XSS 注入面。
 */

const PRICES_KEY = "prices";
const FILTER_KEY = "filter";
const POLL_MS = 5000;
const PROJECTS_POLL_MS = 60000;
const CATS = [
  { key: "nonCachedInput", labelKey: "cat.nonCachedInput", label: "非缓存输入" },
  { key: "cacheRead", labelKey: "cat.cacheRead", label: "缓存读" },
  { key: "cacheWrite", labelKey: "cat.cacheWrite", label: "缓存写" },
  { key: "output", labelKey: "cat.output", label: "输出" },
];
const ZERO_P = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };

/* 内置估算单价（每 100 万 token）：仅作兜底参考，可在「单价设置」按模型覆盖；规则自上而下首个命中生效 */
const BUILTIN_DEFAULT_PRICE = { input: 2, cacheRead: 0.2, cacheWrite: 4, output: 6 };
/* 价格来源分级（2026-10-11 查证）：
   官方刊例核实：GLM-5.3 / GLM-5.3-Flash / DeepSeek V4 / Qwen3.8-Max（人民币）；
   OpenRouter 实时价按当日汇率 USD×6.7069 换算：gpt-6 系（astra / sol / luna）与 claude fable 系；
   其余为中转站常见价位估算，建议按实际账单校准。规则自上而下首个命中生效 */
const BUILTIN_PRICE_RULES = [
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
  { re: /spark|kimi|grok/i, price: { input: 1, cacheRead: 0.1, cacheWrite: 2, output: 4 } },
];
/* 价格来源 → i18n 键与中文兜底 */
const SOURCE_LABEL_KEY = { custom: "src.custom", builtin: "src.builtin", default: "src.default" };
const SOURCE_LABEL_DEF = { custom: "自定义", builtin: "内置估算", default: "默认价" };

function builtinPriceFor(model) {
  const s = String(model || "").toLowerCase();
  for (const r of BUILTIN_PRICE_RULES) if (r.re.test(s)) return r.price;
  return null;
}

/* ---------- i18n 与界面语言 ---------- */
/* UI_LOCALE / T 在组件挂载时由 api 注入；模块级工具函数（fmtInt 等）依赖 UI_LOCALE。
   T(key, defaultValue, values) 经 api.t 取词，语言包缺失时回退 defaultValue（中文）。 */
let UI_LOCALE = "zh-CN";
let T = (key, def) => def;

/** 界面语言 → 默认货币符号（中文系 ¥，其余 $）；仅用于无用户配置时的默认值 */
function defaultCurrencyFor(locale) {
  return /^zh/i.test(String(locale || "")) ? "¥" : "$";
}

/* ---------- 纯工具函数 ---------- */

function h(tag, props) {
  const R = window.SnowAppPlugin.React;
  const children = Array.prototype.slice.call(arguments, 2).flat(Infinity).filter(
    (c) => c !== null && c !== undefined && c !== false
  );
  return R.createElement(tag, props || null, children.length ? children : null);
}

function icon(name, size) {
  const C = window.SnowAppPlugin.icons && window.SnowAppPlugin.icons[name];
  return C ? window.SnowAppPlugin.React.createElement(C, { size: size || 14 }) : null;
}

/** 元素宽度（ResizeObserver 感知面板宽度变化；不可用时为 0，表示「未知」，由调用方按默认密度处理） */
function useElementWidth() {
  const { useState, useEffect, useRef } = window.SnowAppPlugin.React;
  const ref = useRef(null);
  const [width, setWidth] = useState(0);

  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const read = () => {
      const w = el.clientWidth || 0;
      /* 仅在宽度实际变化时更新，避免 ResizeObserver 抖动引发多余渲染 */
      setWidth((prev) => (prev === w ? prev : w));
    };
    read();
    if (typeof ResizeObserver === "undefined") return undefined;
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return [ref, width];
}

function clamp0(n) {
  return typeof n === "number" && isFinite(n) && n > 0 ? n : 0;
}

/** token 类别拆分（近似口径） */
function splitTokens(rec) {
  const ti = clamp0(rec.totalInputTokens);
  const cr = clamp0(rec.totalCacheReadInputTokens);
  const cw = clamp0(rec.totalCacheCreationInputTokens);
  const out = clamp0(rec.totalOutputTokens);
  return {
    nonCachedInput: Math.max(ti - cr, 0),
    cacheRead: cr,
    cacheWrite: cw,
    output: out,
  };
}

/** 按单价（元/百万 token）计算成本 */
function costOf(rec, price) {
  const t = splitTokens(rec);
  let c = 0;
  for (const cat of CATS) c += t[cat.key] * (clamp0(price[cat.key]) || 0);
  return c / 1e6;
}

/** 人类可读 token：1.23B / 45.6M / 789k */
function fmtTokens(n) {
  if (typeof n !== "number" || !isFinite(n)) return "0";
  if (n >= 1e9) return (n / 1e9).toFixed(2) + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
  if (n >= 1e3) return Math.round(n / 1e3) + "k";
  return String(Math.round(n));
}

function fmtInt(n) {
  if (typeof n !== "number" || !isFinite(n)) return "0";
  return n.toLocaleString(UI_LOCALE);
}

/** 成本展示：小数值多保留几位，避免全显示 0.00 */
function fmtCost(cur, c) {
  if (typeof c !== "number" || !isFinite(c) || c === 0) return cur + "0";
  let s;
  if (c < 0.01) s = c.toFixed(4);
  else if (c < 1) s = c.toFixed(3);
  else if (c < 100) s = c.toFixed(2);
  else s = c.toFixed(1);
  return cur + s;
}

function fmtPct(num, den) {
  if (!den) return "0%";
  return ((num / den) * 100).toFixed(2) + "%";
}

/** Date → yyyy-MM-dd（本地时区） */
function isoDate(d) {
  const p = (x) => String(x).padStart(2, "0");
  return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate());
}

/* 时间预设（对齐官方用量页：今天 / 昨天 / 近 7 天 / 近 30 天 / 本月 / 上月 / 自定义） */
const PRESETS = [
  { key: "today", labelKey: "preset.today", label: "今天" },
  { key: "yesterday", labelKey: "preset.yesterday", label: "昨天" },
  { key: "d7", labelKey: "preset.d7", label: "近 7 天" },
  { key: "d30", labelKey: "preset.d30", label: "近 30 天" },
  { key: "month", labelKey: "preset.month", label: "本月" },
  { key: "lastMonth", labelKey: "preset.lastMonth", label: "上月" },
  { key: "custom", labelKey: "preset.custom", label: "自定义" },
];

/** 预设 → 起止日期（yyyy-MM-dd，含端点；custom 用 fallback 当前输入） */
function presetRange(p, fallbackFrom, fallbackTo) {
  const now = new Date();
  const today = isoDate(now);
  if (p === "today") return { from: today, to: today };
  if (p === "yesterday") {
    const d = new Date(now);
    d.setDate(d.getDate() - 1);
    const s = isoDate(d);
    return { from: s, to: s };
  }
  if (p === "d7" || p === "d30") {
    const n = p === "d7" ? 7 : 30;
    const d = new Date(now);
    d.setDate(d.getDate() - (n - 1));
    return { from: isoDate(d), to: today };
  }
  if (p === "month") return { from: isoDate(new Date(now.getFullYear(), now.getMonth(), 1)), to: today };
  if (p === "lastMonth") {
    return {
      from: isoDate(new Date(now.getFullYear(), now.getMonth() - 1, 1)),
      to: isoDate(new Date(now.getFullYear(), now.getMonth(), 0)),
    };
  }
  return { from: fallbackFrom || today, to: fallbackTo || today };
}

function normalizePrices(raw, locale) {
  const num = (v) => {
    const n = Number(v);
    return isFinite(n) && n >= 0 ? n : 0;
  };
  const mp = (o) => {
    const r = {};
    for (const k of ["input", "cacheRead", "cacheWrite", "output"]) r[k] = num(o && o[k]);
    return r;
  };
  const models = {};
  if (raw && raw.models && typeof raw.models === "object") {
    for (const m of Object.keys(raw.models)) models[m] = mp(raw.models[m]);
  }
  return {
    v: 1,
    currency: typeof (raw && raw.currency) === "string" && raw.currency ? raw.currency : defaultCurrencyFor(locale),
    defaultPrice: raw ? mp(raw.defaultPrice) : mp(BUILTIN_DEFAULT_PRICE),
    models,
  };
}

function priceFor(prices, model) {
  const custom = prices.models && prices.models[model];
  if (custom) return { price: custom, source: "custom" };
  const builtin = builtinPriceFor(model);
  if (builtin) return { price: builtin, source: "builtin" };
  const d = prices.defaultPrice || ZERO_P;
  const hasAny = d.input || d.cacheRead || d.cacheWrite || d.output;
  return { price: hasAny ? d : BUILTIN_DEFAULT_PRICE, source: "default" };
}

/** CSV 字段转义：含逗号/引号/换行时加引号 */
function csvEsc(v) {
  const s = String(v === null || v === undefined ? "" : v);
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

/** 型号名归一化：小写并去掉全部非字母数字（"claude-fable-5-1" 与 "claude-fable-5.1" 归一后相同） */
function normModelName(s) {
  return String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

/* 项目筛选聚合（修复：宿主 usage 域的 directoryId 只作用于 records，summary/daily/models 均不接收，
   故按项目筛选时改由 records 聚合出 summary/daily/models，口径与宿主 SQL 对齐）：
   - 错误口径：宿主为 status = 'error'（严格），records.status 同源，直接比对
   - 非缓存输入：宿主 summary 为 SUM(input_tokens) - SUM(cache_read_input_tokens)（下限 0），按记录逐条截断
   - 成本口径：沿用本插件 models 明细 + 价格表的计算方式，保证与未筛选时一致 */
const RECORD_STATUS_ERROR = "error";

/** 逐条记录聚合（records 已按 created_at DESC 返回，同一天记录相邻） */
function aggregateUsageRecords(records) {
  const empty = {
    totalRequests: 0, errorRequests: 0, totalInputTokens: 0, totalOutputTokens: 0,
    totalCacheCreationInputTokens: 0, totalCacheReadInputTokens: 0,
  };
  const summary = { ...empty };
  const byDate = new Map();
  const byModel = new Map();

  for (const r of records) {
    const rec = r || {};
    const input = clamp0(rec.inputTokens);
    const cacheRead = clamp0(rec.cacheReadInputTokens);
    const cacheWrite = clamp0(rec.cacheCreationInputTokens);
    const output = clamp0(rec.outputTokens);
    const isError = String(rec.status || "") === RECORD_STATUS_ERROR ? 1 : 0;
    const date = String(rec.createdAt || "").slice(0, 10);
    const model = String(rec.model || "");

    summary.totalRequests += 1;
    summary.errorRequests += isError;
    summary.totalInputTokens += input;
    summary.totalOutputTokens += output;
    summary.totalCacheCreationInputTokens += cacheWrite;
    summary.totalCacheReadInputTokens += cacheRead;

    if (date) {
      const d = byDate.get(date) || { ...empty, date };
      d.totalRequests += 1;
      d.errorRequests += isError;
      d.totalInputTokens += input;
      d.totalOutputTokens += output;
      d.totalCacheCreationInputTokens += cacheWrite;
      d.totalCacheReadInputTokens += cacheRead;
      byDate.set(date, d);
    }
    if (model) {
      const m = byModel.get(model) || { ...empty, model };
      m.totalRequests += 1;
      m.errorRequests += isError;
      m.totalInputTokens += input;
      m.totalOutputTokens += output;
      m.totalCacheCreationInputTokens += cacheWrite;
      m.totalCacheReadInputTokens += cacheRead;
      byModel.set(model, m);
    }
  }

  return {
    summary,
    daily: Array.from(byDate.values()).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0)),
    models: Array.from(byModel.values()),
  };
}

/** 按时间倒序分页拉取 records（records 无时间参数，但按 created_at DESC 排序）：
    早于 since 即停止翻页；晚于 until 的记录跳过（如「上月」等历史区间，更新的记录需剔除）。
    返回 { items, truncated }；usage 域被拒绝时抛出带 denied 标记的错误，交由调用方提示。 */
async function fetchRecordsInRange(api, params, since, until) {
  const PAGE = 500;
  const HARD_CAP = 40000; // 安全上限：40000 条约占 7MB 内存，避免异常数据拖垮面板
  const items = [];
  let offset = 0;
  let truncated = false;

  for (;;) {
    const res = await api.metadata.get(["usage"], { params: { ...params, limit: PAGE, offset } });
    if (res && res.denied && res.denied.usage) {
      const err = new Error("usage domain denied");
      err.deniedUsage = true;
      throw err;
    }
    const usage = res && res.domains && res.domains.usage;
    const page = usage && usage.records && Array.isArray(usage.records.items) ? usage.records.items : [];
    if (!page.length) break;

    let reachedBoundary = false;
    for (const r of page) {
      const createdAt = String((r && r.createdAt) || "");
      /* 晚于结束边界：跳过（排序为 DESC，这些记录出现在页面前部） */
      if (until && createdAt && createdAt > until) continue;
      /* 早于起始边界：后续记录更早，直接停止 */
      if (since && createdAt && createdAt < since) { reachedBoundary = true; break; }
      items.push(r);
    }
    if (reachedBoundary) break;
    if (page.length < PAGE) break; // 已到末尾

    offset += PAGE;
    if (items.length >= HARD_CAP) { truncated = true; break; }
  }

  return { items, truncated };
}

/** 拉取某项目下出现过的档案名（用于按项目收窄档案下拉选项，使「选项 = 可用值」）：
    records 无 GROUP BY 能力，故分页扫描该项目记录并按出现次数汇总；受 HARD_CAP 限制，超限返回已收集部分。
    同时返回该项目记录总数（count），供缓存做「数据是否变化」的廉价校验。 */
async function fetchProjectProfileNames(api, directoryId) {
  const PAGE = 500;
  const HARD_CAP = 40000;
  const counts = new Map();
  let offset = 0;
  let scanned = 0;
  let truncated = false;
  let total = null;

  for (;;) {
    const res = await api.metadata.get(["usage"], { params: { directoryId, limit: PAGE, offset } });
    if (res && res.denied && res.denied.usage) {
      const err = new Error("usage domain denied");
      err.deniedUsage = true;
      throw err;
    }
    const usage = res && res.domains && res.domains.usage;
    const page = usage && usage.records && Array.isArray(usage.records.items) ? usage.records.items : [];
    if (total === null && usage && usage.records && typeof usage.records.total === "number") {
      total = usage.records.total;
    }
    if (!page.length) break;

    for (const r of page) {
      const name = String((r && r.apiProfileName) || "").trim();
      if (name) counts.set(name, (counts.get(name) || 0) + 1);
    }
    scanned += page.length;
    if (page.length < PAGE) break; // 已到末尾

    offset += PAGE;
    if (scanned >= HARD_CAP) { truncated = true; break; }
  }

  return {
    /* 按记录量降序，与宿主 listUsageProfileNames 的排序口径一致 */
    names: Array.from(counts.entries()).sort((a, b) => b[1] - a[1]).map(([n]) => n),
    truncated,
    count: total === null ? scanned : total,
  };
}

/* 项目档案名缓存：档案集合是「该项目历史用过的档案」，变化很慢，故按项目缓存并设 TTL。
   目的：项目筛选下 5s 轮询不再重复全量扫描该项目 records（原先每轮都扫，大项目达 7 页 IPC）。
   失效条件：TTL 到期、记录总数变化（新增/删除记录后档案名可能变化）、或显式 invalidate。
   模块级存储：面板重挂载（切标签/重开）后仍可复用，不因组件卸载而失效。 */
const DIR_PROFILES_TTL_MS = 10 * 60 * 1000; // 10 分钟
const DIR_PROFILES_CACHE_MAX = 50; // 项目数上限保护，超出时淘汰最旧条目
const dirProfilesCache = new Map(); // directoryId -> { names, truncated, at, count }
const dirProfilesInflight = new Map(); // directoryId -> Promise（并发去重）

function getCachedDirProfiles(dir) {
  const hit = dirProfilesCache.get(dir);
  if (!hit) return null;
  if (Date.now() - hit.at > DIR_PROFILES_TTL_MS) {
    dirProfilesCache.delete(dir);
    return null;
  }
  return hit;
}

/** 使某项目的档案名缓存失效（用户点「立即刷新」时调用，便于新档案名立刻出现） */
function invalidateDirProfiles(dir) {
  if (dir) dirProfilesCache.delete(dir);
}

function putDirProfilesCache(dir, value) {
  dirProfilesCache.set(dir, value);
  if (dirProfilesCache.size > DIR_PROFILES_CACHE_MAX) {
    /* Map 保持插入顺序，删除最早的条目 */
    const oldest = dirProfilesCache.keys().next();
    if (!oldest.done) dirProfilesCache.delete(oldest.value);
  }
}

/** 带缓存的档案名拉取。
    缓存有效期内先用 limit=1 取一次记录总数做廉价校验（1 次 IPC）：
    总数未变 → 直接复用缓存（不扫描）；总数变化 → 重新全量扫描并更新缓存。 */
async function fetchProjectProfileNamesCached(api, directoryId) {
  const hit = getCachedDirProfiles(directoryId);
  if (hit) {
    const probe = await api.metadata.get(["usage"], { params: { directoryId, limit: 1, offset: 0 } });
    const usage = probe && probe.domains && probe.domains.usage;
    const total = usage && usage.records && typeof usage.records.total === "number" ? usage.records.total : null;
    /* 校验请求失败或宿主未返回 total：保守复用缓存（避免每轮退化为全量扫描） */
    if (total === null || total === hit.count) {
      return { names: hit.names, truncated: hit.truncated };
    }
    dirProfilesCache.delete(directoryId); // 数据已变化，丢弃旧缓存
  }

  const pending = dirProfilesInflight.get(directoryId);
  if (pending) return pending;

  const p = fetchProjectProfileNames(api, directoryId).then(
    (res) => {
      dirProfilesInflight.delete(directoryId);
      putDirProfilesCache(directoryId, { names: res.names, truncated: res.truncated, at: Date.now(), count: res.count });
      return res;
    },
    (err) => {
      dirProfilesInflight.delete(directoryId);
      throw err;
    }
  );
  dirProfilesInflight.set(directoryId, p);
  return p;
}

/* ---------- 自定义下拉（issue #4） ----------
   原生 select 的展开列表由系统渲染，深色主题下选项不可见；
   改为 button 触发器 + 绝对定位面板结构，配色接入宿主主题 CSS 变量（style.css 兜底回退值）。 */
function UcxSelect({ value, onChange, options, title }) {
  const { useState, useRef, useEffect } = window.SnowAppPlugin.React;
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const onDocMouseDown = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    };
    const onKeyDown = (e) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDocMouseDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onDocMouseDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const current = options.find((o) => o.value === value);
  return h("div", { className: "ucx-select", ref, title },
    h("button", {
      type: "button",
      className: "ucx-select-trigger",
      onClick: () => setOpen((v) => !v),
      "aria-haspopup": "listbox",
      "aria-expanded": open,
    },
      h("span", { className: "ucx-select-trigger-label" }, current ? current.label : value),
      h("span", { className: "ucx-select-trigger-icon" + (open ? " ucx-select-trigger-icon-open" : "") },
        icon("ChevronDown", 14))
    ),
    open
      ? h("div", { className: "ucx-select-dropdown", role: "listbox" },
          options.map((o) =>
            h("div", {
              key: o.value,
              className: "ucx-select-item" + (o.value === value ? " ucx-select-item-active" : ""),
              role: "option",
              "aria-selected": o.value === value,
              onClick: () => {
                setOpen(false);
                if (o.value !== value) onChange(o.value);
              },
            }, o.label)
          )
        )
      : null
  );
}

/* ---------- 主组件 ---------- */

export default function UsageCostPanel({ api }) {
  const { useState, useEffect, useRef, useCallback } = window.SnowAppPlugin.React;

  /* 注入界面语言与取词函数（每次渲染刷新，供模块级工具函数使用） */
  UI_LOCALE = api.locale || "zh-CN";
  T = (key, def, values) => api.t(key, { defaultValue: def, values });

  const [preset, setPreset] = useState("d30");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [profileFilter, setProfileFilter] = useState("");
  const [dirFilter, setDirFilter] = useState("");
  const [projects, setProjects] = useState([]);
  const [profileNames, setProfileNames] = useState([]);
  /* 项目维度的档案名：{ dir, names }；dir 与当前 dirFilter 不一致表示该项目尚未扫描完成（names 为 null） */
  const [dirProfiles, setDirProfiles] = useState({ dir: "", names: null });
  const [filterMsg, setFilterMsg] = useState(null);
  const [refreshTick, setRefreshTick] = useState(0);
  const [usage, setUsage] = useState(null);
  const [truncated, setTruncated] = useState(false);
  const [loading, setLoading] = useState(true);
  const [errMsg, setErrMsg] = useState(null);
  const [lastUpdated, setLastUpdated] = useState(null);
  /* 筛选条件是否已从存储恢复：未恢复前禁止持久化，避免默认值覆盖已保存的筛选（修复 2） */
  const [hydrated, setHydrated] = useState(false);

  const [prices, setPrices] = useState(() => normalizePrices(null, UI_LOCALE));
  const [priceEdit, setPriceEdit] = useState(null); // 字符串态编辑缓冲
  const [saveMsg, setSaveMsg] = useState(null); // { text, ok }
  const [syncing, setSyncing] = useState(false);

  const [includeDaily, setIncludeDaily] = useState(false);
  const [actionMsg, setActionMsg] = useState(null); // 导出/复制反馈 { text, ok }

  const aliveRef = useRef(true);
  useEffect(() => () => { aliveRef.current = false; }, []);

  /* 图表容器宽度：用于按可用宽度自适应标签密度（修复 4） */
  const [chartRef, chartWidthPx] = useElementWidth();

  /* 价格加载（挂载一次） */
  useEffect(() => {
    let done = false;
    (async () => {
      let raw = null;
      try {
        raw = await api.storage.getJson(PRICES_KEY, null);
      } catch (e) {
        api.log(T("log.readPrices", "读取价格配置失败:"), e);
      }
      if (done || !aliveRef.current) return;
      const p = normalizePrices(raw, UI_LOCALE);
      setPrices(p);
      setPriceEdit(toEdit(p));
    })();
    return () => { done = true; };
  }, [api]);

  /* 筛选条件恢复（挂载一次；相对预设按当天重算起止，custom 恢复保存的日期） */
  useEffect(() => {
    let done = false;
    (async () => {
      let saved = null;
      try {
        saved = await api.storage.getJson(FILTER_KEY, null);
      } catch (e) {
        api.log(T("log.readFilter", "读取筛选配置失败:"), e);
      }
      if (done || !aliveRef.current) return;
      if (saved) {
        const sp = typeof saved.preset === "string" && PRESETS.some((x) => x.key === saved.preset) ? saved.preset : null;
        const sf = typeof saved.dateFrom === "string" ? saved.dateFrom : "";
        const st = typeof saved.dateTo === "string" ? saved.dateTo : "";
        if (sp && sp !== "custom") {
          setPreset(sp);
          const r = presetRange(sp, sf, st);
          setDateFrom(r.from);
          setDateTo(r.to);
        } else if (sp === "custom") {
          setPreset("custom");
          setDateFrom(sf);
          setDateTo(st);
        }
        if (typeof saved.profileFilter === "string") setProfileFilter(saved.profileFilter);
        if (typeof saved.dirFilter === "string") setDirFilter(saved.dirFilter);
      }
      /* 恢复完成（含无存档情形）后才允许持久化，确保首帧默认值不会覆盖已保存的筛选 */
      setHydrated(true);
    })();
    return () => { done = true; };
  }, [api]);

  /* 筛选条件持久化（hydrated 为 true 后才写入，避免与恢复 effect 竞态） */
  useEffect(() => {
    if (!hydrated) return;
    api.storage.setJson(FILTER_KEY, { preset, dateFrom, dateTo, profileFilter, dirFilter }).catch(() => {});
  }, [api, hydrated, preset, dateFrom, dateTo, profileFilter, dirFilter]);

  function toEdit(p) {
    const mp = (o) => {
      const r = {};
      for (const k of ["input", "cacheRead", "cacheWrite", "output"]) r[k] = String(o[k]);
      return r;
    };
    const models = {};
    for (const m of Object.keys(p.models)) models[m] = mp(p.models[m]);
    return { currency: p.currency, defaultPrice: mp(p.defaultPrice), models };
  }

  /* usage 拉取 + 5s 轮询（筛选条件 / refreshTick 变化即重拉） */
  useEffect(() => {
    let stopped = false;
    let timer = null;

    const pull = async () => {
      const r = presetRange(preset, dateFrom, dateTo);
      /* since/until 必须用空格分隔的完整时间戳：usage 域经 IPC 直接进入 SQL 字符串比较，
         DB 中 created_at 为 "YYYY-MM-DD HH:MM:SS"（空格分隔），T 分隔或纯日期都会导致边界丢数据（issue #5） */
      const since = r.from + " 00:00:00";
      const until = r.to + " 23:59:59";
      const params = { since, until };
      if (profileFilter) params.profileName = profileFilter;
      try {
        let nextUsage;
        let nextTruncated = false;
        if (dirFilter) {
          /* 按项目筛选：宿主 summary/daily/models 不接受 directoryId，改由 records 聚合，
             使汇总卡、每日图表、模型成本表与项目筛选保持一致（修复 1） */
          const aggParams = { ...params, directoryId: dirFilter };
          const { items, truncated } = await fetchRecordsInRange(api, aggParams, since, until);
          nextUsage = aggregateUsageRecords(items);
          nextTruncated = truncated;
        } else {
          const u = await api.metadata.get(["usage"], { params });
          if (u && u.denied && u.denied.usage) {
            if (stopped) return;
            setErrMsg(T("state.denied", "usage 域读取被拒（缺少隐私声明授权），无法展示成本数据。"));
            setUsage(null);
            setLoading(false);
            timer = setTimeout(pull, POLL_MS);
            return;
          }
          nextUsage = (u && u.domains && u.domains.usage) || null;
        }
        if (stopped) return;
        setUsage(nextUsage);
        setTruncated(nextTruncated);
        setErrMsg(null);
        setLastUpdated(new Date());
      } catch (e) {
        if (stopped) return;
        if (e && e.deniedUsage) {
          setErrMsg(T("state.denied", "usage 域读取被拒（缺少隐私声明授权），无法展示成本数据。"));
        } else {
          setErrMsg(T("state.loadError", "读取使用量数据失败：{{error}}", { error: e && e.message ? e.message : String(e) }));
        }
        setUsage(null);
      }
      if (stopped) return;
      setLoading(false);
      timer = setTimeout(pull, POLL_MS);
    };

    pull();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [api, preset, dateFrom, dateTo, profileFilter, dirFilter, refreshTick]);

  /* 项目下拉选项 + 档案下拉选项：挂载时拉一次，之后每 60s 刷新
     （档案名独立于当前筛选，避免按项目筛选时聚合结果把下拉选项收窄） */
  useEffect(() => {
    let stopped = false;
    let timer = null;

    const pullFilters = async () => {
      try {
        const [p, u] = await Promise.all([
          api.metadata.get(["projects"], {}),
          api.metadata.get(["usage"], {}),
        ]);
        if (stopped) return;
        const dirs = p && p.domains && p.domains.projects && Array.isArray(p.domains.projects.directories)
          ? p.domains.projects.directories
          : [];
        setProjects(dirs);
        const names = u && u.domains && u.domains.usage && Array.isArray(u.domains.usage.profileNames)
          ? u.domains.usage.profileNames
          : [];
        setProfileNames(names);
      } catch (e) {
        if (stopped) return;
        api.log(T("log.readFilters", "读取项目/档案列表失败:"), e);
      }
      if (stopped) return;
      timer = setTimeout(pullFilters, PROJECTS_POLL_MS);
    };

    pullFilters();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [api]);

  /* 按项目收窄档案下拉选项（使「选项 = 该项目下真实可用值」）：
     项目变化或点刷新时读取该项目档案名。缓存有效期内只做一次轻量总数校验（1 次 IPC），
     总数未变则复用缓存、不重复全量扫描；扫描完成前该项目的选项视为「未知」（names 为 null）。 */
  useEffect(() => {
    let stopped = false;
    if (!dirFilter) {
      setDirProfiles({ dir: "", names: null });
      return undefined;
    }
    (async () => {
      try {
        const { names, truncated } = await fetchProjectProfileNamesCached(api, dirFilter);
        if (stopped || !aliveRef.current) return;
        setDirProfiles({ dir: dirFilter, names, truncated });
      } catch (e) {
        if (stopped || !aliveRef.current) return;
        api.log(T("log.readDirProfiles", "读取项目档案列表失败:"), e);
        setDirProfiles({ dir: dirFilter, names: [] });
      }
    })();
    return () => { stopped = true; };
  }, [api, dirFilter, refreshTick]);

  /* 项目变化导致已选档案不在新项目可用集合内时，自动重置为「全部档案」并提示（避免误导性空结果） */
  useEffect(() => {
    if (!dirFilter || !profileFilter) return;
    if (dirProfiles.dir !== dirFilter || dirProfiles.names === null) return; // 仍在扫描，先不判定
    if (dirProfiles.names.indexOf(profileFilter) >= 0) return;
    setProfileFilter("");
    setFilterMsg(T("filter.profileReset", "该档案在当前项目下没有记录，已重置为「全部档案」。"));
  }, [dirFilter, profileFilter, dirProfiles]);

  /* 提示自动消失 */
  useEffect(() => {
    if (!filterMsg) return undefined;
    const t = setTimeout(() => { if (aliveRef.current) setFilterMsg(null); }, 4000);
    return () => clearTimeout(t);
  }, [filterMsg]);

  /* ---------- 派生数据 ---------- */

  /* 档案下拉选项：
     - 未选项目：全库档案名（profileNames）
     - 已选项目且扫描完成：该项目下出现过的档案名（dirProfiles.names）
     - 已选项目但扫描未完成：回退全库名，避免下拉短暂为空（此时若选中项不适用，由重置 effect 兜底） */
  const profileOptions = (() => {
    if (!dirFilter) return profileNames;
    if (dirProfiles.dir === dirFilter && Array.isArray(dirProfiles.names)) return dirProfiles.names;
    return profileNames;
  })();

  /* 所选范围天数（含端点），用于超限提示 */
  const spanDays = (() => {
    const a = new Date(dateFrom + "T00:00:00");
    const b = new Date(dateTo + "T00:00:00");
    if (isNaN(a.getTime()) || isNaN(b.getTime()) || b < a) return 0;
    return Math.round((b - a) / 86400000) + 1;
  })();

  const models = (usage && Array.isArray(usage.models) ? usage.models : []).slice();

  const modelRows = models
    .map((m) => {
      const pf = priceFor(prices, m.model);
      return {
        ...m,
        price: pf.price,
        priceSource: pf.source,
        cost: costOf(m, pf.price),
        tokens: splitTokens(m),
      };
    })
    .sort((a, b) => b.cost - a.cost || b.totalRequests - a.totalRequests);

  const totalCost = modelRows.reduce((s, r) => s + r.cost, 0);
  const summary = usage && usage.summary ? usage.summary : null;

  /* 各类别混合单价（元/token）：该类别全期成本 ÷ 该类别全期 token（daily 无按模型拆分，近似折算） */
  const blended = (() => {
    const acc = { nonCachedInput: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
    const cost = { nonCachedInput: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
    for (const r of modelRows) {
      for (const c of CATS) {
        acc[c.key] += r.tokens[c.key];
        cost[c.key] += r.tokens[c.key] * (clamp0(r.price[c.key]) || 0);
      }
    }
    const b = {};
    for (const c of CATS) b[c.key] = acc[c.key] > 0 ? cost[c.key] / acc[c.key] / 1e6 : 0;
    return b;
  })();

  const dailyRows = (() => {
    const days = usage && Array.isArray(usage.daily) ? usage.daily.slice() : [];
    return days
      .map((d) => {
        const t = splitTokens(d);
        let cost = 0;
        for (const c of CATS) cost += t[c.key] * (blended[c.key] || 0);
        return { ...d, tokens: t, cost };
      })
      .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  })();

  const maxDailyCost = dailyRows.reduce((m, d) => Math.max(m, d.cost), 0);

  /* 编辑器要展示的模型集合 = usage 模型 ∪ 已配置覆盖的模型 */
  const editorModels = (() => {
    const set = [];
    const seen = new Set();
    for (const r of modelRows) {
      if (!seen.has(r.model)) { seen.add(r.model); set.push(r.model); }
    }
    const em = priceEdit ? Object.keys(priceEdit.models) : [];
    for (const m of em) if (!seen.has(m)) { seen.add(m); set.push(m); }
    return set;
  })();

  /* ---------- 交互 ---------- */

  const onPriceCell = useCallback((scope, model, key, value) => {
    setPriceEdit((prev) => {
      const next = {
        currency: prev.currency,
        defaultPrice: { ...prev.defaultPrice },
        models: {},
      };
      for (const m of Object.keys(prev.models)) next.models[m] = { ...prev.models[m] };
      if (scope === "default") next.defaultPrice[key] = value;
      else {
        if (!next.models[model]) next.models[model] = { ...(builtinPriceFor(model) || next.defaultPrice) };
        next.models[model][key] = value;
      }
      return next;
    });
  }, []);

  const clearModelPrice = useCallback((model) => {
    setPriceEdit((prev) => {
      const next = { currency: prev.currency, defaultPrice: { ...prev.defaultPrice }, models: {} };
      for (const m of Object.keys(prev.models)) if (m !== model) next.models[m] = { ...prev.models[m] };
      return next;
    });
  }, []);

  /** 把一份 priceEdit 状态写入插件存储并刷新视图；返回 { ok, error? } */
  const persistPrices = useCallback(
    async (pe) => {
      const parse = (o) => {
        const r = {};
        for (const k of ["input", "cacheRead", "cacheWrite", "output"]) {
          const n = Number(String(o[k]).trim());
          r[k] = isFinite(n) && n >= 0 ? n : 0;
        }
        return r;
      };
      const currency = (pe.currency || "").trim() || defaultCurrencyFor(UI_LOCALE);
      const out = {
        v: 1,
        currency,
        defaultPrice: parse(pe.defaultPrice),
        models: {},
      };
      for (const m of Object.keys(pe.models)) out.models[m] = parse(pe.models[m]);
      try {
        await api.storage.setJson(PRICES_KEY, out);
        if (!aliveRef.current) return { ok: false };
        setPrices(normalizePrices(out, UI_LOCALE));
        setPriceEdit(toEdit(normalizePrices(out, UI_LOCALE)));
        return { ok: true };
      } catch (e) {
        return { ok: false, error: e && e.message ? e.message : String(e) };
      }
    },
    [api]
  );

  const savePrices = useCallback(async () => {
    const res = await persistPrices(priceEdit);
    if (!aliveRef.current) return;
    setSaveMsg(res.ok
      ? { text: T("msg.saved", "已保存"), ok: true }
      : { text: T("msg.saveFailed", "保存失败：{{error}}", { error: res.error || "" }), ok: false });
    setTimeout(() => { if (aliveRef.current) setSaveMsg(null); }, 2500);
  }, [persistPrices, priceEdit]);

  /** 从 OpenRouter 同步当前用量模型的价格：汇率 + 实时价换算为元/百万 token，仅填入未自定义的模型 */
  const syncFromOpenRouter = useCallback(async () => {
    if (syncing || !priceEdit) return;
    setSyncing(true);
    setSaveMsg(null);
    try {
      const rateRes = await api.net.fetch("https://open.er-api.com/v6/latest/USD", { timeoutMs: 20000 });
      if (!rateRes.ok || !rateRes.body) throw new Error(T("sync.rateFailed", "汇率获取失败（HTTP {{status}}）", { status: rateRes.status }));
      const rateData = JSON.parse(rateRes.body);
      const cny = Number(rateData.rates && rateData.rates.CNY);
      if (!(cny > 0)) throw new Error(T("sync.rateBad", "汇率数据异常"));

      const modelsRes = await api.net.fetch("https://openrouter.ai/api/v1/models", { timeoutMs: 60000 });
      if (!modelsRes.ok || !modelsRes.body) throw new Error(T("sync.modelsFailed", "OpenRouter 模型列表获取失败（HTTP {{status}}）", { status: modelsRes.status }));
      const list = JSON.parse(modelsRes.body).data || [];
      if (!list.length) throw new Error(T("sync.modelsEmpty", "OpenRouter 返回空模型列表"));

      /* 建两级归一化索引：厂商前缀剥离后的基础名（优先）与完整 id；:batch 变体不参与建表 */
      const byBase = new Map();
      const byFull = new Map();
      const toCnyPerM = (v) => (Number(v) || 0) * cny * 1e6;
      for (const it of list) {
        const id = String(it.id || "");
        if (!id || id.includes(":batch")) continue;
        const p = it.pricing || {};
        const rec = {
          input: toCnyPerM(p.prompt),
          output: toCnyPerM(p.completion),
          cacheRead: toCnyPerM(p.input_cache_read),
          cacheWrite: toCnyPerM(p.input_cache_write),
        };
        const base = id.includes("/") ? id.slice(id.lastIndexOf("/") + 1) : id;
        const bk = normModelName(base);
        if (bk && !byBase.has(bk)) byBase.set(bk, rec);
        const fk = normModelName(id);
        if (fk && !byFull.has(fk)) byFull.set(fk, rec);
      }

      const round4 = (n) => Math.round(n * 10000) / 10000;
      let filled = 0;
      let skippedCustom = 0;
      const misses = [];
      const next = { currency: priceEdit.currency, defaultPrice: { ...priceEdit.defaultPrice }, models: {} };
      for (const m of Object.keys(priceEdit.models)) next.models[m] = { ...priceEdit.models[m] };
      for (const r of modelRows) {
        const name = r.model;
        if (priceEdit.models[name]) { skippedCustom += 1; continue; } // 已自定义，不覆盖
        const bare = name.includes("/") ? name.slice(name.lastIndexOf("/") + 1) : name;
        const rec = byBase.get(normModelName(bare)) || byFull.get(normModelName(name));
        if (rec) {
          next.models[name] = {
            input: round4(rec.input),
            cacheRead: round4(rec.cacheRead),
            cacheWrite: round4(rec.cacheWrite),
            output: round4(rec.output),
          };
          filled += 1;
        } else {
          misses.push(name);
        }
      }

      if (filled === 0) {
        const detail = skippedCustom
          ? T("msg.syncNoneDetail", "（已有 {{count}} 个模型为自定义单价）", { count: skippedCustom })
          : "";
        const missText = misses.length
          ? T("msg.syncNoneMiss", "，未匹配：{{names}}", {
              names: misses.slice(0, 3).join("、") + (misses.length > 3 ? T("msg.etc", " 等") : ""),
            })
          : "";
        setSaveMsg({ text: T("msg.syncNone", "同步未填入任何模型{{detail}}{{miss}}", { detail, miss: missText }), ok: false });
        setTimeout(() => { if (aliveRef.current) setSaveMsg(null); }, 6000);
        return;
      }

      const res = await persistPrices(next);
      if (!aliveRef.current) return;
      if (!res.ok) {
        setSaveMsg({ text: T("msg.syncSaveFailed", "同步结果保存失败：{{error}}", { error: res.error || "" }), ok: false });
      } else {
        setSaveMsg({
          text: T("msg.synced", "已同步 {{count}} 个模型价格（汇率 {{rate}}）{{skip}}{{miss}}", {
              count: filled,
              rate: cny.toFixed(2),
              skip: skippedCustom ? T("msg.syncedSkip", "，跳过 {{count}} 个已自定义", { count: skippedCustom }) : "",
              miss: misses.length ? T("msg.syncedMiss", "，未匹配 {{count}} 个", { count: misses.length }) : "",
            }),
          ok: true,
        });
      }
      setTimeout(() => { if (aliveRef.current) setSaveMsg(null); }, 6000);
    } catch (e) {
      if (!aliveRef.current) return;
      setSaveMsg({ text: T("msg.syncFailed", "同步失败：{{error}}", { error: e && e.message ? e.message : String(e) }), ok: false });
      setTimeout(() => { if (aliveRef.current) setSaveMsg(null); }, 6000);
    } finally {
      if (aliveRef.current) setSyncing(false);
    }
  }, [api, priceEdit, modelRows, syncing, persistPrices]);

  const buildCsv = useCallback(() => {
    const cur = prices.currency;
    const lines = [];
    const head = [
      T("csv.model", "模型"), T("csv.requests", "请求数"), T("csv.errors", "错误数"),
      T("csv.nonCachedInput", "非缓存输入token"), T("csv.cacheRead", "缓存读token"), T("csv.cacheWrite", "缓存写token"), T("csv.output", "输出token"),
      T("csv.cost", "成本({{cur}})", { cur }),
    ];
    lines.push(head.map(csvEsc).join(","));
    for (const r of modelRows) {
      lines.push([
        r.model, r.totalRequests, r.errorRequests,
        r.tokens.nonCachedInput, r.tokens.cacheRead, r.tokens.cacheWrite, r.tokens.output,
        r.cost.toFixed(6),
      ].map(csvEsc).join(","));
    }
    lines.push([T("csv.total", "合计"), modelRows.reduce((s, r) => s + r.totalRequests, 0), modelRows.reduce((s, r) => s + r.errorRequests, 0),
      modelRows.reduce((s, r) => s + r.tokens.nonCachedInput, 0), modelRows.reduce((s, r) => s + r.tokens.cacheRead, 0),
      modelRows.reduce((s, r) => s + r.tokens.cacheWrite, 0), modelRows.reduce((s, r) => s + r.tokens.output, 0),
      totalCost.toFixed(6)].map(csvEsc).join(","));
    if (includeDaily) {
      lines.push("");
      lines.push([T("csv.date", "日期"), T("csv.requests", "请求数"), T("csv.errors", "错误数"), T("csv.nonCachedInput", "非缓存输入token"), T("csv.cacheRead", "缓存读token"), T("csv.cacheWrite", "缓存写token"), T("csv.output", "输出token"), T("csv.cost", "成本({{cur}})", { cur })].map(csvEsc).join(","));
      for (const d of dailyRows) {
        lines.push([
          d.date, d.totalRequests, d.errorRequests,
          d.tokens.nonCachedInput, d.tokens.cacheRead, d.tokens.cacheWrite, d.tokens.output,
          d.cost.toFixed(6),
        ].map(csvEsc).join(","));
      }
    }
    return lines.join("\r\n");
  }, [modelRows, dailyRows, includeDaily, prices.currency, totalCost]);

  const exportCsv = useCallback(() => {
    try {
      const blob = new Blob(["\ufeff" + buildCsv()], { type: "text/csv;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "usage-cost-" + (dateFrom || isoDate(new Date())) + "-" + (dateTo || isoDate(new Date())) + ".csv";
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setActionMsg({ text: T("msg.exported", "CSV 已导出"), ok: true });
    } catch (e) {
      setActionMsg({ text: T("msg.exportFailed", "导出失败：{{error}}", { error: e && e.message ? e.message : String(e) }), ok: false });
    }
    setTimeout(() => { if (aliveRef.current) setActionMsg(null); }, 2500);
  }, [buildCsv, dateFrom, dateTo]);

  const copyCsv = useCallback(async () => {
    try {
      const res = await api.write.run("system.writeClipboardText", { text: buildCsv() });
      if (!aliveRef.current) return;
      setActionMsg(res && res.ok
        ? { text: T("msg.copied", "CSV 已复制到剪贴板"), ok: true }
        : { text: T("msg.copyFailed", "复制失败：{{error}}", { error: (res && res.error) || T("msg.unknownError", "未知错误") }), ok: false });
    } catch (e) {
      if (!aliveRef.current) return;
      setActionMsg({ text: T("msg.copyFailed", "复制失败：{{error}}", { error: e && e.message ? e.message : String(e) }), ok: false });
    }
    setTimeout(() => { if (aliveRef.current) setActionMsg(null); }, 2500);
  }, [buildCsv]);

  /* ---------- 渲染 ---------- */

  const cur = prices.currency;

  const applyPreset = (key) => {
    setPreset(key);
    if (key !== "custom") {
      const r = presetRange(key, dateFrom, dateTo);
      setDateFrom(r.from);
      setDateTo(r.to);
    }
  };

  const onDateChange = (which, v) => {
    setPreset("custom");
    if (which === "from") setDateFrom(v);
    else setDateTo(v);
  };

  const card = (key, label, value, extraCls, sub) =>
    h("div", { key, className: "ucx-card" + (extraCls ? " " + extraCls : "") },
      h("div", { className: "ucx-card-label" }, label),
      h("div", { className: "ucx-card-value" }, value),
      sub ? h("div", { className: "ucx-card-sub" }, sub) : null
    );

  /* 每日条形图 */
  const chart = (() => {
    if (!dailyRows.length) return null;
    const n = dailyRows.length;
    /* 标签密度按可用宽度自适应（修复 4）：面板越窄标签越少，保证每个标签有足够空间完整显示 MM-DD。
       宽度未知（0，如首帧或宿主未提供 ResizeObserver）时按经验值 480px 处理，避免首帧标签过密。
       每标签按「约 44px 文本宽 + 24px 间隔」估算占位，故取 68px/标签。 */
    const chartWidth = chartWidthPx > 0 ? chartWidthPx : 480;
    const maxLabels = Math.max(2, Math.min(9, Math.floor(chartWidth / 68)));
    const labelEvery = Math.max(1, Math.ceil(n / maxLabels));
    /* 首尾标签改用最小内缩而非贴边，避免极窄面板下文字被容器裁掉（修复 4） */
    const edgePadPx = 18;
    const edgePadPct = Math.min(12, (edgePadPx / chartWidth) * 100).toFixed(3) + "%";
    return h("div", { className: "ucx-chart", ref: chartRef },
      h("div", { className: "ucx-chart-bars" },
        dailyRows.map((d) => {
          const pct = maxDailyCost > 0 && d.cost > 0 ? Math.max((d.cost / maxDailyCost) * 100, 2) : 0;
          const tip = T("chart.tip", "{{date}} | 成本 {{cost}} | 请求 {{requests}} | 错误 {{errors}}", {
            date: d.date, cost: fmtCost(cur, d.cost), requests: fmtInt(d.totalRequests), errors: fmtInt(d.errorRequests),
          });
          return h("div", { key: d.date, className: "ucx-chart-col", title: tip },
            h("div", {
              className: "ucx-chart-bar" + (d.cost > 0 ? "" : " ucx-chart-bar-empty"),
              style: { height: (pct || (d.totalRequests > 0 ? 2 : 0)) + "%" },
            })
          );
        })
      ),
      /* 标签绝对定位于对应柱子中心，不再与柱子等宽排布，杜绝溢出裁剪（issue #6）；
         首个标签左对齐、末个显示标签右对齐，并保留最小内缩避免贴边被裁（修复 4） */
      h("div", { className: "ucx-chart-labels" },
        dailyRows.map((d, i) => {
          if (i % labelEvery !== 0) return null;
          const style = i === 0
            ? { left: edgePadPct }
            : i + labelEvery >= n
              ? { right: edgePadPct }
              : { left: (((i + 0.5) / n) * 100).toFixed(3) + "%", transform: "translateX(-50%)" };
          return h("div", { key: d.date, className: "ucx-chart-label", style }, d.date.slice(5));
        })
      )
    );
  })();

  /* 单价设置表 */
  const priceInputs = (scope, model, p) =>
    CATS.map((c) =>
      h("input", {
        key: scope + ":" + (model || "") + ":" + c.key,
        className: "ucx-price-input",
        type: "number",
        min: "0",
        step: "any",
        title: T(c.labelKey, c.label) + T("price.unitSuffix", "单价（每 100 万 token）"),
        value: p[c.key],
        onChange: (e) => onPriceCell(scope, model, c.key, e.target.value),
      })
    );

  const priceTable = priceEdit && h("div", { className: "ucx-price-wrap" },
    h("div", { className: "ucx-price-toolbar" },
      h("label", { className: "ucx-currency" },
        T("price.currency", "货币符号: "),
        h("input", {
          className: "ucx-currency-input",
          type: "text",
          maxLength: 4,
          value: priceEdit.currency,
          onChange: (e) => setPriceEdit((prev) => ({ ...prev, currency: e.target.value })),
        })
      ),
      h("button", { className: "ucx-btn ucx-primary", onClick: savePrices, title: T("price.saveTitle", "保存单价配置") }, T("price.save", "保存单价")),
      h(
        "button",
        {
          className: "ucx-btn",
          onClick: syncFromOpenRouter,
          disabled: syncing,
          title: T("price.syncTitle", "从 OpenRouter 拉取当前用量模型的实时价（美元按当日汇率折算人民币），仅填入未自定义单价的模型"),
        },
        icon("CloudDownload", 14),
        syncing ? T("price.syncing", "同步中…") : T("price.sync", "同步 OpenRouter 价格")
      ),
      saveMsg ? h("span", { className: saveMsg.ok ? "ucx-ok" : "ucx-err" }, saveMsg.text) : null
    ),
    h("div", { className: "ucx-table-wrap" },
    h("table", { className: "ucx-table" },
      h("thead", null,
        h("tr", null,
          h("th", null, T("price.modelOrDefault", "模型 / 默认价")),
          CATS.map((c) => h("th", { key: c.key, title: T("price.perM", "每 100 万 token") }, T(c.labelKey, c.label))),
          h("th", null, T("price.action", "操作"))
        )
      ),
      h("tbody", null,
        h("tr", { className: "ucx-price-default-row" },
          h("td", { title: T("price.defaultRowTitle", "未单独配置的模型使用此默认价") }, T("price.defaultRow", "默认价")),
          priceInputs("default", null, priceEdit.defaultPrice),
          h("td", { className: "ucx-muted" }, "-")
        ),
        editorModels.map((m) => {
          const row = priceEdit.models[m] || builtinPriceFor(m) || priceEdit.defaultPrice;
          const isOverride = !!priceEdit.models[m];
          const srcLabel = isOverride
            ? T("src.custom", "自定义")
            : builtinPriceFor(m) ? T("src.builtin", "内置估算") : T("src.default", "默认价");
          return h("tr", { key: m },
            h("td", { className: "ucx-model-cell", title: m + T("price.currentEffect", " · 当前生效：") + srcLabel }, m),
            priceInputs("model", m, row),
            h("td", null,
              isOverride
                ? h("button", { className: "ucx-btn ucx-small", onClick: () => clearModelPrice(m), title: T("price.resetTitle", "清除该模型的自定义单价，回退内置估算或默认价") }, T("price.reset", "回退默认"))
                : h("span", { className: "ucx-muted" }, srcLabel)
            )
          );
        })
      )
    )
    ),
    h("div", { className: "ucx-hint" }, T("price.hint", "单价单位：每 100 万 token。未自定义的模型按内置价计费：GLM-5.3、DeepSeek V4、Qwen3.8-Max 为官方刊例核实价；gpt-6 系（astra / sol / luna）与 claude fable 系为 OpenRouter 实时价按汇率折算；其余为估算，请按实际账单校准；逐行输入后点击保存生效。"))
  );

  /* 模型成本表 */
  const costTable = h("table", { className: "ucx-table" },
    h("thead", null,
      h("tr", null,
        h("th", null, T("table.model", "模型")),
        h("th", null, T("table.requests", "请求")),
        h("th", null, T("table.errorRate", "错误率")),
        h("th", null, T("cat.nonCachedInput", "非缓存输入")),
        h("th", null, T("cat.cacheRead", "缓存读")),
        h("th", null, T("cat.cacheWrite", "缓存写")),
        h("th", null, T("cat.output", "输出")),
        h("th", { className: "ucx-right" }, T("table.cost", "成本({{cur}})", { cur }))
      )
    ),
    h("tbody", null,
      modelRows.map((r) =>
        h("tr", { key: r.model },
          h("td", {
            className: "ucx-model-cell",
            title: r.model + T("table.priceSource", " · 价格来源：") + (T(SOURCE_LABEL_KEY[r.priceSource] || r.priceSource, SOURCE_LABEL_DEF[r.priceSource] || r.priceSource)),
          },
            r.model,
            r.priceSource !== "custom"
              ? h("span", { className: "ucx-price-src" }, T(SOURCE_LABEL_KEY[r.priceSource] || r.priceSource, SOURCE_LABEL_DEF[r.priceSource] || r.priceSource))
              : null),
          h("td", null, fmtInt(r.totalRequests)),
          h("td", { className: r.errorRequests > 0 ? "ucx-err" : "", title: T("table.errorCount", "错误数 {{n}}", { n: fmtInt(r.errorRequests) }) },
            fmtPct(r.errorRequests, r.totalRequests)),
          h("td", null, fmtTokens(r.tokens.nonCachedInput)),
          h("td", null, fmtTokens(r.tokens.cacheRead)),
          h("td", null, fmtTokens(r.tokens.cacheWrite)),
          h("td", null, fmtTokens(r.tokens.output)),
          h("td", { className: "ucx-right ucx-cost" }, fmtCost(cur, r.cost))
        )
      ),
      h("tr", { className: "ucx-total-row" },
        h("td", null, T("table.total", "合计")),
        h("td", null, fmtInt(modelRows.reduce((s, r) => s + r.totalRequests, 0))),
        h("td", { title: T("table.errorCount", "错误数 {{n}}", { n: fmtInt(modelRows.reduce((s, r) => s + r.errorRequests, 0)) }) },
          fmtPct(modelRows.reduce((s, r) => s + r.errorRequests, 0), modelRows.reduce((s, r) => s + r.totalRequests, 0))),
        h("td", null, fmtTokens(modelRows.reduce((s, r) => s + r.tokens.nonCachedInput, 0))),
        h("td", null, fmtTokens(modelRows.reduce((s, r) => s + r.tokens.cacheRead, 0))),
        h("td", null, fmtTokens(modelRows.reduce((s, r) => s + r.tokens.cacheWrite, 0))),
        h("td", null, fmtTokens(modelRows.reduce((s, r) => s + r.tokens.output, 0))),
        h("td", { className: "ucx-right ucx-cost" }, fmtCost(cur, totalCost))
      )
    )
  );

  const errRate = summary ? fmtPct(summary.errorRequests, summary.totalRequests) : "0%";

  const emptyState = !loading && !errMsg && (!summary || !summary.totalRequests) && !modelRows.length;
  const hasData = !!usage && !errMsg;

  return h("div", { className: "ucx-root" },
    /* 头部：标题 + 刷新 */
    h("div", { className: "ucx-header" },
      h("div", { className: "ucx-title" },
        icon("CircleDollarSign", 16),
        h("span", null, T("header.title", "成本核算看板"))
      ),
      h("div", { className: "ucx-header-actions" },
        h("button", {
          className: "ucx-btn ucx-icon-btn",
          onClick: () => {
            /* 手动刷新：失效当前项目的档案名缓存，使新出现的档案名立即可见 */
            invalidateDirProfiles(dirFilter);
            setRefreshTick((t) => t + 1);
          },
          title: T("header.refresh", "立即刷新"),
        }, icon("RefreshCw", 14)),
        lastUpdated ? h("span", { className: "ucx-muted ucx-updated" }, T("header.updatedAt", "更新于 {{time}}", { time: lastUpdated.toLocaleTimeString(UI_LOCALE) })) : null
      )
    ),

    /* 筛选栏：时间范围下拉 + 自定义起止 + 档案/项目下拉（自定义下拉组件，issue #4） */
    h("div", { className: "ucx-filter-bar" },
      h(UcxSelect, {
        value: preset,
        onChange: applyPreset,
        title: T("filter.range", "时间范围"),
        options: PRESETS.map((p) => ({ value: p.key, label: T(p.labelKey, p.label) })),
      }),
      h("input", {
        className: "ucx-date-input",
        type: "date",
        value: dateFrom,
        max: dateTo || undefined,
        onChange: (e) => onDateChange("from", e.target.value),
        title: T("filter.dateFrom", "起始日期（含，当日 00:00:00 起）"),
      }),
      h("span", { className: "ucx-filter-sep" }, "~"),
      h("input", {
        className: "ucx-date-input",
        type: "date",
        value: dateTo,
        min: dateFrom || undefined,
        onChange: (e) => onDateChange("to", e.target.value),
        title: T("filter.dateTo", "结束日期（含，至当日 23:59:59）"),
      }),
      h(UcxSelect, {
        value: profileFilter,
        onChange: setProfileFilter,
        title: T("filter.byProfile", "按 API 档案筛选"),
        /* 选项来源：未选项目时为全库档案名；选了项目后收窄为该项目下出现过的档案名（使「选项 = 可用值」） */
        options: [
          { value: "", label: T("filter.allProfiles", "全部档案") },
          ...(profileFilter && profileOptions.indexOf(profileFilter) < 0
            ? [{ value: profileFilter, label: profileFilter }]
            : []),
          ...profileOptions.map((n) => ({ value: n, label: n })),
        ],
      }),
      h(UcxSelect, {
        value: dirFilter,
        onChange: setDirFilter,
        title: T("filter.byProject", "按项目筛选"),
        options: [
          { value: "", label: T("filter.allProjects", "全部项目") },
          ...(dirFilter && !projects.some((d) => d.directoryId === dirFilter)
            ? [{ value: dirFilter, label: dirFilter }]
            : []),
          ...projects.map((d) => ({ value: d.directoryId, label: d.name || d.directoryId })),
        ],
      }),
      filterMsg ? h("span", { className: "ucx-muted ucx-filter-msg" }, filterMsg) : null
    ),

    loading ? h("div", { className: "ucx-state" }, T("state.loading", "加载中，正在读取使用量数据...")) : null,
    errMsg ? h("div", { className: "ucx-state ucx-err" }, errMsg) : null,
    emptyState ? h("div", { className: "ucx-state" }, T("state.empty", "所选时间范围内暂无使用数据。")) : null,

    hasData ? h("div", { className: "ucx-cards" },
      card("cost", T("card.totalCost", "总成本（估算）"), fmtCost(cur, totalCost), "ucx-card-accent"),
      card("req", T("card.totalRequests", "总请求"), fmtInt(summary ? summary.totalRequests : 0)),
      card("err", T("card.errors", "错误数 / 错误率"),
        fmtInt(summary ? summary.errorRequests : 0) + "（" + errRate + "）",
        summary && summary.errorRequests > 0 ? "ucx-card-danger" : ""),
      card("in", T("card.inputTokens", "总输入 token"), fmtTokens(summary ? summary.totalInputTokens : 0),
        null, summary ? T("card.cacheSub", "缓存读 {{read}} / 缓存写 {{write}}", { read: fmtTokens(summary.totalCacheReadInputTokens), write: fmtTokens(summary.totalCacheCreationInputTokens) }) : null),
      card("out", T("card.outputTokens", "总输出 token"), fmtTokens(summary ? summary.totalOutputTokens : 0))
    ) : null,

    /* 每日成本条形图 */
    hasData && dailyRows.length ? h("div", { className: "ucx-section" },
      h("div", { className: "ucx-section-title" }, icon("BarChart3", 14), T("chart.dailyCost", "每日成本")),
      dirFilter && truncated
        ? h("div", { className: "ucx-hint" }, T("chart.truncatedHint", "项目筛选下按明细聚合，已达单次聚合上限（40000 条），汇总与图表可能未覆盖完整范围。"))
        : null,
      spanDays > 90 ? h("div", { className: "ucx-hint" }, T("chart.spanHint", "所选范围 {{days}} 天：每日明细最多返回 90 行（自最早日期起），条形图可能不覆盖完整范围。", { days: spanDays })) : null,
      maxDailyCost === 0 ? h("div", { className: "ucx-hint" }, T("chart.zeroHint", "当前价格配置下每日成本均为 0，可先在下方设置单价。")) : null,
      chart
    ) : null,

    /* 模型成本表 */
    hasData && modelRows.length ? h("div", { className: "ucx-section" },
      h("div", { className: "ucx-section-title" }, icon("Table2", 14), T("table.sectionTitle", "模型成本（按成本降序）")),
      h("div", { className: "ucx-table-wrap" }, costTable)
    ) : null,

    /* 导出 */
    hasData ? h("div", { className: "ucx-section ucx-export-bar" },
      h("label", { className: "ucx-check" },
        h("input", {
          type: "checkbox",
          checked: includeDaily,
          onChange: (e) => setIncludeDaily(e.target.checked),
        }),
        T("export.includeDaily", "含每日明细")
      ),
      h("button", { className: "ucx-btn", onClick: exportCsv, title: T("export.csvTitle", "导出 CSV 文件") }, icon("Download", 14), T("export.csv", "导出 CSV")),
      h("button", { className: "ucx-btn", onClick: copyCsv, title: T("export.copyTitle", "复制 CSV 文本到剪贴板") }, icon("ClipboardCopy", 14), T("export.copy", "复制 CSV")),
      actionMsg ? h("span", { className: actionMsg.ok ? "ucx-ok" : "ucx-err" }, actionMsg.text) : null
    ) : null,

    /* 单价设置 */
    h("div", { className: "ucx-section" },
      h("div", { className: "ucx-section-title" }, icon("Settings2", 14), T("price.section", "单价设置")),
      priceTable || h("div", { className: "ucx-state" }, T("state.priceLoading", "价格配置加载中..."))
    ),

    /* 脚注：口径说明 */
    h("div", { className: "ucx-footer" },
      T("footer.text", "成本口径：非缓存输入 = totalInputTokens - totalCacheReadInputTokens（不足为 0）；缓存读 = totalCacheReadInputTokens；缓存写 = totalCacheCreationInputTokens；输出 = totalOutputTokens；成本 = 各部分 token ÷ 1000000 × 对应单价（单价：每 100 万 token，货币符号可配置）。daily/models 维度无 effective 拆分，成本为近似估算；每日成本按各 token 类别的全期混合单价折算，可能与按模型合计略有出入。数据来自 usage 元数据域，每 5 秒轮询。时间筛选对齐官方用量页口径（起始日 00:00:00 ~ 结束日 23:59:59），支持今天/昨天/近 7 天/近 30 天/本月/上月/自定义起止与档案、项目筛选，筛选条件保存在插件本地存储。未自定义单价的模型按内置估算价计费，仅作参考，请按实际价格在「单价设置」中校准。")
    )
  );
}
