# Snow App 插件集（by kedou）

以下插件均已上架 [snow-plugin-store](https://github.com/MayDay-wpf/snow-plugin-store) 索引（PR 合并后可一键安装）：

## 面板插件

- [snow-tps-metrics](./snow-tps-metrics) — 任务中心：行业口径 TPS/TTFT 指标 + 全部运行中会话（含子代理）实时总览 + 各会话使用模型
- [snow-usage-cost](./snow-usage-cost) — 成本核算看板：内置官方刊例/OpenRouter 换算单价，按模型与每日成本核算，支持从 OpenRouter 一键同步价格；价格配置会作为快照对外发布，供「会话统计条」脚本复用同一套单价（v1.2.4 修非缓存输入单价取键错误）
- [snow-skill-store](./snow-skill-store) — 技能商店：聚合公开技能索引（官方技能 / 本地技能 / 社区源 / skills.sh），搜索与分类过滤，全局或项目级一键安装或让 AI 代装
- [snow-stt-launcher](./snow-stt-launcher) — 本地语音服务（面板插件）：启动 / 停止 / 重启本机 whisper.cpp 转写服务，自动择优 CUDA / Vulkan / CPU 推理后端，并管理识别模型
- [snow-anon-chat](./snow-anon-chat) — 匿名聊天：接入 hack.chat（界面显示 ?SNOW），昵称持久化不随重连变化；支持 Markdown 消息格式（粗体/斜体/代码块/链接/图片/表格/公式源码等，面板内置写法帮助）；因宿主 CSP 限制经本机零依赖桥进程中转，支持代理自动探测，需 Node.js 14+
- [snow-side-ask](./snow-side-ask) — 旁路问答：在面板内用自己的输入框提问，回答只流式显示在面板里，不回填输入框、不发送、不写入会话历史；自动携带焦点会话作为上下文并在切换会话时刷新；「进度报告」可按 `/btw` 语义对主会话当前任务生成进度总结（主会话运行中还能按间隔自动生成）；走宿主内部流式通道且请求不传 conversationId，宿主升级后可能失效
- [snow-annotate-board](./snow-annotate-board) — 批注工作台：导入图片（拖入 / 选择 / 粘贴）或视频，做区域批注、移动缩放与大爆炸布局，导出反馈 JSON / 标注 PNG / 项目 ZIP 到工作区（`.output/annotate-board/`）并把 JSON 直接回填聊天草稿；iframe 面板隔离样式，导出经 Snow 桥落盘（原生 `<a download>` 与剪贴板在 iframe 内不可用，均已接管）；内含按 PolyForm Noncommercial 1.0.0 授权的第三方前端代码，非商业使用

- [snow-rate-limits](./snow-rate-limits) — 用量指标：只统计 RPD / TPD / RPM / ITPM / OTPM 五个指标，区间均值 + 分钟峰值 + 实时滚动窗口，指针停在曲线上可读该时刻数值；只读本机 usage 域，不区分 API 档案

## OAuth 插件

隐藏

## 客户端脚本

- [snow-voice-io](./snow-voice-io) — 本地语音服务（客户端脚本）：语音输入（录音经本机 whisper 转写后回填输入框，静音自动停止、分段实时出字、可自定义快捷键）+ 回合结束时朗读 AI 回复
- [snow-notify-hub](./snow-notify-hub) — 通知推送中心：一轮 AI 回复结束时通过 7 个渠道推送提醒（Server酱 / PushPlus / Bark / 钉钉 / 企业微信 / Telegram / 飞书），并可播放提示音、显示应用内提示条；支持后台会话（切到其他会话时原会话跑完也提醒）。顶栏右侧的铃铛按钮可打开设置浮层（有待办时在待办列表按钮右侧，无待办时停在标题组右侧）
- [snow-prompt-chips](./snow-prompt-chips) — 便捷提示词：把自定义的若干条提示词渲染成输入框上方的芯片按钮（与其它插件按钮同行，排在行首），点一下即以该条内容发送给当前会话（可切换成只填入输入框）；条尾齿轮打开设置浮层，支持增删提示词、上下移动排序、删除二次确认，并可把列表导出/导入 JSON 备份
- [snow-session-stats-pills](./snow-session-stats-pills) — 会话统计条：在聊天输入框正下方（整行居中）显示当前会话的轮次与步数、首 token 与输出速度、缓存命中率、输入输出 token 与会话成本，点成本块看按模型拆分的明细；成本单价与「成本核算看板」联动（读不到价格快照时回落到同一套内置规则），五个药丸可单独开关、刷新间隔可选
- [snow-rate-pills](./snow-rate-pills) — 用量胶囊：把 RPD / TPD / RPM / ITPM / OTPM 五项用量指标做成可自由拖放的胶囊，默认顶部居中，每颗可单独显示或隐藏；刷新速度与光效时长用档位滑块选择（刷新 1/2/5/10/30/60 秒，光效 3/5/8/12 秒或「持续不停」），胶囊宽度随内容自适应，长数字不裁字也不叠字

> 「本地语音服务」的面板插件与客户端脚本**需配合使用**：面板负责起服务与管理模型，
> 脚本负责录音与朗读。只装其一无法完成语音输入——两者通过 `127.0.0.1:8791` 通信，可独立升级。

零依赖、纯原生 JS + 宿主 React，MIT（例外：snow-annotate-board 内含按 PolyForm Noncommercial 1.0.0 授权的第三方前端代码，仅限非商业用途）。
