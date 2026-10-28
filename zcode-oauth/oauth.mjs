/**
 * ZCode（Z.ai / BigModel 的 GLM Coding Plan）—— Snow App OAuth 插件适配层
 * ---------------------------------------------------------------------------
 * 上游实现：随本插件分发的 index.mjs（OpenCode provider 插件）
 *
 * 本文件只做契约翻译与请求/响应改写，不改上游逻辑：
 *   上游 auth.methods[oauth].authorize()/callback()  ->  Snow authorize()/poll()
 *   上游 provider.models(provider, { auth })         ->  Snow models()
 *   上游 auth.usage(getAuth, provider)               ->  Snow quota()
 *   上游 loader.fetch 中「自带 Coding Plan key」分支的出站部分 -> Snow transformRequest()
 *   上游 loader.fetch 中 Start Plan 分支的出站伪装             -> Snow transformRequest()
 *   上游 loader.fetch 中 Start Plan 分支的响应侧拒绝文案        -> Snow transformResponse()（0.5.6+）
 *
 * 登录走 zcode.z.ai 的 OAuth CLI 流程：init 拿授权页，再轮询
 * /api/v1/oauth/cli/poll（index.mjs:941-998），不需要宿主监听本地端口，
 * 因此映射为 flow: "device"。
 *
 * 上游没有 refresh 钩子：自带的 Coding Plan key 不会过期（index.mjs:992），
 * Start Plan 的 JWT 无法刷新、过期只能重新登录（index.mjs:12-13、1815），
 * 所以本插件不导出 refresh。
 *
 * 账号自带 Coding Plan key（个体订阅，以及登录时已经把 key 铸好写进登录状态的团队席位，
 * index.mjs:860、864、909）走标准 Anthropic Messages，只需出站补 x-api-key
 * （index.mjs:1827-1834）。Start Plan（只有 zcode.z.ai 的 JWT）还要按 ZCode 自己的
 * 样子发请求：换基址、换整套请求头、用 dress 重写整段系统提示词（index.mjs:1814-1826），
 * 并在被拒时改写正文（index.mjs:1838-1842）；前者做在 transformRequest，后者做在
 * transformResponse（Snow 0.5.6+，旧版宿主忽略它，只退化这句文案）。
 */
import { readFileSync } from "node:fs";
import { release } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ZCodeAuthPlugin, _internal } from "./index.mjs";

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

/** 列表里显示的名字：产品名 + 版本，如 "ZCode (GLM Coding Plan) v0.1.0"。 */
const withVersion = (name) => (PLUGIN_VERSION ? `${name} v${PLUGIN_VERSION}` : name);

/** 上游 provider id（index.mjs:25）。 */
const PROVIDER_ID = "zcode";

/** 上游 provider 基址：ZAI_BASE + "/v1"（index.mjs:29、1705）。 */
const ZAI_BASE = "https://api.z.ai/api/anthropic";
const BASE = ZAI_BASE + "/v1";

/** 上游两个站点的 Anthropic 端点前缀（index.mjs:29-30），用于出站换站。 */
const PLAN_PREFIXES = [ZAI_BASE, "https://open.bigmodel.cn/api/anthropic"];

/** 上游默认模型（index.mjs:36-41 MODELS 首项）。 */
const DEFAULT_MODEL = "GLM-5.3";

/** 上游给 GLM-5.3 的上下文窗口（index.mjs:37 context: 1_000_000）。 */
const DEFAULT_CONTEXT = 1_000_000;

/** 轮询间隔（秒）由上游 poll_interval_sec 决定（index.mjs:958）；这里给宿主一个默认值。 */
const POLL_INTERVAL = 2;
const SIGN_IN_LIFE = 300;

/**
 * 上游用 client.app.log 记错、用 client.auth.set 落库（index.mjs:1688-1692、1770）。
 * Snow 里落库由宿主通过 refresh/quota 的返回值完成，这里给不落库的桩；
 * 上游的错误信息同时会作为 callback 的 error 返回，由 poll 原样抛出。
 */
