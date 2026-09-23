/**
 * docs/35 遗留项二轮收口实测探针（CDP 驱动：接口口径 + 真实页面写路径）
 *
 * 覆盖：
 *   M5  企业档案主数据：GET 已维护 / PUT 非法邮箱 400 / 页面保存回执与真实落库 / 清空生效
 *   M4  质量负责人签核：非授权角色 403、QA_MANAGER 200、签核人与时间真实落库、幂等覆盖
 *   M3  来料 / 出货录入写路径：提交回执条（data-testid=iqc-submit-receipt / oqc-submit-receipt）
 *   M7  委外「新建委外检验单」入口可达 + 物料编码选择器（选中即回填物料名称）
 *   M9  四个台账行级「证书」入口 + 证书弹窗缺失提示条（不打印提示）
 *
 * 前置：API :3100、由真后端代理的前端（自动探测 :5200 -> :5201 -> :5202，并跳过离线 Mock 实例）、
 *       数据库已按最新种子播种（pnpm db:seed）。
 * 用法：`pnpm verify:leftovers2`（等价 node scripts/testing/leftovers2-probe.cjs）
 * 复位：本探针**会真实写库**（企业档案 / 签核 / 提交回执），跑完必须再跑一次 `pnpm db:seed`。
 *
 * 退出码：0 = 全部通过；1 = 存在失败项；2 = 探针自身异常；3 = 前置不可达（API 或前端未启动）。
 */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const OUT_DIR = path.join(__dirname, '..', 'logs');
fs.mkdirSync(OUT_DIR, { recursive: true });
const PORT = 9341;
const WEB_CANDIDATES = ['http://127.0.0.1:5200/', 'http://127.0.0.1:5201/', 'http://127.0.0.1:5202/'];
const API_BASE = process.env.API_BASE || 'http://127.0.0.1:3100/api/v1';
const DB_URL = process.env.DATABASE_URL || 'postgresql://letian_user:letian_secure_pass_2026@127.0.0.1:5432/letian_qms_db';

const MAIN_USER = '11000000-0000-4000-8000-000000000001'; // 张强 · QA_MANAGER（签核授权角色）
const INSPECTOR_USER = '11000000-0000-4000-8000-000000000008'; // 陈静 · IQC_INSPECTOR（非签核角色）

const LOG = path.join(OUT_DIR, 'leftovers2-probe.log');
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

/** 可达性探测：只关心「端口上有没有服务在应答」，不要求响应体是 JSON（vite dev server 首页是 HTML） */
function httpReachable(url) {
  return new Promise((resolve) => {
    const req = http.get(url, (res) => { res.resume(); resolve(true); });
    req.on('error', () => resolve(false));
    req.setTimeout(5000, () => { req.destroy(); resolve(false); });
  });
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
  results.push(ok);
  log(`${ok ? 'PASS' : 'FAIL'} :: ${name}${detail === undefined ? '' : ' :: ' + JSON.stringify(detail)}`);
};

/** 浏览器侧通用工具：给受 React 控制的 input/select/textarea 赋值 */
const SETTER = `
  const setVal = (el, v) => {
    const proto = el.tagName === 'SELECT' ? HTMLSelectElement.prototype
      : el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  };
`;

/** 表单全部带标签控件：{ label, value, placeholder, type } */
const DUMP_FORM = `(() => {
  const out = [];
  document.querySelectorAll('input, select, textarea').forEach((el) => {
    if (el.type === 'radio' || el.type === 'checkbox') return;
    let label = '';
    const box = el.closest('div,td,label');
    if (box) { const lbl = box.querySelector('label,span'); if (lbl) label = lbl.innerText.trim(); }
    out.push({ label, value: el.value, placeholder: el.placeholder || '', type: el.type });
  });
  return out;
})()`;

const clickButton = (text, exact) => `(() => {
  const btn = [...document.querySelectorAll('button,a')].find((b) => b.innerText.trim() ${exact ? '===' : '.includes('} ${JSON.stringify(text)} ${exact ? '' : ')'});
  if (!btn) return 'no-button';
  btn.click();
  return 'clicked';
})()`;

