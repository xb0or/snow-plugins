# Devin 登录（devin-oauth）

本插件是上游 OpenCode provider 插件的 Snow App 适配层，上游实现原样保留在 `index.mjs`。

- 插件类型：纯 OAuth 插件（`plugin.json` 只声明 `oauth.entry`，无渲染层面板）
- provider id：`devin`
- 分级：**A 级**（登录、模型、额度、对话都可用；对话需要 Snow 0.5.6+ 的 `fetch` 钩子）
- 版本：0.2.0 / 作者：kedou

## 可转换性分级（A 级）

判级按 SPEC 第 4 节，证据全部落在源文件行号上（上游源文件见 `index.mjs`）：

| 判据 | 证据 |
|---|---|
| 对话不是 OpenAI 协议，而是 Connect RPC + protobuf | `official/devin/index.mjs:24`（`CHAT_RPC = "/exa.api_server_pb.ApiServerService/GetChatMessage"`）、`index.mjs:1679`（`Content-Type: application/connect+proto`、`Connect-Protocol-Version: 1`、`Authorization: Basic <key>`） |
| 请求要自己编码成 protobuf | `official/devin/index.mjs:1399-1537`（`build()` 把 messages/tools 编成 protobuf）、`index.mjs:1100-1141`（`frame()` 加 Connect 帧头、必要时 gzip） |
| 响应是 protobuf 流，必须**响应侧**解析成 chat completion | `official/devin/index.mjs:1672-1765`（`complete()`：读帧、解事件，再自己发 `data: {...}` SSE 或 `chat.completion` JSON）、`index.mjs:1735-1754`（自己拼 chunk）、`index.mjs:1764`（返回 `text/event-stream`） |
| 出站+响应一体化，正好对上 Snow 档 3 的 `fetch` 钩子 | `official/devin/index.mjs:1877-1891`（`auth.loader().fetch`：请求改 protobuf、响应交给 `complete()`）；Snow 侧 `oauth.mjs` 的 `fetch()` 直接把这次请求交给它（SPEC 4.5 节） |
| 登录本身是标准 PKCE 回调 | `official/devin/index.mjs:911-973`（`browserSignIn`：PKCE 到 `app.devin.ai`，回 `127.0.0.1/callback`）、`index.mjs:22`（`AUTHORIZE`）、`index.mjs:872-888`（`exchange` 换会话令牌） |
| 模型列表是普通 Connect JSON RPC，可单独调用 | `official/devin/index.mjs:1950-1958`（`provider.models`）、`index.mjs:319`（`GetCliModelConfigs`）、`index.mjs:44-100`（快照目录） |
| 额度是普通 JSON RPC，可单独调用 | `official/devin/index.mjs:1793-1834`（`usage()`）、`index.mjs:1772-1781`（`GetUserStatus`） |
| 上游没有 refresh | `official/devin/index.mjs:1869-1933`（`auth` 只有 `provider` / `loader` / `methods` / `usage`） |

结论：对话所需的出站编码与响应翻译全部在 `auth.loader().fetch` 里，Snow 的 `fetch` 钩子（档 3）允许插件完整接管传输层，因此原样复用上游、不复制任何 protobuf 逻辑即可对话（见「转换要点」第 11 条）。

## 能力

| 能力 | 状态 | 说明 |
|---|---|---|
| 登录 | 可用 | 上游 `authorize()` = `browserSignIn()`（`index.mjs:911-973`）：PKCE（S256）+ `cli_pkce_marker=1` 打开 `app.devin.ai/auth/cli/continue`，回调到 `127.0.0.1:<随机端口>/callback`，用 `ExchangeDevinCLIPKCECode` 换 `devin-session-token$<jwt>`（`index.mjs:872-888`）。映射为 Snow `flow: "device"` + `poll()` |
| 令牌自动续期 | 未实现 | 上游 `auth` 没有 `refresh` 钩子（`index.mjs:1869-1933`），会话令牌也没有到期时间，只有重新登录。Snow 侧因此不导出 `refresh()`，档案不会自动续期 |
| 模型列表 | 可用 | 上游 `provider.models`（`index.mjs:1950-1958`）：读 Devin 的 live 目录（`GetCliModelConfigs`，`index.mjs:319-343`）或 devin CLI 的输出（`index.mjs:811-856`），失败时回快照目录（`index.mjs:44-100`） |
| 对话 | 可用（需 Snow 0.5.6+） | 由 `fetch` 钩子（档 3）整体接管：Snow 把这一次 chat 请求原样交给上游 `auth.loader().fetch`（`index.mjs:1877-1893`），上游负责编 protobuf 请求（`index.mjs:1674`）与把响应的 protobuf 帧翻回 `chat.completion.chunk` SSE（`index.mjs:1672-1765`），适配层不做协议翻译。旧版宿主（0.5.5 及以前）忽略该钩子，对话不可用，其余能力不受影响 |
| 额度面板 | 可用 | 上游 `auth.usage`（`index.mjs:1902-1932` -> `1793-1834`）：`GetUserStatus` 的日/周额度、ACU 用量、额外余额，映射为 `quota()` 的 groups/buckets |

