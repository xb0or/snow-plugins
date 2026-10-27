/**
 * WorkBuddy（国内版 + 国际版）—— Snow App OAuth 插件适配层
 * ---------------------------------------------------------------------------
 * 上游实现：随本插件分发的 index.mjs（OpenCode provider 插件）
 * 上游导出两个站点插件（index.mjs:2045-2046）：
 *   - workbuddy     国内版（copilot.tencent.com，CodeBuddy 桌面端）
 *   - workbuddy-ai  国际版（www.workbuddy.ai）
 * 本文件把两者各转成一个 Snow provider，id 沿用上游站点 id，互不冲突。
 *
 * 只做契约翻译：
 *   上游 auth.methods[oauth].authorize/callback  -> Snow authorize()/poll()
 *   上游 auth.refresh                            -> Snow refresh()
 *   上游 provider.models                         -> Snow models()
 *   上游 auth.usage                              -> Snow quota()
 *   上游 loader.fetch 里出站的那一半改写          -> Snow transformRequest()
 *
 * 不复制、不改写上游业务逻辑；所有网络请求仍由上游模块发出。
 */
import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { WorkBuddyAuthPlugin, WorkBuddyAIAuthPlugin, _internal } from "./index.mjs"

/**
 * 插件版本，用于在「OAuth 登录」来源列表里区分版本。
 * 从同目录的 plugin.json 读，避免与清单里的 version 不同步。
 * （宿主以 pathToFileURL(entry) + "?v=mtime" 加载，fileURLToPath 会忽略查询串。）
 */
const PLUGIN_VERSION = (() => {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url))
    return JSON.parse(readFileSync(path.join(here, "plugin.json"), "utf8")).version || ""
  } catch {
    return ""
  }
})()

/** 列表里显示的名字：产品名 + 版本，如 "WorkBuddy AI v0.1.0"。 */
const withVersion = (name) => (PLUGIN_VERSION ? `${name} v${PLUGIN_VERSION}` : name)

/** 上游站点定义（index.mjs:62-84）。 */
const SITES = _internal.SITES

/**
 * 站点在来源列表里的显示名。上游的 site.name 只叫 "WorkBuddy" / "WorkBuddy AI"，
 * 两个条目放在一起看不出哪个是国内版，这里显式区分。
 */
const SITE_LABELS = {
  workbuddy: { en: "WorkBuddy (China)", zh: "WorkBuddy 国内版" },
  "workbuddy-ai": { en: "WorkBuddy (Global)", zh: "WorkBuddy 国际版" },
}

/** 上游客户端版本号（index.mjs:17），出站头与 /v3/config 都用它。 */
const UA_VERSION = "5.5.6"

/** 上游 auth.refreshLead 为 5 分钟（index.mjs:21 LEAD_MS）。 */
const REFRESH_LEAD = 300

/** 宿主轮询间隔（秒）与登录有效期（秒）。 */
const POLL_INTERVAL = 2
const SIGN_IN_LIFE = 600

/**
 * 上游只用 client.auth.set 落库（index.mjs:227）。Snow 里持久化由宿主按
 * refresh() 的返回值完成，这里给一个不落库的桩。
 */
const noopClient = { auth: { get: async () => ({}), set: async () => ({}) } }

/** 上游 auth 对象 -> Snow 令牌对象。 */
function toSnowToken(t) {
  const data = {}
  for (const k of ["uid", "domain", "enterpriseId", "tokenType"]) {
    if (typeof t?.[k] === "string" && t[k]) data[k] = t[k]
  }
  if (Number(t?.refreshExpiresAt) > 0) data.refreshExpiresAt = Number(t.refreshExpiresAt)
  return {
    accessToken: typeof t?.access === "string" ? t.access : "",
    refreshToken: typeof t?.refresh === "string" ? t.refresh : "",
    // 上游 expires 是毫秒 epoch（index.mjs:158-159）；Snow 的 expiresAt 接受毫秒
    expiresAt: Number(t?.expires) || 0,
    accountId: typeof t?.accountId === "string" ? t.accountId : "",
    email: "",
    planType: "",
    ...(Object.keys(data).length ? { data } : {}),
  }
}