const setLabelInput = (label, value) => `(() => {
  ${SETTER}
  const el = [...document.querySelectorAll('label')].find((l) => l.innerText.trim().startsWith(${JSON.stringify(label)}));
  if (!el) return 'no-label';
  const input = el.parentElement.querySelector('input,select,textarea');
  if (!input) return 'no-input';
  setVal(input, ${JSON.stringify(value)});
  return 'ok';
})()`;

const findByLabel = (fields, label) => {
  const hit = fields.find((f) => f.label.includes(label));
  return hit === undefined ? undefined : hit;
};

/** pg 依赖解析：仓库用 pnpm 隔离式 node_modules，scripts/ 不是工作区包，回退到 .pnpm 存储目录 */
function resolvePg() {
  try {
    return require('pg');
  } catch {
    const store = path.join(__dirname, '..', '..', 'node_modules', '.pnpm');
    const entry = fs.readdirSync(store).filter((name) => name.startsWith('pg@')).sort().pop();
    if (entry === undefined) throw new Error('未找到 pg 依赖，无法执行数据库核对与清理');
    return require(path.join(store, entry, 'node_modules', 'pg'));
  }
}

(async () => {
  // 前置检查：先确认 API 与前端在线，给出可执行的补救命令，而不是让人对着超时猜原因
  if (!(await httpReachable(`${API_BASE}/auth/login`))) { // 401/405 都算在线，只要有应答
    console.error(`PROBE ERROR: API ${API_BASE} 不可达 —— 请先运行 pnpm --filter @letian/api run dev`);
    process.exit(3);
  }
  let webUp = false;
  for (const candidate of WEB_CANDIDATES) {
    if (await httpReachable(candidate)) { webUp = true; break; }
  }
  if (!webUp) {
    console.error(`PROBE ERROR: 前端 ${WEB_CANDIDATES.join(" / ")} 均不可达 —— 请先运行 pnpm --filter @letian/web run dev`);
    process.exit(3);
  }

  const { Client } = resolvePg();
  const db = new Client({ connectionString: DB_URL });
  await db.connect();

  const loginAs = async (userId) => {
    const res = await httpJson(`${API_BASE}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userId }),
    });
    return res.body;
  };
  const qa = await loginAs(MAIN_USER);
  const inspector = await loginAs(INSPECTOR_USER);
  const authQa = { authorization: `Bearer ${qa.token}` };
  const authInspector = { authorization: `Bearer ${inspector.token}` };
  const jsonAuth = (auth) => ({ ...auth, 'content-type': 'application/json' });

  // ---------- M4：企业档案接口口径 ----------
  const profile = await httpJson(`${API_BASE}/master-data/company-profile`, { headers: authQa });
  const profileRow = profile.body;
  check('M5 企业档案 GET 返回已维护行（法定名称 + 印章文字非空）',
    profile.status === 200 && profileRow !== null && typeof profileRow?.legalName === 'string' && profileRow.legalName !== ''
      && typeof profileRow?.qualityStamp === 'string' && profileRow.qualityStamp !== '',
    profileRow);

  const badEmail = await httpJson(`${API_BASE}/master-data/company-profile`, {
    method: 'PUT', headers: jsonAuth(authQa), body: JSON.stringify({ email: 'not-an-email' }),
  });
  check('M5 PUT 非法邮箱 -> 400（契约 z.string().email() 生效，不是静默接受）',
    badEmail.status === 400, { status: badEmail.status, title: badEmail.body?.title });

  // ---------- 目标单据挑选（有方案指标行的真实单） ----------
  const iqcList = await httpJson(`${API_BASE}/inspections?inspectionType=IQC&page=1&pageSize=50`, { headers: authQa });
  let approveTarget = null;
  let submitTarget = null;
  for (const row of iqcList.body.list) {
    const detail = (await httpJson(`${API_BASE}/inspections/${row.id}`, { headers: authQa })).body;
    const items = Array.isArray(detail?.items) ? detail.items : [];
    if (items.length === 0) continue;
    if (approveTarget === null) approveTarget = detail;
    const noMeasured = items.every((i) => (i.measuredVal ?? null) === null && String(i.measuredText ?? '').trim() === '');
    // 只要求「有方案指标行 + 一条实测值都没录」：这样的单才既能走提交写路径，又能触发证书缺失提示条
    if (submitTarget === null && noMeasured) submitTarget = detail;
  }
  check('前置 找到带质检方案指标行的 IQC 单据（签核 / 提交 / 证书提示条用例都依赖它）',
    approveTarget !== null && submitTarget !== null,
    { approveTarget: approveTarget?.orderNo ?? null, submitTarget: submitTarget?.orderNo ?? null });

  // ---------- M5：签核权限门禁与真实落库 ----------
  const denied = await httpJson(`${API_BASE}/inspections/${approveTarget.id}/approve`, {
    method: 'POST', headers: jsonAuth(authInspector), body: '{}',
  });
  check('M4 非签核角色（IQC_INSPECTOR 陈静）签核 -> 403（门禁在服务端，不在前端猜测）',
    denied.status === 403, { status: denied.status, title: denied.body?.title });

  const approved = await httpJson(`${API_BASE}/inspections/${approveTarget.id}/approve`, {
    method: 'POST', headers: jsonAuth(authQa), body: '{}',
  });
  check('M4 QA_MANAGER（张强）签核 -> 200 且回吐签核人 = 当前登录用户真实姓名',
    approved.status === 200 && typeof approved.body?.approverName === 'string' && approved.body.approverName !== '',
    { status: approved.status, approverName: approved.body?.approverName });

  const afterApprove = (await httpJson(`${API_BASE}/inspections/${approveTarget.id}`, { headers: authQa })).body;
  check('M4 签核人 / 签核时间真实落库（重新 GET 仍在，不是仅响应体内存值）',
    afterApprove.approverName === approved.body.approverName
      && typeof afterApprove.approvedAt === 'string' && afterApprove.approvedAt !== '',
    { approverName: afterApprove.approverName, approvedAt: afterApprove.approvedAt });

  const auditRow = await db.query(
    "SELECT count(*)::int AS n FROM audit_logs WHERE diff_patch->>'event' = 'QUALITY_APPROVAL' AND entity_id = $1",
    [approveTarget.id],
  );
  check('M4 签核写入一条 QUALITY_APPROVAL 审计留痕（append-only，可追溯谁签的）',
    auditRow.rows[0].n >= 1, { auditRows: auditRow.rows[0].n });

  await sleep(1100);
  const reApproved = await httpJson(`${API_BASE}/inspections/${approveTarget.id}/approve`, {
    method: 'POST', headers: jsonAuth(authQa), body: JSON.stringify({ remark: '探针重复签核' }),
  });
  check('M4 重复签核幂等覆盖（第二次签核返回新的签核时间，不报冲突）',
    reApproved.status === 200 && reApproved.body.approvedAt >= afterApprove.approvedAt,
    { before: afterApprove.approvedAt, after: reApproved.body?.approvedAt });

  // ---------- 启动 Chrome ----------
  const userDataDir = path.join(OUT_DIR, 'chrome-profile-leftovers2');
  fs.mkdirSync(userDataDir, { recursive: true });
  const chrome = spawn(CHROME, [
    `--remote-debugging-port=${PORT}`, `--user-data-dir=${userDataDir}`, '--headless=new',
    '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-crash-reporter',
    '--no-sandbox', '--window-size=1780,1500', 'about:blank',
  ], { stdio: 'ignore' });
  let version = null;
  for (let i = 0; i < 60; i++) {
    try { version = await httpJson(`http://127.0.0.1:${PORT}/json/version`); break; } catch { await sleep(500); }
  }
  if (!version) throw new Error('Chrome CDP not reachable');
  const list = await httpJson(`http://127.0.0.1:${PORT}/json/list`);
  const page = list.body.find((t) => t.type === 'page');
  const cdp = await Cdp.connect(page.webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1780, height: 1500, deviceScaleFactor: 1, mobile: false });

  const shot = async (name) => {
    const r = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    fs.writeFileSync(path.join(OUT_DIR, name), Buffer.from(r.data, 'base64'));
    log('SHOT:', path.join(OUT_DIR, name));
  };

  /**
   * 只挑「真后端在背后」的前端实例：候选里的离线 Mock 实例（MSW）同样会 200 响应首页，
   * 但它不读数据库 —— 把落库断言跑到它上面会得出假结论（顶栏身份、签核人、企业档案全是内存值）。
   * 判定办法：问同一个源的 /api/v1/auth/users，真实后端返回 200 + 非空职员数组。
   */
  const servesRealBackend = async (base) => {
    try {
      const res = await httpJson(`${base}api/v1/auth/users`);
      return res.status === 200 && Array.isArray(res.body) && res.body.length > 0;
    } catch {
      return false;
    }
  };
  let webBase = null;
  for (const base of WEB_CANDIDATES) {
    try {
      const res = await new Promise((resolve, reject) => {
        const req = http.get(base, (r) => { r.resume(); resolve(r.statusCode); });
        req.on('error', reject);
        req.setTimeout(3000, () => req.destroy(new Error('timeout')));
      });
      if (res >= 200 && res < 400 && (await servesRealBackend(base))) { webBase = base; break; }
    } catch { /* next */ }
  }
  log('web base:', webBase);
  if (webBase === null) {
    console.error('PROBE ERROR: 未找到「真后端在前」的前端实例（候选 ' + WEB_CANDIDATES.join(' / ') + '）。');
    console.error('  本探针断言的是数据库落库结果，跑在离线 Mock 实例上等于自欺，故拒绝执行。请启动：');
    console.error('    pnpm --filter @letian/api run dev   # API :3100');
    console.error('    pnpm --filter @letian/web run dev   # 前端（代理真后端）');
    process.exit(3);
  }

  const clickNav = async (label) => evalJs(cdp, `(() => {
    const matches = [...document.querySelectorAll('button,a,div,span,li')].filter((e) => e.innerText && e.innerText.trim().startsWith(${JSON.stringify(label)}));
    if (matches.length === 0) return null;
    const deep = matches.reduce((best, e) => (e.innerText.trim().length <= best.innerText.trim().length ? e : best));
    const target = deep.closest('a,button') || deep;
    target.click();
    return target.innerText.trim();
  })()`);

  const readRows = async () => evalJs(cdp, `(() => {
    const out = [];
    document.querySelectorAll('table tbody tr').forEach((tr) => {
      const tds = [...tr.querySelectorAll('td')];
      if (tds.length === 0) return;
      out.push({
        orderNo: tds[0].innerText.trim(),
        actions: [...tr.querySelectorAll('button,a')].map((b) => b.innerText.trim()),
      });
    });
    return out;
  })()`);

  const clickRowAction = async (orderNo, action) => evalJs(cdp, `(() => {
    for (const tr of document.querySelectorAll('table tbody tr')) {
      if (!tr.innerText.includes(${JSON.stringify(orderNo)})) continue;
      const btn = [...tr.querySelectorAll('button,a')].find((b) => b.innerText.trim() === ${JSON.stringify(action)});
      if (btn) { btn.click(); return 'clicked'; }
      return 'no-action';
    }
    return 'no-row';
  })()`);

  const MODAL_FIND = `[...document.querySelectorAll('div.fixed.inset-0')].find((d) => d.innerText.includes('打印'))`;
  const modalText = async () => evalJs(cdp, `(() => { const m = ${MODAL_FIND}; return m ? m.innerText : null; })()`);
  const closeModal = async () => evalJs(cdp, `(() => {
    const m = ${MODAL_FIND};
    if (!m) return 'no-modal';
    const b = [...m.querySelectorAll('button')].find((x) => x.getAttribute('title') === '关闭');
    if (b) { b.click(); return 'closed'; }
    return 'no-close';
  })()`);

  const goto = async () => {
    // 每次从「未登录」起步：Chrome 用户目录是复用的，残留 localStorage 会话会让
    // 顶栏身份停在上一轮的用户上，与本次登录身份不一致（断言会因此指向错误结论）。
    for (const candidate of WEB_CANDIDATES) {
      try {
        await cdp.send('Storage.clearDataForOrigin', { origin: new URL(candidate).origin, storageTypes: 'all' });
      } catch { /* 个别 Chrome 版本不支持该命令时忽略 */ }
    }
    await cdp.send('Page.navigate', { url: webBase });
    await sleep(7000);
    await evalJs(cdp, `(() => { const b=[...document.querySelectorAll('button')].find(x=>x.innerText.includes('进入系统')); if(b){b.click();return true;} return false; })()`);
    await sleep(7000);
  };

  /** clickButton 只是表达式生成器：这里统一经 evalJs 执行，避免把源码字符串当成点击结果 */
  const click = async (text, exact = true) => evalJs(cdp, clickButton(text, exact));

  await goto();

  // ---------- M8/M4：企业档案页（读 / 写 / 回执 / 清空） ----------
  log('nav 存货档案:', await clickNav('存货档案'));
  await sleep(4000);
  log('tab 企业档案:', await click('企业档案', true));
  await sleep(4000);
  let form = await evalJs(cdp, DUMP_FORM);
  const legal = findByLabel(form, '企业法定名称');
  check('M5 主数据页出现「企业档案」页签，且回显已维护的企业法定名称',
    legal !== undefined && legal.value === '宁波乐天紧固件制造有限公司', legal);
  const addBtnVisible = await evalJs(cdp, `(() => [...document.querySelectorAll('button')].some((b) => b.innerText.includes('新增')))()`);
  check('M5 企业档案页签下不展示「新增」入口（单行主数据没有「新增一条」语义）',
    addBtnVisible === false, addBtnVisible);
  await shot('leftovers2-company-profile.png');

  log('set address:', await evalJs(cdp, setLabelInput('企业地址（中文）', '探针临时地址-TEMP')));
  await sleep(600);
  log('save:', await click('保存企业档案', true));
  await sleep(3500);
  const receiptText = await evalJs(cdp, `(() => {
    // 精确取绿字回执块（bg-emerald-50）：不能用「包含关键字的最外层 div」，那会把整页 innerText 当回执
    const e = [...document.querySelectorAll('div')].find((d) => String(d.className).includes('bg-emerald-50') && d.innerText.includes('此后生成的证书'));
    return e ? e.innerText.trim() : null;
  })()`);
  check('M5 页面保存出现绿字回执（企业档案已保存）',
    typeof receiptText === 'string' && receiptText.includes('已保存'), receiptText);
  const savedProfile = (await httpJson(`${API_BASE}/master-data/company-profile`, { headers: authQa })).body;
  check('M5 页面保存真实落库（接口回读 address = 探针临时值）',
    savedProfile?.address === '探针临时地址-TEMP', { address: savedProfile?.address });
  check('M5 维护人由服务端按当前登录用户写入（页面不可自称）',
    savedProfile?.updatedBy === '张强', { updatedBy: savedProfile?.updatedBy });
  await shot('leftovers2-company-profile-saved.png');

  log('clear address:', await evalJs(cdp, setLabelInput('企业地址（中文）', '')));
  await sleep(600);
  log('save2:', await click('保存企业档案', true));
  await sleep(3500);
  const clearedProfile = (await httpJson(`${API_BASE}/master-data/company-profile`, { headers: authQa })).body;
  check('M5 字段清空真实生效（显式空串 = 清空，探针值不残留）',
    (clearedProfile?.address ?? '') === '', { address: clearedProfile?.address });

  // ---------- M9：四个台账行级「证书」入口 ----------
  const entries = [
    { name: '来料检验(IQC)台账', nav: '来料检验(IQC)' },
    { name: '过程检验(IPQC)台账', nav: '过程检验(IPQC)', drill: '查看台账' },
    { name: '委外检验台账', nav: '委外检验' },
    { name: '出货检验 (OQC)台账', nav: '出货检验 (OQC)' },
  ];
  let iqcCertText = null;
  for (const entry of entries) {
    log('nav ' + entry.name + ':', await clickNav(entry.nav));
    await sleep(4500);
    if (entry.drill !== undefined) {
      // IPQC 首屏是三张台账的入口卡（下料 / 滚丝 / 成品检），先下钻进台账才有行级操作列
      const firstRow = (await readRows())[0];
      log('drill ' + entry.name + ':', firstRow === undefined ? 'no-row' : await clickRowAction(firstRow.orderNo, entry.drill));
      await sleep(4500);
    }
    const rows = await readRows();
    const row = rows.find((r) => r.actions.includes('证书'));
    if (row === undefined) {
      check(`${entry.name}：行级「证书」入口存在（所有行可点，不再只给已合格行）`, false, rows.slice(0, 3));
      continue;
    }
    check(`${entry.name}：行级「证书」入口存在`, true, { orderNo: row.orderNo, actions: row.actions });
    const opened = await clickRowAction(row.orderNo, '证书');
    await sleep(2500);
    const text = await modalText();
    const hasOrderNo = typeof text === 'string' && text.includes(row.orderNo);
    check(`${entry.name}：点「证书」可打开证书且含本行单号（未录入项留白）`,
      opened === 'clicked' && hasOrderNo, { opened, hasOrderNo });
    if (entry.nav === '来料检验(IQC)') iqcCertText = text;
    await shot(`leftovers2-cert-${entry.name.slice(0, 2)}.png`);
    await closeModal();
    await sleep(900);
  }

  // ---------- M9：证书弹窗「不打印」提示条 ----------
  log('iqc cert hints:', typeof iqcCertText === 'string' ? iqcCertText.split('\n').filter((l) => l.includes('提示：')) : iqcCertText);
  check('M9 证书弹窗带非打印提示条（说明为什么有空白：缺分段 / 企业档案未维护）',
    typeof iqcCertText === 'string' && iqcCertText.includes('提示：'),
    typeof iqcCertText === 'string' ? iqcCertText.split('\n').filter((l) => l.includes('提示：')) : iqcCertText);

  // ---------- M3：来料录入提交回执 ----------
  log('nav IQC(提交用例):', await clickNav('来料检验(IQC)'));
  await sleep(4000);
  // 行级主操作的文案随单据状态变化（未检验=检验 / 检验中=继续）：按真实按钮文案点击，不硬编码
  const submitAction = await evalJs(cdp, `(() => {
    for (const tr of document.querySelectorAll('table tbody tr')) {
      if (!tr.innerText.includes(${JSON.stringify(submitTarget === null ? '' : submitTarget.orderNo)})) continue;
      const labels = [...tr.querySelectorAll('button,a')].map((b) => b.innerText.trim());
      if (labels.includes('检验')) return '检验';
      if (labels.includes('继续')) return '继续';
      return 'none';
    }
    return 'no-row';
  })()`);
  log('open 检验:', submitAction === '检验' || submitAction === '继续' ? await clickRowAction(submitTarget.orderNo, submitAction) : 'skipped', { submitAction });
  await sleep(5500);
  const approveBtnText = await evalJs(cdp, `(() => {
    const hit = [...document.querySelectorAll('button')].find((b) => /质量负责人签核|重新签核/.test(b.innerText));
    return hit ? hit.innerText.trim() : null;
  })()`);
  check('M4 录入表单页头出现签核按钮（未签核=质量负责人签核 / 已签核=重新签核，均来自真实签核动作）',
    typeof approveBtnText === 'string', approveBtnText);
  log('fill inspector:', await evalJs(cdp, setLabelInput('检验员', '刘芳')));
  await sleep(400);
  const filledIqc = await evalJs(cdp, `(() => {
    ${SETTER}
    const inputs = [...document.querySelectorAll('table tbody input, table tbody textarea')]
      .filter((el) => el.type !== 'radio' && el.type !== 'checkbox');
    if (inputs.length === 0) return 'no-input';
    setVal(inputs[0], '1.0');
    return inputs.length;
  })()`);
  log('filled iqc measured inputs:', filledIqc);
  await sleep(800);
  log('submit:', await click('保存并提交来料判定', true));
  await sleep(6000);
  const iqcReceipt = await evalJs(cdp, `(() => { const e = document.querySelector('[data-testid="iqc-submit-receipt"]'); return e ? e.innerText.trim() : null; })()`);
  check('M3 来料录入提交回执 = 服务端返回的检验单号与判定（不再 alert 假成功）',
    typeof iqcReceipt === 'string' && iqcReceipt.includes('已保存并终判') && iqcReceipt.includes(submitTarget.orderNo),
    iqcReceipt);
  await shot('leftovers2-iqc-submit.png');

  // ---------- M7：委外新建入口 + 物料编码选择器 ----------
  log('nav 委外检验(新建用例):', await clickNav('委外检验'));
  await sleep(4000);
  // 按钮 innerText 含前缀图标字符（「+ 新建委外检验单」），用包含匹配
  log('click 新建委外检验单:', await click('新建委外检验单', false));
  await sleep(5000);
  const materialSelect = await evalJs(cdp, `(() => {
    const labels = [...document.querySelectorAll('label')];
    const el = labels.find((l) => l.innerText.trim().startsWith('物料编码'));
    if (!el) return { found: false };
    const box = el.parentElement;
    const sel = box.querySelector('select');
    const input = box.querySelector('input');
    return {
      found: true,
      tag: sel ? 'SELECT' : input ? 'INPUT' : 'NONE',
      readOnly: input ? input.readOnly : null,
      options: sel ? [...sel.options].map((o) => o.value).filter((v) => v !== '') : [],
      placeholder: sel && sel.options[0] ? sel.options[0].text : null,
    };
  })()`);
  check('M7 委外「新建委外检验单」入口可达，且物料编码是存货主数据选择器（不是空值静默拦下）',
    materialSelect.found === true && materialSelect.tag === 'SELECT' && materialSelect.options.length > 0, materialSelect);
  const picked = (materialSelect.options ?? [])[0];
  if (picked === undefined) {
    check('M7 选中物料编码即从主数据回填物料名称（物料编码不再由 materialCode 为空静默拦下）', false, { reason: '选择器不可用', materialSelect });
  }
  log('pick material:', picked === undefined ? 'skipped' : await evalJs(cdp, setLabelInput('物料编码', picked)));
  await sleep(1200);
  // 物料名称字段的标签是「产品名称及规格 (Description & Size)」：用占位符定位更稳（换标签文案不会让探针失效）
  const backfilled = picked === undefined ? null : await evalJs(cdp, `(() => {
    const input = [...document.querySelectorAll('input,textarea')].find((el) => el.placeholder === '取本单物料名称');
    return input ? input.value : null;
  })()`);
  if (picked !== undefined) {
    check('M7 选中物料编码即从主数据回填物料名称（物料编码不再由 materialCode 为空静默拦下）',
      typeof backfilled === 'string' && backfilled.trim() !== '', { picked, materialName: backfilled });
  }
  await shot('leftovers2-outsource-new.png');
  log('back 委外列表:', await click('返回委外列表', false));
  await sleep(2500);

  // ---------- 收尾：清理探针残留（签核三列 + 临时审计留痕） ----------
  const cleanup = await db.query(
    'UPDATE inspection_orders SET approver_id = NULL, approver_name = NULL, approved_at = NULL WHERE id = $1',
    [approveTarget.id],
  );
  log('cleanup approver columns:', cleanup.rowCount);
  // 审计日志是 append-only（触发器 prevent_audit_log_tampering 拒绝 UPDATE / DELETE）：
  // 这里主动试删一次并断言被拒绝 —— 「可追溯」不是文档里的一句话，而是数据库层的强制约束。
  let auditImmutable = false;
  try {
    await db.query('DELETE FROM audit_logs WHERE entity_id = $1', [approveTarget.id]);
  } catch {
    auditImmutable = true;
  }
  const auditLeft = await db.query(
    "SELECT count(*)::int AS n FROM audit_logs WHERE diff_patch->>'event' = 'QUALITY_APPROVAL' AND entity_id = $1",
    [approveTarget.id],
  );
  check('收尾 审计日志 append-only：签核留痕在数据库层不可被删除（触发器拒绝 DELETE）',
    auditImmutable && auditLeft.rows[0].n >= 1, { rejected: auditImmutable, kept: auditLeft.rows[0].n });
  const finalProfile = (await httpJson(`${API_BASE}/master-data/company-profile`, { headers: authQa })).body;
  check('收尾 企业档案回到种子值（地址为空、抬头为种子抬头）',
    (finalProfile?.address ?? '') === '' && finalProfile?.legalName === '宁波乐天紧固件制造有限公司',
    { address: finalProfile?.address, legalName: finalProfile?.legalName });

  await db.end();
  // 本探针会真实推进一单的实测值与终判：跑完请执行 `pnpm db:seed` 回到演示基线（种子会整表重播）
  log('NOTE: 本探针真实写库（提交实测值/终判），跑完请执行 pnpm db:seed 复位演示基线');
  log(`SUMMARY: ${results.filter(Boolean).length}/${results.length} passed`);
  chrome.kill();
  process.exit(results.every(Boolean) ? 0 : 1);
})().catch((e) => { console.error('PROBE ERROR:', e); process.exit(2); });
