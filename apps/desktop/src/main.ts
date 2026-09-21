/**
 * 乐天QMS 桌面客户端主进程。
 *
 * 职责：
 * 1. 启动一个仅监听 127.0.0.1 的内置静态服务器，托管 @letian/web 构建产物
 *    （web-dist/），让渲染进程运行在稳定的 http 源下，避免 file:// 源的
 *    Service Worker / fetch 相对路径 / CORS null origin 系列问题；
 * 2. 维护 userData/config.json 中的服务器地址配置，并通过 preload 暴露给前端
 *    （apps/web 的 resolveApiBase 读取后把请求发往远程 Fastify 后端）；
 * 3. 提供应用菜单（服务器设置 / 开发者工具 / 缩放）与单实例锁。
 *
 * 运行模式（命令行参数）：
 *   --dev    连接本机 Vite 开发服务器 (http://127.0.0.1:5200)，不依赖 web-dist；
 *   --smoke  冒烟测试：加载完成后截图到 smoke-output/screenshot.png 并退出。
 */
import { app, BrowserWindow, dialog, ipcMain, Menu, shell } from 'electron';
import http from 'node:http';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

const IS_DEV = process.argv.includes('--dev');
const IS_SMOKE = process.argv.includes('--smoke');
const IS_SMOKE_SETTINGS = process.argv.includes('--smoke-settings');

/** 内置静态服务器优先使用的固定端口（端口稳定则 http 源与 Service Worker 注册保持不变） */
const PREFERRED_PORT = 5917;
const VITE_DEV_URL = 'http://127.0.0.1:5200';

/** 应用根目录（dev：apps/desktop；打包后：asar 内应用根） */
const APP_ROOT = path.join(__dirname, '..');
const WEB_DIST_DIR = path.join(APP_ROOT, 'web-dist');
const SETTINGS_PAGE = path.join(__dirname, 'settings', 'index.html');
/** 冒烟截图输出目录：开发态输出到工程根 smoke-output，打包后输出到系统 userData 避免 asar 只读错误 */
function smokeOutputDir(): string {
  return app.isPackaged
    ? path.join(app.getPath('userData'), 'smoke-output')
    : path.join(APP_ROOT, 'smoke-output');
}

/** 桌面端窗口尺寸：对齐 21 张高保真设计稿的桌面布局密度 */
const WINDOW_WIDTH = 1440;
const WINDOW_HEIGHT = 900;

interface DesktopConfig {
  /** 用户配置的 API 基址；空串表示未配置（回退到构建期 VITE_API_BASE 或相对路径） */
  serverUrl: string;
}

function configPath(): string {
  return path.join(app.getPath('userData'), 'config.json');
}

function readConfig(): DesktopConfig {
  try {
    const raw = fs.readFileSync(configPath(), 'utf-8');
    const parsed = JSON.parse(raw) as Partial<DesktopConfig>;
    return { serverUrl: typeof parsed.serverUrl === 'string' ? parsed.serverUrl : '' };
  } catch {
    return { serverUrl: '' };
  }
}

function writeConfig(config: DesktopConfig): void {
  fs.mkdirSync(path.dirname(configPath()), { recursive: true });
  fs.writeFileSync(configPath(), `${JSON.stringify(config, null, 2)}\n`, 'utf-8');
}

/**
 * 归一化服务器地址：与 apps/web 的 normalizeServerUrl 保持同一规则 ——
 * 只填主机时自动补 /api/v1，非法输入返回 null。
 */
function normalizeServerUrl(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  const text = raw.trim();
  if (text === '') return null;
  try {
    const url = new URL(text);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (url.pathname === '' || url.pathname === '/') url.pathname = '/api/v1';
    return url.toString().replace(/\/+$/, '');
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// 内置静态文件服务器：托管 web-dist，仅监听回环地址
// ---------------------------------------------------------------------------

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

function listen(port: number): Promise<net.AddressInfo | null> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(null));
    server.listen(port, '127.0.0.1', () => {
      const address = server.address() as net.AddressInfo;
      server.close(() => resolve(address));
    });
  });
}

