# WorkBuddy 登录（workbuddy-oauth）

本插件是上游 OpenCode provider 插件的 Snow App 适配层，上游实现原样保留在 `index.mjs`。上游一个文件导出两个站点插件（`index.mjs:2045-2046`），本插件把它们**合成一个 provider**：登录面板里选站点，命中的站点记进档案，之后都按它选上游实例。

- 插件类型：OAuth 插件 + 自定义登录面板（`plugin.json` 声明 `oauth.entry` 与 `renderMode`/`entry`）
- 版本：0.1.0
- 作者：kedou
- provider id：`workbuddy`（**一个** provider，覆盖国内版 copilot.tencent.com 与国际版 www.workbuddy.ai）

## 可转换性分级：A 级（附两处响应侧边缘限制）

判定依据：上游对话端点就是 OpenAI Chat Completions 兼容协议，鉴权是 `Authorization: Bearer <access>` 加一组固定头，出站侧能用 `transformRequest` 完整补齐。

| 证据 | 位置 |
|---|---|
| 上游用 `@ai-sdk/openai-compatible` 声明模型 | `official/workbuddy/index.mjs:101`、`index.mjs:1756` |
| 对话基址为 `<endpoint>/v2`（宿主自动接 `/chat/completions`） | `official/workbuddy/index.mjs:104`、`index.mjs:1757` |
| 鉴权头与客户端身份头 | `official/workbuddy/index.mjs:269-284` |
| 出站 body 三步改写（system 补齐 / 工具 schema 修补 / tool_choice 归一） | `official/workbuddy/index.mjs:1811-1813` |

两处**响应侧**行为按规范不可转换，见「限制」第 1、2 条；它们不影响标准对话，只在工具名非法或令牌被拒时生效。

## 能力

| 能力 | 状态 | 说明 |
|---|---|---|
| 浏览器登录 | 可用 | 上游 `authorize()` 取登录页并返回 `callback()`，`callback()` 内部按 state 轮询令牌与账号信息（`index.mjs:1043-1080`）。适配层用 `flow: "panel"`：两个站点的授权地址一起交给面板，用户在面板里选站点，`poll()` 两条各自轮询、谁先成功用谁 |
| 令牌续期 | 可用 | 上游 `auth.refresh` 用 refresh token 换新令牌（`index.mjs:240-255`、`1791`），提前 5 分钟续期（`index.mjs:21` 的 `LEAD_MS`） |
| 模型列表 | 可用 | 上游 `provider.models` 读账号实时的 `/v3/config`（`index.mjs:1771-1781`、`1668-1712`）；读不到时回退 `config()` 声明的内置表（`index.mjs:1751-1759`） |
| 对话 | 可用（A 级） | OpenAI 兼容协议加 Bearer 鉴权，出站头与 body 由 `transformRequest` 按上游 `loader.fetch` 的出站部分补齐（`index.mjs:1804-1814`） |
| 额度面板 | 可用 | 上游 `auth.usage` 读 `/billing/meter/get-user-resource-summary`，企业账号回退 `get-enterprise-user-usage`（`index.mjs:1889-1942`、`1421-1449`） |
| 桌面端登录方式 | 未实现 | 上游第二个 oauth 方法 `desktopSignIn` 返回空 access（`index.mjs:1159`），要求每次请求重读 WorkBuddy 桌面端本地文件；Snow 档案只有一个静态 accessToken，语义不匹配。适配层固定取第一个（浏览器）方法 |

## 目录

| 文件 | 作用 |
|---|---|
| `oauth.mjs` | Snow OAuth 适配层（本插件入口），只做契约翻译；单个 provider 覆盖两个站点 |
| `panel/login.js` | 自定义登录面板入口（Snow 0.5.6+，单文件 ESM）：列出国版/国际版两个站点供选择 |
| `index.mjs` | 上游插件入口，原样保留（仅用 `node:` 内置模块，无相对 import） |
| `plugin.json` | Snow 插件清单 |

上游源目录里的 `*.test.mjs` 与 `testdata/` 未被 `index.mjs` import，按规范未复制。

## 转换要点

