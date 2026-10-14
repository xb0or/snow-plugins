"""snow-voice-io 本地语音转写服务

接收 base64 WAV 的 JSON 请求，调用本地 whisper.cpp 转写，返回文本。
仅监听回环地址（127.0.0.1），不对外暴露。

用法：
    python stt_server.py [端口]
    # 环境变量覆盖：
    #   SNOW_STT_PORT      监听端口（默认 8791）
    #   SNOW_STT_BACKEND   推理后端：auto（默认，按 cuda > vulkan > cpu 自动择优）| cuda | vulkan | cpu
    #   SNOW_WHISPER_MODEL ggml 模型文件路径
    #   SNOW_STT_THREADS   线程数（默认自动：逻辑核数 - 2，钳制在 4~16）
    #   SNOW_STT_T2S       繁简输出策略：auto（默认，出现繁体专用字才转简体）| off | force
    #   HTTPS_PROXY/HTTP_PROXY/ALL_PROXY  下载模型时使用的代理（可选）

推理后端：
    后端以运行时目录隔离，放在 whisper/backends/<名字>/ 下，各自含一套
    whisper-cli / whisper-server 与 ggml-*.dll：
      cuda    NVIDIA（官方预编译包；注意官方包缺 cuBLAS，需补 cublas64_11.dll）
      vulkan  AMD / Intel / NVIDIA 通用（需自行编译，见 README）
      cpu     兜底，永远可用（兼容旧的 whisper/bin/Release 布局）
    启动时按 cuda > vulkan > cpu 顺序探测：每个候选都真跑一次转写，并检查日志里
    是否出现对应后端的加载行与设备行——whisper 在 GPU 后端失败时会静默回退 CPU，
    只看文件存在或退出码会误判。第一个通过的就是当前后端，全部失败则报错而非假装成功。
    单个后端内部仍优先常驻 whisper-server（模型只加载一次），不可用时回退逐次调用 whisper-cli。

接口：
    GET  /ping              健康检查 + 后端/模型/线程/常驻状态
    GET  /backends          后端总览（当前后端、各后端安装与探测结果、优先级）
    GET  /models/catalog    可下载模型清单
    GET  /models/status     下载任务状态
    POST /models/download   {"name":"ggml-small.bin","mirror":"official|hf-mirror|modelscope"} 启动下载
    POST /models/download-custom {"url":"...","name":"...","proxy":"..."} 按 URL 下载
    POST /models/delete     {"name":"ggml-small.bin"} 删除已安装模型
    POST /transcribe        {"audio_b64":"...","lang":"zh"} → {"text":"...","mode":"resident|cli","backend":"cuda"}

并发：HTTP 层多线程（ThreadingHTTPServer），转写与下载各自串行。
"""
import os
import re
import sys
import json
import time
import uuid
import socket
import struct
import base64
import tempfile
import threading
import subprocess
import urllib.request
import zipfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

HERE = os.path.dirname(os.path.abspath(__file__))


def _model_dirs():
    """模型可放置的目录（优先 whisper/ 子目录）。"""
    sub = os.path.join(HERE, "whisper")
    return [sub, HERE] if os.path.isdir(sub) else [HERE]


# ---------------------------------------------------------------- 推理后端
#
# whisper.cpp 的后端以"运行时目录"为单位隔离：每个目录里各放一套
# whisper-cli / whisper-server + ggml-*.dll。这样同一份模型可以在
# CUDA（NVIDIA）、Vulkan（AMD / Intel / NVIDIA 通用）与 CPU 之间切换。
#
# 优先级：cuda > vulkan > cpu；CPU 永远作为兜底。
BACKEND_ORDER = ("cuda", "vulkan", "cpu")
BACKEND_LABEL = {
    "cuda": "CUDA（NVIDIA）",
    "vulkan": "Vulkan（AMD / Intel / NVIDIA 通用）",
    "cpu": "CPU",
}
# 判定"是否真的用上了这个后端"的判据：设备标识。
#   CUDA 成功：whisper_backend_init_gpu: found GPU device 0: CUDA0 (type: 1, cnt: 0)
#   Vulkan 成功：whisper_backend_init_gpu: using Vulkan0 backend
#   失败回退：whisper_backend_init_gpu: no GPU found
# 刻意不依赖 "load_backend: loaded X backend"：CUDA 版是动态加载 ggml-cuda.dll 才有那行，
# 而 Vulkan 版把 ggml-vulkan 静态链入，那一行根本不存在（实测确认），用它当判据会误判。
BACKEND_DEVICE_MARK = {"cuda": "CUDA0", "vulkan": "Vulkan0"}
# 仅供信息展示：目录里出现这些 DLL 才说明装了这个后端的运行时
BACKEND_PROBE_DLL = {"cuda": "ggml-cuda.dll", "vulkan": "ggml-vulkan.dll"}


def _exe(name):
    return name + (".exe" if os.name == "nt" else "")


def backends_root():
    return os.path.join(HERE, "whisper", "backends")


def _usable_runtime(d):
    """目录里是否有可用的 whisper 运行时（以 whisper-cli 是否存在为准）。"""
    return bool(d) and os.path.isdir(d) and os.path.isfile(os.path.join(d, _exe("whisper-cli")))


def backend_dir(name):
    """某个后端的运行时目录；cpu 兼容旧的 whisper/bin/Release 布局。"""
    d = os.path.join(backends_root(), name)
    if _usable_runtime(d):
        return d
    if name == "cpu":
        for legacy in (os.path.join(HERE, "whisper", "bin", "Release"),
                       os.path.join(HERE, "whisper", "bin"),
                       HERE):
            if _usable_runtime(legacy):
                return legacy
    return None


def installed_backends():
    """本机已安装的后端名（按优先级排序）。"""
    return [n for n in BACKEND_ORDER if backend_dir(n)]