const noopClient = { app: { log: () => {} }, auth: { set: async () => ({}) } };

/** 上游插件实例（模块级单例，poll 需要跨调用持有 callback 闭包）。 */
const serverPromise = ZCodeAuthPlugin({ client: noopClient });

/** 单次登录的进行中状态。Snow 的 authorize/poll 是两次独立调用。 */
let pending = null;

/** 上游 auth（index.mjs:987-994）-> Snow 令牌对象。 */
function toSnowToken(t) {
  return {
    accessToken: typeof t?.access === "string" ? t.access : "",
    // 上游把 site/base/key/jwt/plan/device 打包进 refresh 字段的 JSON（index.mjs:989）
    refreshToken: typeof t?.refresh === "string" ? t.refresh : "",
    expiresAt: Number(t?.expires) || 0,
    accountId: typeof t?.accountId === "string" ? t.accountId : "",
    planType: typeof t?.plan === "string" ? t.plan : "",
  };
}

/** Snow 档案 -> 上游 auth 对象（stateOf 读 type/refresh/access/key/metadata，index.mjs:1175-1201）。 */
function toUpstreamAuth(account) {
  return {
    type: "oauth",
    access: typeof account?.accessToken === "string" ? account.accessToken : "",
    refresh: typeof account?.refreshToken === "string" ? account.refreshToken : "",
    expires: Number(account?.expiresAt) || 0,
    accountId: typeof account?.accountId === "string" ? account.accountId : "",
  };
}

/** 上游 provider 快照；空表时 models() 会自己填（index.mjs:1713-1745）。 */
const providerSnapshot = () => ({ id: PROVIDER_ID, models: {} });

/**
 * 上游没给 display 的窗口（只给百分比、或本就没有配额的窗口）用 amount/limit/unit 拼一个带数值的说明。
 * 上游只在同时给出用量与总量时才填 display（index.mjs:387、392、525），两条路都可能走到。
 */
function detailOf(w) {
  const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const amount = num(w?.amount);
  const limit = num(w?.limit);
  const unit = typeof w?.unit === "string" && w.unit ? w.unit : "";
  if (amount !== null && limit !== null) return [`${amount} / ${limit}`, unit].filter(Boolean).join(" ");
  return limit !== null ? [String(limit), unit].filter(Boolean).join(" ") : "";
}

/** 上游 windows -> Snow quota。windows 项形如 { name, used, display?, amount?, limit?, unit?, resetsAt?, aside? }（index.mjs:507-542）。 */
function toQuota(result) {
  const windows = Array.isArray(result?.windows) ? result.windows : [];
  const buckets = windows.map((w, i) => {
    const used = Number(w?.used);
    const name = String(w?.name ?? `bucket-${i}`);
    // key 必须是 "window"：宿主配额面板的行标题是白名单 switch（ChatContent.js 的 bucketLabel()），
    // 只有 case "window" 会原样显示 bucket.label，其余键一律显示「其他」。
    // 右侧固定显示「剩余 N%」，插件无法替换，所以具体数值必须写进 label。
    const detail = typeof w?.display === "string" && w.display ? w.display : detailOf(w);
    return {
      key: "window",
      label: [name, detail].filter(Boolean).join(" "),
      ...(Number.isFinite(used) ? { usedPercent: Math.max(0, Math.min(100, used)) } : {}),
      ...(typeof w?.resetsAt === "string" ? { resetAt: w.resetsAt } : {}),
    };
  });
  return {
    ...(typeof result?.plan === "string" && result.plan ? { plan: result.plan } : {}),
    groups: [{ id: "zcode", label: "GLM Coding Plan 用量", buckets }],
  };
}

/** 账号存的登录状态（refresh 字段的 JSON，index.mjs:989 / stateOf 1175-1195）。 */
function stateOfAccount(account) {
  try {
    const s = JSON.parse(String(account?.refreshToken ?? ""));
    return s && typeof s === "object" && !Array.isArray(s) ? s : null;
  } catch {
    return null;
  }
}

