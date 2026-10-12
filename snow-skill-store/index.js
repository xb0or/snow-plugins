/*
 * Skill Store for Snow App
 * A community skill index browser & installer panel for Snow App.
 *
 * Panel plugin, renderMode: esm. Default export: React panel component.
 * Data: public skill index JSON files fetched via api.net.fetch
 * (main-process network stack, honors app proxy, no CORS), with a
 * jsDelivr mirror fallback per source and 12h plugin-storage cache.
 * Install: public write action "skills.installGithub" with a
 * global/project location choice; fallback path inserts an install
 * request into the chat input via public action "chatInput.insertText".
 * No sensitive metadata domains are read (skills/theme are declaration-free).
 *
 * Upstream data aggregation and attribution are documented in README.md.
 */

"use strict";

const OFFICIAL_URLS = [
  "https://raw.githubusercontent.com/anbeime/skill/main/data/skills.json",
  "https://cdn.jsdelivr.net/gh/anbeime/skill@main/data/skills.json",
];

const LOCAL_URLS = [
  "https://raw.githubusercontent.com/anbeime/skill/main/data/local_skills.json",
  "https://cdn.jsdelivr.net/gh/anbeime/skill@main/data/local_skills.json",
];

const COMMUNITY_URLS = [
  "https://raw.githubusercontent.com/anbeime/skill/main/SKILL_SOURCES.json",
  "https://cdn.jsdelivr.net/gh/anbeime/skill@main/SKILL_SOURCES.json",
];

const LOCAL_SKILL_LINK_PREFIX = "https://github.com/anbeime/skill/tree/main/skills/";
const SKILLS_SH_SITEMAPS = [
  "https://www.skills.sh/sitemap-skills-1.xml",
  "https://www.skills.sh/sitemap-skills-2.xml",
];
/* skills.sh exposes no JSON API; its SEO sitemap shards list every skill as
 * /<owner>/<repo>/<skill-name> in a stable (roughly popularity-ordered) list.
 * We lazily load it on first tab visit, keep the top entries only and cache
 * the compact path array. */
const SKILLS_SH_LIMIT = 6000;
const SKILLS_SH_DESC_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const CACHE_TTL_MS = 12 * 60 * 60 * 1000;
const COLLAPSED_CATS = 8;
const PAGE_SIZE = 80;

async function netFetchJson(api, urls) {
  let lastError = "";
  for (const url of urls) {
    try {
      const res = await api.net.fetch(url, { timeoutMs: 25000 });
      if (res && res.ok && res.status >= 200 && res.status < 300 && typeof res.body === "string") {
        return JSON.parse(res.body);
      }
      lastError = (res && (res.error || "HTTP " + res.status)) || "empty response";
    } catch (err) {
      lastError = err && err.message ? err.message : String(err);
    }
  }
  throw new Error(lastError || "network request failed");
}

async function loadCached(api, cacheKey, urls, force) {
  if (!force) {
    try {
      const cached = await api.storage.getJson(cacheKey);
      if (
        cached &&
        cached.data &&
        typeof cached.ts === "number" &&
        Date.now() - cached.ts < CACHE_TTL_MS
      ) {
        return cached.data;
      }
    } catch (_) {
      /* cache miss is non-fatal */
    }
  }
  const data = await netFetchJson(api, urls);
  try {
    await api.storage.setJson(cacheKey, { ts: Date.now(), data: data });
  } catch (_) {
    /* cache write is non-fatal */
  }
  return data;
}

function normalizeOfficial(raw) {
  const skills = raw && Array.isArray(raw.skills) ? raw.skills : [];
  return {
    items: skills.map(function (s) {
      return {
        name: s.name || "",
        category: s.category || "",
        description: s.description || "",
        source: s.source || "",
        link: s.link || "",
      };
    }),
    total: (raw && raw.total) || skills.length,
    updatedAt: (raw && raw.updated_at) || "",
  };
}

