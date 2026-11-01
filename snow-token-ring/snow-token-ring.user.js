// ==UserScript==
// @name         TokenRing增强
// @namespace    kedou
// @version      2.4.0
// @description  增强输入区上下文圆环：把宿主原生的用量明细与上下文分解合并进同一块浮层；消息量与系统基线取自真实请求 token。
// @author       kedou
// @icon         lucide:PieChart
// @snow-target  client
// @snow-view    chat
// @run-at       document-idle
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_addStyle
// @grant        GM_registerMenuCommand
// @snow-privacy messages, personalization, systemPrompts, usage
// ==/UserScript==

/*
 * 数据源（全部只读）
 *   runtime.conversation.tokenUsage       当前上下文快照 { inputTokens, outputTokens, cacheCreationInputTokens, cacheReadInputTokens }
 *   runtime.chatInput.maxContextTokens    上下文上限（分母）
 *   messages.items                        当前会话消息（content / toolCallsJson）
 *   mcp.tools + mcp.projectServersWithTools[].tools   MCP 工具定义（name / description / inputSchemaJson）
 *   skills.available                      技能清单（name / description / allowedTools）
 *   personalization.content               ~/.snow/ROLE.md
 *   systemPrompts[]                       激活的系统提示词 content
 *
 * 口径
 *   总量 / 占用率 / 可用空间：宿主真实值（tokenUsage 与 maxContextTokens）
 *   分类：按文本长度估算（CJK 1 token/字，其他 0.28 token/字，空白 0.05），
 *         估算总和超过真实总量时按比例归一；不足部分计入「未归类（内置工具 / 框架文本）」。
 *   宿主没有暴露内置工具 schema 与上下文压缩缓冲，所以那两块只能落在「未归类」。
 *
 * 界面：只往输入区圆环里挂一个浮层节点；宿主原生 tooltip 的行（输入 / 输出 / 缓存 / 合计 / 上下文）
 *       在运行时读出来合并到同一块面板里，视觉上只有一块浮层，不修改宿主结构。
 */

