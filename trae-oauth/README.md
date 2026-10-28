# Trae 登录（trae-oauth）

本插件是上游 OpenCode provider 插件的 Snow App 适配层，导出 Trae CN 与 Trae 国际版两个 provider；上游实现原样保留在 `index.mjs`。

- 插件类型：纯 OAuth 插件（`plugin.json` 只声明 `oauth.entry`，无渲染层面板）
- 版本：0.1.0
- 作者：kedou
- 可转换性分级：**A 级**（需 Snow 0.5.6+；旧版宿主忽略响应侧钩子，对话不可用，见「限制」）

## 可转换性分级：A 级（登录、模型、对话、额度可用，需 Snow 0.5.6+）

| 项 | 结论 | 证据 |
|---|---|---|
| 判定 | **A 级**：登录、模型列表、额度都能跑通；对话两侧的翻译分别由 `transformRequest` 与 `onResponseChunk` / `transformResponse` 复刻 | 见下三行 |
| 上游对话端点 | 不是 OpenAI Chat，而是 Trae IDE 的 `/api/agent/v3/llm_utils_chat`，返回 Trae 自己的 SSE 事件 | `official/trae/index.mjs:3272-3277`、`3198` |
| 请求侧改写（出站） | 把 OpenAI 请求改写成 Trae 的 `chatBody`（函数名、会话 id、思考档位等），复刻在 `transformRequest` | `official/trae/index.mjs:1185`（`chatBody`）、`3275`；`oauth.mjs:700-718` |
| 响应侧翻译 | 把 Trae 的 SSE 事件翻译成 OpenAI 的 `chat.completion.chunk`（含 reasoning、tool_calls、usage 与错误分片），复刻在 `onResponseChunk`；没有 SSE 分隔符的整段错误正文复刻在 `transformResponse` | `official/trae/index.mjs:2326-2397`（`parts`）、`2436-2515`（`openai`）、`3278-3291`；`oauth.mjs:731-759`、`767-780` |

结论：档案能建出来，模型、额度与对话都可用。出站侧有三处只能取兜底值（函数名、图片能力、思考档位，因为钩子里读不到实时模型表，见「限制」）；上游「换一个函数重试」「把首个错误事件变成 HTTP 错误」这类动作在 Snow 的钩子里做不到，已按不伪造成功的降级处理，逐条写在「限制」里。

## 能力

| 能力 | 状态 | 说明 |
|---|---|---|
| 登录（trae-cn / trae-global） | 可用 | 上游 `browserSignIn()` 在 127.0.0.1 起回调服务器，授权页跳回 `/authorize?userJwt=...&userInfo=...`（`index.mjs:666-744`、`627-662`） |
| 令牌续期 | 可用 | 上游 `auth.refresh` 走 `renewal()`：优先用设备密钥签 `DeviceProof` 走 `/trae/api/v3/oauth/ExchangeToken`，失败回退 `/cloudide/api/v3/trae/oauth/ExchangeToken`（`index.mjs:2804-2817`、`601-614`、`558-599`、`488-526`） |
| 模型列表 | 可用 | 读账号自己的模型目录（`index.mjs:3159-3183` -> `readList` 2749-2759 -> `liveModels` 2977+），失败回退 `config()` 的静态表（`index.mjs:3134-3144`） |
| 对话 | 可用（需 Snow 0.5.6+） | 出站由 `transformRequest` 复刻：URL 换成 `site.apiOf(a) + "/api/agent/v3/llm_utils_chat"`（`index.mjs:3272`），body 复用上游导出的 `chatBody()`（`index.mjs:1185`、`3275`），头用 `ideHeaders()` 的复刻（`index.mjs:749-772`），会话 id 复用 `conversationID()`（`index.mjs:1139`）。响应由 `onResponseChunk` 逐事件折算：Trae 的私有响应是标准 SSE 分帧（`index.mjs:1217-1264`），事件经 `parts()`（`index.mjs:2326-2397`）折成 text / reasoning / tool call / usage / finish 后写成 `chat.completion.chunk`（`index.mjs:2460-2515` 的流式分支）。没有 SSE 分隔符的整段错误正文由 `transformResponse` 复刻 `errorOf()` -> `failure()` -> `errorResponse()`（`index.mjs:3278-3291`、`2422-2429`、`477-481`）。旧版宿主（0.5.5 及以前）忽略响应侧钩子，Trae 的私有事件会直接进 OpenAI 解析器，对话不可用 |
| 额度面板 | 可用 | CN 读 credits 页（`index.mjs:123-144`），Global 读美元额度页（`index.mjs:215-239`）；统一入口 `auth.usage`（`index.mjs:2914-2932`） |
| 每日签到 | 未实现 | 上游 `auth.checkin`（`index.mjs:2880-2912`）在 Snow 宿主没有对应钩子，无法触发；且 CN 的 claim 依赖本机 IDE 的设备身份（`index.mjs:2855-2864`） |

