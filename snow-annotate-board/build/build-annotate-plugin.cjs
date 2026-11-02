// 构建「批注工作台」插件：node snow-annotate-board/build/build-annotate-plugin.cjs（在仓库根执行；脚本用 __dirname 定位，任意 CWD 等价）
//
// 流程：
//   1. 读取上游单文件构建产物（edithere-src/web__EditHere.html）
//   2. 去品牌化：标题/描述/品牌图/favicon/帮助文案/错误文案/全局符号/schema/tool.name/扩展名/存储键
//   3. 删除自带 CSP meta（与宿主 CSP 取交集会让脚本全禁）
//   4. 抽出可执行内联脚本为数组（宿主禁内联脚本），detector-code 改 text/plain 保住 textContent
//   5. 套入口模板生成 index.js + plugin.json + README.md
//
// 未命中的规则会打印出来，残留的旧标记会列出上下文，避免静默漏改。
const fs = require('fs');
const path = require('path');

const HERE = __dirname;
const PROJECT = path.resolve(HERE, '..');
const REPO = path.resolve(PROJECT, '..');
const SRC_HTML = path.join(PROJECT, 'vendor', 'source', 'web__EditHere.html');
const TEMPLATE = path.join(HERE, 'annotate-entry.template.js');
const OUT_DIR = PROJECT;
const OUTPUT_ROOT = path.join(REPO, '.output', 'annotate-board').split('\\').join('/');
const RUNTIME_OUT = OUTPUT_ROOT + '/';
const LOG_FILE = RUNTIME_OUT + '_log.json';

const PRODUCT_NAME = '批注工作台';
const PRODUCT_VERSION = '0.1.0';
const SCHEME_PREFIX = 'annotate-board';

function svgUri(svg) {
  return 'data:image/svg+xml;base64,' + Buffer.from(svg, 'utf8').toString('base64');
}

const brandLockup = function (color) {
  return svgUri(
    '<svg xmlns="http://www.w3.org/2000/svg" width="141" height="25" viewBox="0 0 141 25">' +
      '<rect x="0.5" y="0.5" width="140" height="24" rx="7" fill="none" stroke="' +
      color +
      '" stroke-opacity="0.32"/>' +
      '<text x="11" y="17" font-family="Microsoft YaHei, Segoe UI, sans-serif" font-size="12.5" fill="' +
      color +
      '">' +
      PRODUCT_NAME +
      '</text>' +
      '</svg>',
  );
};

const brandSymbol = svgUri(
  '<svg xmlns="http://www.w3.org/2000/svg" width="30" height="30" viewBox="0 0 30 30">' +
    '<rect x="1" y="1" width="28" height="28" rx="8" fill="#2b6cb0"/>' +
    '<path d="M8 21 L12.5 12 L17 18 L22 9.5" fill="none" stroke="#ffffff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>' +
    '</svg>',
);

const src = fs.readFileSync(SRC_HTML, 'utf8');
let doc = src;

