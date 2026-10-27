// OpenCode provider plugin for a Loomy (iFlytek) account: the account signs
// in with Loomy's phone-code sign-in (a short text-message code, good for
// fourteen days with no way to renew), its chats are OpenAI-compatible ones
// at Loomy's model gateway, sent with the session token, and the account's
// points (the permanent balance and the daily grant) and the daily
// first-login refresh land on the Usage card. The phone-code sign-in — with
// the HMAC-SHA1 signature every request to Loomy's account host carries — is
// in; the gateway forwarding and its error translation are in; the live
// model list, with the web plane's fallback table behind it, is in; the
// points card (the permanent balance and the daily grant) and the daily
// first-login refresh are in.

// Loomy has three planes: the CAccount host (signing in, every request
// HMAC-signed), the integration gateway (points and the daily first-login,
// the session token in a plain header) and the model gateway
// ({integration}/api/v1, OpenAI-compatible, the token sent twice: as
// "token:" and as "Authorization: Bearer"). Their hosts and the signing
// keys are read when asked, not when this module loads, so tests can point
// them at fakes of their own by setting the environment.

import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto"

const ID = "loomy"
const NPM = "@ai-sdk/openai-compatible" // the OpenAI Chat shape Loomy's gateway speaks
const SUCCESS = "000000" // the business code every Loomy plane answers success with
const AUTH_CODES = new Set(["020002", "100002"]) // the sign-in is no longer valid
const SESSION_MS = 14 * 86400_000 // a phone-code session's life; Loomy offers no refresh

// the CAccount host, where the phone-code sign-in goes
const xfyunBase = () => (process.env.LOOMY_XFYUN_BASE_URL || "https://account.xfinfr.com").replace(/\/+$/, "")
// the integration gateway, where the points and the daily first-login live
const integrationBase = () => (process.env.LOOMY_POINTS_BASE_URL || "https://loomyad.xunfei.cn").replace(/\/+$/, "")
// the model gateway: OpenAI-compatible /models and /chat/completions
const apiBase = () => integrationBase() + "/api/v1"
// the signing pair Loomy's own installer ships (a public client fingerprint,
// not a user credential); the environment can override either half
const keyId = () => process.env.LOOMY_XFYUN_ACCESS_KEY_ID || "2thryby66wxi53sk"
const keySecret = () => process.env.LOOMY_XFYUN_ACCESS_KEY_SECRET || "zsak6eadrbawz683wf5r3m2snrwj868r"

// ---- the model catalog ------------------------------------------------------------
// The model gateway has a live /api/v1/models answer; the table below is the
// web plane's own ten, a first install's guide until that answer can be had
// (and the fallback whenever it can't) — the live list is the source of
// truth and wins the moment it answers. Three of the ten carry the point
// rate the model gateway prints (there it rides the display name's suffix),
// kept in the record's rate field and out of the name; spark-x is the one
// the client's own catalog flags as a thinking model. The entries without a
// display name show their id. They carry no capability bits of their own
// (spark-x's reasoning aside) — the two shapes below read a missing toolcall
// bit as the OpenAI-compatible default, tools on, the way the gateway's own
// catalog does for a row that ships no capabilities and the way minimax and
// autoclaw spell their static tables.

const FALLBACK_MODELS = [
  { id: "deepseek-v4-flash-0731", name: "DeepSeek V4 Flash 0731", rate: "x3.0" },
  { id: "MiniMax-M3" },
  { id: "Kimi-k2.6" },
  { id: "qwen-3.8-max" },
  { id: "qwen3.8-flash" },
  { id: "GLM-5.3-Flash", name: "GLM 5.3 Flash", rate: "x0.8" },
  { id: "spark-x", name: "Spark X2.5", rate: "x0.1", reasoning: true },
  { id: "doubao-seed-2.0-mini" },
  { id: "mimo-v2.5" },
  { id: "qwen3.5-flash" },
]

// Every model carries the same three reasoning efforts: an empty variants
// object does nothing, and the upstream ignores the field on the models
// that don't think — a known behavior, the reason even the plain models
// hang the levels here, each spelled out the way the client sends it.
const VARIANTS = Object.fromEntries(["low", "medium", "high"].map((effort) => [effort, { reasoningEffort: effort }]))

