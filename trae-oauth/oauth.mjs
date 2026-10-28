/**
 * Trae CN / Trae Global —— Snow App OAuth 插件适配层
 * ---------------------------------------------------------------------------
 * 上游实现：随本插件分发的 index.mjs
 *           （OpenCode provider 插件，TraeCNAuthPlugin / TraeGlobalAuthPlugin）
 *
 * 本文件只做契约翻译，不改写上游业务逻辑：
 *   上游 auth.methods[oauth].authorize/callback -> Snow authorize()/poll()
 *   上游 auth.refresh                           -> Snow refresh()
 *   上游 provider.models                        -> Snow models()
 *   上游 auth.usage                             -> Snow quota()
 *
 * 上游对话侧：OpenAI Chat 请求 -> Trae 私有请求 -> Trae 私有 SSE -> OpenAI 分片。
 * 出站那一半由 transformRequest() 复刻，响应那一半由 onResponseChunk()（SSE 事件）
 * 与 transformResponse()（非 SSE 的整段正文，即错误体）复刻，均为 Snow 0.5.6+ 钩子。
 *
 * 所有网络请求仍由上游模块发出（上游用全局 fetch）。
 */
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TraeCNAuthPlugin, TraeGlobalAuthPlugin, _internal } from "./index.mjs";

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

/** 上游站点表（index.mjs:22-243）。 */
const SITES = _internal.SITES;

/** 宿主轮询间隔（秒）。 */
const POLL_INTERVAL = 2;

/** 上游登录超时 10 分钟（index.mjs:284 SIGN_IN_TIMEOUT）。 */
const SIGN_IN_LIFE = 600;

/**
 * 上游只用 client.auth.set 落库续期结果（index.mjs:2761-2765 save）。
 * Snow 由宿主按钩子返回值落库，这里给一个不落库的桩。
 */
const noopClient = { auth: { get: async () => ({}), set: async () => ({}) } };

/**
 * 上游 browserSignIn（index.mjs:666-744）在 127.0.0.1 起回调服务器，
 * 并挂 10 分钟超时定时器（index.mjs:709）。
 * 这里只把本次调用**新建**的监听句柄 unref，避免离线 harness 被挂住。
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

const percent = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : 0;
};

/**
 * 配额面板的行标题。宿主的 bucketLabel() 只在 key === "window" 时原样显示 label，
 * 右侧永远只显示「剩余 N%」，所以具体数值必须写进 label。
 * Trae 上游的窗口不带 display，只有 amount/limit/unit，这里自己拼成 "12 / 100 credits"。
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

/**
 * 上游登录结果就是 toAuth(s, site) 的产物（index.mjs:388-409、697）：
 *   { type:"success", access, refresh, expires, accountId, uid, clientId,
 *     deviceId, machineId, devicePublicKey?, devicePrivateKey?, api?, region?,
 *     host?, authHost?, account? }
 * 除 Snow 的固定字段外，其余原样塞进 data（refresh/models/usage 再从 data 读回），
 * 保证设备标识与设备私钥不丢：Trae 的续期要用它签 DeviceProof。
 */
const SNOW_FIELDS = new Set(["type", "access", "refresh", "expires"]);

function toSnowToken(t) {
  const data = {};
  for (const [k, v] of Object.entries(t ?? {})) {
    if (SNOW_FIELDS.has(k)) continue;
    if (v === undefined || v === null || v === "") continue;
    data[k] = v;
  }
  return {
    accessToken: typeof t?.access === "string" ? t.access : "",
    refreshToken: typeof t?.refresh === "string" ? t.refresh : "",
    // 上游 expires 是毫秒 epoch（index.mjs:393、352-361），Snow 接受毫秒
    expiresAt: Number(t?.expires) || 0,
    accountId: typeof t?.accountId === "string" ? t.accountId : "",
    email: "",
    planType: "",
    ...(Object.keys(data).length ? { data } : {}),
  };
}

/**
 * Snow 档案 -> 上游 auth 对象。
 * 上游 fromAuth（index.mjs:411-430）只认 type/access/refresh/expires/uid/
 * accountId/clientId/deviceId/machineId/devicePublicKey/devicePrivateKey/
 * api/region/host/authHost/account，缺的由 data 原样补回。
 */