## Provider

| provider id | 站点 | 默认模型 | 依据 |
|---|---|---|---|
| `trae-cn` | trae.cn（国内版） | `glm-5.2` | 站点表 `index.mjs:33-145`，静态模型表首项 `index.mjs:81` |
| `trae-global` | trae.ai（国际版） | `gpt-5.4` | 站点表 `index.mjs:152-243`，静态模型表首项 `index.mjs:181` |

`api.baseUrl` 取各站点的模型主机 `site.hosts.api`（`index.mjs:42` 的 `https://trae-api-cn.mchost.guru`、`index.mjs:164` 的 `https://coresg-normal.trae.ai`），与上游 `loader` 的 `baseURL` 同源（`index.mjs:3198`）。

## 目录

| 文件 | 作用 |
|---|---|
| `oauth.mjs` | Snow OAuth 适配层（本插件入口），只做契约翻译 |
| `index.mjs` | 上游插件入口，原样保留（上游是单文件插件，只 import `node:` 内置模块；`nonet.mjs`、`fake.mjs` 未被 `index.mjs` 引用，故不复制） |
| `plugin.json` | Snow 插件清单 |
| `icon-trae-cn.png` | trae.cn 的 provider 图标（站点官方 favicon，来源见「转换要点」第 9 条） |
| `icon-trae-global.png` | trae.ai 的 provider 图标（站点官方 favicon，来源见「转换要点」第 9 条） |
| `README.md` | 本文件 |

## 转换要点

1. **流程映射**：上游 `methods[0]`（`index.mjs:3317`）返回 `{ url, instructions, method:"auto", callback: () => done }`，`callback()` 不接受参数、自己等页面跳回。因此用 `flow: "device"` + `poll()`，`authorize()` 返回 `{url, instructions, interval: 2, expiresIn: 600}`，不返回 `userCode`。
2. **轮询时机**：上游 `callback()` 在第一次 `poll()` 时才调用，避免不轮询的调用方留下悬挂的 `node:http` 服务器。
3. **定时器与监听句柄**：上游 `browserSignIn()` 起 `node:http` 服务器（`index.mjs:677-707`）并挂 10 分钟定时器（`index.mjs:709`）。适配层在 `authorize()` 期间把新建监听句柄与新建定时器 `unref()`，登录语义不变。
4. **令牌字段**：上游登录结果就是 `toAuth()` 的产物（`index.mjs:388-409`），`expires` 是毫秒 epoch。适配层把 `access/refresh/expires` 映射成 Snow 固定字段，其余（`uid / clientId / deviceId / machineId / devicePublicKey / devicePrivateKey / api / region / host / authHost / account`）原样塞进 Snow 的 `data`。
5. **设备密钥必须保留**：Trae CN 的续期要用设备私钥签 `DeviceProof`（`index.mjs:528-534`、`558-599`），丢了私钥就只能回退到不带设备的 `/cloudide/` 续期，签到会被拒（`index.mjs:45-52` 的注释说明了这一点）。所以 `toSnowToken` 不丢弃任何非空扩展字段。
6. **不落库**：上游 `save()` 直接调 `client.auth.set`（`index.mjs:2761-2765`），适配层给一个不落库的桩；持久化由 Snow 宿主按 `refresh()` 返回值完成。
7. **续期失败不伪造**：上游在无 refresh token 或未登录时返回 `undefined`（`index.mjs:2806`），适配层转成明确抛错。
8. **quota 的 bucket key 必须是 `"window"`**：宿主的配额面板用白名单 switch 决定行标题（`ChatContent.js` 的 `bucketLabel()`），只有 `case "window"` 会原样返回 `bucket.label`，其余未知 key 一律显示「其他」。所以额度窗口的 `key` 固定为 `"window"`，具体数值写进 `label`：Trae 上游的窗口只有 `name/amount/limit/unit`（`index.mjs:138` 的 credits、`index.mjs:234` 的 dollars），没有 `display`，所以 label 按 `[窗口名, "amount / limit unit"]` 拼成，例如 `Credits 12 / 100 credits`、`Dollar Usage 1.5 / 20 usd`。只有余额时（CN 的 `balance = "unlimited"`，`index.mjs:132`）也落成 key `"window"` 的 bucket，值写在 label 里。右侧的「剩余 N%」由宿主按 `usedPercent` 算，插件无法把数值放到那里。
9. **provider 列表的名字与图标**：名字取自 provider 的 `name`，即「产品名 + 版本」（版本从同目录 `plugin.json` 读，不会不同步）：`Trae CN v0.1.0` / `Trae CN（国内版） v0.1.0`、`Trae Global v0.1.0` / `Trae 国际版 v0.1.0`。图标取自 provider 的 `icon`，两个 provider 各用自己站点的官方 favicon：
   - `icon-trae-cn.png` <- `https://lf-cdn.trae.com.cn/obj/trae-com-cn/trae_website_prod_cn/favicon.png`（www.trae.cn 首页 `<link rel="icon">` 指向的文件）
   - `icon-trae-global.png` <- `https://lf-static.traecdn.us/obj/trae-ai-tx/trae_website/favicon.png`（www.trae.ai 首页 `<link rel="icon">` 指向的文件）
   
   两个站点都只声明了 PNG（48x48，深底 `#0a0b0d` + 品牌绿 `#32f08c`），首页没有任何 SVG logo（React SPA，logo 内联在 JS 里），因此图标按真实类型命名 `.png`：宿主 `loadIcon` 的白名单包含 `.png`，而把 PNG 字节改名成 `.svg` 会被当成 `image/svg+xml` 渲染而显示不出来。`headerScheme` 显式设为不带版本的产品名（`Trae CN` / `Trae Global`）；不声明 `icon` 时宿主显示默认的钥匙图标。
