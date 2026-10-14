#!/usr/bin/env node
// check-node14-compat.cjs — 扫描部署产物，拦截 Node 15/16/18+ 独有的语法与 API
//
// 背景：客户服务器为 Windows Server 2008 R2，只能运行 Node 14.21.3（V8 8.4）。
// 该脚本扫描 deploy/dist 与 deploy/node_modules 中的 JS 文件，发现以下两类问题：
//   1. 语法级（加载即 SyntaxError）：??= / &&= / ||=（ES2021 逻辑赋值）、static {} 初始化块
//   2. API 级（调用时才报错）：structuredClone、replaceAll、Object.hasOwn、
//      Promise.any、findLast、.at()、全局 fetch、全局 AbortController、fs.cp 等
//
// 用法：node scripts/deploy/check-node14-compat.cjs [目录=deploy]
// 退出码：发现未豁免项时为 1（可接入 assemble / CI 作为门禁）。
const fs = require('fs');
const path = require('path');

const TARGET = process.argv[2] ? path.resolve(process.argv[2]) : path.join(process.cwd(), 'deploy');

// —— 语法级：Node 14（V8 8.4）不支持，require 即抛 SyntaxError ——
const SYNTAX_RULES = [
  { pattern: '??=', name: '逻辑空赋值 (ES2021)' },
  { pattern: '&&=', name: '逻辑与赋值 (ES2021)' },
  { pattern: '||=', name: '逻辑或赋值 (ES2021)' },
  { pattern: 'static {', name: '类静态初始化块 (ES2022)' },
  { pattern: 'static{', name: '类静态初始化块 (ES2022)' },
];

// —— API 级：Node 14 运行时不存在或非全局 ——
const API_RULES = [
  { pattern: 'structuredClone(', name: 'structuredClone', since: 'Node 17+' },
  { pattern: '.replaceAll(', name: 'String.replaceAll', since: 'Node 15+' },
  { pattern: 'Object.hasOwn(', name: 'Object.hasOwn', since: 'Node 16.9+' },
  { pattern: 'Promise.any(', name: 'Promise.any', since: 'Node 15+' },
  { pattern: '.findLast(', name: 'Array.findLast', since: 'Node 18+' },
  { pattern: '.findLastIndex(', name: 'Array.findLastIndex', since: 'Node 18+' },
  { pattern: '.at(', name: 'Array/String.at', since: 'Node 16.6+' },
  { pattern: 'fetch(', name: '全局 fetch', since: 'Node 18（undici）' },
  { pattern: 'AbortController', name: '全局 AbortController', since: 'Node 15' },
  { pattern: 'cpSync(', name: 'fs.cpSync', since: 'Node 16.7+' },
  { pattern: 'fs.cp(', name: 'fs.cp', since: 'Node 16.7+' },
];

// 整包豁免：这些路径前缀下的任何命中均豁免。
// 依据：Node 14.21.3 实机探针（require 全部运行时依赖 + @letian 全链）已全部通过，
// 证明下列代码不在服务端 require 路径上，或属于运行时不可达分支。
const GLOBAL_ALLOW_PATHS = [
  'node_modules/@azure/',               // 仅 tedious 的 AAD 认证分支使用（已补丁为懒加载）；本项目 ERP 走 SQL 账号认证
  'node_modules/@typespec/',            // @azure 新版运行时库的依赖，同上
  'node_modules/default-browser',       // 桌面“打开浏览器”工具链，服务端不用
  'node_modules/open/',                 // 同上
  'node_modules/es-abstract/',          // structuredClone 仅位于其 DetachArrayBuffer 规范算法内部，不在调用路径
  'node_modules/@js-joda/core/src/',    // 命中的是 src/ 源码注释；运行时只加载 dist
  'node_modules/js-md4/doc/',           // 文档站示例脚本
  'node_modules/thread-stream/test/',   // pino 生态的测试文件
  'node_modules/abort-controller/',     // AbortController 的 polyfill 包：browser 构建仅浏览器用，node 构建有 typeof 守卫
];

