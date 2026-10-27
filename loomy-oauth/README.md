# Loomy 登录（loomy-oauth）

本插件是上游 OpenCode provider 插件的 Snow App 适配层，上游实现原样保留在 `index.mjs`（逐字节复制，未改一行）。上游做的是讯飞 Loomy 账号的手机验证码登录、Loomy 的 OpenAI 兼容模型网关转发、双钱包积分与每日 first-login 刷新。

- 插件类型：纯 OAuth 插件（`plugin.json` 只声明 `oauth.entry`，无渲染层面板）
- 版本：0.1.0
- 作者：kedou
- provider id：`loomy`（只有一个 provider）

## 手机验证码怎么采集：本地服务 + 插件登录面板

结论：上游用 `prompts` 采集输入、`authorize()` 返回的 `url` 是空串，**没有可复用的登录页**；适配层因而自建一个只监听 `127.0.0.1` 的 `node:http` 服务（跑在 Electron 主进程）承担发短信与验证码换会话，界面由 Snow 0.5.6 的**自定义登录面板**（`panel/login.js`）在登录弹窗内接管——`flow: "panel"`，宿主不再自动打开浏览器。

判定依据（全部落在上游源码上）：

| 事实 | 位置 |
|---|---|
| 登录方式声明 `prompts: [{ type:"text", key:"phone", message:"手机号（11 位，不带 +86）" }]` | `index.mjs:379-390` |
| `authorize(inputs)` 直接读 `inputs.phone`，非法就抛错（`请填写 11 位中国大陆手机号`） | `index.mjs:391-395` |
| 发短信走账号主机 `POST /login/phone/sendMsgCode`，成功后返回 `url: ""`、`method: "code"`、`instructions` 与 `callback` | `index.mjs:396-407` |
| 验证码经 `callback(code)` 交回（六位数字校验 + `POST /login/phone/checkCode`） | `index.mjs:408-428` |

Snow 的 OAuth 契约没有输入提示（prompts）钩子，用户可提供的输入只有两种：`manual` 的一个「回调地址」粘贴框，或 `device` 的 URL + 轮询。手机号与短信验证码是两次交互式的输入，且上游 `callback(code)` **接受参数**（不是自己等回调），所以既不复用上游页面，也不能塞进 `manual`

流程（`oauth.mjs` 的 `authorize` / `submitPhone` / `submitCode` / `poll`，加上面板 `panel/login.js`）：

1. `authorize()` 起一个只监听 `127.0.0.1` 的 `node:http` 服务（随机端口），返回 `{ url: "http://127.0.0.1:<port>/", instructions, interval: 2, expiresIn: 600, session: { port } }`，不返回 `userCode`；端口经 `api.oauth.session.pluginSession.port` 交给面板；
2. 面板（`panel/login.js`，单文件 ESM、零依赖）`POST /send` 提交手机号，服务转手调上游 `authorize({ phone })` 发短信，把上游返回的提示原文（含打码手机号 `138****8000`）显示在面板上；
3. 面板切到验证码输入，`POST /verify` 提交六位验证码，服务调上游 `callback(code)` 换会话（十四天）；失败时把上游错误原文显示出来并允许重填；
4. `poll()` 每 2 秒被宿主调用一次，面板完成登录后返回标准化令牌对象，并收掉本次的监听句柄。

其它工程细节：

- **句柄与定时器 unref**：本次 `authorize()` 新建的监听句柄与 10 分钟超时定时器都调了 `unref()`，登录行为不变，但只靠事件循环退出的调用方（离线契约 harness、CLI）不会被挂住；
- **超时**：10 分钟（`expiresIn`）后页面与 `poll()` 一并报「登录已超时，请回到 Snow App 重新发起登录」，不伪造成功；
- **不做落库**：上游只用 `client.auth.set` 保存登录态（`index.mjs:609-726` 的插件形态里用 `client`），Snow 由宿主按钩子返回值落库，适配层传一个不落库的桩。

## 可转换性分级：A 级

判定依据：上游对话端点就是 OpenAI Chat Completions 兼容协议，鉴权是 `Authorization: Bearer <session>` 加一个 `token` 头，出站侧可用 `transformRequest` 完整补齐；上游对请求体原样透传，没有出站 body 改写。

| 证据 | 位置 |
|---|---|
| 上游用 `@ai-sdk/openai-compatible` 声明协议形态 | `index.mjs:24` |
| 对话基址 `<集成网关>/api/v1`，模型记录的 url 是 `apiBase() + "/chat/completions"` | `index.mjs:32-34`、`index.mjs:190` |
| 鉴权头：`token: <session>` 与 `Authorization: Bearer <session>` 双写，另有 `Accept: text/event-stream` | `index.mjs:643-647` |
| 请求体取自调用方并原样发出（`loader.fetch` 未改 body） | `index.mjs:635-658` |
| 会话 token 同时是模型网关的令牌（登录返回的 `session`） | `index.mjs:422-424` |