/** Snow 档案 -> 上游 auth 对象（上游读 type/access/refresh/expires/uid/domain/enterpriseId）。 */
function toUpstreamAuth(account) {
  const d = account?.data && typeof account.data === "object" ? account.data : {}
  return {
    type: "oauth",
    access: typeof account?.accessToken === "string" ? account.accessToken : "",
    refresh: typeof account?.refreshToken === "string" ? account.refreshToken : "",
    expires: Number(account?.expiresAt) || 0,
    accountId: typeof account?.accountId === "string" ? account.accountId : "",
    uid: typeof d.uid === "string" ? d.uid : "",
    domain: typeof d.domain === "string" ? d.domain : "",
    enterpriseId: typeof d.enterpriseId === "string" ? d.enterpriseId : "",
    refreshExpiresAt: Number(d.refreshExpiresAt) || 0,
    tokenType: typeof d.tokenType === "string" ? d.tokenType : "",
  }
}

/**
 * 上游 refresh 只回变化字段（index.mjs:240-255 只把与旧值不同的 TOKEN_FIELDS
 * 放进结果），缺的用档案里的旧值补。
 */
function mergeRefresh(account, next) {
  const d = account?.data && typeof account.data === "object" ? account.data : {}
  const snow = toSnowToken(next)
  const data = { ...d, ...(snow.data ?? {}) }
  return {
    accessToken: snow.accessToken || account?.accessToken || "",
    refreshToken: snow.refreshToken || account?.refreshToken || "",
    expiresAt: snow.expiresAt || Number(account?.expiresAt) || 0,
    accountId: snow.accountId || account?.accountId || "",
    ...(Object.keys(data).length ? { data } : {}),
  }
}

const percent = (v) => {
  const n = Number(v)
  return Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : 0
}

/**
 * 上游 auth.usage 的返回（index.mjs:1889-1942）：
 *   { plan?, windows: [{ name, used(百分比), display, amount?, limit?, unit?, resetsAt? }], error?, signIn }
 * 映射成 Snow 的 quota 形状（groups / buckets）。
 */
function toSnowQuota(siteId, result) {
  const res = result ?? {}
  const windows = Array.isArray(res.windows) ? res.windows : []
  const buckets = []
  for (const w of windows) {
    const name = String(w?.name ?? "usage")
    // key 必须是 "window"：宿主配额面板的 bucketLabel() 是白名单 switch，
    // 只有 case "window" 会原样显示 bucket.label，其余键一律显示「其他」。
    // 具体数值（如 "Credits 0.44 / 350"）就靠 label 带出来。
    const label = [name, typeof w?.display === "string" ? w.display : ""].filter(Boolean).join(" ")
    buckets.push({
      key: "window",
      label: label || name,
      usedPercent: percent(w?.used),
      ...(typeof w?.resetsAt === "string" && w.resetsAt ? { resetAt: w.resetsAt } : {}),
    })
  }
  const plan = typeof res.plan === "string" && res.plan ? res.plan : ""
  return {
    ...(plan ? { plan } : {}),
    groups: [{ id: siteId, label: plan || SITES[siteId].name, buckets }],
  }
}

/**
 * 上游 sign() 写进请求的头（index.mjs:269-284），逐项照抄。
 * sign() 未导出，所以这里复刻同样的常量与顺序；enterpriseHeaders 用上游导出。
 */
function signHeaders(site, a) {
  const h = {
    Authorization: "Bearer " + a.access,
    "X-User-Id": a.uid,
    "X-Domain": a.domain || new URL(site.endpoint + "/v2").host,
    "X-Product": "SaaS",
    "X-IDE-Type": "WorkBuddy",
    "User-Agent": "WorkBuddy/" + UA_VERSION,
    "X-Requested-With": "XMLHttpRequest",
    "X-Agent-Intent": "craft",
    "X-Agent-Purpose": "conversation",
    "X-IDE-Name": "WorkBuddy",
    "X-IDE-Version": UA_VERSION,
    ..._internal.enterpriseHeaders(a),
  }
  // index.mjs:282-283：国际版额外带 X-Agent-Type
  if (site.ai) h["X-Agent-Type"] = "main"
  return h
}

