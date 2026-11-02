# 批注工作台（Annotate Board）

Snow 面板插件形式的批注工作台：导入图片或视频，做区域批注与布局调整，导出反馈 JSON（`feedback-minimal-4`）与标注 PNG。

- 运行方式：面板插件，`renderMode: "iframe"`
- 构建：`node snow-annotate-board/build/build-annotate-plugin.cjs`（在仓库根执行；脚本用 `__dirname` 定位，任意 CWD 等价）
- 输出目录：仓库根 `.output/annotate-board/`（JSON 为纯文本，PNG/ZIP 为 base64 文本）
- 解码：`node snow-annotate-board/build/decode-export.cjs ".output/annotate-board/<name>.zip.b64" .output/annotate-board/decoded`（同样在仓库根执行）

## 构建期改造

1. 内联脚本全部外置：宿主 iframe 继承 `script-src 'self' blob:`（无 `unsafe-inline`），内联 `<script>` 不执行；构建时抽成数组，运行时以 blob URL 通过 `<script src>` 注入并保持顺序。
2. 检测器脚本改为 `type="text/plain"`，保住 `textContent`（前端用它拼 Worker 代码）；blob Worker 在宿主 CSP 下可用。
3. 删除自带 CSP meta。
4. `<a download>` 拦截：插件 iframe 内原生下载不产生文件，改为经 Snow 桥落盘。
5. `navigator.clipboard` 覆写：iframe 内原 API 报 `Document is not focused`，改走 Snow 剪贴板动作。
6. 去品牌化：标题、品牌图、图标、帮助文案、错误文案、全局符号、数据格式常量、扩展名与存储键统一为本产品标识。

## 许可

本插件包含按 PolyForm Noncommercial 1.0.0 授权的第三方前端代码，完整条款见 `LICENSES/LICENSE`。
非商业用途；商业用途需取得该第三方代码权利人的书面授权。
