#!/usr/bin/env node
// assemble.cjs — 生成本地可移植部署目录 deploy/
//
// 目标环境：客户服务器 Windows Server 2008 R2（只能运行 Node 14.17.6——
// 14.18.0 起官方构建静态导入 WS2_32.dll 的 GetHostNameW，2008 R2 无此导出，
// 见 get-node.ps1 注释；node: 前缀由 deploy/node14-prefix-shim.cjs 垫片兼容）。
// 部署包必须完全自包含：node.exe + VC++ 运行库 + dist + public + 无链接的 node_modules。
//
// node_modules 的生成方式（重要，历经三个方案的取舍）：
//   ✗ 直接拷贝 pnpm 的 node_modules：绝对符号链接在客户机失效，且传递依赖
//     （fastify 的 avvio 等）存放在 .pnpm 兄弟目录，必然丢失。
//   ✗ npm 全新解析安装：会拉入 pnpm-lock 之外的新版本传递依赖（行为未经验证，
//     且部分新版本仅支持 Node 16+）。
//   ✓ 最终方案：
//     1) `pnpm deploy --prod` 导出锁定版本的依赖图（.pnpm 目录名即精确版本号）；
//     2) 把这些版本写入 npm `overrides`，npm 安装时即完全复刻 pnpm-lock 的版本，
//        同时得到扁平、真实文件、无链接的 node_modules（多版本共存的包按 npm
//        规则嵌套，交给 npm 处理）；
//     3) 应用 scripts/deploy/node14-patches/（kysely、openapi3-ts 官方产物含
//        ??=/||= 语法，Node 14 require 即 SyntaxError，改为语义等价的 ES2020 写法）。
//     4) @letian/* 工作区包按「package.json + dist」手动放入。
//
// 用法（仓库根目录执行，需联网走 npm 源）：  node scripts/deploy/assemble.cjs
// 前置：pnpm -r build 已完成。跳过 Node 14 兼容审计：  set SKIP_NODE14_CHECK=1
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = process.cwd();
const DEPLOY = path.join(ROOT, 'deploy');
const DEPLOY_NM = path.join(DEPLOY, 'node_modules');
const DEPLOY_DIST = path.join(DEPLOY, 'dist');
const DEPLOY_PUBLIC = path.join(DEPLOY, 'public');
const STAGE = path.join(ROOT, 'deploy-stage'); // pnpm deploy 的临时输出
const NPM_STAGE = path.join(ROOT, 'deploy-npm-stage'); // npm 扁平安装的临时目录
const PATCH_DIR = path.join(ROOT, 'scripts', 'deploy', 'node14-patches');

// node14-patches 对应的官方版本（不匹配则中止，提示重新生成补丁）
// 注意：pg 已降级锁定 8.16.0（自带 Node<15 原生 crypto 回退），无需补丁
const PATCH_VERSIONS = { kysely: '0.27.6', 'openapi3-ts': '4.6.1', mssql: '12.7.2', tedious: '20.0.0' };

// workspace 包根目录（其 package.json 的 dependencies 会被收集）
const WORKSPACE_PKGS = [
  path.join(ROOT, 'apps/api'),
  path.join(ROOT, 'packages/contracts'),
  path.join(ROOT, 'packages/domain'),
  path.join(ROOT, 'packages/application'),
  path.join(ROOT, 'packages/infrastructure'),
];

function log(...a) { console.log('[assemble]', ...a); }
function ensureDir(p) { fs.mkdirSync(p, { recursive: true }); }
function readJson(p) { return JSON.parse(fs.readFileSync(p, 'utf8')); }

// 递归「去符号链接」拷贝：符号链接解析到真实路径再进入（对 file: 目录依赖等
// npm 可能产生的链接同样生效），保证 deploy/node_modules 无任何链接。
function copyTree(src, dst, allow) {
  const st = fs.lstatSync(src);
  if (st.isSymbolicLink()) {
    copyTree(fs.realpathSync(src), dst, allow);
    return;
  }
  if (st.isDirectory()) {
    ensureDir(dst);
    for (const e of fs.readdirSync(src, { withFileTypes: true })) {
      if (allow && !allow(path.join(src, e.name), true)) continue;
      copyTree(path.join(src, e.name), path.join(dst, e.name), allow);
    }
    return;
  }
  if (st.isFile()) {
    if (allow && !allow(src, false)) return;
    fs.copyFileSync(src, dst);
  }
}

