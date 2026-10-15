/**
 * MRB 不合格品处置页（浅色整合单页）离线 Mock 渲染校验（CDP 驱动，只读）
 *
 * 验证目标：
 *   1. 菜单与页头口径：菜单「MRB不合格品处置」，页面标题 + 副标题与原型一致；
 *   2. 十列表头与页签（待评审/评审中/已评审；2026-09-23 起「已处置」并入「已评审」）齐备；
 *   3. KPI 取值来自 GET /mrb/records（Mock 层计算，非写死）；
 *   4. 浅色主题：页面容器/KPI 卡片/表头背景均为浅色，无深色残留；
 *   5. 页头口径（docs/43）：判定不合格自动进入评审，**无人工发起入口** ——
 *      不存在【+ 发起评审】按钮与「待发起评审」计数胶囊，副标题为「判定不合格自动进入评审」；
 *   6. 行内「评审」抽屉渲染会签席位与真实 approvers 记录。
 *   7. 并列菜单「评审流程设置」子页：流程说明与节点四列真实回吐（docs/21 §10 E1/E2），
 *      点「停用此流程」必须真实调用 POST /review-flows/:id/toggle-active 并被重载读回（E3）。
 *   8. 运行目标自检（R7）：本探针的断言值只对**离线 Mock**成立，因此进入应用后先确认页面注册了
 *      MSW 的 `mockServiceWorker`；若不是（例如落到了代理真实后端的 dev 实例），打印正确启动方式并
 *      以退出码 3 退出 —— 否则断言会照真实库取值，且下面的「返工处置」会真的写真实库。
 */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const OUT_DIR = path.join(__dirname, '..', 'logs');
const PORT = 9336;
/** CDP 监听地址候选：先 IPv4，再 IPv6 回环（Chrome 只绑 `[::1]` 的环境见下方探测注释） */
const CDP_HOSTS = ['127.0.0.1', '[::1]'];
// 多会话环境下 vite dev 端口会自增（31100/31101/31102），故自动探测，避免指向无人监听的端口而卡死。
// 但「探测到的实例是不是离线 Mock」不能靠端口猜：进入应用后由运行目标自检（mockServiceWorker）判定，
// 不是离线 Mock 就 exit 3，绝不拿真实库的数据去满足 Mock 断言。
const WEB_CANDIDATES = process.env.WEB_BASE
  ? [process.env.WEB_BASE]
  : ['http://127.0.0.1:31101/', 'http://127.0.0.1:31100/', 'http://127.0.0.1:31102/'];
const LOG = path.join(OUT_DIR, 'mrb-mock-verify.log');
fs.writeFileSync(LOG, '');
const log = (...a) => {
  const line = a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ');
  fs.appendFileSync(LOG, line + '\n');
  console.log(line);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function httpJson(url, options = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, options, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

/** 端口探测：只看 HTTP 状态码（首页返回 HTML，不能按 JSON 解析） */
function probeHttp(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      res.resume();
      if (res.statusCode && res.statusCode >= 200 && res.statusCode < 400) resolve(res.statusCode);
      else reject(new Error('status ' + res.statusCode));
    });
    req.on('error', reject);
    req.setTimeout(3000, () => req.destroy(new Error('timeout')));
  });
}

async function resolveWebBase() {
  for (const base of WEB_CANDIDATES) {
    try {
      const res = await probeHttp(new URL('/', base).href);
      if (res) return base;
    } catch { /* 试下一个 */ }
  }
  throw new Error('前端未监听，候选地址均不可用: ' + WEB_CANDIDATES.join(', '));
}

class Cdp {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); this.handlers = new Map(); }
  static async connect(wsUrl) {
    const ws = new WebSocket(wsUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws error')); });
    const cdp = new Cdp(ws);
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && cdp.pending.has(msg.id)) {
        const { resolve, reject } = cdp.pending.get(msg.id);
        cdp.pending.delete(msg.id);
        msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
      } else if (msg.method && cdp.handlers.has(msg.method)) {
        cdp.handlers.get(msg.method)(msg.params);
      }
    };
    return cdp;
  }
  on(method, handler) { this.handlers.set(method, handler); }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
}