10. **对话侧改写（Snow 0.5.6+）**：上游 `loader.fetch`（`index.mjs:3200-3313`）是一整套传输层替代品，适配层复刻其中两半。出站（`transformRequest`，`oauth.mjs:700-718`）：URL 用 `site.apiOf(a) + "/api/agent/v3/llm_utils_chat"`（`index.mjs:3272`、`433`），body 复用上游导出的 `chatBody()`（`index.mjs:1185`、`3275`），头用 `ideHeaders()` 的复刻（`index.mjs:749-772`），会话 id 复用 `conversationID()`（`index.mjs:1139`）。响应（`onResponseChunk`，`oauth.mjs:731-759`）：Trae 的响应是标准 SSE 分帧（`sse()`，`index.mjs:1217-1264`），逐事件交给 `parts()` 的复刻（`index.mjs:2326-2397`）算出 text / reasoning / tool call / usage / finish，再按 `openai()` 流式分支的写法编成 `chat.completion.chunk`（`index.mjs:2460-2515`），收尾分片在 `done` 类事件或 `[DONE]` 处补发。没有 SSE 分隔符的整段正文走 `transformResponse`（`oauth.mjs:767-780`）：用 `errorOf()` 的复刻（`index.mjs:456-464`）与 `failure()` 的分类（`index.mjs:2422-2429`）判定后，写成 `errorResponse()` 的错误体（`index.mjs:477-481`）。`TextTools` / `NativeCalls` / `toolNamed` / `unwrapped` / `chatBody` / `SITES` / `conversationID` 直接用上游 `_internal` 导出（`index.mjs:3326`）；上游没导出的 `ideHeaders` / `eventName` / `tokensOf` / `finishOf` / `Thoughts` / `errorOf` 按原样复刻，行号写在 `oauth.mjs` 的注释里。

## 安装

```powershell
Copy-Item -Recurse "F:\desktop\code\snow-plugins\snow-oauth-plugins\trae-oauth" "$env:USERPROFILE\.snowapp\plugins\trae-oauth"
```

然后重启 Snow App，或在「设置 -> 插件」中重新扫描。打开「设置 -> API 设置 -> OAuth 登录」，来源列表出现「Trae CN（国内版） v0.1.0」与「Trae 国际版 v0.1.0」（名字里带当前插件版本，见转换要点第 9 条）。

