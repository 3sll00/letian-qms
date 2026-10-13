/** 临时：统计 any 按文件分布（与 audit_check.js 同口径） */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = process.cwd();
const SKIP = new Set([
  'node_modules', '.git', 'dist', 'out', 'release', 'web-dist',
  'smoke-output', 'coverage', '.vite', '.turbo', '.cache', 'logs', 'scripts',
]);

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(e.name) && !/\.d\.ts$/.test(e.name)) out.push(p);
  }
  return out;
}

const RE = /\bas\s+any\b|:\s*any\b|<any>|,\s*any\b|\|\s*any\b|\bany\[\]|z\.any\(/;
const per = new Map();
let total = 0;

for (const f of walk(ROOT)) {
  const raw = fs
    .readFileSync(f, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  let n = 0;
  for (const line of raw.split('\n')) if (RE.test(line)) n += 1;
  if (n > 0) {
    per.set(path.relative(ROOT, f).split(path.sep).join('/'), n);
    total += n;
  }
}

const arr = [...per.entries()].sort((a, b) => b[1] - a[1]);
process.stdout.write(`含 any 的文件: ${per.size} 个 / 总计 ${total} 处\n\n--- TOP 25 ---\n`);
for (const [f, n] of arr.slice(0, 25)) process.stdout.write(`${String(n).padStart(4)}  ${f}\n`);
process.stdout.write(`\n预算 138，需削减至少 ${total - 138} 处\n`);
process.stdout.write(`前 10 个文件合计: ${arr.slice(0, 10).reduce((s, x) => s + x[1], 0)} 处\n`);