## 目录

| 文件 | 作用 |
|---|---|
| `oauth.mjs` | Snow OAuth 适配层（本插件入口），只做契约翻译 |
| `index.mjs` | 上游插件入口，原样复制，一行未改 |
| `plugin.json` | Snow 插件清单（`oauth.entry`） |
| `README.md` | 本文件 |

上游 `index.mjs` 只 import `node:buffer` / `node:crypto` / `node:http` / `node:zlib` / `node:child_process` / `node:fs` / `node:fs/promises` / `node:os` / `node:path`，无相对依赖，因此只复制了这一个文件（上游的 `*.test.mjs` 与 `testdata/` 未复制）。

## 转换要点

1. **登录方式选择**：上游导出两个登录方法（`index.mjs:1895-1898`）：`Devin (browser)` 与 `Devin CLI's sign-in`。后者 `url` 是空串（`index.mjs:977-981`），不满足 Snow 的 `authorize()` 契约（必须给出可打开的 http(s) 地址），所以只用浏览器方式；CLI 方式未导出。
2. **流程映射**：`browserSignIn()` 返回 `{ url, instructions, method: "auto", callback: () => done }`，`callback()` 不接受参数、自己等本地回调（`index.mjs:967-972`）。因此映射为 `flow: "device"` + `poll()`，不需要用户粘贴回调内容。
3. **懒启动回调用**：`authorize()` 只记下上游 `callback`，第一次 `poll()` 才真正调用，避免不轮询的调用方（离线 harness、CLI）留下悬挂任务。
4. **句柄与定时器 unref**：上游在 `127.0.0.1` 监听并挂了一个 10 分钟定时器（`index.mjs:949-957`），会阻止只靠事件循环退出的调用方结束。适配层只把本次 `authorize()` 新建的监听句柄与定时器 `unref()`，登录行为不变。
5. **令牌字段**：上游登录结果是 `{ key, metadata:{email, plan, orgId, teamId, server?, cli?} }`（`index.mjs:896-907`）。映射为 `accessToken = key`、`email/accountId = metadata.email`、`planType = metadata.plan`，整份 `metadata` 存进 `data.metadata`（Snow 会落库，后续钩子用 `ctx.account.data` 读回）。
6. **`type: "api"` 契约**：上游 `loader` / `models` / `usage` 都要求 `auth.type === "api"` 且 `auth.key`（`index.mjs:1873`、`1951`、`1904`），并从 `auth.metadata` 读 `server` / `cli`（`index.mjs:1850`、`1857`）。适配层在 `toUpstreamAuth()` 里把 Snow 档案还原成这个形状。
7. **不落库**：上游 `usage` 会 `client.auth.set` 回写邮箱/组织（`index.mjs:1906-1929`），Snow 由宿主落库，适配层传入不落库的桩。
8. **上游用全局 fetch**：上游所有请求走 `fetch`（Node/Electron 内置）。适配层在 `fetch()` 接管期间把全局 `fetch` 临时指向宿主的 `ctx.fetch`（Electron `net.fetch`，遵循应用代理），结束后恢复；登录 / 模型 / 额度这些不走 `fetch` 钩子的调用仍用全局 `fetch`，不经过 Snow 应用代理设置。
9. **配额 bucket 的 `key` 必须是 `"window"`**：宿主配额面板的行标题用白名单 switch 决定（渲染层 `ChatContent.js` 的 `bucketLabel()`），只有 `case "window"` 会原样显示 `bucket.label`，其余未知 key 一律显示「其他」。右侧数值由宿主写死为「剩余 N%」，插件改不了，所以具体数值必须拼进 `label`：`oauth.mjs` 的 `windowLabel()` 优先用上游 `windows[].display`，没有它再用 `amount / limit / unit` 拼。原先按窗口名生成 key 的逻辑（窗口名兜底为 `bucket-<数组下标>`，并因此多带一个 `map` 数组下标参数）已随本次改动删除；`resetAt` 仍按上游 `*ResetAtUnix` 转 ISO 字符串。上游 windows 里只有 `ACUs` 带 `display`（形如 `12.50 / 50 ACUs`，`index.mjs:1829`），`1 day` / `7 days` 只有 `name` / `used` / `span` / `resetsAt`（`index.mjs:1820`），因此后两行的标题只显示窗口名，具体数值由宿主的「剩余 N%」体现。
10. **provider 的名字与图标**：名字取自 provider 的 `name`，即「产品名 + 版本」（如 `Devin v0.2.0` / `Devin 订阅 v0.2.0`），版本从同目录 `plugin.json` 读取（`oauth.mjs` 顶部的 `PLUGIN_VERSION` / `withVersion`），不会与清单里的 `version` 不同步；`headerScheme` 显式固定为不带版本的 `Devin`，避免自定义请求头方案名跟着版本变。图标：Devin 站点的 SVG 候选都是单色（`https://devin.ai/favicon.svg` 是单个 `fill="black"` 的 path，1405 字节；`app.devin.ai/favicon.svg` 实际返回的是 SPA 的 HTML，不是图标），因此取 `app.devin.ai` 页面声明的 PWA 图标 `https://app.devin.ai/assets/pwa/pwa-icon-512.png`（512x512，27215 字节；`_shared/.probe/png-stats.mjs` 实测不透明像素中白底约占 72%、深色标记约占 26%，另有 5.6% 四角透明，深浅主题下都可见）。该文件是位图，扩展名按实际类型用 `icon.png`（`_shared/SPEC-UI.md` 的 `loadIcon` 白名单允许 `.png`）。不声明 `icon` 时宿主会显示默认的钥匙图标。
11. **对话接管（档 3，Snow 0.5.6+）**：`oauth.mjs` 的 `fetch(ctx)` 只做四件事——从 `ctx.account` 还原上游 auth（`toUpstreamAuth`）；取上游 `auth.loader()`；把 `ctx.url` 归一到 `/chat/completions` 结尾（上游只认这个路径，`index.mjs:1881`），把 `ctx.body` 归一成上游能 JSON.parse 的字符串；在 `withHostFetch` 里调用上游 `client.fetch()` 并原样返回它的 `Response`。protobuf 编解码、gzip 帧、SSE 拼装全部留在上游（`index.mjs:1672-1765`），适配层不复制一行。`withHostFetch` 的作用是让上游内部那个全局 `fetch` 走宿主的 `ctx.fetch`（应用代理），并用串行队列避免并发对话互覆盖；`ctx.fetch` 缺失时直接回退全局 `fetch`。宿主会把这个 `Response` 的正文整段读完再按 SSE 逐条解析（SPEC 4.5 节），因此对话内容可用，但没有逐字打字机效果。

