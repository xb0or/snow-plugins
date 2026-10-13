# 本地语音服务（Local Speech Service）

Snow App 客户端脚本：**语音输入（本地 Whisper）** + **AI 回复朗读（系统 TTS）**。

> **需与「本地语音服务」服务面板插件配合使用**（两个产物同名，需一起安装）：本脚本负责录音与朗读，
> 转写依赖本机 whisper 服务——用面板一键启停服务、管理识别模型，否则需自己用命令行启动
> `stt-service/stt_server.py`。

## 功能

- **语音输入**：点击输入栏麦克风按钮开始录音，再次点击（或点浮标按钮）结束；录音在本地编码为 16kHz 单声道 WAV，经 `snow.fetch` 发往本机 STT 服务转写，文本回填输入框。
- **录音快捷键**（可自定义，默认不设置）：在设置里点按钮后直接按键即可改键，支持任意组合键，也支持**单键**（如 `F2`、`\``）。默认留空以免与 Snow App 自带快捷键冲突。单键只在焦点不在输入框、且设置弹层未打开时生效，因此不会吃掉正常打字。
- **静音自动停止**：能量式 VAD，识别到人声后连续静音达到设定时长即自动结束录音并转写；一直没说话则给更长的思考时间（8 秒起）再收工。
- **分段实时出字**（可关）：在静音边界把已录语音切段送识别，边录边插入，不必等整段结束。切段只在静音处发生，避免把词切两半；上一段没识别完就继续攒着，不会堆任务。
- **语音朗读**：一轮 AI 回复结束（`stream-end`）后自动朗读，可关闭；支持音色、语速、音量、跳过代码块、最长字数。
- **设置弹层**：输入栏齿轮按钮或 `GM_registerMenuCommand`（脚本菜单）打开；配色跟随宿主主题，图标为内嵌官方 Lucide SVG。

## 架构

```
录音(getUserMedia + ScriptProcessor) → 降采样 16kHz → WAV → base64
  → snow.fetch POST http://127.0.0.1:8791/transcribe
  → 本机 STT 服务(whisper.cpp) → {"text":"..."}
  → snow.client.insertInputText(text)
```

朗读：`snow.on('stream-end')` → 读取最后一条 assistant 消息（聊天 DOM）→ `speechSynthesis`。

## 安装

1. 安装脚本：把 `snow-voice-io.user.js` 装入 Snow App（插件 → 插件列表 → 脚本插件 → 导入文件），或在会话中让 AI 用 `config-set scope=userscripts` 安装。
2. 启动本地 STT 服务，两种方式任选：
   - **面板插件（推荐）**：安装配套的「本地语音服务」面板插件，在面板里点「启动」。
   - **命令行**：运行 `stt-service/start.ps1`（见 `stt-service/README.md`）。
3. 在输入栏点齿轮 → 状态区点「检测」，确认转写服务可用。

## 依赖与边界（实测结论）

- 录音与朗读均为浏览器标准 API，脚本内完成，无外部依赖。
- 转写必须有一个**本机 STT 服务**（默认 `127.0.0.1:8791`）。脚本本身不含模型；服务脚本见 `stt-service/`。
- **不使用** WebAssembly / Transformers.js：Snow App 构建禁用了 WASM 代码生成（`Wasm code generation disallowed by embedder`），且远程 ESM import 被 CSP 拦截，故浏览器内本地推理不可行。
- **不使用** Web Speech 语音识别：Electron 构建下 `SpeechRecognition` 立即返回 `network` 错误。
- 系统 TTS（`speechSynthesis`）可用，Windows 下通常含中文音色（如 Microsoft Huihui / Kangkang / Yaoyao）。

## 服务端可调项（环境变量）

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `SNOW_STT_PORT` | `8791` | 监听端口 |
| `SNOW_STT_BACKEND` | `auto` | 推理后端：`auto` 按 `cuda > vulkan > cpu` 自动择优，也可强制 `cuda` / `vulkan` / `cpu` |
| `SNOW_WHISPER_MODEL` | 空 | 指定 ggml 模型路径；面板「当前模型」即通过它下发 |
| `SNOW_STT_THREADS` | 逻辑核数 − 2 | 推理线程数（钳制 4~16） |
| `SNOW_STT_T2S` | `auto` | 繁体输出转简体：`auto` 只在出现繁体专用字时转换、`off` 关闭、`force` 无条件转换 |

