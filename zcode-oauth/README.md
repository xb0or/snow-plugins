# ZCode 登录（zcode-oauth）

本插件是上游 OpenCode provider 插件（Z.ai / BigModel 智谱 的 GLM Coding Plan）的 Snow App 适配层，上游实现原样保留在 `index.mjs`。

- 插件类型：纯 OAuth 插件（`plugin.json` 只声明 `oauth.entry`，无渲染层面板）
- provider id：`zcode`
- 版本：0.1.0
- 作者：kedou
- 可转换性级别：**A 级**（登录、模型、对话、额度可用）
  - Start Plan 被拒时的可读文案需要 **Snow 0.5.6+**（响应侧钩子 `transformResponse`），旧版宿主的退化行为见「其他限制」
  - 三条账号线的请求改写按上游逐行复刻，**未在真实账号上复核**（无可用账号，见「其他限制」）

## 对话的可用性：三条账号线都已复刻

ZCode 有三种账号形态，上游走三条不同的请求路径；本插件把三条都接上了：

| 账号形态 | 上游的请求路径 | Snow 下对话 |
|---|---|---|
| 账号自带 GLM Coding Plan（个体订阅） | 请求直接发到 `api.z.ai/api/anthropic` 或 `open.bigmodel.cn/api/anthropic`，只改请求头（`x-api-key` + `Bearer`）就够（`official/zcode/index.mjs:1827-1834`） | **可用**：标准 Anthropic Messages，出站补一个 `x-api-key`（`oauth.mjs:transformRequest` 第 2 条） |
| 团队席位（team 计划的 `zcode-team-api-key`） | 登录时上游就把席位 key 铸好并写进登录状态（`official/zcode/index.mjs:860`、`864`、`909`），请求与个体订阅走同一条分支 | **可用**：同个体订阅（补 `x-api-key`）。上游 fetch 里那处「现场铸 key」只在登录状态里没有 key 时才走（`official/zcode/index.mjs:1766-1772`），正常登录的席位不需要 |
| ZCode Start Plan（只有 zcode.z.ai 的 JWT） | 请求要打到 `zcode.z.ai/api/v1/zcode-plan/anthropic`，还必须伪装成 ZCode 自己的请求：整套换请求头、用 `dress()` 重写整段 system 提示词、重排 `cache_control`、改 `metadata.user_id`（`official/zcode/index.mjs:1814-1826`、`1435-1460`、`1641-1683`）；被拒时改写响应正文（`1838-1842`） | **可用**：出站伪装由 `oauth.mjs:transformRequest` 复刻（请求体整段交给上游导出的 `_internal.dress`，不重新实现），被拒文案由 `oauth.mjs:transformResponse`（Snow 0.5.6+）复刻。请求头是否被 `zcode.z.ai` 接受**未在真实账号上核实** |

另外两条仍在响应侧、档 1/2 表达不了：`-Trial`（试用额度路由）与 Claude Code 的 tool search 改名，见「其他限制」。

登录、模型列表、额度面板对**所有**账号形态都可用。

## 能力

| 能力 | 状态 | 说明与证据 |
|---|---|---|
| 登录 | 可用 | 上游 `authorize(site)`：`POST {ZCODE}/api/v1/oauth/cli/init` 拿授权页，再轮询 `/api/v1/oauth/cli/poll/{flow_id}`（`official/zcode/index.mjs:941-998`）。不需要宿主监听本地端口，映射为 Snow `flow: "device"` + `poll()` |
| 续期 | 未实现 | 上游**没有** `refresh` 钩子：自带的 Coding Plan key 不会过期（`official/zcode/index.mjs:992`），Start Plan 的 JWT 不能刷新、到期只能重新登录（`official/zcode/index.mjs:12-13`、`1815`）。本插件因此不导出 `refresh` |
| 模型列表 | 可用 | 上游 `provider.models`：读 ZCode 的本地配置表列出计划内模型，读不到就退回内置表 `MODELS`（`official/zcode/index.mjs:1713-1745`、`36-41`），再补上试用额度的 `-Trial` 别名。离线实测返回 `["GLM-5.3","GLM-5.3-Flash","GLM-5.2","GLM-5-Turbo"]` |
| 对话 | 可用（Start Plan 的被拒文案需 Snow 0.5.6+） | 三条账号形态都能发消息：个体订阅与团队席位是标准 Anthropic Messages，出站补 `x-api-key`（`official/zcode/index.mjs:1827-1834`）；Start Plan 的出站伪装与响应侧被拒文案分别由 `transformRequest`（`index.mjs:1814-1826`）与 `transformResponse`（`index.mjs:1838-1842`）复刻。三条线均**未在真实账号上复核** |
| 额度 | 可用 | 上游 `auth.usage`：按账号形态读 Coding 窗口、Start Plan 试用额度或团队额度，并附「在 ZCode 应用里领取」的提示（`official/zcode/index.mjs:1871-1912`、`364-446`、`463-545`）。`used` -> `usedPercent`，`resetsAt` -> `resetAt`，上游 `display`（如 `120 / 1000`）拼进 `label`；上游没给 `display` 时退回用 `amount / limit / unit` 拼 |