def find_model():
    env = os.environ.get("SNOW_WHISPER_MODEL")
    if env and os.path.isfile(env):
        return env
    for d in _model_dirs():
        for name in sorted(os.listdir(d)):
            if name.startswith("ggml-") and name.endswith(".bin"):
                return os.path.join(d, name)
    return None


def active_model():
    """当前生效模型：显式指定且存在 > 目录中首个可用模型。

    动态解析而非固定启动时的取值，因此删除或新增模型后无需重启服务。
    """
    env = os.environ.get("SNOW_WHISPER_MODEL")
    if env and os.path.isfile(env):
        return env
    return find_model()


def list_models():
    """列出已安装模型（文件名 / 绝对路径 / 字节大小）。"""
    found = []
    seen = set()
    for d in _model_dirs():
        if os.path.isdir(d):
            for name in sorted(os.listdir(d)):
                if name.startswith("ggml-") and name.endswith(".bin") and name not in seen:
                    seen.add(name)
                    path = os.path.join(d, name)
                    try:
                        size = os.path.getsize(path)
                    except Exception:
                        size = None
                    found.append({"name": name, "path": path, "size": size})
    return found


def find_model_path(name):
    """按文件名查找已安装模型的绝对路径（防止路径穿越，只认已安装清单）。"""
    for m in list_models():
        if m["name"] == name:
            return m["path"]
    return None


def default_threads():
    """默认线程数：逻辑核数 - 2（钳制 4~16）。

    实测编码阶段耗时（Ryzen 5 5600 / 12 逻辑核 / large-v3-turbo / 20 s 音频）：
    6 线程 7.62 s，8 线程 6.57 s，10 线程 6.42 s，12 线程 6.37 s。
    留 2 个逻辑核给界面线程，收益已接近跑满而系统更跟手。
    """
    n = os.cpu_count() or 4
    return max(4, min(16, n - 2))


MODEL = find_model()
THREADS = os.environ.get("SNOW_STT_THREADS") or str(default_threads())

# 运行时目录里出现这些 DLL 才说明装了这个 GPU 后端（仅供展示，不代表一定可用）
GPU_DLLS = ("ggml-cuda.dll", "ggml-vulkan.dll", "ggml-sycl.dll", "ggml-hip.dll", "ggml-opencl.dll")

_backend_lock = threading.Lock()
_backend = {"resolved": False, "probing": False, "name": None, "dir": None, "detail": {}}
_backend_pref = None   # 面板运行时覆盖；None 表示按环境变量/Snow 默认（auto）
_probe_wav_path = None


def backend_preference():
    """生效的后端偏好：面板覆盖 > SNOW_STT_BACKEND 环境变量 > auto。

    auto 表示按 cuda > vulkan > cpu 自动择优；其余值强制指定单个后端。
    """
    if _backend_pref:
        return _backend_pref
    return (os.environ.get("SNOW_STT_BACKEND") or "auto").strip().lower()


def set_backend_preference(mode):
    """运行时切换后端偏好：回收常驻进程 → 重新探测。返回 (ok, 实际偏好)。"""
    global _backend_pref
    m = (mode or "auto").strip().lower()
    if m not in ("auto",) + BACKEND_ORDER:
        return False, "未知后端：%s" % m
    _backend_pref = None if m == "auto" else m
    _resident.stop()                       # 换后端必须重启常驻推理进程
    resolve_backend(refresh=True)
    return True, m


def runtime_dir():
    """当前生效后端的运行时目录。"""
    d = _backend["dir"] or backend_dir("cpu")
    return d or os.path.join(HERE, "whisper", "bin", "Release")


def whisper_cli():
    d = _backend["dir"]
    if not d:
        return None
    p = os.path.join(d, _exe("whisper-cli"))
    return p if os.path.isfile(p) else None


def whisper_server():
    d = _backend["dir"]
    if not d:
        return None
    p = os.path.join(d, _exe("whisper-server"))
    return p if os.path.isfile(p) else None


def gpu_backends():
    """当前后端目录里的 GPU 后端 DLL 列表（信息展示用）。"""
    d = runtime_dir()
    if not os.path.isdir(d):
        return []
    return [n for n in GPU_DLLS if os.path.isfile(os.path.join(d, n))]


def compute_device():
    name = _backend["name"]
    if name in ("cuda", "vulkan"):
        return "gpu"
    return "gpu" if gpu_backends() else "cpu"


def probe_wav():
    """生成并缓存一个 0.4 秒静音 WAV，用于后端可用性探测。"""
    global _probe_wav_path
    if _probe_wav_path and os.path.isfile(_probe_wav_path):
        return _probe_wav_path
    path = os.path.join(tempfile.gettempdir(), "snow-stt-probe.wav")
    rate, count = 16000, 6400
    pcm = b"\x00\x00" * count
    header = (b"RIFF" + struct.pack("<I", 36 + len(pcm)) + b"WAVE"
              + b"fmt " + struct.pack("<IHHIIHH", 16, 1, 1, rate, rate * 2, 2, 16)
              + b"data" + struct.pack("<I", len(pcm)))
    with open(path, "wb") as fh:
        fh.write(header + pcm)
    _probe_wav_path = path
    return path