function toUpstreamAuth(account, site) {
  const d = account?.data && typeof account.data === "object" ? account.data : {};
  return {
    ...d,
    type: "oauth",
    access: typeof account?.accessToken === "string" ? account.accessToken : "",
    refresh: typeof account?.refreshToken === "string" ? account.refreshToken : "",
    expires: Number(account?.expiresAt) || 0,
    accountId: typeof account?.accountId === "string" ? account.accountId : "",
    uid: typeof d.uid === "string" ? d.uid : String(d.uid ?? ""),
    clientId: typeof d.clientId === "string" && d.clientId ? d.clientId : site.clientId,
    deviceId: typeof d.deviceId === "string" ? d.deviceId : "",
    machineId: typeof d.machineId === "string" ? d.machineId : "",
  };
}

/** 上游 refresh 只回变化字段（index.mjs:2804-2817），缺的用档案旧值补。 */
function mergeToken(account, next) {
  const prev = account?.data && typeof account.data === "object" ? account.data : {};
  const data = { ...prev };
  for (const k of ["devicePublicKey", "devicePrivateKey", "clientId"]) {
    if (typeof next?.[k] === "string" && next[k]) data[k] = next[k];
  }
  return {
    accessToken: typeof next?.access === "string" && next.access ? next.access : account?.accessToken || "",
    refreshToken: typeof next?.refresh === "string" && next.refresh ? next.refresh : account?.refreshToken || "",
    expiresAt: Number(next?.expires) || Number(account?.expiresAt) || 0,
    accountId: account?.accountId || "",
    data,
  };
}

/* ============================ 对话侧（档 1，Snow 0.5.6+） ============================
 *
 * 上游 loader.fetch（index.mjs:3200-3313）是一整套传输层替代品，两侧都要复刻：
 *   出站  URL     -> {模型主机}/api/agent/v3/llm_utils_chat（index.mjs:3272-3277）
 *         body    -> chatBody()（index.mjs:1185-1214）
 *         headers -> ideHeaders()（index.mjs:749-772）
 *   响应  Trae 的私有 SSE（sse() index.mjs:1217-1264 逐条读 `data: {…}`，是标准 SSE 分帧，
 *         所以用 onResponseChunk 逐事件改写）
 *         -> parts()（index.mjs:2326-2397）-> openai() 的流式分支（index.mjs:2460-2515）
 *
 * 判定与解析尽量复用上游导出的 _internal：chatBody、conversationID、SITES、
 * TextTools、NativeCalls、toolNamed、unwrapped（导出见 index.mjs:3326）。
 * 上游没有导出的一组小工具（ideHeaders / eventName / tokensOf / finishOf / Thoughts /
 * errorOf / failure）在下面按原样复刻，行号写在各自注释里。
 */

/** 上游对话端点路径，拼在 site.apiOf(a) 后面（index.mjs:3272）。 */
const CHAT_PATH = "/api/agent/v3/llm_utils_chat";

/** 待领取的请求状态最多留几条、最长留多久（见 takePending）。 */
const PENDING_MAX = 8;
const PENDING_TTL = 120000;

/** 一条流静默多久就当作已结束（Trae 不给 done 标记直接断线时的兜底）。 */
const STREAM_IDLE = 120000;

/**
 * 上游 ideHeaders()（index.mjs:749-772）的复刻：同一张固定头表，只含常量与账号字段。
 */
function ideHeaders(site, a, extra = {}) {
  return {
    "Content-Type": "application/json",
    Authorization: `Cloud-IDE-JWT ${a.token}`,
    "X-Cloudide-Token": a.token,
    "x-ide-token": a.token,
    "x-uid": a.uid,
    "x-app-id": site.appId,
    "x-device-id": a.deviceId,
    "x-machine-id": a.machineId,
    "x-request-id": randomUUID(),
    "x-app-version": site.clientVersion,
    "x-app-version-code": site.clientVersionCode,
    "x-ide-version": site.clientVersion,
    "x-ide-version-code": site.clientVersionCode,
    "x-ide-version-type": "stable",
    "x-device-cpu": "AMD",
    "x-device-brand": site.brand,
    "x-device-type": "windows",
    "x-os-version": "Windows 10",
    "x-system-type": "Windows",
    ...extra,
  };
}

/* ---- 上游未导出的小工具（原样复刻）---- */

/** 上游 eventName()（index.mjs:1267-1272）。 */
const eventName = (s) =>
  String(s ?? "")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .toLowerCase()
    .replace(/^_|_$/g, "");