/**
 * ---- Start Plan：出站伪装与响应侧拒绝文案（复刻 index.mjs:1378-1413、1426-1460）----
 *
 * 上游给「只有 zcode.z.ai JWT 的账号」准备了两样东西：
 *  - 请求要像 ZCode 自己发出的：换基址（index.mjs:1817 的 swap）、去掉查询串
 *    （index.mjs:1569-1572 startURL）、整套换请求头（index.mjs:1435-1460 startHeaders）、
 *    用 dress 重写整段提示词（index.mjs:1641-1683）——由 transformRequest 做；
 *  - 被 zcode.z.ai 拒绝时（405 / 拦截页 / code 3012）改写整段正文
 *    （index.mjs:1396 startRefused、index.mjs:1400-1413 startBlocked，调用点
 *    index.mjs:1838-1842）——由 transformResponse（Snow 0.5.6+）做。
 *
 * 上游只导出 dress / spentUp / stateOf / plan 相关的一部分（index.mjs:1957）。
 * startHeaders / startRefused / startBlocked 以及它们依赖的字面量（START_BLOCKED、
 * EDGE_BLOCKED、START_REFUSED、STATUS_TEXT、first、platform、osCategory、intl、uuid）
 * 都没有导出，下面按上游逐行复刻，各自标注出处行号；上游改版时这几处要同步。
 * 「Start Plan 走哪条路」的判定不在这里，见 startState。
 */

/** 上游 Start Plan 的站点与请求基址（index.mjs:26、31）。 */
const ZCODE = "https://zcode.z.ai";
const START_BASE = ZCODE + "/api/v1/zcode-plan/anthropic";

/** 上游伪装头里的应用版本（index.mjs:32-33）。 */
const APP_VERSION = "3.16.3";
const UA = "ZCode/" + APP_VERSION;

/** 上游 Start Plan 被拒时补的那句说明（index.mjs:1390）。 */
const START_BLOCKED =
  "ZCode's Start Plan still turned this request away, though magpie sends it as the ZCode app does; it can be a network block of this IP, or ZCode checking for something new. Use an account with a GLM Coding Plan, or add another provider to this group";

/** 上游判「被拦」用的两条正则与状态名表（index.mjs:1391-1392、55-59）。 */
const EDGE_BLOCKED = /request has been blocked|errors\.aliyun\.com/i;
const START_REFUSED = /unusual activity|"code"\s*:\s*"?3012\b/i;
const STATUS_TEXT = {
  400: "Bad Request",
  401: "Unauthorized",
  403: "Forbidden",
  404: "Not Found",
  405: "Method Not Allowed",
  408: "Request Timeout",
  429: "Too Many Requests",
  500: "Internal Server Error",
  502: "Bad Gateway",
  503: "Service Unavailable",
  504: "Gateway Timeout",
};

/** 上游 first（index.mjs:53）；未导出，就地复刻。 */
const firstString = (...ss) => ss.map((s) => (typeof s === "string" ? s.trim() : "")).find((s) => s) ?? "";

/** 上游 platform / osCategory / intl / uuid（index.mjs:50、1416、1418-1424、51）；未导出。 */
const platform = () => `${process.platform}-${process.arch}`;
const osCategory = () =>
  process.platform === "darwin" ? "macos" : process.platform === "win32" ? "windows" : "linux";
const uuid = () => crypto.randomUUID();
function intl() {
  try {
    return Intl.DateTimeFormat().resolvedOptions();
  } catch {
    return {};
  }
}

/**
 * 上游 startHeaders（index.mjs:1435-1460）：Start Plan 的请求头，ZCode 自己的那一套，
 * 外加 body 的 content-type，别的都不带（agent 自己的 anthropic-beta、x-claude-code-*
 * 都不带）。与上游的差别只有一处：这里收 content-type 字符串，而不是 Headers 对象。
 */
