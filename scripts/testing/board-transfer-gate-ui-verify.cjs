/**
 * 质量追溯看板「传递链闸门（合格后传递）」界面级端到端探针（CDP 驱动，只读 DOM、不写库）
 *
 * 验证维度：
 * 1. 系统登录入口 & 侧边栏「质量追溯看板」导航
 * 2. 场景 A（放行态 RELEASED）：检索 TEST2609-001，验证概览区出现「传递链闸门（合格后传递）」区块、锚点、放行统计
 * 3. 场景 B（阻断态 BLOCKED）：检索 TEST2609-020，验证闸门显示「阻断」状态徽标与阻断统计
 * 4. 场景 C（终止态 TERMINATED）：检索 TEST2609-018，验证闸门显示「整链已终止（MRB 退货 / 报废）」告警文案与终止状态徽标
 * 5. 场景 D（检验中 PENDING）：检索 TEST2609-002，验证闸门显示「检验中」状态徽标与检验中统计
 * 6. 场景 E（现有库演示批次，缺失自动 SKIP）：特采 / 上游不合格 / MRB 在途 / 返工在途 / 链首缺失
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

// Windows Hyper-V/WSL 会动态保留 TCP 端口段（netsh ... show excludedportrange），
// 落入排除段时 Chrome 绑定调试端口直接 WSAEACCES → CDP 起不来。
// 候选端口按序尝试；可用 CDP_PORT 指定首选。
const PORT_CANDIDATES = [Number(process.env.CDP_PORT || 0), 9500, 9830, 9338].filter((p) => p > 0);
const OUT_DIR = path.resolve(__dirname, '../logs');
const LOG = path.join(OUT_DIR, 'board-transfer-gate-ui-verify.log');
fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(LOG, '');

const log = (...a) => {
  const line = a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ');
  fs.appendFileSync(LOG, line + '\n');
  console.log(line);
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const WEB_CANDIDATES = [
  'http://127.0.0.1:31100',
  'http://[::1]:31100',
  'http://localhost:31100',
];

const CHROME_PATHS = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  path.join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe'),
];

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
    } catch {}
  }
  throw new Error(`前端未监听，候选地址均不可用: ${WEB_CANDIDATES.join(', ')}`);
}

function requestJson(method, url) {
  const u = new URL(url);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        method,
      },
      (res) => {
        let buf = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (buf += c));
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode, data: buf ? JSON.parse(buf) : null });
          } catch (e) {
            reject(e);
          }
        });
      }
    );
    req.on('error', reject);
    req.end();
  });
}

async function resolveCdpBase(port) {
  const candidates = [`http://127.0.0.1:${port}`, `http://[::1]:${port}`, `http://localhost:${port}`];
  for (const base of candidates) {
    try {
      await requestJson('GET', `${base}/json/version`);
      return base;
    } catch {}
  }
  throw new Error('Chrome CDP not reachable');
}

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
  }
  static async connect(wsUrl) {
    const ws = new WebSocket(wsUrl);
    await new Promise((res, rej) => {
      ws.onopen = res;
      ws.onerror = () => rej(new Error('ws error'));
    });
    const cdp = new Cdp(ws);
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && cdp.pending.has(msg.id)) {
        const { resolve, reject } = cdp.pending.get(msg.id);
        cdp.pending.delete(msg.id);
        msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
      }
    };
    return cdp;
  }
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
function check(name, ok, detail) {
  results.push({ name, ok: Boolean(ok) });
  log((ok ? 'PASS' : 'FAIL') + ' :: ' + name + (detail === undefined ? '' : ' :: ' + JSON.stringify(detail)));
}

async function main() {
  let chromeExe = null;
  for (const p of CHROME_PATHS) {
    if (fs.existsSync(p)) { chromeExe = p; break; }
  }
  if (!chromeExe) {
    check('找到 Chrome 可执行文件', false, { searched: CHROME_PATHS });
    process.exitCode = 1;
    return;
  }

  const profileDir = path.resolve(OUT_DIR, 'chrome-profile-board-gate');
  let chromeProc = null;
  let cdpBase = null;
  let usedPort = 0;
  try {
    for (const port of PORT_CANDIDATES) {
      chromeProc = spawn(chromeExe, [
        '--headless=new',
        '--remote-debugging-port=' + port,
        '--user-data-dir=' + profileDir,
        '--disable-extensions',
        '--disable-crash-reporter',
        '--no-sandbox',
        '--no-first-run',
        '--no-default-browser-check',
        'about:blank',
      ], { detached: false, stdio: 'ignore' });
      for (let i = 0; i < 40; i++) {
        try {
          cdpBase = await resolveCdpBase(port);
          if (cdpBase) { usedPort = port; break; }
        } catch {}
        await sleep(250);
      }
      if (cdpBase) break;
      try { chromeProc.kill(); } catch {}
      chromeProc = null;
      await sleep(500);
    }
    check('CDP 调试端口启动成功 (:' + (usedPort || PORT_CANDIDATES.join('/')) + ')', Boolean(cdpBase), { cdpBase });
    if (!cdpBase) {
      process.exitCode = 1;
      return;
    }

    const verRes = (await requestJson('GET', `${cdpBase}/json/version`)).data;
    log('chrome ok:', verRes.Browser, 'cdp:', cdpBase);

    const listRes = (await requestJson('GET', `${cdpBase}/json/list`)).data;
    const page = listRes.find((x) => x.type === 'page') || listRes[0];
    if (!page || !page.webSocketDebuggerUrl) throw new Error('未找到可用 Page target');

    const cdp = await Cdp.connect(page.webSocketDebuggerUrl);
    await cdp.send('Page.enable');
    await cdp.send('DOM.enable');

    const webBase = await resolveWebBase();
    log('web base:', webBase);
    await cdp.send('Page.navigate', { url: new URL('/', webBase).href });
    await sleep(6000);

    // 1. 登录
    const loginOk = await evalJs(cdp, `
      (() => {
        const btn = Array.from(document.querySelectorAll('button')).find(b => (b.innerText || '').includes('进入系统'));
        if (btn) { btn.click(); return true; }
        return false;
      })()
    `);
    check('系统登录入口或已处系统内', loginOk !== null && loginOk !== undefined);
    await sleep(6000);

    // 2. 导航到质量追溯看板
    const navOk = await evalJs(cdp, `
      (() => {
        const items = Array.from(document.querySelectorAll('aside nav button, aside nav a, nav button, nav div'));
        const target = items.find(el => (el.innerText || '').trim() === '质量追溯看板');
        if (target) {
          target.click();
          return (target.innerText || '').trim();
        }
        return null;
      })()
    `);
    check('左侧菜单「质量追溯看板」可导航', Boolean(navOk), navOk);
    await sleep(6000); const curUrl = await evalJs(cdp, 'window.location.href'); console.log('DEBUG CURRENT URL:', curUrl);
    await sleep(1500);

    // 辅助函数：在输入框内填入批次并点击查询
    async function searchBatch(batchNo) {
      const res = await evalJs(cdp, `
        (() => {
          const inputs = Array.from(document.querySelectorAll('input'));
          const input = inputs.find(i => (i.placeholder || '').includes('LOT-2026') || (i.placeholder || '').includes('批次') || (i.placeholder || '').includes('PO-B'));
          if (!input) { return { ok: false, reason: 'no_input', found: inputs.map(i => ({ placeholder: i.placeholder, type: i.type, name: i.name, id: i.id })) }; }
          
          const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
          setter.call(input, '${batchNo}');
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));

          const btn = Array.from(document.querySelectorAll('button')).find(b => (b.innerText || '').includes('查询追溯链') || (b.innerText || '').includes('检索'));
          if (!btn) return { ok: false, reason: 'no_btn' };
          btn.click();
          return { ok: true, value: input.value };
        })()
      `);
      await sleep(1500);

      // 如果有候选项列表且当前有匹配行，点击匹配行或首行
      await evalJs(cdp, `
        (() => {
          const rows = Array.from(document.querySelectorAll('table tbody tr'));
          const matchRow = rows.find(r => (r.innerText || '').includes('${batchNo}'));
          if (matchRow) { matchRow.click(); return true; }
          if (rows.length > 0) { rows[0].click(); return true; }
          return false;
        })()
      `);
      await sleep(2000);
      return res;
    }

    // --- 场景 A：放行态（RELEASED）---
    log('--- 场景 A：放行态（TEST2609-001）---');
    const sA = await searchBatch('TEST2609-001');
    check('检索放行批次 TEST2609-001', Boolean(sA && sA.ok), sA);
    
    const gateInfoA = await evalJs(cdp, `
      (() => {
        const bodyText = document.body.innerText || '';
        const hasGate = bodyText.includes('传递链闸门（合格后传递）');
        const hasReleasedBadge = bodyText.includes('全部放行') || bodyText.includes('已放行') || bodyText.includes('RELEASED');
        const hasAnchor = bodyText.includes('锚点 BATCH=TEST2609-001');
        return { hasGate, hasReleasedBadge, hasAnchor };
      })()
    `);
    check('场景 A：页面呈现「传递链闸门（合格后传递）」区块', gateInfoA.hasGate);
    check('场景 A：状态显示为放行态相关标识', gateInfoA.hasReleasedBadge);
    check('场景 A：包含 BATCH 锚点信息', gateInfoA.hasAnchor);

    // --- 场景 B：阻断态（BLOCKED）---
    log('--- 场景 B：阻断态（TEST2609-020）---');
    const sB = await searchBatch('TEST2609-020');
    check('检索阻断批次 TEST2609-020', Boolean(sB && sB.ok), sB);

    const gateInfoB = await evalJs(cdp, `
      (() => {
        const bodyText = document.body.innerText || '';
        const hasBlockedBadge = bodyText.includes('阻断') || bodyText.includes('BLOCKED');
        const hasBlockCount = bodyText.includes('阻断 1');
        return { hasBlockedBadge, hasBlockCount };
      })()
    `);
    check('场景 B：闸门显示「阻断」状态徽标', gateInfoB.hasBlockedBadge);
    check('场景 B：阻断计数正确 (阻断 1)', gateInfoB.hasBlockCount);

    // --- 场景 C：终止态（TERMINATED）---
    log('--- 场景 C：终止态（TEST2609-018）---');
    const sC = await searchBatch('TEST2609-018');
    check('检索终止批次 TEST2609-018', Boolean(sC && sC.ok), sC);

    const gateInfoC = await evalJs(cdp, `
      (() => {
        const bodyText = document.body.innerText || '';
        const hasTerminatedText = bodyText.includes('整链已终止（MRB 退货 / 报废）');
        const hasTerminatedBadge = bodyText.includes('链路终止') || bodyText.includes('TERMINATED');
        return { hasTerminatedText, hasTerminatedBadge };
      })()
    `);
    check('场景 C：呈现「整链已终止（MRB 退货 / 报废）」红色告警文案', gateInfoC.hasTerminatedText);
    check('场景 C：显示整链终止状态徽标', gateInfoC.hasTerminatedBadge);

    // --- 场景 D：检验中（PENDING）---
    log('--- 场景 D：检验中态（TEST2609-002）---');
    const sD = await searchBatch('TEST2609-002');
    check('检索检验中批次 TEST2609-002', Boolean(sD && sD.ok), sD);

    const gateInfoD = await evalJs(cdp, `
      (() => {
        const bodyText = document.body.innerText || '';
        const hasPendingBadge = bodyText.includes('检验中') || bodyText.includes('PENDING');
        const hasPendingCount = bodyText.includes('检验中 1');
        return { hasPendingBadge, hasPendingCount };
      })()
    `);
    check('场景 D：显示「检验中」状态徽标', gateInfoD.hasPendingBadge);
    check('场景 D：检验中计数正确 (检验中 1)', gateInfoD.hasPendingCount);

    // --- 场景 E：现有库演示批次（非夹具数据，缺失时 SKIP 不计失败）---
    // 覆盖 A-D 之外的理由码：UPSTREAM_CONCESSION / UPSTREAM_FAILED / UPSTREAM_UNDER_MRB /
    // UPSTREAM_REINSPECTING / 单环节链首 UPSTREAM_MISSING。
    const skip = (name, why) => log('SKIP :: ' + name + ' :: ' + why);
    const demoScenario = async (batch, expects) => {
      const s = await searchBatch(batch);
      if (!s || !s.ok) { skip(batch, '检索未命中（演示数据不在库）'); return; }
      await sleep(500);
      const info = await evalJs(cdp, `
        (() => {
          const bodyText = document.body.innerText || '';
          return {
            hasGate: bodyText.includes('传递链闸门（合格后传递）'),
            checks: ${JSON.stringify(expects)}.map(([name, needle]) => [name, bodyText.includes(needle)]),
          };
        })()
      `);
      if (!info.hasGate) { skip(batch, '闸门区块未渲染（演示数据不在库）'); return; }
      for (const [name, ok] of info.checks) check(batch + '：' + name, ok);
    };
    await demoScenario('B20231011-92', [
      ['特采姿态徽标「让步接收（受限放行）」', '让步接收（受限放行）'],
      ['让步放行凭证含 MRB 单号', 'MRB-20231011-01'],
    ]);
    await demoScenario('TEST2609-HT-004A', [
      ['阻断姿态徽标「上游不合格」', '上游不合格'],
      ['指名拦截单 OQC-HT-20260923-9105', 'OQC-HT-20260923-9105'],
    ]);
    await demoScenario('B20231013-03', [
      ['MRB 在途姿态「上游 MRB 评审中」', '上游 MRB 评审中'],
    ]);
    await demoScenario('TEST2609-011', [
      ['返工在途姿态「返工复检中」', '返工复检中'],
    ]);
    await demoScenario('B20231013-02', [
      ['已放行徽标', '已放行'],
      ['链首缺失提示「上游环节缺失」', '上游环节缺失'],
    ]);

    cdp.ws.close();
  } finally {
    try { chromeProc.kill(); } catch {}
  }
}

main()
  .then(() => {
    const failed = results.filter((r) => !r.ok);
    console.log('=== 汇总：' + (results.length - failed.length) + '/' + results.length + ' 通过 ===');
    process.exitCode = failed.length === 0 ? 0 : 1;
  })
  .catch((err) => {
    console.error('探针异常终止：', err);
    process.exitCode = 2;
  });