/** 上游 ANSWER 集合（index.mjs:2293）。 */
const ANSWER = new Set(["", "output", "message", "delta", "content", "text", "answer", "chunk", "output_delta", "message_delta"]);

/** 上游 tokensOf()（index.mjs:1284-1303）：Trae 的 token 计数 -> OpenAI 的。 */
function tokensOf(u) {
  if (!u || typeof u !== "object") return null;
  const n = (...v) => Number(v.find((x) => x != null) ?? 0) || 0;
  const p = n(u.prompt_tokens, u.input_tokens, u.promptTokens, u.inputTokens);
  const c = n(u.completion_tokens, u.output_tokens, u.completionTokens, u.outputTokens);
  if (!p && !c) return null;
  const out = { prompt_tokens: p, completion_tokens: c, total_tokens: n(u.total_tokens, u.totalTokens) || p + c };
  const read = n(u.prompt_tokens_details?.cached_tokens);
  const write = n(u.prompt_tokens_details?.cache_write_tokens);
  if (read || write) out.prompt_tokens_details = { cached_tokens: read, ...(write ? { cache_write_tokens: write } : {}) };
  else {
    const r = n(u.cache_read_input_tokens, u.cacheReadInputTokens);
    const w = n(u.cache_creation_input_tokens, u.cacheCreationInputTokens);
    if (r) out.cache_read_input_tokens = r;
    if (w) out.cache_creation_input_tokens = w;
  }
  const thought = n(u.reasoning_tokens, u.completion_tokens_details?.reasoning_tokens);
  if (thought) out.completion_tokens_details = { reasoning_tokens: thought };
  return out;
}

/** 上游 finishOf()（index.mjs:2297-2302）。 */
function finishOf(d) {
  const f = String(d?.finish_reason ?? d?.stop_reason ?? d?.finishReason ?? "").toLowerCase();
  if (["length", "max_tokens", "max_output_tokens", "max_length"].includes(f)) return "length";
  if (f === "content_filter" || f === "sensitive") return "content_filter";
  return "";
}

/** 上游 Thoughts（index.mjs:2307-2321）：重复送出的思考只送新增的那一段。 */
class Thoughts {
  constructor() {
    this.all = "";
    this.last = "";
  }
  add(r) {
    const last = this.last;
    this.last = r;
    if (r === last && r.length >= 8) return "";
    if (this.all.length >= 16 && r.length >= 16 && this.all.endsWith(r)) return "";
    if (this.all.length >= 16 && r.startsWith(this.all)) r = r.slice(this.all.length);
    this.all += r;
    return r;
  }
}

/** 上游 callId()（index.mjs:1305-1306）。 */
let callSeq = 0;
const callId = () => "call_" + randomBytes(12).toString("hex") + (callSeq++).toString(36);

/** 上游 parseJSON()（index.mjs:373-381）的小号版本。 */
function asObject(v) {
  if (v && typeof v === "object") return v;
  try {
    const o = JSON.parse(String(v ?? ""));
    return o && typeof o === "object" ? o : {};
  } catch {
    return {};
  }
}

/** 上游 errorOf()（index.mjs:456-464）：Trae 的几种错误体形状。 */
function errorOf(v) {
  const o = asObject(v);
  const meta = o?.ResponseMetadata?.Error;
  if (meta && (meta.Code || meta.Message)) return { code: meta.Code ?? "", message: String(meta.Message ?? meta.Code ?? "") };
  const e = o?.error && typeof o.error === "object" ? o.error : o;
  const code = e?.code ?? e?.Code ?? o?.code ?? "";
  const message = e?.message ?? e?.msg ?? e?.Message ?? (typeof o?.error === "string" ? o.error : "") ?? "";
  return { code, message: String(message || "") };
}

/**
 * 上游 failure() 的分类（index.mjs:2422-2429，码表与词表见 index.mjs:469-474）：
 * 判定与文案照抄，只把 statusLine(status)（index.mjs:307 的 HTTP 原因短语表）换成状态码本身
 * —— 那张表上游没导出，而且只在 Trae 一个字都没说时才用到。
 */
const CN_LAPSED = [1001, "1001", 401, "401"];
const CN_QUOTA = [4008, "4008", 1005, "1005"];
const lapsedWords = /not ?log(ged)? ?in|unauthori[sz]ed|token (is )?(expired|invalid)|jwt|未登录|登录(已)?(过期|失效)/i;
const quotaWords = /quota|credit|insufficient|exceed|limit|额度|积分|次数|上限|用完/i;

