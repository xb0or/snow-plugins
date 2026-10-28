/**
 * WorkBuddy 登录面板（Snow 0.5.6+ 自定义登录面板，ESM 单文件）
 * ------------------------------------------------------------------
 * 插件只导出一个 provider，覆盖两个站点：国内版（copilot.tencent.com）与国际版（www.workbuddy.ai）。
 * 两个站点的 device 授权在 authorize() 里并行发起，授权地址随会话传进来，这个面板只负责：
 *   1. 让用户选站点（面板不会自动打开浏览器）；
 *   2. 把选中的授权页交给系统浏览器；
 *   3. 显示等待与失败。
 * 令牌由宿主按 device 流程轮询 oauth.mjs 的 poll() 取得，面板不碰令牌；poll 会记住命中的站点。
 *
 * 约束：入口以 Blob 形式被 import，必须是单文件、无相对 import、无裸模块名。
 */

const STRINGS = {
  "zh-CN": {
    title: "WorkBuddy 登录",
    intro: "选一个站点在系统浏览器里完成登录；登录完成后本窗口会自动继续，无需手动操作。",
    pick: "选择站点",
    open: "打开授权页",
    reopen: "重新打开",
    opening: "已把授权页交给浏览器，请在那里完成登录…",
    cancel: "取消登录",
    done: "登录成功，正在创建账号…",
    cancelled: "登录已取消。",
    failed: "登录失败",
    noSite: "本次会话没有可用的授权地址，请关闭弹窗后重新发起登录。",
    hint: "国内账号选「WorkBuddy 国内版」，海外账号选「WorkBuddy 国际版」；面板会把命中的站点记进档案，之后不用再选。",
  },
  "zh-TW": {
    title: "WorkBuddy 登入",
    intro: "選一個站點在系統瀏覽器完成登入；登入完成後本視窗會自動繼續，無需手動操作。",
    pick: "選擇站點",
    open: "開啟授權頁",
    reopen: "重新開啟",
    opening: "已把授權頁交給瀏覽器，請在那裡完成登入…",
    cancel: "取消登入",
    done: "登入成功，正在建立帳號…",
    cancelled: "登入已取消。",
    failed: "登入失敗",
    noSite: "本次對話沒有可用的授權位址，請關閉彈窗後重新發起登入。",
    hint: "國內帳號選「WorkBuddy 國內版」，海外帳號選「WorkBuddy 國際版」；面板會把命中的站點記進檔案，之後不用再選。",
  },
  en: {
    title: "WorkBuddy sign-in",
    intro: "Pick a site and finish signing in from your system browser; this window continues automatically.",
    pick: "Choose a site",
    open: "Open authorization page",
    reopen: "Open again",
    opening: "The page was handed to your browser; finish signing in there…",
    cancel: "Cancel",
    done: "Signed in. Creating the account…",
    cancelled: "Sign-in cancelled.",
    failed: "Sign-in failed",
    noSite: "This session has no authorization URL. Close the dialog and start again.",
    hint: "China accounts pick WorkBuddy (China); overseas accounts pick WorkBuddy (Global). The site is stored on the profile, so you only choose once.",
  },
};

const CSS = {
  root: "display:flex;flex-direction:column;gap:10px;font-size:13px;color:var(--text-primary,#1f2328);min-width:0",
  title: "margin:0;font-weight:600;font-size:13px",
  intro: "margin:0;color:var(--text-secondary,#6b7280);font-size:12px;line-height:1.5",
  sites: "display:flex;flex-wrap:wrap;gap:8px",
  siteBtn: [
    "display:flex",
    "flex-direction:column",
    "align-items:flex-start",
    "gap:2px",
    "padding:8px 12px",
    "border-radius:8px",
    "font-size:12px",
    "cursor:pointer",
    "border:1px solid var(--border-color,#e5e7eb)",
    "background:var(--bg-secondary,transparent)",
    "color:var(--text-primary,#1f2328)",
    "text-align:left",
    "min-width:0",
  ].join(";"),
  siteLabel: "font-weight:600;font-size:12px",
  siteHost: "color:var(--text-muted,#9ca3af);font-size:11px;word-break:break-all",
  status: "margin:0;font-size:12px;color:var(--text-secondary,#6b7280);line-height:1.5",
  hint: "margin:0;color:var(--text-muted,#9ca3af);font-size:11px;line-height:1.5",
  footer: "display:flex;justify-content:flex-end",
  cancel:
    "padding:6px 12px;border-radius:6px;font-size:12px;cursor:pointer;border:1px solid var(--border-color,#e5e7eb);background:var(--bg-secondary,transparent);color:var(--text-primary,#1f2328)",
};

