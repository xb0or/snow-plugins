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
  const [refreshTick, setRefreshTick] = useState(0);
  const [usage, setUsage] = useState(null);
  const [loading, setLoading] = useState(true);
  const [errMsg, setErrMsg] = useState(null);
  const [lastUpdated, setLastUpdated] = useState(null);

  const [prices, setPrices] = useState(() => normalizePrices(null, UI_LOCALE));
  const [priceEdit, setPriceEdit] = useState(null); // 字符串态编辑缓冲
  const [saveMsg, setSaveMsg] = useState(null); // { text, ok }
  const [syncing, setSyncing] = useState(false);

  const [includeDaily, setIncludeDaily] = useState(false);
  const [actionMsg, setActionMsg] = useState(null); // 导出/复制反馈 { text, ok }

  const aliveRef = useRef(true);
  useEffect(() => () => { aliveRef.current = false; }, []);

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
      if (done || !aliveRef.current || !saved) return;
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
    })();
    return () => { done = true; };
  }, [api]);

  /* 筛选条件持久化 */
  useEffect(() => {
    api.storage.setJson(FILTER_KEY, { preset, dateFrom, dateTo, profileFilter, dirFilter }).catch(() => {});
  }, [api, preset, dateFrom, dateTo, profileFilter, dirFilter]);

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
      const params = { since: r.from + "T00:00:00", until: r.to + "T23:59:59" };
      if (profileFilter) params.profileName = profileFilter;
      if (dirFilter) params.directoryId = dirFilter;
      try {
        const [u, p] = await Promise.all([
          api.metadata.get(["usage"], { params }),
          api.metadata.get(["projects"], {}),
        ]);
        if (stopped) return;
        if (u && u.denied && u.denied.usage) {
          setErrMsg(T("state.denied", "usage 域读取被拒（缺少隐私声明授权），无法展示成本数据。"));
          setUsage(null);
        } else {
          setUsage((u && u.domains && u.domains.usage) || null);
          setErrMsg(null);
        }
        const dirs = p && p.domains && p.domains.projects && Array.isArray(p.domains.projects.directories)
          ? p.domains.projects.directories
          : [];
        setProjects(dirs);
        setLastUpdated(new Date());
      } catch (e) {
        if (stopped) return;
        setErrMsg(T("state.loadError", "读取使用量数据失败：{{error}}", { error: e && e.message ? e.message : String(e) }));
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

  /* ---------- 派生数据 ---------- */

  const profileNames = usage && Array.isArray(usage.profileNames) ? usage.profileNames : [];

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
    const labelEvery = Math.max(1, Math.ceil(n / 10));
    return h("div", { className: "ucx-chart" },
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
      h("div", { className: "ucx-chart-labels" },
        dailyRows.map((d, i) =>
          h("div", { key: d.date, className: "ucx-chart-label" },
            i % labelEvery === 0 ? d.date.slice(5) : ""
          )
        )
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
          onClick: () => setRefreshTick((t) => t + 1),
          title: T("header.refresh", "立即刷新"),
        }, icon("RefreshCw", 14)),
        lastUpdated ? h("span", { className: "ucx-muted ucx-updated" }, T("header.updatedAt", "更新于 {{time}}", { time: lastUpdated.toLocaleTimeString(UI_LOCALE) })) : null
      )
    ),

    /* 筛选栏：时间范围下拉 + 自定义起止 + 档案/项目下拉 */
    h("div", { className: "ucx-filter-bar" },
      h("select", {
        className: "ucx-select",
        value: preset,
        onChange: (e) => applyPreset(e.target.value),
        title: T("filter.range", "时间范围"),
      },
        PRESETS.map((p) => h("option", { key: p.key, value: p.key }, T(p.labelKey, p.label)))
      ),
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
      h("select", {
        className: "ucx-select",
        value: profileFilter,
        onChange: (e) => setProfileFilter(e.target.value),
        title: T("filter.byProfile", "按 API 档案筛选"),
      },
        h("option", { value: "" }, T("filter.allProfiles", "全部档案")),
        profileFilter && profileNames.indexOf(profileFilter) < 0
          ? h("option", { value: profileFilter }, profileFilter)
          : null,
        profileNames.map((n) => h("option", { key: n, value: n }, n))
      ),
      h("select", {
        className: "ucx-select",
        value: dirFilter,
        onChange: (e) => setDirFilter(e.target.value),
        title: T("filter.byProject", "按项目筛选"),
      },
        h("option", { value: "" }, T("filter.allProjects", "全部项目")),
        dirFilter && !projects.some((d) => d.directoryId === dirFilter)
          ? h("option", { value: dirFilter }, dirFilter)
          : null,
        projects.map((d) => h("option", { key: d.directoryId, value: d.directoryId }, d.name || d.directoryId))
      )
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
