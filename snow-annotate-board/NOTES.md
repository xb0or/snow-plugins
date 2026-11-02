# 批注工作台 —— 技术与合规说明

Snow 面板插件形式的批注工作台：导入图片或视频，做区域批注与布局调整，导出反馈 JSON（`feedback-minimal-4`）与标注 PNG，并把 JSON 直接写回聊天草稿。

## 1. 插件形态

面板插件，`renderMode: "iframe"`。

1. 需要独立画布、固定布局与独立样式表，属于面板职责，不往宿主界面插槽里塞控件，排除脚本插件。
2. 实测：宿主自建 `#snow-plugin-root` 骨架、注入 `styles`，entry 以 `<script src="blob:">` 经典脚本执行；图片（`data:`/`blob:`）与 Worker（`blob:`）可用。
3. 不走 ESM：前端是经典脚本（UMD），改 ESM 需重打包并处理宿主 `script-src 'self' blob:`（无 `unsafe-inline`）对注入式脚本的限制；且 ESM 跑在主渲染进程，`<style>` 会污染宿主界面。iframe 天然隔离。
4. `panels[].chatInputAction` 仅 ESM 生效，所以没有"输入框旁按钮"。但 `api.write.run('chatInput.*')` 在 iframe 桥里可用，导出后直接回填草稿。

## 2. 宿主环境约束（实测）

```
default-src 'self'; script-src 'self' blob:; style-src 'self' 'unsafe-inline';
img-src 'self' data: blob: theme-bg: img-proxy:;
connect-src 'self' ws: wss: http: https: img-proxy:; frame-src 'self' blob: data: html-preview:
```

- `script-src` 无 `'unsafe-inline'`：内联 `<script>` 不执行；`srcdoc` / `blob:` / `data:` 三种子文档都继承容器 CSP。
- 子文档自声明 CSP 会与容器 CSP 取交集，收紧即全禁，因此必须删除。
- `blob:` Worker 可用（`worker-src` 回退 `script-src`）。
- `filesystem.writeFile` 只接受 `{ filePath, content }` 文本，`encoding: 'base64'` 被忽略，无二进制写盘；目录不存在时自动创建。
- iframe 内 `navigator.clipboard` 报 `Document is not focused`；原生 `<a download>` 不产生文件。

## 3. 目录布局

```
snow-annotate-board/
  plugin.json / index.js / README.md   构建产物，可直接安装
  NOTES.md                             本文件
  WORKLOG.md                           开发与问题修复记录
  LICENSES/                            第三方许可 + 归属披露
  build/
    annotate-entry.template.js         入口模板
    build-annotate-plugin.cjs          构建脚本（含去品牌化规则）
    decode-export.cjs                  base64 / ZIP 解码
    filegrep.cjs scan-asar.cjs asar-probe.cjs   宿主分析小工具
  vendor/source/                       第三方前端源码存档（仅重建用，不随插件分发）
  samples/                             验证产物
```

运行时输出写到仓库根 `.output/annotate-board/`（已在 `.gitignore` 中忽略）。

## 4. 构建

```powershell
# 在仓库根执行
node snow-annotate-board/build/build-annotate-plugin.cjs
node --check snow-annotate-board/index.js
```

构建脚本会打印每条替换规则命中数，并扫描入口里是否残留第三方标记（当前 0）。

## 5. 入口运行时

1. **桥封装**：`system.notify`、`filesystem.writeFile`（带分块降级）、`system.writeClipboardText`、`parent.snow.writeImageToClipboard`、`parent.snow.readFileContent`。
2. **草稿回填**：主路径 `chatInput.insertText({ text })`（无需令牌，返回 `{ ok: true, data: { length } }`，`length` 为插入后草稿长度），成功后同时复制到剪贴板。`chatInput.captureDraft` 在 iframe 插件里返回的 `data` **没有 `draftToken`**（实测），因此 `applyDraft` 只能作次级尝试；全部失败才仅剩剪贴板。
3. **Blob 追踪**：hook `URL.createObjectURL` 记录 `url → Blob`，供导出拦截取回原始 Blob（不用 fetch，避开 `connect-src`）。
4. **导出拦截**：hook `HTMLAnchorElement.prototype.click`，命中 `[download]` 且能取到 Blob 时不走原生下载，改为：
   - 图片 → base64 落盘 + 尝试写剪贴板图片
   - 反馈 JSON/文本 → 落盘 + 回填草稿 + 通知
   - 项目文件（`.annotate-board`）→ 落盘 + 登记到"最近项目"
   - ZIP → base64 落盘 + `DecompressionStream('deflate-raw')` 解包，抽出内部 `.json` 回填草稿
5. **剪贴板覆写**：`Object.defineProperty(Navigator.prototype, 'clipboard', ...)`，`writeText` 走草稿回填。
6. **工具条**：右下角两个自绘 Lucide 图标按钮——「新建」重放文档回到空状态；「最近」列出已保存项目，点击后构造 `File` 塞进 `#file-input` 完成导入。
7. **诊断**：事件日志写 `.output/annotate-board/_log.json`，启动时与旧日志合并（保留最近 120 条）；就绪标记写 `_panel-ready.txt`。不做任何写剪贴板或触发下载的自检。

## 6. 能力边界

| 项目 | 状态 |
| --- | --- |
| 导入图片（拖入 / 选择 / 粘贴）、示例画布 | 可用 |
| 区域批注、移动、缩放、大爆炸布局 | 可用 |
| 反馈 JSON / ZIP 导出 + 草稿回填 | 可用 |
| 项目保存、最近项目、新建 | 可用 |
| 视频批注 | 未验证（宿主 `media-src` 回退 `default-src 'self'`，`blob:` 视频受限） |
| 单张 PNG 导出、图片写剪贴板 | 未单独实测（同一链路） |
| 全局热键截屏、跨应用抓屏、系统 OCR、长截图、托盘贴图 | 宿主无对应能力 |
| 阻塞式命令行闭环、localhost Agent 会话 | 宿主 CSP 与进程模型不同 |

## 7. 合规

- 第三方前端代码按 PolyForm Noncommercial 1.0.0 授权，完整条款见 `LICENSES/LICENSE`，归属披露见 `LICENSES/NOTICE.txt`。
- 非商业用途；商业用途须取得该代码权利人的书面授权。分发时须随附 `LICENSES/LICENSE`。
- 产品名称、图标与界面标识均为自有，未使用第三方名称与商标。
- `vendor/source/` 与 `build/` 仅用于重建与维护，不作为插件内容分发。