function startHeaders(contentType, jwt) {
  const out = {};
  out["content-type"] = contentType || "application/json";
  out["Authorization"] = "Bearer " + jwt;
  out["anthropic-version"] = "2023-06-01";
  out["HTTP-Referer"] = ZCODE;
  out["User-Agent"] = UA + " ai-sdk/anthropic/3.0.81";
  out["X-ZCode-App-Version"] = APP_VERSION;
  out["X-Title"] = "Z Code@cli";
  out["X-Release-Channel"] = "production";
  const o = intl();
  out["X-Client-Language"] = o.locale || "unknown";
  out["X-Client-Timezone"] = o.timeZone || "unknown";
  out["X-ZCode-Agent"] = "glm";
  out["X-Platform"] = platform();
  out["X-Os-Category"] = osCategory();
  out["X-Os-Version"] = release();
  out["x-request-id"] = uuid();
  out["x-zcode-session-type"] = "main";
  out["x-zcode-trace-id"] = uuid();
  out["x-zcode-query-source"] = "main_turn";
  return out;
}

/** 上游 startRefused（index.mjs:1396）。 */
const startRefused = (status, text) =>
  status >= 400 && (status === 405 || EDGE_BLOCKED.test(text) || START_REFUSED.test(text));

/**
 * 上游 startBlocked 里那句给用户看的说明（index.mjs:1400-1413）：厂商自己的话，
 * 缺了就用状态名，再接 START_BLOCKED。与上游的差别只有一处：响应钩子的 ctx 里没有
 * statusText（SPEC 4.5），状态名表里没有的状态码就只写数字。
 */
function blockedMessage(status, text) {
  let said = "";
  if (!EDGE_BLOCKED.test(text)) {
    try {
      const v = JSON.parse(text);
      said = firstString(v?.error?.message, typeof v?.error === "string" ? v.error : "", v?.message, v?.msg);
    } catch {
      /* 拦截页不是 JSON：退回状态名 */
    }
  }
  said ||= `${status} ${STATUS_TEXT[status] ?? ""}`.trim();
  return `${said} — ${START_BLOCKED}`;
}

/**
 * Start Plan 形态的登录状态：有 jwt、没有 Coding Plan key、也不是团队席位。
 * 上游 plansOf 的两个本地短路就是这个判定（index.mjs:207-208），它们不发请求；
 * 有 key 的账号要读计划列表才知道走哪条路（index.mjs:215-227），而钩子里不能发网络
 * 请求，所以按 Coding Plan 处理——与上游「计划列表读不到时仍走 Coding Plan」的兜底一致。
 */
function startState(account) {
  const s = stateOfAccount(account);
  if (!s || (s.org && s.project)) return null; // isTeam(s)（index.mjs:102）：团队席位
  if (!s.jwt || s.key) return null;
  return s;
}

/**
 * Start Plan 的请求（上游 index.mjs:1814-1826）：换基址、去掉查询串、整套换请求头、
 * 用上游导出的 _internal.dress 把 body 变成 ZCode 自己会发的样子。
 * 上游在这里还会先判 jwt 是否过期并抛 EXPIRED（index.mjs:1815，jwtExpired 未导出），
 * 本插件不复刻这一句：过期的 jwt 会被上游以 401 拒绝，看到的是厂商自己的话。
 * place 传空对象：上游的 cwd / git 来自 magpie 自己的 x-magpie-* 头，Snow 没有这对头，
 * 上游在这种情况下同样把这两行留空（index.mjs:1599-1604、1610-1613）。
 */