function failedError(site, status, code, message) {
  const said = message || String(status);
  if (status === 401 || (site.lapsed ?? CN_LAPSED).includes(code) || (status === 403 && lapsedWords.test(said))) {
    return { status: 401, message: `${site.realm}'s sign-in has expired (${said}); sign in again` };
  }
  if (status === 429 || (site.quota ?? CN_QUOTA).includes(code) || (status === 403 && quotaWords.test(said))) {
    return { status: 429, message: `${site.realm}: ${said}` };
  }
  return { status: status >= 400 ? status : 502, message: `${site.realm}: ${said}${code ? ` (code ${code})` : ""}` };
}

/** 上游 errorResponse()（index.mjs:477-481）的错误体（去掉 magpie 自己的 X-Magpie-Sign-In）。 */
const errorBody = (status, message) => ({ error: { message, type: status === 429 ? "rate_limit_error" : "api_error", code: null } });

/* ---- 流状态 ---- */

/**
 * transformRequest 落下的待领取请求状态。宿主不给请求 id，onResponseChunk 的 ctx 里也没有，
 * 所以按先进先出认领（见 takePending）。
 */
const pendings = [];

function pushPending(req) {
  const now = Date.now();
  while (pendings.length && (now - pendings[0].at > PENDING_TTL || pendings.length >= PENDING_MAX)) pendings.shift();
  pendings.push({ at: now, model: String(req?.model ?? ""), tools: Array.isArray(req?.tools) ? req.tools : [] });
}

function takePending(ctx) {
  const now = Date.now();
  while (pendings.length && now - pendings[0].at > PENDING_TTL) pendings.shift();
  const one = pendings.shift() ?? null;
  return { model: one?.model || String(ctx?.model ?? ""), tools: one?.tools ?? [] };
}

/** 进行中的那条对话流（宿主按 SSE 顺序调用，收尾后复位）。 */
let stream = null;

/**
 * 一条流的状态：上游 parts() 的三个状态对象（index.mjs:2327-2329）与 openai()
 * 流式分支里的 calls / usage / finish（index.mjs:2472-2475）。
 */
function beginStream(site, ctx) {
  const { model, tools } = takePending(ctx);
  return {
    site,
    id: "chatcmpl-" + randomBytes(12).toString("hex"),
    created: Math.floor(Date.now() / 1000),
    model,
    tools,
    last: Date.now(),
    tt: new _internal.TextTools(tools),
    nc: new _internal.NativeCalls(),
    th: new Thoughts(),
    calls: 0,
    usage: null,
    finish: "",
    started: false,
    failed: false,
    stopped: false,
    flushed: false,
  };
}

const chunkOf = (st, delta, finish = null, extra = {}) => ({
  id: st.id,
  object: "chat.completion.chunk",
  created: st.created,
  model: st.model,
  choices: [{ index: 0, delta, finish_reason: finish }],
  ...extra,
});

/** 上游 openai() 的 error()（index.mjs:2468）：错误事件是一个带 error 字段的 data 行。 */
const errorChunk = (st, message, code = null) => ({ error: { message: `${st.site.realm}: ${message}`, type: "api_error", code } });

/** 上游 parts() 的 call()（index.mjs:2330-2333）与 openai() 的 tool_calls 分片（index.mjs:2490）。 */
function callChunk(st, c) {
  const name = _internal.toolNamed(c.name, st.tools);
  const args = _internal.unwrapped(c.arguments, name, st.tools);
  return chunkOf(st, { tool_calls: [{ index: st.calls++, id: c.id ?? callId(), type: "function", function: { name, arguments: args } }] });
}

/**
 * 上游 parts() 的循环体（index.mjs:2335-2385）按「一个事件进、若干分片出」重写：
 * 判定顺序、字段优先级、错误码与 finish 的处理逐行对齐。
 */
