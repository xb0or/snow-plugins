# 工作记录：批注工作台（snow-annotate-board）

时间：2026-11-01
运行环境：Snow App 0.5.10 / Windows / Node v24.21.0

## 1. 起点与结论

目标是把一个网页版图片批注前端搬进 Snow 插件。两条前置验证先跑通，再定形态。

### 验证一：iframe 面板能否直接吃任意 HTML

结论：**不能原样吃，但只需机械改写**。

| 承载方式 | 内联脚本执行 | origin |
| --- | --- | --- |
| `srcdoc` | 否 | null |
| `blob:`（宿主实际用法） | 否 | file:// |
| `data:` | 否 | null |

- 宿主 iframe 元素没有 `sandbox` 属性；entry 是作为 `text/javascript` 脚本加载的，HTML 骨架由宿主自建（`#snow-plugin-root`）。
- 宿主渲染进程 CSP：`script-src 'self' blob:`（**无 `unsafe-inline'**）、`frame-src 'self' blob: data: html-preview:`、`style-src 'self' 'unsafe-inline'`、`img-src 'self' data: blob:`。
- 三种子文档都继承容器 CSP，内联 `<script>` 一律不执行。
- 子文档若再声明 CSP，会与容器 CSP 取交集；`'unsafe-inline'` 与 `'self' blob:` 交集为空 → 全部脚本失效。所以内联 HTML 必须删掉自带 CSP。
- `blob:` Worker 可用（`worker-src` 未声明时回退 `script-src`，其中含 `blob:`）。

### 验证二：`filesystem.writeFile` 是否支持二进制

结论：**只能写 UTF-8 文本**。

- 参数 `{ filePath, content }`；`encoding: 'base64'` 与 `base64: true` 被静默忽略（写出的仍是 base64 文本）；`contentBase64` 报错 `Parameter 'content' must be a non-empty string`。
- 目标目录不存在时自动创建。
- 由此确定二进制交付策略：PNG/ZIP 以 base64 落盘，由 `build/decode-export.cjs` 解码。

## 2. 形态判定

**面板插件，`renderMode: "iframe"`**。

- 脚本插件不合适：需要独立画布与独立样式表，不该往宿主插槽里塞控件。
- 不走 ESM：前端是 9 段经典脚本（UMD），重打成 ESM 成本高，且 `<style>` 会污染宿主界面；iframe 天然隔离。
- 代价：`panels[].chatInputAction` 仅 ESM 生效，所以"输入框旁一键回填"按钮拿不到。但实测 `api.write.run('chatInput.*')` 在 iframe 桥里可用，因此改为导出后直接回填草稿。

## 3. 构建流水线

```
vendor/source/web__EditHere.html         上游单文件产物（存档，仅重建用）
        │  build/build-annotate-plugin.cjs
        │   1. 去品牌化规则表（34 条）
        │   2. 删除自带 CSP meta
        │   3. 抽出 8 段可执行内联脚本 → 数组
        │   4. 检测器脚本改 type="text/plain"（保住 textContent）
        ▼
snow-annotate-board/
  plugin.json / index.js / README.md     构建产物（可直接安装）
  NOTES.md                               技术与合规说明
  LICENSES/                              第三方许可 + 归属披露
  build/                                 构建、解码与宿主分析脚本
  samples/                               验证产物
