/**
 * 「进度总览」投屏页 UI 验收（CDP 驱动，离线 Mock 兼容）。
 *
 * 前置：Web dev server 已启动（默认探测 5200/5201/5202，或 WEB_BASE 指定）。
 * 退出码：0 = 全部断言通过；1 = 页面断言失败；2 = 环境不可用。
 */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const CDP_PORT = Number(process.env.CDP_PORT || 9342);
const OUT_DIR = path.resolve(__dirname, '..', 'logs');
const SHOT_DIR = path.resolve(__dirname, '..', '..', 'docs', 'screenshots');
const LOG = path.join(OUT_DIR, 'progress-overview-verify.log');
fs.mkdirSync(OUT_DIR, { recursive: true });
fs.mkdirSync(SHOT_DIR, { recursive: true });
fs.writeFileSync(LOG, '');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const log = (...values) => {
  const line = values.map((value) => (typeof value === 'string' ? value : JSON.stringify(value))).join(' ');
  fs.appendFileSync(LOG, line + '\n');
  console.log(line);
};

function getJson(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (error) {
          reject(error);
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(3000, () => req.destroy(new Error('timeout')));
  });
}

function probe(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      res.resume();
      if (res.statusCode >= 200 && res.statusCode < 400) resolve(res.statusCode);
      else reject(new Error(`status ${res.statusCode}`));
    });
    req.on('error', reject);
    req.setTimeout(3000, () => req.destroy(new Error('timeout')));
  });
}

async function resolveWebBase() {
  const candidates = process.env.WEB_BASE
    ? [process.env.WEB_BASE]
    : ['http://127.0.0.1:5200/', 'http://127.0.0.1:5201/', 'http://127.0.0.1:5202/'];
  for (const candidate of candidates) {
    try {
      await probe(new URL('/', candidate).href);
      return candidate;
    } catch {
      // try next candidate
    }
  }
  throw new Error(`前端未监听：${candidates.join(', ')}`);
}

async function ensureChrome() {
  try {
    await getJson(`http://127.0.0.1:${CDP_PORT}/json/version`);
    return null;
  } catch {
    const profile = path.join(OUT_DIR, 'chrome-profile-progress-overview');
    fs.mkdirSync(profile, { recursive: true });
    const chrome = spawn(CHROME, [
      `--remote-debugging-port=${CDP_PORT}`,
      `--user-data-dir=${profile}`,
      '--headless=new',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--disable-crash-reporter',
      '--no-sandbox',
      '--window-size=1780,1100',
      'about:blank',
    ], { stdio: 'ignore' });

    for (let attempt = 0; attempt < 60; attempt += 1) {
      try {
        await getJson(`http://127.0.0.1:${CDP_PORT}/json/version`);
        return chrome;
      } catch {
        await sleep(500);
      }
    }
    chrome.kill();
    throw new Error(`无法启动 Chrome CDP ${CDP_PORT}`);
  }
}

class CdpClient {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.id = 0;
    this.pending = new Map();
  }

  async connect() {
    this.ws = new WebSocket(this.wsUrl);
    await new Promise((resolve, reject) => {
      this.ws.onopen = resolve;
      this.ws.onerror = reject;
    });
    this.ws.onmessage = (event) => {
      const message = JSON.parse(event.data);
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(JSON.stringify(message.error)));
      else pending.resolve(message.result);
    };
  }

  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  close() {
    this.ws?.close();
  }
}

