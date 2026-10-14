/**
 * 部署准备：把前端构建产物 apps/web/dist 拷贝到 apps/api/public，
 * 供 @fastify/static 托管与 pkg assets 打包。
 * 用法：node scripts/deploy/copy-web-to-api.cjs
 */
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..', '..');
const srcDir = path.join(repoRoot, 'apps', 'web', 'dist');
const destDir = path.join(repoRoot, 'apps', 'api', 'public');

if (!fs.existsSync(path.join(srcDir, 'index.html'))) {
  console.error(`[copy-web] 未找到前端构建产物：${srcDir}`);
  console.error('[copy-web] 请先执行: pnpm --filter @letian/web run build');
  process.exit(1);
}

try {
  fs.rmSync(destDir, { recursive: true, force: true });
} catch (err) {
  // 删除失败（如目录被占用）不阻断：直接覆盖拷贝，残留的旧 hash 资源不影响运行
  console.warn(`[copy-web] 清理旧目录失败（忽略，改为覆盖拷贝）: ${err.message}`);
}
fs.cpSync(srcDir, destDir, { recursive: true });
const files = fs.readdirSync(destDir);
console.log(`[copy-web] 已拷贝 ${files.length} 项 → ${destDir}`);