## 使用

1. 选择对应 provider -> 点「开始登录」
2. 浏览器打开 `www.trae.cn/authorization?...`（或 `www.trae.ai/...`），登录并允许本次登录
3. 授权页跳回 `127.0.0.1` 的 `/authorize` 回调，Snow 自动完成建档
4. 模型与额度可用；对话经 `transformRequest` + `onResponseChunk` 中转（需 Snow 0.5.6+，见「转换要点」第 10 条与「限制」）

## 限制

- **响应侧钩子需要 Snow 0.5.6+**：`transformRequest` / `onResponseChunk` / `transformResponse` 都是 0.5.6 才有的钩子。旧版宿主（0.5.5 及以前）忽略响应侧两个钩子，档案仍能建出来、模型与额度可用，但 Trae 的私有事件会原样进 OpenAI 解析器，对话不可用，与加钩子前一致。
- **出站有三处只能取兜底值**（钩子里读不到实时模型表）：函数名取 `site.functions[0]`（即 `chat_v3`，上游是「列出该模型的函数优先，其次上次服务过的函数」，`index.mjs:3220`、`76`）；图片能力取静态站点表的 `modalities`（上游模型表没写时的同一兜底，`index.mjs:3237`）；思考档位不发（`levels = null`，上游会按模型表里的档位发 `reasoning_effort`，`index.mjs:3238-3254`）。见 `oauth.mjs:694-698`。
- **不会自动换函数重试**：Trae 对不接受的模型/函数回 400 且错误码属于 `4001` / `4023` / `1005` 时，上游会换下一个函数把同一请求再发一次（`index.mjs:2517-2518`、`3271-3283`、`3286-3304`）。重发要在钩子之外接管传输层，本插件只发一次，失败时按 `transformResponse` 的文案报错。
- **首个错误事件不会变成 HTTP 错误**：上游在写出任何回答之前先读一批事件（`first()`，`index.mjs:2402-2410`，调用点 `3294-3306`），首个是错误就把整次请求答成 HTTP 错误。Snow 的响应此时已经是 200，本插件把它作为错误分片（`data:` 里带 `error` 字段）送出（`oauth.mjs:400-401`）。
- **失败路径不补 `data: [DONE]`**：上游无论成败都会补（`index.mjs:2503-2504`）；本插件在出错时只送回错误分片，正常收尾由宿主原本那条 `[DONE]` 事件带出（`oauth.mjs:485-502`、`735-741`）。
- **`X-Magpie-Sign-In` 头不带**：上游用它告诉宿主账号是否失效（`index.mjs:3309`、`3312`），Snow 侧没有对应概念，适配层不发该头。
- **错误文案的一个兜底来源被换掉**：上游 `failure()` 在没有文案时用 `statusLine(status)` 拼 HTTP 原因短语（`index.mjs:2423`、`307`），那张表未导出，适配层改用状态码本身（`oauth.mjs:317-321`）。
- 每日签到（`index.mjs:2880-2912`）无宿主钩子，未实现；CN 的 claim 还依赖本机 Trae 客户端的设备身份（`index.mjs:2855-2864` -> `clientDevice` 856+），离线环境本就不可用。
- 上游注释说明 CN 协议是从两个开源中转项目推导、未对真实账号完整验证（`index.mjs:7-8`、`28-29`）；国际版只对 "one Free SG account" 跑过（`index.mjs:150-151`）。真实可用性取决于上游假设是否仍成立，本适配层未做额外验证。
- 模型主机可能因账号 `region` / 登录时返回的 `api` 而变化（`index.mjs:189-199`）。档案里的 `api.baseUrl` 只是基址；对话请求的目标由适配层用上游 `site.apiOf(a)` 现算（`oauth.mjs:714`、`index.mjs:433`），会跟着账号的 `region` / `api` 走，因此档案基址与真实请求主机不一致不影响对话。
- 额度在账号页被拒时上游返回 `{ error }`，适配层只记日志并返回空 `groups`，不抛错。

## 校验

```powershell
cd F:\desktop\code\snow-plugins\snow-oauth-plugins
node _shared\verify.mjs trae-oauth
node _shared\harness.mjs trae-oauth
```
