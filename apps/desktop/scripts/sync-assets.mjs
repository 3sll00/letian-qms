/**
 * 资产同步脚本：
 * 1. 默认：把 apps/web 的构建产物 (dist/) 复制到本包 web-dist/（electron-builder 打包内容）；
 * 2. --settings-only：仅把设置窗口页面复制到 out/settings/（esbuild 不处理静态 HTML）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(__dirname, '..');
const webDist = path.resolve(desktopRoot, '../web/dist');

const settingsOnly = process.argv.includes('--settings-only');

// 设置窗口页面：src/settings -> out/settings（主进程从 out/settings/index.html 加载）
fs.cpSync(
  path.join(desktopRoot, 'src/settings'),
  path.join(desktopRoot, 'out/settings'),
  { recursive: true }
);

if (settingsOnly) {
  process.exit(0);
}

if (!fs.existsSync(path.join(webDist, 'index.html'))) {
  console.error(
    '[sync-assets] 未找到 apps/web/dist/index.html。\n' +
      '请先构建前端产物：pnpm --filter @letian/web run build（或 build:mock 演示模式）。'
  );
  process.exit(1);
}

fs.rmSync(path.join(desktopRoot, 'web-dist'), { recursive: true, force: true });
fs.cpSync(webDist, path.join(desktopRoot, 'web-dist'), { recursive: true });
console.log('[sync-assets] apps/web/dist -> apps/desktop/web-dist 同步完成');
