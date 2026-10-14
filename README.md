# Snow App 插件集（by kedou）

以下插件均已上架 [snow-plugin-store](https://github.com/MayDay-wpf/snow-plugin-store) 索引（PR 合并后可一键安装）：

## 面板插件

- [snow-tps-metrics](./snow-tps-metrics) — 任务中心：行业口径 TPS/TTFT 指标 + 全部运行中会话（含子代理）实时总览 + 各会话使用模型
- [snow-usage-cost](./snow-usage-cost) — 成本核算看板：内置官方刊例/OpenRouter 换算单价，按模型与每日成本核算，支持从 OpenRouter 一键同步价格
- [snow-skill-store](./snow-skill-store) — 技能商店：聚合公开技能索引（官方技能 / 本地技能 / 社区源 / skills.sh），搜索与分类过滤，全局或项目级一键安装或让 AI 代装
- [snow-stt-launcher](./snow-stt-launcher) — 本地语音服务（面板插件）：启动 / 停止 / 重启本机 whisper.cpp 转写服务，自动择优 CUDA / Vulkan / CPU 推理后端，并管理识别模型

## 客户端脚本

- [snow-voice-io](./snow-voice-io) — 本地语音服务（客户端脚本）：语音输入（录音经本机 whisper 转写后回填输入框，静音自动停止、分段实时出字、可自定义快捷键）+ 回合结束时朗读 AI 回复
- [snow-notify-hub](./snow-notify-hub) — 通知推送中心：一轮 AI 回复结束时通过 7 个渠道推送提醒（Server酱 / PushPlus / Bark / 钉钉 / 企业微信 / Telegram / 飞书），并可播放提示音、显示应用内提示条；支持后台会话（切到其他会话时原会话跑完也提醒）。顶栏待办列表旁的铃铛按钮可打开设置浮层

> 「本地语音服务」的面板插件与客户端脚本**需配合使用**：面板负责起服务与管理模型，
> 脚本负责录音与朗读。只装其一无法完成语音输入——两者通过 `127.0.0.1:8791` 通信，可独立升级。

零依赖、纯原生 JS + 宿主 React，MIT。
