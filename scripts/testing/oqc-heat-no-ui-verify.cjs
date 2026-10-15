/**
 * 出货检验「炉批号溯源联动」**界面级**验收（CDP 驱动，只读 DOM、不点提交、不写库）
 *
 * 覆盖 docs/47 §6 里属于界面表现的断言（服务端侧断言见 scripts/testing/heat-batch-trace-verify.cjs）：
 *   AC-11：打开目标单，炉批号回显自库；Banner 显示「委外热处理 + 源单号」（修 D8「恒显示来料检验」）
 *   AC-09：清空炉批号 -> 带出值回滚、计数清零、Banner 消失（修 D11）
 *   AC-04：查无记录的炉号 -> 界面静默空态（无 Banner、不报错）
 *   TBD-03：炉批号标签默认显示 ★（可配置开关的默认态，单点实现 apps/web/src/lib/oqcHeatNoRequirement.ts）
 *
 * 为什么单独一个脚本：服务端脚本能证明"数据对了"，但 AC-09 / AC-11 的一半是**界面事实**
 * （Banner 文案、清空后的回滚、回显来源），只能在实际渲染出来的 DOM 上验。
 *
 * 只做：导航 + 读 DOM + 截图。不点「提交并生成质保书」，因此不会改动任何单据状态。
 */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const OUT_DIR = path.join(__dirname, '..', 'logs');
fs.mkdirSync(OUT_DIR, { recursive: true });
// 默认 9440：原 9336 落在本机 Windows 动态端口保留段（netsh excludedportrange 9240-9439），
// Chrome DevTools 无法 bind；可用 CDP_PORT 覆盖（与 inspection-detail-probe 同一惯例）。
const PORT = Number(process.env.CDP_PORT || 9440);
const WEB_CANDIDATES = process.env.WEB_BASE
  ? [process.env.WEB_BASE]
  : ['http://127.0.0.1:31100/', 'http://127.0.0.1:31101/', 'http://127.0.0.1:31102/'];
const API_BASE = process.env.API_BASE || 'http://127.0.0.1:3100/api/v1';

const TARGET_ORDER_NO = 'OQC-SH-20260923-9001';
const HEAT_L1 = 'TEST-HT-2609-001';
const EXPECTED_SOURCE_ORDER = 'OQC-HT-20260923-9103';
const HEAT_NONE = 'TEST-HT-2609-003';
/** 组④：同炉存在不合格记录（TBD-01 空态提示场景） */
const HEAT_FAILED = 'TEST-HT-2609-004';
/** 组①里那张 MRB 未结案的 OQC_HEAT（TBD-01「带出 + 提示」场景） */
const MRB_ORDER_NO = 'OQC-HT-20260923-9104';
/** 组④里那张不合格的 OQC_HEAT（TBD-01「空态 + 提示」场景） */
const FAILED_ORDER_NO = 'OQC-HT-20260923-9105';

const LOG = path.join(OUT_DIR, 'oqc-heat-no-ui-verify.log');
fs.writeFileSync(LOG, '');
const log = (...a) => {
  const line = a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ');
  fs.appendFileSync(LOG, line + '\n');
  console.log(line);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function probeHttp(url) {
  return new Promise((resolve, reject) => {
    const req = require('node:http').get(url, (res) => {
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
  throw new Error(`前端未监听，候选地址均不可用: ${WEB_CANDIDATES.join(', ')}`);
}

function requestJson(method, url, token, body) {
  const http = require('node:http');
  const u = new URL(url);
  const payload = body === undefined ? null : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        method,
        headers: {
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode, json: data === '' ? null : JSON.parse(data) });
          } catch (e) {
            reject(e);
          }
        });
      }
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/**
 * CDP 探针地址解析：Chrome 在本机可能只绑到 IPv6 环回（`--remote-debugging-port`
 * 的 IPv4 绑定被系统拒绝时会静默回落到 `[::1]`），因此三种写法都试一遍，
 * 避免"Chrome 起来了却连不上"的假失败。
 */
async function resolveCdpBase(port) {
  const candidates = [`http://127.0.0.1:${port}`, `http://[::1]:${port}`, `http://localhost:${port}`];
  for (const base of candidates) {
    try {
      await requestJson('GET', `${base}/json/version`, '');
      return base;
    } catch { /* 试下一个 */ }
  }
  throw new Error('Chrome CDP not reachable');
}

class Cdp {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); }
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
const check = (name, ok, detail) => {
  results.push({ name, ok });
  log(`${ok ? 'PASS' : 'FAIL'} :: ${name}${detail === undefined ? '' : ' :: ' + JSON.stringify(detail)}`);
};