function startRequest(ctx, s) {
  const url = typeof ctx?.url === "string" ? ctx.url : "";
  let next = url;
  for (const prefix of PLAN_PREFIXES) {
    if (!url.startsWith(prefix)) continue;
    next = START_BASE + url.slice(prefix.length);
    break;
  }
  const at = next.indexOf("?");
  if (at >= 0) next = next.slice(0, at); // startURL（index.mjs:1569-1572）

  const incoming = ctx?.headers && typeof ctx.headers === "object" ? ctx.headers : {};
  const type = typeof incoming["content-type"] === "string" ? incoming["content-type"] : "";
  const headers = {
    ...startHeaders(type, s.jwt),
    // 上游这一分支是把头整套换掉：不带 x-api-key，也不带 agent 自己的 anthropic-beta
    "x-api-key": null,
    "anthropic-beta": null,
    // dress 会让 body 变长，上游这里删掉 content-length（index.mjs:1825）
    "content-length": null,
  };

  const raw =
    typeof ctx?.body === "string"
      ? ctx.body
      : ctx?.body && typeof ctx.body === "object"
        ? JSON.stringify(ctx.body)
        : "";
  const body = raw ? _internal.dress(raw, s.site, s.device, {}) : undefined;
  return body === undefined ? { url: next, headers } : { url: next, body, headers };
}