// The model gateway prints its point rate as a suffix on the display name —
// "DeepSeek V4 Flash 0731 (x3.0)", "GLM 5.3 Flash(x0.8)", "Spark X2.5
// (x0.1)" — and ships no structured rate field. splitRateSuffix takes it
// off, the same split the client's display-name reader and the gateway's
// own catalog make: only a trailing bracket counts, ASCII () and full-width
// （） both and only matched with their own kind; the content must be an
// x/X-prefixed, non-empty run of digits and dots with a digit among them —
// any other trailing label ("限时免费" and the like) is no rate, and stays
// in the name rather than being silently dropped. A name that is nothing
// but the bracket keeps itself whole: no empty display names.
function splitRateSuffix(name) {
  const raw = String(name ?? "")
  const trimmed = raw.replace(/\s+$/, "")
  const close = trimmed.endsWith(")") ? ")" : trimmed.endsWith("）") ? "）" : ""
  if (!close) return { name: raw, rate: undefined }
  const open = close === ")" ? "(" : "（"
  const body = trimmed.slice(0, -close.length)
  const at = body.lastIndexOf(open)
  if (at === -1) return { name: raw, rate: undefined }
  const inner = body.slice(at + open.length).trim()
  const number = inner[0] === "x" || inner[0] === "X" ? inner.slice(1).trim() : ""
  if (!number || !/[0-9]/.test(number) || !/^[0-9.]+$/.test(number)) return { name: raw, rate: undefined }
  const cleaned = body.slice(0, at).replace(/\s+$/, "")
  return { name: cleaned || raw, rate: "x" + number }
}

// a JSON value as a plain object — the only shape capabilities can be
const plainObject = (v) => (v !== null && typeof v === "object" && !Array.isArray(v) ? v : undefined)

// a limit's value: a positive number, or a numeric string read as one (the
// tolerant read costs nothing and catches a gateway that quotes its numbers)
const posInt = (v) => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() && Number.isFinite(Number(v)) ? Number(v) : NaN
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : undefined
}

// the thinking models by their own name — the client hangs its reasoning
// bit on spark-x alone, and the catalog keeps that name check beside the
// capabilities bit
const isReasoningModel = (id) => id.toLowerCase().includes("spark-x")

// parseModels reads the model gateway's /api/v1/models answer — the OpenAI
// {data:[…]} envelope, or the bare array the gateway has also been seen in —
// as the short model records both shapes below are built from. Rows without
// an id are dropped; a missing name falls back to the id, and the rate
// suffix comes off whatever name there is. The capability bits follow the
// gateway's own catalog mapping: tool call is the OpenAI-compatible default
// when the capabilities object is missing entire, and only what a present
// object says — a present object without function_calling says no; reasoning
// is the capabilities' own bit or a spark-x name; vision is the
// capabilities' own bit or "image" among the input modalities, either's
// case. The context and output limits pass through from the first key the
// row carries of each set — the client's own normalizer reads the same two
// sets. (This is the models interface alone; the points plane's two-layer
// data has no business here.)
function parseModels(payload) {
  const rows = Array.isArray(payload?.data) ? payload.data : Array.isArray(payload) ? payload : []
  const pick = (row, keys) => {
    for (const key of keys) {
      const value = posInt(row?.[key])
      if (value !== undefined) return value
    }
    return undefined
  }
  const out = []
  for (const row of rows) {
    const id = typeof row?.id === "string" ? row.id.trim() : ""
    if (!id) continue
    const displayName = typeof row.name === "string" && row.name.trim() ? row.name.trim() : id
    const { name, rate } = splitRateSuffix(displayName)
    const caps = plainObject(row.capabilities)
    const hasModal = (want) =>
      (Array.isArray(caps?.input_modalities) ? caps.input_modalities : []).some(
        (item) => typeof item === "string" && item.toLowerCase() === want
      )
    out.push({
      id,
      name,
      rate,
      toolcall: caps === undefined || caps.function_calling === true,
      reasoning: caps?.reasoning === true || isReasoningModel(id),
      vision: caps?.vision === true || hasModal("image"),
      context: pick(row, ["context_length", "context_window", "input_token_limit", "max_input_tokens", "maxInputTokens"]),
      output: pick(row, ["max_output_tokens", "max_completion_tokens", "max_tokens", "maxOutputTokens"]),
    })
  }
  return out
}