function copyDir(src, dst, label) {
  if (!fs.existsSync(src)) { console.warn(`  跳过 ${label}（不存在）: ${src}`); return; }
  fs.rmSync(dst, { recursive: true, force: true }); // 仅删除我们自己的部署目录，无副作用
  copyTree(src, dst);
  log(`${label} 拷贝完成 -> ${path.relative(ROOT, dst)}`);
}

// —— 1) 收集外部生产依赖及其当前安装的精确版本（来自 workspace 各包） ——
function collectExternalProdDeps() {
  const deps = {};
  const searchRoots = [path.join(ROOT, 'apps/api/node_modules'), ...WORKSPACE_PKGS.map((p) => path.join(p, 'node_modules'))];
  for (const pkgRoot of WORKSPACE_PKGS) {
    const manifest = readJson(path.join(pkgRoot, 'package.json'));
    for (const [name] of Object.entries(manifest.dependencies || {})) {
      if (name.startsWith('@letian/') || name.startsWith('@types/')) continue;
      if (deps[name]) continue;
      const found = searchRoots.map((r) => path.join(r, name)).find((p) => fs.existsSync(p));
      if (!found) throw new Error(`未找到已安装的依赖 ${name}，请先 pnpm install`);
      deps[name] = readJson(path.join(fs.realpathSync(found), 'package.json')).version;
    }
  }
  return deps;
}

// —— 2) pnpm deploy 导出锁定依赖图，解析 .pnpm 目录名得到全部包的锁定版本 ——
function lockedVersionsFromPnpm() {
  fs.rmSync(STAGE, { recursive: true, force: true });
  log('pnpm deploy 导出锁定版本依赖图...');
  const r = spawnSync('pnpm', ['--filter', '@letian/api', 'deploy', '--prod', 'deploy-stage'], {
    cwd: ROOT, stdio: 'inherit', shell: true,
  });
  if (r.status !== 0) throw new Error('pnpm deploy 失败');
  const pnpmDir = path.join(STAGE, 'node_modules', '.pnpm');
  if (!fs.existsSync(pnpmDir)) throw new Error('未找到 deploy-stage/node_modules/.pnpm');
  // 目录名形态：name@version[_peer@hash...]，scoped 包中 / 被写作 +
  const byName = new Map(); // name -> Set<version>
  for (const entry of fs.readdirSync(pnpmDir)) {
    const stripped = entry.split('_')[0];
    const m = stripped.match(/^(@[^@]+|[^@]+)@([^@]+)$/);
    if (!m) continue;
    const name = m[1].startsWith('@') ? m[1].replace('+', '/') : m[1];
    if (!byName.has(name)) byName.set(name, new Set());
    byName.get(name).add(m[2]);
  }
  return byName;
}

// —— 3) npm 扁平安装（overrides 复刻 pnpm-lock 版本） ——
function npmStageInstall(deps, byName) {
  const overrides = {};
  for (const [name, versions] of byName) {
    if (deps[name]) continue; // 直接依赖已在 dependencies 里精确锁定
    if (versions.size !== 1) continue; // 多版本共存：交给 npm 按嵌套规则解析
    overrides[name] = [...versions][0];
  }
  fs.rmSync(NPM_STAGE, { recursive: true, force: true });
  ensureDir(NPM_STAGE);
  fs.writeFileSync(
    path.join(NPM_STAGE, 'package.json'),
    JSON.stringify(
      {
        name: 'letian-qms-deploy-stage',
        private: true,
        engines: { node: '>=14.17' },
        dependencies: deps,
        overrides,
      },
      null,
      2
    )
  );
  log(`npm 安装 ${Object.keys(deps).length} 个直接依赖，overrides 锁定 ${Object.keys(overrides).length} 个传递依赖版本...`);
  const r = spawnSync('npm', ['install', '--omit=dev', '--no-audit', '--no-fund', '--loglevel=error'], {
    cwd: NPM_STAGE, stdio: 'inherit', shell: true,
  });
  if (r.status !== 0) throw new Error('npm install 失败');
}