const provider = {
  id: PROVIDER_ID,
  // 列表里显示「产品名 + 版本」；headerScheme 固定不带版本，避免自定义请求头方案名随版本变化
  name: {
    default: withVersion("ZCode (GLM Coding Plan)"),
    "zh-CN": withVersion("ZCode (GLM Coding Plan)"),
  },
  description: {
    default: "Sign in to Z.ai or BigModel (Zhipu) and use the GLM Coding Plan.",
    "zh-CN": "登录 Z.ai 或 BigModel（智谱）账号，使用 GLM Coding Plan。",
  },
  // Lucide 兜底图标（点阵见 README「图标来源」）
  icon: "icon.svg",
  headerScheme: "ZCode",
  // 上游在 zcode.z.ai 打开授权页并轮询换令牌（index.mjs:941-998）
  flow: "device",
  api: {
    baseUrl: BASE,
    // 上游 npm 是 @ai-sdk/anthropic（index.mjs:1704），端点是 Anthropic Messages
    requestMethod: "anthropic",
    defaultModel: DEFAULT_MODEL,
    maxContextTokens: DEFAULT_CONTEXT,
  },

  /** 上游 authorize("zai"|"bigmodel", log) 返回 { url, instructions, method: "auto", callback() }。 */
  async authorize(ctx) {
    const server = await serverPromise;
    const method = server?.auth?.methods?.find?.((m) => m.type === "oauth");
    if (!method || typeof method.authorize !== "function") {
      throw new Error("ZCode: upstream plugin exposes no oauth method");
    }
    const started = await method.authorize();
    if (!started || typeof started.url !== "string" || !started.url) {
      throw new Error("ZCode: upstream authorize() returned no url");
    }

    pending = { done: false, result: null, error: null };
    const state = pending;
    // 上游 callback() 自己按 poll_interval_sec 轮询，这里只跟踪它何时结束
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

    ctx.log("zcode sign-in started");
    return {
      url: started.url,
      instructions: started.instructions ?? "在浏览器登录 Z.ai / BigModel；本窗口会自动完成。",
      interval: POLL_INTERVAL,
      expiresIn: SIGN_IN_LIFE,
      session: {},
    };
  },

  /** 宿主按 interval 轮询；上游 callback 未结束就返回 pending。 */
  async poll() {
    if (!pending) throw new Error("ZCode: no sign-in in progress; start again");
    if (!pending.done) return { pending: true };
    const { result, error } = pending;
    pending = null;
    if (error) throw error instanceof Error ? error : new Error(String(error));
    if (!result || result.type !== "success") {
      throw new Error(result?.error ? String(result.error) : "ZCode sign-in failed");
    }
    return toSnowToken(result);
  },

  /** 上游 provider.models(provider, { auth }) 返回 { id: model } 映射（index.mjs:1713-1745）。 */
  async models(ctx) {
    const server = await serverPromise;
    const auth = toUpstreamAuth(ctx?.account ?? {});
    const listed = await server.provider.models(providerSnapshot(), { auth });
    return Object.keys(listed ?? {});
  },

  /** 上游 auth.usage(getAuth, provider) 返回 { windows, plan?, error? }（index.mjs:1871-1912）。 */
  async quota(ctx) {
    const server = await serverPromise;
    const auth = toUpstreamAuth(ctx?.account ?? {});
    const result = await server.auth.usage(async () => auth, providerSnapshot());
    if (result?.error) throw new Error(String(result.error));
    return toQuota(result);
  },

  /**
   * 出站改写，覆盖上游 loader.fetch 里的两条账号形态：
   *
   * 1) Start Plan（只有 jwt 的账号，见 startState）：整段交给 startRequest 复刻上游
   *    的伪装（index.mjs:1814-1826）。上游这条分支**不改请求体之外的东西**——
   *    请求体由 dress 重写，走的是同一个上游函数。
   * 2) 其余（自带 Coding Plan key，含团队席位）：上游「自带 key」分支（index.mjs:1827-1834）
   *    的补 x-api-key，并让 BigModel 账号的请求落到 open.bigmodel.cn 而不是档案里的
   *    api.z.ai。请求体不动：该分支上游也原样转发（只有 Claude Code 的 tool search 改名，
   *    index.mjs:1784-1788，Snow 不会发那种工具）。
   *
   * 全程纯本地计算：不发任何网络请求。
   */
  transformRequest(ctx) {
    const account = ctx?.account ?? {};
    const start = startState(account);
    if (start) return startRequest(ctx, start);

    const headers = {};
    const access = typeof account?.accessToken === "string" ? account.accessToken : "";
    if (access) headers["x-api-key"] = access;

    const state = stateOfAccount(account);
    const base = typeof state?.base === "string" && /^https:\/\//.test(state.base) ? state.base.replace(/\/+$/, "") : "";
    const url = typeof ctx?.url === "string" ? ctx.url : "";
    if (base && url) {
      for (const prefix of PLAN_PREFIXES) {
        if (!url.startsWith(prefix)) continue;
        const next = base + url.slice(prefix.length);
        if (next !== url) return { url: next, headers };
        break;
      }
    }
    return { headers };
  },

  /**
   * 响应侧改写（档 1，Snow 0.5.6+）。
   *
   * 只对 Start Plan 账号生效，而且只动一种响应：被 zcode.z.ai 拒绝的那一段
   * （index.mjs:1838-1842——status >= 400 且 startRefused 判定为「被拦」时，上游把整段正文
   * 换成 startBlocked 的错误体，状态码保持原样）。这类正文是裸 JSON 或拦截页，不是 SSE，
   * 宿主按整段交给本钩子；成功的 Anthropic 回答上游原样透传（index.mjs:1864），这里不碰。
   *
   * 状态码本身改不了（宿主只让插件改 body / headers），上游也没改它。上游另外动了两处
   * 响应侧，本钩子表达不了，见 README「限制」：
   *  - 上游把 X-Magpie-Sign-In: kept 加在每个响应上（index.mjs:1344-1350），这是 magpie 自己
   *    的标记，Snow 侧没有对应概念，不复刻；
   *  - `-Trial`（试用额度）那条线要把 200 改成 429（index.mjs:1849-1861），只能改正文与头，
   *    改不了状态码。
   *
   * 旧版宿主（0.5.5 及以前）忽略本钩子：被拒时显示厂商原文（405 拦截页 / code 3012），
   * 对话本身不受影响（请求侧的伪装是 transformRequest，旧版也有）。
   */
  transformResponse(ctx) {
    if (!startState(ctx?.account)) return undefined;
    const status = Number(ctx?.status) || 0;
    if (status < 400) return undefined;

    const body = ctx?.body;
    const text = typeof body === "string" ? body : body && typeof body === "object" ? JSON.stringify(body) : "";
    if (!text || !startRefused(status, text)) return undefined;

    return {
      body: { type: "error", error: { type: "permission_error", message: blockedMessage(status, text) } },
      // 上游 startBlocked 把正文换成 JSON，kept() 删掉了 content-encoding；宿主不再给 statusText
      headers: { "content-type": "application/json", "content-encoding": null, "content-length": null },
    };
  },
};

export default { providers: [provider] };