def probe_backend(name, timeout=180):
    """真跑一次转写来确认后端可用，返回 (ok, detail)。

    GPU 后端不仅要能启动，还必须确认日志里出现了对应后端的加载行与设备行——
    whisper 在 GPU 后端加载失败时会静默回退 CPU（实测官方 CUDA 包缺 cuBLAS 时
    就是这样），只看退出码或 DLL 是否存在都会误判。
    """
    d = backend_dir(name)
    if not d:
        return False, "未安装"
    model = active_model()
    if not model:
        return False, "等待识别模型（在面板「模型库」下载后自动重试）"
    cli = os.path.join(d, _exe("whisper-cli"))
    try:
        proc = subprocess.run(
            [cli, "-m", model, "-f", probe_wav(), "-l", "zh", "-nt", "-t", THREADS],
            capture_output=True, text=True, encoding="utf-8", errors="replace",
            timeout=timeout, cwd=d,
        )
    except subprocess.TimeoutExpired:
        return False, "探测超时"
    except Exception as exc:
        return False, str(exc)
    log = (proc.stdout or "") + (proc.stderr or "")
    if proc.returncode != 0:
        return False, "退出码 %d" % proc.returncode
    mark = BACKEND_DEVICE_MARK.get(name)
    if mark:
        # 仅 GPU 后端做这两项检查：CPU 后端的日志里本来就有 "no GPU found"
        if mark not in log:
            return False, "%s 未启用（缺运行库/依赖 DLL，或无可用设备）" % name.upper()
        if "no GPU found" in log:
            return False, "%s 已加载但回退到 CPU" % name.upper()
    return True, "可用"


def _probe_all():
    """按优先级探测，返回 (name, dir, detail)。"""
    pref = backend_preference()
    names = installed_backends()
    if pref not in ("", "auto"):
        names = [pref] if pref in names else []
        if not names:
            return None, None, {pref: "未安装该后端"}
    detail = {}
    for n in names:
        ok, why = probe_backend(n)
        detail[n] = why
        if ok:
            return n, backend_dir(n), detail
    return None, None, detail


def resolve_backend(refresh=False, blocking=True):
    """解析当前生效后端；结果缓存，refresh=True 时重新探测。"""
    with _backend_lock:
        if _backend["resolved"] and not refresh:
            return _backend["name"], _backend["dir"]
        if _backend["probing"] and not blocking:
            return _backend["name"], _backend["dir"]
    name, d, detail = _probe_all()
    # 暂无识别模型时探测结果不可信（所有后端都会因缺模型而失败）：不缓存，
    # /ping 会持续触发后台重探，模型就绪后即可自动解析出可用后端。
    settled = find_model() is not None
    with _backend_lock:
        _backend.update({"resolved": settled, "probing": False, "name": name, "dir": d, "detail": detail})
    if name:
        print("[stt] 推理后端: %s"% name, flush=True)
    else:
        print("[stt] 无可用推理后端: %s" % detail, flush=True)
    return name, d


def ensure_backend_probing():
    """/ping 时调用：尚未解析就后台探测，不阻塞请求。"""
    with _backend_lock:
        if _backend["resolved"] or _backend["probing"]:
            return
        _backend["probing"] = True
    threading.Thread(target=resolve_backend, kwargs={"refresh": True}, daemon=True).start()


def backend_status():
    """面板用的后端总览。"""
    with _backend_lock:
        active = _backend["name"]
        detail = dict(_backend["detail"])
        info = {"resolved": _backend["resolved"], "probing": _backend["probing"]}
    installed = installed_backends()
    items = []
    for n in BACKEND_ORDER:
        d = backend_dir(n)
        items.append({
            "name": n,
            "label": BACKEND_LABEL[n],
            "installed": n in installed,
            "gpuDll": bool(d and os.path.isfile(os.path.join(d, BACKEND_PROBE_DLL.get(n, "")))),
            "probe": detail.get(n),
        })
    return {
        "active": active,
        "activeLabel": BACKEND_LABEL.get(active) if active else None,
        "preference": backend_preference(),
        "resolved": info["resolved"],
        "probing": info["probing"],
        "order": list(BACKEND_ORDER),
        "backends": items,
    }


def system_proxy():
    """读取 Windows 系统代理（WinINET 设置）。非 Windows 或未启用时返回 None。"""
    if os.name != "nt":
        return None
    try:
        import winreg
        key = winreg.OpenKey(
            winreg.HKEY_CURRENT_USER,
            r"Software\Microsoft\Windows\CurrentVersion\Internet Settings",
        )
        enabled, _ = winreg.QueryValueEx(key, "ProxyEnable")
        if not enabled:
            return None
        server, _ = winreg.QueryValueEx(key, "ProxyServer")
        if not server:
            return None
        if "=" in server:  # 形如 http=host:port;https=host:port
            parts = dict(p.split("=", 1) for p in server.split(";") if "=" in p)
            server = parts.get("https") or parts.get("http") or ""
        if server and not server.startswith("http"):
            server = "http://" + server
        return server or None
    except Exception:
        return None


def snow_app_proxy():
    """读取 Snow App 自身的代理配置（~/.snow/proxy-config.json）。"""
    try:
        path = os.path.join(os.path.expanduser("~"), ".snow", "proxy-config.json")
        with open(path, "r", encoding="utf-8") as fh:
            cfg = json.load(fh)
        if not cfg.get("enabled"):
            return None
        host = str(cfg.get("host") or "127.0.0.1")
        port = cfg.get("port")
        if not port:
            return None
        return "http://%s:%d" % (host, int(port))
    except Exception:
        return None


# 明确表示"不使用代理"的哨兵值（区别于 None = 按优先级自动解析）
DIRECT = "__direct__"


def resolve_proxy(explicit=None):
    """代理优先级：显式传入 > 环境变量 > Snow App 代理 > Windows 系统代理。

    传入 DIRECT 时强制直连（用于国内源，避免绕过一圈代理反而更慢）。
    """
    if explicit == DIRECT:
        return None
    if explicit:
        return explicit
    for k in ("HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy"):
        v = os.environ.get(k)
        if v:
            return v
    return snow_app_proxy() or system_proxy()


_CJK = r"\u4e00-\u9fff\u3400-\u4dbf\u3040-\u30ff\uac00-\ud7af"
_CJK_PUNCT_R = r"，。！？；：、）】》」』…"
_CJK_PUNCT_L = r"（【《「『"
_HALF_PUNCT = r",.;:!?"


