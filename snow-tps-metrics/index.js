// 任务中心（Mission Control）面板
// 口径：全部会话汇总，不区分当前聚焦会话。
// 数据源：
//   runtime 域（免声明，live 推送）：
//     streamingSessions[]
//       —— 全部运行中会话（含子代理）：sessionKey / conversationId / title /
//          isStreaming / isPaused / isAborting / tokenCount / elapsedMs /
//          ttftMs / runTtftMs / startedAt
//     conversation.attentionRequiredConversationIds
//       —— 需要用户关注的会话 id 数组，对应会话卡片的红色描边
//     conversation.subAgentSessions
//       —— 以会话 id 为键的对象（Record<conversationId, SubAgentSessionEvent>），非数组
//   conversations 域（敏感域，已在 plugin.json 声明）：
//     全部会话记录的累计字段：outputTokens / totalDurationMs / runTtftSumMs /
//     runRequestCount；以及会话的 model / apiProfileName
//       域按激活项目拉取，其他项目的运行中会话查不到模型，显示“模型未知”
// 口径约定：
//   TTFT      = run 开始到首个 token 的耗时
//   解码 TPS  = tokenCount / (elapsedMs - TTFT)，行业基准惯例（如 vLLM benchmark_serving）
//               剔除首 token 延迟；Hero 合计值与每张会话卡片共用 decodeTps()
//   合计解码  = 全部运行中会话解码 TPS 之和；首 token 尚未到达的会话不计入
//   瞬时 TPS  = 3s 滚动窗口内 Δtoken / Δt，按 sessionKey 采样后求和
//   原始口径  = tokenCount / elapsedMs（含 TTFT，与应用内置显示一致）
//   运行时长  = Date.now() - startedAt，每秒实时跳动；缺 startedAt 时退回 elapsedMs
//   总体均值  = Σ累计输出 / (Σ累计时长 − Σ累计 TTFT)，分母含 run 内工具执行等
//               非流式间隙（数据源未拆分），穿插工具调用时该值偏低

const host = window.SnowAppPlugin;
const React = host.React;
const Icons = host.icons || {};
const h = React.createElement;
const { useState, useEffect, useRef } = React;

const SAMPLE_WINDOW_MS = 3000;
const CONV_POLL_MS = 2000;
const TICK_MS = 1000;
const SPARK_SLOTS = 48;

/* ---------- 格式化 ---------- */

function fmtMs(v) {
  if (!Number.isFinite(v) || v < 0) return "—";
  return v >= 10000 ? (v / 1000).toFixed(1) + " s" : Math.round(v) + " ms";
}

function fmtTps(v) {
  return Number.isFinite(v) && v > 0 ? v.toFixed(1) + " tok/s" : "—";
}

