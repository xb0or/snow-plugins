# 商汤小浣熊登录（raccoon-oauth）

本插件是上游 OpenCode provider 插件的 Snow App 适配层，只导出一个 provider，登录弹窗里同时提供「浏览器授权自动回调」与「粘贴回调链接」两条路；上游实现原样保留在 `index.mjs`。

- 插件类型：纯 OAuth 插件（`plugin.json` 只声明 `oauth.entry`，无渲染层面板）
- 版本：0.1.0
- 作者：kedou

## 可转换性分级：A 级（完整可用）

| 项 | 结论 | 证据 |
|---|---|---|
| 判定 | **A 级**：对话端点就是 OpenAI Chat Completions，鉴权只需 `Authorization: Bearer <jwt>` | 见下三行 |
| 协议 | `@ai-sdk/openai-compatible`，基址 `${mainOrigin}/api/web/llm/v2`，对话在 `/chat/completions` | `official/raccoon/index.mjs:17`、`21`、`947-949` |
| 鉴权 | `headers.set("Authorization", "Bearer " + cred.access)`，并删掉 `x-api-key` | `official/raccoon/index.mjs:982-995` |
| 请求侧改写 | 只有头（删 `x-api-key`、删 `content-length`、固定 `Content-Type`/`Accept`），没有改 URL、没有改正文 | `official/raccoon/index.mjs:982-995` |

上游唯一的响应侧动作是 `rewriteSseModel()`（`official/raccoon/index.mjs:407-465`），它只把响应里的 `model` 字段改回请求时的名字，并把续期状态写进 `X-Magpie-Sign-In` 头。这属于锦上添花：不改也能正常解析 OpenAI 分片，因此不构成 B 级限制。Snow 没有该钩子，适配层不做这一步，代价只是响应里的 `model` 名可能与请求名不同。

## 能力

| 能力 | 状态 | 说明 |
|---|---|---|
| 登录（浏览器） | 可用 | 上游 `browserSignIn()` 在 127.0.0.1 起回调服务器，授权页跳回 `/auth/callback?code=...&state=...`，再换令牌（`index.mjs:776-840`、`739-757`） |
| 登录（手动粘贴） | 可用 | 上游 `manualSignIn()` 的 `callback(input)` 接受回调链接、JSON 或裸 JWT（`index.mjs:842-860`、`711-737`） |
| 登录（读本机客户端登录态） | 未实现 | 上游 `desktopSignIn()`（`index.mjs:862-889`）的 `url` 是空串，Snow 的登录 UI 需要一个可打开的 http(s) 地址；且它读 `~/.box-agent/config/auth.json`，属于本机文件登录态而非 OAuth 流程 |
| 令牌续期 | 可用 | 上游 `auth.refresh` 调 `/api/web/auth/v1/refresh`（`index.mjs:932-943` -> `149-181`），单飞合并并发续期 |
| 模型列表 | 可用 | 读 `/model_catalog`（`index.mjs:914-927` -> `339-356`），失败回退 `config()` 的静态表（`index.mjs:358-375`） |
| 对话 | 可用（A 级） | OpenAI Chat Completions + Bearer，见上表 |
| 额度面板 | 可用 | 上游 `auth.usage` 汇总积分余额与账单窗口（`index.mjs:1011-1042` -> `533-597`） |
| 每日签到 | 未实现 | 上游 `auth.checkin`（`index.mjs:1043-1062` -> `614-699`）在 Snow 宿主没有对应钩子，无法触发 |

## Provider

| provider id | flow | 说明 |
|---|---|---|
| `raccoon` | `panel` | 单一入口，两条路：浏览器授权 + 127.0.0.1 本地回调自动完成（`methods[0]`，`index.mjs:1064-1068`）；或把回调链接粘回来，走 `exchange()` → 上游 `callback(input)`（`methods[2]`，`index.mjs:1074-1078`） |

`authorize()` 起本地回调服务器的同时，会把上游 `methods[2]` 的手动粘贴 callback 一起备好（`prepareManualCallback()`），所以一个 provider 就能承载两条路。`raccoon-manual` 已并入 `raccoon`：早期版本在来源列表里会看到两个卡片，现在只有一个。

`api.baseUrl` = `https://xiaohuanxiong.com/api/web/llm/v2`（`index.mjs:21`），`api.defaultModel` = `raccoon-chat-ml-5-5`（静态表里标"默认"的那一项，`index.mjs:44`）。

注意：上游三个登录方式都用 `type: "oauth"`（`index.mjs:1063-1079`），适配层按 `label` 区分，不改上游。

## 目录

| 文件 | 作用 |
|---|---|
| `oauth.mjs` | Snow OAuth 适配层（本插件入口），只做契约翻译 |
| `panel/login.js` | 自定义登录面板入口（Snow 0.5.6+，单文件 ESM）：两条路都在这个面板里 |
| `index.mjs` | 上游插件入口，原样保留（上游是单文件插件，只 import `node:` 内置模块，没有相对依赖，也没有同名 `oauth.mjs` 需要重命名） |
| `plugin.json` | Snow 插件清单 |
| `README.md` | 本文件 |

## 转换要点

