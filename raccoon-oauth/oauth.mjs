/**
 * 商汤小浣熊（Raccoon）—— Snow App OAuth 插件适配层
 * ---------------------------------------------------------------------------
 * 上游实现：随本插件分发的 index.mjs
 *           （OpenCode provider 插件，RaccoonAuthPlugin）
 *
 * 本文件只做契约翻译，不改写上游业务逻辑：
 *   上游 auth.methods[oauth].authorize/callback -> Snow authorize()/poll()
 *   上游 auth.methods[oauth].callback(input)    -> Snow exchange()（手动粘贴）
 *   上游 auth.refresh                           -> Snow refresh()
 *   上游 provider.models                        -> Snow models()
 *   上游 auth.usage                             -> Snow quota()
 *   上游 loader.fetch 里"出站"的头改写            -> Snow transformRequest()
 *
 * 所有网络请求仍由上游模块发出（上游用全局 fetch）。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { RaccoonAuthPlugin, _internal } from "./index.mjs";

/**
 * 插件版本，用于在「OAuth 登录」来源列表里区分版本。
 * 从同目录的 plugin.json 读，避免与清单里的 version 不同步。
 * （宿主以 pathToFileURL(entry) + "?v=mtime" 加载，fileURLToPath 会忽略查询串。）
 */
const PLUGIN_VERSION = (() => {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    return JSON.parse(readFileSync(path.join(here, "plugin.json"), "utf8")).version || "";
  } catch {
    return "";
  }
})();

/** 列表里显示的名字：产品名 + 版本。 */
const withVersion = (name) => (PLUGIN_VERSION ? `${name} v${PLUGIN_VERSION}` : name);

/** 上游 provider id（index.mjs:15）。 */
const PROVIDER_ID = "raccoon";

/** 上游对话基址（index.mjs:21 llmBase()）。 */
const LLM_BASE = "https://xiaohuanxiong.com/api/web/llm/v2";

/**
 * 上游默认模型：FALLBACK_MODELS 里标着"默认"的那一项
 * （index.mjs:44，parseCatalog 也在末尾补它，index.mjs:333-335）。
 */
const DEFAULT_MODEL = "raccoon-chat-ml-5-5";

/** 宿主轮询间隔（秒）。 */
const POLL_INTERVAL = 2;

/** 上游浏览器登录超时 10 分钟（index.mjs:776 默认参数）。 */
const SIGN_IN_LIFE = 600;

/** 上游只用 client.auth.set 落库轮换后的令牌，Snow 由宿主落库。 */
const noopClient = { auth: { get: async () => ({}), set: async () => ({}) } };

/** 上游插件实例（模块级单例，poll 需要跨调用持有 callback 闭包）。 */
const serverPromise = Promise.resolve(RaccoonAuthPlugin({ client: noopClient }));

/** 单次浏览器登录的进行中状态。 */
let pending = null;
/** 单次手动登录的 callback 闭包（exchange 时调用）。 */
let manual = null;

/**
 * 上游 browserSignIn（index.mjs:776-840）在 127.0.0.1 起回调服务器，
 * 并挂 10 分钟超时定时器（index.mjs:832，已自带 unref）。
 * 这里只把本次调用**新建**的监听句柄 unref，登录照常工作。
 */
function unrefNewListeners(known) {
  try {
    const now = typeof process._getActiveHandles === "function" ? process._getActiveHandles() : [];
    for (const h of now) {
      if (known.has(h) || !h || typeof h.unref !== "function") continue;
      if (h.listening === true && typeof h.address === "function") h.unref();
    }
  } catch {
    /* 宿主没有该 API 时忽略 */
  }
}

/** 只覆盖本次 authorize 调用期间新建的定时器。 */
async function withUnrefedTimers(fn) {
  const real = globalThis.setTimeout;
  globalThis.setTimeout = (...args) => {
    const timer = real(...args);
    timer?.unref?.();
    return timer;
  };
  try {
    return await fn();
  } finally {
    globalThis.setTimeout = real;
  }
}

/**
 * 上游登录结果（index.mjs:759-774 toSuccessAuth）：
 *   { type:"success", access, refresh, expires, accountId, uid, name?, source? }
 * Snow 只有固定字段，其余塞进 data，refresh/usage/models 再从 data 读回。
 */