## 目录

| 文件 | 作用 |
|---|---|
| `plugin.json` | Snow 插件清单，`id` = 目录名，`oauth.entry` = `oauth.mjs` |
| `oauth.mjs` | Snow OAuth 适配层（本插件入口），只做契约翻译与请求/响应改写 |
| `index.mjs` | 上游插件入口，原样复制未改一行（`official/zcode/index.mjs`） |
| `prompt.mjs` | 上游 `index.mjs:23` import 的 CLI 提示词模块，原样保留（Start Plan 分支的 `dress()` 要靠它伪装请求） |

未复制：`*.test.mjs`、`docs/`、`package.json`（`index.mjs` 不 import 它们）。

## 转换要点

1. **流程映射**：上游 `authorize()` 返回 `{url, instructions, method:"auto", callback()}`，轮询间隔来自服务端的 `poll_interval_sec`、有效期来自 `expires_at`（`official/zcode/index.mjs:958-959`）。Snow 侧固定 2 秒轮询、300 秒有效期交给宿主驱动（`oauth.mjs:authorize`）。
2. **令牌字段**：上游把整份登录状态（`site` / `base` / `key` / `jwt` / `plan` / `device` / 团队 project）打包进 `refresh` 字段的 JSON（`official/zcode/index.mjs:986-994`），Snow 的 `refreshToken` 原样存这串 JSON，`access` 进 `accessToken`，`accountId` 进 `accountId`，`plan` 进 `planType`。
3. **`transformRequest` 覆盖上游 loader.fetch 的两条账号线**（`oauth.mjs:transformRequest`，纯本地计算）：
   - **Start Plan**（登录状态里有 `jwt`、没有 `key`、也不是团队席位）：整段交给 `startRequest()`，复刻上游 `index.mjs:1814-1826` 的三件事——换基址到 `https://zcode.z.ai/api/v1/zcode-plan/anthropic` 并去掉查询串（`index.mjs:1817`、`1569-1572`）、整套换请求头（`index.mjs:1435-1460`）、请求体交给上游导出的 `_internal.dress()`（`index.mjs:1641-1683`）；同时删掉 `x-api-key` 与 `anthropic-beta`（上游这条分支把头整套换掉，`index.mjs:1432-1434`）。走哪条路由 `startState()` 判：上游 `plansOf` 的本地短路是同一个判定（`index.mjs:207-208`），有 key 的账号要读计划列表才知道，钩子里不发网络请求，按 Coding Plan 处理。
   - **其余（自带 Coding Plan key，含团队席位）**：补 `x-api-key: <accessToken>`，对齐上游个体订阅分支（`index.mjs:1832-1833`）；再从 `refreshToken` 的 JSON 里读出账号实际的计划基址，把发往 `api.z.ai` 的请求换到 `open.bigmodel.cn`（BigModel 账号）。实测：`https://api.z.ai/api/anthropic/v1/messages?beta=true` -> `https://open.bigmodel.cn/api/anthropic/v1/messages?beta=true`。请求体不动——上游在这一分支上也原样转发（`index.mjs:1827-1834`）。
