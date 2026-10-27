# Snow App 插件集（by kedou）

以下插件均已上架 [snow-plugin-store](https://github.com/MayDay-wpf/snow-plugin-store) 索引（PR 合并后可一键安装）：

## 面板插件

- [snow-tps-metrics](./snow-tps-metrics) — 任务中心：行业口径 TPS/TTFT 指标 + 全部运行中会话（含子代理）实时总览 + 各会话使用模型
- [snow-usage-cost](./snow-usage-cost) — 成本核算看板：内置官方刊例/OpenRouter 换算单价，按模型与每日成本核算，支持从 OpenRouter 一键同步价格
- [snow-skill-store](./snow-skill-store) — 技能商店：聚合公开技能索引（官方技能 / 本地技能 / 社区源 / skills.sh），搜索与分类过滤，全局或项目级一键安装或让 AI 代装
- [snow-stt-launcher](./snow-stt-launcher) — 本地语音服务（面板插件）：启动 / 停止 / 重启本机 whisper.cpp 转写服务，自动择优 CUDA / Vulkan / CPU 推理后端，并管理识别模型
- [snow-anon-chat](./snow-anon-chat) — 匿名聊天：接入 hack.chat（界面显示 ?SNOW），昵称持久化不随重连变化；支持 Markdown 消息格式（粗体/斜体/代码块/链接/图片/表格/公式源码等，面板内置写法帮助）；因宿主 CSP 限制经本机零依赖桥进程中转，支持代理自动探测，需 Node.js 14+
- [snow-side-ask](./snow-side-ask) — 旁路问答：在面板内用自己的输入框提问，回答只流式显示在面板里，不回填输入框、不发送、不写入会话历史；自动携带焦点会话作为上下文并在切换会话时刷新；「进度报告」可按 `/btw` 语义对主会话当前任务生成进度总结（主会话运行中还能按间隔自动生成）；走宿主内部流式通道且请求不传 conversationId，宿主升级后可能失效

## OAuth 插件

以下三个是「设置 → API 设置 → OAuth 登录」里的登录来源，需要在 Snow App 0.5.6+ 使用（自定义登录面板与响应侧钩子由 0.5.6 引入）：

- [loomy-oauth](./loomy-oauth) — 讯飞 Loomy 登录：手机号 + 短信验证码直接在登录弹窗的面板里完成（适配层起只在 127.0.0.1 监听的本地服务负责发码与验码），登录后使用其 OpenAI 兼容模型网关；会话 14 天、无续期
- [raccoon-oauth](./raccoon-oauth) — 商汤小浣熊登录：单一入口两种方式——点「打开授权页」在浏览器授权后由 127.0.0.1 本地回调自动完成，或把浏览器最后的 `office-raccoon://auth/callback?code=…` 链接（也支持 JWT）粘回面板提交
- [workbuddy-oauth](./workbuddy-oauth) — WorkBuddy 登录（国内版 / 国际版）：一个 provider 覆盖两个站点，面板里选站点；命中站点记进档案，之后续期 / 模型 / 额度 / 对话都按它走，出站 URL 由 `transformRequest` 改写 origin

## 客户端脚本

- [snow-voice-io](./snow-voice-io) — 本地语音服务（客户端脚本）：语音输入（录音经本机 whisper 转写后回填输入框，静音自动停止、分段实时出字、可自定义快捷键）+ 回合结束时朗读 AI 回复
- [snow-notify-hub](./snow-notify-hub) — 通知推送中心：一轮 AI 回复结束时通过 7 个渠道推送提醒（Server酱 / PushPlus / Bark / 钉钉 / 企业微信 / Telegram / 飞书），并可播放提示音、显示应用内提示条；支持后台会话（切到其他会话时原会话跑完也提醒）。顶栏右侧的铃铛按钮可打开设置浮层（有待办时在待办列表按钮右侧，无待办时停在标题组右侧）

> 「本地语音服务」的面板插件与客户端脚本**需配合使用**：面板负责起服务与管理模型，
> 脚本负责录音与朗读。只装其一无法完成语音输入——两者通过 `127.0.0.1:8791` 通信，可独立升级。

零依赖、纯原生 JS + 宿主 React，MIT。