// —— 4) 应用 Node 14 语法补丁（先校验版本一致） ——
function applyNode14Patches(nmDir) {
  for (const [pkg, expected] of Object.entries(PATCH_VERSIONS)) {
    const installed = readJson(path.join(nmDir, pkg, 'package.json')).version;
    if (installed !== expected) {
      throw new Error(`${pkg} 实际安装 ${installed}，与补丁版本 ${expected} 不符；请重跑 scripts/deploy/make-node14-patches.cjs`);
    }
    const patchRoot = path.join(PATCH_DIR, pkg);
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { walk(p); continue; }
        const dst = path.join(nmDir, pkg, path.relative(patchRoot, p));
        fs.copyFileSync(p, dst);
      }
    };
    walk(patchRoot);
    log(`Node14 补丁已应用：${pkg}@${installed}`);
  }
}

// —— 5) @letian 工作区包：只放 package.json + dist（等价各自 files 字段） ——
function placeWorkspacePackages() {
  ensureDir(path.join(DEPLOY_NM, '@letian'));
  for (const pkgRoot of WORKSPACE_PKGS.slice(1)) {
    const manifest = readJson(path.join(pkgRoot, 'package.json'));
    const dst = path.join(DEPLOY_NM, '@letian', manifest.name.replace(/^@letian\//, ''));
    fs.rmSync(dst, { recursive: true, force: true });
    ensureDir(dst);
    const allowed = (p, isDir) => {
      const rel = path.relative(pkgRoot, p);
      // 只放行 dist 目录本身与其内容（dist.old* 等备份目录绝不随包分发）
      if (rel === 'dist' || rel.startsWith(`dist${path.sep}`)) return true;
      if (path.basename(rel) === 'package.json') return true;
      if (['README.md', 'LICENSE'].includes(path.basename(p))) return true;
      return false;
    };
    copyTree(pkgRoot, dst, allowed);
    log(`工作区包 ${manifest.name} -> ${path.relative(ROOT, dst)}（package.json + dist）`);
  }
}

function main() {
  log('开始组装 deploy/ ...');
  ensureDir(DEPLOY);

  copyDir(path.join(ROOT, 'apps/api/dist'), DEPLOY_DIST, 'API 编译产物 dist');
  copyDir(path.join(ROOT, 'apps/api/public'), DEPLOY_PUBLIC, '前端静态文件 public');

  const deps = collectExternalProdDeps();
  const byName = lockedVersionsFromPnpm();
  npmStageInstall(deps, byName);

  const stageNm = path.join(NPM_STAGE, 'node_modules');
  applyNode14Patches(stageNm);

  fs.rmSync(DEPLOY_NM, { recursive: true, force: true });
  copyTree(stageNm, DEPLOY_NM); // copyTree 会去链接化，杜绝 file: 依赖的符号链接残留
  log(`node_modules 生成完成（npm 扁平布局 + 锁定版本 + Node14 补丁）-> ${path.relative(ROOT, DEPLOY_NM)}`);

  fs.rmSync(STAGE, { recursive: true, force: true });
  fs.rmSync(NPM_STAGE, { recursive: true, force: true });

  placeWorkspacePackages();

  // Node 14.17.6 兼容垫片：剥掉 require('node:xxx') 前缀（14.18.0 才支持该写法，
  // 而 14.18.0+ 在 2008 R2 上无法启动，见 get-node.ps1 注释）。
  fs.copyFileSync(path.join(ROOT, 'scripts/deploy/node14-prefix-shim.cjs'), path.join(DEPLOY, 'node14-prefix-shim.cjs'));
  log('node14-prefix-shim.cjs 已放入 deploy/（start.bat / migrate.bat 通过 -r 加载）');
  for (const bat of ['start.bat', 'migrate.bat']) {
    const batPath = path.join(DEPLOY, bat);
    if (fs.existsSync(batPath) && !fs.readFileSync(batPath, 'utf8').includes('node14-prefix-shim')) {
      console.warn(`  ⚠ deploy/${bat} 未引用 node14-prefix-shim.cjs（-r 参数缺失会导致 Cannot find module 'node:xxx'）`);
    }
  }

  if (process.env.SKIP_NODE14_CHECK !== '1') {
    log('运行 Node 14 兼容性审计（设 SKIP_NODE14_CHECK=1 可跳过）...');
    const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts/deploy/check-node14-compat.cjs'), DEPLOY], { stdio: 'inherit' });
    if (r.status !== 0) throw new Error('Node 14 兼容性审计未通过，见上方报告');
  }
  log('全部完成。deploy/ 现在包含：node.exe、redist/、dist、public、node_modules、start.bat、migrate.bat、.env、README.txt');
}

try {
  main();
} catch (err) {
  console.error('[assemble] 失败：', err);
  process.exit(1);
}
