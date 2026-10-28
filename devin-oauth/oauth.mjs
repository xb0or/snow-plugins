/**
 * Devin 订阅 —— Snow App OAuth 插件适配层
 * ---------------------------------------------------------------------------
 * 上游实现：随本插件分发的 index.mjs（OpenCode provider 插件）
 *
 * 本文件只做契约翻译，不改写上游业务逻辑：
 *   上游 auth.methods[oauth].authorize/callback    -> Snow authorize()/poll()
 *   上游 provider.models                           -> Snow models()
 *   上游 auth.usage                                -> Snow quota()
 *   上游 auth.loader().fetch                       -> Snow fetch()（档 3，Snow 0.5.6+）
 *
 * 对话（GetChatMessage，Connect RPC + protobuf）的编解码仍由上游完成：Snow 的
 * fetch 钩子把一次对话请求原样交给上游 loader 的 fetch，它负责把 chat 编成
 * protobuf 帧、再把响应的 protobuf 帧翻回 OpenAI SSE（index.mjs:1672-1765）。
 * 旧版宿主（0.5.5 及以前）忽略 fetch 钩子，对话仍不可用，其余能力不受影响。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DevinAuthPlugin } from "./index.mjs";

/**
 * 插件版本，用于在「OAuth 登录」来源列表里区分版本。
 * 从同目录的 plugin.json 读，避免与清单里的 version 不同步。
 * （宿主以 pathToFileURL(entry) + "?v=mtime" 加载时，fileURLToPath 会忽略查询串。）
 */
const PLUGIN_VERSION = (() => {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    return JSON.parse(readFileSync(path.join(here, "plugin.json"), "utf8")).version || "";
  } catch {
    return "";
  }
})();

/** 列表里显示的名字：产品名 + 版本，如 "Devin v0.1.0"。 */
const withVersion = (name) => (PLUGIN_VERSION ? `${name} v${PLUGIN_VERSION}` : name);

/** 上游常量（index.mjs:18-30、1896）。 */
const PROVIDER_ID = "devin"; // index.mjs:18
const BASE = "https://server.codeium.com/devin/v1"; // index.mjs:21 SERVER + index.mjs:29 "/devin/v1"

/** 宿主轮询间隔与登录有效期（秒）。上游登录窗口是 10 分钟（index.mjs:30 SIGN_IN_TIMEOUT）。 */
const POLL_INTERVAL = 2;
const SIGN_IN_LIFE = 600;

/** 上游 usage 会写回账号（index.mjs:1907-1929），Snow 由宿主落库，这里给不落库的桩。 */
const noopClient = { auth: { get: async () => ({}), set: async () => ({}) } };

const serverPromise = Promise.resolve(DevinAuthPlugin({ client: noopClient }));

/**
 * 上游 authorize()（index.mjs:911-973 browserSignIn）在 127.0.0.1 起回调服务器等浏览器跳回。
 * Electron 里这不是问题，但没有窗口、靠事件循环退出的调用方（离线契约 harness、CLI）
 * 会被监听句柄与 10 分钟定时器（index.mjs:954）挂住。这里只把本次调用**新建**的监听句柄
 * unref，并在调用期间把新建定时器一并 unref：登录照常工作，进程存活仍由宿主决定。
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
 * 上游登录结果 { key, metadata:{email, plan, orgId, teamId, server?, cli?} }（index.mjs:896-907）。
 * key 是 `devin-session-token$<jwt>`，会话令牌，无 refresh、无到期时间。
 */
function toSnowToken(t) {
  const metadata = t?.metadata && typeof t.metadata === "object" ? t.metadata : {};
  return {
    accessToken: typeof t?.key === "string" ? t.key : "",
    refreshToken: "",
    accountId: typeof metadata.email === "string" ? metadata.email : "",
    email: typeof metadata.email === "string" ? metadata.email : "",
    planType: typeof metadata.plan === "string" ? metadata.plan : "",
    data: { metadata },
  };
}