function feed(st, event, data) {
  const out = [];
  const name = eventName(event);
  const d = data && typeof data === "object" ? data : {};
  if (data === "[DONE]") {
    st.stopped = true;
    return out;
  }
  if (name === "error" || (name !== "output" && d.code && d.message && !d.response && !d.content)) {
    const e = errorOf(d);
    out.push(errorChunk(st, e.message || "Trae returned an error", e.code));
    st.failed = true;
    st.stopped = true;
    return out;
  }
  if (name === "token_usage") {
    const u = tokensOf(d.usage ?? d);
    if (u) st.usage = u;
    return out;
  }
  if (name === "done" || name === "response_done" || name === "stream_done") {
    const u = tokensOf(d.usage);
    if (u) st.usage = u;
    st.finish = finishOf(d) || st.finish;
    st.stopped = true;
    return out;
  }
  if (!ANSWER.has(name)) return out;

  const delta = d.delta && typeof d.delta === "object" ? d.delta : {};
  const said = [d.reasoning_content, d.reasoning, delta.reasoning_content, delta.reasoning].find((v) => typeof v === "string" && v) ?? "";
  if (said) {
    const r = st.th.add(said);
    if (r) out.push(chunkOf(st, { reasoning_content: r }));
  }
  let text =
    typeof d.response === "string"
      ? d.response
      : typeof d.content === "string"
        ? d.content
        : typeof delta.content === "string"
          ? delta.content
          : typeof d.delta === "string"
            ? d.delta
            : "";
  // 上游丢掉 IDE 自己的进度提示（index.mjs:2369）
  if (/^(Building prompt:|Completed building prompt)/.test(text)) text = "";
  if (text) {
    const r = st.tt.push(text);
    const t = r.reasoning && st.th.add(r.reasoning);
    if (t) out.push(chunkOf(st, { reasoning_content: t }));
    if (r.text) out.push(chunkOf(st, { content: r.text }));
    for (const c of r.calls) out.push(callChunk(st, { ...c, id: callId() }));
    if (r.error) {
      out.push(errorChunk(st, r.error, null));
      st.failed = true;
      st.stopped = true;
      return out;
    }
  }
  for (const tc of Array.isArray(d.tool_calls) ? d.tool_calls : []) st.nc.push(tc);
  const u = tokensOf(d.usage);
  if (u) st.usage = u;
  st.finish = finishOf(d) || st.finish;
  return out;
}

/**
 * 收尾：上游 parts() 的尾部（index.mjs:2386-2396）与 openai() 流式分支的收尾
 * （index.mjs:2494-2497，含只带 usage 的那条空 choices 分片）。
 */
function flushStream(st) {
  const out = [];
  st.flushed = true;
  if (st.failed) return out;
  const r = st.tt.push("", true);
  const t = r.reasoning && st.th.add(r.reasoning);
  if (t) out.push(chunkOf(st, { reasoning_content: t }));
  if (r.text) out.push(chunkOf(st, { content: r.text }));
  for (const c of r.calls) out.push(callChunk(st, { ...c, id: callId() }));
  if (r.error) {
    out.push(errorChunk(st, r.error, null));
    st.failed = true;
    return out;
  }
  for (const c of st.nc.take(st.tools)) out.push(callChunk(st, c));
  out.push(chunkOf(st, {}, st.calls ? "tool_calls" : st.finish || "stop"));
  if (st.usage) out.push({ id: st.id, object: "chat.completion.chunk", created: st.created, model: st.model, choices: [], usage: st.usage });
  return out;
}

/** 事件名：`event:` 行优先，缺了用 JSON 自己的 event / type（上游 sse() 的同一取法，index.mjs:1231）。 */
function eventOf(raw, data) {
  for (const line of String(raw ?? "").split("\n")) {
    const t = line.trimStart();
    if (t.startsWith("event:")) return t.slice(6).trim();
  }
  return typeof data?.event === "string" || typeof data?.type === "string" ? String(data.event ?? data.type ?? "") : "";
}