/**
 * 单次登录的站点状态。两个站点并行发起，谁先完成用谁。
 * 每个条目：{ id, site, started, begun, done, result, error }
 */
let pending = null

/** 两个站点的上游插件实例（懒加载后缓存，同一个实例跨调用复用）。 */
const plugins = {
  workbuddy: WorkBuddyAuthPlugin({ client: noopClient }),
  "workbuddy-ai": WorkBuddyAIAuthPlugin({ client: noopClient }),
}

/** 发起顺序：国内版优先（面板默认高亮它）。 */
const SITE_ORDER = ["workbuddy", "workbuddy-ai"]

/** 档案里记录的站点 id；没有或非法时回退默认站点。 */
function siteIdOf(account) {
  const d = account?.data && typeof account.data === "object" ? account.data : {}
  const id = typeof d.site === "string" ? d.site : ""
  return SITES[id] ? id : SITE_ORDER[0]
}

/** 上游 config() 填出来的模型目录（index.mjs:1751-1759），作为模型列表兜底。 */
async function catalogOf(siteId) {
  const server = await plugins[siteId]
  const cfg = {}
  await server.config(cfg)
  const models = cfg?.provider?.[siteId]?.models
  return models && typeof models === "object" ? models : {}
}

/** 为一个站点发起一次 device 授权，返回 { id, site, started }。 */
async function startSite(siteId) {
  const site = SITES[siteId]
  const server = await plugins[siteId]
  const method = server?.auth?.methods?.find?.((m) => m.type === "oauth")
  if (!method || typeof method.authorize !== "function") {
    throw new Error(`${site.name}: upstream plugin exposes no oauth method`)
  }
  const started = await method.authorize()
  if (!started || typeof started.url !== "string" || !/^https?:\/\//i.test(started.url)) {
    throw new Error(`${site.name}: upstream authorize() returned no http(s) url`)
  }
  return { id: siteId, site, started }
}

/**
 * 单一 provider：两个站点（国内版 copilot.tencent.com / 国际版 www.workbuddy.ai）。
 *
 * 上游的授权是「向站点取 state + authUrl，再轮询 /v2/plugin/auth/token?state=」，
 * 不占本地端口、state 由站点各自生成，所以两个站点可以**并行**发起：
 *   - authorize() 两站各起一次，把两个授权地址一起写进 session，面板让用户选；
 *   - poll() 两条各自轮询，谁先成功用谁，并把命中的站点写进 data.site；
 *   - 之后 refresh / models / quota / transformRequest 都按 data.site 选站点，
 *     档案的 api.baseUrl 保持默认（国内），出站 URL 由 transformRequest 改写到实际站点。
 */