/**
 * Snow 档案 -> 上游 auth 对象。上游要求 type === "api" 且带 key（index.mjs:1873、1951），
 * 并从 metadata 读 server / cli（index.mjs:1850、1857）。
 */
function toUpstreamAuth(account) {
  const metadata = account?.data?.metadata && typeof account.data.metadata === "object" ? account.data.metadata : {};
  return {
    type: "api",
    key: typeof account?.accessToken === "string" ? account.accessToken : "",
    metadata: {
      ...metadata,
      ...(typeof account?.email === "string" && account.email ? { email: account.email } : {}),
    },
  };
}

const percent = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : 0;
};

/**
 * 配额行的标题。
 * key 必须是 "window"：宿主配额面板的 bucketLabel() 是白名单 switch，只有 case "window"
 * 会原样显示 bucket.label，其余键一律显示「其他」；右侧又固定只显示宿主算出的「剩余 N%」，
 * 所以具体数值必须写进 label（上游 windows[].display 优先，缺了用 amount / limit / unit 拼）。
 */
function windowLabel(w) {
  const name = typeof w?.name === "string" && w.name ? w.name : "usage";
  let display = typeof w?.display === "string" ? w.display.trim() : "";
  if (!display) {
    const amount = Number(w?.amount);
    const limit = Number(w?.limit);
    if (Number.isFinite(amount) || Number.isFinite(limit)) {
      const unit = typeof w?.unit === "string" && w.unit ? ` ${w.unit}` : "";
      display = `${Number.isFinite(amount) ? amount : 0} / ${Number.isFinite(limit) ? limit : 0}${unit}`;
    }
  }
  return [name, display].filter(Boolean).join(" ");
}

/** 上游把重置时间原样透传（index.mjs:1820、1829），字段名是 `*ResetAtUnix`（index.mjs:1815-1816），
 * 所以按 Unix 秒处理；「未核实」Snow 需要的 resetAt 格式，这里统一转 ISO 字符串。
 */
function resetAtOf(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return new Date(n < 1e11 ? n * 1000 : n).toISOString();
}

/** 上游 config() 填出来的 provider 段（index.mjs:1934-1944），模型目录取自它。 */
async function providerSnapshot() {
  const server = await serverPromise;
  const cfg = {};
  await server.config(cfg);
  const entry = cfg?.provider?.[PROVIDER_ID];
  return entry && typeof entry === "object" ? entry : { id: PROVIDER_ID, models: {} };
}

/** 上游 auth 对象。 */
const upstreamAuth = async () => (await serverPromise)?.auth ?? null;

/**
 * 上游 loader 的 fetch 只服务以 /chat/completions 结尾的 OpenAI 请求
 * （index.mjs:1881）。Snow 的 url 一般已经是 baseUrl + "/chat/completions"；
 * 万一不是（自定义 baseUrl、代理前缀），改成上游认得的形状，真正的目标地址
 * 由上游按账号的 server 自己拼（index.mjs:1889-1891）。
 */
function chatCompletionsUrl(raw) {
  try {
    const url = new URL(String(raw));
    if (/\/chat\/completions$/.test(url.pathname)) return url.href;
  } catch {
    /* 非法 url：落到下面的默认值 */
  }
  return `${BASE}/chat/completions`;
}

/** ctx.body 可能是 string（宿主已序列化）、对象或字节；上游按 JSON 解析（index.mjs:1884-1887）。 */
function requestBody(body) {
  if (typeof body === "string") return body;
  if (body instanceof Uint8Array) return body;
  if (body === undefined || body === null) return "{}";
  return JSON.stringify(body);
}

/**
 * 上游 complete() 用全局 fetch 发请求（index.mjs:1677），而 Snow 的出站由
 * Electron net.fetch 统一走应用代理。接管期间把全局 fetch 临时指向 ctx.fetch，
 * 让上游那些请求也走同一套代理解析。上游拿到首个事件后就不再调 fetch（后面只读
 * 已捕获的 reader），所以这个窗口只覆盖到响应建立为止；串行队列避免并发接管时
 * 两个请求抢同一个全局变量。
 */