/** 一个上游站点 -> 一个 Snow provider。 */
function defineProvider(def) {
  const site = def.site;
  /** 与上游同一份 auth 对象（续期状态挂在它的闭包里）。 */
  const serverPromise = Promise.resolve(def.plugin({ client: noopClient }));

  /** 单次登录的进行中状态：Snow 的 authorize 与 poll 是两次独立调用。 */
  let pending = null;

  /** 上游 config() 填出来的静态模型表（index.mjs:3134-3144）。 */
  const catalog = async () => {
    const server = await serverPromise;
    const cfg = {};
    await server.config(cfg);
    const models = cfg?.provider?.[def.id]?.models;
    return models && typeof models === "object" ? models : {};
  };

  return {
    id: def.id,
    // 列表里显示「产品名 + 版本」；headerScheme 固定不带版本，避免自定义请求头方案名随版本变化
    name: def.name,
    description: def.description,
    // 各自站点的官方 logo（下载自 trae.cn / trae.ai 的 <link rel="icon">，见 README）
    icon: def.icon,
    headerScheme: def.headerScheme,
    flow: "device",
    // 上游在令牌到期前 10 分钟主动续期（index.mjs:286 LEAD_MS）
    refreshLeadSeconds: 600,
    api: {
      baseUrl: site.hosts.api,
      requestMethod: "chat",
      defaultModel: def.defaultModel,
    },

    /**
     * 上游 methods[0]（index.mjs:3317）是 IDE 的浏览器登录：
     * 起 127.0.0.1 回调服务器，返回 { url, instructions, method:"auto",
     * callback: () => done }。callback() 不接受参数，自己等页面跳回
     * （index.mjs:742），所以映射到 Snow 的 device 流程 + poll()。
     */
    async authorize(ctx) {
      const server = await serverPromise;
      const methods = server?.auth?.methods;
      const method = Array.isArray(methods) ? methods.find((m) => m.type === "oauth") : null;
      if (!method || typeof method.authorize !== "function") {
        throw new Error(`${def.id}：上游插件没有 oauth 登录方式`);
      }
      const known = new Set(process._getActiveHandles?.() ?? []);
      const started = await withUnrefedTimers(() => method.authorize());
      unrefNewListeners(known);
      if (!started || typeof started.url !== "string" || !/^https?:\/\//i.test(started.url)) {
        throw new Error(`${def.id}：上游 authorize() 未返回可打开的 http(s) 地址`);
      }

      pending = { started, begun: false, done: false, result: null, error: null };
      ctx?.log?.(`${def.id} sign-in started`);
      return {
        url: started.url,
        instructions:
          started.instructions ??
          `在浏览器登录 ${site.name}（${site.webHost}）并允许本次登录，本窗口会自动继续。`,
        interval: POLL_INTERVAL,
        expiresIn: SIGN_IN_LIFE,
        session: {},
      };
    },

    async poll() {
      if (!pending) throw new Error(`${def.id}：没有进行中的登录，请重新发起`);
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
      if (!result) throw error instanceof Error ? error : new Error(String(error ?? `${def.id} 登录失败`));
      if (result.type !== "success") {
        throw new Error(result.error ? String(result.error) : `${def.id} 登录失败`);
      }
      const token = toSnowToken(result);
      if (!token.accessToken) throw new Error(`${def.id}：登录结果里没有令牌`);
      return token;
    },

    /** 上游 auth.refresh(auth)（index.mjs:2804-2817 -> renew 2767-2782）。 */
    async refresh(ctx) {
      const server = await serverPromise;
      const auth = server?.auth;
      if (!auth || typeof auth.refresh !== "function") throw new Error(`${def.id}：上游没有 refresh`);
      const account = ctx?.account ?? {};
      const upstream = toUpstreamAuth(account, site);
      if (!upstream.refresh) throw new Error(`${def.id}：没有 refresh token，请重新登录`);
      const next = await auth.refresh(upstream);
      // 上游在无 refresh 或未登录时返回 undefined，这里不能当成成功
      if (!next) throw new Error(`${def.id}：续期未返回新令牌，请重新登录`);
      return mergeToken(account, next);
    },

    /**
     * 上游 provider.models(provider, { auth })（index.mjs:3159-3183）：
     * 账号自己的模型目录；读取失败或为空时回退到 config() 的静态表。
     */
    async models(ctx) {
      const server = await serverPromise;
      const fallback = await catalog();
      const fallbackIds = Object.keys(fallback);
      const upstream = toUpstreamAuth(ctx?.account ?? {}, site);
      if (!upstream.access) return fallbackIds;
      try {
        const listed = await server.provider.models({ id: def.id, models: fallback }, { auth: upstream });
        const ids = Object.keys(listed ?? {});
        return ids.length ? ids : fallbackIds;
      } catch (e) {
        if (fallbackIds.length) return fallbackIds;
        throw e;
      }
    },

    /**
     * 上游 auth.usage(getAuth)（index.mjs:2914-2932）：CN 是 credits 页，
     * Global 是美元额度页（index.mjs:122-144、213-239）。
     * 上游把失败包成 { error }，这里不再抛出，只是没有 bucket。
     */
    async quota(ctx) {
      const server = await serverPromise;
      const account = ctx?.account ?? {};
      const upstream = toUpstreamAuth(account, site);
      if (!upstream.access) return { groups: [] };
      const usage = await server.auth.usage(async () => upstream);
      if (!usage || usage.error) {
        if (usage?.error) ctx?.log?.(`${def.id} usage: ${String(usage.error)}`);
        return { groups: [] };
      }
      const windows = Array.isArray(usage.windows) ? usage.windows : [];
      // key 固定 "window"：宿主配额面板的 bucketLabel() 是白名单 switch，
      // 只有 case "window" 会原样显示 bucket.label，其余键一律显示「其他」。
      const buckets = windows.map((w, i) => ({
        key: "window",
        label: bucketLabel(w, `bucket-${i}`),
        usedPercent: percent(w?.used),
        ...(typeof w?.resetsAt === "string" && w.resetsAt ? { resetAt: w.resetsAt } : {}),
      }));
      if (!buckets.length) {
        // 上游在没有额度包时只给余额（index.mjs:132 balance = "unlimited"），
        // 落成的 bucket 同样必须是 key "window"，值写在 label 里
        const balance = typeof usage.balance === "string" ? usage.balance : "";
        if (!balance) return { groups: [] };
        const label = typeof usage.plan === "string" && usage.plan ? usage.plan : site.name;
        return {
          plan: label,
          groups: [{ id: def.id, label, buckets: [{ key: "window", label: balance, usedPercent: 0 }] }],
        };
      }
      const label = typeof usage.plan === "string" && usage.plan ? usage.plan : site.name;
      return { plan: label, groups: [{ id: def.id, label, buckets }] };
    },

    /**
     * 出站改写（档 1 的出站那一半）：把宿主发出的 OpenAI Chat 请求换成 Trae 的私有请求。
     * 复刻上游 loader.fetch 里属于出站的动作（index.mjs:3207-3208、3220、3236-3237、3272-3277）：
     *   URL     -> site.apiOf(a) + /api/agent/v3/llm_utils_chat
     *   body    -> chatBody()（复用上游导出，index.mjs:1185）
     *   headers -> ideHeaders()（index.mjs:749-772，上游未导出，本文件复刻）
     * 会话 id 复用上游的 conversationID()（index.mjs:1139，导出见 index.mjs:3326）。
     *
     * 上游靠实时模型表才能拿到的三样东西这里拿不到（钩子里不许发网络请求），按上游自己的兜底取值：
     *   fn     -> site.functions[0]（上游是按模型表里列出该模型的那个函数优先，index.mjs:3220）
     *   sees   -> site.models[model].modalities（上游在模型表没写时的同一兜底，index.mjs:3237）
     *   levels -> null（不发 reasoning_effort，Trae 用自己的默认档）
     * 见 README 的限制。
     */
    transformRequest(ctx) {
      const account = ctx?.account ?? {};
      const upstream = toUpstreamAuth(account, site);
      if (!upstream.access) return undefined;
      const req = typeof ctx?.body === "string" ? asObject(ctx.body) : ctx?.body;
      if (!req || typeof req !== "object" || Array.isArray(req) || !Array.isArray(req.messages)) return undefined;

      // 上游 fromAuth()（index.mjs:411-430）交给 ideHeaders 的字段名
      const a = { ...upstream, token: upstream.access, uid: String(upstream.uid ?? ""), name: String(upstream.accountId ?? "") };
      const model = String(req.model ?? ctx?.model ?? "");
      const session = _internal.conversationID(req, "", a.uid || a.name);
      const sees = site.models?.[model]?.modalities?.input?.includes("image") ?? true;
      pushPending(req);
      return {
        url: site.apiOf(a) + CHAT_PATH,
        body: _internal.chatBody(req, site.functions[0], "", 0, null, session, sees, null),
        headers: ideHeaders(site, a, { Accept: "text/event-stream", "X-Request-ID": randomUUID() }),
      };
    },

    /**
     * 逐事件改写（档 1，Snow 0.5.6+）。
     * Trae 的私有响应是标准 SSE（sse() index.mjs:1217-1264 逐条 `data: {…}`），所以走事件钩子：
     * parts()（index.mjs:2326-2397）把事件折成 text / reasoning / tool call / usage / finish，
     * openai() 的流式分支（index.mjs:2460-2515）再写成 chat.completion.chunk。
     * 状态机（TextTools / NativeCalls）直接复用上游 `_internal`，粘合逻辑照抄上面两段的行号顺序。
     *
     * ctx.data 可能为 null（`[DONE]`、注释行、非 JSON 事件）：判空后按 SPEC 4.5 处理 ——
     * 返回 undefined 放行。收尾分片在 done / [DONE] 处补发；旧版宿主忽略本钩子，Trae 的私有事件
     * 直接进 OpenAI 解析器（对话仍是不可用，与加钩子前一致）。
     */
    onResponseChunk(ctx, chunk) {
      const raw = typeof chunk === "string" ? chunk : "";
      const data = ctx?.data ?? null;

      if (data === null) {
        if (!raw.includes("[DONE]")) return undefined;
        const ended = stream;
        stream = null;
        if (!ended || ended.flushed) return undefined;
        // 先把收尾分片补上，再把 `[DONE]` 原样交回宿主
        return [...flushStream(ended), raw];
      }

      // 上一条流拖着不结束时（Trae 没给 done 标记就断线）按空闲时间丢弃，避免把新回答接到旧缓冲上
      if (stream && Date.now() - stream.last > STREAM_IDLE) stream = null;
      const st = stream ?? (stream = beginStream(site, ctx));
      st.last = Date.now();
      const out = [];
      if (!st.started) {
        st.started = true;
        out.push(chunkOf(st, { role: "assistant", content: "" })); // index.mjs:2480
      }
      out.push(...feed(st, eventOf(raw, data), data));
      if (st.stopped) {
        out.push(...flushStream(st));
        stream = null;
      }
      return out.length ? out : undefined;
    },

    /**
     * 非 SSE 的整段正文（档 2）：HTTP 错误，或 200 里装着的 Trae 错误体。
     * 上游在这一路读正文、判定、转成 errorResponse（index.mjs:3278-3284、3286-3291 -> failure 2422-2429
     * -> errorResponse 477-481）。正文与 content-type 照抄，状态码改不了（宿主只让插件改 body / headers），
     * 所以只能在正文里把上游的话说清楚；Trae 一个字都没说的正文（HTML 拦截页等）不猜，原样交回。
     */
    transformResponse(ctx) {
      const status = Number(ctx?.status) || 0;
      const body = ctx?.body;
      const text = (typeof body === "string" ? body : body && typeof body === "object" ? JSON.stringify(body) : "").trim();
      if (!text) return undefined;
      // OpenAI 形态的正常回答（非流式）与 SSE 文本都不动
      if (body?.choices || /^data:/m.test(text)) return undefined;

      const e = errorOf(text);
      if (!e.message && !e.code) return undefined;
      // 上游：非 2xx 用 HTTP 状态；200 里装错误体按 502（index.mjs:3289）
      const out = failedError(site, status >= 400 ? status : 502, e.code, e.message);
      return { body: errorBody(out.status, out.message), headers: { "content-type": "application/json" } };
    },
  };
}