4. **不导出 `refresh`**：上游没有这个钩子，Snow 宿主未实现 `refresh()` 时会报「does not implement refresh()」（`probe/host/main-index.js:12681-12686`），这是预期行为，不是缺陷。
5. **日志**：上游用 `client.app.log` 记错（`official/zcode/index.mjs:1688-1692`），Snow 下传桩对象；但上游的错误同时会作为 `callback()` 的 `error` 返回（`965`、`978-979`），由 `poll()` 原样抛给界面，不会丢。
6. **只暴露一种登录**：上游 methods 里还有「团队计划」「ZCode 应用自己的登录」「粘贴 API key」（`official/zcode/index.mjs:1914-1951`）。Snow provider 没有 `prompts`/多入口，只暴露 Z.ai 个体计划这一条；团队计划与「ZCode 应用登录」需要交互式选择站点或读取本机 ZCode 凭据，未暴露。
7. **quota 的 bucket key 必须是 `"window"`**：宿主的配额面板用白名单 switch 决定行标题（`ChatContent.js` 的 `bucketLabel()`），只有 `case "window"` 会返回 `bucket.label` 原文，其余未知 key 一律显示「其他」。所以 `key` 固定写 `"window"`，具体数值必须进 `label`。右侧的「剩余 N%」由宿主按 `usedPercent` 算，插件无法换成别的文案。
8. **`label` 一定带数值**：`label` 取 `[窗口名, 数值说明]` 拼接（如 `Weekly 120 / 1000`）。数值说明优先用上游 `windows[].display`（`official/zcode/index.mjs:387`、`392`、`525`），上游只在同时给出用量与总量时才填它；没填时退回 `oauth.mjs:detailOf` 用 `amount / limit / unit` 拼（上游 `unit` 已折算成 `span`，通常没有 `unit`，此时只拼 `amount / limit`）。只给百分比、或本就没有配额的窗口（如 `MCP · Month`）只显示窗口名，不编造数值。
9. **provider 列表的名字与图标**：名字取自 provider 的 `name`，即「产品名 + 版本」（版本从同目录 `plugin.json` 读，不会不同步）；图标取自 provider 的 `icon`（本插件用插件目录内的 `icon.svg`，来源见下节），不声明则宿主显示默认的钥匙图标。`headerScheme` 显式设为不带版本的产品名 `ZCode`，避免自定义请求头方案名跟着版本变。
10. **响应侧改写（档 1，Snow 0.5.6+）**：上游对响应做的、不属于出站的事有两处能放进 `transformResponse`：
    - **Start Plan 被拒时的正文**（`official/zcode/index.mjs:1838-1842`）：`status >= 400` 且 `startRefused()` 判为「被拦」（405 / 拦截页 / `code 3012`，判定见 `index.mjs:1391-1392`、`1396`）时，上游把整段正文换成 `startBlocked()` 的错误体（`{type:"error", error:{type:"permission_error", message}}`，`index.mjs:1400-1413`）。这种正文是裸 JSON 或拦截页，不是 SSE，宿主按整段交给 `transformResponse`，本插件复刻同一判定与文案，并把 `content-type` 换成 JSON、删掉 `content-length` / `content-encoding`。
    - 状态码本身改不了（宿主只让插件改 `body` / `headers`），上游这一处也没改。
    上游同一个 `loader.fetch` 里还有两处响应侧逻辑**没有**转（判定见第 6 条与「其他限制」）：`X-Magpie-Sign-In: kept`（`index.mjs:1344-1350`，magpie 自己的标记，Snow 没有对应概念）、`-Trial` 的 200 -> 429（`index.mjs:1849-1861`，状态码改不了）。
    上游没有导出 `startRefused` / `startBlocked` / `startHeaders` 与它们依赖的字面量（`_internal` 的导出清单见 `index.mjs:1957`），所以这三段在 `oauth.mjs` 里按上游逐行复刻并标注了出处行号；`dress()` 则是**直接复用** `_internal.dress`，没有第二份实现。

## 图标来源

`icon.svg` 是 Lucide 的 `bot` 图标，描边色固定为 `#4B5563`，来源 `https://unpkg.com/lucide-static@latest/icons/bot.svg`，用 `_shared/fetch-lucide-icon.mjs bot icon.svg "#4B5563"` 生成（已去掉 license 注释与 `class`，`stroke="currentColor"` 换成固定色）。

为什么不用站点官方 logo：宿主的 provider 卡片用 `<img>` 渲染图标，不跟随主题，单色 logo 在深浅两个主题里必有一边看不见。按规范先探测了两个站点自带的图标，都不适合：

| 探测目标 | 结果 | 结论 |
|---|---|---|
| `https://zcode.z.ai`（ZCode 站点根，上游 `ZCODE`，`index.mjs:26`） | `<link rel="apple-touch-icon">` -> `apple-icon.png` 180x180，不透明像素只有 `#2d2d2d`（16874 px）与 `#ffffff`（7606 px），其余全透明 | 单色图标，深色主题下深色部分与卡片背景融在一起，不用 |
| `https://z.ai` | `<link rel="icon" type="image/svg+xml">` -> `https://z-cdn.chatglm.cn/z-ai/static/logo.svg` | 220 行、195 个 `st*` 类、108 处 `url(#SVGID_n_)` 引用，但文件里没有任何 `<defs>` / 渐变 / `<clipPath` 定义（实测 `Gradient`、`<defs`、`<clipPath` 各出现 0 次），只有 3 个 `<path>` | 不是能用在小尺寸上的 logo 记号，且样式引用的图形定义缺失，不用 |
| `https://bigmodel.cn` | `<link rel="icon">` -> `static/images/favicon.png` 90x90，同样只有 `#2d2d2d` 与 `#ffffff` 两种不透明色 | 单色图标，同上，不用 |