def normalize_text(raw):
    """规范化转写文本，保证插入输入框时格式干净。

    处理：换行/制表/连续空格 → 单空格；中文字符之间的空格删除；
    中文标点（含半角）前后的空格删除；过滤 whisper 的非语音标记；去首尾空白。

    多段转写时 whisper-cli 每段一行、行首带一个空格（whisper-server 还会在末尾补换行），
    因此这里必须先折叠空白，再按"中文—标点"邻接关系删掉残留空格。
    """
    if not raw:
        return ""
    t = str(raw).replace("\r\n", "\n").replace("\r", "\n")
    # 过滤 whisper 对静音/音乐的标记性输出
    t = re.sub(r"\[(?:blank_audio|music|sound|silence|inaudible|no speech|noise)\]", "", t, flags=re.IGNORECASE)
    t = re.sub(r"\((?:music|silence|applause|laughter|noise|buzzing|beep)\)", "", t, flags=re.IGNORECASE)
    t = t.replace("♪", "").replace("♫", "")
    # 所有空白序列（换行、制表、多空格）压成单空格
    t = re.sub(r"\s+", " ", t)
    # 中文字符之间的空格直接删掉
    t = re.sub(r"(?<=[" + _CJK + r"])\s+(?=[" + _CJK + r"])", "", t)
    # 中文标点前后的空格删掉
    t = re.sub(r"\s+(?=[" + _CJK_PUNCT_R + r"])", "", t)
    t = re.sub(r"(?<=[" + _CJK_PUNCT_L + r"])\s+", "", t)
    t = re.sub(r"(?<=[" + _CJK_PUNCT_R + r"])\s+(?=[" + _CJK + r"])", "", t)
    # 半角标点贴着中文时的空格删掉（"面板, 点击" → "面板,点击"），英文语境不动
    t = re.sub(r"(?<=[" + _CJK + r"])\s+(?=[" + _HALF_PUNCT + r"])", "", t)
    t = re.sub(r"(?<=[" + _CJK + r"][" + _HALF_PUNCT + r"])\s+(?=[" + _CJK + r"])", "", t)
    return t.strip()


_lock = threading.Lock()          # 转写串行
_download_lock = threading.Lock()  # 下载状态读写

# ---------------------------------------------------------------- 模型下载

DOWNLOAD_MIRRORS = {
    "official": "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/",
    "hf-mirror": "https://hf-mirror.com/ggerganov/whisper.cpp/resolve/main/",
    # 魔搭社区镜像（国内直连可用，无需代理）：iceCream2025/whisper.cpp 托管全套 ggml 模型
    "modelscope": "https://www.modelscope.cn/models/iceCream2025/whisper.cpp/resolve/master/",
}

MODELS_CATALOG = [
    {"name": "ggml-small.bin", "size": "约 466 MB", "note": "推荐：中文明显优于 base"},
    {"name": "ggml-small-q5_1.bin", "size": "约 190 MB", "note": "small 量化版，体积小、速度快"},
    {"name": "ggml-medium.bin", "size": "约 1.5 GB", "note": "更高精度，速度较慢"},
    {"name": "ggml-medium-q5_0.bin", "size": "约 539 MB", "note": "medium 量化版"},
    {"name": "ggml-large-v3-turbo.bin", "size": "约 1.6 GB", "note": "大模型加速版，性价比高"},
    {"name": "ggml-large-v3-turbo-q5_0.bin", "size": "约 547 MB", "note": "turbo 量化版"},
    {"name": "ggml-large-v3.bin", "size": "约 3.1 GB", "note": "最高精度，很慢"},
    {"name": "ggml-large-v3-q5_0.bin", "size": "约 1.1 GB", "note": "large-v3 量化版"},
]

_downloads = {}  # name -> {state, received, total, error}


def _download_model(name, mirror, proxy=None, source_url=None):
    if source_url:
        url = source_url
    else:
        base = DOWNLOAD_MIRRORS.get(mirror) or DOWNLOAD_MIRRORS["official"]
        url = base + name
    target_dir = _model_dirs()[0]
    os.makedirs(target_dir, exist_ok=True)
    target = os.path.join(target_dir, name)
    tmp = target + ".part"

    with _download_lock:
        _downloads[name] = {"state": "downloading", "received": 0, "total": 0, "error": None}

    try:
        proxy = resolve_proxy(proxy)
        handlers = [urllib.request.ProxyHandler({"http": proxy, "https": proxy})] if proxy else []
        opener = urllib.request.build_opener(*handlers)
        req = urllib.request.Request(url, headers={"User-Agent": "snow-stt/1.0"})
        with opener.open(req, timeout=60) as resp:
            total = int(resp.headers.get("Content-Length") or 0)
            with _download_lock:
                _downloads[name]["total"] = total
            received = 0
            with open(tmp, "wb") as fh:
                while True:
                    chunk = resp.read(256 * 1024)
                    if not chunk:
                        break
                    fh.write(chunk)
                    received += len(chunk)
                    with _download_lock:
                        _downloads[name]["received"] = received
        # 服务器提前断流时长度会小于 Content-Length：此时不得把残缺文件当成模型
        if total > 0 and received != total:
            raise IOError("下载不完整：%d / %d 字节" % (received, total))
        if not total:
            total = received
        os.replace(tmp, target)
        with _download_lock:
            _downloads[name]["state"] = "done"
            _downloads[name]["received"] = received
            _downloads[name]["total"] = total
        # 模型就绪后重探后端（此前可能因缺模型而未解析）
        try:
            if find_model():
                resolve_backend(refresh=True)
        except Exception:
            pass
    except Exception as exc:
        with _download_lock:
            _downloads[name]["state"] = "error"
            _downloads[name]["error"] = str(exc)
        try:
            os.remove(tmp)
        except Exception:
            pass