```

构建自检：打印每条规则命中数，并扫描入口里是否残留第三方标记（当前 0）。

## 4. 三个线上问题与修复

### 4.1 剪贴板被 probe JSON 污染

原因：入口里留了调试自检（`_hook-selftest.json` / `_selftest.json`），每次面板加载都会走一遍导出交付，其中一条会把 JSON 写进系统剪贴板。

修复：删除全部自检；就绪标记只写 `_panel-ready.txt`，不再触碰剪贴板，也不触发下载。日志改在事件发生时记录，并跨会话累积（启动时读取旧 `_log.json` 合并）。

### 4.2 「复制 JSON 与图片」不写回聊天草稿

原因：`chatInputAction` 只在 ESM 生效，而此前交付只做落盘 + 剪贴板。

修复（两次迭代，第一次是错的）：

- 第一版用 `captureDraft` → `applyDraft`。日志显示 `hasToken: false`：iframe 插件拿不到 `draftToken`，`applyDraft` 静默无效；而这时剪贴板兜底又被去掉，结果草稿和剪贴板都是空的。
- 第二版改用 `chatInput.insertText({ text })`（无需令牌），返回 `{ ok: true, data: { length } }`；实测聊天输入框出现 JSON。
- 最终逻辑：主路径 insertText，成功后同时复制到剪贴板；insertText 失败再试 capture/apply；只有全部失败才仅剩剪贴板。
- 经验：所有 `api.write` 动作统一返回 `{ ok, action, data }` 包装，判断成功要读 `r.ok` / `r.data`，不能读顶层字段。

- ZIP 包 → base64 落盘 + `DecompressionStream('deflate-raw')` 解包，抽出内部 `.json` 回填。
- `navigator.clipboard.writeText`（「复制 JSON 内容」按钮）→ 同样走草稿回填。

### 4.3 粘贴图片后回不到首页、没有项目列表

原因：上游是单文档应用，`#open` / `#drop-card` 只绑定了文件选择，没有"返回/新建"入口，也不持久化项目列表。

修复：在入口里注入自有工具条（右下角，两个 Lucide 图标按钮）：

- **新建**：`document.open/write/close` 重放文档，回到空状态，并重新注入工具条。
- **最近**：从 `localStorage['annotate-board.recent-projects']` 读列表；保存项目时登记（名称、落盘路径、时间，小于 1.2 MB 时同时存文本）。点击条目时优先用内存文本，否则用 `parent.snow.readFileContent(路径)` 读回，构造 `File` 塞进 `#file-input` 并派发 `change`，完成导入。

## 5. 去品牌化

界面与代码里的上游标识全部替换为自有标识：标题、描述、版本 meta、3 张品牌图（换成自绘 SVG）、favicon、帮助与错误文案、7 个全局符号（`EditHere*` → `Annotate*`）、数据 URN、项目 schema 与扩展名、localStorage 前缀、内部事件名、默认文件名、`tool.name`、agent 路由。

`tool.name` 的导入校验已放宽，旧格式数据仍可导入。构建脚本会对入口整体扫描 `(?i)edithere`，当前 0 残留（`build/` 与 `vendor/` 属内部工具与存档，不随插件分发）。

## 6. 当前状态

| 项目 | 状态 |
| --- | --- |
| 面板渲染、图片导入、批注、大爆炸布局 | 已验证 |
| JSON / ZIP 导出落盘 | 已验证 |
| 草稿回填（JSON 与图片、复制 JSON 内容） | 已验证 |
| 工具条新建 / 最近项目 | 已验证可用 |
| 剪贴板不再被自检污染 | 已验证 |
| 视频批注 | 未验证（宿主 `media-src` 回退 `default-src 'self'`，`blob:` 视频受限） |
| 单张 PNG 导出、图片写剪贴板 | 未单独实测（同一交付链路） |
| 全局热键截屏 / 系统 OCR / 长截图 / 托盘贴图 | 宿主不提供 |

## 7. 复现命令

```powershell
# 构建（在仓库根 F:\desktop\code\snow-plugins 执行）
node snow-annotate-board/build/build-annotate-plugin.cjs
node --check snow-annotate-board/index.js

# 解码导出产物
node snow-annotate-board/build/decode-export.cjs ".output/annotate-board/<name>.zip.b64" ".output/annotate-board/decoded"
```

## 8. 合规

第三方前端按 PolyForm Noncommercial 1.0.0 授权，条款见 `LICENSES/LICENSE`，归属披露见 `LICENSES/NOTICE.txt`。非商业用途；商业使用需取得权利人书面授权。产品名称、图标与界面标识为自有。