function fmtHeroTps(v) {
  if (!Number.isFinite(v) || v <= 0) return null;
  return v >= 100 ? v.toFixed(0) : v.toFixed(1);
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

/* ---------- 口径计算 ---------- */

function decodeTps(tokens, elapsedMs, ttftMs) {
  if (!Number.isFinite(tokens) || tokens <= 0) return null;
  if (!Number.isFinite(elapsedMs) || !Number.isFinite(ttftMs)) return null;
  const decodeMs = elapsedMs - ttftMs;
  if (decodeMs <= 0) return null;
  return (tokens / decodeMs) * 1000;
}

/** 全部运行中会话的汇总实时状态 */
function runningTotals(sessions) {
  const now = Date.now();
  let decode = 0;
  let hasDecode = false;
  let tokens = 0;
  let longest = null;
  let streaming = 0;
  let paused = 0;
  let aborting = 0;

  for (const s of sessions) {
    if (!s) continue;
    const ttft = s.ttftMs ?? s.runTtftMs;
    const elapsed = Number.isFinite(s.elapsedMs)
      ? s.elapsedMs
      : Number.isFinite(s.startedAt) && s.startedAt > 0
        ? now - s.startedAt
        : null;
    const d = decodeTps(Number.isFinite(s.tokenCount) ? s.tokenCount : 0, elapsed, ttft);
    if (d != null) {
      decode += d;
      hasDecode = true;
    }
    if (Number.isFinite(s.tokenCount)) tokens += s.tokenCount;
    const runElapsed =
      Number.isFinite(s.startedAt) && s.startedAt > 0 ? now - s.startedAt : elapsed;
    if (Number.isFinite(runElapsed) && (longest == null || runElapsed > longest)) {
      longest = runElapsed;
    }
    if (s.isAborting) aborting++;
    else if (s.isPaused) paused++;
    else if (s.isStreaming) streaming++;
  }

  return {
    count: sessions.length,
    decode: hasDecode ? decode : null,
    tokens,
    longest,
    streaming,
    paused,
    aborting,
  };
}

/** 全部会话累计字段 → 总计；缺失字段返回 null 而不是 0 */
function aggregateTotals(items) {
  let output = 0;
  let duration = 0;
  let hasDuration = false;
  let ttftSum = 0;
  let hasTtft = false;
  let requests = 0;

  for (const it of items) {
    if (!it) continue;
    if (Number.isFinite(it.outputTokens)) output += it.outputTokens;
    if (Number.isFinite(it.totalDurationMs) && it.totalDurationMs > 0) {
      duration += it.totalDurationMs;
      hasDuration = true;
    }
    if (Number.isFinite(it.runTtftSumMs)) {
      ttftSum += it.runTtftSumMs;
      hasTtft = true;
    }
    if (Number.isFinite(it.runRequestCount)) requests += it.runRequestCount;
  }

  const decodeTotal = hasDuration && hasTtft ? duration - ttftSum : null;
  return {
    output,
    duration: hasDuration ? duration : null,
    requests,
    avgDecode: output > 0 && decodeTotal > 0 ? (output / decodeTotal) * 1000 : null,
    avgAll: output > 0 && duration > 0 ? (output / duration) * 1000 : null,
    avgTtft: requests > 0 && hasTtft ? ttftSum / requests : null,
  };
}

/* ---------- 状态 ---------- */

function statusMeta(s) {
  if (!s) return { label: "—", cls: "mc-badge mc-b-gray", title: "无会话" };
  if (s.isAborting) return { label: "中断中", cls: "mc-badge mc-b-red", title: "aborting" };
  if (s.isPaused) return { label: "暂停", cls: "mc-badge mc-b-orange", title: "paused" };
  if (s.isStreaming) return { label: "运行中", cls: "mc-badge mc-b-green", title: "streaming" };
  return { label: "空闲", cls: "mc-badge mc-b-gray", title: "idle" };
}

function aggregateStatusMeta(run) {
  if (!run || run.count === 0)
    return { label: "空闲", cls: "mc-badge mc-b-gray", title: "没有运行中的会话" };
  if (run.aborting > 0) return { label: "中断中", cls: "mc-badge mc-b-red", title: "aborting" };
  if (run.streaming > 0) return { label: "运行中", cls: "mc-badge mc-b-green", title: "streaming" };
  if (run.paused > 0) return { label: "暂停", cls: "mc-badge mc-b-orange", title: "paused" };
  return { label: "空闲", cls: "mc-badge mc-b-gray", title: "idle" };
}

function subAgentStatus(status) {
  switch (status) {
    case "running":
      return { label: "运行中", cls: "mc-badge mc-b-green" };
    case "completed":
      return { label: "已完成", cls: "mc-badge mc-b-gray" };
    case "failed":
      return { label: "失败", cls: "mc-badge mc-b-red" };
    case "cancelled":
      return { label: "已取消", cls: "mc-badge mc-b-orange" };
    default:
      return { label: status || "—", cls: "mc-badge mc-b-gray" };
  }
}

/** 子代理会话：宿主发布的是以会话 id 为键的对象，旧版本可能是数组 */
function subAgentList(raw) {
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === "object") return Object.values(raw);
  return [];
}

/* ---------- 组件 ---------- */

/** 迷你曲线：固定 48 槽位、右侧对齐，宽度跟随容器 */
function sparkline(values) {
  const series = Array.isArray(values) ? values.filter((v) => Number.isFinite(v)) : [];
  const recent = series.slice(-SPARK_SLOTS);
  const empty = recent.length < 2;
  const children = [];

  if (!empty) {
    const max = Math.max(1, ...recent);
    const offset = SPARK_SLOTS - recent.length;
    const step = SPARK_SLOTS > 1 ? 100 / (SPARK_SLOTS - 1) : 0;
    const pts = recent.map((v, i) => {
      const x = (offset + i) * step;
      const y = 31 - (v / max) * 28;
      return [x, y];
    });
    const line = pts.map((p) => p[0].toFixed(2) + "," + p[1].toFixed(2)).join(" ");
    children.push(
      h("polygon", {
        key: "area",
        className: "mc-spark-area",
        points: "0,32 " + line + " 100,32",
      }),
      h("polyline", { key: "line", className: "mc-spark-line", points: line }),
    );
  }

  return h(
    "svg",
    {
      className: "mc-spark" + (empty ? " is-empty" : ""),
      viewBox: "0 0 100 32",
      preserveAspectRatio: "none",
      "aria-hidden": "true",
      focusable: "false",
    },
    children,
  );
}