# ---------------------------------------------------------------- CPU 运行时自动安装

# 本机一个推理后端都没有时（全新安装），自动下载 whisper.cpp 官方 CPU 预编译包，
# 解压到 whisper/backends/cpu/，保证零配置可用。GPU 后端（CUDA/Vulkan）仍需手动安装
# （面板提供「让 AI 帮装 GPU 后端」指引）。
CPU_RUNTIME_URL = "https://github.com/ggml-org/whisper.cpp/releases/download/v1.9.2/whisper-bin-x64.zip"

_runtime_ready = threading.Event()
_runtime_auto_tried = False


def _install_cpu_runtime():
    """下载官方 CPU 预编译包并解压到 whisper/backends/cpu/（平铺布局，与 backend_dir 约定一致）。"""
    proxy = resolve_proxy()
    handlers = [urllib.request.ProxyHandler({"http": proxy, "https": proxy})] if proxy else []
    opener = urllib.request.build_opener(*handlers)
    req = urllib.request.Request(CPU_RUNTIME_URL, headers={"User-Agent": "snow-stt/1.0"})
    os.makedirs(backends_root(), exist_ok=True)
    tmp = os.path.join(backends_root(), "cpu-runtime.zip.part")
    try:
        with opener.open(req, timeout=60) as resp, open(tmp, "wb") as fh:
            total = int(resp.headers.get("Content-Length") or 0)
            received = 0
            while True:
                chunk = resp.read(256 * 1024)
                if not chunk:
                    break
                fh.write(chunk)
                received += len(chunk)
        if total > 0 and received != total:
            raise IOError("下载不完整：%d / %d 字节" % (received, total))
        target = os.path.join(backends_root(), "cpu")
        exe = _exe("whisper-cli")
        with zipfile.ZipFile(tmp) as zf:
            # 包内布局可能是 bin/Release/... 等内层结构：定位 whisper-cli 所在目录，把该目录内容提平
            prefix = None
            for n in zf.namelist():
                base = n.replace("\\", "/").rstrip("/")
                if os.path.basename(base).lower() == exe.lower():
                    prefix = os.path.dirname(base)
                    break
            if prefix is None:
                raise IOError("包内未找到 %s，官方包布局可能已变化" % exe)
            plen = len(prefix) + 1 if prefix else 0
            for info in zf.infolist():
                rel = info.filename.replace("\\", "/")[plen:]
                if not rel or rel.endswith("/"):
                    continue
                dest = os.path.join(target, *rel.split("/"))
                os.makedirs(os.path.dirname(dest), exist_ok=True)
                with zf.open(info) as src, open(dest, "wb") as out:
                    while True:
                        buf = src.read(256 * 1024)
                        if not buf:
                            break
                        out.write(buf)
        if not _usable_runtime(target):
            raise IOError("解压完成但未找到可用的 %s" % exe)
    finally:
        try:
            os.remove(tmp)
        except Exception:
            pass


def auto_cpu_runtime():
    """无任何已装后端时自动安装 CPU 运行时；后台执行，不阻塞 HTTP 服务起监听。"""
    global _runtime_auto_tried
    try:
        if installed_backends() or _runtime_auto_tried:
            return
        _runtime_auto_tried = True
        print("[stt] 未检测到任何推理后端，自动下载 CPU 运行时（whisper.cpp 官方包）…", flush=True)
        _install_cpu_runtime()
        print("[stt] CPU 运行时安装完成: %s" % backend_dir("cpu"), flush=True)
    except Exception as exc:
        print("[stt] CPU 运行时自动安装失败: %s" % exc, flush=True)
    finally:
        _runtime_ready.set()
        if installed_backends():
            resolve_backend(refresh=True)


def _initial_probe():
    """首次后端探测：若正在自动安装 CPU 运行时，先等它结束再探测，避免空结果被缓存。"""
    if not installed_backends():
        _runtime_ready.wait(timeout=900)
    resolve_backend(refresh=True)


# ---------------------------------------------------------------- 繁简转换

# 策略：auto（默认，只在检测到繁体专用字时转换）| off | force
_T2S_MODE = (os.environ.get("SNOW_STT_T2S") or "auto").strip().lower()
# 这些字在简体里同样合法，不能当作繁体判据
_T2S_AMBIGUOUS = set("著乾臺裡")
# LCMapStringW 是逐字表，遇到"一对多"的繁体字不转换（实测 後/麪/徵 保持不变）。
# 这三个字简体里不会出现（徵 仅在乐音 徵(zhǐ) 有极罕见保留），既当判据也补进映射。
_T2S_EXTRA = {"後": "后", "麪": "面", "徵": "征"}
_t2s_ready = False
_t2s_trigger = set(_T2S_EXTRA)


def _lcmap_simplified(text):
    """用 Windows 内置 NLS 表做繁→简（LCMapStringW），无第三方依赖。"""
    try:
        import ctypes
        k32 = ctypes.WinDLL("kernel32", use_last_error=True)
        src = ctypes.c_wchar_p(text)
        need = k32.LCMapStringW(0x0804, 0x02000000, src, -1, None, 0)
        if need <= 0:
            return text
        buf = ctypes.create_unicode_buffer(need)
        if k32.LCMapStringW(0x0804, 0x02000000, src, -1, buf, need) <= 0:
            return text
        return buf.value
    except Exception:
        return text