// ---------- 去品牌化规则（顺序敏感：先处理含旧名的复合串，再全局替换裸名） ----------
const rules = [
  // 文档头
  ['meta-description', /content="EditHere 无边界工作台：图片批注、组件布局与视频时间点批注，在你的设备上完成。"/g,
    'content="' + PRODUCT_NAME + '：图片批注、组件布局与视频时间点批注，在你的设备上完成。"'],
  ['title', /<title>EditHere · 改这里<\/title>/g, '<title>' + PRODUCT_NAME + '</title>'],
  ['version-meta', /<meta name="edithere-version" content="[^"]*">/g,
    '<meta name="' + SCHEME_PREFIX + '-version" content="' + PRODUCT_VERSION + '">'],
  ['brand-aria', /aria-label="EditHere · 改这里"/g, 'aria-label="' + PRODUCT_NAME + '"'],
  // 品牌图与图标
  ['brand-lockup-light', /<img[^>]*class="brand-lockup brand-lockup-light"[^>]*>/g,
    '<img class="brand-lockup brand-lockup-light" src="' + brandLockup('#1f2937') + '" alt="' + PRODUCT_NAME + '" width="141" height="25">'],
  ['brand-lockup-dark', /<img[^>]*class="brand-lockup brand-lockup-dark"[^>]*>/g,
    '<img class="brand-lockup brand-lockup-dark" src="' + brandLockup('#f3f4f6') + '" alt="' + PRODUCT_NAME + '" width="141" height="25">'],
  ['brand-symbol', /<img[^>]*class="brand-symbol"[^>]*>/g,
    '<img class="brand-symbol" src="' + brandSymbol + '" alt="' + PRODUCT_NAME + '" width="30" height="30">'],
  ['favicon', /<link rel="icon"[^>]*>/g, '<link rel="icon" type="image/svg+xml" href="' + brandSymbol + '">'],
  // 帮助文案
  ['help-footnote-1', /系统截图与 OCR 仍需桌面 EditHere；网页可导入图片、视频和网页项目。/g,
    '系统截图与 OCR 需桌面端应用；此处可导入图片、视频和网页项目。'],
  ['help-footnote-2', /系统截图与 OCR 使用桌面 EditHere，Agent 也可先截图再传入。/g,
    '系统截图与 OCR 需桌面端应用，也可先截图再传入。'],
  ['help-continue', /继续，读取 EditHere 的反馈/g, '继续，读取批注反馈'],
  // 图标许可注释（保留第三方许可，去掉上游署名短语）
  ['icon-license', /Lucide \(ISC\/MIT\) and EditHere additions\./g, 'Lucide (ISC/MIT).'],
  // 全局符号
  ['sym-layout', /EditHereLayout/g, 'AnnotateLayout'],
  ['sym-image', /EditHereImage/g, 'AnnotateImage'],
  ['sym-feedback', /EditHereFeedback/g, 'AnnotateFeedback'],
  ['sym-bundle', /EditHereBundle/g, 'AnnotateBundle'],
  ['sym-detector', /EditHereDetector/g, 'AnnotateDetector'],
  ['sym-chrome', /EditHereChrome/g, 'AnnotateChrome'],
  ['sym-web', /EditHereWeb/g, 'AnnotateWeb'],
  // 数据格式常量
  ['urn', /urn:edithere:/g, 'urn:' + SCHEME_PREFIX + ':'],
  ['project-schema', /edithere-web-project-1/g, SCHEME_PREFIX + '-project-1'],
  ['project-ext', /\.edithere-web/g, '.' + SCHEME_PREFIX],
  // 存储键与内部事件
  ['ls-prefix', /'edithere\.'/g, "'" + SCHEME_PREFIX + ".'"],
  ['event-layout', /'edithere:layout'/g, "'" + SCHEME_PREFIX + ":layout'"],
  // 错误文案
  ['err-objects', /请导入 EditHere objects 格式/g, '请导入批注反馈 objects 格式'],
  ['err-zip', /Open a ZIP downloaded by EditHere, or extract and select its JSON and images\./g,
    'Open an exported ZIP, or extract and select its JSON and images.'],
  ['err-version', /EditHere build version is unavailable\./g, '构建版本不可用。'],
  // 默认文件名与工具名（先处理复合串）
  ['basename-default', /\|\|'EditHere'/g, "||'批注'"],
  ['tool-web', /'EditHere Web'/g, "'" + PRODUCT_NAME + "'"],
  ['tool-name-check', /value\.tool\.name\s*!==\s*'EditHere'\s*\|\|\s*/g, ''],
  ['product-const', /EDITHERE_PRODUCT_VERSION/g, 'ANNOTATE_PRODUCT_VERSION'],
  ['version-meta-ref', /meta\[name="edithere-version"\]/g, 'meta[name="' + SCHEME_PREFIX + '-version"]'],
  ['ext-bare', /edithere-web/g, SCHEME_PREFIX + '-project'],
  ['agent-route', /\/__edithere_agent\//g, '/__annotate_agent/'],
  ['desktop-project-text', /桌面 \.edithere 项目暂不支持/g, '桌面客户端项目暂不支持'],
  ['script-comment', /\/\* EditHere Web\. Offline editing with an optional local Agent session\. \*\//g,
    '/* ' + PRODUCT_NAME + '。离线编辑，可选本地 Agent 会话。 */'],
  ['doc-comment', /a claim that EditHere recognized a page/g, 'a claim that this tool recognized a page'],
  // 最后：兜底替换所有剩余的裸 'EditHere' 字面量
  ['tool-name-literal', /'EditHere'/g, "'" + PRODUCT_NAME + "'"],
  ['bare-brand', /EditHere/g, PRODUCT_NAME],
];

const applied = [];
for (const [name, re, to] of rules) {
  const before = doc;
  const hits = (doc.match(re) || []).length;
  doc = doc.replace(re, to);
  applied.push({ name: name, hits: hits, changed: before !== doc });
}

// 删除自带 CSP：与宿主 CSP 取交集会让所有脚本失效
const cspRe = /<meta\s+http-equiv="Content-Security-Policy"[^>]*>\s*/gi;
const removedCsp = (doc.match(cspRe) || []).length;
doc = doc.replace(cspRe, '');

// 抽出可执行内联脚本，detector-code 保留为不可执行类型
const scripts = [];
const extracted = doc.replace(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi, function (match, attrs, code) {
  const idMatch = /id\s*=\s*"([^"]+)"/i.exec(attrs);
  const id = idMatch ? idMatch[1] : '';
  if (id === 'detector-code') {
    return '<script type="text/plain" id="detector-code">' + code + '</script>';
  }
  const index = scripts.length;
  scripts.push({ id: id || 'script' + (index + 1), code: code });
  return '<!--EH_SCRIPT_' + index + '-->';
});
doc = extracted;

// ---------- 生成入口 ----------
let entry = fs.readFileSync(TEMPLATE, 'utf8');
entry = entry
  .replace('__EH_OUT_DIR__', JSON.stringify(RUNTIME_OUT))
  .replace('__EH_LOG_FILE__', JSON.stringify(LOG_FILE))
  .replace('__EH_SCRIPTS__', JSON.stringify(scripts))
  .replace('__EH_HTML__', JSON.stringify(doc));