// configModelOf is one model as the config hook's table spells it
// (models.dev's shape, minimax's configModels): tool_call with the
// underscore there. The rate stays in the record, out of the name. A
// toolcall bit that isn't there (the fallback table's) is the compatible
// default — only an explicit false says no.
function configModelOf(m) {
  return {
    id: m.id,
    name: m.name || m.id,
    reasoning: m.reasoning === true,
    tool_call: m.toolcall !== false,
    attachment: m.vision === true,
    modalities: { input: m.vision === true ? ["text", "image"] : ["text"], output: ["text"] },
    limit: { context: m.context ?? 0, output: m.output ?? 0 },
    cost: { input: 0, output: 0 },
    variants: VARIANTS,
  }
}

// providerModelOf is one model as the provider's models hook spells it
// (OpenCode's ModelInfo, minimax's modelOf): the provider's own id on
// every record, capabilities' toolcall without the underscore, and the
// cost's cache keys nested under cache.
function providerModelOf(m, providerID = ID) {
  return {
    id: m.id,
    providerID,
    name: m.name || m.id,
    api: { id: m.id, url: apiBase() + "/chat/completions", npm: NPM },
    limit: { context: m.context ?? 0, output: m.output ?? 0 },
    capabilities: { toolcall: m.toolcall !== false, reasoning: m.reasoning === true, attachment: m.vision === true },
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    variants: VARIANTS,
  }
}

// ---- the CAccount signature -------------------------------------------------------
// Every request to the account host is HMAC-SHA1 signed, the way the client's
// electron/xfyun/sign.js signs one: nine lines (the method, the escaped path,
// an always-empty query line, the body's MD5, the content type, the date, the
// nonce, and two always-empty header lines) HMAC'd with the installer's own
// key pair and sent as "account {id}:{base64}" — a client fingerprint
// replicated, not a user credential.

const CONTENT_TYPE = "application/json" // the string-to-sign's fifth line, and the requests' own content type

