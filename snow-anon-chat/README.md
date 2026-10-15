# Snow Anonymous Chat（snow-anon-chat）

Snow App 匿名聊天面板插件：接入 [hack.chat](https://hack.chat/)，频道在界面显示为 `?SNOW`。

## 功能

- 匿名聊天：自动生成并持久化昵称（重连不换名），昵称冲突自动加 `_1`/`_2` 后缀，支持手动改名
- 成员列表、系统消息、emote、上下线提醒；不持久化任何聊天记录
- 设置面板：代理地址（留空自动探测本机常见代理端口）、桥接端口（默认 8799）、自动连接开关
- 免责声明首启确认；昵称与偏好仅保存在插件私有存储

## 架构

宿主 CSP 禁止面板直连外部网络，因此经本机桥接进程中转：

```
面板 (renderer, CSP 受限)
  → ws://localhost:8799（CSP 放行）
  → bridge/bridge.cjs（Node 进程，经 terminal 写动作拉起）
  → HttpsProxyAgent（代理由 hello 握手下发，空 = 直连）
  → wss://hack.chat/chat-ws
```

- 代理经 hello 握手下发，改代理无需重启桥；探测范围 `7897/7890/7891/10809/10808/1080/8118/8889`
- `bridge.cjs` 为 esbuild 打包的零依赖单文件（`ws` + `https-proxy-agent` 内联），安装无需 node_modules

## 环境要求

- Node.js 14+（桥进程由宿主终端启动 `node "<installPath>/bridge/bridge.cjs" --port N`）
- 首次安装需授予终端权限（terminal scope）；本插件不读取任何应用元数据

## 源文件说明

| 文件 | 说明 |
|---|---|
| `index.src.js` | 面板源码（source of truth），构建产出 `index.js`（无 import 的自包含单文件） |
| `bridge/bridge.src.mjs` | 桥源码，构建产出 `bridge/bridge.cjs` |
| `bridge/package.json` | 仅开发期依赖（esbuild 打包用），安装时不需要 |

构建桥：`npx --yes esbuild@0.24.0 bridge.src.mjs --bundle --format=cjs --platform=node --minify --outfile=bridge.cjs`
（注意必须 `--format=cjs` + `.cjs` 后缀；ESM 格式会破坏 `ws` 内部的 require。）

MIT
