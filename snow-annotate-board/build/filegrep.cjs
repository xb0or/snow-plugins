// 受限上下文提取器：node tools/filegrep.cjs <file> <needle> [ctxChars] [maxHits]
// 只打印命中处 ±ctx 字符并压缩空白，避免超长单行炸上下文
const fs = require('fs');
const argv = process.argv.slice(2);
const file = argv[0];
const needle = argv[1];
const ctx = Number(argv[2]) || 150;
const max = Number(argv[3]) || 10;
const s = fs.readFileSync(file, 'utf8');
console.log('FILE_LEN: ' + s.length + ' NEEDLE: ' + JSON.stringify(needle));
let i = 0;
let n = 0;
while (n < max) {
  const j = s.indexOf(needle, i);
  if (j < 0) break;
  const seg = s.slice(Math.max(0, j - ctx), j + needle.length + ctx).replace(/\s+/g, ' ');
  console.log('@' + j + ' :: ' + seg);
  i = j + needle.length;
  n += 1;
}
console.log('HITS_SHOWN: ' + n);