// RFC3986 for one path segment: encodeURIComponent, then the five characters
// it lets through that RFC3986 does not (!'()*) get their uppercase %XX on top
const escapeSegment = (segment) =>
  encodeURIComponent(segment).replace(/[!'()*]/g, (ch) => "%" + ch.charCodeAt(0).toString(16).toUpperCase())

// the path as signed: a leading slash, no trailing one, every segment escaped
function escapedPath(path) {
  let clean = String(path ?? "")
  if (!clean.startsWith("/")) clean = "/" + clean
  if (clean.length > 1 && clean.endsWith("/")) clean = clean.slice(0, -1)
  return clean.split("/").map(escapeSegment).join("/")
}

// the nine lines, \n-joined; the last two being empty, the string ends two
// newlines past the nonce. Built as an array so the count cannot drift.
const stringToSign = (method, escapedPathStr, md5, date, nonce) =>
  [String(method).toUpperCase(), escapedPathStr, "", md5, CONTENT_TYPE, date, nonce, "", ""].join("\n")

// base64(md5(utf8 bytes)) over exactly the JSON that goes on the wire; an
// empty body signs as the empty string (the client's contentMD5("") — both
// account requests carry a body, so that branch never runs in the flow)
const contentMd5 = (jsonString) =>
  jsonString === "" ? "" : createHash("md5").update(jsonString, "utf8").digest("base64")

// the Authorization header's value: "account {AccessKeyId}:{base64(HMAC-SHA1)}"
const signHeader = (keyId, keySecret, stringToSign) =>
  `account ${keyId}:${createHmac("sha1", keySecret).update(stringToSign, "utf8").digest("base64")}`

// ---- the sign-in's own small vocabulary -------------------------------------------

// a mainland phone number as the client's sendSmsCode reads one: spaces and
// hyphens dropped, an optional +86 (or a bare 86 leading straight into the
// eleven digits) stripped, then exactly eleven digits starting 1[3-9]. A
// valid input answers the cleaned digits; anything else answers undefined.
function normalizePhone(value) {
  const trimmed = String(value ?? "").replace(/[\s-]/g, "")
  let digits = trimmed.startsWith("+86") ? trimmed.slice(3) : trimmed
  if (digits.startsWith("86") && digits.length === 13) digits = digits.slice(2)
  return /^1[3-9]\d{9}$/.test(digits) ? digits : undefined
}

// the send-code answer's msgid, which the sign-in has to carry back: the
// field has shipped as msgid and as msgId, on the data floor and one floor
// below it — these four paths, in this order, and no others. None of them
// holding a string means the send-code answer is treated as failed.
function extractMsgid(payload) {
  const candidates = [payload?.data?.msgid, payload?.data?.msgId, payload?.data?.data?.msgid, payload?.data?.data?.msgId]
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim()
  }
  return ""
}

// first three digits, stars, last four — the auditable trace without the
// personal data. Input shorter than seven characters stays whole.
const maskPhone = (phone) => {
  const text = String(phone ?? "")
  const chars = [...text]
  return chars.length < 7 ? text : chars.slice(0, 3).join("") + "****" + chars.slice(-4).join("")
}

// every Loomy plane answers business results inside a 200: the code as a
// string, the wording in desc (message as its fallback)
const businessCode = (payload) => (typeof payload?.code === "string" ? payload.code.trim() : "")
const upstreamMessage = (payload) => {
  const desc = typeof payload?.desc === "string" ? payload.desc.trim() : ""
  if (desc) return desc
  return typeof payload?.message === "string" ? payload.message.trim() : ""
}

// what a failed business code should tell the person signing in: the two
// sign-in codes say so in so many words, the rest pass the upstream wording
// through (or the bare code when there is no wording)
const describeLoginError = (code, upstreamMsg) => {
  if (AUTH_CODES.has(code)) return "登录态已失效，请重新登录"
  const text = String(upstreamMsg ?? "").trim()
  return text ? `登录失败：${text}` : `登录失败（上游 code=${code}）`
}

// ---- the request envelope and the signed POST -------------------------------------

// the client's _makeBase() constants: the web desk the desktop client says it
// is. devid is a fixed "web", not a device fingerprint.
const WEB_MODEL_ID = "Web"
const WEB_DEVICE_ID = "web"
const CLIENT_UA = "Loomy|Desktop|Electron|macOS"
const CLIENT_VERSION = "1.0.0"
// the envelope's appid; LOOMY_XFYUN_APP_ID can override it, the way the
// client's own config can
const appId = () => process.env.LOOMY_XFYUN_APP_ID || "GM3LOOMY"

// the envelope's traceid: sixteen random bytes as lowercase hex
const traceid = () => randomBytes(16).toString("hex")

// the envelope both account requests ride in — the field order is the
// client's, and the MD5 covers these bytes as serialized
const makeBase = () => ({
  appid: appId(),
  modelid: WEB_MODEL_ID,
  version: CLIENT_VERSION,
  devid: WEB_DEVICE_ID,
  ua: CLIENT_UA,
  traceid: traceid(),
})

// one signed POST to the CAccount host. The body is stringified once, so the
// MD5 and the wire carry the same bytes; HTTP-level failures throw here, the
// business code in the answer is the caller's to translate. Twenty seconds:
// the client's own timeout, drawn in a little.
async function caccountPost(path, body) {
  const json = JSON.stringify(body)
  const md5 = contentMd5(json)
  const date = new Date().toUTCString() // the RFC7231 form: "Tue, 07 Oct 2026 08:00:00 GMT"
  const nonce = randomUUID() // the client signs the hyphenated UUID itself
  const res = await fetch(xfyunBase() + path, {
    method: "POST",
    headers: {
      "Content-Type": CONTENT_TYPE,
      Accept: "application/json",
      Authorization: signHeader(keyId(), keySecret(), stringToSign("POST", escapedPath(path), md5, date, nonce)),
      Date: date,
      Nonce: nonce,
      "Content-MD5": md5,
    },
    body: json,
    signal: AbortSignal.timeout(20_000),
  })
  if (!res.ok) throw new Error(`Loomy 账号接口 HTTP ${res.status}`)
  return await res.json()
}

// ---- the integration gateway ------------------------------------------------------

// The plane the points, the daily first-login and the model list answer on:
// the session token in both headers its gateways read — "token:" and
// "Authorization: Bearer", the client's authMode "token" dual write — and
// not one signature: the HMAC-SHA1 belongs to the account plane alone, and
// a signed header sent here is noise the gateway never checks. HTTP-level
// refusals are translated here the way client.rs translates them (401 and
// 403 the sign-in's end, anything else the bare status); the business code
// in the answer stays the caller's to read.
async function tokenRequest(method, path, json, token) {
  const res = await fetch(integrationBase() + path, {
    method,
    headers: {
      Accept: "application/json",
      token: token,
      Authorization: "Bearer " + token,
      ...(json === undefined ? {} : { "Content-Type": CONTENT_TYPE }),
    },
    ...(json === undefined ? {} : { body: json }),
    signal: AbortSignal.timeout(20_000), // the client's own timeout, drawn in a little
  })
  if (res.status === 401 || res.status === 403) throw signInExpired()
  if (!res.ok) throw new Error(`Loomy 网关接口 HTTP ${res.status}`)
  return await res.json()
}

// a read (the points summary, the model list); the query rides in the path
const tokenGet = (path, token) => tokenRequest("GET", path, undefined, token)

// a write (the daily first-login): the body stringified once, an empty
// object when the caller passes none — first-login's own body is one
const tokenPost = (path, body, token) => tokenRequest("POST", path, JSON.stringify(body ?? {}), token)

// ---- the phone-code sign-in -------------------------------------------------------
// Two signed calls to the account host: sendMsgCode for the code's msgid,
// checkCode for the fourteen-day session. magpie collects the phone number
// first (prompts), calls authorize(inputs), then — method "code" — asks for
// the texted code and hands it to callback(code).

const phoneCodeMethod = {
  type: "oauth",
  label: "Loomy 手机验证码登录（讯飞）",
  prompts: [
    {
      type: "text",
      key: "phone",
      message: "手机号（11 位，不带 +86）",
      placeholder: "13800138000",
      validate: (v) => (normalizePhone(v) === undefined ? "请填写 11 位中国大陆手机号" : undefined),
    },
  ],
  async authorize(inputs) {
    const phone = normalizePhone(inputs?.phone)
    // an authorize failure has to throw: answering {type:"failed"} here would
    // have the host take the "auto" branch and call callback() with no code
    if (phone === undefined) throw new Error("请填写 11 位中国大陆手机号")
    const payload = await caccountPost("/login/phone/sendMsgCode", {
      base: makeBase(),
      param: { ccode: "86", phone, expire: 300 }, // the code lives five minutes
    })
    const code = businessCode(payload)
    if (code !== SUCCESS) throw new Error(describeLoginError(code, upstreamMessage(payload)))
    const msgid = extractMsgid(payload)
    if (!msgid) throw new Error("验证码已发出但上游没有返回 msgid，请稍后重试")
    return {
      url: "",
      instructions: `验证码已发送到 ${maskPhone(phone)}，请输入收到的 6 位验证码。`,
      method: "code",
      async callback(input) {
        const mcode = String(input ?? "").trim()
        if (!/^\d{6}$/.test(mcode)) return { type: "failed", error: "请填写 6 位数字验证码" }
        const res = await caccountPost("/login/phone/checkCode", {
          base: makeBase(),
          param: { ccode: "86", phone, mcode, msgid, expire: 1209600 }, // fourteen days
        })
        const status = businessCode(res)
        if (status !== SUCCESS) return { type: "failed", error: describeLoginError(status, upstreamMessage(res)) }
        const session = typeof res.data?.session === "string" ? res.data.session.trim() : ""
        if (!session) return { type: "failed", error: "登录成功但上游没有返回 session" }
        const userid = typeof res.data?.userid === "string" ? res.data.userid.trim() : ""
        return {
          type: "success",
          access: session, // the session is the model gateway's token
          refresh: "", // a phone-code session has no way to renew
          expires: Date.now() + SESSION_MS, // milliseconds; extra fields persist with the credential
          accountId: maskPhone(phone),
          uid: userid,
        }
      },
    }
  },
}

// ---- the points card and the daily refresh ----------------------------------------
// Loomy has no balance endpoint: the points summary rides on the V2 records
// call's answer — the client's own points page reads it there — and no
// check-in endpoint either: the daily grant is renewed by the first-login
// call the client makes on every login, idempotent per day on the server's
// side. Both answer on the integration gateway above, with the session
// token and no signature.

// the records call the summary rides on; pageSize 1 because the summary is
// the point and the records themselves go unread (balance.rs's own query)
const RECORDS_PATH = "/api/v2/points/records?pageNo=1&pageSize=1&direction=debit&granularity=chat"

// the daily grant's refresh, the every-login call the client makes
const FIRST_LOGIN_PATH = "/api/v1/points/first-login"

// a summary number: a number as it is, a numeric string ("5000" — a shape
// the upstream has been seen in) as the number it names, anything else as
// missing
function pickNumber(v) {
  if (typeof v === "number") return Number.isFinite(v) ? v : undefined
  if (typeof v === "string") {
    const text = v.trim()
    if (text && Number.isFinite(Number(text))) return Number(text)
  }
  return undefined
}

// the summary's floor: the V2 answer has shipped two ways, the summary
// directly in data and one floor below it in data.data — the deeper floor
// first, the shallower one behind it, the same settle balance.rs makes
const pointsFloor = (payload) => plainObject(payload?.data?.data) ?? plainObject(payload?.data) ?? {}

// usageOf is the card. The two wallets Loomy keeps — the permanent balance
// and the daily grant — add into the one balance line, and the grant takes
// the window. used is a percentage 0-100; the amounts live in display
// alone. The grant's percentage is its consumed share, read off
// dailyRemainingPoints/dailyLimitPoints when both are there (the pair the
// client shows on the team card — a display of its own, never mixed into
// the balance reads), else zero with the grant's own balance in display;
// the permanent line is a status row set aside, always zero — a permanent
// balance has no window to consume. The grant's size is whatever the
// answer says; no figure is assumed of it.
function usageOf(payload) {
  const data = pointsFloor(payload)
  const permanent = pickNumber(data.balance) ?? 0
  const daily = pickNumber(data.dailyBalance) ?? 0
  const remaining = pickNumber(data.dailyRemainingPoints)
  const limit = pickNumber(data.dailyLimitPoints)
  const both = remaining !== undefined && limit !== undefined
  return {
    balance: `${Math.round((permanent + daily) * 100) / 100} 积分`,
    windows: [
      {
        name: "每日赠送",
        used: both && limit > 0 ? Math.max(0, Math.min(100, Math.round(((limit - remaining) / limit) * 100))) : 0,
        span: 86400, // a day: the grant comes back with the calendar
        display: both ? `剩余 ${remaining} / 限额 ${limit}` : `${daily} 积分`,
      },
      { name: "永久积分", used: 0, display: `${permanent} 积分`, aside: true },
    ],
  }
}

// checkinOf reads a first-login answer as the claim. The server renews the
// grant once a day and answers a repeat the same way, so "already today" is
// not a state it can tell apart — every success is claimed. The answer
// carries no granted-this-time field, and what it does carry of the grant
// (dailyBalance, when it carries it at all) is the balance, not the gain —
// so no credit is ever promised here; the balance goes into the wording.
function checkinOf(payload) {
  const code = businessCode(payload)
  if (AUTH_CODES.has(code)) {
    return { outcome: "failed", message: describeLoginError(code, upstreamMessage(payload)), signIn: "expired" }
  }
  if (code !== SUCCESS) {
    const text = upstreamMessage(payload)
    return { outcome: "failed", message: text ? `每日积分刷新失败：${text}` : `每日积分刷新失败（上游 code=${code}）` }
  }
  const daily = pickNumber(payload?.data?.dailyBalance) ?? pickNumber(payload?.data?.data?.dailyBalance)
  return {
    outcome: "claimed",
    message: daily !== undefined ? `每日赠送积分已刷新（当前 ${daily}）` : "每日赠送积分已刷新",
  }
}

// ---- the chat forwarding and the error translation --------------------------------

// a sign-in the gateway has ended: a phone-code session has no way to renew
// (Loomy offers no refresh), so the only way on is signing in again — the
// marker is what tells magpie to ask for exactly that
function signInExpired() {
  const error = new Error("Loomy 登录态已失效，请重新登录")
  error.signIn = "expired"
  return error
}

// the words a refusal about the account's points carries, whichever plane
// said it — the full set, exhaust and limit included
const QUOTA = /insufficient|balance|credit|quota|exhaust|limit|余额|积分|额度|不足|用完|上限/i

// a refusal of these three statuses is about the quota only when its words
// say so; any other status never is, whatever its words
const quotaHit = (status, text) =>
  (Number(status) === 402 || Number(status) === 403 || Number(status) === 429) && QUOTA.test(String(text ?? ""))

// the wording an error body carries, whichever envelope it rode in: an
// OpenAI-style error.message, a bare message, Loomy's own desc, or a msg
function refusalText(text) {
  let msg = String(text ?? "").trim()
  try {
    const v = JSON.parse(String(text ?? ""))
    const found = [v?.error?.message, v?.message, v?.desc, v?.msg].find((w) => typeof w === "string" && w.trim())
    if (found) msg = found.trim()
  } catch {}
  return msg
}

// a quota refusal rewritten the way magpie routes on — 429 with
// rate_limit_error, so the routing group can take over with another
// account. No code field: magpie's reading of the rewrite needs none.
function translateQuota(status, text) {
  return new Response(
    JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: "usage limit reached: " + refusalText(text) } }),
    { status: 429, statusText: "Too Many Requests", headers: { "content-type": "application/json" } }
  )
}