function startStaticServer(rootDir: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      try {
        const requestPath = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname);
        let filePath = path.join(rootDir, requestPath);
        // SPA 回退：非资源路径（无扩展名）一律返回 index.html
        if (!path.extname(filePath) || !fs.existsSync(filePath)) {
          filePath = path.join(rootDir, 'index.html');
        }
        // 防目录穿越：解析后必须仍在 rootDir 之下
        if (!path.resolve(filePath).startsWith(path.resolve(rootDir) + path.sep)) {
          res.writeHead(403);
          res.end('Forbidden');
          return;
        }
        const body = fs.readFileSync(filePath);
        res.writeHead(200, {
          'Content-Type': MIME_TYPES[path.extname(filePath)] ?? 'application/octet-stream',
          'Cache-Control': path.extname(filePath) === '.html' ? 'no-cache' : 'public, max-age=86400',
        });
        res.end(body);
      } catch {
        res.writeHead(404);
        res.end('Not Found');
      }
    });

    server.on('error', (err) => reject(err));
    // 优先固定端口（保持源稳定），被占用时回退到随机端口
    listen(PREFERRED_PORT).then((fixed) => {
      if (fixed !== null) {
        server.listen(fixed.port, '127.0.0.1', () => resolve(fixed.port));
      } else {
        server.listen(0, '127.0.0.1', () => {
          resolve((server.address() as net.AddressInfo).port);
        });
      }
    });
  });
}

// ---------------------------------------------------------------------------
// 窗口管理
// ---------------------------------------------------------------------------

let mainWindow: BrowserWindow | null = null;
let settingsWindow: BrowserWindow | null = null;

