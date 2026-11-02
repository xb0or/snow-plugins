# 项目记忆（跨会话事实）

本文件是该项目的事实沉淀，供新会话快速恢复上下文。记忆库（memory bank）按项目目录绑定，迁移项目目录后需要重新导入。

## 一、Snow 插件 iframe 运行时（宿主 0.5.10 实测）

1. **entry 形态**：iframe 面板的 entry 是**经典 JS 脚本**，宿主自建 HTML 骨架（`#snow-plugin-root` + `<style>`），以 `<script src="blob:...">` 加载；iframe 元素**没有 sandbox 属性**。
2. **宿主 CSP**（`/out/renderer/index.html`）：
   `default-src 'self'; script-src 'self' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: theme-bg: img-proxy:; connect-src 'self' ws: wss: http: https: img-proxy:; frame-src 'self' blob: data: html-preview:`
3. **内联脚本被禁**：`srcdoc` / `blob:` / `data:` 三种子文档都继承容器 CSP，`inline <script>` 一律不执行（实测 3/3）。子文档自声明 CSP 会与容器取交集，收紧即全禁。
4. **可用**：`blob:` 脚本、blob Worker（`worker-src` 回退 `script-src`）、内联 `<style>`、`data:`/`blob:` 图片。
5. **写盘**：`filesystem.writeFile` 参数 `{ filePath, content }`，仅 UTF-8 文本；`encoding: 'base64'` / `base64: true` 被静默忽略；`contentBase64` 报错；目录不存在时自动创建。
6. **iframe 可访问 `window.parent.snow`**（758 个 preload API）：`readFileContent`、`writeFileContent`、`writeImageToClipboard`、`saveHtmlPreview`、`importImageFiles`、`listAppLogs` 等。
7. **草稿写回**：`chatInput.insertText({ text })` 在 iframe 插件可用，返回 `{ ok: true, data: { length } }`（`length` 为插入后草稿长度），实测输入框出现文本。`chatInput.captureDraft` 在 iframe 里返回的 `data` **没有 `draftToken`**（实测 `hasToken: false`），所以 `applyDraft` 不可用；要用令牌能力必须走 ESM。所有 `api.write` 动作统一返回 `{ ok, action, data }` 包装，判断成功读 `r.ok` / `r.data`。
8. **iframe 内限制**：`navigator.clipboard.writeText` 报 `Document is not focused`（需覆写）；`<a download>` 不产生任何文件（需 hook 改成桥落盘）。

## 二、本项目（snow-annotate-board）

- 插件 id：`com.seagull.annotate-board`，`renderMode: "iframe"`，面板 id `board`。
- 源码与产物：本目录；安装副本：`~/.snowapp/plugins/com.seagull.annotate-board/`。
- 运行时输出：仓库根 `.output/annotate-board/`（`_log.json`、导出 JSON、`.zip.b64`、`.png.b64`）。
- 构建：在仓库根执行 `node snow-annotate-board/build/build-annotate-plugin.cjs`（脚本用 `__dirname` 定位，任意 CWD 等价）；语法检查 `node --check snow-annotate-board/index.js`。
- 解码：在仓库根执行 `node snow-annotate-board/build/decode-export.cjs ".output/annotate-board/<name>.zip.b64" ".output/annotate-board/decoded"`。
- 去品牌化规则在构建脚本里（34 条），构建会扫描入口残留，当前 0。

## 三、已知边界

- 视频批注未验证：宿主 `media-src` 回退 `default-src 'self'`，`blob:` 视频源受限。
- 单张 PNG 导出、图片写剪贴板未单独实测。
- 全局热键截屏、跨应用抓屏、系统 OCR、长截图、托盘贴图：宿主无对应能力。
- 第三方前端为 PolyForm Noncommercial 1.0.0；`LICENSES/` 必须随插件分发。

## 四、待办

1. 视频导入路径验证与修复。
2. 单张 PNG 导出链路实测。
3. 如需输入框旁一键回填按钮，需迁移到 ESM + `panels[].chatInputAction`。