// a body whose business code is one of the two the client's own
// AUTH_ERROR_CODES call a dead sign-in
const authDead = (payload) => AUTH_CODES.has(businessCode(payload))

// answer is the gateway's answer as magpie reads it: every response the
// sign-in noted as kept; a refusal about the quota a 429 another account
// can take over from; and a dead sign-in thrown as the one end it has
// (Loomy offers no refresh, so there is nothing to retry). The order the
// last two are told apart in is the point: a refusal's body is read before
// the refusal is judged, because a gateway can refuse an account whose
// points are spent with a 403 — AutoClaw's gateway has been caught
// answering exactly that — and reading it as a dead session asks for a
// sign-in that would answer the same 403 again. So the quota statuses'
// bodies are read first and a quota refusal becomes the 429; only what the
// words didn't claim falls through to the sign-in's end, a 401 always (no
// quota status includes it) and a 403 that carried one of the two
// dead-session codes or no quota words at all. A 200 — stream included —
// passes through untouched, its body never read here: only the refusal
// statuses carry finite error payloads, never streams.
async function answer(res) {
  const headers = new Headers(res.headers)
  headers.set("X-Magpie-Sign-In", "kept")
  if (res.status !== 401 && res.status !== 402 && res.status !== 403 && res.status !== 429) {
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers })
  }
  // a 401 is the sign-in's end outright: its body is not read — released,
  // not carried
  if (res.status === 401) {
    try {
      res.body?.cancel?.()
    } catch {}
    throw signInExpired()
  }
  const text = await res.text()
  headers.delete("content-length")
  headers.delete("content-encoding")
  if (quotaHit(res.status, text)) {
    const rewritten = translateQuota(res.status, text)
    rewritten.headers.set("X-Magpie-Sign-In", "kept")
    return rewritten
  }
  let payload
  try {
    payload = JSON.parse(text)
  } catch {}
  if (authDead(payload) || res.status === 403) throw signInExpired()
  return new Response(text, { status: res.status, statusText: res.statusText, headers })
}