function metaCell(key, label, value, title) {
  return h(
    "div",
    { key, className: "mc-meta-cell", title: title || undefined },
    h("span", { className: "mc-meta-k" }, label),
    h("span", { className: "mc-meta-v" }, value),
  );
}

function metricCell(key, label, value, title, muted) {
  return h(
    "div",
    { key, className: "mc-cell" + (muted ? " is-muted" : ""), title: title || undefined },
    h("div", { className: "mc-cell-k" }, label),
    h("div", { className: "mc-cell-v" }, value),
  );
}

function sectionBlock(key, title, count, note, children) {
  return h(
    "section",
    { key, className: "mc-section" },
    h(
      "div",
      { className: "mc-section-head" },
      h("div", { className: "mc-section-title" }, title),
      count != null ? h("span", { className: "mc-section-count" }, String(count)) : null,
      note ? h("span", { className: "mc-section-note", title: note }, note) : null,
    ),
    children,
  );
}

function cardMetric(key, label, value, title) {
  return h(
    "div",
    { key, className: "mc-metric", title: title || undefined },
    h("div", { className: "mc-metric-k" }, label),
    h("div", { className: "mc-metric-v" }, value),
  );
}

/* ---------- 面板 ---------- */

export default function Panel({ api }) {
  const [rt, setRt] = useState(null);
  const [conv, setConv] = useState(null);
  const [inst, setInst] = useState({});
  const [spark, setSpark] = useState([]);
  const [, setTick] = useState(0);
  const rtRef = useRef(null);
  const samplesRef = useRef(new Map());
  const sparkRef = useRef([]);

  // runtime 域实时订阅 + 3s 瞬时 TPS 采样
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

  // conversations 域轮询：全部会话的模型与累计字段
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

  // 每秒：推进合计速度曲线 + 触发重渲染（运行时长实时跳动）
  useEffect(() => {
    const timer = setInterval(() => {
      const r = rtRef.current;
      const list =
        r && Array.isArray(r.streamingSessions) ? r.streamingSessions : [];
      if (list.length === 0) {
        if (sparkRef.current.length > 0) {
          sparkRef.current = [];
          setSpark([]);
        }
      } else {
        const agg = runningTotals(list);
        if (agg.decode != null) {
          sparkRef.current.push(agg.decode);
          if (sparkRef.current.length > SPARK_SLOTS) sparkRef.current.shift();
          setSpark(sparkRef.current.slice());
        }
      }
      setTick((x) => x + 1);
    }, TICK_MS);
    return () => clearInterval(timer);
  }, []);

  const c = rt && rt.conversation ? rt.conversation : null;
  const sessions = (rt && rt.streamingSessions) || [];
  const convItems = conv && Array.isArray(conv.items) ? conv.items : [];
  const convById = new Map();
  for (const it of convItems) {
    if (it && it.conversationId) convById.set(it.conversationId, it);
  }
  const convItem = c ? convById.get(c.conversationId) || null : null;
  const currentModel = convItem && convItem.model ? convItem.model : null;
  const currentProfile =
    convItem && convItem.apiProfileName ? convItem.apiProfileName : null;

  const run = runningTotals(sessions);
  const totals = aggregateTotals(convItems);
  const runStatus = aggregateStatusMeta(run);
  const heroNum = fmtHeroTps(run.decode);

  let instTotal = null;
  for (const s of sessions) {
    const v = inst[s.sessionKey];
    if (Number.isFinite(v)) instTotal = (instTotal == null ? 0 : instTotal) + v;
  }

  const attentionIds = new Set(
    c && Array.isArray(c.attentionRequiredConversationIds)
      ? c.attentionRequiredConversationIds
      : [],
  );
  const currentId = c ? c.conversationId : null;
  const subAgents = subAgentList(c && c.subAgentSessions);

  /* ---------- Hero：全部运行中会话合计 ---------- */

  const hero = h(
    "div",
    { className: "mc-hero" },
    h(
      "div",
      { className: "mc-hero-top" },
      h("div", { className: "mc-hero-label" }, "合计输出速度 · 解码口径"),
      h("span", { className: runStatus.cls, title: runStatus.title }, runStatus.label),
    ),
    h(
      "div",
      { className: "mc-hero-value" },
      h("span", { className: "mc-hero-num" }, heroNum == null ? "—" : heroNum),
      heroNum == null ? null : h("span", { className: "mc-hero-unit" }, "tok/s"),
    ),
    h(
      "div",
      { className: "mc-hero-sub" },
      sessions.length > 0
        ? "全部 " + sessions.length + " 个运行中会话"
        : "当前没有运行中的会话",
    ),
    sparkline(spark),
    h(
      "div",
      { className: "mc-meta" },
      metaCell("count", "运行中", String(run.count), "全部运行中的会话数（含子代理）"),
      metaCell("tokens", "本轮 token", fmtTokens(run.tokens), "全部运行中会话本轮已产出的 token 合计"),
      metaCell(
        "longest",
        "最长运行",
        fmtDuration(run.longest),
        "运行时间最长的那个会话的本轮时长",
      ),
    ),
  );

  /* ---------- 指标网格：全部会话累计 ---------- */

  const grid = h(
    "div",
    { className: "mc-grid" },
    metricCell(
      "inst",
      "瞬时 TPS",
      fmtTps(instTotal),
      "全部运行中会话 3 秒滚动窗口速度之和",
      instTotal == null,
    ),
    metricCell(
      "avgDecode",
      "总体均值",
      fmtTps(totals.avgDecode),
      "全部会话累计输出 / (累计时长 − 累计 TTFT)，分母含工具执行间隙",
      totals.avgDecode == null,
    ),
    metricCell(
      "avgTtft",
      "平均 TTFT",
      fmtMs(totals.avgTtft),
      "全部会话累计 TTFT / 累计请求数",
      totals.avgTtft == null,
    ),
    metricCell(
      "output",
      "累计输出",
      totals.output > 0 ? fmtTokens(totals.output) + " token" : "—",
      "全部会话累计输出的 token 数",
      totals.output <= 0,
    ),
  );

  /* ---------- 运行中会话 ---------- */

  const sessionCards = sessions.map((s) => {
    const sSt = statusMeta(s);
    const ttft = s.ttftMs ?? s.runTtftMs ?? null;
    const elapsed = Number.isFinite(s.elapsedMs) ? s.elapsedMs : null;
    const runElapsed =
      Number.isFinite(s.startedAt) && s.startedAt > 0
        ? Date.now() - s.startedAt
        : elapsed;
    const isCurrent = currentId && s.conversationId === currentId;
    const needsAttention = attentionIds.has(s.conversationId);
    const rec = s.conversationId ? convById.get(s.conversationId) : null;
    const model = rec && rec.model ? rec.model : null;
    const profile = rec && rec.apiProfileName ? rec.apiProfileName : null;

    return h(
      "div",
      {
        key: s.sessionKey,
        className:
          "mc-card" +
          (isCurrent ? " is-current" : "") +
          (needsAttention ? " is-attention" : ""),
      },
      h(
        "div",
        { className: "mc-card-head" },
        h(
          "span",
          {
            className: "mc-card-title",
            title: s.title || s.conversationId || s.sessionKey,
          },
          s.title || s.conversationId || "未命名会话",
        ),
        h(
          "div",
          { className: "mc-card-tags" },
          isCurrent ? h("span", { className: "mc-tag" }, "当前") : null,
          needsAttention
            ? h("span", { className: "mc-attention-dot", title: "需要关注" })
            : null,
          h("span", { className: sSt.cls, title: sSt.title }, sSt.label),
        ),
      ),
      h(
        "div",
        {
          className: "mc-card-model",
          title: model
            ? profile
              ? model + " @ " + profile
              : model
            : "该会话不在当前项目，模型未知",
        },
        model || "模型未知",
      ),
      h(
        "div",
        { className: "mc-card-speed" },
        h(
          "div",
          { className: "mc-speed-block" },
          h("div", { className: "mc-speed-k" }, "解码 TPS"),
          h(
            "div",
            { className: "mc-speed-v", title: "解码 TPS = token / (时长 − TTFT)" },
            fmtTps(decodeTps(s.tokenCount || 0, elapsed, ttft)),
          ),
        ),
        h(
          "div",
          { className: "mc-speed-block" },
          h("div", { className: "mc-speed-k" }, "瞬时 TPS"),
          h(
            "div",
            { className: "mc-speed-v", title: "3 秒滚动窗口内的输出速度" },
            fmtTps(inst[s.sessionKey]),
          ),
        ),
      ),
      h(
        "div",
        { className: "mc-card-metrics" },
        cardMetric("ttft", "TTFT", fmtMs(ttft), "本轮首个 token 延迟"),
        cardMetric("tokens", "token", fmtTokens(s.tokenCount || 0), "本轮已产出 token"),
        cardMetric("elapsed", "时长", fmtDuration(runElapsed), "本轮 run 的实时时长"),
      ),
    );
  });

  const sessionSection = sectionBlock(
    "sessions",
    "运行中会话",
    sessions.length,
    null,
    sessions.length === 0
      ? h("div", { className: "mc-empty" }, "当前没有运行中的会话")
      : h("div", { className: "mc-cards" }, sessionCards),
  );

  /* ---------- 子代理 ---------- */

  const subSection =
    subAgents.length > 0
      ? sectionBlock(
          "subAgents",
          "子代理",
          subAgents.length,
          null,
          h(
            "div",
            { className: "mc-cards" },
            subAgents.map((sa, i) => {
              const saSt = subAgentStatus(sa && sa.status);
              const name = (sa && (sa.agentName || sa.agentId)) || "子代理";
              const desc = (sa && sa.summary) || "";
              return h(
                "div",
                {
                  key: (sa && (sa.conversationId || sa.agentId)) || "sub-" + i,
                  className: "mc-card",
                },
                h(
                  "div",
                  { className: "mc-card-head" },
                  h("span", { className: "mc-card-title", title: name }, name),
                  h("span", { className: saSt.cls }, saSt.label),
                ),
                desc ? h("div", { className: "mc-sub-desc", title: desc }, desc) : null,
              );
            }),
          ),
        )
      : null;

  /* ---------- 说明 ---------- */

  const totalsLine =
    totals.requests > 0
      ? "全部会话累计 " +
        totals.requests +
        " 次请求 · 累计输出 " +
        fmtTokens(totals.output) +
        " token"
      : null;

  const convUnavailable = !conv && sessions.length > 0;

  const footnote = h(
    "details",
    { className: "mc-details" },
    h("summary", null, "口径说明"),
    h(
      "div",
      { className: "mc-details-body" },
      h(
        "div",
        null,
        h("b", null, "合计速度"),
        " = 全部运行中会话解码 TPS 之和，剔除各自的首 token 等待；首 token 未到的会话不计入。",
      ),
      h("div", null, h("b", null, "解码 TPS"), " = token / (时长 − TTFT)，行业基准口径。"),
      h("div", null, h("b", null, "瞬时 TPS"), " = 3 秒滚动窗口内的 Δtoken / Δt，各会话求和。"),
      h(
        "div",
        null,
        h("b", null, "总体均值"),
        " = 全部会话累计输出 / (累计时长 − 累计 TTFT)。分母含 run 内工具执行等非流式间隙，穿插工具调用的会话该值偏低，实际生成速度以解码口径为准。",
      ),
      h(
        "div",
        null,
        "部分会话的累计时长由应用侧未累计（totalDurationMs 为 0），这些会话不计入总体均值，仅计入平均 TTFT 与累计输出。",
      ),
      h(
        "div",
        null,
        "模型取自 conversations 域，按激活项目拉取；其他项目的运行中会话显示「模型未知」。",
      ),
    ),
  );

  return h(
    "div",
    { className: "mc-root" },
    h(
      "div",
      { className: "mc-head" },
      h(
        "div",
        { className: "mc-head-title" },
        Icons.Activity ? h(Icons.Activity, { size: 15 }) : null,
        "任务中心",
      ),
      currentModel
        ? h(
            "span",
            {
              className: "mc-model-chip",
              title: currentProfile ? currentModel + " @ " + currentProfile : currentModel,
            },
            currentModel,
          )
        : null,
      h(
        "span",
        { className: "mc-live" + (run.streaming > 0 ? " is-hot" : "") },
        h("span", { className: "mc-live-dot" }),
        sessions.length > 0 ? sessions.length + " 个运行中" : "空闲",
      ),
    ),
    hero,
    grid,
    totalsLine || convUnavailable
      ? h(
          "div",
          { className: "mc-hint" + (convUnavailable ? " is-warn" : "") },
          convUnavailable
            ? "conversations 域不可用：模型与累计数据暂不可读"
            : totalsLine,
        )
      : null,
    sessionSection,
    subSection,
    footnote,
  );
}