**响应侧不可转换的部分**（Snow 没有响应改写钩子）：上游把「额度不足」的 402/403/429 改写成 429 `rate_limit_error`，把 401 与两条失效业务码判成登录失效，并给保住的响应加一个内部标记（`index.mjs:579-607`）。这些只在被拒时生效，不影响正常对话；在 Snow 下拒绝会原样透出。

## 能力

| 能力 | 状态 | 说明 |
|---|---|---|
| 手机验证码登录 | 可用（自建本地页） | 上游 `prompts` + `authorize(inputs)` + `callback(code)`（`index.mjs:379-428`），适配层用本地表单页承载，映射为 `device` + `poll()` |
| 令牌续期 | 不提供 | 会话 14 天且上游没有续期协议（`index.mjs:27` 的 `SESSION_MS`、`index.mjs:423` 的 `refresh: ""`）。**适配层不导出 `refresh`**，到期只能重新短信登录 |
| 模型列表 | 可用 | 上游 `provider.models` 有会话时读实时 `GET /api/v1/models`（`index.mjs:713-724`、`717`），无会话或拉取失败时回退 `config()` 填出的内置表（`index.mjs:613-621`、`54-65`） |
| 对话 | 可用（A 级） | OpenAI Chat 形态 + 双头鉴权，出站头由 `transformRequest` 按上游 `loader.fetch` 的出站部分复刻（`index.mjs:643-647`） |
| 额度面板 | 可用 | 上游 `auth.usage` 把积分摘要挂在积分流水查询上，给出两个钱包：每日赠送（有窗口）与永久积分（无窗口，`used` 恒 0）（`index.mjs:673-691`、`475-494`） |
| 每日 first-login 签到 | 未接入 | 上游的 `checkin`（`index.mjs:694-703`，`POST /api/v1/points/first-login`）在上游宿主里由「Daily check-in」开关驱动。**Snow 的 OAuth 契约没有签到钩子**，本插件不执行签到、也不把签到结果伪造进额度面板 |
| 账号面 HMAC-SHA1 签名 | 上游原样保留 | 发往账号主机（发码 / 验码）的每个请求都由上游签名（`index.mjs:198-234`、`317-337`）。这是上游对**账号面**的出站行为，不是对话请求，适配层不动它 |

## 目录

| 文件 | 作用 |
|---|---|
| `oauth.mjs` | Snow OAuth 适配层（本插件入口），只做契约翻译 + 自建本地发码/验码服务 |
| `panel/login.js` | 自定义登录面板入口（Snow 0.5.6+，单文件 ESM），手机号与验证码两步界面 |
| `index.mjs` | 上游插件入口，逐字节原样保留（只 import `node:crypto`，无相对依赖） |
| `plugin.json` | Snow 插件清单 |
| `icon.png` | provider 图标（见下节） |

上游源目录里的 `*.test.mjs`、`fake.mjs`、`scripts/`、`nonet.mjs` 未复制：`index.mjs` 没有 import 它们（`index.mjs:21` 只 import `node:crypto`）。

## 转换要点

1. **流程映射**：上游 `authorize(inputs)` 需要手机号（`index.mjs:391-397`），返回 `{ url: "", instructions, method: "code", callback(code) }`（`index.mjs:404-428`）。适配层自建本地页承载输入，`authorize()` 返回该页 URL，`poll()` 等页面完成。
2. **令牌字段**：上游 `{ access, refresh: "", expires(毫秒 epoch), accountId(打码手机号), uid }`（`index.mjs:420-427`）映射为 Snow `{ accessToken, refreshToken: "", expiresAt, accountId }`，`uid` 放进 `data`。
3. **配额 bucket key 必须是 `"window"`**：宿主配额面板的行标题是白名单 switch，只有 `case "window"` 会原样显示 `bucket.label`，其余未知 key 一律显示成「其他」；右侧又固定只显示宿主算出的「剩余 N%」。所以具体数值（如 `每日赠送 剩余 1200 / 限额 2000`、`永久积分 3500 积分`）全部写进 `label`，`key` 固定为 `"window"`。
4. **不做桶的 `resetAt`**：上游「每日赠送」窗口只带一个 `span: 86400` 的时长，没有重置时间戳（`index.mjs:488`），所以本插件不输出 `resetAt`，不猜时间。
5. **不导出 `refresh`**：上游没有续期协议，续期钩子会变成造假实现。
6. **出站改写按上游原样复刻**：只加 `token`、`Authorization: Bearer`、`Accept: text/event-stream` 三个头（`index.mjs:645-647`），请求体不动。
7. **provider 列表的名字与图标**：名字取自 provider 的 `name`，即「产品名 + 版本」（版本从同目录 `plugin.json` 读，不会不同步）；`headerScheme` 显式设为不带版本的产品名，避免自定义请求头方案名跟着版本变。

