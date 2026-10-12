/*
 * 成本核算看板 (Usage Cost) — Snow App 面板插件
 *
 * 数据源：usage 元数据域（summary / daily / models），params.since 按所选时间范围计算。
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
const POLL_MS = 5000;
const CATS = [
  { key: "nonCachedInput", label: "非缓存输入" },
  { key: "cacheRead", label: "缓存读" },
  { key: "cacheWrite", label: "缓存写" },
  { key: "output", label: "输出" },
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
const SOURCE_LABEL = { custom: "自定义", builtin: "内置估算", default: "默认价" };

function builtinPriceFor(model) {
  const s = String(model || "").toLowerCase();
  for (const r of BUILTIN_PRICE_RULES) if (r.re.test(s)) return r.price;
  return null;
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
  return n.toLocaleString("zh-CN");
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

/** 时间范围 → since ISO 日期（含今天在内往前 days 天） */
function isoSince(days) {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - (days - 1));
  const p = (x) => String(x).padStart(2, "0");
  return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate());
}

function normalizePrices(raw) {
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
    currency: typeof (raw && raw.currency) === "string" && raw.currency ? raw.currency : "¥",
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

  const [range, setRange] = useState(7);
  const [refreshTick, setRefreshTick] = useState(0);
  const [usage, setUsage] = useState(null);
  const [loading, setLoading] = useState(true);
  const [errMsg, setErrMsg] = useState(null);
  const [lastUpdated, setLastUpdated] = useState(null);

  const [prices, setPrices] = useState(() => normalizePrices(null));
  const [priceEdit, setPriceEdit] = useState(null); // 字符串态编辑缓冲
  const [saveMsg, setSaveMsg] = useState(null);
  const [syncing, setSyncing] = useState(false);

  const [includeDaily, setIncludeDaily] = useState(false);
  const [actionMsg, setActionMsg] = useState(null); // 导出/复制反馈

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
        api.log("读取价格配置失败:", e);
      }
      if (done || !aliveRef.current) return;
      const p = normalizePrices(raw);
      setPrices(p);
      setPriceEdit(toEdit(p));
    })();
    return () => { done = true; };
  }, [api]);

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

  /* usage 拉取 + 5s 轮询（range / refreshTick 变化即重拉） */
  useEffect(() => {
    let stopped = false;
    let timer = null;

    const pull = async () => {
      const since = isoSince(range);
      try {
        const r = await api.metadata.get(["usage"], { params: { since } });
        if (stopped) return;
        if (r && r.denied && r.denied.usage) {
          setErrMsg("usage 域读取被拒（缺少隐私声明授权），无法展示成本数据。");
          setUsage(null);
        } else {
          setUsage((r && r.domains && r.domains.usage) || null);
          setErrMsg(null);
        }
        setLastUpdated(new Date());
      } catch (e) {
        if (stopped) return;
        setErrMsg("读取使用量数据失败：" + (e && e.message ? e.message : String(e)));
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
  }, [api, range, refreshTick]);

  /* ---------- 派生数据 ---------- */

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
      const currency = (pe.currency || "").trim() || "¥";
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
        setPrices(normalizePrices(out));
        setPriceEdit(toEdit(normalizePrices(out)));
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
    setSaveMsg(res.ok ? "已保存" : "保存失败：" + (res.error || ""));
    setTimeout(() => { if (aliveRef.current) setSaveMsg(null); }, 2500);
  }, [persistPrices, priceEdit]);

  /** 从 OpenRouter 同步当前用量模型的价格：汇率 + 实时价换算为元/百万 token，仅填入未自定义的模型 */
  const syncFromOpenRouter = useCallback(async () => {
    if (syncing || !priceEdit) return;
    setSyncing(true);
    setSaveMsg(null);
    try {
      const rateRes = await api.net.fetch("https://open.er-api.com/v6/latest/USD", { timeoutMs: 20000 });
      if (!rateRes.ok || !rateRes.body) throw new Error("汇率获取失败（HTTP " + rateRes.status + "）");
      const rateData = JSON.parse(rateRes.body);
      const cny = Number(rateData.rates && rateData.rates.CNY);
      if (!(cny > 0)) throw new Error("汇率数据异常");

      const modelsRes = await api.net.fetch("https://openrouter.ai/api/v1/models", { timeoutMs: 60000 });
      if (!modelsRes.ok || !modelsRes.body) throw new Error("OpenRouter 模型列表获取失败（HTTP " + modelsRes.status + "）");
      const list = JSON.parse(modelsRes.body).data || [];
      if (!list.length) throw new Error("OpenRouter 返回空模型列表");

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
        const detail = skippedCustom ? "已有 " + skippedCustom + " 个模型为自定义单价" : "";
        const missText = misses.length
          ? "，未匹配：" + misses.slice(0, 3).join("、") + (misses.length > 3 ? " 等" : "")
          : "";
        setSaveMsg("同步未填入任何模型" + (detail ? "（" + detail + "）" : "") + missText);
        setTimeout(() => { if (aliveRef.current) setSaveMsg(null); }, 6000);
        return;
      }

      const res = await persistPrices(next);
      if (!aliveRef.current) return;
      if (!res.ok) {
        setSaveMsg("同步结果保存失败：" + (res.error || ""));
      } else {
        setSaveMsg(
          "已同步 " + filled + " 个模型价格（汇率 " + cny.toFixed(2) + "）" +
            (skippedCustom ? "，跳过 " + skippedCustom + " 个已自定义" : "") +
            (misses.length ? "，未匹配 " + misses.length + " 个" : "")
        );
      }
      setTimeout(() => { if (aliveRef.current) setSaveMsg(null); }, 6000);
    } catch (e) {
      if (!aliveRef.current) return;
      setSaveMsg("同步失败：" + (e && e.message ? e.message : String(e)));
      setTimeout(() => { if (aliveRef.current) setSaveMsg(null); }, 6000);
    } finally {
      if (aliveRef.current) setSyncing(false);
    }
  }, [api, priceEdit, modelRows, syncing, persistPrices]);

  const buildCsv = useCallback(() => {
    const cur = prices.currency;
    const lines = [];
    const head = ["模型", "请求数", "错误数", "非缓存输入token", "缓存读token", "缓存写token", "输出token", "成本(" + cur + ")"];
    lines.push(head.map(csvEsc).join(","));
    for (const r of modelRows) {
      lines.push([
        r.model, r.totalRequests, r.errorRequests,
        r.tokens.nonCachedInput, r.tokens.cacheRead, r.tokens.cacheWrite, r.tokens.output,
        r.cost.toFixed(6),
      ].map(csvEsc).join(","));
    }
    lines.push(["合计", modelRows.reduce((s, r) => s + r.totalRequests, 0), modelRows.reduce((s, r) => s + r.errorRequests, 0),
      modelRows.reduce((s, r) => s + r.tokens.nonCachedInput, 0), modelRows.reduce((s, r) => s + r.tokens.cacheRead, 0),
      modelRows.reduce((s, r) => s + r.tokens.cacheWrite, 0), modelRows.reduce((s, r) => s + r.tokens.output, 0),
      totalCost.toFixed(6)].map(csvEsc).join(","));
    if (includeDaily) {
      lines.push("");
      lines.push(["日期", "请求数", "错误数", "非缓存输入token", "缓存读token", "缓存写token", "输出token", "成本(" + cur + ")"].map(csvEsc).join(","));
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
      a.download = "usage-cost-" + isoSince(range) + "-" + isoSince(1) + ".csv";
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setActionMsg("CSV 已导出");
    } catch (e) {
      setActionMsg("导出失败：" + (e && e.message ? e.message : String(e)));
    }
    setTimeout(() => { if (aliveRef.current) setActionMsg(null); }, 2500);
  }, [buildCsv, range]);

  const copyCsv = useCallback(async () => {
    try {
      const res = await api.write.run("system.writeClipboardText", { text: buildCsv() });
      if (!aliveRef.current) return;
      setActionMsg(res && res.ok ? "CSV 已复制到剪贴板" : "复制失败：" + ((res && res.error) || "未知错误"));
    } catch (e) {
      if (!aliveRef.current) return;
      setActionMsg("复制失败：" + (e && e.message ? e.message : String(e)));
    }
    setTimeout(() => { if (aliveRef.current) setActionMsg(null); }, 2500);
  }, [buildCsv]);

  /* ---------- 渲染 ---------- */

  const cur = prices.currency;

  const rangeBtn = (days, label) =>
    h("button", {
      key: "r" + days,
      className: "ucx-btn ucx-range-btn" + (range === days ? " ucx-active" : ""),
      onClick: () => setRange(days),
      title: "最近 " + days + " 天",
    }, label);

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
          const tip = d.date + " | 成本 " + fmtCost(cur, d.cost) + " | 请求 " + fmtInt(d.totalRequests) + " | 错误 " + fmtInt(d.errorRequests);
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
        title: c.label + "单价（每 100 万 token）",
        value: p[c.key],
        onChange: (e) => onPriceCell(scope, model, c.key, e.target.value),
      })
    );

  const priceTable = priceEdit && h("div", { className: "ucx-price-wrap" },
    h("div", { className: "ucx-price-toolbar" },
      h("label", { className: "ucx-currency" },
        "货币符号: ",
        h("input", {
          className: "ucx-currency-input",
          type: "text",
          maxLength: 4,
          value: priceEdit.currency,
          onChange: (e) => setPriceEdit((prev) => ({ ...prev, currency: e.target.value })),
        })
      ),
      h("button", { className: "ucx-btn ucx-primary", onClick: savePrices, title: "保存单价配置" }, "保存单价"),
      h(
        "button",
        {
          className: "ucx-btn",
          onClick: syncFromOpenRouter,
          disabled: syncing,
          title: "从 OpenRouter 拉取当前用量模型的实时价（美元按当日汇率折算人民币），仅填入未自定义单价的模型",
        },
        icon("CloudDownload", 14),
        syncing ? "同步中…" : "同步 OpenRouter 价格"
      ),
      saveMsg ? h("span", { className: /^(已保存|已同步)/.test(saveMsg) ? "ucx-ok" : "ucx-err" }, saveMsg) : null
    ),
    h("div", { className: "ucx-table-wrap" },
    h("table", { className: "ucx-table" },
      h("thead", null,
        h("tr", null,
          h("th", null, "模型 / 默认价"),
          CATS.map((c) => h("th", { key: c.key, title: "每 100 万 token" }, c.label)),
          h("th", null, "操作")
        )
      ),
      h("tbody", null,
        h("tr", { className: "ucx-price-default-row" },
          h("td", { title: "未单独配置的模型使用此默认价" }, "默认价"),
          priceInputs("default", null, priceEdit.defaultPrice),
          h("td", { className: "ucx-muted" }, "-")
        ),
        editorModels.map((m) => {
          const row = priceEdit.models[m] || builtinPriceFor(m) || priceEdit.defaultPrice;
          const isOverride = !!priceEdit.models[m];
          const srcLabel = isOverride ? "自定义" : builtinPriceFor(m) ? "内置估算" : "默认价";
          return h("tr", { key: m },
            h("td", { className: "ucx-model-cell", title: m + " · 当前生效：" + srcLabel }, m),
            priceInputs("model", m, row),
            h("td", null,
              isOverride
                ? h("button", { className: "ucx-btn ucx-small", onClick: () => clearModelPrice(m), title: "清除该模型的自定义单价，回退内置估算或默认价" }, "回退默认")
                : h("span", { className: "ucx-muted" }, srcLabel)
            )
          );
        })
      )
    )
    ),
    h("div", { className: "ucx-hint" }, "单价单位：每 100 万 token。未自定义的模型按内置价计费：GLM-5.3、DeepSeek V4、Qwen3.8-Max 为官方刊例核实价；gpt-6 系（astra / sol / luna）与 claude fable 系为 OpenRouter 实时价按汇率折算；其余为估算，请按实际账单校准；逐行输入后点击保存生效。")
  );

  /* 模型成本表 */
  const costTable = h("table", { className: "ucx-table" },
    h("thead", null,
      h("tr", null,
        h("th", null, "模型"),
        h("th", null, "请求"),
        h("th", null, "错误率"),
        h("th", null, "非缓存输入"),
        h("th", null, "缓存读"),
        h("th", null, "缓存写"),
        h("th", null, "输出"),
        h("th", { className: "ucx-right" }, "成本(" + cur + ")")
      )
    ),
    h("tbody", null,
      modelRows.map((r) =>
        h("tr", { key: r.model },
          h("td", {
            className: "ucx-model-cell",
            title: r.model + " · 价格来源：" + (SOURCE_LABEL[r.priceSource] || r.priceSource),
          },
            r.model,
            r.priceSource !== "custom"
              ? h("span", { className: "ucx-price-src" }, SOURCE_LABEL[r.priceSource] || r.priceSource)
              : null),
          h("td", null, fmtInt(r.totalRequests)),
          h("td", { className: r.errorRequests > 0 ? "ucx-err" : "", title: "错误数 " + fmtInt(r.errorRequests) },
            fmtPct(r.errorRequests, r.totalRequests)),
          h("td", null, fmtTokens(r.tokens.nonCachedInput)),
          h("td", null, fmtTokens(r.tokens.cacheRead)),
          h("td", null, fmtTokens(r.tokens.cacheWrite)),
          h("td", null, fmtTokens(r.tokens.output)),
          h("td", { className: "ucx-right ucx-cost" }, fmtCost(cur, r.cost))
        )
      ),
      h("tr", { className: "ucx-total-row" },
        h("td", null, "合计"),
        h("td", null, fmtInt(modelRows.reduce((s, r) => s + r.totalRequests, 0))),
        h("td", { title: "错误数 " + fmtInt(modelRows.reduce((s, r) => s + r.errorRequests, 0)) },
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
    /* 头部：标题 + 时间范围 + 刷新 */
    h("div", { className: "ucx-header" },
      h("div", { className: "ucx-title" },
        icon("CircleDollarSign", 16),
        h("span", null, "成本核算看板")
      ),
      h("div", { className: "ucx-header-actions" },
        rangeBtn(7, "最近 7 天"),
        rangeBtn(30, "最近 30 天"),
        rangeBtn(90, "最近 90 天"),
        h("button", {
          className: "ucx-btn ucx-icon-btn",
          onClick: () => setRefreshTick((t) => t + 1),
          title: "立即刷新",
        }, icon("RefreshCw", 14)),
        lastUpdated ? h("span", { className: "ucx-muted ucx-updated" }, "更新于 " + lastUpdated.toLocaleTimeString("zh-CN")) : null
      )
    ),

    loading ? h("div", { className: "ucx-state" }, "加载中，正在读取使用量数据...") : null,
    errMsg ? h("div", { className: "ucx-state ucx-err" }, errMsg) : null,
    emptyState ? h("div", { className: "ucx-state" }, "所选时间范围内暂无使用数据。") : null,

    hasData ? h("div", { className: "ucx-cards" },
      card("cost", "总成本（估算）", fmtCost(cur, totalCost), "ucx-card-accent"),
      card("req", "总请求", fmtInt(summary ? summary.totalRequests : 0)),
      card("err", "错误数 / 错误率",
        fmtInt(summary ? summary.errorRequests : 0) + "（" + errRate + "）",
        summary && summary.errorRequests > 0 ? "ucx-card-danger" : ""),
      card("in", "总输入 token", fmtTokens(summary ? summary.totalInputTokens : 0),
        null, summary ? "缓存读 " + fmtTokens(summary.totalCacheReadInputTokens) + " / 缓存写 " + fmtTokens(summary.totalCacheCreationInputTokens) : null),
      card("out", "总输出 token", fmtTokens(summary ? summary.totalOutputTokens : 0))
    ) : null,

    /* 每日成本条形图 */
    hasData && dailyRows.length ? h("div", { className: "ucx-section" },
      h("div", { className: "ucx-section-title" }, icon("BarChart3", 14), "每日成本"),
      maxDailyCost === 0 ? h("div", { className: "ucx-hint" }, "当前价格配置下每日成本均为 0，可先在下方设置单价。") : null,
      chart
    ) : null,

    /* 模型成本表 */
    hasData && modelRows.length ? h("div", { className: "ucx-section" },
      h("div", { className: "ucx-section-title" }, icon("Table2", 14), "模型成本（按成本降序）"),
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
        "含每日明细"
      ),
      h("button", { className: "ucx-btn", onClick: exportCsv, title: "导出 CSV 文件" }, icon("Download", 14), "导出 CSV"),
      h("button", { className: "ucx-btn", onClick: copyCsv, title: "复制 CSV 文本到剪贴板" }, icon("ClipboardCopy", 14), "复制 CSV"),
      actionMsg ? h("span", { className: /失败/.test(actionMsg) ? "ucx-err" : "ucx-ok" }, actionMsg) : null
    ) : null,

    /* 单价设置 */
    h("div", { className: "ucx-section" },
      h("div", { className: "ucx-section-title" }, icon("Settings2", 14), "单价设置"),
      priceTable || h("div", { className: "ucx-state" }, "价格配置加载中...")
    ),

    /* 脚注：口径说明 */
    h("div", { className: "ucx-footer" },
      "成本口径：非缓存输入 = totalInputTokens - totalCacheReadInputTokens（不足为 0）；缓存读 = totalCacheReadInputTokens；缓存写 = totalCacheCreationInputTokens；输出 = totalOutputTokens；成本 = 各部分 token ÷ 1000000 × 对应单价（单价：每 100 万 token，货币符号可配置）。daily/models 维度无 effective 拆分，成本为近似估算；每日成本按各 token 类别的全期混合单价折算，可能与按模型合计略有出入。数据来自 usage 元数据域，每 5 秒轮询。未自定义单价的模型按内置估算价计费，仅作参考，请按实际价格在「单价设置」中校准。"
    )
  );
}