function normalizeLocal(raw) {
  const categories = (raw && raw.categories) || {};
  const highlights = new Map(
    (((raw || {}).highlights || {}).core_skills || []).map(function (s) {
      return [s.name, s];
    })
  );
  const items = [];
  for (const entry of Object.entries(categories)) {
    const cat = entry[0];
    const info = entry[1] || {};
    const skills = Array.isArray(info.skills) ? info.skills : [];
    for (const name of skills) {
      const hl = highlights.get(name);
      items.push({
        name: name,
        category: cat,
        description: (hl && hl.description) || "",
        rating: (hl && hl.rating) || 0,
        builtin: Boolean(info.note),
        link: LOCAL_SKILL_LINK_PREFIX + encodeURIComponent(name),
      });
    }
  }
  return {
    items: items,
    metadata: (raw && raw.metadata) || null,
    updateLog: raw && Array.isArray(raw.update_log) ? raw.update_log : [],
  };
}

function normalizeCommunity(raw) {
  const sources = (raw && raw.sources) || {};
  const items = [];
  for (const entry of Object.entries(sources)) {
    const key = entry[0];
    const info = entry[1] || {};
    items.push({
      name: key,
      category: info.upstream_source || "unknown",
      description: info.description || "",
      discoveredAt: info.discovered_at || "",
      link: "https://github.com/" + key,
    });
  }
  items.sort(function (a, b) {
    return (b.discoveredAt || "").localeCompare(a.discoveredAt || "");
  });
  return { items: items, total: items.length };
}

function extractSkillsShPaths(xml) {
  const re = /<loc>\s*https:\/\/www\.skills\.sh\/([^<\s]+?)\s*<\/loc>/g;
  const paths = [];
  let m;
  while ((m = re.exec(xml)) !== null) {
    const p = m[1];
    /* keep only owner/repo/skill entries (skip owner or repo index pages) */
    if (p.indexOf("/") === -1 || p.indexOf("/") === p.lastIndexOf("/")) continue;
    if (paths.length >= SKILLS_SH_LIMIT) break;
    paths.push(p);
  }
  return paths;
}

function normalizeSkillsSh(paths) {
  const items = (paths || []).map(function (p) {
    const seg = String(p).split("/");
    const owner = seg[0] || "";
    const repo = seg[1] || "";
    const name = seg.slice(2).join("/") || String(p);
    return {
      name: name,
      category: "",
      description: "",
      repo: owner && repo ? owner + "/" + repo : "",
      link: owner && repo ? "https://github.com/" + owner + "/" + repo : "",
      detail: "https://www.skills.sh/" + p,
    };
  });
  return { items: items, total: items.length };
}

function decodeHtmlEntities(s) {
  return String(s)
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, function (m, d) {
      const code = parseInt(d, 10);
      return code > 0 ? String.fromCharCode(code) : m;
    })
    .replace(/&amp;/g, "&");
}

function extractSkillsShDescription(html) {
  if (typeof html !== "string" || !html) return "";
  const patterns = [
    /<meta\s+property="og:description"\s+content="([^"]*)"/i,
    /<meta\s+name="description"\s+content="([^"]*)"/i,
    /<meta\s+content="([^"]*)"\s+property="og:description"/i,
    /<meta\s+content="([^"]*)"\s+name="description"/i,
  ];
  for (const re of patterns) {
    const m = html.match(re);
    if (m && m[1]) return decodeHtmlEntities(m[1]).trim();
  }
  return "";
}

function tailOf(name) {
  return String(name || "")
    .toLowerCase()
    .split("/")
    .pop()
    .trim();
}

function isInstalled(item, installedIds) {
  const full = String(item.name || "").toLowerCase();
  const tail = tailOf(item.name);
  if (!tail) return false;
  for (const id of installedIds) {
    if (id === full || id === tail || tailOf(id) === tail) return true;
  }
  return false;
}