def _t2s_prepare():
    """按系统 NLS 表生成"繁体判据"字符集：会被表改成别的字的即是繁体变体。

    实测（0x3400~0x9FFF）：命中 2473 个，其中只有 著/乾/臺/裡 四个在简体里也合法，
    已单独排除；常见简体句子命中数为 0，不会误转。
    """
    global _t2s_ready, _t2s_trigger
    if _t2s_ready:
        return
    chars = set()
    for cp in range(0x3400, 0xA000):
        ch = chr(cp)
        if _lcmap_simplified(ch) != ch:
            chars.add(ch)
    _t2s_trigger = (chars - _T2S_AMBIGUOUS) | set(_T2S_EXTRA)
    _t2s_ready = True


def to_simplified(text):
    """按 SNOW_STT_T2S 策略把繁体输出转成简体；简体文本原样返回。"""
    if not text or _T2S_MODE == "off" or os.name != "nt":
        return text
    if _T2S_MODE != "force":
        _t2s_prepare()
        for ch in text:
            if ch in _t2s_trigger:
                break
        else:
            return text
    out = _lcmap_simplified(text)
    if any(ch in out for ch in _T2S_EXTRA):
        out = "".join(_T2S_EXTRA.get(ch, ch) for ch in out)
    return out


# ---------------------------------------------------------------- 常驻推理进程

class _Resident:
    """常驻 whisper-server 管理。

    whisper-cli 每次调用都要重新加载模型（实测 large-v3-turbo 约 1.2 s），
    常驻后模型只加载一次，单次请求省掉这部分开销。
    子进程绑定 KILL_ON_JOB_CLOSE 作业对象：本服务被强杀时子进程随之退出，不留残留进程。
    """

    def __init__(self):
        self.lock = threading.Lock()
        self.proc = None
        self.port = None
        self.model = None
        self.server = None   # 该常驻进程所用的 whisper-server 路径（换后端需重启）
        self.job = None

    # ---- 以下三个方法由调用方持锁 ----
    def _kill(self):
        proc = self.proc
        if proc is not None and proc.poll() is None:
            try:
                proc.terminate()
                proc.wait(timeout=5)
            except Exception:
                try:
                    proc.kill()
                except Exception:
                    pass
        self.proc = None
        self.port = None
        self.model = None
        self.server = None
        self.job = None

    @staticmethod
    def _healthy(base, timeout=1.5):
        try:
            with urllib.request.urlopen(base + "/health", timeout=timeout) as resp:
                return resp.status == 200
        except Exception:
            return False

    @staticmethod
    def _pick_port():
        s = socket.socket()
        try:
            s.bind(("127.0.0.1", 0))
            return s.getsockname()[1]
        finally:
            s.close()

    @staticmethod
    def _kill_on_close(proc):
        """Windows：把子进程绑到 KILL_ON_JOB_CLOSE 作业对象，父进程消失即被回收。"""
        if os.name != "nt":
            return None
        try:
            import ctypes
            from ctypes import wintypes

            class _BasicLimit(ctypes.Structure):
                _fields_ = [
                    ("PerProcessUserTimeLimit", wintypes.LARGE_INTEGER),
                    ("PerJobUserTimeLimit", wintypes.LARGE_INTEGER),
                    ("LimitFlags", wintypes.DWORD),
                    ("MinimumWorkingSetSize", ctypes.c_size_t),
                    ("MaximumWorkingSetSize", ctypes.c_size_t),
                    ("ActiveProcessLimit", wintypes.DWORD),
                    ("Affinity", ctypes.c_size_t),
                    ("PriorityClass", wintypes.DWORD),
                    ("SchedulingClass", wintypes.DWORD),
                ]

            class _IOCounters(ctypes.Structure):
                _fields_ = [(n, ctypes.c_ulonglong) for n in (
                    "ReadOperationCount", "WriteOperationCount", "OtherOperationCount",
                    "ReadTransferCount", "WriteTransferCount", "OtherTransferCount")]

            class _ExtendedLimit(ctypes.Structure):
                _fields_ = [
                    ("BasicLimitInformation", _BasicLimit),
                    ("IoInfo", _IOCounters),
                    ("ProcessMemoryLimit", ctypes.c_size_t),
                    ("JobMemoryLimit", ctypes.c_size_t),
                    ("PeakProcessMemoryUsed", ctypes.c_size_t),
                    ("PeakJobMemoryUsed", ctypes.c_size_t),
                ]

            k32 = ctypes.WinDLL("kernel32", use_last_error=True)
            job = k32.CreateJobObjectW(None, None)
            if not job:
                return None
            info = _ExtendedLimit()
            info.BasicLimitInformation.LimitFlags = 0x2000  # JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
            if not k32.SetInformationJobObject(job, 9, ctypes.byref(info), ctypes.sizeof(info)):
                k32.CloseHandle(job)
                return None
            if not k32.AssignProcessToJobObject(job, wintypes.HANDLE(int(proc._handle))):
                k32.CloseHandle(job)
                return None
            return job
        except Exception:
            return None

    # ---- 对外接口 ----
    def stop(self):
        with self.lock:
            self._kill()

    def ready(self, model_path):
        """确保常驻进程已按当前后端加载 model_path，返回服务地址；不可用时返回 None。"""
        server = whisper_server()
        if not server:
            return None
        rt_dir = runtime_dir()
        with self.lock:
            if (self.proc is not None and self.proc.poll() is None and self.port
                    and self.model == model_path and self.server == server):
                base = "http://127.0.0.1:%d" % self.port
                if self._healthy(base):
                    return base
            self._kill()
            port = self._pick_port()
            args = [server, "-m", model_path, "-nt", "-t", THREADS,
                    "--host", "127.0.0.1", "--port", str(port)]
            flags = 0x08000000 if os.name == "nt" else 0  # CREATE_NO_WINDOW
            try:
                proc = subprocess.Popen(args, cwd=rt_dir, stdout=subprocess.DEVNULL,
                                        stderr=subprocess.DEVNULL, creationflags=flags)
            except Exception:
                return None
            self.proc, self.port, self.model, self.server = proc, port, model_path, server
            self.job = self._kill_on_close(proc)
            base = "http://127.0.0.1:%d" % port
            deadline = time.time() + 90  # 首次加载大模型需要时间
            while time.time() < deadline:
                if proc.poll() is not None:
                    self._kill()
                    return None
                if self._healthy(base):
                    return base
                time.sleep(0.25)
            self._kill()
            return None

    def transcribe(self, model_path, lang, wav_bytes):
        """经常驻进程转写；返回文本，不可用时返回 None（调用方回退 whisper-cli）。"""
        base = self.ready(model_path)
        if not base:
            return None
        fields = {"language": lang or "auto", "response_format": "json", "no_timestamps": "true"}
        body, content_type = build_multipart(fields, "audio.wav", wav_bytes)
        req = urllib.request.Request(base + "/inference", data=body,
                                     headers={"Content-Type": content_type})
        try:
            with urllib.request.urlopen(req, timeout=300) as resp:
                data = json.loads(resp.read().decode("utf-8", "replace"))
            return str(data.get("text") or "")
        except Exception:
            self.stop()  # 常驻进程异常，回收后由下次请求重建
            return None