`https://zcode.z.ai/favicon.svg` 与 `/logo.svg` 不存在：该站点对这两个路径返回的是 SPA 的 HTML（283KB），不是图片，未采用。

## 安装

```powershell
Copy-Item -Recurse "F:\desktop\code\snow-plugins\snow-oauth-plugins\zcode-oauth" "$env:USERPROFILE\.snowapp\plugins\zcode-oauth"
```

或在 Snow App「设置 -> 插件」里安装。之后打开「设置 -> API 设置 -> OAuth 登录」，来源列表出现「ZCode 登录」。

## 使用

1. 选「ZCode 登录」-> 开始登录，浏览器打开 z.ai 的授权页并登录
2. Snow 每 2 秒轮询一次；上游会在站点侧查出该账号的 Coding Plan key（个体订阅 / 团队席位）或 Start Plan，然后建档并激活
3. 模型列表与额度面板可用；三条账号形态都能发消息。Start Plan 账号若仍被上游拒绝，界面会显示「被拦 + 该怎么换账号」的说明（需要 Snow 0.5.6+）

## 其他限制

- **只能登录 Z.ai（`site = "zai"`）**。BigModel（智谱）账号需要走同一条 `authorize("bigmodel")` 分支（`official/zcode/index.mjs:1916`），Snow 没有入口；但 `transformRequest` 的换站逻辑对 BigModel 基址是就绪的。
- **`-Trial`（试用额度别名）线不可用**：上游在请求侧要把 `-Trial` 别名解析回试用额度的真实模型名，前提是先读到该账号的试用额度（一次网络读取，`official/zcode/index.mjs:1791-1801`），钩子里不能发网络请求；被拒后的 200 -> 429（`index.mjs:1849-1861`）也改不了状态码。这条线需要档 3（`fetch` 接管）。模型列表里出现 `-Trial` 的账号请改用同名的非 `-Trial` 模型。
- **Claude Code 的 tool search 改名未转**：上游只在请求体里出现名为 `ToolSearch` 的工具时改名（`official/zcode/index.mjs:1484-1508`），并在响应里把 `ToolSearchTool` 改回 `ToolSearch`（`index.mjs:1513-1564`，只对 SSE 事件或整段 JSON 生效）。Snow 的 Anthropic 口径工具名由宿主决定，不含 Claude Code 那套 `ToolSearch` / `DeferredToolPlaceholder`（未在教学机上核对宿主的工具名清单），触发不到，因此本插件不导出 `onResponseChunk`。
- **状态码类改写做不到**：上游的 `-Trial` 把 200 改成 429、以及 `kept()` 给每个响应加的 `X-Magpie-Sign-In: kept` 头，前者需要改状态码、后者是 magpie 自己的标记，Snow 的响应钩子只给 `body` / `headers`。
- **Start Plan 的 JWT 过期**：上游在发请求前会先判过期并抛 `EXPIRED`（`official/zcode/index.mjs:1815`，`jwtExpired` 未导出），本插件不复刻这一句——过期的 JWT 会被上游以 401 拒绝，界面显示厂商自己的话。
- **旧版宿主（0.5.5 及以前）的退化行为**：旧版忽略 `transformResponse`，Start Plan 被上游拒绝时显示厂商原文（405 拦截页 / `code 3012` 的 JSON），可读说明不出现；请求侧的伪装走 `transformRequest`，旧版也有，功能不受影响。没有声明 `onResponseChunk` / `fetch`，其余能力新旧一致。
- **未核实**：真实账号下的登录、模型、额度、对话均未跑（无账号）；Start Plan 的整套请求头是否被 `zcode.z.ai` 接受、三条线的对话是否真的通，须以真实账号为准。离线实测见「能力」表与 `_shared/harness.mjs`。

## 校验

```powershell
cd F:\desktop\code\snow-plugins\snow-oauth-plugins
node _shared\verify.mjs zcode-oauth
node _shared\harness.mjs zcode-oauth
```
