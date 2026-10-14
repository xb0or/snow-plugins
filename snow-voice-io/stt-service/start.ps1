# snow-voice-io 本地 STT 服务启动脚本
#
# 用法（PowerShell）：
#   .\start.ps1                     # 自动在当前目录 / whisper\bin\Release 下查找 whisper-cli 与模型
#   .\start.ps1 -Port 8791
#   .\start.ps1 -WhisperCli "D:\whisper\whisper-cli.exe" -Model "D:\whisper\ggml-small.bin"
#
# 依赖：Python 3（PATH 中可用）、whisper.cpp 预编译二进制与 ggml 模型。

param(
    [int]$Port = 8791,
    [string]$WhisperCli = "",
    [string]$Model = ""
)

$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path

if (-not $WhisperCli) {
    $cands = @(
        (Join-Path $here "whisper\bin\Release\whisper-cli.exe"),
        (Join-Path $here "whisper\bin\whisper-cli.exe"),
        (Join-Path $here "whisper-cli.exe")
    )
    foreach ($c in $cands) { if (Test-Path $c) { $WhisperCli = $c; break } }
}
if (-not $Model) {
    $found = Get-ChildItem -Path $here -Filter "ggml-*.bin" -File -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($found) { $Model = $found.FullName }
}

if ($WhisperCli) { $env:SNOW_WHISPER_CLI = $WhisperCli } else { Write-Warning "未找到 whisper-cli，请用 -WhisperCli 指定" }
if ($Model) { $env:SNOW_WHISPER_MODEL = $Model } else { Write-Warning "未找到 ggml 模型，请用 -Model 指定" }
$env:SNOW_STT_PORT = "$Port"

Write-Host "启动 snow-stt 服务..." -ForegroundColor Cyan
Write-Host "  whisper-cli : $WhisperCli"
Write-Host "  model       : $Model"
Write-Host "  port        : $Port"
python (Join-Path $here "stt_server.py") $Port