/** 读取录入页的炉批号相关状态：输入框值 / 标签 / 溯源 Banner / 提示行 */
const READ_FORM = `(() => {
  const input = [...document.querySelectorAll('input')].find((i) => (i.placeholder || '').includes('输入炉号'));
  const body = document.body.innerText;
  const labelEl = input && input.closest('div') ? input.closest('div').querySelector('label') : null;
  // 带出文案有两个分支（docs/47 §9.6.4）：有带出值时「已依据炉号…自动带入」，
  // 带出 0 项时「已按炉号…关联到前道工序检验记录」（两分支都回吐源单据号）。
  const srcLine = (body.match(/已依据炉号[^\\n]*/) || body.match(/已按炉号[^\\n]*/) || [''])[0];
  const bannerLine = (body.match(/[^\\n]*炉批号溯源联动[^\\n]*/) || [''])[0];
  const warningLine = (body.match(/[^\\n]*(同炉不合格提示|同炉 MRB 未结案提示|同炉检验未终判提示)[^\\n]*/) || [''])[0];
  return {
    hasInput: input !== null,
    value: input ? input.value : null,
    label: labelEl ? labelEl.innerText : '',
    warning: warningLine !== '',
    warningLine,
    banner: /炉批号溯源联动/.test(body),
    bannerLine,
    srcLine,
    modifiedBadge: (body.match(/已手动修改 \d+ 项指标[^\\n]*/) || [''])[0],
    hasError: /检验单.*加载失败|加载失败|不符合契约/.test(body),
  };
})()`;

/** React 受控输入：必须走原生 setter + input 事件，否则 React 收不到变更 */
const setHeatValue = (value) => `(() => {
  const input = [...document.querySelectorAll('input')].find((i) => (i.placeholder || '').includes('输入炉号'));
  if (!input) return 'NO_INPUT';
  const desc = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value');
  desc.set.call(input, ${JSON.stringify(value)});
  input.dispatchEvent(new Event('input', { bubbles: true }));
  return input.value;
})()`;

