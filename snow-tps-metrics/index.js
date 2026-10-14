// 任务中心（Mission Control）/ TPS / TTFT 指标面板
// 数据源：
//   runtime 域（免声明，live 推送）：
//     conversation.streamTokenCount / streamStartedAt / streamTtftMs / runTtftMs
//       —— 焦点会话当前 run 的实时流式指标
//     conversation.attentionRequiredConversationIds
//       —— 需要用户关注的会话 id 数组，对应总览表中红色描边行
//     conversation.subAgentSessions
//       —— 焦点会话的子代理会话列表，非空时单列一节
//     streamingSessions[]
//       —— 全部运行中会话（含子代理）：sessionKey / conversationId / title /
//          isStreaming / isPaused / isAborting / tokenCount / elapsedMs /
//          ttftMs / runTtftMs / startedAt
//   conversations 域（敏感域，已在 plugin.json 声明）：
//     会话累计 outputTokens / totalDurationMs / runTtftSumMs / runRequestCount
//     会话记录的 model / apiProfileName —— 总览表“模型”列与标题行当前模型的数据源；
//       域按激活项目拉取，其他项目的运行中会话查不到模型，显示“—”
// 口径约定：
//   TTFT      = run 开始到首个 token 的耗时
//   解码 TPS  = tokenCount / (elapsedMs - TTFT)，行业基准惯例（如 vLLM benchmark_serving）
//               剔除首 token 延迟；总览表与当前会话实时区共用 decodeTps()
//   瞬时 TPS  = 3s 滚动窗口内 Δtoken / Δt；采样按 sessionKey 存于 samplesRef，
//               覆盖全部 isStreaming 会话（不只焦点会话），非流式会话的旧采样自动清理
//   原始口径  = tokenCount / elapsedMs（含 TTFT，与应用内置显示一致）
//   运行时长  = Date.now() - startedAt，每秒实时跳动；缺 startedAt 时退回 elapsedMs
//   会话均值  = 累计 outputTokens / 对应时长；分母含 run 内工具执行等非流式间隙
//               （数据源未拆分），穿插工具调用时该值偏低

const host = window.SnowAppPlugin;
const React = host.React;
const Icons = host.icons || {};
const { useState, useEffect, useRef } = React;

const SAMPLE_WINDOW_MS = 3000;
const CONV_POLL_MS = 2000;
const TICK_MS = 1000;

function fmtMs(v) {
  if (!Number.isFinite(v) || v < 0) return "—";
  return v >= 10000 ? (v / 1000).toFixed(1) + " s" : Math.round(v) + " ms";
}

function fmtTps(v) {
  return Number.isFinite(v) && v > 0 ? v.toFixed(1) + " tok/s" : "—";
}

function fmtTokens(n) {
  if (!Number.isFinite(n) || n <= 0) return "0";
  if (n >= 1000000) return (n / 1000000).toFixed(1) + "M";
  if (n >= 1000) return (n / 1000).toFixed(1) + "k";
  return String(n);
}

function fmtDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const total = Math.floor(ms / 1000);
  if (total < 60) return total + " s";
  const m = Math.floor(total / 60);
  if (m < 60) return m + " m " + (total % 60) + " s";
  return Math.floor(m / 60) + " h " + (m % 60) + " m";
}

function decodeTps(tokens, elapsedMs, ttftMs) {
  if (!Number.isFinite(tokens) || tokens <= 0) return null;
  if (!Number.isFinite(elapsedMs) || !Number.isFinite(ttftMs)) return null;
  const decodeMs = elapsedMs - ttftMs;
  if (decodeMs <= 0) return null;
  return (tokens / decodeMs) * 1000;
}

function sessionStatus(s) {
  if (!s) return { label: "—", cls: "apx-mc-badge apx-mc-b-gray" };
  if (s.isAborting) return { label: "aborting", cls: "apx-mc-badge apx-mc-b-red" };
  if (s.isPaused) return { label: "paused", cls: "apx-mc-badge apx-mc-b-orange" };
  if (s.isStreaming) return { label: "streaming", cls: "apx-mc-badge apx-mc-b-green" };
  return { label: "空闲", cls: "apx-mc-badge apx-mc-b-gray" };
}