// 按模式豁免：pattern → 允许的路径子串（含原因）。
const WHITELIST = {
  'fetch(': [
    // kysely 的 SQL 查询构建器方法 .fetch(rowCount, modifier)，与全局 fetch 无关
    'node_modules/kysely/dist/',
    // fastify 自带的测试文件（同时命中 AbortController），运行时不会 require
    'node_modules/fastify/test/',
    // LRUCache.fetch() 是缓存类的方法名，与全局 fetch 无关
    'node_modules/lru-cache/dist/',
  ],
  'AbortController': [
    'node_modules/fastify/test/',
    // light-my-request 是 fastify 的测试客户端，命中均在其 test/ 目录
    'node_modules/light-my-request/test/',
    // lru-cache 为 typeof 守卫写法（未定义时不使用），API 探针已验证可加载
    'node_modules/lru-cache/dist/',
    // readable-stream 为「全局存在 || polyfill」守卫写法，Node 14 自动回退 abort-controller 包
    'node_modules/readable-stream/',
    // 该行是 node14-patches 补丁产物：typeof 守卫，Node 14 回退 abort-controller polyfill
    'node_modules/tedious/lib/connection.js',
  ],
  '.at(': [
    // kysely 该命中位于 JSDoc 注释示例中
    'node_modules/kysely/dist/',
    // mssql 的 msnodesqlv8 本机驱动路径（默认走 tedious 纯 JS 驱动，不加载）
    'node_modules/mssql/lib/msnodesqlv8/',
  ],
  '.replaceAll(': [
    'node_modules/pino/test/',
  ],
  '??=': [
    // 命中位于 // TODO 注释文本中，非可执行代码
    'node_modules/is-docker/',
    'node_modules/is-inside-container/',
  ],
};

const SCAN_DIRS = ['dist', 'node_modules'];
const EXT = new Set(['.js', '.cjs', '.mjs']);

function isWhitelisted(rulePattern, relPath) {
  if (GLOBAL_ALLOW_PATHS.some((frag) => relPath.startsWith(frag))) return true;
  const allows = WHITELIST[rulePattern];
  if (!allows) return false;
  return allows.some((frag) => relPath.includes(frag));
}

function scan() {
  const hits = []; // { rule, file, line, snippet }
  let fileCount = 0;

  for (const dir of SCAN_DIRS) {
    const abs = path.join(TARGET, dir);
    if (!fs.existsSync(abs)) continue;
    walk(abs, (file) => {
      if (!EXT.has(path.extname(file))) return;
      fileCount++;
      const buf = fs.readFileSync(file);
      const relPath = path.relative(TARGET, file).replace(/\\/g, '/');
      for (const rule of [...SYNTAX_RULES, ...API_RULES]) {
        const idx = buf.indexOf(rule.pattern);
        if (idx === -1) continue;
        const line = buf.slice(0, idx).toString('utf8').split('\n').length;
        const lineStart = buf.lastIndexOf('\n', idx) + 1;
        const lineEnd = buf.indexOf('\n', idx);
        const snippet = buf.slice(lineStart, lineEnd === -1 ? buf.length : lineEnd).toString('utf8').trim().slice(0, 160);
        hits.push({ rule, relPath, line, snippet, whitelisted: isWhitelisted(rule.pattern, relPath) });
      }
    });
  }
  return { hits, fileCount };
}

function walk(dir, cb) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === '.bin' || e.name.startsWith('.')) continue;
      walk(p, cb);
    } else {
      cb(p);
    }
  }
}

function main() {
  console.log(`[node14-compat] 扫描目标: ${TARGET}`);
  const { hits, fileCount } = scan();
  const blocked = hits.filter((h) => !h.whitelisted);
  const allowed = hits.filter((h) => h.whitelisted);

  const byPattern = new Map();
  for (const h of blocked) {
    if (!byPattern.has(h.rule.pattern)) byPattern.set(h.rule.pattern, []);
    byPattern.get(h.rule.pattern).push(h);
  }

  for (const [pattern, list] of byPattern) {
    const rule = list[0].rule;
    console.log(`\n✗ [${rule.name || rule.pattern} 需要 ${rule.since || '语法级不支持'}] 命中 ${list.length} 处，例如：`);
    for (const h of list.slice(0, 5)) {
      console.log(`    ${h.relPath}:${h.line}`);
      console.log(`      ${h.snippet}`);
    }
    if (list.length > 5) console.log(`    ...等共 ${list.length} 处`);
  }

  if (allowed.length) {
    console.log(`\n（豁免命中 ${allowed.length} 处，详见脚本 WHITELIST 注释）`);
  }

  console.log(`\n[node14-compat] 扫描文件 ${fileCount} 个；未豁免命中 ${blocked.length} 处。`);
  if (blocked.length > 0) {
    console.error('[node14-compat] 存在 Node 14 不兼容项，请修复或经人工确认后加入 WHITELIST。');
    process.exit(1);
  }
  console.log('[node14-compat] 通过：未发现 Node 14 不兼容项。');
}

main();
