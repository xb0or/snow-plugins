// asar 头偏移自检：只打印少量诊断信息，禁止全量 header 输出
const fs = require('fs');
const P = 'C:/Users/Administrator/AppData/Local/Programs/Snow App/resources/app.asar';
const fd = fs.openSync(P, 'r');
const head = Buffer.alloc(32);
fs.readSync(fd, head, 0, 32, 0);

const u32 = [];
for (let i = 0; i < 32; i += 4) u32.push(head.readUInt32LE(i));
console.log('U32[0,4,8,12,16,20,24,28] =', u32.join(', '));
for (const off of [8, 12, 16, 20]) {
  console.log('bytes@' + off + ' =', JSON.stringify(head.slice(off, off + 16).toString('latin1')));
}

// 猜测 jsonLen 字段与 JSON 起点
const cands = [
  { name: 'jsonLen@12 start@16', len: u32[3], start: 16 },
  { name: 'jsonLen@8  start@12', len: u32[2], start: 12 },
];
const totalBytes = fs.statSync(P).size;
console.log('ASAR_SIZE =', totalBytes);

for (const c of cands) {
  if (!c.len || c.len < 100 || c.len > totalBytes) {
    console.log('SKIP', c.name, 'len=', c.len);
    continue;
  }
  const b = Buffer.alloc(24);
  fs.readSync(fd, b, 0, 24, c.start);
  console.log('CAND', c.name, 'first24=', JSON.stringify(b.toString('latin1')), 'ok=', b[0] === 0x7b);
}