## 图标来源

Loomy 官方站点 `https://loomy.xunfei.cn` 的 `<link rel="icon">` 指向 `https://loomy.xunfei.cn/icon.png?5f7e7b8be5d4c76b`（1024x1024 PNG，670506 字节）。宿主对插件内图标文件有 512KB 上限，所以本插件保存的是该官方图标的等比缩放版（256x256 PNG，88945 字节，内容不变），文件名 `icon.png`。该 logo 自带固定色（非 `stroke="currentColor"`），深浅主题下都能正常显示。

站点探测命令与结果：

```powershell
node _shared\fetch-site-icon.mjs "https://loomy.xunfei.cn" ".\loomy-oauth\icon.svg"
# 唯一候选 icon.png 为 670506 字节，超过 512KB 上限，被工具跳过（favicon.svg / .ico / logo.svg 均 404）
```

## 安装

```powershell
# 目录名必须等于 plugin.json 的 id
Copy-Item -Recurse "F:\desktop\code\snow-plugins\snow-oauth-plugins\loomy-oauth" "$env:USERPROFILE\.snowapp\plugins\loomy-oauth" -Force
```

然后重启 Snow App，或在「设置 - 插件」中重新扫描。打开「设置 - API 设置 - OAuth 登录」，来源列表出现「Loomy 登录」，内含 provider `loomy`。

## 使用

1. 选择「Loomy 登录」下的 `loomy`，点「开始登录」
2. 登录弹窗内出现插件面板，填 11 位手机号（不带 `+86`）后点「发送验证码」
3. 填收到的六位验证码后点「登录」，面板提示成功后本窗口自动完成
4. 档案自动创建并激活，模型列表来自 `GET /api/v1/models`

旧版宿主（0.5.5 及以前）忽略 `panel`：退回 device 流程，宿主打开 `http://127.0.0.1:<随机端口>/` 上的本地表单页，操作方式相同。

## 限制

1. **会话 14 天且无法续期**：上游没有 refresh 协议（`index.mjs:27`、`423`）。到期后只能重新走一次短信登录。适配层因此不导出 `refresh`，也不会伪造续期。
2. **每日签到不在本插件内**：见能力表最后一行。Loomy 的「签到」就是客户端每次登录都会调的 first-login（`index.mjs:694-703`，`/api/v1/points/first-login`），Snow 没有对应钩子，所以本插件不执行它，额度面板上也不会出现签到结果。签到确实会刷新每日赠送额度，但需要在 Loomy 客户端里完成。
3. **响应侧错误改写不可用**：额度不足的 402/403/429 在上游会被改写成 429 `rate_limit_error`，登录失效会被抛成可引导重新登录的错误（`index.mjs:579-607`）。Snow 只有出站改写钩子，这些拒绝会原样透出。
4. **积分倍率只是展示名后缀**：上游把倍率从模型展示名里拆出来（`index.mjs:83-97`），Loomy 没有结构化的倍率字段，插件无从核对数额。
5. **图片输入按模型家族而不同**：deepseek 系只认网关私有的 `<image_base64>` 标记，GLM 系只认标准 `image_url`；上游把这条改写列为二期增强（上游 README「Known limits」一节），落地前图片输入只在 GLM 系可靠。本插件同样不做该改写（请求体原样透传）。
6. **流式 tool_calls 未经真机验证**：上游 README 明确记录该路径没有实机跑过，首次使用请用你的工具循环验证。
7. **onboarding 新手任务不代领**：Loomy 新手任务的一次性奖励留给 Loomy 客户端（上游 README「Known limits」一节）。
8. **未做真机登录实测**：本轮只跑了结构校验与离线契约 harness（见下节），没有真实 Loomy 账号可以完成短信登录，因此「登录成功、对话可用、额度正确」这三项尚未在真机上验证。

## 校验

```powershell
cd F:\desktop\code\snow-plugins\snow-oauth-plugins
node _shared\verify.mjs loomy-oauth
node _shared\harness.mjs loomy-oauth
node _shared\check-installed.mjs "$env:USERPROFILE\.snowapp\plugins\loomy-oauth"
```

`harness.mjs` 是完全离线的契约校验：它把 `globalThis.fetch` 换成直接抛错的桩，验证「钩子在网络不可用时明确失败而不是伪造成功」「`poll()` 在没有进行中登录时抛错」「`transformRequest()` 纯本地计算且形状合法」等语义。它不验证真实登录能否成功。