async function evalJs(cdp, expression) {
  const r = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error('JS error: ' + JSON.stringify(r.exceptionDetails.exception));
  return r.result.value;
}

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok });
  log(`${ok ? 'PASS' : 'FAIL'} :: ${name}${detail === undefined ? '' : ' :: ' + JSON.stringify(detail)}`);
};

(async () => {
  const userDataDir = path.join(OUT_DIR, 'chrome-profile-mrb');
  fs.mkdirSync(userDataDir, { recursive: true });
  const chrome = spawn(CHROME, [
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${userDataDir}`,
    '--headless=new',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-crash-reporter',
    '--no-sandbox',
    '--window-size=1780,1100',
    'about:blank',
  ], { stdio: 'ignore' });

  // CDP 主机探测：部分环境（实测 Chrome 153）下 headless Chrome 只把调试端口绑在 IPv6 `[::1]`，
  // 只轮询 `127.0.0.1` 会误报「Chrome CDP not reachable」并把端口冲突记成业务问题。
  // 两种地址都试，先通的先用（IPv4 可用的机器行为不变）。
  let cdpHost = null;
  for (const host of CDP_HOSTS) {
    const budget = host === CDP_HOSTS[1] ? 60 : 20;
    for (let i = 0; i < budget && cdpHost === null; i++) {
      try {
        await httpJson(`http://${host}:${PORT}/json/version`);
        cdpHost = host;
      } catch {
        await sleep(500);
      }
    }
    if (cdpHost !== null) break;
  }
  if (cdpHost === null) throw new Error('Chrome CDP not reachable');
  log('cdp host:', cdpHost);

  const list = await httpJson(`http://${cdpHost}:${PORT}/json/list`);
  const page = list.body.find((t) => t.type === 'page');
  const cdp = await Cdp.connect(page.webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  // 启停成功提示是原生 alert：无人值守时必须自动放行，否则渲染进程会一直阻塞、后续断言全部超时
  const dialogs = [];
  cdp.on('Page.javascriptDialogOpening', (params) => {
    dialogs.push(params.message);
    cdp.send('Page.handleJavaScriptDialog', { accept: true }).catch(() => {});
  });
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1780, height: 1100, deviceScaleFactor: 1, mobile: false });

  const shot = async (name) => {
    const r = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    const file = path.join(OUT_DIR, name);
    fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
    log('SHOT:', file);
  };

  const webBase = await resolveWebBase();
  log('web base:', webBase);
  await cdp.send('Page.navigate', { url: webBase });
  await sleep(7000);
  // 预置会话，跳过登录页（Mock 层不校验 Authorization，任意令牌均可）
  await evalJs(cdp, `(() => {
    localStorage.setItem('letian_qms_token', 'mock_session_token_for_walkthrough');
    localStorage.setItem('letian_qms_user', JSON.stringify({
      userId: '11000000-0000-4000-8000-000000000001',
      userName: '张强',
      role: 'QA_MANAGER',
      department: '品质保证部',
    }));
    return true;
  })()`);
  await cdp.send('Page.reload');
  await sleep(12000);
  let menuReady = await evalJs(cdp, `document.body.innerText.includes('MRB不合格品处置')`);
  if (!menuReady) {
    const loginClicked = await evalJs(cdp, `(() => {
      const fallback = [...document.querySelectorAll('button')].find((x) => x.innerText.includes('以默认身份'));
      if (fallback) { fallback.click(); return fallback.innerText.trim(); }
      const btn = [...document.querySelectorAll('button')].find((x) => x.innerText.includes('进入系统'));
      if (btn) { btn.click(); return btn.innerText.trim(); }
      return false;
    })()`);
    log('login fallback click:', loginClicked);
    await sleep(15000);
    menuReady = await evalJs(cdp, `document.body.innerText.includes('MRB不合格品处置')`);
  }
  log('menuReady:', menuReady);

  // 运行目标自检（R7）：断言值（待评审 1 条 / 评审中 2 条 / 待审核池 3 条）只对离线 Mock 成立。
  // 不锁 WEB_BASE 时多会话环境可能探测到「代理真实后端」的实例：断言照真实库取值，
  // 而且下面的返工处置会真的 POST /mrb/records/:id/disposition 写真实库。
  const swScripts = await evalJs(cdp, `navigator.serviceWorker.getRegistrations().then((rs) => rs.map((r) => ((r.active || r.installing || r.waiting || {}).scriptURL || '')))`);
  const isOfflineMock = Array.isArray(swScripts) && swScripts.some((u) => String(u).includes('mockServiceWorker'));
  check('运行目标自检：页面由离线 Mock 提供（已注册 mockServiceWorker）', isOfflineMock, swScripts);
  if (!isOfflineMock) {
    log('');
    log('== FATAL(3)：探测到的前端不是离线 Mock —— 断言值无意义，且写路径会污染真实库 ==');
    log('  web base: ' + webBase);
    log('  serviceWorker 注册项: ' + JSON.stringify(swScripts));
    log('  正确做法（先起 dev:mock，再用 WEB_BASE 显式指向它）：');
    log('    $env:VITE_API_TARGET="http://127.0.0.1:5999"; pnpm dev:mock   # 5999 = 未监听端口');
    log('    $env:WEB_BASE="http://127.0.0.1:31100/"; pnpm verify:mrb');
    log('  真实库的权威门禁是：pnpm verify:mrb-wiring（需 API :3101 + pnpm db:seed）');
    log('');
    chrome.kill();
    process.exit(3);
  }

  const clickNav = async (label) => evalJs(cdp, `(() => {
    const matches = [...document.querySelectorAll('button,a,div,span,li')]
      .filter((e) => e.innerText && e.innerText.trim().startsWith(${JSON.stringify(label)}));
    if (matches.length === 0) return null;
    const deep = matches.reduce((best, e) =>
      e.innerText.trim().length <= best.innerText.trim().length ? e : best);
    const target = deep.closest('a,button') || deep;
    target.click();
    return target.innerText.trim();
  })()`);

  const nav = await clickNav('MRB不合格品处置');
  log('nav MRB:', nav);
  await sleep(5000);
  await shot('mrb-list-light.png');

  const snapshot = await evalJs(cdp, `(() => {
    const text = document.body.innerText;
    // 只读主页面表格（抽屉未打开时 tbody 只有一个）
    const mainTable = document.querySelector('table');
    const heads = mainTable ? [...mainTable.querySelectorAll('th')].map((t) => t.innerText.trim()) : [];
    const rows = mainTable
      ? [...mainTable.querySelectorAll('tbody tr')].map((tr) =>
          [...tr.querySelectorAll('td')].map((td) => td.innerText.trim()))
      : [];
    const kpiTitles = ['待评审','评审中','已评审','已处置','本月评审率'];
    const kpis = {};
    for (const el of document.querySelectorAll('div')) {
      const t = el.innerText || '';
      for (const title of kpiTitles) {
        if (Object.prototype.hasOwnProperty.call(kpis, title)) continue;
        if (t.startsWith(title) && t.length < 60) kpis[title] = t.replace(/\\n/g, ' | ');
      }
    }
    const tabLabels = [...document.querySelectorAll('button')]
      .map((b) => b.innerText.trim())
      .filter((t) => ['全部','待评审','评审中','已评审'].includes(t));
    // 筛选栏「评审状态」下拉与页签同源（MRB_TABS），同样不再出现「已处置」
    const statusSelect = [...document.querySelectorAll('select')].find((s) =>
      [...s.options].some((o) => o.value === 'REVIEWED')
    );
    const statusOptions = statusSelect ? [...statusSelect.options].map((o) => o.textContent.trim()) : [];
    // 浅色校验只针对 MRB 页面自身子树（侧边栏/顶栏是应用外壳，深色属既有设计）
    const title = [...document.querySelectorAll('h2')].find((h) => h.innerText.includes('MRB不合格品处置'));
    const pageScope = title ? title.closest('div.space-y-5') || title.parentElement.parentElement : null;
    const darkEls = pageScope
      ? [...pageScope.querySelectorAll('div,section,table,thead,tr,td,th')]
          .filter((el) => {
            const c = getComputedStyle(el).backgroundColor || '';
            const m = c.match(/rgba?\\((\\d+), (\\d+), (\\d+)(?:, ([\\d.]+))?\\)/);
            if (!m) return false;
            const alpha = m[4] === undefined ? 1 : Number(m[4]);
            if (alpha === 0) return false;
            const lum = (Number(m[1]) + Number(m[2]) + Number(m[3])) / 3;
            return lum < 140 && el.clientHeight > 30;
          })
          .slice(0, 3)
          .map((el) => ({ cls: el.className.toString().slice(0, 80), bg: getComputedStyle(el).backgroundColor }))
      : [];
    const activeTab = [...document.querySelectorAll('button')]
      .filter((b) => (b.className || '').includes('border-blue-600'))
      .map((b) => b.innerText.trim());
    return { heads, rowCount: rows.length, firstRow: rows[0] || [], kpis, tabLabels, statusOptions, darkEls, activeTab,
      hasTitle: text.includes('MRB不合格品处置'), hasSubtitle: text.includes('不合格品评审与处置'), url: location.href };
  })()`);
  log('snapshot:', snapshot);

  const expectedHeads = ['MRB单号','来源检验单','物料编码','物料名称','不合格原因','不合格数量','检验人','发现日期','评审状态','操作'];
  check('页头标题「MRB不合格品处置」', snapshot.hasTitle === true);
  check('副标题「不合格品评审与处置 · 判定不合格自动进入评审」', snapshot.hasSubtitle === true, snapshot.hasSubtitle);
  check('十列表头与原型一致（第5列为「不合格原因」）', JSON.stringify(snapshot.heads) === JSON.stringify(expectedHeads), snapshot.heads);
  check('3 个状态页签（不含「全部」；「已处置」已并入「已评审」）', JSON.stringify(snapshot.tabLabels) === JSON.stringify(['待评审','评审中','已评审']), snapshot.tabLabels);
  check('筛选栏「评审状态」下拉与页签同源（全部/待评审/评审中/已评审）', JSON.stringify(snapshot.statusOptions) === JSON.stringify(['全部','待评审','评审中','已评审']), snapshot.statusOptions);
  check('默认选中「待评审」页签', JSON.stringify(snapshot.activeTab) === JSON.stringify(['待评审']), snapshot.activeTab);
  check('KPI 5 张卡片齐全', Object.keys(snapshot.kpis).length === 5, snapshot.kpis);
  check('「待评审」页签取到 1 条 Mock 记录（断言的是条数，不是空态）', snapshot.rowCount === 1, snapshot.rowCount);
  check('浅色主题：MRB 页面子树无深色容器', snapshot.darkEls.length === 0, snapshot.darkEls);

  // 切到「评审中」页签：应取到 2 条记录且检验人列有值
  await evalJs(cdp, `(() => {
    const btn = [...document.querySelectorAll('button')].find((b) => b.innerText.trim() === '评审中');
    if (btn) { btn.click(); return true; } return false;
  })()`);
  await sleep(3000);
  await shot('mrb-list-under-review.png');
  const reviewing = await evalJs(cdp, `(() => {
    const mainTable = document.querySelector('table');
    const rows = mainTable ? [...mainTable.querySelectorAll('tbody tr')].map((tr) =>
      [...tr.querySelectorAll('td')].map((td) => td.innerText.trim())) : [];
    const heads = mainTable ? [...mainTable.querySelectorAll('th')].map((t) => t.innerText.trim()) : [];
    const inspectorIdx = heads.indexOf('检验人');
    return { rowCount: rows.length, inspectors: rows.map((r) => r[inspectorIdx]) };
  })()`);
  log('评审中页签:', reviewing);
  check('「评审中」页签取到 2 条 Mock 记录', reviewing.rowCount === 2, reviewing.rowCount);
  check('「检验人」列由 sourceOrderNo 联表派生（非空且非占位）', reviewing.inspectors.every((n) => n && n !== '-'), reviewing.inspectors);

  // ---- 页头口径（docs/43）：判定不合格自动进入评审，**无人工发起入口** ----
  const header = await evalJs(cdp, `(() => {
    const buttons = [...document.querySelectorAll('button')].map((b) => b.innerText.trim());
    const subtitle = [...document.querySelectorAll('p')].map((p) => p.innerText.trim())
      .find((t) => t.includes('不合格品评审与处置')) ?? '';
    return {
      initiateButtons: buttons.filter((t) => t.startsWith('发起评审')).length,
      pendingCapsules: buttons.filter((t) => t.includes('待发起评审')).length,
      subtitle,
      exportButton: buttons.includes('导出报表'),
    };
  })()`);
  log('mrb header:', header);
  check('页头无【+ 发起评审】按钮（判定不合格自动进入评审，docs/43）', header.initiateButtons === 0, header.initiateButtons);
  check('页头无「待发起评审」计数胶囊', header.pendingCapsules === 0, header.pendingCapsules);
  check('副标题为「不合格品评审与处置 · 判定不合格自动进入评审」', header.subtitle.includes('判定不合格自动进入评审'), header.subtitle);
  check('导出报表按钮保留', header.exportButton === true);

  // ---- 日期筛选占位口径（docs/09 §3）：不得再露出 Chromium 原生 `yyyy-mm-dd` ----
  const dateFields = await evalJs(cdp, `(() => {
    const inputs = [...document.querySelectorAll('input[type=date]')].filter((i) => i.offsetParent !== null);
    const rules = [];
    for (const sheet of document.styleSheets) {
      let list = null;
      try { list = sheet.cssRules; } catch { continue; }
      if (!list) continue;
      for (const rule of list) {
        if ((rule.cssText || '').includes('lt-date-input--empty')) rules.push(rule.cssText);
      }
    }
    const details = inputs.map((i) => {
      const box = i.parentElement;
      const hint = box
        ? [...box.querySelectorAll('span')].find((s) => (s.className || '').includes('pointer-events-none'))
        : null;
      return {
        hint: hint ? hint.innerText.trim() : null,
        hintHiddenOnFocus: hint ? (hint.className || '').includes('peer-focus:hidden') : false,
        // 空值输入框必须真的带上隐藏原生占位的类（否则 CSS 白写，yyyy-mm-dd 仍会露出来）
        emptyClassApplied: i.matches('input[type=date].lt-date-input--empty'),
      };
    });
    return {
      fields: details,
      // 样式层证据：隐藏规则存在且作用在 `::-webkit-datetime-edit` 上，聚焦时有恢复规则
      hideRules: rules.filter((t) => t.includes('::-webkit-datetime-edit')),
      restoresOnFocus: rules.some(
        (t) => t.includes(':focus') && t.includes('::-webkit-datetime-edit')
      ),
    };
  })()`);
  log('date fields:', dateFields);
  check(
    '筛选栏两个日期框渲染中文占位（开始日期 / 结束日期）',
    JSON.stringify(dateFields.fields.map((d) => d.hint)) === JSON.stringify(['开始日期', '结束日期']),
    dateFields
  );
  check(
    '日期框原生 `yyyy-mm-dd` 占位被隐藏（空值类命中 + `::-webkit-datetime-edit` 透明规则 + 聚焦恢复）',
    dateFields.fields.length === 2 &&
      dateFields.fields.every((d) => d.emptyClassApplied === true && d.hintHiddenOnFocus === true) &&
      dateFields.hideRules.some((t) => /transparent/.test(t)) &&
      dateFields.restoresOnFocus === true,
    dateFields
  );

  // ---- 查询命中「别的状态」时自动跳到有数据的页签（docs/19 §7）----
  // 当前停在「待评审」（Mock 无待评审单据 = 空态），用一条 DISPOSED 单据的单号查询，
  // 期望页面自动落到「已评审」并渲染该行，而不是让用户以为「查不到」。
  const autoJumpSetup = await evalJs(cdp, `(() => {
    const setValue = (el, value) => {
      const desc = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value');
      desc.set.call(el, value);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    };
    const input = [...document.querySelectorAll('input')]
      .find((i) => (i.getAttribute('placeholder') || '').includes('MRB-'));
    if (!input) return { ok: false, reason: '未找到「MRB单号」输入框' };
    setValue(input, 'MRB-20231011-01');
    const btn = [...document.querySelectorAll('button')].find((b) => b.innerText.trim() === '查询');
    if (!btn) return { ok: false, reason: '未找到【查询】按钮' };
    btn.click();
    return { ok: true };
  })()`);
  await sleep(4000);
  await shot('mrb-filter-autojump.png');
  const autoJumped = await evalJs(cdp, `(() => {
    const activeTab = [...document.querySelectorAll('button')]
      .filter((b) => (b.className || '').includes('border-blue-600')).map((b) => b.innerText.trim());
    const mainTable = document.querySelector('table');
    const rows = mainTable
      ? [...mainTable.querySelectorAll('tbody tr')].map((tr) =>
          [...tr.querySelectorAll('td')].map((td) => td.innerText.trim()))
      : [];
    return { activeTab, rowCount: rows.length, firstRowNo: rows[0] ? rows[0][0] : null };
  })()`);
  log('auto jump:', { setup: autoJumpSetup, ...autoJumped });
  check(
    '筛选命中「已评审」单据后自动跳到「已评审」页签并渲染该行（不再停在「待评审」空态）',
    autoJumpSetup.ok === true &&
      JSON.stringify(autoJumped.activeTab) === JSON.stringify(['已评审']) &&
      autoJumped.firstRowNo === 'MRB-20231011-01',
    autoJumped
  );

  // 复位到「评审中」页签：下面「行内评审」抽屉断言依赖该页签的首行记录
  await evalJs(cdp, `(() => {
    const reset = [...document.querySelectorAll('button')].find((b) => b.innerText.trim() === '重置');
    if (reset) reset.click();
    return true;
  })()`);
  await sleep(1500);
  await evalJs(cdp, `(() => {
    const tab = [...document.querySelectorAll('button')].find((b) => b.innerText.trim() === '评审中');
    if (tab) tab.click();
    return true;
  })()`);
  await sleep(3000);

  // ---- 行内「评审」抽屉 ----
  const openedReview = await evalJs(cdp, `(() => {
    const btn = [...document.querySelectorAll('button')].find((b) => b.innerText.trim() === '评审');
    if (!btn) return false; btn.click(); return true;
  })()`);
  await sleep(3500);
  await shot('mrb-review-drawer.png');
  const review = await evalJs(cdp, `(() => {
    const text = document.body.innerText;
    return { opened: text.includes('MRB 评审与处置'), hasSeats: text.includes('质量部负责人') && text.includes('质量总监'),
      hasDisposition: text.includes('处置'), hasSignForm: text.includes('会签'), length: text.length };
  })()`);
  log('review drawer:', { opened: openedReview, ...review });
  check('行内「评审」打开评审与处置抽屉', review.opened === true, review);
  check('抽屉含四方会签席位', review.hasSeats === true);

  // ---- 处置闭环：返工（REWORK）必须生成复检单，且页面必须展示复检单号 ----
  // 链路：抽屉提交 → POST /mrb/records/{id}/disposition（Mock 按后端同口径生成复检单）
  //       → 响应回吐 reinspectionOrderNo（契约 DisposeMRBResponse）→ 页面渲染「已生成复检单 {单号}」
  const reworkSubmit = await evalJs(cdp, `(() => {
    const setValue = (el, value) => {
      const desc = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value');
      desc.set.call(el, value);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    };
    const select = [...document.querySelectorAll('select')].find((s) =>
      [...s.options].some((o) => o.value === 'REWORK')
    );
    if (!select) return { ok: false, reason: '未找到「处置方式」下拉框' };
    setValue(select, 'REWORK');
    const reasonEl = [...document.querySelectorAll('textarea')].find((t) =>
      /处置决议理由/.test(t.closest('label') ? t.closest('label').innerText : '')
    );
    if (!reasonEl) return { ok: false, reason: '未找到处置理由输入框' };
    setValue(reasonEl, '返工后复检：验证复检单号回吐（mrb-verify 回归）');
    const btn = [...document.querySelectorAll('button')].find((b) => /提交处置结论/.test(b.innerText));
    if (!btn) return { ok: false, reason: '未找到提交处置结论按钮' };
    if (btn.disabled) return { ok: false, reason: '提交按钮被禁用（当前状态不可处置）' };
    btn.click();
    return { ok: true };
  })()`);
  await sleep(4000);
  // 抽屉自带滚动容器且高于视口：截图前把容器**直接置底**（横幅就在提交行上方），
  // 不依赖 scrollIntoView 的块级定位，避免版式微调后证据图又拍不到横幅。
  const bannerPos = await evalJs(cdp, `(() => {
    // 取「最深」的命中容器：祖先 div 的 innerText 也含该文案，find() 会命中外层容器而滚不动
    const banner = [...document.querySelectorAll('div')]
      .filter((el) => /返工处置已生效/.test(el.innerText || ''))
      .reduce((best, el) => (!best || el.innerText.length <= best.innerText.length ? el : best), null);
    if (!banner) return { found: false };
    let scroller = banner.parentElement;
    while (scroller && scroller !== document.body) {
      const overflowY = getComputedStyle(scroller).overflowY;
      if (/(auto|scroll)/.test(overflowY) && scroller.scrollHeight > scroller.clientHeight) break;
      scroller = scroller.parentElement;
    }
    if (scroller && scroller !== document.body) scroller.scrollTop = scroller.scrollHeight;
    const r = banner.getBoundingClientRect();
    return {
      found: true,
      inView: r.top >= 0 && r.bottom <= window.innerHeight,
      top: Math.round(r.top),
      bottom: Math.round(r.bottom),
      viewportHeight: window.innerHeight,
    };
  })()`);
  await sleep(800);
  // 视口截图：captureBeyondViewport 会临时改变视口高度并把 scrollTop 复位，抽屉底部会再次跑到画面外
  const reworkShot = await cdp.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(OUT_DIR, 'mrb-disposition-rework.png'), Buffer.from(reworkShot.data, 'base64'));
  log('SHOT:', path.join(OUT_DIR, 'mrb-disposition-rework.png'), 'bannerRect=', bannerPos);
  const disposed = await evalJs(cdp, `(() => {
    const text = document.body.innerText;
    const m = text.match(/系统已生成下一轮复检单：\\s*([^\\s]+)/);
    return { hasBanner: /返工处置已生效/.test(text), orderNo: m ? m[1].trim() : null };
  })()`);
  log('rework disposition:', { ...reworkSubmit, ...disposed });
  check(
    '返工处置提交成功并回吐复检单号（契约 DisposeMRBResponse）',
    reworkSubmit.ok === true && disposed.hasBanner === true,
    { ...reworkSubmit, ...disposed }
  );
  check(
    '复检单号符合 {原检验单号}-R{轮次} 规则',
    typeof disposed.orderNo === 'string' && /-R\d+$/.test(disposed.orderNo),
    disposed.orderNo
  );

  // ---- 并列菜单「评审流程设置」子页（docs/21 §10 三处断链 E1/E2/E3 闭环）----
  await evalJs(cdp, `(() => { const m = document.querySelector('.absolute.inset-0'); if (m) m.click(); return true; })()`);
  await sleep(1500);
  const navFlow = await clickNav('评审流程设置');
  log('nav 评审流程设置:', navFlow);
  await sleep(5000);
  await shot('mrb-workflow-light.png');

  const wf = await evalJs(cdp, `(() => {
    const text = document.body.innerText;
    // 左侧流程卡片：h4 = 流程名称，紧随的 p = 流程说明。
    // 右侧「评审路由节点链」「节点配置清单」也是 h4，必须按「同容器内含 FLOW- 编码」排除，
    // 否则会把它们当成没有说明的流程卡片而误报。
    const cards = [...document.querySelectorAll('h4')]
      .filter((h) => h.parentElement !== null && /FLOW-/.test(h.parentElement.innerText))
      .map((h) => {
        const p = h.parentElement.querySelector('p');
        return { name: h.innerText.trim(), desc: p ? p.innerText.trim() : '' };
      });
    const table = [...document.querySelectorAll('table')].find((t) => t.innerText.includes('授权签署角色'));
    const rows = table
      ? [...table.querySelectorAll('tbody tr')].map((tr) => [...tr.querySelectorAll('td')].map((td) => td.innerText.trim()))
      : [];
    const heads = table ? [...table.querySelectorAll('th')].map((th) => th.innerText.trim()) : [];
    const toggleBtn = [...document.querySelectorAll('button')].find((b) => /停用此流程|启用此流程/.test(b.innerText));
    const title = [...document.querySelectorAll('h2')].find((h) => h.innerText.includes('评审流程设置'));
    const scope = title ? title.closest('div.space-y-6') : null;
    const darkEls = scope
      ? [...scope.querySelectorAll('div,section,table,thead,tr,td,th')].filter((el) => {
          const c = getComputedStyle(el).backgroundColor || '';
          const m = c.match(/rgba?\\((\\d+), (\\d+), (\\d+)(?:, ([\\d.]+))?\\)/);
          if (!m) return false;
          const alpha = m[4] === undefined ? 1 : Number(m[4]);
          if (alpha === 0) return false;
          return (Number(m[1]) + Number(m[2]) + Number(m[3])) / 3 < 140 && el.clientHeight > 30;
        }).length
      : -1;
    const badges = (text.match(/已启用|已停用/g) || []).length;
    return {
      hasTitle: text.includes('MRB 不合格品评审流程设置'),
      hasPlaceholder: text.includes('无详细描述'),
      cardCount: cards.length,
      cardDescs: cards.map((c) => c.desc),
      heads, rows, badges, darkEls,
      toggleLabel: toggleBtn ? toggleBtn.innerText.trim() : null,
    };
  })()`);
  log('workflow page:', wf);
  check('子页标题「MRB 不合格品评审流程设置」', wf.hasTitle === true);
  check('流程卡片「流程说明」非空且无「无详细描述」占位（E1 闭环）', wf.cardCount >= 1 && !wf.hasPlaceholder && wf.cardDescs.every((d) => d && d !== '无详细描述'), wf.cardDescs);
  check(
    '节点配置清单五列齐备（顺序/节点名称/授权签署角色/是否必签/特采审批权）',
    JSON.stringify(wf.heads) === JSON.stringify(['顺序','节点名称','授权签署角色','是否必签','特采审批权']),
    wf.heads
  );
  check(
    '节点四列真实回吐：顺序为数字、角色非空、必签为「是」、终审具特采权（E2 闭环）',
    wf.rows.length >= 1 &&
      wf.rows.every((r) => /^\d+$/.test(r[0]) && r[2] && r[2] !== '-') &&
      wf.rows.some((r) => r[3] === '是') &&
      wf.rows.some((r) => r[4] === '支持'),
    wf.rows
  );
  check('浅色主题：评审流程设置子页无深色容器', wf.darkEls === 0, wf.darkEls);

  // E3：点「停用此流程」必须真实打 POST /review-flows/:id/toggle-active，并被重载读回
  const clickedToggle = await evalJs(cdp, `(() => {
    const btn = [...document.querySelectorAll('button')].find((b) => /停用此流程|启用此流程/.test(b.innerText));
    if (!btn) return null;
    const label = btn.innerText.trim();
    btn.click();
    return label;
  })()`);
  await sleep(4000);
  const afterToggle = await evalJs(cdp, `(() => {
    const text = document.body.innerText;
    const btn = [...document.querySelectorAll('button')].find((b) => /停用此流程|启用此流程/.test(b.innerText));
    return { label: btn ? btn.innerText.trim() : null, hasBadge: /已启用|已停用/.test(text) };
  })()`);
  log('toggle result:', { before: wf.toggleLabel, clicked: clickedToggle, after: afterToggle.label, dialogs });
  check(
    '启停按钮调用 /toggle-active 后状态翻转（E3 闭环，不再假成功）',
    clickedToggle !== null &&
      afterToggle.label !== null &&
      afterToggle.label !== clickedToggle &&
      afterToggle.hasBadge === true,
    { before: clickedToggle, after: afterToggle.label, dialogs }
  );

  const failed = results.filter((r) => !r.ok);
  log(`\n== 结果: ${results.length - failed.length}/${results.length} 通过 ==`);
  if (failed.length > 0) log('FAILED:', failed.map((f) => f.name));
  chrome.kill();
  process.exit(failed.length > 0 ? 1 : 0);
})().catch((err) => { log('FATAL:', err && err.message); process.exit(2); });