export const LoomyAuthPlugin = async ({ client }) => ({
  // the provider entry a fresh config needs — name, npm package, api base
  // and the fallback model table keyed by id — each filled only where the
  // config doesn't say its own
  config: async (config) => {
    config.provider ??= {}
    config.provider[ID] ??= {}
    const p = config.provider[ID]
    p.name ??= "Loomy"
    p.npm ??= NPM
    p.api ??= apiBase()
    p.models ??= Object.fromEntries(FALLBACK_MODELS.map((m) => [m.id, configModelOf(m)]))
  },
  auth: {
    provider: ID,
    methods: [phoneCodeMethod], // the phone-code sign-in, the only way into a Loomy account
    loader(getAuth) {
      return {
        baseURL: apiBase(),
        apiKey: "loomy", // a placeholder the SDK asks for; the session token goes into the headers in the loader's fetch
        async fetch(input, init) {
          const auth = await getAuth()
          const access = typeof auth?.access === "string" ? auth.access.trim() : ""
          // no token and nowhere to get one (Loomy has no refresh): the
          // sign-in has to happen again
          if (!access) throw signInExpired()
          // the request arrives either as a Request or as (input, init);
          // the body comes from whichever of the two holds it
          const req = input instanceof Request ? input : null
          let body = init?.body
          if (body === undefined && req) body = await req.clone().text()
          // the session in both headers the gateway reads (the client's
          // authMode "token" dual write), and the Accept of a chat stream —
          // this plane's alone, the account and points planes take JSON
          const headers = new Headers(init?.headers ?? req?.headers)
          headers.delete("content-length")
          headers.set("token", access)
          headers.set("Authorization", "Bearer " + access)
          headers.set("Accept", "text/event-stream")
          const finalInit = {
            ...init,
            method: init?.method ?? req?.method ?? "POST",
            headers,
            ...(body !== undefined ? { body } : {}),
          }
          // a body this side of the SDK is a string or a stream; a stream
          // needs duplex "half" to ride a second fetch
          if (body !== undefined && typeof body !== "string" && finalInit.duplex === undefined) {
            finalInit.duplex = "half"
          }
          const res = await fetch(req ? req.url : input, finalInit)
          // the answer is judged on its whole self, body first: a 403 the
          // gateway words as the account's points having run out is a quota
          // refusal — the 429 answer() rewrites it into — not a dead
          // session; only the refusals the words don't claim are the
          // sign-in's end (answer throws those)
          return answer(res)
        },
      }
    },
    // the account's card: the summary off the records call, the user the
    // masked phone persisted with the credential at sign-in, and the
    // sign-in kept — its only end is the one the records call itself
    // reports
    async usage(getAuth) {
      const auth = await getAuth()
      const access = typeof auth?.access === "string" ? auth.access.trim() : ""
      if (!access) return { error: "not signed in" }
      try {
        const payload = await tokenGet(RECORDS_PATH, access)
        const code = businessCode(payload)
        if (AUTH_CODES.has(code)) throw signInExpired()
        if (code !== SUCCESS) {
          const text = upstreamMessage(payload)
          throw new Error(text ? `积分查询失败：${text}` : `积分查询失败（上游 code=${code}）`)
        }
        return { plan: "Loomy", ...usageOf(payload), user: auth.accountId || "Loomy 账号", signIn: "kept" }
      } catch (e) {
        // a dead sign-in keeps its marker (thrown here or by the gateway's
        // own 401/403); every other failure is a kept sign-in's bad answer
        return { error: e?.message ?? String(e), ...(e?.signIn ? { signIn: e.signIn } : { signIn: "kept" }) }
      }
    },
    // the daily first-login: Loomy's grant renewal as the claim magpie runs
    // once a day; its outcome lands on the same card
    async checkin(getAuth) {
      const auth = await getAuth()
      const access = typeof auth?.access === "string" ? auth.access.trim() : ""
      if (!access) return { outcome: "failed", message: "not signed in" }
      try {
        return checkinOf(await tokenPost(FIRST_LOGIN_PATH, {}, access))
      } catch (e) {
        return { outcome: "failed", message: e?.message ?? String(e), ...(e?.signIn ? { signIn: e.signIn } : {}) }
      }
    },
  },
  provider: {
    id: ID,
    // the live list off the model gateway, asked with the session token:
    // it wins when it answers with anything usable, and the fallback table
    // answers when there is no session to ask with, when the answer parses
    // to nothing, or when the ask fails any other way. The one failure
    // passed on is the sign-in's end — magpie should ask for the sign-in
    // again, not be shown a stale table as if it were live.
    async models(p, { auth }) {
      const access = typeof auth?.access === "string" ? auth.access.trim() : ""
      if (!access) return p.models
      try {
        const models = parseModels(await tokenGet("/api/v1/models", access))
        if (!models.length) return p.models
        return Object.fromEntries(models.map((m) => [m.id, providerModelOf(m, p.id)]))
      } catch (e) {
        if (e?.signIn === "expired") throw e
        return p.models
      }
    },
  },
})

// for tests
export const _internal = {
  FALLBACK_MODELS,
  escapedPath,
  stringToSign,
  contentMd5,
  signHeader,
  normalizePhone,
  extractMsgid,
  maskPhone,
  businessCode,
  upstreamMessage,
  describeLoginError,
  traceid,
  makeBase,
  caccountPost,
  tokenGet,
  tokenPost,
  signInExpired,
  quotaHit,
  refusalText,
  translateQuota,
  authDead,
  answer,
  pickNumber,
  usageOf,
  checkinOf,
  splitRateSuffix,
  parseModels,
  configModelOf,
  providerModelOf,
}
