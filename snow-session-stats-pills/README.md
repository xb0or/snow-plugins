# 会话统计条（snow-session-stats-pills）

Snow App 客户端脚本：把当前会话的统计做成一行药丸，挂在**聊天输入框正下方**（输入区最底部），点成本块弹出按模型拆分的浮层。

参照对象是 DeepSeek Harness 的 composer 统计条（`StatsPills` = `ActivityPill` + `UsagePill`，源码包见仓库根 `deepseek-harness-stats-pills.tar.gz`），并按 Snow App 的宿主能力重做数据层：DeepSeek 用 `sessionStats` / `tokenUsage` 投影，Snow App 用 `usage` / `messages` / `runtime` 元数据域。

## 功能

| 药丸 | 内容 | 数据来源 |
| --- | --- | --- |
| 轮次 · 步数 | `N 轮 · M 步`（轮 = 用户消息数，步 = 模型请求数，含工具步） | `messages.userMessages` + `usage.records` |
| 速度 | 流式中：`首 token 1.2s · 45.6 tok/s`；空闲：`上轮 12.3s` | `runtime.conversation` |
| 缓存命中 | `缓存命中 94.9%`（缓存读 ÷ 输入，与输入框右侧用量环同源同公式） | `runtime.conversation.tokenUsage` |
| 输入 / 输出 | `输入 1.0M · 输出 5k` | `usage.records` 聚合 |
| 成本 | `¥0.157`，点击展开明细 | `usage.records` × 单价表（联动看板） |

- 成本浮层：会话总额 + 每个模型的 token 四桶（非缓存输入 / 缓存读 / 缓存写 / 输出）、步数、单价与单价来源（自定义 / 内置估算 / 默认价）、刷新时间、记录是否被截断。
- 设置浮层（药丸组末尾的滑杆图标）：五个药丸独立开关、用量刷新间隔（3s / 5s / 10s）、立即刷新、联动状态说明。
- 整行药丸组**水平居中**于输入框下方（`justify-content: center`，另加 `safe center` 回退，内容超宽时不会被裁掉一侧），设置齿轮跟随在药丸组末尾。
- 窄窗口：`<=760px` 收起「轮次·步数」，`<=620px` 再收起速度，其余药丸自动换行，不整体缩放。
- 新会话（还没有 conversationId）时统计条整行隐藏；会话开始后自动出现。
- 全部颜色取宿主 CSS 变量（`--text-secondary` / `--bg-secondary` / `--border-color` / `--accent-blue` 等），跟随明暗主题；图标为内嵌 Lucide 路径，无外部依赖、无网络请求。

## 缓存命中率口径（与输入框右侧用量环一致）

宿主 `TokenUsageRing`（渲染层 `ChatContent.js`）的算法：

```js
const input = tokenUsage.inputTokens;
const cacheRead = Math.min(tokenUsage.cacheReadInputTokens, input);
命中率 = Math.round((cacheRead / input) * 100 * 10) / 10;   // formatPercent：1 位小数
```

药丸严格照抄这套：数据取自 `runtime.conversation.tokenUsage`（当前上下文口径），并做同样的 `Math.min` 裁剪与 1 位小数取整，因此显示的是与环同一个数。

账单口径（全会话所有请求累加，取 `usage.records`）与它天然不同：同一会话环上单步命中 94.9%，全会话累加可能是 99.2%。两个数都在成本浮层里列出：

- 药丸 = 环口径（`runtime.tokenUsage`）
- 浮层「全会话账单口径」= `usage.records` 聚合

`runtime` 快照还没有 `tokenUsage` 时（环本身显示 `--`），命中率药丸一并隐藏，不用账单口径顶替，避免数字跳变。

输入 / 输出 / 成本固定用账单口径（`usage.records`）——这是唯一能按模型拆分算钱的数据源。

## 成本口径（与「成本核算看板」逐项一致）

```
非缓存输入 = max(输入 - 缓存读, 0)
缓存读     = cacheRead
缓存写     = cacheWrite
输出       = output
成本       = Σ(各类 token × 对应单价) / 1,000,000
单价单位   = 货币 / 百万 token
单价解析   = 看板自定义单价 → 内置估算规则 → 默认价(2 / 0.2 / 4 / 6)
```

内置规则表与看板 `BUILTIN_PRICE_RULES` 完全相同（脚本里用 `PURE-MATH-BEGIN/END` 标出，改动需两侧同步）。仓库里 `.probe/check-cost-math.cjs` 会把两侧实现分别加载做逐项比对。

## 与「成本核算看板」联动

看板是价格的唯一事实源。`snow-usage-cost` 1.2.4 起在**价格加载完成**与**保存单价**后发布归一化价格快照：