export function mount(container, api) {
  const oauth = api?.oauth;
  const locale = typeof api?.locale === "string" ? api.locale : "zh-CN";
  const table = STRINGS[locale] ?? STRINGS[locale.split("-")[0]] ?? STRINGS.en;
  const L = (key) => table[key] ?? STRINGS.en[key] ?? key;

  if (!oauth) {
    const note = document.createElement("p");
    note.textContent = L("noSite");
    note.style.cssText = CSS.status;
    container.replaceChildren(note);
    return () => container.replaceChildren();
  }

  const session = oauth.session ?? {};
  const meta = (() => {
    const raw = session.pluginSession;
    if (raw && typeof raw === "object") return raw;
    if (typeof raw === "string") {
      try {
        return JSON.parse(raw);
      } catch {
        return null;
      }
    }
    return null;
  })();
  const sites = Array.isArray(meta?.sites) ? meta.sites.filter((s) => s && typeof s.url === "string" && s.url) : [];

  const root = document.createElement("div");
  root.style.cssText = CSS.root;

  const title = document.createElement("p");
  title.textContent = L("title");
  title.style.cssText = CSS.title;

  const intro = document.createElement("p");
  intro.textContent = L("intro");
  intro.style.cssText = CSS.intro;

  const status = document.createElement("p");
  status.textContent = sites.length ? L("pick") : L("noSite");
  status.style.cssText = CSS.status;

  const hint = document.createElement("p");
  hint.textContent = L("hint");
  hint.style.cssText = CSS.hint;

  const say = (text, tone) => {
    status.textContent = text;
    status.style.color =
      tone === "error" ? "var(--color-error,#dc2626)" : "var(--text-secondary,#6b7280)";
  };

  let disposed = false;
  let openedId = "";

  const labelOf = (site) => {
    if (locale === "en" && typeof site.labelEn === "string" && site.labelEn) return site.labelEn;
    if (typeof site.label === "string" && site.label) return site.label;
    return typeof site.id === "string" ? site.id : "WorkBuddy";
  };
  const hostOf = (url) => {
    try {
      return new URL(url).host;
    } catch {
      return "";
    }
  };

  const buttons = [];
  const list = document.createElement("div");
  list.style.cssText = CSS.sites;

  const openSite = (site, button) => {
    oauth.openBrowser(site.url);
    openedId = String(site.id ?? "");
    for (const [id, el] of buttons) {
      const active = id === openedId;
      el.style.borderColor = active ? "var(--accent-blue,#2563eb)" : "var(--border-color,#e5e7eb)";
      el.style.background = active ? "var(--accent-blue-bg,rgba(37,99,235,0.08))" : "var(--bg-secondary,transparent)";
      const mark = el.querySelector("[data-role='action']");
      if (mark) mark.textContent = active ? L("reopen") : L("open");
    }
    say(L("opening"));
  };

  for (const site of sites) {
    const button = document.createElement("button");
    button.type = "button";
    button.style.cssText = CSS.siteBtn;

    const name = document.createElement("span");
    name.style.cssText = CSS.siteLabel;
    name.textContent = labelOf(site);

    const host = document.createElement("span");
    host.style.cssText = CSS.siteHost;
    host.textContent = hostOf(site.url);

    const action = document.createElement("span");
    action.dataset.role = "action";
    action.style.cssText = "color:var(--accent-blue,#2563eb);font-size:11px";
    action.textContent = L("open");

    button.append(name, host, action);
    const id = String(site.id ?? "");
    const onClick = () => openSite(site, button);
    button.addEventListener("click", onClick);
    buttons.push([id, button]);
    list.append(button);
  }

  const footer = document.createElement("div");
  footer.style.cssText = CSS.footer;
  const cancelBtn = document.createElement("button");
  cancelBtn.type = "button";
  cancelBtn.textContent = L("cancel");
  cancelBtn.style.cssText = CSS.cancel;
  const onCancel = () => void oauth.cancel();
  cancelBtn.addEventListener("click", onCancel);
  footer.append(cancelBtn);

  if (sites.length) root.append(title, intro, list, status, hint, footer);
  else root.append(title, intro, status, footer);
  container.replaceChildren(root);

  const unsubscribe = oauth.onStatus((next) => {
    if (disposed || !next) return;
    const state = String(next.status ?? "");
    if (state === "error") say(next.error ? `${L("failed")}: ${next.error}` : L("failed"), "error");
    else if (state === "cancelled") say(L("cancelled"));
    else if (state === "success") say(L("done"));
  });

  return () => {
    disposed = true;
    try {
      unsubscribe?.();
    } catch {
      /* 取消订阅失败不影响卸载 */
    }
    for (const [, button] of buttons) {
      button.replaceWith(button.cloneNode(true));
    }
    cancelBtn.removeEventListener("click", onCancel);
    container.replaceChildren();
  };
}

export default { mount };