function toSnowToken(t) {
  const data = {};
  const put = (k, v) => {
    if (typeof v === "string" && v) data[k] = v;
  };
  put("uid", t?.uid);
  put("name", t?.name);
  put("source", t?.source);
  if (t?.onboardingSettled === true) data.onboardingSettled = true;
  return {
    accessToken: typeof t?.access === "string" ? t.access : "",
    refreshToken: typeof t?.refresh === "string" ? t.refresh : "",
    // 上游 expires 是 JWT 的 exp 毫秒（index.mjs:66-70），Snow 接受毫秒
    expiresAt: Number(t?.expires) || 0,
    accountId: typeof t?.accountId === "string" ? t.accountId : "",
    email: "",
    planType: "",
    ...(Object.keys(data).length ? { data } : {}),
  };
}

/** Snow 档案 -> 上游 auth 对象（上游读 type/access/refresh/expires/uid/name/source/accountId）。 */
function toUpstreamAuth(account) {
  const d = account?.data && typeof account.data === "object" ? account.data : {};
  const str = (v) => (typeof v === "string" ? v : "");
  const out = {
    type: "oauth",
    access: str(account?.accessToken),
    refresh: str(account?.refreshToken),
    expires: Number(account?.expiresAt) || 0,
    accountId: str(account?.accountId),
    uid: str(d.uid),
    name: str(d.name),
  };
  if (str(d.source)) out.source = str(d.source);
  if (d.onboardingSettled === true) out.onboardingSettled = true;
  return out;
}

/** 上游 refresh 只回变化字段（index.mjs:936-942），缺的用档案旧值补。 */
function mergeToken(account, next) {
  const snow = toSnowToken(next);
  const prev = account?.data && typeof account.data === "object" ? account.data : {};
  return {
    accessToken: snow.accessToken || account?.accessToken || "",
    refreshToken: snow.refreshToken || account?.refreshToken || "",
    expiresAt: snow.expiresAt || Number(account?.expiresAt) || 0,
    accountId: snow.accountId || account?.accountId || "",
    data: { ...prev, ...(snow.data ?? {}) },
  };
}

const percent = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : 0;
};

/**
 * 配额面板的行标题。宿主的 bucketLabel() 只在 key === "window" 时原样显示 label，
 * 右侧永远只显示「剩余 N%」，所以具体数值必须写进 label：
 * 上游 windows[].display 优先（如 "12 / 100"），没有就用 amount/limit/unit 拼。
 */
function bucketLabel(w, fallback) {
  const name = typeof w?.name === "string" && w.name ? w.name : "";
  let detail = typeof w?.display === "string" ? w.display.trim() : "";
  if (!detail) {
    const amount = w?.amount;
    const limit = w?.limit;
    if (amount != null && limit != null) detail = `${amount} / ${limit}${w?.unit ? ` ${w.unit}` : ""}`;
  }
  return [name, detail].filter(Boolean).join(" ") || fallback;
}

/** 上游 config() 填出来的静态模型表（index.mjs:901-911）。 */
async function catalog() {
  const server = await serverPromise;
  const cfg = {};
  await server.config(cfg);
  const models = cfg?.provider?.[PROVIDER_ID]?.models;
  return models && typeof models === "object" ? models : {};
}

/** 浏览器登录（device 流程）：上游 callback() 不接受参数。 */
async function startBrowserSignIn(ctx) {
  const server = await serverPromise;
  const list = Array.isArray(server?.auth?.methods) ? server.auth.methods : [];
  // methods[0] 是浏览器登录（index.mjs:1064-1068）；label 变了就按固定顺序兜底
  const method = list.find((m) => m.type === "oauth" && m.label?.includes("浏览器")) ?? list[0];
  if (!method || typeof method.authorize !== "function") {
    throw new Error("raccoon：上游插件没有浏览器登录方式");
  }
  const known = new Set(process._getActiveHandles?.() ?? []);
  const started = await withUnrefedTimers(() => method.authorize());
  unrefNewListeners(known);
  if (!started || typeof started.url !== "string" || !/^https?:\/\//i.test(started.url)) {
    throw new Error("raccoon：上游 authorize() 未返回可打开的 http(s) 地址");
  }
  pending = { started, begun: false, done: false, result: null, error: null };
  ctx?.log?.("raccoon sign-in started");
  return {
    url: started.url,
    instructions: started.instructions ?? "在浏览器完成商汤小浣熊登录并确认授权，本窗口会自动继续。",
    interval: POLL_INTERVAL,
    expiresIn: SIGN_IN_LIFE,
    session: {},
  };
}

