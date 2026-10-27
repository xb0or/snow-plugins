/**
 * 商汤小浣熊 登录面板（Snow 0.5.6+ 自定义登录面板，ESM 单文件）
 * ------------------------------------------------------------------
 * 插件现在只导出一个 provider，面板同时给两条路，任选其一：
 *   1. 点「打开授权页」→ 系统浏览器完成授权 → 127.0.0.1 本地回调自动收尾（宿主轮询 poll()）；
 *   2. 在浏览器里把最后的 `office-raccoon://auth/callback?code=...` 链接（或 JWT）粘回来提交，
 *      走 api.oauth.submitCallback() → 适配层的 exchange()。
 * 面板不会自动打开浏览器，也不会接触令牌。
 *
 * 约束：入口以 Blob 形式被 import，必须是单文件、无相对 import、无裸模块名。
 */

const STRINGS = {
  "zh-CN": {
    title: "商汤小浣熊登录",
    intro:
      "两种方式任选：点「打开授权页」在浏览器完成授权，本窗口会自动继续；或在浏览器复制最后的 office-raccoon:// 链接，回到这里粘贴提交。",
    open: "打开授权页",
    reopen: "重新打开授权页",
    idle: "点「打开授权页」在浏览器完成授权；授权后本窗口会自动继续。",
    waiting: "正在等待浏览器完成授权…",
    or: "或者：把授权后浏览器最后跳转的链接粘贴回来",
    paste: "回调链接或访问令牌",
    pastePlaceholder: "office-raccoon://auth/callback?code=… 或 eyJ…",
    submit: "提交",
    submitting: "正在提交…",
    empty: "请先粘贴回调链接或访问令牌。",
    cancel: "取消登录",
    done: "正在创建账号…",
    cancelled: "登录已取消。",
    failed: "登录失败",
    noUrl: "本次会话没有可打开的授权地址，请关闭弹窗后重新发起登录。",
  },
  "zh-TW": {
    title: "商湯小浣熊登入",
    intro:
      "兩種方式任選：點「開啟授權頁」在瀏覽器完成授權，本視窗會自動繼續；或在瀏覽器複製最後的 office-raccoon:// 連結，回到這裡貼上提交。",
    open: "開啟授權頁",
    reopen: "重新開啟授權頁",
    idle: "點「開啟授權頁」在瀏覽器完成授權；授權後本視窗會自動繼續。",
    waiting: "正在等待瀏覽器完成授權…",
    or: "或者：把授權後瀏覽器最後跳轉的連結貼回來",
    paste: "回呼連結或存取權杖",
    pastePlaceholder: "office-raccoon://auth/callback?code=… 或 eyJ…",
    submit: "提交",
    submitting: "正在提交…",
    empty: "請先貼上回呼連結或存取權杖。",
    cancel: "取消登入",
    done: "正在建立帳號…",
    cancelled: "登入已取消。",
    failed: "登入失敗",
    noUrl: "本次對話沒有可開啟的授權位址，請關閉彈窗後重新發起登入。",
  },
  en: {
    title: "SenseTime Raccoon sign-in",
    intro:
      "Either way works: open the authorization page and approve in your browser (this window continues automatically), or copy the final office-raccoon:// link and paste it here.",
    open: "Open authorization page",
    reopen: "Open the page again",
    idle: "Open the authorization page to approve in your browser; this window continues automatically.",
    waiting: "Waiting for the browser to finish the authorization…",
    or: "Or: paste the link your browser ends on after approving",
    paste: "Callback link or access token",
    pastePlaceholder: "office-raccoon://auth/callback?code=… or eyJ…",
    submit: "Submit",
    submitting: "Submitting…",
    empty: "Paste the callback link or access token first.",
    cancel: "Cancel",
    done: "Creating the account…",
    cancelled: "Sign-in cancelled.",
    failed: "Sign-in failed",
    noUrl: "This session has no authorization URL. Close the dialog and start again.",
  },
};

const CSS = {
  root: "display:flex;flex-direction:column;gap:10px;font-size:13px;color:var(--text-primary,#1f2328);min-width:0",
  title: "margin:0;font-weight:600;font-size:13px",
  intro: "margin:0;color:var(--text-secondary,#6b7280);font-size:12px;line-height:1.5",
  primary:
    "align-self:flex-start;padding:6px 12px;border-radius:6px;font-size:12px;cursor:pointer;border:1px solid var(--accent-blue,#2563eb);background:var(--accent-blue,#2563eb);color:#fff",
  ghost:
    "align-self:flex-start;padding:6px 12px;border-radius:6px;font-size:12px;cursor:pointer;border:1px solid var(--border-color,#e5e7eb);background:var(--bg-secondary,transparent);color:var(--text-primary,#1f2328)",
  field: "display:flex;flex-direction:column;gap:4px",
  label: "color:var(--text-secondary,#6b7280);font-size:12px",
  textarea: [
    "width:100%",
    "box-sizing:border-box",
    "padding:6px 8px",
    "border-radius:6px",
    "border:1px solid var(--border-color,#e5e7eb)",
    "background:var(--bg-primary,#fff)",
    "color:var(--text-primary,#1f2328)",
    "font-size:12px",
    "font-family:var(--font-mono,monospace)",
    "resize:vertical",
    "outline:none",
  ].join(";"),
  status: "margin:0;font-size:12px;color:var(--text-secondary,#6b7280);line-height:1.5",
  divider: "margin:2px 0 0;color:var(--text-muted,#9ca3af);font-size:11px",
  footer: "display:flex;justify-content:flex-end",
};