`SNOW_STT_T2S` 走 Windows 内置 NLS 表（`LCMapStringW`）做繁→简，不引入第三方依赖；该逐字表对「一对多」的繁体字（实测 後/麪/徵）不转换，服务端另补了一张 3 条的小映射表。

## 推理后端（GPU 跨厂商）

后端以运行时目录隔离，放在 `stt-service/whisper/backends/<名字>/` 下，各自含一套
`whisper-cli` / `whisper-server` 与 `ggml-*.dll`，共用 `whisper/` 下的 ggml 模型：

| 后端 | 覆盖硬件 | 获取方式 |
| --- | --- | --- |
| `cuda` | NVIDIA | whisper.cpp 官方预编译包（**注意官方包缺 cuBLAS**，须补 `cublas64_11.dll` / `cublasLt64_11.dll`，否则会静默回退 CPU） |
| `vulkan` | AMD / Intel / NVIDIA 通用 | 需自行编译（`-DGGML_VULKAN=ON`，需 Vulkan SDK 提供 glslc） |
| `cpu` | 任意 | 兜底，永远可用；兼容旧的 `whisper/bin/Release` 布局 |

启动时按 `cuda > vulkan > cpu` 顺序探测，**每个候选真跑一次转写**，并检查日志里是否出现
对应后端的设备标识（`CUDA0` / `Vulkan0`）：whisper 在 GPU 后端失败时会静默回退 CPU，
只看文件存在或退出码会误判。第一个通过的即当前后端；全部失败则如实报错，不做假成功。

本机实测（Ryzen 5 5600 + RTX 3060 Ti，large-v3-turbo-q5_0）：

| 后端 | 20s 音频 encode | 常驻后单次请求 |
| --- | --- | --- |
| cuda | 0.80 s | 0.31 s |
| vulkan | 4.97 s | 7.67 s（含首次启动） |
| cpu | 6.59 s | 8.6 s |

> AMD / Intel 的 GPU 走 Vulkan 路径，用的是同一份标准 Vulkan compute 二进制；该路径在
> NVIDIA 卡上已验证可跑通，但本机无 A 卡 / I 卡，无法实测那两类硬件。

## 配置项

| 项 | 默认 | 说明 |
| --- | --- | --- |
| 启用语音输入 | 开 | 关闭后隐藏输入栏麦克风按钮 |
| 转写服务地址 | `http://127.0.0.1:8791/transcribe` | 本机 STT 服务端点 |
| 识别语言 | 中文 | 传给 whisper 的 `-l` 参数 |
| 最长录音秒数 | 60 | 超时自动结束并转写 |
| 静音自动停止 | 开 | 连续静音达到设定时长自动结束录音 |
| 静音判定秒数 | 1.5 | 说过话后的静音阈值；一直没说话时为该值的 4 倍（下限 8 秒） |
| 静音阈值 | 0.012 | RMS 能量阈值，环境噪声大时调高 |
| 分段实时出字 | 关 | 静音边界切段送识别，边录边插入 |
| 单段最长秒数 | 15 | 一直不停顿时强制切段的上限 |
| 插入前加空格 | 关 | 插入文本前加一个前导空格 |
| 启用快捷键 | 开 | 全局快捷键总开关 |
| 录音快捷键 | 未设置 | 开始/结束录音；默认留空避免与宿主冲突，可设任意组合键或单键 |
| 停止朗读快捷键 | 未设置 | 立即停止朗读 |
| 启用朗读 | 开 | 总开关 |
| 回合结束自动朗读 | 开 | 关闭后仅可手动试听 |
| 音色 / 语速 / 音量 | 自动 / 1.0 / 1.0 | 系统 TTS 参数 |
| 跳过代码块 | 开 | 朗读前移除 ``` 代码块与行内代码 |
| 最长朗读字数 | 3000 | 超出截断 |

> 快捷键说明：`Esc` 取消录制、`Del` / `Backspace` 清除。单键快捷键仅在焦点不在输入框且设置弹层关闭时触发；若与 Snow App 自带快捷键冲突，换一个即可——部分宿主快捷键由系统级注册，页面脚本无法覆盖。