function createMainWindow(loadUrl: string): void {
  mainWindow = new BrowserWindow({
    width: WINDOW_WIDTH,
    height: WINDOW_HEIGHT,
    minWidth: 1200,
    minHeight: 760,
    show: !IS_SMOKE,
    backgroundColor: '#020617',
    title: '乐天质量管理系统',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // 与界面深色底色一致，避免白屏闪烁
  mainWindow.once('ready-to-show', () => {
    if (!IS_SMOKE) mainWindow?.show();
  });

  // 外部链接交给系统浏览器，不在客户端内新开窗口
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://') || url.startsWith('https://')) {
      void shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  void mainWindow.loadURL(loadUrl);
}

function createErrorWindow(html: string): void {
  createMainWindow(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
}

function showMissingDistError(): void {
  createErrorWindow(`<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>乐天QMS 桌面客户端</title></head>
<body style="margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#020617;color:#e2e8f0;font-family:system-ui,sans-serif;">
  <div style="max-width:520px;padding:32px;border:1px solid #334155;border-radius:12px;background:#0f172a;">
    <h1 style="font-size:18px;margin:0 0 12px;color:#f8fafc;">前端产物缺失</h1>
    <p style="font-size:13px;line-height:1.8;color:#94a3b8;margin:0;">
      未找到 web-dist 目录。请先在仓库根目录执行：<br>
      <code style="color:#7dd3fc;">pnpm desktop:build</code>（连接真实后端）<br>
      <code style="color:#7dd3fc;">pnpm desktop:demo</code>（内置离线演示数据）<br>
      构建完成后重新启动客户端。
    </p>
  </div>
</body></html>`);
}

function openSettingsWindow(): void {
  if (settingsWindow !== null) {
    settingsWindow.focus();
    return;
  }
  settingsWindow = new BrowserWindow({
    width: 520,
    height: 340,
    resizable: false,
    maximizable: false,
    minimizable: false,
    parent: mainWindow ?? undefined,
    modal: mainWindow !== null,
    show: false,
    backgroundColor: '#020617',
    title: '服务器设置',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  settingsWindow.once('ready-to-show', () => settingsWindow?.show());
  settingsWindow.on('closed', () => {
    settingsWindow = null;
  });
  void settingsWindow.loadFile(SETTINGS_PAGE);
}

// ---------------------------------------------------------------------------
// 菜单
// ---------------------------------------------------------------------------

function buildMenu(): Menu {
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: '文件',
      submenu: [
        { label: '退出', accelerator: 'CmdOrCtrl+Q', role: 'quit' },
        { type: 'separator' },
        { label: '关闭窗口', accelerator: 'CmdOrCtrl+W', role: 'close' },
      ],
    },
    {
      label: '视图',
      submenu: [
        { label: '重新加载', accelerator: 'CmdOrCtrl+R', role: 'reload' },
        { label: '强制重新加载', accelerator: 'CmdOrCtrl+Shift+R', role: 'forceReload' },
        { label: '开发者工具', accelerator: 'F12', role: 'toggleDevTools' },
        { type: 'separator' },
        { label: '放大', accelerator: 'CmdOrCtrl+=', role: 'zoomIn' },
        { label: '缩小', accelerator: 'CmdOrCtrl+-', role: 'zoomOut' },
        { label: '重置缩放', accelerator: 'CmdOrCtrl+0', role: 'resetZoom' },
        { label: '全屏', accelerator: 'F11', role: 'togglefullscreen' },
      ],
    },
    {
      label: '设置',
      submenu: [
        {
          label: '服务器设置...',
          accelerator: 'CmdOrCtrl+,',
          click: () => openSettingsWindow(),
        },
      ],
    },
    {
      label: '帮助',
      submenu: [
        {
          label: '关于 乐天QMS工作台',
          click: () => {
            void dialog.showMessageBox({
              type: 'info',
              title: '关于',
              message: `乐天QMS工作台 v${app.getVersion()}`,
              detail: [
                `Electron ${process.versions.electron}`,
                `Chromium ${process.versions.chrome}`,
                `Node ${process.versions.node}`,
                `当前服务器地址：${normalizeServerUrl(readConfig().serverUrl) ?? '未配置（使用构建期默认地址）'}`,
              ].join('\n'),
            });
          },
        },
      ],
    },
  ];
  return Menu.buildFromTemplate(template);
}

// ---------------------------------------------------------------------------
// IPC：preload 桥
// ---------------------------------------------------------------------------

function registerIpcHandlers(): void {
  // 同步接口：渲染进程模块加载前就要拿到服务器地址（apps/web resolveApiBase）
  ipcMain.on('config:get-server-url', (event) => {
    const normalized = normalizeServerUrl(readConfig().serverUrl);
    event.returnValue = normalized ?? '';
  });

  ipcMain.handle('config:get', () => {
    const config = readConfig();
    return { serverUrl: config.serverUrl, normalized: normalizeServerUrl(config.serverUrl) ?? '' };
  });

  ipcMain.handle('config:set', (_event, rawUrl: unknown) => {
    const text = typeof rawUrl === 'string' ? rawUrl.trim() : '';
    // 允许留空（清空后回退到构建期 VITE_API_BASE）；非空则必须是合法的 http(s) 地址
    if (text !== '') {
      const normalized = normalizeServerUrl(text);
      if (normalized === null) {
        return { ok: false as const, error: '地址无效：请输入 http:// 或 https:// 开头的完整地址' };
      }
      writeConfig({ serverUrl: normalized });
    } else {
      writeConfig({ serverUrl: '' });
    }
    // 重新加载主窗口使新地址生效（resolveApiBase 在页面加载时求值）
    if (mainWindow !== null && !mainWindow.isDestroyed()) {
      mainWindow.webContents.reload();
    }
    return { ok: true as const };
  });

  ipcMain.handle('config:test', async (_event, rawUrl: unknown) => {
    const normalized = normalizeServerUrl(typeof rawUrl === 'string' ? rawUrl : '');
    if (normalized === null) {
      return { ok: false as const, message: '地址无效：请输入 http:// 或 https:// 开头的完整地址' };
    }
    // 用 API 基址推导后端根（Fastify /health 健康检查，免鉴权）
    const root = normalized.replace(/\/api\/v1$/, '');
    const startedAt = Date.now();
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 4000);
      const res = await fetch(`${root}/health`, { signal: controller.signal });
      clearTimeout(timer);
      const latency = Date.now() - startedAt;
      if (res.ok) {
        return { ok: true as const, message: `连接成功（${latency}ms）` };
      }
      return { ok: false as const, message: `服务器已响应，但健康检查返回 HTTP ${res.status}` };
    } catch (err) {
      return { ok: false as const, message: `无法连接：${err instanceof Error ? err.message : String(err)}` };
    }
  });

  ipcMain.handle('app:get-info', () => ({
    version: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    platform: process.platform,
    configPath: configPath(),
  }));

  ipcMain.on('app:open-settings', () => openSettingsWindow());
}

// ---------------------------------------------------------------------------
// 冒烟测试（--smoke）：加载 → 等待数据渲染 → 截图 → 退出
// ---------------------------------------------------------------------------

function runSmokeTest(loadUrl: string): void {
  const timeout = setTimeout(() => {
    console.error('SMOKE_FAIL: 30s 内未能完成页面加载');
    app.exit(1);
  }, 30_000);

  const win = new BrowserWindow({
    width: WINDOW_WIDTH,
    height: WINDOW_HEIGHT,
    show: true,
    backgroundColor: '#020617',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.webContents.on('console-message', (_event, level, message) => {
    if (level >= 2) console.log(`[renderer] ${message}`);
  });
  win.webContents.on('did-fail-load', (_event, code, desc, url) => {
    clearTimeout(timeout);
    console.error(`SMOKE_FAIL: 页面加载失败 code=${code} desc=${desc} url=${url}`);
    app.exit(1);
  });

  win.webContents.once('did-finish-load', () => {
    // 等待首屏数据请求与 ECharts 渲染完成
    setTimeout(async () => {
      try {
        const image = await win.webContents.capturePage();
        const outDir = smokeOutputDir();
        fs.mkdirSync(outDir, { recursive: true });
        const target = path.join(outDir, 'screenshot.png');
        fs.writeFileSync(target, image.toPNG());
        console.log(`SMOKE_OK: ${target}`);
      } catch (err) {
        console.error(`SMOKE_FAIL: 截图失败 ${err instanceof Error ? err.message : String(err)}`);
        app.exit(1);
        return;
      }
      clearTimeout(timeout);
      app.exit(0);
    }, 5000);
  });

  void win.loadURL(loadUrl);
}

/**
 * 冒烟扩展：打开「服务器设置」窗口并截图（--smoke-settings）。
 * 验证设置页静态资源（外部 JS 受 CSP 'self' 约束）与 preload IPC 桥接链路。
 */
function runSettingsSmokeTest(): void {
  const timeout = setTimeout(() => {
    console.error('SMOKE_FAIL: 设置窗口 15s 内未能完成加载');
    app.exit(1);
  }, 15_000);

  openSettingsWindow();

  setTimeout(async () => {
    try {
      if (settingsWindow === null) throw new Error('设置窗口未创建');
      const image = await settingsWindow.webContents.capturePage();
      const outDir = smokeOutputDir();
      fs.mkdirSync(outDir, { recursive: true });
      const target = path.join(outDir, 'settings.png');
      fs.writeFileSync(target, image.toPNG());
      console.log(`SMOKE_OK: ${target}`);
    } catch (err) {
      console.error(`SMOKE_FAIL: 设置窗口截图失败 ${err instanceof Error ? err.message : String(err)}`);
      app.exit(1);
      return;
    }
    clearTimeout(timeout);
    app.exit(0);
  }, 4000);
}

// ---------------------------------------------------------------------------
// 应用生命周期
// ---------------------------------------------------------------------------

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow !== null) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  void app.whenReady().then(async () => {
    registerIpcHandlers();
    Menu.setApplicationMenu(buildMenu());

    // 开发模式直连 Vite 开发服务器（/api 由 Vite 代理到后端，无需静态产物）
    if (IS_DEV) {
      createMainWindow(VITE_DEV_URL);
      return;
    }

    // 设置窗口冒烟：只依赖 out/settings 静态页与 preload 桥，不需要 web-dist
    if (IS_SMOKE_SETTINGS) {
      runSettingsSmokeTest();
      return;
    }

    if (!fs.existsSync(path.join(WEB_DIST_DIR, 'index.html'))) {
      showMissingDistError();
      return;
    }

    try {
      const port = await startStaticServer(WEB_DIST_DIR);
      const url = `http://127.0.0.1:${port}/`;
      if (IS_SMOKE) {
        runSmokeTest(url);
      } else {
        createMainWindow(url);
      }
    } catch (err) {
      createErrorWindow(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"></head>
<body style="margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#020617;color:#e2e8f0;font-family:system-ui;">
<p>内置静态服务启动失败：${err instanceof Error ? err.message : String(err)}</p></body></html>`);
    }
  });

  app.on('window-all-closed', () => {
    app.quit();
  });
}
