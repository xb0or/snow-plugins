// 受控 asar 工具：偏移已实测校准，只打印命中片段并限制总输出量
// 实测：u32@12 = JSON 字节长度；JSON 起点 = 16；数据区基址 = 8 + u32@4
// 用法：
//   node tools/scan-asar.cjs <关键词...>                 搜索 /out 下的 js
//   node tools/scan-asar.cjs --all <关键词...>           搜索全部非 unpacked 文件
//   node tools/scan-asar.cjs --dump <asar路径...>        导出文件到 tmp/
//   node tools/scan-asar.cjs --range <asar路径> <off> <len>  打印指定字节区间(utf8, len<=20000)
//   node tools/scan-asar.cjs --find <子串>               列出匹配路径的文件名+大小
const fs = require('fs');
const P = 'C:/Users/Administrator/AppData/Local/Programs/Snow App/resources/app.asar';
const fd = fs.openSync(P, 'r');

const head = Buffer.alloc(16);
fs.readSync(fd, head, 0, 16, 0);
const pickleSize = head.readUInt32LE(4);
const jsonLen = head.readUInt32LE(12);

const hb = Buffer.alloc(jsonLen);
fs.readSync(fd, hb, 0, jsonLen, 16);
const header = JSON.parse(hb.toString('utf8'));
const dataBase = 8 + pickleSize;

const files = [];
(function walk(n, p) {
  for (const k of Object.keys(n.files || {})) {
    const c = n.files[k];
    const np = p + '/' + k;
    if (c.files) walk(c, np);
    else files.push({ p: np, size: Number(c.size), offset: Number(c.offset), unpacked: !!c.unpacked });
  }
})(header, '');

const readRange = (f, max) => {
  const len = Math.min(f.size, max);
  const b = Buffer.alloc(len);
  fs.readSync(fd, b, 0, len, dataBase + f.offset);
  return b.toString('latin1');
};

const pkg = files.find((f) => f.p === '/package.json');
console.log('SANITY package.json@dataBase:', JSON.stringify(readRange(pkg, 20)), 'files=', files.length);

const argv = process.argv.slice(2);
const resolve = (p) => files.find((x) => x.p === (p.startsWith('/') ? p : '/' + p));

// range 模式
if (argv[0] === '--range') {
  const f = resolve(argv[1]);
  if (!f) {
    console.log('NOTFOUND', argv[1]);
    process.exit(1);
  }
  const start = Math.max(0, Number(argv[2]) || 0);
  const len = Math.min(Number(argv[3]) || 8000, 20000);
  const b = Buffer.alloc(len);
  fs.readSync(fd, b, 0, len, dataBase + f.offset + start);
  console.log(b.toString('utf8'));
  process.exit(0);
}

// find 模式
if (argv[0] === '--find') {
  const sub = argv[1];
  const hits = files.filter((f) => f.p.includes(sub)).slice(0, 40);
  for (const f of hits) console.log(f.unpacked ? 'UNPACKED' : '        ', f.size, f.p);
  console.log('MATCHES:', hits.length);
  process.exit(0);
}

// dump 模式
if (argv[0] === '--dump') {
  const outDir = 'C:/Users/Administrator/.snowapp/workspace/tmp';
  fs.mkdirSync(outDir, { recursive: true });
  for (const p of argv.slice(1)) {
    const f = resolve(p);
    if (!f) {
      console.log('NOTFOUND', p);
      continue;
    }
    if (f.unpacked) {
      console.log('UNPACKED', p);
      continue;
    }
    if (f.size > 24 * 1024 * 1024) {
      console.log('TOOBIG', p, f.size);
      continue;
    }
    const b = Buffer.alloc(f.size);
    fs.readSync(fd, b, 0, f.size, dataBase + f.offset);
    const name = p.startsWith('/') ? p.slice(1).replace(/[\/\\]/g, '_') : p.replace(/[\/\\]/g, '_');
    fs.writeFileSync(outDir + '/' + name, b);
    console.log('DUMPED', p, f.size, '-> tmp/' + name);
  }
  process.exit(0);
}

// 搜索模式
const scanAll = argv[0] === '--all';
const keys = scanAll ? argv.slice(1) : argv;
const targets = files.filter(
  (f) =>
    !f.unpacked &&
    f.size > 200 &&
    f.size < 12 * 1024 * 1024 &&
    (scanAll ? true : /^\/out\/.*\.(js|cjs|mjs)$/.test(f.p)),
);

let out = 0;
const LIM = 8000;
for (const k of keys) {
  if (out > LIM) break;
  console.log('===== KEY: ' + k + ' =====');
  for (const t of targets) {
    if (out > LIM) break;
    let s;
    try {
      s = readRange(t, 12 * 1024 * 1024);
    } catch (e) {
      continue;
    }
    let i = s.indexOf(k);
    let n = 0;
    while (i >= 0 && n < 2 && out <= LIM) {
      const seg = s.slice(Math.max(0, i - 300), i + 500).replace(/\s+/g, ' ');
      console.log('### ' + t.p + ' @' + i + ' :: ' + seg);
      out += seg.length + t.p.length;
      n++;
      i = s.indexOf(k, i + 1);
    }
  }
}
console.log('TARGETS_SCANNED:', targets.length);
