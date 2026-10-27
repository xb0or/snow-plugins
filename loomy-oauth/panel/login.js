/**
 * 讯飞 Loomy 登录面板（Snow 0.5.6+ 自定义登录面板，ESM 单文件）
 * ------------------------------------------------------------------
 * 面板在 OAuth 登录弹窗内接管界面，宿主不再自动打开浏览器。
 *
 * 分工：
 *   - 发短信、验证码换会话由 oauth.mjs（主进程）起的本地服务完成，面板只发两个 POST：
 *       POST /send   { phone }  -> { ok, message }
 *       POST /verify { code }   -> { ok, message }
 *   - 令牌由宿主按 interval 轮询 oauth.mjs 的 poll() 取得，面板不碰令牌。
 *   - 本地服务端口由 authorize() 的 session（{ port }）经 api.oauth.session.pluginSession 传进来。
 *
 * 约束：入口以 Blob 形式被 import，因此必须是单文件、无相对 import、无裸模块名。
 */

/** 面板文案。 */
const STRINGS = {
  "zh-CN": {
    title: "讯飞 Loomy 登录",
    intro: "用手机号接收短信验证码完成登录，令牌由本窗口自动取得。",
    phone: "手机号",
    phonePlaceholder: "13800138000",
    send: "发送验证码",
    code: "短信验证码",
    codePlaceholder: "6 位数字",
    submit: "登录",
    cancel: "取消登录",
    sending: "正在发送验证码…",
    verifying: "正在校验验证码…",
    noPort: "登录会话还没准备好（本地服务未启动），请关闭弹窗后重新发起登录。",
    badPhone: "请输入 11 位手机号（不带 +86）。",
    badCode: "请输入 6 位数字验证码。",
    sent: "验证码已发送，请查收短信。",
    done: "登录成功，正在创建账号…",
    cancelled: "登录已取消。",
    failed: "登录失败",
    networkFailed: "无法连接本地登录服务，请重试。",
  },
  "zh-TW": {
    title: "訊飛 Loomy 登入",
    intro: "用手機號接收簡訊驗證碼完成登入，權杖由本視窗自動取得。",
    phone: "手機號",
    phonePlaceholder: "13800138000",
    send: "發送驗證碼",
    code: "簡訊驗證碼",
    codePlaceholder: "6 位數字",
    submit: "登入",
    cancel: "取消登入",
    sending: "正在發送驗證碼…",
    verifying: "正在校驗驗證碼…",
    noPort: "登入對話尚未就緒（本機服務未啟動），請關閉彈窗後重新發起登入。",
    badPhone: "請輸入 11 位手機號（不帶 +86）。",
    badCode: "請輸入 6 位數字驗證碼。",
    sent: "驗證碼已發送，請查收簡訊。",
    done: "登入成功，正在建立帳號…",
    cancelled: "登入已取消。",
    failed: "登入失敗",
    networkFailed: "無法連線本機登入服務，請重試。",
  },
  en: {
    title: "iFlytek Loomy sign-in",
    intro: "Sign in with your phone number and the SMS code; the token is collected automatically.",
    phone: "Phone number",
    phonePlaceholder: "13800138000",
    send: "Send code",
    code: "SMS code",
    codePlaceholder: "6 digits",
    submit: "Sign in",
    cancel: "Cancel",
    sending: "Sending the code…",
    verifying: "Verifying the code…",
    noPort: "The sign-in session is not ready (local service not started). Close the dialog and start again.",
    badPhone: "Enter an 11-digit phone number (without +86).",
    badCode: "Enter the 6-digit code.",
    sent: "The code was sent; check your messages.",
    done: "Signed in. Creating the account…",
    cancelled: "Sign-in cancelled.",
    failed: "Sign-in failed",
    networkFailed: "Cannot reach the local sign-in service. Please retry.",
  },
};

/** 从 api.oauth.session 里取标识。 */
function pickLabel(session) {
  const raw = session?.pluginSession;
  let obj = raw;
  if (typeof raw === "string") {
    try {
      obj = JSON.parse(raw);
    } catch {
      obj = null;
    }
  }
  if (!obj || typeof obj !== "object") return null;
  return obj;
}

/**
 * 读一次响应体。
 * 宿主的 api.net.fetch 可能返回 Response，也可能返回 { ok, status, body } 形态，两种都兼容。
 */