_resident = _Resident()


def build_multipart(fields, filename, content):
    """手工拼 multipart/form-data（仅用标准库，不引入新依赖）。"""
    boundary = "----snowstt" + uuid.uuid4().hex
    parts = []
    for key, value in fields.items():
        parts.append(("--%s\r\nContent-Disposition: form-data; name=\"%s\"\r\n\r\n%s\r\n"
                      % (boundary, key, value)).encode("utf-8"))
    parts.append(("--%s\r\nContent-Disposition: form-data; name=\"file\"; filename=\"%s\"\r\n"
                  "Content-Type: application/octet-stream\r\n\r\n"
                  % (boundary, filename)).encode("utf-8"))
    parts.append(content)
    parts.append(("\r\n--%s--\r\n" % boundary).encode("utf-8"))
    return b"".join(parts), "multipart/form-data; boundary=" + boundary


# ---------------------------------------------------------------- HTTP

class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def _send(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(body)

    def _read_json(self):
        length = int(self.headers.get("Content-Length", "0"))
        raw = self.rfile.read(length)
        return json.loads(raw.decode("utf-8"))

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "POST, GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Content-Length", "0")
        self.send_header("Connection", "close")
        self.end_headers()

    def do_GET(self):
        path = self.path
        if path.startswith("/ping") or path.startswith("/health"):
            ensure_backend_probing()  # 后台探测后端，不阻塞本次响应
            st = backend_status()
            self._send(200, {
                "ok": True,
                "service": "snow-stt",
                "engine": "whisper.cpp",
                "backend": st["active"],
                "backendLabel": st["activeLabel"],
                "backendPreference": st["preference"],
                "cli": whisper_cli() or None,
                "server": whisper_server() or None,
                "resident": bool(_resident.proc is not None and _resident.proc.poll() is None),
                "device": compute_device(),
                "gpuBackends": gpu_backends(),
                "model": os.path.basename(active_model()) if active_model() else None,
                "modelPath": active_model() or None,
                "threads": THREADS,
                "t2s": _T2S_MODE,
                "models": list_models(),
                "proxy": resolve_proxy(),
            })
        elif path.startswith("/backends"):
            self._send(200, backend_status())
        elif path.startswith("/models/catalog"):
            self._send(200, {"catalog": MODELS_CATALOG, "mirrors": list(DOWNLOAD_MIRRORS.keys())})
        elif path.startswith("/models/status"):
            with _download_lock:
                snapshot = {k: dict(v) for k, v in _downloads.items()}
            self._send(200, {"downloads": snapshot})
        else:
            self._send(404, {"error": "not found"})

    def do_POST(self):
        path = self.path
        if path.startswith("/backends"):
            self._handle_backend_set()
            return
        if path.startswith("/models/download-custom"):
            self._handle_custom_download()
            return
        if path.startswith("/models/delete"):
            self._handle_delete()
            return
        if path.startswith("/models/download"):
            self._handle_download()
            return
        if not path.startswith("/transcribe"):
            self._send(404, {"error": "not found"})
            return

        model_path = active_model()
        if not model_path:
            self._send(500, {"error": "whisper 未就绪：未找到可用的 ggml 模型，请先在面板中下载"})
            return
        resolve_backend()  # 首次请求会同步探测，之后走缓存
        cli = whisper_cli()
        srv = whisper_server()
        if not cli and not srv:
            self._send(500, {"error": "whisper 未就绪：没有可用的推理后端（已尝试 GPU 与 CPU）"})
            return
        try:
            req = self._read_json()
        except Exception as exc:
            self._send(400, {"error": "bad request: " + str(exc)})
            return

        b64 = req.get("audio_b64", "")
        lang = req.get("lang", "auto") or "auto"
        try:
            data = base64.b64decode(b64)
        except Exception as exc:
            self._send(400, {"error": "bad base64: " + str(exc)})
            return
        if len(data) < 44:
            self._send(400, {"error": "audio too small", "bytes": len(data)})
            return

        try:
            mode = "cli"
            exit_code = 0
            text = None
            with _lock:  # whisper 单实例串行，避免并发抢占
                if srv:
                    text = _resident.transcribe(model_path, lang, data)
                    if text is not None:
                        mode = "resident"
                if text is None:
                    if not cli:
                        raise RuntimeError("当前后端没有可用的 whisper-cli")
                    fd, path_tmp = tempfile.mkstemp(suffix=".wav")
                    os.close(fd)
                    try:
                        with open(path_tmp, "wb") as fh:
                            fh.write(data)
                        proc = subprocess.run(
                            [cli, "-m", model_path, "-f", path_tmp,
                             "-l", lang, "-nt", "-t", THREADS],
                            capture_output=True, text=True, encoding="utf-8",
                            errors="replace", timeout=300, cwd=runtime_dir(),
                        )
                        text = proc.stdout or ""
                        exit_code = proc.returncode
                    finally:
                        try:
                            os.remove(path_tmp)
                        except Exception:
                            pass
            self._send(200, {"text": to_simplified(normalize_text(text)), "audioBytes": len(data),
                             "exitCode": exit_code, "mode": mode, "backend": _backend["name"]})
        except subprocess.TimeoutExpired:
            self._send(500, {"error": "whisper timeout"})
        except Exception as exc:
            self._send(500, {"error": str(exc)})

    def _handle_backend_set(self):
        """切换推理后端：{"mode":"auto|cuda|vulkan|cpu"}。切换会重新探测并重启常驻进程。"""
        try:
            req = self._read_json()
        except Exception as exc:
            self._send(400, {"error": "bad request: " + str(exc)})
            return
        ok, info = set_backend_preference(str(req.get("mode") or "auto"))
        if not ok:
            self._send(400, {"error": info})
            return
        self._send(200, {"switched": True, "mode": info, "status": backend_status()})

    def _handle_delete(self):
        """删除一个已安装的模型文件。仅接受已安装清单中的文件名，杜绝路径穿越。"""
        try:
            req = self._read_json()
        except Exception as exc:
            self._send(400, {"error": "bad request: " + str(exc)})
            return
        name = str(req.get("name") or "").strip()
        if not name:
            self._send(400, {"error": "缺少模型名"})
            return
        path = find_model_path(name)
        if not path:
            self._send(404, {"error": "未找到该模型：" + name})
            return
        with _download_lock:
            cur = _downloads.get(name)
            if cur and cur.get("state") == "downloading":
                self._send(409, {"error": "该模型正在下载中，无法删除"})
                return
        try:
            os.remove(path)
        except Exception as exc:
            # Windows 下若模型正被 whisper-cli 占用会失败，如实回报
            self._send(500, {"error": "删除失败：" + str(exc)})
            return
        with _download_lock:
            _downloads.pop(name, None)
        self._send(200, {"deleted": True, "name": name, "fallbackModel": os.path.basename(active_model()) if active_model() else None})

    def _handle_download(self):
        try:
            req = self._read_json()
        except Exception as exc:
            self._send(400, {"error": "bad request: " + str(exc)})
            return
        name = str(req.get("name") or "")
        mirror = str(req.get("mirror") or "official")
        proxy = str(req.get("proxy") or "").strip() or None
        # 魔搭为国内源，未显式指定代理时直连（走代理反而更慢）
        effective_proxy = proxy if proxy else (DIRECT if mirror == "modelscope" else None)
        if not any(m["name"] == name for m in MODELS_CATALOG):
            self._send(400, {"error": "unknown model: " + name})
            return
        with _download_lock:
            cur = _downloads.get(name)
            if cur and cur.get("state") == "downloading":
                self._send(409, {"error": "already downloading", "name": name})
                return
        threading.Thread(target=_download_model, args=(name, mirror, effective_proxy), daemon=True).start()
        self._send(200, {"started": True, "name": name, "mirror": mirror, "direct": effective_proxy == DIRECT})

    def _handle_custom_download(self):
        """下载任意 URL 提供的 ggml 模型。"""
        try:
            req = self._read_json()
        except Exception as exc:
            self._send(400, {"error": "bad request: " + str(exc)})
            return
        url = str(req.get("url") or "").strip()
        name = str(req.get("name") or "").strip()
        proxy = str(req.get("proxy") or "").strip() or None
        if not url.lower().startswith(("http://", "https://")):
            self._send(400, {"error": "地址必须是 http(s)"})
            return
        if not name:
            name = url.split("?")[0].rstrip("/").split("/")[-1] or "custom-model.bin"
        if not name.lower().endswith(".bin"):
            name = name + ".bin"
        if ("/" in name) or ("\\" in name) or name.startswith("."):
            self._send(400, {"error": "文件名非法"})
            return
        with _download_lock:
            cur = _downloads.get(name)
            if cur and cur.get("state") == "downloading":
                self._send(409, {"error": "already downloading", "name": name})
                return
        threading.Thread(target=_download_model, args=(name, "custom", proxy, url), daemon=True).start()
        self._send(200, {"started": True, "name": name, "url": url})

    def log_message(self, *args):
        pass


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else int(os.environ.get("SNOW_STT_PORT", "8791"))
    print("snow-stt listening on 127.0.0.1:%d" % port, flush=True)
    print("  model  : %s" % (MODEL or "<未找到，请设置 SNOW_WHISPER_MODEL>"), flush=True)
    print("  threads: %s" % THREADS, flush=True)
    print("  backend: 首选 %s（可用 SNOW_STT_BACKEND 强制，自动模式按 cuda > vulkan > cpu）"
          % backend_preference(), flush=True)
    for n in BACKEND_ORDER:
        d = backend_dir(n)
        print("    - %-7s %s" % (n, d if d else "<未安装>"), flush=True)
    print("  models : %s" % ", ".join(m["name"] for m in list_models()), flush=True)
    print("  t2s    : %s" % _T2S_MODE, flush=True)
    if _T2S_MODE != "off" and os.name == "nt":
        threading.Thread(target=_t2s_prepare, daemon=True).start()  # 预热繁简判据表（约 0.4 s）
    if not installed_backends():
        # 全新安装：后台自动下载 CPU 运行时（服务先起监听，/ping 不受影响）
        threading.Thread(target=auto_cpu_runtime, daemon=True).start()
    threading.Thread(target=_initial_probe, daemon=True).start()  # 启动即探测后端（必要时等运行时就绪）
    try:
        ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()
    finally:
        _resident.stop()


if __name__ == "__main__":
    main()