async function main() {
  const webBase = await resolveWebBase();
  const spawnedChrome = await ensureChrome();
  const targets = await getJson(`http://127.0.0.1:${CDP_PORT}/json/list`);
  const target = targets.find((item) => item.type === 'page' && item.webSocketDebuggerUrl);
  if (!target) throw new Error('没有可连接的 Chrome 页面 target');

  const cdp = new CdpClient(target.webSocketDebuggerUrl);
  await cdp.connect();
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');

  const errors = [];
  cdp.ws.onmessage = (event) => {
    const message = JSON.parse(event.data);
    const pending = cdp.pending.get(message.id);
    if (pending) {
      cdp.pending.delete(message.id);
      if (message.error) pending.reject(new Error(JSON.stringify(message.error)));
      else pending.resolve(message.result);
      return;
    }
    if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails.text);
    if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') {
      errors.push((message.params.args || []).map((arg) => arg.value ?? arg.description ?? '').join(' '));
    }
  };

  const evaluate = async (expression) => {
    const result = await cdp.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || '页面执行失败');
    return result.result?.value;
  };

  const screenshot = async () => {
    const result = await cdp.send('Page.captureScreenshot', { format: 'png' });
    const file = path.join(SHOT_DIR, 'progress-overview.png');
    fs.writeFileSync(file, Buffer.from(result.data, 'base64'));
    return file;
  };

  const results = [];
  const check = (name, passed, detail) => {
    results.push({ name, passed });
    log(`${passed ? 'PASS' : 'FAIL'} :: ${name}${detail === undefined ? '' : ` :: ${JSON.stringify(detail)}`}`);
  };

  await cdp.send('Page.navigate', { url: webBase });
  await sleep(3500);
  await evaluate(`(() => {
    const button = [...document.querySelectorAll('button')].find((item) => item.innerText.trim().includes('进入系统'));
    if (button) button.click();
    return Boolean(button);
  })()`);
  await sleep(3500);

  const clickedNav = await evaluate(`(() => {
    const button = [...document.querySelectorAll('aside button')].find((item) => item.innerText.trim() === '进度总览');
    if (!button) return false;
    button.click();
    return true;
  })()`);
  await sleep(1800);

  const pageState = await evaluate(`(() => ({
    title: document.title,
    body: document.body.innerText,
    board: Boolean(document.querySelector('[data-testid="progress-overview-board"]')),
    canvases: document.querySelectorAll('canvas').length,
    mrb: Boolean(document.querySelector('[data-testid="mrb-carousel"]')),
    taskTitle: document.body.innerText.includes('待办检验任务'),
    menu: [...document.querySelectorAll('aside button')].some((item) => item.innerText.trim() === '进度总览'),
  }))()`);
  check('侧边菜单进入进度总览', clickedNav && pageState.menu && pageState.board, pageState);
  check('投屏看板关键区块与图表渲染', pageState.mrb && pageState.taskTitle && pageState.canvases >= 2, pageState);

  const carouselState = await evaluate(`(() => {
    const slide = document.querySelector('[data-testid="mrb-slide"]');
    const toggle = document.querySelector('[data-testid="mrb-carousel-toggle"]');
    const next = [...document.querySelectorAll('button')].find((item) => item.getAttribute('aria-label') === '下一条 MRB 问题');
    if (!slide || !toggle || !next) return null;
    const before = slide.innerText;
    toggle.click();
    const paused = toggle.getAttribute('aria-label') === '播放 MRB 轮播';
    next.click();
    return { before, after: slide.innerText, paused };
  })()`);
  check('MRB 轮播支持暂停与手动切换', carouselState !== null && carouselState.paused && carouselState.before !== carouselState.after, carouselState);

  const refreshed = await evaluate(`(() => {
    const button = document.querySelector('[data-testid="progress-refresh"]');
    const before = document.querySelector('[data-testid="mrb-slide"]')?.innerText ?? '';
    if (!button) return { clicked: false, before, after: '' };
    button.click();
    return { clicked: true, before, after: document.querySelector('[data-testid="mrb-slide"]')?.innerText ?? '' };
  })()`);
  await sleep(900);
  const refreshAfter = await evaluate(`document.querySelector('[data-testid="mrb-slide"]')?.innerText ?? ''`);
  check('手动刷新保留当前 MRB 内容', refreshed.clicked && refreshed.before !== '' && refreshAfter !== '', { ...refreshed, refreshAfter });

  const fullscreen = await evaluate(`(async () => {
    const button = document.querySelector('[data-testid="progress-fullscreen"]');
    if (!button) return { button: false };
    button.click();
    await new Promise((resolve) => setTimeout(resolve, 500));
    return {
      button: true,
      active: document.fullscreenElement !== null,
      compatibilityMessage: document.body.innerText.includes('全屏投屏失败') || document.body.innerText.includes('不支持全屏投屏'),
    };
  })()`);
  check('全屏投屏按钮可用或给出兼容提示', fullscreen.button && (fullscreen.active || fullscreen.compatibilityMessage), fullscreen);

  const shot = await screenshot();
  log(`[截图] ${shot}`);
  const fatalErrors = errors.filter((error) => !String(error).includes('favicon') && !String(error).includes('React DevTools'));
  const failed = results.filter((result) => !result.passed);
  log(`=== 汇总 === ${results.length - failed.length}/${results.length} 通过，控制台异常 ${fatalErrors.length} 条`);
  fatalErrors.forEach((error) => log(`  ✗ ${error}`));
  failed.forEach((result) => log(`  ✗ ${result.name}`));

  cdp.close();
  if (spawnedChrome) spawnedChrome.kill();
  process.exit(failed.length === 0 && fatalErrors.length === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('进度总览验收运行异常:', error && error.stack ? error.stack : error);
  process.exit(2);
});