async function readJson(res) {
  if (!res) return {};
  if (typeof res.json === "function") {
    try {
      return await res.json();
    } catch {
      return {};
    }
  }
  if (typeof res.text === "function") {
    try {
      return JSON.parse(await res.text());
    } catch {
      return {};
    }
  }
  const body = res.body ?? res.data;
  if (typeof body === "string") {
    try {
      return JSON.parse(body);
    } catch {
      return {};
    }
  }
  if (body && typeof body === "object") return body;
  return {};
}

const isOk = (res, payload) => {
  if (payload && typeof payload.ok === "boolean") return payload.ok;
  if (res && typeof res.ok === "boolean") return res.ok;
  return true;
};

/**
 * 面板入口：宿主在弹窗内调用，容器由宿主提供。
 * 返回清理函数（宿主卸载面板时调用）。
 */
export function mount(container, api) {
  const oauth = api?.oauth;
  const locale = typeof api?.locale === "string" ? api.locale : "zh-CN";
  const table = STRINGS[locale] ?? STRINGS[locale.split("-")[0]] ?? STRINGS.en;
  const L = (key) => table[key] ?? STRINGS.en[key] ?? key;

  if (!oauth) {
    const note = document.createElement("p");
    note.textContent = L("noPort");
    note.style.cssText = "margin:0;color:var(--text-secondary,#6b7280);font-size:12px";
    container.replaceChildren(note);
    return () => container.replaceChildren();
  }

  const session = oauth.session ?? {};
  const meta = pickLabel(session);
  const port = meta && Number(meta.port) > 0 ? Number(meta.port) : 0;
  const base = port ? `http://127.0.0.1:${port}` : "";

  // ---- 视图 ----
  const root = document.createElement("div");
  root.style.cssText =
    "display:flex;flex-direction:column;gap:10px;font-size:13px;color:var(--text-primary,#1f2328);min-width:0";

  const title = document.createElement("p");
  title.textContent = L("title");
  title.style.cssText = "margin:0;font-weight:600;font-size:13px";

  const intro = document.createElement("p");
  intro.textContent = L("intro");
  intro.style.cssText = "margin:0;color:var(--text-secondary,#6b7280);font-size:12px;line-height:1.5";

  const field = (labelText) => {
    const wrap = document.createElement("label");
    wrap.style.cssText = "display:flex;flex-direction:column;gap:4px";
    const span = document.createElement("span");
    span.textContent = labelText;
    span.style.cssText = "color:var(--text-secondary,#6b7280);font-size:12px";
    const input = document.createElement("input");
    input.style.cssText = [
      "width:100%",
      "box-sizing:border-box",
      "padding:6px 8px",
      "border-radius:6px",
      "border:1px solid var(--border-color,#e5e7eb)",
      "background:var(--bg-primary,#fff)",
      "color:var(--text-primary,#1f2328)",
      "font-size:13px",
      "outline:none",
    ].join(";");
    input.addEventListener("focus", () => {
      input.style.borderColor = "var(--border-focus,#2563eb)";
    });
    input.addEventListener("blur", () => {
      input.style.borderColor = "var(--border-color,#e5e7eb)";
    });
    wrap.append(span, input);
    return { wrap, input };
  };

  const button = (text, primary) => {
    const el = document.createElement("button");
    el.type = "button";
    el.textContent = text;
    el.style.cssText = [
      "padding:6px 12px",
      "border-radius:6px",
      "font-size:12px",
      "cursor:pointer",
      primary
        ? "border:1px solid var(--accent-blue,#2563eb);background:var(--accent-blue,#2563eb);color:#fff"
        : "border:1px solid var(--border-color,#e5e7eb);background:var(--bg-secondary,transparent);color:var(--text-primary,#1f2328)",
    ].join(";");
    el.addEventListener("mouseenter", () => {
      el.style.opacity = "0.9";
    });
    el.addEventListener("mouseleave", () => {
      el.style.opacity = "1";
    });
    return el;
  };

  const phoneField = field(L("phone"));
  phoneField.input.type = "tel";
  phoneField.input.inputMode = "numeric";
  phoneField.input.autocomplete = "tel";
  phoneField.input.maxLength = 11;
  phoneField.input.placeholder = L("phonePlaceholder");

  const sendBtn = button(L("send"), true);

  const codeField = field(L("code"));
  codeField.input.inputMode = "numeric";
  codeField.input.autocomplete = "one-time-code";
  codeField.input.maxLength = 6;
  codeField.input.placeholder = L("codePlaceholder");
  codeField.wrap.hidden = true;

  const submitBtn = button(L("submit"), true);
  submitBtn.hidden = true;

  const status = document.createElement("p");
  status.style.cssText = "margin:0;font-size:12px;color:var(--text-secondary,#6b7280);line-height:1.5";

  const footer = document.createElement("div");
  footer.style.cssText = "display:flex;justify-content:flex-end;gap:8px";
  const cancelBtn = button(L("cancel"), false);
  footer.append(cancelBtn);

  root.append(title, intro, phoneField.wrap, sendBtn, codeField.wrap, submitBtn, status, footer);
  container.replaceChildren(root);

  // ---- 状态 ----
  let busy = false;
  let disposed = false;

  const say = (text, tone) => {
    status.textContent = text;
    status.style.color =
      tone === "error" ? "var(--color-error,#dc2626)" : "var(--text-secondary,#6b7280)";
  };
  const setBusy = (value) => {
    busy = value;
    sendBtn.disabled = value;
    submitBtn.disabled = value;
    sendBtn.style.opacity = value ? "0.6" : "1";
    submitBtn.style.opacity = value ? "0.6" : "1";
  };

  const post = async (path, payload) => {
    const res = await api.net.fetch(base + path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    const body = await readJson(res);
    return { ok: isOk(res, body), message: typeof body?.message === "string" ? body.message : "" };
  };

  const sendCode = async () => {
    if (busy) return;
    const phone = phoneField.input.value.trim();
    if (!/^1\d{10}$/.test(phone)) {
      say(L("badPhone"), "error");
      phoneField.input.focus();
      return;
    }
    setBusy(true);
    say(L("sending"));
    try {
      const result = await post("/send", { phone });
      if (!result.ok) {
        say(result.message || L("failed"), "error");
        return;
      }
      codeField.wrap.hidden = false;
      submitBtn.hidden = false;
      say(result.message || L("sent"));
      codeField.input.focus();
    } catch {
      say(L("networkFailed"), "error");
    } finally {
      setBusy(false);
    }
  };

  const submit = async () => {
    if (busy) return;
    const code = codeField.input.value.trim();
    if (!/^\d{6}$/.test(code)) {
      say(L("badCode"), "error");
      codeField.input.focus();
      return;
    }
    setBusy(true);
    say(L("verifying"));
    try {
      const result = await post("/verify", { code });
      if (!result.ok) {
        say(result.message || L("failed"), "error");
        return;
      }
      say(result.message || L("done"));
    } catch {
      say(L("networkFailed"), "error");
    } finally {
      setBusy(false);
    }
  };

  const onSendClick = () => void sendCode();
  const onSubmitClick = () => void submit();
  const onCancelClick = () => void oauth.cancel();
  const onPhoneEnter = (event) => {
    if (event.key === "Enter") void sendCode();
  };
  const onCodeEnter = (event) => {
    if (event.key === "Enter") void submit();
  };

  sendBtn.addEventListener("click", onSendClick);
  submitBtn.addEventListener("click", onSubmitClick);
  cancelBtn.addEventListener("click", onCancelClick);
  phoneField.input.addEventListener("keydown", onPhoneEnter);
  codeField.input.addEventListener("keydown", onCodeEnter);

  // 宿主轮询到的状态同步到面板（成功由弹窗自己切页，这里只显示失败与取消）
  const unsubscribe = oauth.onStatus((next) => {
    if (disposed || !next) return;
    const state = String(next.status ?? "");
    if (state === "error") say(next.error ? `${L("failed")}: ${next.error}` : L("failed"), "error");
    else if (state === "cancelled") say(L("cancelled"));
    else if (state === "success") say(L("done"));
  });

  if (!base) say(L("noPort"), "error");
  else phoneField.input.focus();

  return () => {
    disposed = true;
    try {
      unsubscribe?.();
    } catch {
      /* 取消订阅失败不影响卸载 */
    }
    sendBtn.removeEventListener("click", onSendClick);
    submitBtn.removeEventListener("click", onSubmitClick);
    cancelBtn.removeEventListener("click", onCancelClick);
    phoneField.input.removeEventListener("keydown", onPhoneEnter);
    codeField.input.removeEventListener("keydown", onCodeEnter);
    container.replaceChildren();
  };
}

export default { mount };
