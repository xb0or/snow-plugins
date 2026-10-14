# stt-service — 本地 whisper 转写服务

`snow-voice-io` 依赖的本机语音转写服务，仅监听回环地址，音频不出本机。

## 目录

```
stt-service/
  stt_server.py              服务本体（接收 base64 WAV → whisper.cpp → 返回文本）
  start.ps1                  命令行启动脚本
  whisper/
    bin/Release/whisper-cli.exe
    ggml-base.bin
```

## 启动

**方式一：面板插件（推荐）** — 安装 [snow-stt-launcher](../../snow-stt-launcher/)，在面板里点「启动」。

**方式二：命令行**

```powershell
.\start.ps1                       # 自动查找 whisper-cli 与 ggml 模型
.\start.ps1 -Port 8791
.\start.ps1 -WhisperCli "D:\whisper\whisper-cli.exe" -Model "D:\whisper\ggml-small.bin"
```

## 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/ping` | 健康检查，返回服务信息（cli / model / threads / models / proxy） |
| GET | `/models/catalog` | 可下载模型清单与下载源列表 |
| GET | `/models/status` | 下载任务状态（进度 / 错误） |
| POST | `/models/download` | `{"name":"ggml-small.bin","mirror":"official\|hf-mirror\|modelscope","proxy":"http://..."}` 启动下载 |
| POST | `/models/download-custom` | `{"url":"https://.../ggml-x.bin","name":"可选"}` 下载任意 ggml 模型 |
| POST | `/models/delete` | `{"name":"ggml-x.bin"}` 删除已装模型 |
| POST | `/transcribe` | `{"audio_b64":"...","lang":"zh"}` → `{"text":"..."}` |

### 下载源

| 源 | 地址 | 备注 |
| --- | --- | --- |
| `official` | `huggingface.co/ggerganov/whisper.cpp` | 国内通常需代理 |
| `hf-mirror` | `hf-mirror.com/ggerganov/whisper.cpp` | 国内镜像 |
| `modelscope` | `modelscope.cn/models/iceCream2025/whisper.cpp` | **国内直连，默认不走代理** |

### 代理规则

`显式传入 > 环境变量 > Snow App 代理配置（~/.snow/proxy-config.json） > Windows 系统代理`。
`modelscope` 源在未显式指定代理时强制直连。

### 模型生效规则

每次请求动态解析当前模型（`SNOW_WHISPER_MODEL` 指定且存在 → 目录中首个 `ggml-*.bin`），因此**删除或新增模型后无需重启服务**；若删除的是生效模型，会自动回退到下一个可用模型。

## 环境变量

| 变量 | 说明 |
| --- | --- |
| `SNOW_STT_PORT` | 监听端口（默认 8791） |
| `SNOW_WHISPER_CLI` | whisper-cli 可执行文件路径 |
| `SNOW_WHISPER_MODEL` | ggml 模型文件路径 |
| `SNOW_STT_THREADS` | 推理线程数（默认 CPU 核数一半） |

未设置时，服务自动在自身目录与其 `whisper/` 子目录中查找 `whisper-cli(.exe)` 与 `ggml-*.bin`。

## 换用更大的模型

`ggml-base.bin` 中文效果一般（可能出现繁体）。如需更好效果，下载 `ggml-small.bin` / `ggml-medium.bin` 放到 `whisper/` 目录，服务启动时按文件名排序取第一个 `ggml-*.bin`；或用 `SNOW_WHISPER_MODEL` 显式指定。

模型下载：<https://huggingface.co/ggerganov/whisper.cpp>（`ggml-small.bin` 约 466 MB）。

## 说明

- 仅绑定 `127.0.0.1`，不对外暴露。
- 转写请求串行执行（同一时刻只跑一个 whisper 进程），避免并发抢占。
- 服务无状态：删除进程即停止，不写任何持久数据。