const manifest = {
  id: 'com.seagull.annotate-board',
  name: { default: 'Annotate Board', 'zh-CN': PRODUCT_NAME },
  description: {
    default:
      'Annotation workspace: import an image or video, annotate regions, explode layouts, then export feedback JSON or annotated PNG into the workspace.',
    'zh-CN': PRODUCT_NAME + '：导入图片或视频、区域批注、大爆炸布局，导出反馈 JSON 或标注 PNG 到工作区。',
  },
  version: PRODUCT_VERSION,
  author: 'kedou',
  license: 'PolyForm-Noncommercial-1.0.0',
  icon: 'lucide:PenTool',
  renderMode: 'iframe',
  entry: 'index.js',
  panels: [
    {
      id: 'board',
      title: { default: 'Annotate Board', 'zh-CN': PRODUCT_NAME },
      icon: 'lucide:PenTool',
    },
  ],
  privacy: {
    scopes: ['filesystem'],
    note: '导出时把 JSON/PNG/ZIP 写入仓库根 .output/annotate-board 目录，并把 JSON 写回聊天草稿（失败时写入剪贴板）。',
  },
};

const readme = [
  '# ' + PRODUCT_NAME + '（Annotate Board）',
  '',
  'Snow 面板插件形式的批注工作台：导入图片或视频，做区域批注与布局调整，导出反馈 JSON（`feedback-minimal-4`）与标注 PNG。',
  '',
  '- 运行方式：面板插件，`renderMode: "iframe"`',
  '- 构建：`node snow-annotate-board/build/build-annotate-plugin.cjs`（在仓库根执行；脚本用 `__dirname` 定位，任意 CWD 等价）',
  '- 输出目录：仓库根 `.output/annotate-board/`（JSON 为纯文本，PNG/ZIP 为 base64 文本）',
  '- 解码：`node snow-annotate-board/build/decode-export.cjs ".output/annotate-board/<name>.zip.b64" .output/annotate-board/decoded`（同样在仓库根执行）',
  '',
  '## 构建期改造',
  '',
  '1. 内联脚本全部外置：宿主 iframe 继承 `script-src \'self\' blob:`（无 `unsafe-inline`），内联 `<script>` 不执行；构建时抽成数组，运行时以 blob URL 通过 `<script src>` 注入并保持顺序。',
  '2. 检测器脚本改为 `type="text/plain"`，保住 `textContent`（前端用它拼 Worker 代码）；blob Worker 在宿主 CSP 下可用。',
  '3. 删除自带 CSP meta。',
  '4. `<a download>` 拦截：插件 iframe 内原生下载不产生文件，改为经 Snow 桥落盘。',
  '5. `navigator.clipboard` 覆写：iframe 内原 API 报 `Document is not focused`，改走 Snow 剪贴板动作。',
  '6. 去品牌化：标题、品牌图、图标、帮助文案、错误文案、全局符号、数据格式常量、扩展名与存储键统一为本产品标识。',
  '',
  '## 许可',
  '',
  '本插件包含按 PolyForm Noncommercial 1.0.0 授权的第三方前端代码，完整条款见 `LICENSES/LICENSE`。',
  '非商业用途；商业用途需取得该第三方代码权利人的书面授权。',
  '',
].join('\n');

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(OUT_DIR + '/index.js', entry, 'utf8');
fs.writeFileSync(OUT_DIR + '/plugin.json', JSON.stringify(manifest, null, 2) + '\n', 'utf8');
fs.writeFileSync(OUT_DIR + '/README.md', readme, 'utf8');

// ---------- 报告 ----------
console.log('DOC_LEN:', doc.length);
console.log('SCRIPTS:', scripts.length, 'SCRIPTS_LEN:', scripts.reduce((n, s) => n + s.code.length, 0));
console.log('REMOVED_CSP_META:', removedCsp);
console.log('PLACEHOLDERS:', (doc.match(/<!--EH_SCRIPT_\d+-->/g) || []).length);
console.log('DETECTOR_PLAIN:', doc.indexOf('type="text/plain" id="detector-code"') > 0);
console.log('ENTRY_BYTES:', fs.statSync(OUT_DIR + '/index.js').size);
console.log('--- rule hits (0 = 未命中，需检查) ---');
for (const item of applied) {
  console.log('  ' + (item.hits > 0 ? 'OK ' : 'MISS ') + item.name + ' : ' + item.hits);
}

// 残留扫描（入口整体，含脚本数组）
const payload = entry;
const leftovers = [];
const leftoverRe = /EditHere|edithere|EDIT_HERE/gi;
let m;
while ((m = leftoverRe.exec(payload)) !== null) {
  const at = m.index;
  leftovers.push(payload.slice(Math.max(0, at - 60), at + 70).replace(/\s+/g, ' '));
  if (leftovers.length >= 12) break;
}
console.log('--- leftover upstream marks: ' + leftovers.length + ' ---');
for (const seg of leftovers) {
  console.log('  @@ ' + seg);
}