const provider = {
  id: "workbuddy",
  // 列表里显示「产品名 + 版本」；headerScheme 固定不带版本，避免自定义请求头方案名随版本变化
  name: { default: withVersion("WorkBuddy"), "zh-CN": withVersion("WorkBuddy") },
  description: {
    default: "Sign in to WorkBuddy (China) or WorkBuddy (Global) in the browser; pick the site in the panel.",
    "zh-CN": "在浏览器登录 WorkBuddy 国内版或国际版，面板里选站点。",
  },
  // 默认国内版 logo（站点官方 favicon）；国际账号建好档案后不影响使用
  icon: "icon-workbuddy-cn.svg",
  headerScheme: "WorkBuddy",
  flow: "panel",
  panel: {
    entry: "panel/login.js",
    title: { default: "WorkBuddy sign-in", "zh-CN": "WorkBuddy 登录" },
  },
  api: {
    // 上游对话端点：<endpoint>/v2（index.mjs:104、1757），OpenAI 兼容 SDK（index.mjs:101）
    // 这里放默认站点，国际账号由 transformRequest 改写 origin
    baseUrl: SITES.workbuddy.endpoint + "/v2",
    requestMethod: "chat",
    defaultModel: SITES.workbuddy.models[0][0],
  },
  refreshLeadSeconds: REFRESH_LEAD,

  /**
   * 两个站点各发起一次授权，面板让用户点其中一条。
   * 上游 callback() 不接受参数、自己轮询，所以映射到 device 语义 + poll()。
   */
  async authorize(ctx) {
    pending = null
    let started
    try {
      started = await Promise.all(
        SITE_ORDER.map((id) =>
          startSite(id).catch((error) => ({ id, site: SITES[id], error })),
        ),
      )
    } catch (error) {
      throw error instanceof Error ? error : new Error(String(error))
    }
    const usable = started.filter((item) => item.started)
    if (!usable.length) {
      const first = started.find((item) => item.error)
      throw first?.error instanceof Error ? first.error : new Error("WorkBuddy: 两个站点都没能发起登录")
    }
    pending = {
      sites: usable.map(({ id, site, started: s }) => ({
        id,
        site,
        started: s,
        begun: false,
        done: false,
        result: null,
        error: null,
      })),
      skipped: started.filter((item) => item.error).map((item) => item.id),
    }
    ctx?.log?.(`workbuddy sign-in started: ${usable.map((s) => s.id).join(" + ")}`)
    return {
      // 默认给第一个可用站点（国内优先）；面板会列出全部可选地址
      url: usable[0].started.url,
      instructions: "在浏览器完成登录：面板里选国内版或国际版。",
      interval: POLL_INTERVAL,
      expiresIn: SIGN_IN_LIFE,
      session: {
        sites: usable.map(({ id, started: s }) => ({
          id,
          url: s.url,
          label: SITE_LABELS[id].zh,
          labelEn: SITE_LABELS[id].en,
        })),
      },
    }
  },

  /** 宿主按 interval 轮询；任一站点完成即返回，全部失败才报错。 */
  async poll() {
    if (!pending) throw new Error("WorkBuddy: no sign-in in progress; start again")
    // 第一次 poll 时把各站点的 callback 一起启动（不轮询的调用方不留悬挂任务）
    for (const item of pending.sites) {
      if (item.begun) continue
      item.begun = true
      const state = item
      Promise.resolve()
        .then(() => state.started.callback())
        .then(
          (value) => {
            state.result = value
            state.done = true
          },
          (error) => {
            state.error = error
            state.done = true
          },
        )
    }
    const won = pending.sites.find((item) => item.done && item.result?.type === "success")
    if (won) {
      const { id, result } = won
      pending = null
      const token = toSnowToken(result)
      // 把命中的站点记进 data：后续 refresh / models / quota / transformRequest 按它走
      token.data = { ...(token.data ?? {}), site: id }
      return token
    }
    if (pending.sites.every((item) => item.done)) {
      const reasons = pending.sites
        .map((item) => item.error ?? (item.result?.type !== "success" ? item.result?.error : null))
        .filter(Boolean)
        .map(String)
      pending = null
      throw new Error(reasons.length ? reasons[0] : "WorkBuddy sign-in failed")
    }
    return { pending: true }
  },

  /** 上游 auth.refresh(auth)（index.mjs:1791、240-255、182-204），按档案站点选实例。 */
  async refresh(ctx) {
    const account = ctx?.account ?? {}
    const siteId = siteIdOf(account)
    const server = await plugins[siteId]
    const auth = toUpstreamAuth(account)
    if (!auth.refresh) throw new Error(`${SITES[siteId].name}: no refresh token; sign in again`)
    const next = await server.auth.refresh(auth)
    if (!next) return undefined
    return mergeRefresh(account, next)
  },

  /** 上游 provider.models(provider, {auth})（index.mjs:1771-1781）：实时表，失败回退内置表。 */
  async models(ctx) {
    const account = ctx?.account ?? {}
    const siteId = siteIdOf(account)
    const server = await plugins[siteId]
    const auth = toUpstreamAuth(account)
    const bundled = await catalogOf(siteId)
    const listed = await server.provider.models({ id: siteId, models: bundled }, { auth })
    return Object.keys(listed ?? {})
  },

  /** 上游 auth.usage(getAuth)（index.mjs:1889-1942）：额度包与积分。 */
  async quota(ctx) {
    const account = ctx?.account ?? {}
    const siteId = siteIdOf(account)
    const server = await plugins[siteId]
    const auth = toUpstreamAuth(account)
    if (!auth.access) throw new Error(`${SITES[siteId].name}: not signed in`)
    const result = await server.auth.usage(() => auth)
    if (result?.error) throw new Error(String(result.error))
    return toSnowQuota(siteId, result)
  },

  /**
   * 出站改写：上游 loader.fetch 里属于出站的那一半（index.mjs:1804-1814），
   * 外加把请求 origin 换到账号实际所属站点（档案的 baseUrl 固定为默认站点）。
   * 响应侧（工具名改回、拒绝原因、401 重发）宿主没有钩子，不做（见 README）。
   */
  transformRequest(ctx) {
    const account = ctx?.account ?? {}
    const siteId = siteIdOf(account)
    const site = SITES[siteId]
    const access = typeof account.accessToken === "string" ? account.accessToken : ""
    if (!access) return undefined
    const d = account.data && typeof account.data === "object" ? account.data : {}
    const a = {
      access,
      uid: typeof d.uid === "string" ? d.uid : "",
      domain: typeof d.domain === "string" ? d.domain : "",
      enterpriseId: typeof d.enterpriseId === "string" ? d.enterpriseId : "",
    }

    // 上游先删掉宿主/客户端自带的鉴权头，再按 sign() 重写（index.mjs:1804-1808）
    const merged = new Headers()
    const incoming = ctx?.headers
    const entries =
      incoming && typeof incoming.forEach === "function" && typeof incoming.get === "function"
        ? (() => {
            const list = []
            incoming.forEach((v, k) => list.push([k, v]))
            return list
          })()
        : Object.entries(incoming ?? {})
    for (const [k, v] of entries) {
      if (typeof v === "string") merged.set(k, v)
    }
    merged.delete("authorization")
    merged.delete("x-api-key")
    merged.delete("content-length")
    for (const [k, v] of Object.entries(signHeaders(site, a))) merged.set(k, v)

    // 上游 body 三步：withSystem -> fitted -> normalizeToolChoice（index.mjs:1811-1813）
    let body = ctx?.body
    let text = body
    if (body && typeof body === "object" && !(body instanceof ArrayBuffer) && !ArrayBuffer.isView(body)) {
      text = JSON.stringify(body)
    }
    if (typeof text === "string") {
      text = _internal.withSystem(text)
      text = _internal.fitted(text).body
      text = _internal.normalizeToolChoice(text)
    }
    // 会话 id 由上游的 chat.headers 钩子给出，Snow 没有该钩子：session 传空，
    // 上游会退回用首条 user 消息生成会话 id（index.mjs:402-411）。
    _internal.attend(merged, typeof text === "string" ? text : "", "")

    // 档案的 baseUrl 是默认站点；国际账号的请求换到它自己的 origin
    let url = typeof ctx?.url === "string" ? ctx.url : ""
    const defaultOrigin = new URL(SITES.workbuddy.endpoint).origin
    const targetOrigin = new URL(site.endpoint).origin
    if (url && targetOrigin !== defaultOrigin && url.startsWith(defaultOrigin)) {
      url = targetOrigin + url.slice(defaultOrigin.length)
    }

    const headers = Object.fromEntries(merged)
    const out = {}
    if (url && url !== ctx?.url) out.url = url
    out.headers = headers
    // 宿主只接受对象形态的 body（normalizeTransform 会丢弃字符串），这里解析回对象
    if (typeof text === "string") {
      try {
        out.body = JSON.parse(text)
      } catch {
        /* 上游改写后不是 JSON：不带 body，避免宿主丢掉整段改写 */
      }
    }
    return out
  },
}

export default { providers: [provider] }