function sessionAverages(item) {
  if (!item) return null;
  const out = item.outputTokens;
  const total = item.totalDurationMs;
  const ttftSum = item.runTtftSumMs;
  const requests = item.runRequestCount || 0;
  const decodeTotal =
    Number.isFinite(total) && Number.isFinite(ttftSum) ? total - ttftSum : null;
  return {
    avgDecode: out > 0 && decodeTotal > 0 ? (out / decodeTotal) * 1000 : null,
    avgAll: out > 0 && total > 0 ? (out / total) * 1000 : null,
    avgTtft: requests > 0 && Number.isFinite(ttftSum) ? ttftSum / requests : null,
    requests: requests,
  };
}

function Row(label, value, valueTitle) {
  return React.createElement(
    "div",
    {
      key: label,
      style: { display: "flex", justifyContent: "space-between", gap: 12 },
    },
    React.createElement(
      "span",
      { style: { opacity: 0.65, flexShrink: 0 } },
      label,
    ),
    React.createElement(
      "span",
      {
        style: { fontFamily: "ui-monospace, monospace", textAlign: "right" },
        title: valueTitle || undefined,
      },
      value,
    ),
  );
}

function SectionTitle(text) {
  return React.createElement(
    "div",
    {
      key: text,
      style: { marginTop: 10, marginBottom: 2, fontWeight: 600, fontSize: 12 },
    },
    text,
  );
}