/**
 * 手动粘贴那一路的上游入口（methods[2]，index.mjs:1074-1078 -> manualSignIn 842-860）。
 * 上游 authorize() 不联网，只给出授权页与一个接受粘贴内容的 callback。
 * 合并成单个 provider 后这条路仍然保留；消费掉或失败后再次调用会重新准备。
 */
async function prepareManualCallback() {
  try {
    const server = await serverPromise;
    const list = Array.isArray(server?.auth?.methods) ? server.auth.methods : [];
    // methods[2] 是手动粘贴；label 变了就按固定顺序兜底（取最后一个）
    const method = list.find((m) => m.type === "oauth" && m.label?.includes("手动")) ?? list[list.length - 1];
    if (!method || typeof method.authorize !== "function") return null;
    const started = await method.authorize();
    return typeof started?.callback === "function" ? started.callback : null;
  } catch {
    return null;
  }
}

/** 一个 Snow provider。 */
const provider = {
  id: PROVIDER_ID,
  // 列表里显示「产品名 + 版本」；headerScheme 固定不带版本，避免自定义请求头方案名随版本变化
  name: { default: withVersion("Raccoon (SenseTime)"), "zh-CN": withVersion("商汤小浣熊") },
  description: {
    default: "Sign in to SenseTime Raccoon through its desktop authorization page (local callback on 127.0.0.1).",
    "zh-CN": "通过商汤小浣熊的桌面授权页登录（127.0.0.1 本地回调），使用其模型额度。",
  },
  // 站点官方 logo（下载自 xiaohuanxiong.com 的 <link rel="icon">，见 README）
  icon: "icon-raccoon.svg",
  // 浏览器登录与手动粘贴是同一产品的两个入口，共用同一个请求头方案名
  headerScheme: "Raccoon (SenseTime)",
  // 声明 panel 后宿主在登录弹窗内渲染插件面板，不再自动打开浏览器；
  // 面板负责把授权页交给系统浏览器（panel 模式下宿主不会代劳）。
  flow: "panel",
  panel: {
    entry: "panel/login.js",
    title: { default: "SenseTime Raccoon sign-in", "zh-CN": "商汤小浣熊登录" },
  },
  // 上游在令牌到期前 5 分钟续期（index.mjs:24 LEAD_MS）
  refreshLeadSeconds: 300,
  api: {
    baseUrl: LLM_BASE,
    requestMethod: "chat",
    defaultModel: DEFAULT_MODEL,
  },

  /**
   * 上游 methods[0]（index.mjs:1064-1068）：起 127.0.0.1 回调服务器，
   * 返回 { url, instructions, method:"auto", callback() }，callback() 不接受参数。
   * methods[1] 是读本机客户端登录态（url 为空，无浏览器可打开），
   * methods[2] 是手动粘贴，分别见 README 的说明。
   */
  async authorize(ctx) {
    // 先把手动粘贴那一路的上游入口备好：面板里「等浏览器授权」与「粘贴回调」两条路都可用
    manual = await prepareManualCallback();
    return startBrowserSignIn(ctx);
  },

  /** 宿主按 interval 轮询；上游 callback 未结束就返回 pending。 */
  async poll() {
    if (!pending) throw new Error("raccoon：没有进行中的登录，请重新发起");
    if (!pending.begun) {
      pending.begun = true;
      const state = pending;
      const { started } = state;
      Promise.resolve()
        .then(() => started.callback())
        .then(
          (value) => {
            state.result = value;
            state.done = true;
          },
          (error) => {
            state.error = error;
            state.done = true;
          },
        );
    }
    if (!pending.done) return { pending: true };
    const { result, error } = pending;
    pending = null;
    if (!result) throw error instanceof Error ? error : new Error(String(error ?? "raccoon 登录失败"));
    if (result.type !== "success") {
      throw new Error(result.error ? String(result.error) : "raccoon 登录失败");
    }
    const token = toSnowToken(result);
    if (!token.accessToken) throw new Error("raccoon：登录结果里没有 access_token");
    return token;
  },

  /** 上游 auth.refresh(auth)（index.mjs:932-943 -> currentAuth 232-288）。 */
  async refresh(ctx) {
    const server = await serverPromise;
    const account = ctx?.account ?? {};
    const upstream = toUpstreamAuth(account);
    if (!upstream.refresh) throw new Error("raccoon：没有 refresh token，请重新登录");
    const next = await server.auth.refresh(upstream);
    if (!next) throw new Error("raccoon：续期未返回新令牌，请重新登录");
    return mergeToken(account, next);
  },

  /**
   * 上游 provider.models(provider, { auth })（index.mjs:914-927）：
   * 读实时目录，失败时回退到 config() 的静态表。
   */
  async models(ctx) {
    const server = await serverPromise;
    const fallback = await catalog();
    const fallbackIds = Object.keys(fallback);
    const listed = await server.provider.models({ id: PROVIDER_ID, models: fallback }, { auth: toUpstreamAuth(ctx?.account ?? {}) });
    const ids = Object.keys(listed ?? {});
    return ids.length ? ids : fallbackIds;
  },

  /**
   * 上游 auth.usage(getAuth)（index.mjs:1011-1042 -> queryUsage 533-597）：
   * { plan, until?, windows:[{name, used, display, ...}], balance? } 或 { error }。
   */
  async quota(ctx) {
    const server = await serverPromise;
    const account = ctx?.account ?? {};
    const upstream = toUpstreamAuth(account);
    if (!upstream.access) return { groups: [] };
    const usage = await server.auth.usage(async () => upstream);
    if (!usage || usage.error) {
      if (usage?.error) ctx?.log?.(`raccoon usage: ${String(usage.error)}`);
      return { groups: [] };
    }
    const windows = Array.isArray(usage.windows) ? usage.windows : [];
    const resetAt = typeof usage.until === "string" && usage.until ? usage.until : undefined;
    // key 固定 "window"：宿主配额面板的 bucketLabel() 是白名单 switch，
    // 只有 case "window" 会原样显示 bucket.label，其余键一律显示「其他」。
    const buckets = windows.map((w, i) => ({
      key: "window",
      label: bucketLabel(w, `bucket-${i}`),
      usedPercent: percent(w?.used),
      ...(resetAt ? { resetAt } : {}),
    }));
    if (!buckets.length) {
      // 上游在没有可核算账单时只给余额（index.mjs:591-596），这里落成一个不显示百分比的 bucket；
      // key 同样必须是 "window"（白名单 switch 只认它），具体数值（"1234 credits"）写在 label 里。
      const balance = typeof usage.balance === "string" ? usage.balance : "";
      if (!balance) return { groups: [] };
      const label = typeof usage.plan === "string" && usage.plan ? usage.plan : "Raccoon";
      return {
        plan: label,
        groups: [{ id: PROVIDER_ID, label, buckets: [{ key: "window", label: balance, usedPercent: 0 }] }],
      };
    }
    const label = typeof usage.plan === "string" && usage.plan ? usage.plan : "Raccoon";
    return { plan: label, groups: [{ id: PROVIDER_ID, label, buckets }] };
  },

  /**
   * 出站改写：复现上游 loader.fetch 里属于出站的头（index.mjs:982-995）：
   * 删掉 x-api-key，Authorization 用 Bearer <access>，Content-Type / Accept 固定。
   * 响应侧的模型名改写（index.mjs:407-465 rewriteSseModel）属于宿主没有的钩子，不做。
   */
  transformRequest(ctx) {
    const token = typeof ctx?.account?.accessToken === "string" ? ctx.account.accessToken : "";
    if (!token) return undefined;
    return {
      headers: {
        authorization: `Bearer ${_internal.stripBearer(token)}`,
        "x-api-key": null,
        "content-length": null,
        "content-type": "application/json",
        accept: "*/*",
      },
    };
  },

  /**
   * 手动粘贴那一路（面板里的粘贴区）。
   *
   * 用户把 `office-raccoon://auth/callback?code=...` 或 JWT access_token 粘进面板，
   * 宿主的自定义面板经 `api.oauth.submitCallback()` 调到这里；上游 callback(input)
   * 自己做 state 校验、JWT 直填与换取（index.mjs:842-860）。
   *
   * 与浏览器那一路共用同一个 provider：谁先完成都落到同一个 Snow 会话上。
   */
  async exchange(ctx) {
    const raw = typeof ctx?.code === "string" ? ctx.code : "";
    if (!raw.trim()) throw new Error("商汤小浣熊：没有收到粘贴的内容");
    // 已消费或还没准备（例如上次粘贴失败）时重新准备一次
    const run = manual ?? (await prepareManualCallback());
    if (!run) throw new Error("商汤小浣熊：粘贴入口不可用，请重新发起登录");
    manual = null;
    const result = await run(raw);
    if (!result || result.type !== "success") {
      throw new Error(result?.error ? String(result.error) : "商汤小浣熊登录失败");
    }
    const token = toSnowToken(result);
    if (!token.accessToken) throw new Error("商汤小浣熊：登录结果里没有 access_token");
    return token;
  },
};

export default { providers: [provider] };