let hostFetchQueue = Promise.resolve();

function withHostFetch(hostFetch, run) {
  if (typeof hostFetch !== "function") return run();
  const next = hostFetchQueue.then(async () => {
    const real = globalThis.fetch;
    globalThis.fetch = (input, init) => hostFetch(input, init);
    try {
      return await run();
    } finally {
      globalThis.fetch = real;
    }
  });
  hostFetchQueue = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

/** 单次登录的进行中状态：Snow 的 authorize 与 poll 是两次独立调用。 */
let pending = null;

const provider = {
  id: PROVIDER_ID,
  // 列表里显示「产品名 + 版本」；headerScheme 固定不带版本，避免自定义请求头方案名随版本变化
  name: { default: withVersion("Devin"), "zh-CN": withVersion("Devin 订阅") },
  description: {
    default: "Sign in to Devin through app.devin.ai (PKCE callback on 127.0.0.1).",
    "zh-CN": "通过 app.devin.ai 的 PKCE 回调（127.0.0.1）登录 Devin 订阅账号。",
  },
  // 站点官方 logo（下载自 https://app.devin.ai/assets/pwa/pwa-icon-512.png，
  // 512x512 白底 + 深色标记，深浅主题都可见；因为是位图，文件名用 .png）
  icon: "icon.png",
  headerScheme: "Devin",
  flow: "device",
  api: {
    baseUrl: BASE,
    requestMethod: "chat",
    defaultModel: "swe-2-high", // index.mjs:45 SNAPSHOT 第一项的第一个变体
  },

  /**
   * 上游 authorize() 返回 { url, instructions, method:"auto", callback: () => done }：
   * url 是 app.devin.ai 的 PKCE 授权页，callback() 不接受参数，自己等本地回调（index.mjs:967-972）。
   * 上游第二个登录方式 cliSignIn 的 url 是空串（index.mjs:977-995），不满足宿主契约，未导出。
   * 因此映射为 Snow 的 device 流程 + poll()（SPEC 2.3 第 3 条）。
   */
  async authorize(ctx) {
    const auth = await upstreamAuth();
    const method = auth?.methods?.find?.((m) => m.type === "oauth"); // methods[0] 是浏览器登录（index.mjs:1896）
    if (!method || typeof method.authorize !== "function") {
      throw new Error("Devin: 上游插件没有 oauth 登录方式");
    }
    const known = new Set(process._getActiveHandles?.() ?? []);
    const started = await withUnrefedTimers(() => method.authorize());
    unrefNewListeners(known);
    if (!started || typeof started.url !== "string" || !/^https?:\/\//i.test(started.url)) {
      throw new Error("Devin: 上游 authorize() 未返回可打开的 http(s) 地址");
    }

    // 上游 callback() 只 await 内部 promise；第一次 poll 时才真正开始等。
    pending = { started, begun: false, done: false, result: null, error: null };
    ctx?.log?.("devin sign-in started");
    return {
      url: started.url,
      instructions: "在浏览器完成 Devin 登录；登录成功后本窗口会自动完成，无需复制任何内容。",
      interval: POLL_INTERVAL,
      expiresIn: SIGN_IN_LIFE,
      session: {},
    };
  },

  /** 宿主按 interval 轮询；上游 callback 未结束就返回 pending。 */
  async poll() {
    if (!pending) throw new Error("Devin: 没有进行中的登录，请重新发起");
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
    if (!result) throw error instanceof Error ? error : new Error(String(error ?? "Devin 登录失败"));
    if (result.type !== "success") {
      throw new Error(result.error ? String(result.error) : "Devin 登录失败");
    }
    const token = toSnowToken(result);
    if (!token.accessToken) throw new Error("Devin: 登录结果里没有会话令牌");
    return token;
  },

  /**
   * 上游 provider.models(provider, {auth})（index.mjs:1950-1958）：读 Devin / devin CLI 的
   * live 目录；未登录或读取失败时上游回 provider.models（config 里的快照目录）。
   */
  async models(ctx) {
    const server = await serverPromise;
    const snapshot = await providerSnapshot();
    const fallback = Object.keys(snapshot?.models ?? {});
    const upstream = toUpstreamAuth(ctx?.account ?? {});
    if (!upstream.key) return fallback;
    try {
      const live = await server.provider.models(snapshot, { auth: upstream });
      const ids = Object.keys(live ?? {});
      return ids.length ? ids : fallback;
    } catch {
      return fallback;
    }
  },

  /** 上游 auth.usage(getAuth)（index.mjs:1902-1932 -> index.mjs:1793-1834）：套餐与额度。 */
  async quota(ctx) {
    const auth = await upstreamAuth();
    if (!auth || typeof auth.usage !== "function") return { groups: [] };
    const account = ctx?.account ?? {};
    const upstream = toUpstreamAuth(account);
    if (!upstream.key) return { groups: [] };
    const usage = await auth.usage(async () => upstream);
    const windows = Array.isArray(usage?.windows) ? usage.windows : [];
    // key 固定为 "window"（见 windowLabel 的说明）；具体数值由 label 带出。
    const buckets = windows.map((w) => ({
      key: "window",
      label: windowLabel(w),
      usedPercent: percent(w?.used),
      ...(resetAtOf(w?.resetsAt) ? { resetAt: resetAtOf(w?.resetsAt) } : {}),
    }));
    // 上游把额外余额放在 balance（index.mjs:1832），套餐结束时间放在 until（index.mjs:1807）
    const label = typeof usage?.balance === "string" && usage.balance ? usage.balance : PROVIDER_ID;
    return buckets.length ? { plan: label, groups: [{ id: PROVIDER_ID, label, buckets }] } : { groups: [] };
  },

  /**
   * 对话接管（档 3，Snow 0.5.6+ 的 fetch 钩子）。
   *
   * 上游 auth.loader(getAuth) 返回 { baseURL, apiKey, fetch }（index.mjs:1871-1893）。
   * 它的 fetch 本身就是"OpenAI chat -> GetChatMessage"的完整翻译层：出站用
   * build()/frame() 把 chat 编成 Connect 帧（index.mjs:1674），入站用 frames()/events()
   * 把 protobuf 帧翻回 chat.completion.chunk 的 SSE（index.mjs:1672-1765）。
   * 因此这里不做任何协议翻译，只把这次请求交过去并原样返回它的 Response——
   * 宿主会读完整正文再按 SSE 逐条解析（_shared/SPEC.md 4.5 节）。
   *
   * 已知代价（宿主文档写明）：绕过打字机式流式、跨协议工具归一化、原生重试；
   * 服务商列表会标注「自定义传输」。
   */
  async fetch(ctx) {
    const account = toUpstreamAuth(ctx?.account ?? {});
    if (!account.key) {
      return {
        status: 401,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ error: { message: "Devin isn't signed in", type: "devin_error", code: 401 } }),
      };
    }
    const auth = await upstreamAuth();
    if (!auth || typeof auth.loader !== "function") {
      throw new Error("Devin: 上游插件没有 auth.loader");
    }
    const client = await auth.loader(async () => account);
    if (!client || typeof client.fetch !== "function") {
      throw new Error("Devin: 上游 loader 没有返回 fetch（账号缺少会话令牌）");
    }
    const url = chatCompletionsUrl(ctx?.url);
    const init = {
      method: typeof ctx?.method === "string" && ctx.method ? ctx.method : "POST",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: requestBody(ctx?.body),
    };
    return withHostFetch(ctx?.fetch, () => client.fetch(url, init));
  },
};

export default { providers: [provider] };
