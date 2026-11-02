// 解码插件导出产物：node tools/decode-export.cjs <输入文件> [输出目录]
//   - *.b64 / *.b64.part* 一类 base64 文本 → 还原真实字节（PNG / ZIP / JSON）
//   - ZIP 自动解包到输出目录（支持 store 与 deflate）
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const input = process.argv[2];
const outDir = process.argv[3] || path.join(path.dirname(input), 'decoded');

if (!input) {
  console.log('usage: node tools/decode-export.cjs <file> [outDir]');
  process.exit(1);
}

function loadBase64Payload(file) {
  const text = fs.readFileSync(file, 'utf8');
  // 分块导出：同名 .parts 描述块数；否则整体就是一个 base64 串
  const partsMeta = file + '.parts';
  if (fs.existsSync(partsMeta)) {
    const meta = fs.readFileSync(partsMeta, 'utf8').trim().split(';');
    const count = Number(meta[0]);
    const chunks = [];
    for (let i = 0; i < count; i += 1) {
      chunks.push(fs.readFileSync(file + '.part' + i, 'utf8'));
    }
    return Buffer.from(chunks.join(''), 'base64');
  }
  return Buffer.from(text.replace(/\s+/g, ''), 'base64');
}

function parseZip(buf) {
  let eocd = -1;
  const minStart = Math.max(0, buf.length - 70000);
  for (let i = buf.length - 22; i >= minStart; i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('ZIP EOCD not found');
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const entries = [];
  for (let n = 0; n < count; n += 1) {
    if (buf.readUInt32LE(off) !== 0x02014b50) throw new Error('bad zip central header at ' + off);
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.toString('utf8', off + 46, off + 46 + nameLen);
    const lnameLen = buf.readUInt16LE(localOff + 26);
    const lextraLen = buf.readUInt16LE(localOff + 28);
    const dataStart = localOff + 30 + lnameLen + lextraLen;
    const comp = buf.subarray(dataStart, dataStart + compSize);
    const data = method === 0 ? Buffer.from(comp) : zlib.inflateRawSync(comp);
    entries.push({ name, data });
    off += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

const buf = loadBase64Payload(input);
fs.mkdirSync(outDir, { recursive: true });
console.log('DECODED_BYTES:', buf.length, 'head:', buf.subarray(0, 8).toString('hex'));

if (buf.subarray(0, 2).toString('latin1') === 'PK') {
  const entries = parseZip(buf);
  console.log('ZIP_ENTRIES:', entries.length);
  for (const entry of entries) {
    const target = path.join(outDir, entry.name.replace(/\.\./g, '_'));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, entry.data);
    console.log('  ' + entry.data.length + ' B -> ' + target);
  }
  process.exit(0);
}

const isPng = buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
const ext = isPng ? '.png' : path.extname(input).replace(/^\.b64/, '') || '.bin';
const target = path.join(outDir, path.basename(input).replace(/\.b64.*$/, '') + ext);
fs.writeFileSync(target, buf);
console.log('WROTE:', target, buf.length, 'B', isPng ? '(PNG)' : '');
