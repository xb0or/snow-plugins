/**
 * Loomy（讯飞 Loomy）—— Snow App OAuth 插件适配层
 * ---------------------------------------------------------------------------
 * 本插件是上游 OpenCode provider 插件的 Snow App 适配层，上游实现原样保留在 `index.mjs`
 * （逐字节复制，未改一行）。
 *
 * 本文件只做契约翻译：
 *   上游 auth.methods[oauth].authorize/callback -> Snow authorize()/poll()
 *   上游 provider.models                        -> Snow models()
 *   上游 auth.usage                             -> Snow quota()
 *   上游 loader.fetch 里"出站"的那一半改写        -> Snow transformRequest()
 *
 * 登录输入怎么采集：上游用 prompts 声明一个手机号输入框（index.mjs:382-390），
 * authorize(inputs) 需要 inputs.phone（index.mjs:391-404），验证码经 callback(code)
 * 交回（index.mjs:408-428）。Snow 的 OAuth 契约没有 prompts 钩子，所以适配层自建一个
 * 最小本地表单页（node:http，跑在 Electron 主进程）承载这两步输入，再映射成
 * flow: "device" + poll()。全过程不引入任何前端依赖。
 *
 * 不导出 refresh：上游 SESSION_MS 是 14 天且没有续期协议（index.mjs:27、423），
 * 不造假实现。
 */
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LoomyAuthPlugin } from "./index.mjs";

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

/** 列表里显示的名字：产品名 + 版本，如 "Loomy (iFlytek) v0.1.0"。 */
const withVersion = (name) => (PLUGIN_VERSION ? `${name} v${PLUGIN_VERSION}` : name);

/** 产品名，不带版本：headerScheme 用它，避免自定义请求头方案名跟着版本变。 */
const PRODUCT = "Loomy (iFlytek)";

/** 上游 provider id（index.mjs:23）。 */
const PROVIDER_ID = "loomy";

/**
 * 上游对话基址：集成网关 + "/api/v1"（index.mjs:32-34），向上游的 providerModelOf 也写它
 * （index.mjs:190），宿主会在其后接 /chat/completions。
 */
const API_BASE = "https://loomyad.xunfei.cn/api/v1";

/** 默认模型：上游内置表的第一项（index.mjs:55）。 */
const DEFAULT_MODEL = "deepseek-v4-flash-0731";

/** 宿主轮询间隔与登录有效期（秒）。 */
const POLL_INTERVAL = 2;
const SIGN_IN_LIFE = 600;

/** 上游只用 client.auth.set 落库（Snow 由宿主按钩子返回值落库），给一个不落库的桩。 */
const noopClient = { auth: { get: async () => ({}), set: async () => ({}) } };

/** 上游插件实例（只建一次）。 */
const upstreamPromise = Promise.resolve(LoomyAuthPlugin({ client: noopClient }));

/** 单次登录的进行中状态：Snow 的 authorize 与 poll 是两次独立调用。 */
let pending = null;

const upstreamAuth = async () => {
  const server = await upstreamPromise;
  return server?.auth ?? null;
};

const oauthMethod = async () => {
  const auth = await upstreamAuth();
  const method = auth?.methods?.find?.((m) => m.type === "oauth");
  if (!method || typeof method.authorize !== "function") {
    throw new Error(`${PROVIDER_ID}: 上游插件没有 oauth 登录方式`);
  }
  return method;
};

/**
 * 上游 config() 填出来的内置模型表（index.mjs:613-621）。
 * 模型列表在无令牌、拉空或拉取失败时回退到它（index.mjs:713-724）。
 */
const catalog = async () => {
  const server = await upstreamPromise;
  const config = {};
  await server.config(config);
  const models = config?.provider?.[PROVIDER_ID]?.models;
  return models && typeof models === "object" ? models : {};
};

/** 上游 callback() 的结果 -> Snow 令牌对象。 */
function toSnowToken(t) {
  const data = {};
  // 上游把 Loomy 的 userid 随凭据一起存（index.mjs:419-426）
  if (typeof t?.uid === "string" && t.uid) data.uid = t.uid;
  return {
    accessToken: typeof t?.access === "string" ? t.access : "",
    refreshToken: typeof t?.refresh === "string" ? t.refresh : "",
    // 上游 expires 是毫秒 epoch（index.mjs:424），Snow 的 expiresAt 接受毫秒
    expiresAt: Number(t?.expires) || 0,
    accountId: typeof t?.accountId === "string" ? t.accountId : "",
    email: "",
    planType: "",
    ...(Object.keys(data).length ? { data } : {}),
  };
}