## 安装

```powershell
Copy-Item -Recurse "F:\desktop\code\snow-plugins\snow-oauth-plugins\devin-oauth" "$env:USERPROFILE\.snowapp\plugins\devin-oauth"
```

然后重启 Snow App，或在「设置 - 插件」中重新扫描。打开「设置 - API 设置 - OAuth 登录」，来源列表出现「Devin 登录」。

## 使用

1. 选择「Devin 订阅」，点「开始登录」
2. 浏览器打开 `app.devin.ai/auth/cli/continue?...`，登录/选账号后回调到 `127.0.0.1`，页面提示已登录
3. Snow 每 2 秒轮询一次，换到会话令牌后档案自动创建并激活
4. 直接发消息即可对话；服务商与登录弹窗会带「自定义传输」标注（对话由插件的 `fetch` 接管）

## 限制

- **对话走「自定义传输」**：`fetch` 钩子绕过宿主的打字机式流式、跨协议工具调用归一化、原生重试与部分截断保护（宿主文档与 `_shared/SPEC.md` 4.5 节写明）；服务商列表会标注「自定义传输」。正文要等上游把整段 SSE 产出完才进入宿主解析，长回答的观感是「一次性出结果」而不是逐字滚出。
- **对话需要 Snow 0.5.6+**：旧版宿主（0.5.5 及以前）忽略 `fetch` 钩子，档案、模型与额度照旧可用，发消息会失败。
- 不会自动续期（上游没有 refresh）。会话令牌失效后需要重新登录。
- CLI 登录方式（读 `devin auth login` 的 `credentials.toml`）未导出：它的 `url` 是空串，不满足宿主契约。
- 额度映射里 `resetsAt` 的上游字段是 `dailyQuotaResetAtUnix` / `weeklyQuotaResetAtUnix`（`index.mjs:1815-1816`）且上游原样透传（`index.mjs:1820`），适配层按 Unix 秒转 ISO 字符串。**「未核实」** Snow 期望的 `resetAt` 格式，若不接受 ISO 会显示不出重置时间。
- 上游专有字段（`span`、`notModels`、`until`、`aside`）在 Snow 侧无对应字段，已丢弃；`balance`（额外余额，`index.mjs:1832`）用作 group 的 `label`。
- 登录 / 模型 / 额度这些不走 `fetch` 钩子的调用仍用上游的全局 `fetch`，不经过 Snow 应用代理设置（对话请求在接管期间走 `ctx.fetch`，遵循应用代理）。
- 模型快照（`index.mjs:44-100`）是上游写死的 2026-10-14 列表，只有 live 读取成功时才会被账号自己的目录替换。

## 校验

```powershell
node F:\desktop\code\snow-plugins\snow-oauth-plugins\_shared\verify.mjs devin-oauth
node F:\desktop\code\snow-plugins\snow-oauth-plugins\_shared\harness.mjs devin-oauth
node F:\desktop\code\snow-plugins\.probe\devin-fetch-test.mjs
```

第三条是 `fetch` 钩子的离线端到端验证（不发真实网络请求）：用上游自己的 `PB` / `frame` 编出一帧 `GetChatMessage` 回复塞进 mock transport，断言钩子把上游翻好的 SSE 原样交回、正文与 `[DONE]` 收尾完整、出站是 `application/connect+proto` + `Basic` 认证、无令牌时返回 401 且不发请求、上游 401 原样透传。该脚本位于仓库 `.probe/`（不随插件发布）。