(function () {
  "use strict";

  var HEAVY_MS = 15000; /* 消息 / MCP / 技能 / 提示词的刷新间隔 */
  var COLLAPSE_KEY = "scb.collapsed";

  /* ===================== 纯工具 ===================== */

  function num(v) {
    var n = Number(v);
    return isFinite(n) ? n : 0;
  }

  function clamp0(v) {
    return typeof v === "number" && isFinite(v) && v > 0 ? v : 0;
  }

  /** 人类可读 token：1.23B / 45.6M / 789k */
  function fmtTokens(n) {
    if (typeof n !== "number" || !isFinite(n)) return "0";
    if (n >= 1e9) return (n / 1e9).toFixed(2) + "B";
    if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
    if (n >= 1e3) return Math.round(n / 1e3) + "k";
    return String(Math.round(n));
  }

  /** 上下限这类整数会被格式化成 1.0M，去掉多余的 .0 */
  function fmtLimit(n) {
    return fmtTokens(n).replace(/\.0([kMB])$/, "$1");
  }

  /**
   * 文本长度 -> token 估算
   * CJK 按 1 token/字；拉丁/符号按 0.28 token/字（约 3.6 字符/token）；空白按 0.05。
   * 只用于分类占比，绝对误差不保证。
   */
  function estimateTokens(text) {
    if (!text) return 0;
    var s = String(text);
    var cjk = 0;
    var other = 0;
    var space = 0;
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      if (c === 32 || c === 9 || c === 10 || c === 13 || c === 12288) space++;
      else if (
        (c >= 0x4e00 && c <= 0x9fff) ||
        (c >= 0x3000 && c <= 0x303f) ||
        (c >= 0xff00 && c <= 0xffef) ||
        (c >= 0x3040 && c <= 0x30ff) ||
        (c >= 0xac00 && c <= 0xd7af)
      )
        cjk++;
      else other++;
    }
    return cjk * 1 + other * 0.28 + space * 0.05;
  }

  /* ===================== 存储 ===================== */

  function gmGet(key, def) {
    try {
      if (typeof GM_getValue === "function") {
        var v = GM_getValue(key, def);
        return v === undefined ? def : v;
      }
    } catch (e) {
      /* 忽略 */
    }
    return def;
  }

  function gmSet(key, value) {
    try {
      if (typeof GM_setValue === "function") GM_setValue(key, value);
    } catch (e) {
      /* 忽略 */
    }
  }

  /* ===================== 状态 ===================== */

  var state = {
    runtime: null,
    messages: null,
    mcp: null,
    skills: null,
    personalization: null,
    systemPrompts: null,
    usage: null,
    nativeRows: [],
    nativeSig: "",
    convId: "",
    projectId: "",
    locale: "zh-CN",
    collapsed: gmGet(COLLAPSE_KEY, false) === true,
    denied: {},
    dirty: true,
    lastHeavy: 0,
    normalized: false,
  };

  var subs = [];
  var mountedPop = null;
  var mountedRing = null;
  var hideTimer = null;
  var lastTooltipHeight = -1;
  var lastPosCheck = 0;
  var observer = null;
  var rafId = 0;
  var destroyed = false;
  var heavyTimer = null;

  /* ===================== 数据读取 ===================== */

  function contextSnapshot() {
    var rt = state.runtime && state.runtime.conversation;
    var u = rt && rt.tokenUsage;
    if (!u) return null;
    var input = num(u.inputTokens);
    var output = num(u.outputTokens);
    var cacheWrite = num(u.cacheCreationInputTokens);
    var cacheRead = Math.min(num(u.cacheReadInputTokens), input);
    var total = input + output;
    if (total <= 0) return null;
    return {
      input: input,
      output: output,
      cacheWrite: cacheWrite,
      cacheRead: cacheRead,
      nonCachedInput: Math.max(input - cacheRead - cacheWrite, 0),
      total: total,
    };
  }

  /* ---------- 首轮请求的真实输入 token（基线） ---------- */

  function pad2(n) {
    return n < 10 ? "0" + n : String(n);
  }

  function fmtDbTime(d) {
    return (
      d.getFullYear() +
      "-" +
      pad2(d.getMonth() + 1) +
      "-" +
      pad2(d.getDate()) +
      " " +
      pad2(d.getHours()) +
      ":" +
      pad2(d.getMinutes()) +
      ":" +
      pad2(d.getSeconds())
    );
  }

  function parseDbTime(s) {
    if (!s) return null;
    var m = String(s).replace("T", " ").match(/^(\d{4})-(\d{2})-(\d{2})[ ](\d{2}):(\d{2}):(\d{2})/);
    if (!m) return null;
    return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]));
  }

  /** 会话首条用户消息（含时间），用于定位首轮请求窗口 */
  function firstMessage() {
    var items = state.messages && state.messages.items;
    if (!Array.isArray(items) || !items.length) return null;
    var best = null;
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      if (!it || it.role !== "user") continue;
      var at = parseDbTime(it.createdAt);
      if (!best) best = { item: it, at: at };
      else if (at && (!best.at || at < best.at)) best = { item: it, at: at };
    }
    if (!best) {
      for (var j = 0; j < items.length; j++) {
        if (!items[j]) continue;
        best = { item: items[j], at: parseDbTime(items[j].createdAt) };
        break;
      }
    }
    return best;
  }

  /** 首条用户消息的 token 估算（唯一从基线里扣除的估算项） */
  function firstMessageTokens() {
    var f = firstMessage();
    if (!f || !f.item) return 0;
    return estimateTokens((f.item.content || "") + (f.item.toolCallsJson || ""));
  }

  /** 首轮请求的真实 input token：同一会话 earliest usage 记录 */
  function firstRequestInput() {
    var items = state.usage && state.usage.records && state.usage.records.items;
    if (!Array.isArray(items) || !items.length) return 0;
    var best = 0;
    var bestAt = "";
    for (var i = 0; i < items.length; i++) {
      var r = items[i];
      if (!r || r.conversationId !== state.convId) continue;
      if (r.isSubAgent) continue;
      var v = num(r.inputTokens);
      if (v <= 0) continue;
      var at = String(r.createdAt || "");
      if (!best || at < bestAt) {
        best = v;
        bestAt = at;
      }
    }
    return best;
  }

  function safeGet(domain, params) {
    return Promise.resolve()
      .then(function () {
        return snow.metadata.get(domain, params && Object.keys(params).length ? { params: params } : {});
      })
      .then(function (r) {
        if (r && r.denied && r.denied[domain]) {
          state.denied[domain] = true;
          return null;
        }
        state.denied[domain] = false;
        return (r && r.domains && r.domains[domain]) || null;
      })
      .catch(function () {
        state.denied[domain] = true;
        return null;
      });
  }

  /** 消息 / MCP / 技能 / 提示词：低频刷新，会话或流式结束时强制 */
  function refreshHeavy(force) {
    if (destroyed || !window.snow || !snow.metadata) return;
    var now = Date.now();
    if (!force && now - state.lastHeavy < HEAVY_MS) return;
    state.lastHeavy = now;
    var convId = state.convId;
    var projectId = state.projectId;
    Promise.all([
      convId ? safeGet("messages", { conversationId: convId }) : Promise.resolve(null),
      safeGet("mcp", projectId ? { projectId: projectId } : {}),
      safeGet("skills", projectId ? { projectId: projectId } : {}),
      safeGet("personalization"),
      safeGet("systemPrompts"),
    ]).then(function (arr) {
      if (destroyed) return;
      state.messages = arr[0];
      state.mcp = arr[1];
      state.skills = arr[2];
      state.personalization = arr[3];
      state.systemPrompts = arr[4];
      state.dirty = true;
      fetchFirstRequest();
      if (isPopOpen()) render();
    });
  }

  /** 按首条消息时间窗拉当前会话的 usage 明细，取最早一条的真实 inputTokens */
  function fetchFirstRequest() {
    var f = firstMessage();
    if (!f || !f.at || !state.convId) {
      state.usage = null;
      return;
    }
    var since = new Date(f.at.getTime() - 60000);
    var until = new Date(f.at.getTime() + 900000);
    safeGet("usage", { since: fmtDbTime(since), until: fmtDbTime(until), limit: 100 }).then(function (u) {
      if (destroyed) return;
      state.usage = u;
      state.dirty = true;
      if (isPopOpen()) render();
    });
  }

  /** 组装估算分解 */
  function buildBreakdown() {
    var snap = contextSnapshot();
    var chatInput = state.runtime && state.runtime.chatInput;
    var maxCtx = num(chatInput && chatInput.maxContextTokens);
    var realTotal = snap ? snap.total : 0;
    var parts = [];

    /* 系统提示词：ROLE.md + 激活的系统提示词 */
    var sysText = "";
    if (state.personalization && state.personalization.content) sysText += state.personalization.content;
    var sp = state.systemPrompts;
    if (Array.isArray(sp)) {
      for (var i = 0; i < sp.length; i++) {
        if (sp[i] && sp[i].isActive && sp[i].content) sysText += "\n" + sp[i].content;
      }
    }
    parts.push({
      key: "systemPrompt",
      label: "系统提示词",
      color: "#3b82f6",
      tokens: estimateTokens(sysText),
      hint: "ROLE.md 与已激活的系统提示词文本",
    });

    /* 技能清单 */
    var skillText = "";
    var skillCount = 0;
    var skills = state.skills && state.skills.available;
    if (Array.isArray(skills)) {
      for (var s = 0; s < skills.length; s++) {
        var sk = skills[s];
        if (!sk) continue;
        skillCount++;
        skillText += (sk.name || "") + "\n" + (sk.description || "") + "\n";
        if (Array.isArray(sk.allowedTools)) skillText += sk.allowedTools.join(" ") + "\n";
      }
    }
    parts.push({
      key: "skills",
      label: "技能清单",
      color: "#a855f7",
      tokens: estimateTokens(skillText),
      count: skillCount,
      hint: "可用技能的 name / description / allowedTools",
    });

    /* MCP 工具定义 */
    var mcpText = "";
    var mcpCount = 0;
    var mcp = state.mcp;
    if (mcp && Array.isArray(mcp.tools)) {
      for (var t = 0; t < mcp.tools.length; t++) {
        var tool = mcp.tools[t];
        if (!tool) continue;
        mcpCount++;
        mcpText += (tool.name || "") + "\n" + (tool.description || "") + "\n" + (tool.inputSchemaJson || "") + "\n";
      }
    }
    if (mcp && Array.isArray(mcp.projectServersWithTools)) {
      for (var p = 0; p < mcp.projectServersWithTools.length; p++) {
        var server = mcp.projectServersWithTools[p];
        if (!server || !Array.isArray(server.tools)) continue;
        for (var q = 0; q < server.tools.length; q++) {
          var pt = server.tools[q];
          if (!pt) continue;
          mcpCount++;
          mcpText += (pt.name || "") + "\n" + (pt.description || "") + "\n" + (pt.inputSchemaJson || "") + "\n";
        }
      }
    }
    parts.push({
      key: "mcpTools",
      label: "MCP 工具",
      color: "#f59e0b",
      tokens: estimateTokens(mcpText),
      count: mcpCount,
      hint: "MCP 工具的 name / description / inputSchema",
    });

    /* 消息 */
    var msgText = "";
    var msgCount = 0;
    var items = state.messages && state.messages.items;
    if (Array.isArray(items)) {
      for (var m = 0; m < items.length; m++) {
        var it = items[m];
        if (!it) continue;
        msgCount++;
        msgText += (it.content || "") + "\n";
        if (it.toolCallsJson) msgText += it.toolCallsJson + "\n";
      }
    }
    parts.push({
      key: "messages",
      label: "消息",
      color: "#14b8a6",
      tokens: estimateTokens(msgText),
      count: msgCount,
      hint: "会话消息正文与工具调用参数",
    });

    /* ---------- 真实基线：首轮请求 input 减去首条消息 ---------- */
    var firstInput = firstRequestInput();
    var mode = "estimate";
    var baseline = 0;
    var other = 0;
    state.normalized = false;

    if (firstInput > 0 && realTotal > 0) {
      mode = "real";
      baseline = Math.max(firstInput - firstMessageTokens(), 0);
      var usable = Math.min(baseline, realTotal);
      if (baseline > realTotal) state.normalized = true;

      /* 基线内只有这三类是估算，按文本比例分摊；余量是真实的内置工具 / 框架开销 */
      var wSys = parts[0].tokens;
      var wSkills = parts[1].tokens;
      var wMcp = parts[2].tokens;
      var wSum = wSys + wSkills + wMcp;
      var builtin = 0;
      if (wSum > 0) {
        if (wSum <= usable) {
          builtin = usable - wSum;
        } else {
          var k2 = usable / wSum;
          parts[0].tokens = wSys * k2;
          parts[1].tokens = wSkills * k2;
          parts[2].tokens = wMcp * k2;
        }
      } else {
        builtin = usable;
      }
      parts[0].estimated = true;
      parts[1].estimated = true;
      parts[2].estimated = true;

      /* 消息量 = 当前上下文 - 真实基线 */
      parts[3].tokens = Math.max(realTotal - usable, 0);
      parts[3].estimated = false;

      parts.splice(3, 0, {
        key: "builtin",
        label: "内置工具与框架",
        color: "#6b7280",
        muted: true,
        estimated: false,
        tokens: builtin,
        hint: "首轮请求 input 减去系统提示词 / 技能 / MCP 工具估算后的真实余量：内置工具定义、指令与框架文本",
      });
    } else {
      /* 退化：没有首轮记录时全部按文本估算，按固定项 / 消息归一 */
      var fixedSum = 0;
      var msgTokens = 0;
      var msgIndex = -1;
      for (var k = 0; k < parts.length; k++) {
        if (parts[k].key === "messages") {
          msgIndex = k;
          msgTokens = parts[k].tokens;
        } else {
          fixedSum += parts[k].tokens;
        }
      }
      var estSum = fixedSum + msgTokens;
      if (realTotal > 0) {
        if (estSum > realTotal) {
          state.normalized = true;
          if (fixedSum >= realTotal && fixedSum > 0) {
            var ratio = realTotal / fixedSum;
            for (var r1 = 0; r1 < parts.length; r1++) {
              if (parts[r1].key !== "messages") parts[r1].tokens = parts[r1].tokens * ratio;
            }
            if (msgIndex >= 0) parts[msgIndex].tokens = 0;
          } else if (msgIndex >= 0) {
            parts[msgIndex].tokens = realTotal - fixedSum;
          }
          estSum = realTotal;
        } else {
          other = realTotal - estSum;
        }
      }
      for (var e = 0; e < parts.length; e++) parts[e].estimated = true;
    }

    var free = maxCtx > 0 ? Math.max(maxCtx - realTotal, 0) : 0;
    var denom = maxCtx > 0 ? maxCtx : realTotal;

    return {
      realTotal: realTotal,
      max: maxCtx,
      free: free,
      denom: denom,
      other: other,
      parts: parts,
      normalized: state.normalized,
      snap: snap,
      mode: mode,
      baseline: baseline,
      firstInput: firstInput,
    };
  }

  /* ===================== 视图 ===================== */

  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function buildPop() {
    var pop = el("div", "scb-pop");
    pop.setAttribute("data-scb-pop", "1");
    pop.addEventListener("click", function (e) {
      e.stopPropagation();
    });
    return pop;
  }

  function pctOf(value, denom) {
    if (!denom || denom <= 0) return "—";
    var pct = (value / denom) * 100;
    if (pct > 0 && pct < 0.1) return "<0.1%";
    return pct.toFixed(1) + "%";
  }

  function renderBar(host, data) {
    var bar = el("div", "scb-bar");
    if (!data.denom || data.denom <= 0) {
      host.appendChild(bar);
      return;
    }
    var segs = data.parts.slice();
    if (data.other > 0) segs.push({ tokens: data.other, color: "#6b7280" });
    var used = 0;
    for (var i = 0; i < segs.length; i++) {
      var w = (segs[i].tokens / data.denom) * 100;
      if (w <= 0) continue;
      used += w;
      var piece = el("i", "scb-bar-seg");
      piece.style.width = Math.min(w, 100) + "%";
      piece.style.background = segs[i].color;
      bar.appendChild(piece);
    }
    if (used < 100) {
      var rest = el("i", "scb-bar-seg scb-bar-rest");
      rest.style.width = Math.max(100 - used, 0) + "%";
      bar.appendChild(rest);
    }
    host.appendChild(bar);
  }

  function renderRow(host, row) {
    var line = el("div", "scb-row");
    line.setAttribute("title", row.hint || "");
    var dot = el("span", "scb-dot");
    dot.style.background = row.color;
    if (row.muted) dot.classList.add("scb-dot-muted");
    line.appendChild(dot);

    var label = el("span", "scb-row-label");
    label.textContent = row.label;
    if (row.count > 0) {
      var cnt = el("span", "scb-row-count", " · " + row.count);
      label.appendChild(cnt);
    }
    line.appendChild(label);

    line.appendChild(el("span", "scb-row-token", (row.estimated ? "≈" : "") + fmtTokens(row.tokens)));
    line.appendChild(el("span", "scb-row-pct", pctOf(row.tokens, row.denom)));
    host.appendChild(line);
  }

  /** 把宿主原生 tooltip 的行合并进面板（两列），视觉上只有一块浮层 */
  function renderNativeRows(host) {
    var rows = state.nativeRows;
    if (!rows || !rows.length) return;
    var box = el("div", "scb-native");
    for (var i = 0; i < rows.length; i += 2) {
      var line = el("div", "scb-native-row");
      for (var j = i; j < Math.min(i + 2, rows.length); j++) {
        var cell = el("span", "scb-native-cell");
        var dot = el("span", "scb-native-dot");
        if (rows[j].color && rows[j].color !== "rgba(0, 0, 0, 0)") dot.style.background = rows[j].color;
        else dot.style.visibility = "hidden";
        cell.appendChild(dot);
        cell.appendChild(el("span", "scb-native-label", rows[j].label));
        cell.appendChild(el("span", "scb-native-value", rows[j].value));
        line.appendChild(cell);
      }
      box.appendChild(line);
    }
    host.appendChild(box);
  }

  function render(force) {
    var pop = mountedPop;
    if (!pop) return;
    state.dirty = false;

    var data = buildBreakdown();
    var snap = data.snap;
    var usedPct = data.max > 0 && snap ? Math.min((data.realTotal / data.max) * 100, 100) : 0;

    pop.textContent = "";
    pop.classList.toggle("is-collapsed", state.collapsed);

    /* 头部 */
    var head = el("div", "scb-head");
    head.appendChild(el("span", "scb-title", "上下文"));
    head.appendChild(el("span", "scb-chev"));
    head.addEventListener("click", function () {
      state.collapsed = !state.collapsed;
      gmSet(COLLAPSE_KEY, state.collapsed);
      render(true);
    });
    pop.appendChild(head);

    /* 主行：已使用 / 总量 */
    var main = el("div", "scb-main");
    var left = el("span", "scb-used");
    left.textContent = snap ? "已使用 " + Math.round(usedPct) + "%" : "暂无上下文数据";
    main.appendChild(left);
    var right = el("span", "scb-ctx");
    right.textContent = snap
      ? fmtTokens(data.realTotal) + (data.max > 0 ? " / " + fmtLimit(data.max) : "")
      : data.max > 0
        ? "0 / " + fmtLimit(data.max)
        : "—";
    main.appendChild(right);
    pop.appendChild(main);

    if (!snap) {
      pop.appendChild(el("div", "scb-empty", "当前会话还没有 token 记录，宿主也不会渲染上下文圆环。"));
      return;
    }

    renderBar(pop, data);

    if (state.collapsed) return;

    var rows = data.parts
      .filter(function (p) {
        return p.tokens > 0;
      })
      .sort(function (a, b) {
        return b.tokens - a.tokens;
      });

    for (var i = 0; i < rows.length; i++) {
      rows[i].denom = data.denom;
      renderRow(pop, rows[i]);
    }

    if (data.other > 0) {
      renderRow(pop, {
        label: "未归类（内置工具 / 框架文本）",
        color: "#6b7280",
        muted: true,
        tokens: data.other,
        denom: data.denom,
        hint: "宿主真实总量减去各分类估算值后的剩余，主要是内置工具定义与框架文本",
      });
    }

    if (data.free > 0) {
      renderRow(pop, {
        label: "可用空间",
        color: "#3f3f46",
        muted: true,
        tokens: data.free,
        denom: data.denom,
        hint: "上下文上限减去已使用",
      });
    }

    renderNativeRows(pop);

    var note;
    if (data.mode === "real") {
      note = "实测 · ≈ 为文本分摊（首轮 " + fmtTokens(data.firstInput) + " input）";
    } else {
      note = "未取到首轮请求记录，分类为估算" + (state.denied.usage ? "（usage 未授权）" : "");
    }
    if (data.normalized) note += " · 已按总量裁剪";
    pop.appendChild(el("div", "scb-note", note));

    if (state.denied.messages) {
      pop.appendChild(el("div", "scb-warn", "消息域未授权，消息分类按 0 计（其余分类不受影响）。"));
    }
  }

  /* ===================== 挂载 ===================== */

  function isPopOpen() {
    return !!(mountedPop && mountedPop.classList.contains("is-open"));
  }

  function findRing() {
    var input = document.querySelector('[data-snow-anchor="chat.input"]');
    var scope = input || document;
    var ring = scope.querySelector(".token-usage-ring-wrapper");
    if (!ring) {
      var svg = scope.querySelector("svg.token-usage-ring");
      ring = svg && svg.parentElement ? svg.parentElement : null;
    }
    return ring;
  }

  function ensureMounted() {
    if (destroyed) return;
    var ring = findRing();
    if (!ring) {
      mountedRing = null;
      mountedPop = null;
      return;
    }
    if (mountedRing !== ring) {
      mountedRing = ring;
      mountedPop = null;
    }
    if (mountedPop && mountedPop.parentNode === ring) return;
    var existing = ring.querySelector(".scb-pop");
    if (existing && existing !== mountedPop) existing.parentNode.removeChild(existing);
    mountedPop = buildPop();
    ring.appendChild(mountedPop);
    render(true);
  }

  function showPop() {
    if (hideTimer) {
      clearTimeout(hideTimer);
      hideTimer = null;
    }
    if (!mountedPop) return;
    if (state.dirty || !mountedPop.querySelector(".scb-main")) render(true);
    mountedPop.classList.add("is-open");
    lastTooltipHeight = -1;
    positionPop();
    refreshNative();
    /* 宿主原生 tooltip 由 React 在 hover 后才渲染：出现后把它的行合并进来 */
    setTimeout(function () {
      if (!isPopOpen()) return;
      refreshNative();
      positionPop();
    }, 60);
    setTimeout(function () {
      if (!isPopOpen()) return;
      refreshNative();
      positionPop();
    }, 220);
    refreshHeavy(false);
  }

  function hostTooltip() {
    return mountedRing ? mountedRing.querySelector(".token-usage-tooltip") : null;
  }

  /** 读取宿主原生 tooltip 的行（label / value / 圆点颜色），供面板内合并展示 */
  function readHostRows() {
    var tt = hostTooltip();
    if (!tt) return [];
    var rows = tt.querySelectorAll(".token-usage-tooltip-row");
    var out = [];
    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      var label = row.querySelector(".token-usage-label");
      var value = row.querySelector(".token-usage-value");
      var dot = row.querySelector(".token-usage-dot");
      if (!label || !value) continue;
      out.push({
        label: (label.textContent || "").trim(),
        value: (value.textContent || "").trim(),
        color: dot ? getComputedStyle(dot).backgroundColor : "",
      });
    }
    return out;
  }

  /** 宿主 tooltip 是 hover 后才渲染的，读取到新内容时重绘一次 */
  function refreshNative() {
    var rows = readHostRows();
    var sig = rows
      .map(function (r) {
        return r.label + "=" + r.value;
      })
      .join("|");
    if (sig === state.nativeSig) return;
    state.nativeSig = sig;
    state.nativeRows = rows;
    /* 只有真的把原生行读进面板了，才隐藏宿主 tooltip；读不到就让它自己显示，信息不丢 */
    if (mountedRing) {
      if (rows.length) mountedRing.setAttribute("data-scb-native", "1");
      else mountedRing.removeAttribute("data-scb-native");
    }
    if (isPopOpen()) render(true);
  }

  /**
   * 增强而非覆盖：宿主原生 tooltip（input / output / 缓存 / 合计 / 上下文）保持原样，
   * 本浮层叠在它上方；上方空间不足时改贴圆环左侧。
   */
  function positionPop() {
    if (!mountedPop || !mountedRing) return;
    var vw = document.documentElement.clientWidth || window.innerWidth || 0;
    var tt = hostTooltip();
    var ttH = tt ? tt.offsetHeight || 0 : 0;
    lastTooltipHeight = ttH;

    mountedPop.style.top = "auto";
    mountedPop.style.left = "auto";
    mountedPop.style.bottom = "calc(100% + " + (8 + (ttH > 0 ? ttH + 8 : 0)) + "px)";
    mountedPop.style.right = "-4px";

    var rect = mountedRing.getBoundingClientRect();
    if (vw) {
      var popW = mountedPop.offsetWidth || 258;
      var right = rect.right + 4;
      var minRight = popW + 8;
      var maxRight = vw - 8;
      if (right < minRight) right = minRight;
      if (right > maxRight) right = maxRight;
      if (right < minRight) right = minRight;
      mountedPop.style.right = rect.right - right + "px";
    }

    var box = mountedPop.getBoundingClientRect();

    /* 上方放不下（窗口很矮）→ 贴到圆环左侧 */
    if (box.top < 8) {
      mountedPop.style.bottom = "0px";
      mountedPop.style.right = "calc(100% + 10px)";
      box = mountedPop.getBoundingClientRect();
    }

    /* 左侧也放不下（输入区贴左边）→ 改到圆环下方 */
    if (box.left < 8) {
      mountedPop.style.bottom = "auto";
      mountedPop.style.right = "auto";
      mountedPop.style.top = "calc(100% + 8px)";
      var popW2 = mountedPop.offsetWidth || 258;
      var left = rect.right + 4 - popW2;
      var minLeft = 8;
      var maxLeft = vw ? vw - 8 - popW2 : left;
      if (left < minLeft) left = minLeft;
      if (left > maxLeft) left = maxLeft;
      mountedPop.style.left = left - rect.left + "px";
    }
  }

  /** 宿主 tooltip 出现 / 消失时高度变化，重新让位（宿主 hover 才渲染，靠这个兜住时序） */
  function repositionIfNeeded() {
    if (!isPopOpen() || !mountedPop) return;
    var now = Date.now();
    if (now - lastPosCheck < 100) return;
    lastPosCheck = now;
    var tt = hostTooltip();
    var h = tt ? tt.offsetHeight || 0 : 0;
    if (h === lastTooltipHeight) return;
    lastTooltipHeight = h;
    var gap = 8 + (h > 0 ? h + 8 : 0);
    mountedPop.style.bottom = "calc(100% + " + gap + "px)";
  }

  function hidePop() {
    if (!mountedPop) return;
    mountedPop.classList.remove("is-open");
  }

  function scheduleHide() {
    if (hideTimer) clearTimeout(hideTimer);
    hideTimer = setTimeout(function () {
      hideTimer = null;
      hidePop();
    }, 180);
  }

  function isRingTarget(node) {
    return !!(node && node.closest && node.closest('[data-snow-anchor="chat.input"] .token-usage-ring-wrapper'));
  }

  function onPointerOver(e) {
    if (isRingTarget(e.target)) showPop();
  }

  function onPointerOut(e) {
    if (!isRingTarget(e.target)) return;
    var to = e.relatedTarget;
    if (to && to.nodeType === 1 && mountedRing && mountedRing.contains(to)) return;
    scheduleHide();
  }

  function scheduleEnsure() {
    if (rafId) return;
    rafId = requestAnimationFrame(function () {
      rafId = 0;
      ensureMounted();
    });
  }

  /* ===================== 订阅 ===================== */

  function applyRuntime(next) {
    if (!next || !next.domains) return;
    var rt = next.domains.runtime;
    if (!rt) return;
    state.runtime = rt;
    state.dirty = true;
    if (isPopOpen()) render();
  }

  function subscribeRuntime() {
    if (!window.snow || !window.snow.metadata) return;
    try {
      var s1 = snow.metadata.subscribe("runtime", applyRuntime, {});
      if (s1 && typeof s1.then === "function") s1.then(function (x) { subs.push(x); });
      else if (s1) subs.push(s1);
    } catch (e) {
      /* 忽略 */
    }
    /* 首帧兜底 */
    Promise.resolve()
      .then(function () { return snow.metadata.get("runtime", { params: {} }); })
      .then(function (r) {
        if (destroyed) return;
        var rt = r && r.domains && r.domains.runtime;
        if (rt && !state.runtime) {
          state.runtime = rt;
          state.dirty = true;
          if (isPopOpen()) render();
        }
      })
      .catch(function () { /* 忽略 */ });
  }

  function syncContext() {
    try {
      var ctx = (window.snow && window.snow.context) || {};
      state.convId = ctx.conversationId || "";
      if (ctx.locale) state.locale = ctx.locale;
      if (ctx.projectId) state.projectId = ctx.projectId;
    } catch (e) {
      /* 忽略 */
    }
  }

  /* ===================== 样式 ===================== */

  function injectStyle() {
    var css = [
      /* 原生行已并入面板时才隐藏宿主 tooltip（避免两块浮层；宿主结构变动时自动退回） */
      '[data-snow-anchor="chat.input"] .token-usage-ring-wrapper[data-scb-native="1"] .token-usage-tooltip{display:none !important;}',
      ".scb-pop{position:absolute;right:-4px;bottom:calc(100% + 8px);z-index:130;display:none;width:268px;max-width:calc(100vw - 32px);box-sizing:border-box;padding:10px 12px 11px;border:1px solid var(--border-light);border-radius:var(--radius-lg);background:var(--bg-secondary);box-shadow:var(--island-shadow);font-size:11px;line-height:1.5;color:var(--text-secondary);text-align:left;cursor:default;}",
      ".scb-pop.is-open{display:block;animation:scb-in .14s ease-out;}",
      "@keyframes scb-in{from{opacity:0;transform:translateY(3px);}to{opacity:1;transform:translateY(0);}}",
      ".scb-head{display:flex;align-items:center;justify-content:space-between;gap:6px;cursor:pointer;user-select:none;}",
      ".scb-title{font-size:11px;font-weight:600;color:var(--text-primary);}",
      ".scb-chev{width:0;height:0;border-left:4px solid transparent;border-right:4px solid transparent;border-top:5px solid var(--text-tertiary);transition:transform .15s ease;}",
      ".scb-pop.is-collapsed .scb-chev{transform:rotate(-90deg);}",
      ".scb-main{display:flex;align-items:baseline;justify-content:space-between;gap:8px;margin-top:5px;}",
      ".scb-used{font-size:12px;font-weight:600;color:var(--text-primary);font-variant-numeric:tabular-nums;white-space:nowrap;}",
      ".scb-ctx{font-size:10px;color:var(--text-tertiary);font-variant-numeric:tabular-nums;white-space:nowrap;}",
      ".scb-bar{display:flex;gap:1px;height:4px;margin:7px 0 8px;border-radius:2px;overflow:hidden;background:var(--border-light);}",
      ".scb-bar-seg{display:block;height:100%;flex:0 0 auto;}",
      ".scb-bar-rest{background:var(--border-light);}",
      ".scb-row{display:flex;align-items:center;gap:6px;min-width:0;padding:1px 0;}",
      ".scb-dot{width:7px;height:7px;border-radius:50%;flex:0 0 auto;}",
      ".scb-dot-muted{opacity:.55;}",
      ".scb-row-label{flex:1 1 auto;min-width:0;color:var(--text-tertiary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}",
      ".scb-row-count{color:var(--text-tertiary);opacity:.7;font-variant-numeric:tabular-nums;}",
      ".scb-row-token{flex:0 0 auto;color:var(--text-secondary);font-variant-numeric:tabular-nums;min-width:44px;text-align:right;}",
      ".scb-row-pct{flex:0 0 auto;color:var(--text-primary);font-weight:500;font-variant-numeric:tabular-nums;min-width:42px;text-align:right;}",
      ".scb-divider{height:1px;margin:7px 0 6px;background:var(--border-light);}",
      ".scb-native{display:flex;flex-direction:column;gap:2px;margin-top:8px;padding-top:7px;border-top:1px solid var(--border-light);}",
      ".scb-native-row{display:flex;gap:10px;}",
      ".scb-native-cell{display:flex;align-items:center;gap:5px;flex:1 1 0;min-width:0;}",
      ".scb-native-dot{width:6px;height:6px;border-radius:50%;flex:0 0 auto;background:var(--text-tertiary);}",
      ".scb-native-label{flex:1 1 auto;min-width:0;color:var(--text-tertiary);font-size:10px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}",
      ".scb-native-value{flex:0 0 auto;color:var(--text-secondary);font-size:10px;font-variant-numeric:tabular-nums;}",
      ".scb-note{font-size:10px;line-height:1.45;color:var(--text-tertiary);margin-top:6px;}",
      ".scb-warn{margin-top:5px;font-size:10px;line-height:1.45;color:var(--text-tertiary);}",
      ".scb-empty{margin-top:6px;font-size:10px;line-height:1.45;color:var(--text-tertiary);}",
    ].join("\n");
    try {
      if (typeof GM_addStyle === "function") GM_addStyle(css);
      else {
        var tag = document.createElement("style");
        tag.textContent = css;
        document.head.appendChild(tag);
      }
    } catch (e) {
      /* 忽略 */
    }
  }

  /* ===================== 启动 ===================== */

  function boot() {
    injectStyle();
    syncContext();
    subscribeRuntime();
    refreshHeavy(true);
    ensureMounted();

    if (observer) observer.disconnect();
    observer = new MutationObserver(function () {
      if (destroyed) return;
      var ring = findRing();
      if (!ring) {
        mountedPop = null;
        mountedRing = null;
        return;
      }
      if (!mountedPop || mountedPop.parentNode !== ring) scheduleEnsure();
      else repositionIfNeeded();
    });
    observer.observe(document.body, { childList: true, subtree: true });

    heavyTimer = setInterval(function () {
      if (destroyed) return;
      refreshHeavy(false);
    }, HEAVY_MS);

    document.addEventListener("mouseover", onPointerOver, true);
    document.addEventListener("mouseout", onPointerOut, true);

    try {
      if (window.snow && typeof snow.on === "function") {
        snow.on("conversation-change", function () {
          syncContext();
          state.dirty = true;
          if (isPopOpen()) render();
          scheduleEnsure();
          refreshHeavy(true);
        });
        snow.on("stream-end", function () {
          refreshHeavy(true);
        });
      }
    } catch (e) {
      /* 忽略 */
    }

    try {
      if (typeof GM_registerMenuCommand === "function") {
        GM_registerMenuCommand("重新估算上下文分解", function () {
          refreshHeavy(true);
          render(true);
        });
      }
    } catch (e) {
      /* 忽略 */
    }

    if (window.snow && typeof snow.onCleanup === "function") {
      snow.onCleanup(function () {
        destroyed = true;
        document.removeEventListener("mouseover", onPointerOver, true);
        document.removeEventListener("mouseout", onPointerOut, true);
        if (observer) observer.disconnect();
        observer = null;
        if (rafId) cancelAnimationFrame(rafId);
        if (hideTimer) clearTimeout(hideTimer);
        if (heavyTimer) clearInterval(heavyTimer);
        for (var i = 0; i < subs.length; i++) {
          try {
            if (subs[i] && typeof subs[i].unsubscribe === "function") subs[i].unsubscribe();
          } catch (e) {
            /* 忽略 */
          }
        }
        subs = [];
        if (mountedRing) mountedRing.removeAttribute("data-scb-native");
        if (mountedPop && mountedPop.parentNode) mountedPop.parentNode.removeChild(mountedPop);
        mountedPop = null;
        mountedRing = null;
      });
    }
  }

  if (document.body) boot();
  else document.addEventListener("DOMContentLoaded", boot, { once: true });
})();