const DEFS = [
  {
    id: "trae-cn",
    name: { default: withVersion("Trae CN"), "zh-CN": withVersion("Trae CN（国内版）") },
    icon: "icon-trae-cn.png",
    headerScheme: "Trae CN",
    description: {
      default: "Sign in to trae.cn with the IDE's browser flow (local callback on 127.0.0.1) and use its models.",
      "zh-CN": "通过 Trae CN 的 IDE 浏览器登录（127.0.0.1 本地回调）接入 trae.cn 账号。",
    },
    plugin: TraeCNAuthPlugin,
    site: SITES["trae-cn"],
    // 上游静态表第一项（index.mjs:81）
    defaultModel: Object.keys(SITES["trae-cn"].models)[0],
  },
  {
    id: "trae-global",
    name: { default: withVersion("Trae Global"), "zh-CN": withVersion("Trae 国际版") },
    icon: "icon-trae-global.png",
    headerScheme: "Trae Global",
    description: {
      default: "Sign in to trae.ai with the IDE's browser flow (local callback on 127.0.0.1) and use its models.",
      "zh-CN": "通过 Trae 国际版的 IDE 浏览器登录（127.0.0.1 本地回调）接入 trae.ai 账号。",
    },
    plugin: TraeGlobalAuthPlugin,
    site: SITES["trae-global"],
    // 上游静态表第一项（index.mjs:181）
    defaultModel: Object.keys(SITES["trae-global"].models)[0],
  },
];

export default { providers: DEFS.map(defineProvider) };