- DOM：`script[type="application/json"][data-snow-usage-cost-prices]`（共享 DOM，隔离世界脚本必读得到）
- `localStorage["snow.usageCost.prices.v1"]`（跨会话留存）

本脚本每次刷新时先读快照，读不到才回落到内置规则，并在浮层/设置里标明当前用的是哪一种。

**限制**：快照由看板面板写入，所以需要**至少打开过一次「成本核算看板」**才会联动（打开后价格变更立即生效，重启应用后靠 localStorage 仍可读到）。

## 挂载位置

宿主渲染层（Snow 0.5.10，`ChatContent.js`）结构：

```
div.chat-input-region[data-snow-anchor="chat.input"]
  └ div.input-area > div.input-content            ← 与消息列同宽（max-width 1120，居中）
      ├ div.stream-metrics-bar                     （流式指标，条件渲染）
      ├ div.snow-client-slot[data-snow-slot="chat.input.actions"]   ← 官方可写插槽，在输入框上方
      └ div.input-box                              （输入框本体，最后一行是 toolbar）
```

官方可写插槽只有输入框**上方**那一条，输入框下方没有插槽，因此脚本把统计条 append 到 `.input-content` 末尾（= 输入框正下方）。宿主 React 重建节点后由 `MutationObserver` 重挂；找不到 `.input-content` 时退化为 append 到 `[data-snow-anchor="chat.input"]` 末尾。

## 安装

方式一（界面）：插件页面 → 插件列表 → 脚本插件 → **导入文件**，选 `snow-session-stats-pills.user.js`，保存即生效。

方式二（AI / config 工具）：

```text
config-set scope=userscripts key="new" value={sourcePath: "F:\\desktop\\code\\snow-plugins\\snow-session-stats-pills\\snow-session-stats-pills.user.js"}
```

更新已有安装：`config-set scope=userscripts key=<scriptId> value={sourcePath: "..."}`。

联动需要 `snow-usage-cost` 1.2.4+：

```text
config-set scope=plugins key="com.seagull.usage-cost" value={sourceDir: "F:\\desktop\\code\\snow-plugins\\snow-usage-cost"}
```

## 元数据

```text
@snow-target  client        注入桌面窗口
@snow-scope   global        常驻，不随视图卸载（找不到输入区时不渲染）
@snow-privacy messages, usage
@run-at       document-idle
@grant        GM_getValue / GM_setValue   （存 ssp.config：药丸开关与刷新间隔）
```

`usage` 与 `messages` 都是整域敏感域，未在 `@snow-privacy` 声明会被宿主拒绝；脚本对拒绝有显式提示（成本块显示 `成本 -`，浮层显示「用量读取失败：…」），不伪造数字。

## 查询与性能

- `usage` 按 `conversationId` 分页拉取：单页 500 条、最多 6 页（3000 条），超出时浮层标注「记录已截断」。
- 刷新节奏：`runtime` 每 1s（实时速度），`usage` 按设置间隔（默认 5s），轮数 30s 兜底；`stream-end` / `conversation-change` / `view-enter` 触发立即刷新。
- 页面不可见（`document.hidden`）时跳过 usage 轮询；同一时刻只跑一个 usage 请求（`usageSeq` 防串台，切换会话后旧响应丢弃）。

## 验证（本地已跑）

- `node --check` 语法 OK。
- 口径自检 `.probe/check-cost-math.cjs`：两侧 13089 项比对全部一致（含「非缓存输入必须按 input 单价计费」回归项）。
- 离线 DOM harness `.probe/harness-stats-pills.cjs`：15 项全过（挂载位置、轮/步、速度、缓存命中、输入输出、成本、分页、conversationId 透传、浮层内容、流式切换、新会话隐藏）。两种场景都跑：带桥接快照（自定义单价）与不带桥接（内置规则回落）。
- **未验证**：真实窗口里的视觉渲染、拖动窗口宽度、主题切换、真实会话数字与看板页面的对照——需要用户在实际界面确认。

## 已知限制

- 成本随「已完成的请求」更新：一次很长的流式回复在结束时才写入 `usage`，期间只有速度与轮数在动。
- `runtime` 未提供历史 decode 速度，空闲时速度块显示「上轮耗时」（run 墙钟时长，含工具调用），不伪造 tok/s。
- 记录超过 3000 条的超长会话，统计会截断（浮层有标注）。
- 看板价格快照只在看板打开/保存时刷新，改了价格但没开过看板时，本脚本仍用上一次快照或内置规则。

## 卸载

插件页面 → 插件列表 → 脚本插件 → 该脚本行 → 删除（同时删除它的 `GM_*` 数据）。