export default function Panel({ api }) {
  const [rt, setRt] = useState(null);
  const [conv, setConv] = useState(null);
  const [inst, setInst] = useState({});
  const [, setTick] = useState(0);
  const rtRef = useRef(null);
  const samplesRef = useRef(new Map());

  useEffect(() => {
    let sub = null;
    let disposed = false;
    api.metadata
      .subscribe(
        "runtime",
        (next) => {
          const r = next.domains.runtime;
          if (!r) return;
          rtRef.current = r;
          setRt(r);

          const now = Date.now();
          const nextInst = {};
          const sessions = r.streamingSessions || [];
          for (const s of sessions) {
            if (!s.isStreaming) continue;
            const arr = (samplesRef.current.get(s.sessionKey) || []).filter(
              (p) => now - p.t <= SAMPLE_WINDOW_MS,
            );
            arr.push({ t: now, tokens: s.tokenCount || 0 });
            samplesRef.current.set(s.sessionKey, arr);
            const first = arr[0];
            const last = arr[arr.length - 1];
            const dt = last.t - first.t;
            nextInst[s.sessionKey] =
              dt >= 500 ? ((last.tokens - first.tokens) / dt) * 1000 : null;
          }
          const activeKeys = new Set(
            sessions.filter((s) => s.isStreaming).map((s) => s.sessionKey),
          );
          for (const key of Array.from(samplesRef.current.keys())) {
            if (!activeKeys.has(key)) samplesRef.current.delete(key);
          }
          setInst(nextInst);
        },
        {},
      )
      .then((s) => {
        if (disposed) s.unsubscribe();
        else sub = s;
      });
    return () => {
      disposed = true;
      if (sub) sub.unsubscribe();
    };
  }, []);

  useEffect(() => {
    let stopped = false;
    let timer = null;
    const pull = async () => {
      try {
        const dirId =
          rtRef.current && rtRef.current.activeDirectory
            ? rtRef.current.activeDirectory.directoryId
            : null;
        const resp = await api.metadata.get(
          ["conversations"],
          dirId ? { params: { directoryId: dirId } } : {},
        );
        if (!stopped) setConv(resp.domains.conversations || null);
      } catch (e) {
        if (!stopped) setConv(null);
      }
      if (!stopped) timer = setTimeout(pull, CONV_POLL_MS);
    };
    pull();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, []);

  // 每秒触发一次重渲染，让总览表的运行时长实时跳动
  useEffect(() => {
    const timer = setInterval(() => setTick((x) => x + 1), TICK_MS);
    return () => clearInterval(timer);
  }, []);

  const c = rt && rt.conversation ? rt.conversation : null;
  const convItems = conv && Array.isArray(conv.items) ? conv.items : [];
  const convItem =
    c && conv
      ? convItems.find((x) => x.conversationId === c.conversationId)
      : null;
  const averages = sessionAverages(convItem);

  // conversationId → 会话记录（model / apiProfileName），供总览表模型列查询
  const convById = new Map();
  for (const it of convItems) {
    if (it && it.conversationId) convById.set(it.conversationId, it);
  }
  const currentModel = convItem && convItem.model ? convItem.model : null;
  const currentProfile =
    convItem && convItem.apiProfileName ? convItem.apiProfileName : null;

  const liveElapsed = c
    ? Number.isFinite(c.streamElapsedMs)
      ? c.streamElapsedMs
      : c.streamStartedAt
        ? Date.now() - c.streamStartedAt
        : null
    : null;
  const liveTtft = c ? (c.runTtftMs ?? c.streamTtftMs ?? null) : null;
  const liveTokens = c ? c.streamTokenCount || 0 : 0;
  const liveDecode = decodeTps(liveTokens, liveElapsed, liveTtft);
  const liveRaw =
    liveTokens > 0 && Number.isFinite(liveElapsed) && liveElapsed > 0
      ? (liveTokens / liveElapsed) * 1000
      : null;

  const sessions = (rt && rt.streamingSessions) || [];
  const attentionIds = new Set(
    (c && Array.isArray(c.attentionRequiredConversationIds)
      ? c.attentionRequiredConversationIds
      : []),
  );
  const subAgents = c && Array.isArray(c.subAgentSessions) ? c.subAgentSessions : [];

  const el = React.createElement;

  const overviewRows = sessions.map((s) => {
    const ttft = s.ttftMs ?? s.runTtftMs ?? null;
    const elapsed = Number.isFinite(s.elapsedMs) ? s.elapsedMs : null;
    const runElapsed =
      s.startedAt != null && Number.isFinite(s.startedAt)
        ? Date.now() - s.startedAt
        : elapsed;
    const status = sessionStatus(s);
    const isCurrent = c && s.conversationId === c.conversationId;
    const needsAttention = attentionIds.has(s.conversationId);
    const convRec = s.conversationId ? convById.get(s.conversationId) : null;
    const rowModel = convRec && convRec.model ? convRec.model : null;
    const rowModelTitle =
      rowModel && convRec && convRec.apiProfileName
        ? rowModel + " @ " + convRec.apiProfileName
        : rowModel || undefined;
    return el(
      "tr",
      {
        key: s.sessionKey,
        className:
          "apx-mc-row" +
          (needsAttention ? " apx-mc-attention" : "") +
          (isCurrent ? " apx-mc-current" : ""),
      },
      el(
        "td",
        { className: "apx-mc-cell apx-mc-titlecell" },
        el(
          "span",
          {
            className: "apx-mc-title",
            title: s.title || s.conversationId || s.sessionKey,
          },
          s.title || s.conversationId || s.sessionKey,
        ),
        isCurrent ? el("span", { className: "apx-mc-tag" }, "当前") : null,
        needsAttention
          ? el("span", { className: "apx-mc-attention-dot", title: "需要关注" })
          : null,
      ),
      el("td", { className: "apx-mc-cell" }, el("span", { className: status.cls }, status.label)),
      el(
        "td",
        { className: "apx-mc-cell" },
        rowModel
          ? el("span", { className: "apx-mc-model", title: rowModelTitle }, rowModel)
          : el("span", { className: "apx-mc-model apx-mc-model-empty", title: "该会话不在当前项目，模型未知" }, "—"),
      ),
      el("td", { className: "apx-mc-cell apx-mc-num" }, fmtTps(decodeTps(s.tokenCount || 0, elapsed, ttft))),
      el("td", { className: "apx-mc-cell apx-mc-num" }, fmtTps(inst[s.sessionKey])),
      el("td", { className: "apx-mc-cell apx-mc-num" }, fmtMs(ttft)),
      el("td", { className: "apx-mc-cell apx-mc-num" }, fmtTokens(s.tokenCount || 0)),
      el("td", { className: "apx-mc-cell apx-mc-num" }, fmtDuration(runElapsed)),
    );
  });

  const overviewTable =
    sessions.length === 0
      ? el("div", { className: "apx-mc-empty" }, "当前没有运行中的会话")
      : el(
          "div",
          { className: "apx-mc-tablewrap" },
          el(
            "table",
            { className: "apx-mc-table" },
            el(
              "thead",
              null,
              el(
                "tr",
                null,
                el("th", { className: "apx-mc-head" }, "会话"),
                el("th", { className: "apx-mc-head" }, "状态"),
                el("th", { className: "apx-mc-head" }, "模型"),
                el("th", { className: "apx-mc-head" }, "解码 TPS"),
                el("th", { className: "apx-mc-head" }, "瞬时 TPS"),
                el("th", { className: "apx-mc-head" }, "TTFT"),
                el("th", { className: "apx-mc-head" }, "token"),
                el("th", { className: "apx-mc-head" }, "时长"),
              ),
            ),
            el("tbody", null, overviewRows),
          ),
        );

  return el(
    "div",
    {
      className: "apx-mc-root",
    },
    el(
      "div",
      { style: { display: "flex", alignItems: "center", gap: 6, fontWeight: 600 } },
      Icons.Activity ? el(Icons.Activity, { size: 14 }) : null,
      "任务中心",
      currentModel
        ? el(
            "span",
            {
              className: "apx-mc-model apx-mc-model-head",
              title: currentProfile ? currentModel + " @ " + currentProfile : currentModel,
            },
            currentModel,
          )
        : null,
      c && c.isStreaming
        ? el(
            "span",
            {
              style: {
                fontSize: 10,
                color: "#22c55e",
                border: "1px solid currentColor",
                borderRadius: 8,
                padding: "0 6px",
              },
            },
            "streaming",
          )
        : null,
    ),

    SectionTitle("运行中会话"),
    overviewTable,
    sessions.length > 0
      ? el(
          "div",
          { className: "apx-mc-hint" },
          "解码 TPS = token / (时长 − TTFT)；瞬时 TPS 为 3s 滚动窗口；时长实时跳动。可横向滚动查看全部列。",
        )
      : null,

    subAgents.length > 0
      ? [
          SectionTitle("子代理"),
          ...subAgents.map((sa, i) =>
            el(
              "div",
              {
                key: (sa && (sa.sessionKey || sa.subAgentId || sa.conversationId)) || "sub-" + i,
                className: "apx-mc-subrow",
              },
              el(
                "span",
                { className: "apx-mc-title", title: sa.title || "子代理" },
                sa.title || "子代理",
              ),
              el("span", { className: sessionStatus(sa).cls }, sessionStatus(sa).label),
            ),
          ),
        ]
      : null,

    SectionTitle("当前会话（实时）"),
    c
      ? [
          Row("会话", c.title || c.conversationId),
          Row(
            "模型",
            currentModel || "未知（conversations 域未返回）",
            currentProfile ? (currentModel || "") + " @ " + currentProfile : undefined,
          ),
          Row(
            "TTFT（首 token 延迟）",
            c.isStreaming && !Number.isFinite(liveTtft)
              ? "等待首 token…"
              : fmtMs(liveTtft),
          ),
          Row("实时 TPS（解码口径）", fmtTps(liveDecode)),
          Row(
            "瞬时 TPS（3s 窗口）",
            c.sessionKey && Number.isFinite(inst[c.sessionKey])
              ? fmtTps(inst[c.sessionKey])
              : "—",
          ),
          Row("原始口径（含 TTFT，与应用一致）", fmtTps(liveRaw)),
          Row("已产出 token", String(liveTokens)),
        ]
      : "未聚焦任何会话",

    SectionTitle("会话累计均值（conversations 域）"),
    averages &&
    (averages.avgDecode != null || averages.avgAll != null || averages.avgTtft != null)
      ? [
          Row(
            "平均 TPS（解码口径）",
            averages.avgDecode != null
              ? fmtTps(averages.avgDecode)
              : "需 totalDurationMs 累计",
          ),
          Row(
            "平均 TPS（含 TTFT 与工具耗时）",
            averages.avgAll != null
              ? fmtTps(averages.avgAll)
              : "需 totalDurationMs 累计",
          ),
          Row(
            "平均 TTFT",
            averages.avgTtft != null ? fmtMs(averages.avgTtft) : "数据源未提供",
          ),
          Row("请求数", String(averages.requests)),
        ]
      : averages && averages.requests > 0
        ? "累计 TPS 不可算：域数据缺累计输出/时长（outputTokens=" +
            (convItem && Number.isFinite(convItem.outputTokens) ? convItem.outputTokens : "无") +
            "，totalDurationMs=" +
            (convItem && Number.isFinite(convItem.totalDurationMs) ? convItem.totalDurationMs : "无") +
            "，runTtftSumMs=" +
            (convItem && Number.isFinite(convItem.runTtftSumMs) ? convItem.runTtftSumMs : "无") +
            "；请求数 " +
            averages.requests +
            "）"
        : "累计数据不足：完成至少一轮对话后再看（分母需要 conversations 域的累计输出、时长与请求数）",

    el(
      "div",
      { className: "apx-mc-footnote" },
      "口径：解码 TPS = token / (时长 − TTFT)，行业基准惯例；会话均值分母来自应用累计时长，包含 run 内工具执行等非流式间隙，穿插工具调用的会话该均值偏低，实际生成速度以实时解码口径为准。部分会话 conversations 域的 totalDurationMs 为 0（应用侧未累计会话总时长），此时 TPS 均值不可算，仅平均 TTFT 可用。",
    ),
  );
}