/** Snow 档案 -> 上游 auth 对象（上游只读 type/access/refresh/expires/accountId）。 */
function toUpstreamAuth(account) {
  return {
    type: "oauth",
    access: typeof account?.accessToken === "string" ? account.accessToken : "",
    refresh: typeof account?.refreshToken === "string" ? account.refreshToken : "",
    expires: Number(account?.expiresAt) || 0,
    accountId: typeof account?.accountId === "string" ? account.accountId : "",
  };
}

/** 上游 usage 的百分比取 0-100（index.mjs:487 的取整口径）。 */
const percent = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : 0;
};

const HTML_ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const escapeHtml = (v) => String(v ?? "").replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch]);

/**
 * 本机登录页：一个 form 加一段内联脚本，没有任何前端依赖。
 * 服务器按 state.phase 渲染阶段（phone / code / done / expired），脚本只负责
 * 提交与就地切换两段输入。
 */
function signInPage(state) {
  const codeStage = state.phase === "code";
  const finished = state.phase === "done";
  const notice = escapeHtml(state.notice || "填写手机号后点击发送验证码。");
  const failed = escapeHtml(state.error || "");
  const phone = escapeHtml(state.phone || "");
  const form = finished
    ? '<p class="ok">登录成功，本页面可以关闭。</p>'
    : `<form id="form" autocomplete="off">
      <label for="phone">手机号（11 位，不带 +86）</label>
      <input id="phone" name="phone" type="tel" inputmode="numeric" placeholder="13800138000" value="${phone}"${
        codeStage ? " readonly" : " autofocus"
      }>
      <label for="code"${codeStage ? "" : ' class="hidden"'}>短信验证码（6 位数字）</label>
      <input id="code" name="code" type="text" inputmode="numeric" placeholder="000000"${
        codeStage ? " autofocus" : ' class="hidden"'
      }>
      <button type="submit" id="submit">${codeStage ? "登录" : "发送验证码"}</button>
    </form>`;

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Loomy 登录</title>
<style>
  body { margin: 0; padding: 32px 20px; font-family: system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif; background: #f5f5f7; color: #1f2329; }
  main { max-width: 420px; margin: 0 auto; background: #fff; border: 1px solid #e5e6eb; border-radius: 10px; padding: 24px; }
  h1 { font-size: 18px; margin: 0 0 10px; }
  p { font-size: 13px; line-height: 1.6; margin: 0 0 16px; color: #4b5563; }
  label { display: block; font-size: 13px; margin: 0 0 6px; }
  input { width: 100%; box-sizing: border-box; padding: 10px 12px; margin: 0 0 14px; font-size: 14px; border: 1px solid #d0d3d9; border-radius: 6px; background: #fff; color: inherit; }
  input:focus { outline: none; border-color: #4b5563; }
  button { width: 100%; padding: 10px 12px; font-size: 14px; border: 0; border-radius: 6px; background: #1f2329; color: #fff; cursor: pointer; }
  button:disabled { opacity: .6; cursor: default; }
  .hidden { display: none; }
  .ok { color: #1f2329; }
  .err { color: #b3261e; }
</style>
</head>
<body>
<main>
  <h1>Loomy 登录（讯飞）</h1>
  <p id="notice">${notice}</p>
  ${form}
  <p id="message" class="err" role="status">${failed}</p>
</main>
<script>
var stage = ${finished ? '"done"' : codeStage ? '"code"' : '"phone"'};
var form = document.getElementById("form");
var message = document.getElementById("message");
if (form && stage !== "done") {
  form.addEventListener("submit", function (event) {
    event.preventDefault();
    var phone = document.getElementById("phone");
    var code = document.getElementById("code");
    var button = document.getElementById("submit");
    button.disabled = true;
    message.textContent = "";
    fetch(stage === "phone" ? "/send" : "/verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(stage === "phone" ? { phone: phone.value } : { code: code.value })
    })
      .then(function (res) { return res.json(); })
      .then(function (data) {
        message.textContent = data && data.message ? data.message : "";
        if (!data || !data.ok) { button.disabled = false; return; }
        if (stage === "phone") {
          stage = "code";
          phone.readOnly = true;
          code.classList.remove("hidden");
          code.focus();
          button.textContent = "登录";
          button.disabled = false;
          return;
        }
        stage = "done";
        form.classList.add("hidden");
        message.className = "ok";
      })
      .catch(function (error) {
        message.textContent = "请求失败：" + error;
        button.disabled = false;
      });
  });
}
</script>
</body>
</html>
`;
}

/** 关掉本次登录的监听句柄与定时器（只动本次新建的）。 */
function shutdown(state) {
  try {
    if (state?.timer) clearTimeout(state.timer);
  } catch {
    /* ignore */
  }
  try {
    state?.server?.close?.();
    state?.server?.closeIdleConnections?.();
  } catch {
    /* ignore */
  }
  if (state) {
    state.timer = null;
    state.server = null;
  }
}

/** 读一个小的 JSON 请求体。 */
function readJson(req) {
  return new Promise((resolve) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 100_000) req.destroy();
    });
    req.on("end", () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        resolve({});
      }
    });
    req.on("error", () => resolve({}));
  });
}

/**
 * 第一步：把手机号交给上游发短信。
 * 上游 authorize({phone}) 内部已经做手机号校验与业务码翻译（index.mjs:392-403），
 * 失败时抛错，这里把错误原文交给页面显示，不吞异常。
 */
async function submitPhone(state, body) {
  if (state.phase !== "phone") return { ok: false, message: "手机号已提交，请填写短信验证码。" };
  let started;
  try {
    started = await state.method.authorize({ phone: body?.phone });
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
  if (!started || typeof started.callback !== "function") {
    return { ok: false, message: "上游没有返回验证码回调，请稍后重试。" };
  }
  state.callback = started.callback;
  state.phase = "code";
  state.phone = String(body?.phone ?? "").trim();
  state.notice = typeof started.instructions === "string" && started.instructions ? started.instructions : "验证码已发送。";
  return { ok: true, message: state.notice };
}

/**
 * 第二步：用验证码换会话。
 * 上游 callback(code) 自己校验六位数字、调 /login/phone/checkCode 并翻译业务码
 * （index.mjs:408-428）。失败时 phase 留在 code，允许重填验证码。
 */
async function submitCode(state, body) {
  if (state.phase !== "code" || typeof state.callback !== "function") {
    return { ok: false, message: "请先发送短信验证码。" };
  }
  let result;
  try {
    result = await state.callback(body?.code);
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
  if (!result || result.type !== "success") {
    return { ok: false, message: result?.error ? String(result.error) : "登录失败，请重试。" };
  }
  state.token = result;
  state.phase = "done";
  state.notice = "登录成功，本页面可以关闭。";
  state.error = "";
  return { ok: true, message: state.notice };
}

/** 一次请求的处理；任何异常都转成页面能显示的 JSON，不留下未处理的 rejection。 */
async function handleRequest(state, req, res) {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const json = (payload, status = 200) => {
    const text = JSON.stringify(payload);
    res.writeHead(status, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "content-length": Buffer.byteLength(text),
    });
    res.end(text);
  };

  if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
    const html = signInPage(state);
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-length": Buffer.byteLength(html),
    });
    res.end(html);
    return;
  }
  if (req.method === "POST" && url.pathname === "/send") return json(await submitPhone(state, await readJson(req)));
  if (req.method === "POST" && url.pathname === "/verify") return json(await submitCode(state, await readJson(req)));
  return json({ ok: false, message: "未知路径" }, 404);
}

const provider = {
  id: PROVIDER_ID,
  // 列表里显示「产品名 + 版本」；headerScheme 固定不带版本
  name: { default: withVersion(PRODUCT), "zh-CN": withVersion("讯飞 Loomy") },
  description: {
    default: "Sign in to Loomy (iFlytek) with its phone-code flow in a local page, then use Loomy's OpenAI-compatible model gateway.",
    "zh-CN": "在本地页面完成讯飞 Loomy 的手机验证码登录，使用其 OpenAI 兼容模型网关。",
  },
  // Loomy 官方站点 icon（https://loomy.xunfei.cn/icon.png，自带固定色，深浅主题都正常）
  icon: "icon.png",
  headerScheme: PRODUCT,
  // 声明 panel 后宿主在 OAuth 登录弹窗内渲染插件面板，不再自动打开浏览器；
  // flow 缺省即按 panel 处理，这里显式写出便于阅读（旧版宿主忽略 panel，退回 device 流程）。
  flow: "panel",
  panel: {
    entry: "panel/login.js",
    title: { default: "iFlytek Loomy sign-in", "zh-CN": "讯飞 Loomy 登录" },
  },
  api: {
    baseUrl: API_BASE,
    // 上游用 @ai-sdk/openai-compatible（index.mjs:24），即 OpenAI Chat 形态
    requestMethod: "chat",
    defaultModel: DEFAULT_MODEL,
  },

  /**
   * 上游 authorize(inputs) 要手机号（index.mjs:391-397），而 Snow 没有输入提示钩子，
   * 所以这里起一个仅监听 127.0.0.1 的本地表单页：页面 POST /send 触发上游发短信，
   * POST /verify 用验证码换会话，poll() 等页面完成。
   */
  async authorize(ctx) {
    const method = await oauthMethod();
    // 宿主重复发起时，先收掉上一次没结束的登录
    if (pending) shutdown(pending);
    pending = null;

    const state = {
      method,
      phase: "phone",
      phone: "",
      notice: "",
      error: "",
      token: null,
      callback: null,
      server: null,
      timer: null,
    };

    const httpServer = createServer((req, res) => {
      handleRequest(state, req, res).catch((error) => {
        try {
          const text = JSON.stringify({ ok: false, message: String(error?.message ?? error) });
          res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
          res.end(text);
        } catch {
          /* 响应已经发出去时忽略 */
        }
      });
    });

    const port = await new Promise((resolve, reject) => {
      httpServer.once("error", reject);
      httpServer.listen(0, "127.0.0.1", () => resolve(httpServer.address().port));
    });
    state.server = httpServer;
    // 只对本次新建的监听句柄 unref：登录照常工作，但不会挂住只靠事件循环退出的调用方
    httpServer.unref?.();

    state.timer = setTimeout(() => {
      state.phase = "expired";
      state.error = "登录已超时，请回到 Snow App 重新发起登录。";
      state.notice = "";
    }, SIGN_IN_LIFE * 1000);
    state.timer.unref?.();

    pending = state;
    const url = `http://127.0.0.1:${port}/`;
    ctx?.log?.(`${PROVIDER_ID} sign-in page ready`);
    return {
      url,
      instructions: "在打开的页面里填手机号与短信验证码，页面提示登录成功后本窗口会自动完成。",
      interval: POLL_INTERVAL,
      expiresIn: SIGN_IN_LIFE,
      session: { port },
    };
  },

  /** 宿主按 interval 轮询；页面还没完成登录就返回 pending。 */
  async poll() {
    const state = pending;
    if (!state) throw new Error(`${PROVIDER_ID}: 没有进行中的登录，请重新发起`);
    if (state.token) {
      pending = null;
      shutdown(state);
      return toSnowToken(state.token);
    }
    if (state.error) {
      pending = null;
      shutdown(state);
      throw new Error(state.error);
    }
    return { pending: true };
  },

  /**
   * 上游 provider.models(p, { auth })（index.mjs:713-724）：有会话时读实时 /api/v1/models，
   * 无会话、拉空或拉取失败时回退 config() 填出的内置表；登录失效会抛出，交由宿主引导重新登录。
   */
  async models(ctx) {
    const server = await upstreamPromise;
    const auth = toUpstreamAuth(ctx?.account ?? {});
    const bundled = await catalog();
    const listed = await server.provider.models({ id: PROVIDER_ID, models: bundled }, { auth });
    return Object.keys(listed ?? {});
  },

  /**
   * 上游 auth.usage(getAuth)（index.mjs:673-691、475-494）：
   * 两个钱包（永久余额 + 每日赠送）的积分摘要挂在积分流水查询上。
   * bucket 的 key 必须是 "window"：宿主配额面板的行标题是白名单 switch，只有 "window"
   * 会原样显示 label，右侧又固定只显示「剩余 N%」，所以具体数值写进 label。
   */
  async quota(ctx) {
    const account = ctx?.account ?? {};
    if (!account.accessToken) return { groups: [] };
    const auth = await upstreamAuth();
    if (!auth || typeof auth.usage !== "function") return { groups: [] };
    const usage = await auth.usage(async () => toUpstreamAuth(account));
    if (usage?.error) throw new Error(String(usage.error));
    const windows = Array.isArray(usage?.windows) ? usage.windows : [];
    const buckets = windows.map((w) => {
      const name = typeof w?.name === "string" && w.name ? w.name : "usage";
      const display = typeof w?.display === "string" ? w.display.trim() : "";
      return {
        key: "window",
        label: [name, display].filter(Boolean).join(" "),
        usedPercent: percent(w?.used),
      };
    });
    if (!buckets.length) return { groups: [] };
    const plan = typeof usage?.plan === "string" && usage.plan ? usage.plan : PRODUCT;
    return { plan, groups: [{ id: PROVIDER_ID, label: plan, buckets }] };
  },

  /**
   * 出站改写：上游 loader.fetch 里属于出站的那一半（index.mjs:643-647）——
   * 会话 token 同时放进网关读取的两个头（token 与 Authorization: Bearer，
   * 官方客户端的双头写法），再声明聊天流用的 Accept。
   * 上游对响应做的事（配额拒绝改写 429、登录失效判定、给保住的响应加内部标记，
   * index.mjs:579-607）属于响应侧，Snow 没有响应改写钩子，这里不做（见 README）。
   * 请求体上游原样透传，这里也不动。
   */
  transformRequest(ctx) {
    const account = ctx?.account ?? {};
    const access = typeof account.accessToken === "string" ? account.accessToken.trim() : "";
    if (!access) return undefined;
    return {
      headers: {
        token: access,
        Authorization: "Bearer " + access,
        Accept: "text/event-stream",
      },
    };
  },
};

export default { providers: [provider] };