(async () => {
  const userDataDir = path.join(OUT_DIR, 'chrome-profile-oqc-heat');
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
  chrome.on('error', (e) => log('chrome spawn error:', String(e)));

  let cdpBase = null;
  for (let i = 0; i < 60; i++) {
    try { cdpBase = await resolveCdpBase(PORT); break; } catch { await sleep(500); }
  }
  if (cdpBase === null) throw new Error('Chrome CDP not reachable');
  const version = await requestJson('GET', `${cdpBase}/json/version`, '');
  log('chrome ok:', version.json['Browser'], 'cdp:', cdpBase);

  const list = (await requestJson('GET', `${cdpBase}/json/list`, '')).json;
  const page = list.find((t) => t.type === 'page');
  const cdp = await Cdp.connect(page.webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
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
  log('login clicked:', await evalJs(cdp, `(() => {
    const b = [...document.querySelectorAll('button')].find((x) => x.innerText.includes('进入系统'));
    if (b) { b.click(); return true; } return false;
  })()`));
  await sleep(7000);

  log('nav 出货检验:', await evalJs(cdp, `(() => {
    const el = [...document.querySelectorAll('button,a,div,span,li')]
      .find((e) => e.innerText && e.innerText.trim().startsWith('出货检验'));
    if (el) { el.click(); return el.innerText.trim(); } return null;
  })()`));
  await sleep(6000);

  // 打开目标单：行内动作按钮（检验中 -> 「继续」）
  const opened = await evalJs(cdp, `(() => {
    const rows = [...document.querySelectorAll('tbody tr')];
    const row = rows.find((tr) => (tr.querySelectorAll('td')[0] || {}).innerText?.trim() === ${JSON.stringify(TARGET_ORDER_NO)});
    if (!row) return { ok: false, visible: rows.map((tr) => (tr.querySelectorAll('td')[0] || {}).innerText?.trim()).slice(0, 30) };
    const btn = [...row.querySelectorAll('button')].find((b) => ['检验', '继续', '详情'].includes(b.innerText.trim()));
    if (!btn) return { ok: false, reason: 'no-action-button' };
    btn.click();
    return { ok: true, action: btn.innerText.trim() };
  })()`);
  log('open target:', JSON.stringify(opened));
  check('AC-11 目标单可从出货检验台账打开录入页', opened.ok === true, opened);

  let form = null;
  for (let i = 0; i < 20; i++) {
    await sleep(1500);
    form = await evalJs(cdp, READ_FORM);
    if (form.hasInput) break;
  }
  check('AC-11 录入页渲染出炉批号输入框', form.hasInput === true, form.value);
  await shot('oqc-heat-ui-01-open.png');

  // ---- 与服务端逐字段对账：界面回显必须来自库字段 ----
  const login = (await requestJson('POST', `${API_BASE}/auth/login`, '', { userId: '11000000-0000-4000-8000-000000000001' })).json;
  const listed = (await requestJson('GET', `${API_BASE}/inspections?type=OQC_SH&pageSize=50&page=1`, login.token)).json;
  const apiRow = (listed.list || []).find((o) => o.orderNo === TARGET_ORDER_NO);
  log('api row:', JSON.stringify(apiRow && { orderNo: apiRow.orderNo, furnaceHeatNo: apiRow.furnaceHeatNo, status: apiRow.status }));

  check('AC-11 打开即回显库中炉批号（furnaceHeatNo）', form.value === HEAT_L1, form.value);
  check('AC-11 界面回显值 == 接口 furnaceHeatNo（证明取自库字段，非前端推算）', apiRow !== undefined && form.value === apiRow.furnaceHeatNo, { ui: form.value, api: apiRow && apiRow.furnaceHeatNo });
  check('AC-11 Banner 显示「委外热处理」（修 D8：此前恒显示来料检验）', /委外热处理/.test(form.bannerLine) && !/来料检验/.test(form.bannerLine), form.bannerLine);
  check('AC-11 Banner 带出源单号（界面可追溯来源单据）', form.srcLine.includes(EXPECTED_SOURCE_ORDER), form.srcLine);
  // ---- TBD-01：同炉 MRB 未结案 -> 带出照常 + 琥珀色提示条（只提示、不带值、不阻断） ----
  check(
    'TBD-01 同炉存在 MRB 未结案记录：录入页出现提示条且蓝色带出 Banner 不受影响',
    form.warning === true && /同炉 MRB 未结案提示/.test(form.warningLine) && form.banner === true,
    form.warningLine
  );
  check(
    `TBD-01 提示文案带出命中单号 ${MRB_ORDER_NO} 与「最近终判合格」口径说明`,
    form.warningLine.includes(MRB_ORDER_NO) && /最近终判合格/.test(form.warningLine),
    form.warningLine
  );
  check('TBD-03 炉批号标签默认显示必填标记 ★（可配置开关默认态）', form.label.includes('★'), form.label);
  check('AC-11 录入页未出现「加载失败 / 不符合契约」横幅', form.hasError === false);

  // ---- AC-09：清空炉批号 ----
  await evalJs(cdp, setHeatValue(''));
  await sleep(2500);
  const cleared = await evalJs(cdp, READ_FORM);
  await shot('oqc-heat-ui-02-cleared.png');
  check('AC-09 清空炉批号：输入框为空', cleared.value === '', cleared.value);
  check('AC-09 清空后溯源 Banner 消失', cleared.banner === false, cleared.bannerLine);
  check('AC-09 清空后带出值/修改计数一并回滚（无残留带出与「已手动修改」）', cleared.modifiedBadge === '', cleared.modifiedBadge);

  // ---- 回填：链路可继续使用 ----
  await evalJs(cdp, setHeatValue(HEAT_L1));
  await sleep(2500);
  const restored = await evalJs(cdp, READ_FORM);
  await shot('oqc-heat-ui-03-restored.png');
  check('AC-09 回填炉号后 Banner 恢复（录入可继续）', restored.banner === true && restored.srcLine.includes(EXPECTED_SOURCE_ORDER), restored.srcLine);

  // ---- AC-04（界面侧）：上游无记录的炉号 = 静默空态 ----
  await evalJs(cdp, setHeatValue(HEAT_NONE));
  await sleep(2500);
  const noneState = await evalJs(cdp, READ_FORM);
  check('AC-04 上游无记录的炉号：无 Banner、不报错（静默空态）', noneState.banner === false && noneState.hasError === false, noneState.bannerLine);

  // ---- TBD-01（界面侧）：同炉有不合格记录 -> 空态 + 「同炉不合格提示」（只提示、不带值） ----
  await evalJs(cdp, setHeatValue(HEAT_FAILED));
  await sleep(2500);
  const failedState = await evalJs(cdp, READ_FORM);
  check(
    'TBD-01 同炉存在不合格记录：空态也出现「同炉不合格提示」',
    failedState.warning === true && /同炉不合格提示/.test(failedState.warningLine),
    failedState.warningLine
  );
  check(
    'TBD-01 空态提示不带值：蓝色带出 Banner 不出现（提示 ≠ 带值）',
    failedState.banner === false,
    failedState.bannerLine
  );
  check(
    `TBD-01 不合格提示文案带出命中单号 ${FAILED_ORDER_NO} 与「未带出该炉数据」口径说明`,
    failedState.warningLine.includes(FAILED_ORDER_NO) && /未带出该炉数据/.test(failedState.warningLine),
    failedState.warningLine
  );

  // ---- 复位：把演示单留在可演示状态（仍未提交，不写库） ----
  await evalJs(cdp, setHeatValue(HEAT_L1));
  await sleep(2500);
  const finalState = await evalJs(cdp, READ_FORM);
  check('演示单复位：炉号回到 TEST-HT-2609-001 且 Banner 正常', finalState.value === HEAT_L1 && finalState.banner === true, finalState.value);

  // 收尾：确认没写库（表头仍是之前落库的值，本次只读走查不应改变它）
  const afterList = (await requestJson('GET', `${API_BASE}/inspections?type=OQC_SH&pageSize=50&page=1`, login.token)).json;
  const afterRow = (afterList.list || []).find((o) => o.orderNo === TARGET_ORDER_NO);
  check('本次界面走查未改动库中单据（炉号与状态保持原值）',
    afterRow !== undefined && afterRow.furnaceHeatNo === HEAT_L1 && afterRow.status === (apiRow && apiRow.status),
    afterRow && { furnaceHeatNo: afterRow.furnaceHeatNo, status: afterRow.status });

  const failed = results.filter((r) => !r.ok);
  log(`\n[${failed.length === 0 ? 'PASS' : 'FAIL'}] 出货检验炉批号界面级验收：${results.length - failed.length}/${results.length}`);
  if (failed.length > 0) process.exitCode = 1;
  chrome.kill();
  process.exit(process.exitCode || 0);
})().catch((e) => {
  console.error('探针异常：', e);
  process.exit(2);
});