export function mount(container, api) {
  const oauth = api?.oauth;
  const locale = typeof api?.locale === "string" ? api.locale : "zh-CN";
  const table = STRINGS[locale] ?? STRINGS[locale.split("-")[0]] ?? STRINGS.en;
  const L = (key) => table[key] ?? STRINGS.en[key] ?? key;

  if (!oauth) {
    const note = document.createElement("p");
    note.textContent = L("noUrl");
    note.style.cssText = CSS.status;
    container.replaceChildren(note);
    return () => container.replaceChildren();
  }

  const session = oauth.session ?? {};
  const authUrl = typeof session.authUrl === "string" ? session.authUrl.trim() : "";

  const root = document.createElement("div");
  root.style.cssText = CSS.root;

  const title = document.createElement("p");
  title.textContent = L("title");
  title.style.cssText = CSS.title;

  const intro = document.createElement("p");
  intro.textContent = L("intro");
  intro.style.cssText = CSS.intro;

  const openBtn = document.createElement("button");
  openBtn.type = "button";
  openBtn.textContent = L("open");
  openBtn.style.cssText = CSS.primary;

  const status = document.createElement("p");
  status.textContent = L("idle");
  status.style.cssText = CSS.status;

  const say = (text, tone) => {
    status.textContent = text;
    status.style.color =
      tone === "error" ? "var(--color-error,#dc2626)" : "var(--text-secondary,#6b7280)";
  };

  let disposed = false;
  let busy = false;
  let opened = false;

  // 只有用户点按钮才打开浏览器：panel 模式下宿主不会代劳，面板也不自作主张
  const onOpen = () => {
    if (!authUrl) {
      say(L("noUrl"), "error");
      return;
    }
    oauth.openBrowser(authUrl);
    if (!opened) {
      opened = true;
      openBtn.textContent = L("reopen");
    }
    say(L("waiting"));
  };
  openBtn.addEventListener("click", onOpen);

  // ---- 第二路：粘贴回调链接 ----
  const divider = document.createElement("p");
  divider.textContent = L("or");
  divider.style.cssText = CSS.divider;

  const label = document.createElement("span");
  label.textContent = L("paste");
  label.style.cssText = CSS.label;

  const input = document.createElement("textarea");
  input.rows = 3;
  input.placeholder = L("pastePlaceholder");
  input.style.cssText = CSS.textarea;
  input.addEventListener("focus", () => {
    input.style.borderColor = "var(--border-focus,#2563eb)";
  });
  input.addEventListener("blur", () => {
    input.style.borderColor = "var(--border-color,#e5e7eb)";
  });

  const field = document.createElement("label");
  field.style.cssText = CSS.field;
  field.append(label, input);

  const submitBtn = document.createElement("button");
  submitBtn.type = "button";
  submitBtn.textContent = L("submit");
  submitBtn.style.cssText = CSS.primary;

  const onSubmit = async () => {
    if (busy) return;
    const value = input.value.trim();
    if (!value) {
      say(L("empty"), "error");
      input.focus();
      return;
    }
    busy = true;
    submitBtn.disabled = true;
    submitBtn.style.opacity = "0.6";
    say(L("submitting"));
    try {
      const next = await oauth.submitCallback(value);
      const state = String(next?.status ?? "");
      if (state === "error") {
        say(next?.error ? `${L("failed")}: ${next.error}` : L("failed"), "error");
      } else if (state === "cancelled") {
        say(L("cancelled"));
      } else {
        say(L("done"));
      }
    } catch (error) {
      say(`${L("failed")}: ${error?.message ?? String(error)}`, "error");
    } finally {
      busy = false;
      submitBtn.disabled = false;
      submitBtn.style.opacity = "1";
    }
  };
  const onSubmitClick = () => void onSubmit();
  const onKeyDown = (event) => {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) void onSubmit();
  };
  submitBtn.addEventListener("click", onSubmitClick);
  input.addEventListener("keydown", onKeyDown);

  const footer = document.createElement("div");
  footer.style.cssText = CSS.footer;
  const cancelBtn = document.createElement("button");
  cancelBtn.type = "button";
  cancelBtn.textContent = L("cancel");
  cancelBtn.style.cssText = CSS.ghost;
  const onCancel = () => void oauth.cancel();
  cancelBtn.addEventListener("click", onCancel);
  footer.append(cancelBtn);

  root.append(title, intro, openBtn, status, divider, field, submitBtn, footer);
  container.replaceChildren(root);

  const unsubscribe = oauth.onStatus((next) => {
    if (disposed || !next) return;
    const state = String(next.status ?? "");
    if (state === "error") say(next.error ? `${L("failed")}: ${next.error}` : L("failed"), "error");
    else if (state === "cancelled") say(L("cancelled"));
    else if (state === "success") say(L("done"));
    else if (state === "pending" && opened) say(L("waiting"));
  });

  if (!authUrl) {
    say(L("noUrl"), "error");
    openBtn.disabled = true;
    openBtn.style.opacity = "0.6";
  }

  return () => {
    disposed = true;
    try {
      unsubscribe?.();
    } catch {
      /* 取消订阅失败不影响卸载 */
    }
    openBtn.removeEventListener("click", onOpen);
    submitBtn.removeEventListener("click", onSubmitClick);
    cancelBtn.removeEventListener("click", onCancel);
    input.removeEventListener("keydown", onKeyDown);
    container.replaceChildren();
  };
}

export default { mount };