1. **两种流程并存**：上游 `browserSignIn()` 的 `callback()` 不接受参数、自己等本地回调（`index.mjs:834-839`）-> 用 `flow: "device"` + `poll()`，`authorize()` 返回 `{url, instructions, interval: 2, expiresIn: 600}`，不返回 `userCode`。上游 `manualSignIn()` 的 `callback(input)` 需要用户输入（`index.mjs:850`）-> 用 `flow: "manual"` + `exchange()`，把 Snow 的 `ctx.code` 直接交给上游。
2. **手动登录的输入顺序**：`exchange()` 先校验输入是否为空，再消耗待用的上游回调。否则一次空提交会让本次登录作废（这是适配层自己发现的缺陷，已修正）。
3. **定时器与监听句柄**：上游 `browserSignIn()` 起 `node:http` 服务器（`index.mjs:792-829`）并挂 10 分钟定时器（`index.mjs:832`，已自带 `unref`）。适配层额外在 `authorize()` 期间把新建监听句柄与新建定时器 `unref()`，避免离线 harness 被挂住。
4. **令牌字段**：上游 `{access, refresh, expires}`（`expires` 是 JWT 的 exp 毫秒，`index.mjs:66-70`）映射为 Snow `{accessToken, refreshToken, expiresAt}`。
5. **扩展字段落库**：`uid / name / source / onboardingSettled` 塞进 Snow 的 `data`，`refresh/models/quota` 时还原。`source === "desktop"` 会让上游走"读本机客户端"分支（`index.mjs:233-258`），本插件不产生该值。
6. **出站改写**：只复现上游 `loader.fetch` 里属于出站的头（`index.mjs:982-995`），返回 `{headers}`，不动 url 与 body。
7. **续期失败不伪造**：上游在无 refresh token 或桌面端登录态时返回 `undefined`（`index.mjs:933`），适配层转成明确抛错。
8. **quota 的 bucket key 必须是 `"window"`**：宿主的配额面板用白名单 switch 决定行标题（`ChatContent.js` 的 `bucketLabel()`），只有 `case "window"` 会原样返回 `bucket.label`，其余未知 key 一律显示「其他」。所以额度窗口的 `key` 固定为 `"window"`，具体数值写进 `label`：上游 `windows[]` 的 `display`（`index.mjs:581` 拼的 `used / granted`）优先，与窗口名拼接，`display` 缺失时才用 `amount/limit/unit` 兜底（上游同时给了这三个字段，`index.mjs:582-584`）。没有可核算账单时上游只给 `balance`（`index.mjs:594`，形如 `350 credits`），那个 bucket 同样用 key `"window"`，数值直接写在 label 里。右侧的「剩余 N%」由宿主按 `usedPercent` 算，插件无法把数值放到那里。
9. **provider 列表的名字与图标**：名字取自 provider 的 `name`，即「产品名 + 版本」（版本从同目录 `plugin.json` 读，不会不同步）：`Raccoon (SenseTime) v0.1.0` / `商汤小浣熊 v0.1.0`。图标取自 provider 的 `icon`：
   - `icon-raccoon.svg` <- `https://sta-volc.xiaohuanxiong.com/raccoon-website/prod/mime-v1/favicon.svg`（xiaohuanxiong.com 首页 `<link rel="icon">` 指向的文件，1757 字节，自带 `#fff` / `#192842` 双色填充）

   `headerScheme` 是不带版本的产品名 `Raccoon (SenseTime)`；不声明 `icon` 时宿主显示默认的钥匙图标。`icon-raccoon-manual.svg`（Lucide `clipboard-paste`）是早期第二个 provider 用的图标，`raccoon-manual` 并入 `raccoon` 后已不再被引用（文件保留，不影响加载）。

## 安装

```powershell
Copy-Item -Recurse "F:\desktop\code\snow-plugins\snow-oauth-plugins\raccoon-oauth" "$env:USERPROFILE\.snowapp\plugins\raccoon-oauth"
```

然后重启 Snow App，或在「设置 -> 插件」中重新扫描。打开「设置 -> API 设置 -> OAuth 登录」，来源列表只出现一个「商汤小浣熊 v0.1.0」（名字里带当前插件版本，见转换要点第 9 条）；两条登录路径都在它的面板里。

## 使用

只有一个入口「商汤小浣熊」，面板里两种方式任选：

方式一（浏览器授权，自动完成）：

1. 选择「商汤小浣熊」-> 点「开始登录」，登录弹窗内出现面板
2. 点面板里的「打开授权页」（**面板不会自动打开浏览器**），在浏览器完成登录并确认授权
3. 授权页跳回 `127.0.0.1` 的本地回调，Snow 自动完成建档

方式二（粘贴回调链接）：

1. 同样点「打开授权页」在浏览器完成授权
2. 复制浏览器最后跳转的 `office-raccoon://auth/callback?code=...` 链接（也支持直接粘贴 JWT access_token 或含 `access_token` 的 JSON）
3. 回到面板粘贴并点「提交」（Ctrl/Cmd+Enter 也可提交）

两条路落到同一个登录会话，谁先完成算谁。旧版宿主（0.5.5 及以前）忽略 `panel`：退回 device 流程（宿主自动打开浏览器、弹窗内提供粘贴框），操作方式相同。

## 限制

- 上游读本机客户端登录态的方式（`~/.box-agent/config/auth.json`）未导出：Snow 的登录入口需要可打开的 http(s) 地址，且这属于本机文件登录态，不是 OAuth 流程。
- 响应侧 `rewriteSseModel()`（`index.mjs:407-465`）不可转换：Snow 无响应改写钩子。影响仅是响应 `model` 字段可能保留上游原名。
- 每日签到（`index.mjs:1043-1062`）无宿主钩子，未实现。
- 上游 `models` 在无令牌时用静态表兜底（`index.mjs:922-926`），适配层沿用，因此未登录也会列出模型名。
- 环境变量 `RACCOON_MAIN_SITE_URL` / `RACCOON_AUTH_API_BASE` / `RACCOON_LLM_BASE_URL` 可改上游基址（`index.mjs:19-21`）；`api.baseUrl` 是静态值，若改了环境变量需要自行同步清单。

## 校验

```powershell
cd F:\desktop\code\snow-plugins\snow-oauth-plugins
node _shared\verify.mjs raccoon-oauth
node _shared\harness.mjs raccoon-oauth
```