1. **流程映射**：上游 `authorize()` 返回 `{ url, instructions, method: "auto", callback() }`，`callback()` 不接受参数、自己轮询（`index.mjs:1059-1079`）。按规范用 `flow: "panel"` 加 `poll()`：`authorize()` 为两个站点各发起一次（上游授权是「取 state + authUrl 再轮询 token」，不占本地端口，两站可并行），把两条授权地址一起写进 `session`，面板让用户选；`poll()` 两条各自轮询，谁先成功用谁，并把命中的站点写进 `data.site`。
2. **一个 provider 覆盖两个站点**：站点表来自上游导出的 `_internal.SITES`（`index.mjs:63-83`，不复制常量）。provider 的 `id` 固定 `workbuddy`，`api.baseUrl` 取默认站点（国内版）；账号实际所属站点记在 `data.site`，`refresh` / `models` / `quota` / `transformRequest` 都按它选上游实例，出站 URL 由 `transformRequest` 改写 origin。
3. **令牌字段**：上游 `{access, refresh, expires}`（`expires` 为毫秒 epoch，`index.mjs:158-159`）映射为 Snow `{accessToken, refreshToken, expiresAt}`；`uid`、`domain`、`enterpriseId`、`refreshExpiresAt`、`tokenType` 放进 `data`，续期与企业头要靠它们还原（`index.mjs:292-295`）。
4. **续期只回变化字段**：上游 `refreshed()` 只返回与旧值不同的字段（`index.mjs:252-254`），适配层用 `ctx.account` 兜底合并。
5. **出站改写按上游顺序复刻**：删除宿主自带的 `authorization` / `x-api-key` / `content-length`，再按 `sign()` 重写头（`index.mjs:1804-1808`、`269-284`）；body 依次走 `withSystem`、`fitted`、`normalizeToolChoice`（`index.mjs:1811-1813`）；最后 `attend()` 补会话与请求 id（`index.mjs:439-452`）。这些函数全部来自上游导出的 `_internal`，未重写实现。
6. **会话 id 退化**：上游从 `chat.headers` 钩子拿会话 id（`index.mjs:1762-1766`），Snow 没有该钩子。适配层传空 session，上游会退回用首条 user 消息生成会话 id（`index.mjs:402-411`）。
7. **不落库**：上游用 `client.auth.set` 保存续期结果（`index.mjs:227`），Snow 由宿主按 `refresh()` 返回值落库，适配层传不落库的桩对象。
8. **quota 的 bucket key 必须是 `"window"`**：宿主的配额面板用白名单 switch 决定行标题（`ChatContent.js` 的 `bucketLabel()`），只有 `case "window"` 会返回 `bucket.label` 原文，其余未知 key 一律显示「其他」。所以具体数值（如 `Credits 0.44 / 350`）必须写进 `label`，key 固定为 `"window"`。右侧的「剩余 N%」由宿主按 `remainingPercent` / `usedPercent` 计算，插件无法替换成别的文案。
9. **名字与图标**：名字取自 provider 的 `name`，即「产品名 + 版本」（版本从同目录 `plugin.json` 读，不会不同步）。图标用国内版站点的官方 logo `icon-workbuddy-cn.svg`（从 copilot.tencent.com 的 `<link rel="icon">` 下载，自带渐变色，不依赖主题）；`icon-workbuddy-ai.svg` 是国际版站点的图标，合并后不再被引用（文件保留）。`headerScheme` 固定为不带版本的产品名 `WorkBuddy`，避免自定义请求头方案名跟着版本变。

## 安装

```powershell
# 目录名必须等于 plugin.json 的 id
Copy-Item -Recurse "F:\desktop\code\snow-plugins\snow-oauth-plugins\workbuddy-oauth" "$env:USERPROFILE\.snowapp\plugins\workbuddy-oauth"
```

然后重启 Snow App，或在「设置 - 插件」中重新扫描。打开「设置 - API 设置 - OAuth 登录」，来源列表只出现一个「WorkBuddy 登录」；国内版与国际版都在它的登录面板里选。

## 使用

1. 选择「WorkBuddy 登录」，点「开始登录」
2. 登录弹窗内出现面板，里面有「WorkBuddy 国内版」与「WorkBuddy 国际版」两个按钮（各显示站点域名）
3. 点对应站点（**面板不会自动打开浏览器**），在浏览器完成登录
4. Snow 每 2 秒轮询，任一站点的授权先完成就建档激活；命中的站点记进档案，之后续期/模型/额度/对话都按它走