export default function SkillStorePanel(props) {
  const React = window.SnowAppPlugin && window.SnowAppPlugin.React;
  const api = (props && props.api) || (window.SnowAppPlugin && window.SnowAppPlugin.api);
  const h = React.createElement;

  const t = function (key, options) {
    return api.t(key, options || {});
  };

  const [tab, setTab] = React.useState("official");
  const [query, setQuery] = React.useState("");
  const [category, setCategory] = React.useState("__all");
  const [official, setOfficial] = React.useState(null);
  const [local, setLocal] = React.useState(null);
  const [community, setCommunity] = React.useState(null);
  const [skillssh, setSkillssh] = React.useState(null);
  const [skillsshLoading, setSkillsshLoading] = React.useState(false);
  const [skillsshError, setSkillsshError] = React.useState(null);
  const [descMap, setDescMap] = React.useState({});
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState(null);
  const [installedIds, setInstalledIds] = React.useState([]);
  const [busyName, setBusyName] = React.useState(null);
  const [toast, setToast] = React.useState(null);
  const [showLog, setShowLog] = React.useState(false);
  const [showAllCats, setShowAllCats] = React.useState(false);
  const [limit, setLimit] = React.useState(PAGE_SIZE);
  const [installScope, setInstallScope] = React.useState("global");
  const [themeStyle, setThemeStyle] = React.useState(null);
  const toastTimer = React.useRef(null);
  const descMapRef = React.useRef({});
  const descBusy = React.useRef(false);

  const showToast = function (msg, kind) {
    setToast({ msg: msg, kind: kind || "info" });
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(function () {
      setToast(null);
    }, 3600);
  };

  const loadInstalled = async function () {
    try {
      const res = await api.metadata.get("skills");
      const list =
        (res && res.domains && res.domains.skills && res.domains.skills.available) || [];
      setInstalledIds(
        list.map(function (s) {
          return String((s && s.id) || "").toLowerCase();
        })
      );
    } catch (_) {
      setInstalledIds([]);
    }
  };

  const loadTheme = async function () {
    try {
      const res = await api.metadata.get("theme");
      const th = res && res.domains && res.domains.theme;
      if (!th) return;
      const pal = th.custom && (th.mode === "dark" ? th.custom.dark : th.custom.light);
      if (!pal) return;
      setThemeStyle({
        "--sk-bg": pal.bgSecondary,
        "--sk-card": pal.bgPrimary,
        "--sk-card-hover": pal.bgHover,
        "--sk-border": pal.borderColor,
        "--sk-text": pal.textPrimary,
        "--sk-text2": pal.textSecondary,
        "--sk-accent": pal.accentColor || pal.accentGreen,
        "--sk-green-bg": pal.accentGreenBg,
        "--sk-green-text": pal.accentGreenText,
      });
    } catch (_) {
      /* theme is optional decoration */
    }
  };

  const loadAll = async function (force) {
    setLoading(true);
    setError(null);
    const jobs = [
      loadCached(api, "cache.official", OFFICIAL_URLS, force)
        .then(function (d) {
          return normalizeOfficial(d);
        })
        .catch(function (e) {
          return e;
        }),
      loadCached(api, "cache.local", LOCAL_URLS, force)
        .then(function (d) {
          return normalizeLocal(d);
        })
        .catch(function (e) {
          return e;
        }),
      loadCached(api, "cache.community", COMMUNITY_URLS, force)
        .then(function (d) {
          return normalizeCommunity(d);
        })
        .catch(function (e) {
          return e;
        }),
    ];
    const results = await Promise.all(jobs);
    const setters = [setOfficial, setLocal, setCommunity];
    const labels = ["official", "local", "community"];
    const failed = [];
    let anyOk = false;
    results.forEach(function (r, i) {
      if (r instanceof Error) {
        failed.push(labels[i] + ": " + r.message);
      } else {
        setters[i](r);
        anyOk = true;
      }
    });
    if (!anyOk) {
      setError(failed.join(" / "));
    } else if (failed.length) {
      showToast(t("toast.partial", { values: { msg: failed.join(" / ") } }), "warn");
    }
    setLoading(false);
  };

  const ensureSkillsSh = async function (force) {
    if (!force && skillssh) return;
    if (!force) {
      try {
        const cached = await api.storage.getJson("cache.skillssh");
        if (
          cached &&
          Array.isArray(cached.paths) &&
          typeof cached.ts === "number" &&
          Date.now() - cached.ts < CACHE_TTL_MS
        ) {
          setSkillssh(normalizeSkillsSh(cached.paths));
          return;
        }
      } catch (_) {
        /* cache miss is non-fatal */
      }
    }
    setSkillsshLoading(true);
    setSkillsshError(null);
    try {
      const paths = [];
      for (const url of SKILLS_SH_SITEMAPS) {
        const res = await api.net.fetch(url, { timeoutMs: 45000 });
        if (!(res && res.ok && typeof res.body === "string")) {
          throw new Error((res && (res.error || "HTTP " + res.status)) || "empty response");
        }
        const part = extractSkillsShPaths(res.body);
        for (const p of part) {
          if (paths.length >= SKILLS_SH_LIMIT) break;
          paths.push(p);
        }
        if (paths.length >= SKILLS_SH_LIMIT) break;
      }
      if (!paths.length) throw new Error("no skill entries found in sitemaps");
      try {
        await api.storage.setJson("cache.skillssh", { ts: Date.now(), paths: paths });
      } catch (_) {
        /* cache write is non-fatal */
      }
      setSkillssh(normalizeSkillsSh(paths));
    } catch (e) {
      setSkillsshError(e && e.message ? e.message : String(e));
    } finally {
      setSkillsshLoading(false);
    }
  };

  React.useEffect(function () {
    loadAll(false);
    loadInstalled();
    loadTheme();
    api.storage
      .getJson("cache.skillssh.desc")
      .then(function (c) {
        if (
          c &&
          c.map &&
          typeof c.ts === "number" &&
          Date.now() - c.ts < SKILLS_SH_DESC_TTL_MS
        ) {
          descMapRef.current = c.map;
          setDescMap(c.map);
        }
      })
      .catch(function () {
        /* description cache is optional */
      });
    return function () {
      if (toastTimer.current) clearTimeout(toastTimer.current);
    };
  }, []);

  React.useEffect(
    function () {
      setLimit(PAGE_SIZE);
    },
    [tab, query, category]
  );

  React.useEffect(
    function () {
      if (tab === "skillssh") ensureSkillsSh(false);
    },
    [tab]
  );


  const install = async function (item) {
    if (!item.link || busyName) return;
    setBusyName(item.name);
    try {
      const res = await api.write.run("skills.installGithub", {
        url: item.link,
        location: installScope,
      });
      if (res && res.ok) {
        showToast(t("toast.installOk", { values: { name: item.name } }), "ok");
        loadInstalled();
      } else if (res && res.denied && res.denied.reason === "unknown-action") {
        showToast(t("toast.actionMissing"), "warn");
      } else {
        showToast(
          t("toast.installFail", {
            values: {
              msg: (res && (res.error || (res.denied && res.denied.reason))) || "unknown",
            },
          }),
          "error"
        );
      }
    } finally {
      setBusyName(null);
    }
  };

  const askAi = async function (item) {
    const text = t(installScope === "project" ? "aiInstallPromptProject" : "aiInstallPromptGlobal", {
      values: { name: item.name, url: item.link },
    });
    const res = await api.write.run("chatInput.insertText", { text: text });
    if (res && res.ok) {
      showToast(t("toast.inserted"), "ok");
    } else {
      showToast(
        t("toast.insertFail", { values: { msg: (res && res.error) || "unknown" } }),
        "error"
      );
    }
  };

  const Icon = function (iconProps) {
    const name = iconProps.name;
    const size = iconProps.size || 15;
    const lib = (window.SnowAppPlugin && window.SnowAppPlugin.icons) || {};
    let comp = lib[name];
    if (!comp && api.ui && typeof api.ui.icon === "function") {
      try {
        comp = api.ui.icon(name);
      } catch (_) {
        comp = null;
      }
    }
    if (comp && (typeof comp === "function" || (comp && comp.$$typeof))) {
      return h(comp, { size: size, width: size, height: size, "aria-hidden": true });
    }
    return null;
  };

  const officialItems = official ? official.items : [];
  const localItems = local ? local.items : [];
  const communityItems = community ? community.items : [];
  const skillsshItems = skillssh ? skillssh.items : [];
  const activeItems =
    tab === "official"
      ? officialItems
      : tab === "local"
        ? localItems
        : tab === "community"
          ? communityItems
          : skillsshItems;

  const categories = React.useMemo(
    function () {
      const map = new Map();
      for (const it of activeItems) {
        if (it.category) map.set(it.category, (map.get(it.category) || 0) + 1);
      }
      return Array.from(map.entries()).sort(function (a, b) {
        return b[1] - a[1] || a[0].localeCompare(b[0]);
      });
    },
    [activeItems]
  );

  const filtered = React.useMemo(
    function () {
      const q = query.trim().toLowerCase();
      return activeItems.filter(function (it) {
        if (category !== "__all" && it.category !== category) return false;
        if (!q) return true;
        return (
          (it.name +
            " " +
            it.description +
            " " +
            it.category +
            " " +
            (it.source || "") +
            " " +
            (it.repo || ""))
            .toLowerCase()
            .indexOf(q) !== -1
        );
      });
    },
    [activeItems, query, category]
  );

  const visibleItems = React.useMemo(
    function () {
      return filtered.slice(0, limit);
    },
    [filtered, limit]
  );
  const remaining = filtered.length - visibleItems.length;
  /* skills.sh cards have no description in the sitemap; silently fetch
   * og:description from the detail pages of the currently visible page
   * (3 concurrent workers) and persist results in plugin storage. */
  React.useEffect(
    function () {
      if (tab !== "skillssh" || !skillssh) return;
      if (descBusy.current) return;
      const missing = visibleItems.filter(function (it) {
        return it.detail && !(it.detail in descMapRef.current);
      });
      if (!missing.length) return;
      descBusy.current = true;
      const queue = missing.slice(0, PAGE_SIZE);
      const results = {};
      let idx = 0;
      const worker = async function () {
        while (idx < queue.length) {
          const item = queue[idx++];
          try {
            const res = await api.net.fetch(item.detail, { timeoutMs: 15000 });
            results[item.detail] =
              res && res.ok && typeof res.body === "string"
                ? extractSkillsShDescription(res.body)
                : "";
          } catch (_) {
            results[item.detail] = "";
          }
        }
      };
      Promise.all([worker(), worker(), worker()])
        .then(function () {
          const merged = Object.assign({}, descMapRef.current, results);
          descMapRef.current = merged;
          setDescMap(merged);
          try {
            api.storage.setJson("cache.skillssh.desc", { ts: Date.now(), map: merged });
          } catch (_) {
            /* cache write is non-fatal */
          }
        })
        .catch(function () {})
        .finally(function () {
          descBusy.current = false;
        });
    },
    [tab, skillssh, visibleItems]
  );

  const renderCard = function (it) {
    const inst = isInstalled(it, installedIds);
    const busy = busyName === it.name;
    return h(
      "div",
      {
        key:
          (tab === "official" ? "o:" : tab === "local" ? "l:" : tab === "community" ? "c:" : "s:") +
          it.name,
        className: "skstore-card" + (inst ? " is-installed" : ""),
      },
      h(
        "div",
        { className: "skstore-card-head" },
        h("span", { className: "skstore-name", title: it.name }, it.name),
        it.rating
          ? h(
              "span",
              { className: "skstore-rating", title: it.rating + "/5" },
              "\u2605 " + it.rating
            )
          : null,
        inst ? h("span", { className: "skstore-badge" }, t("badge.installed")) : null
      ),
      it.description || (tab === "skillssh" ? descMap[it.detail] || "" : "")
        ? h(
            "div",
            { className: "skstore-desc" },
            tab === "skillssh" ? descMap[it.detail] || it.description : it.description
          )
        : null,
      h(
        "div",
        { className: "skstore-meta" },
        it.category ? h("span", { className: "skstore-chip" }, it.category) : null,
        tab === "official" && it.source
          ? h("span", { className: "skstore-src", title: it.source }, it.source)
          : null,
        tab === "community" && it.discoveredAt
          ? h(
              "span",
              { className: "skstore-src" },
              t("meta.discovered") + ": " + String(it.discoveredAt).slice(0, 10)
            )
          : null,
        tab === "local" && it.builtin
          ? h("span", { className: "skstore-builtin" }, t("badge.builtin"))
          : null,
        tab === "skillssh" && it.repo
          ? h("span", { className: "skstore-chip", title: it.repo }, it.repo)
          : null
      ),
      h(
        "div",
        { className: "skstore-actions" },
        h(
          "button",
          {
            className: "skstore-btn primary",
            disabled: busy || inst || !it.link,
            onClick: function () {
              install(it);
            },
            title: it.link || "",
          },
          busy ? t("btn.installing") : inst ? t("badge.installed") : t("btn.install")
        ),
        h(
          "button",
          {
            className: "skstore-btn recommended",
            onClick: function () {
              askAi(it);
            },
            title: t("btn.askAiHint"),
          },
          t("btn.askAi")
        ),
        it.link
          ? h(
              "a",
              {
                className: "skstore-btn link",
                href: it.link,
                target: "_blank",
                rel: "noreferrer",
              },
              "GitHub"
            )
          : null,
        it.detail
          ? h(
              "a",
              {
                className: "skstore-btn link",
                href: it.detail,
                target: "_blank",
                rel: "noreferrer",
                title: it.detail,
              },
              t("btn.detail")
            )
          : null
      )
    );
  };

  const officialCount = official ? official.total : 0;
  const localCount = local ? local.items.length : 0;
  const communityCount = community ? community.total : 0;
  const skillsshCountText = skillssh
    ? String(skillssh.total)
    : skillsshLoading
      ? "\u2026"
      : "";

  const visibleCats = showAllCats ? categories : categories.slice(0, COLLAPSED_CATS);
  const hiddenCats = categories.length - visibleCats.length;

  return h(
    "div",
    { className: "skstore", style: themeStyle || undefined },
    h(
      "div",
      { className: "skstore-header" },
      h(
        "div",
        { className: "skstore-title-row" },
        h(Icon, { name: "Store", size: 16 }),
        h("span", { className: "skstore-title" }, t("header.title", { defaultValue: "Skill Store" }))
      ),
      h(
        "div",
        { className: "skstore-toolbar" },
        h("input", {
          className: "skstore-search",
          type: "text",
          placeholder: t("search.placeholder"),
          value: query,
          onChange: function (e) {
            setQuery(e.target.value);
          },
        }),
        h(
          "div",
          {
            className: "skstore-scope",
            title: t("scope.title", { defaultValue: "install location" }),
          },
          h("span", { className: "skstore-scope-label" }, t("scope.label")),
          h(
            "button",
            {
              className: "skstore-scope-btn" + (installScope === "global" ? " active" : ""),
              onClick: function () {
                setInstallScope("global");
              },
            },
            t("scope.global")
          ),
          h(
            "button",
            {
              className: "skstore-scope-btn" + (installScope === "project" ? " active" : ""),
              onClick: function () {
                setInstallScope("project");
              },
            },
            t("scope.project")
          )
        ),
        h(
          "button",
          {
            className: "skstore-btn",
            disabled: loading,
            onClick: function () {
              loadAll(true);
              if (skillssh || tab === "skillssh") ensureSkillsSh(true);
            },
          },
          loading ? t("state.loading") : t("btn.refresh")
        )
      ),
      h(
        "div",
        { className: "skstore-tabs" },
        h(
          "button",
          {
            className: "skstore-tab" + (tab === "official" ? " active" : ""),
            onClick: function () {
              setTab("official");
              setCategory("__all");
              setShowAllCats(false);
            },
          },
          t("tab.official") + " (" + officialCount + ")"
        ),
        h(
          "button",
          {
            className: "skstore-tab" + (tab === "local" ? " active" : ""),
            onClick: function () {
              setTab("local");
              setCategory("__all");
              setShowAllCats(false);
            },
          },
          t("tab.local") + " (" + localCount + ")"
        ),
        h(
          "button",
          {
            className: "skstore-tab" + (tab === "community" ? " active" : ""),
            onClick: function () {
              setTab("community");
              setCategory("__all");
              setShowAllCats(false);
            },
          },
          t("tab.community") + " (" + communityCount + ")"
        ),
        h(
          "button",
          {
            className: "skstore-tab" + (tab === "skillssh" ? " active" : ""),
            onClick: function () {
              setTab("skillssh");
              setCategory("__all");
              setShowAllCats(false);
            },
          },
          "skills.sh" + (skillsshCountText ? " (" + skillsshCountText + ")" : "")
        )
      )
    ),
    categories.length > 1
      ? h(
          "div",
          { className: "skstore-cats" },
          h(
            "button",
            {
              className: "skstore-cat" + (category === "__all" ? " active" : ""),
              onClick: function () {
                setCategory("__all");
              },
            },
            t("cat.all") + " (" + activeItems.length + ")"
          ),
          visibleCats.map(function (entry) {
            return h(
              "button",
              {
                key: entry[0],
                className: "skstore-cat" + (category === entry[0] ? " active" : ""),
                onClick: function () {
                  setCategory(entry[0]);
                },
              },
              entry[0] + " (" + entry[1] + ")"
            );
          }),
          categories.length > COLLAPSED_CATS
            ? h(
                "button",
                {
                  className: "skstore-cat more-toggle",
                  onClick: function () {
                    setShowAllCats(!showAllCats);
                  },
                },
                showAllCats
                  ? t("cat.less")
                  : t("cat.more", { values: { count: hiddenCats } })
              )
            : null
        )
      : null,
    h(
      "div",
      { className: "skstore-list" },
      tab === "skillssh" && skillsshLoading && !skillssh
        ? h("div", { className: "skstore-state" }, t("state.loading"))
        : tab === "skillssh" && skillsshError && !skillssh
          ? h(
              "div",
              { className: "skstore-state error" },
              h("div", null, t("state.error") + ": " + skillsshError),
              h(
                "button",
                {
                  className: "skstore-btn",
                  onClick: function () {
                    ensureSkillsSh(true);
                  },
                },
                t("state.retry")
              )
            )
          : loading && !official && !local && !community
        ? h("div", { className: "skstore-state" }, t("state.loading"))
        : error && !official && !local && !community
          ? h(
              "div",
              { className: "skstore-state error" },
              h("div", null, t("state.error") + ": " + error),
              h(
                "button",
                {
                  className: "skstore-btn",
                  onClick: function () {
                    loadAll(true);
                  },
                },
                t("state.retry")
              )
            )
          : filtered.length === 0
            ? h("div", { className: "skstore-state" }, t("state.empty"))
            : visibleItems.map(renderCard),
      remaining > 0
        ? h(
            "button",
            {
              className: "skstore-more",
              onClick: function () {
                setLimit(limit + PAGE_SIZE);
              },
            },
            t("page.more", { values: { count: remaining } })
          )
        : null,
      tab === "local" && local && local.updateLog.length
        ? h(
            "div",
            { className: "skstore-log" },
            h(
              "button",
              {
                className: "skstore-log-toggle",
                onClick: function () {
                  setShowLog(!showLog);
                },
              },
              showLog ? t("log.hide") : t("log.show")
            ),
            showLog
              ? h(
                  "div",
                  { className: "skstore-log-body" },
                  local.updateLog.map(function (e) {
                    return h(
                      "div",
                      { key: e.date + ":" + e.version, className: "skstore-log-item" },
                      h(
                        "span",
                        { className: "skstore-log-date" },
                        (e.date || "") + " v" + (e.version || "")
                      ),
                      h(
                        "ul",
                        null,
                        (e.changes || []).map(function (c, i) {
                          return h("li", { key: i }, c);
                        })
                      )
                    );
                  })
                )
              : null
          )
        : null
    ),
    h(
      "div",
      { className: "skstore-footer" },
      h("div", { className: "skstore-footer-meta" },
        official && official.updatedAt
          ? t("footer.updated") + ": " + String(official.updatedAt).slice(0, 10) + " · "
          : "",
        community && community.total
          ? t("tab.community") + ": " + community.total + " · "
          : "",
        skillssh && skillssh.total
          ? "skills.sh: top " + skillssh.total
          : ""
      ),
      h("div", { className: "skstore-disclaimer" }, t("disclaimer"))
    ),
    toast
      ? h("div", { className: "skstore-toast " + (toast.kind || "info") }, toast.msg)
      : null
  );
}