旧版宿主（0.5.5 及以前）忽略 `panel`：退回 device 流程，宿主用默认站点（国内版）打开浏览器，操作方式相同。

## 限制

1. **工具名回改不可用（响应侧）**：上游会把不合法的工具名改成安全名再发给 WorkBuddy，并在响应里把模型返回的调用名改回客户端原名（`index.mjs:902-943`、`979-1024`、`1882`）。Snow 只有出站改写钩子，改回这一步无法执行。请让工具名只使用字母、数字、下划线与横线（上游的 `NAME_OK`，`index.mjs:658`），此时不会触发改名。
2. **401 自动重发不可用（响应侧）**：上游在 401 时用另一个 access token 重发一次请求（`index.mjs:1838-1852`）。Snow 无响应钩子。令牌过期依赖 `refresh` 钩子提前 5 分钟续期；若仍被拒，会直接报错，重新登录即可。
3. **拒绝原因提示不可用（响应侧）**：上游把 `unapproved channel`、`11140`、`14018` 三类拒绝改写成带处理建议的错误（`index.mjs:1968-1991`、`2006-2043`）。Snow 下这些错误原样透出。
4. **桌面端登录未接入**：见能力表最后一行。
5. **企业账号头**：`X-Enterprise-Id` / `X-Tenant-Id` 来自登录时写入的 `data.enterpriseId`（`index.mjs:292-295`）。若企业归属在登录后变化，需要重新登录刷新。
6. **额度包重置时间**：额度面板的 bucket 标签用上游的 `name` 与 `display` 拼接（`index.mjs:1428`、`1443`）。个人账号的额度包不带重置时间，bucket 因此没有 `resetAt`；只有企业账号的 `cycleResetTime` 存在时才有值（`index.mjs:1446`）。已实测确认（见下节）。

## 实测记录（2026-10-26，本机 Snow App 0.5.4）

| 项 | 结果 | 证据 |
|---|---|---|
| 插件加载 | 通过 | 宿主日志 `module=oauthPlugins`，`func=workbuddy` / `func=workbuddy-ai` 均有 `sign-in started`，无 WARN/ERROR |
| 登录（国际版） | 成功 | 档案 `workbuddy-ai-l6050293`，`source=oauth-workbuddy-ai`，`data.uid=0833463f-1877-4348-91fa-e6c1af4385ce` |
| 对话 | 成功 | `POST https://www.workbuddy.ai/v2/chat/completions`（stream:true）→ HTTP 200，SSE 返回标准 `chat.completion.chunk`，内容 `pong` |
| 配额 | 成功 | `plan=Free`，bucket `Credits 0.44 / 350`（`usedPercent` 0.126） |

### 已知现象：首次登录后立刻查配额会报服务端错误

现象：配额面板显示

```
配额查询失败：10084:GetUserResourceSummary GetUsageCache failed: 9999:cache is empty, key: measure:usage:<uid>, userID:<uid>
```

原因链（全部在源码里可查）：

1. 上游 `usage()` 调 `/billing/meter/get-user-resource-summary`（`index.mjs:1895`、`1902`）。
2. 服务端返回 HTTP 200 但体内 `code=10084`，msg 说明该 uid 的用量缓存为空。
3. 上游 `meter()` 对 `code≠0` 一律按硬错误抛出（`index.mjs:1707-1718`），`usage()` 外层兜成 `{error, signIn:"kept"}`（`index.mjs:1939-1941`）。
4. 上游的企业回退只在「summary 读成功但 `windows` 为空」时触发（`index.mjs:1922-1928`），**summary 直接报错时不会回退**。
5. 适配层把这个 error 原样抛出（`oauth.mjs:276`），宿主显示在配额面板。

结论：**不是插件故障**。服务端按 uid 聚合的用量缓存尚未生成，同账号约 10 分钟后重查即恢复正常（已实测）。登录与对话不受影响。

> 上游对企业账号存在一个缺陷：summary 报错会阻断 `get-enterprise-user-usage` 回退（第 4 点）。本插件不改动上游业务逻辑，因此企业账号遇到 summary 报错时同样只能等缓存生成。


## 校验

```powershell
cd F:\desktop\code\snow-plugins\snow-oauth-plugins
node _shared\verify.mjs workbuddy-oauth
node _shared\harness.mjs workbuddy-oauth
```
