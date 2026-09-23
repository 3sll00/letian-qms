/**
 * 陈静录入页「方案指标清单」渲染探针（CDP 驱动，只读）
 *
 * 背景：用户实测反馈「陈静的检验填写内容为空是怎么回事」—— 以 IQC 检验员 `陈静`
 * 打开【来料检验】→ `INS-20231013-0001` 录入表单，横幅报「质检方案匹配失败」、
 * 三个指标分区全空、指标条「检验项总数 0 项」。
 * 根因、口径与改造清单见 docs/42-质检方案域PBAC供应商维度错配修复设计.md。
 *
 * 本脚本把该现象的**界面级**判定固化成可重跑断言
 * （接口级断言见 apps/api/test/integration/plan-match-pbac-link.test.ts）：
 *   P1 正例：修复后横幅应为「已匹配质检方案」+ 4 项待检指标
 *            （直径 DIA-001 / 抗拉强度 TEN-001 / 碳含量 CHE-001 / 表面粗糙度 RGH-001），
 *            指标条「检验项总数 4 项」，
 *            且不得出现「无需录入」/「清单未就绪」这类把"取不到"说成"不需要"的空态；
 *   P2 负例：把 `GET /plans/match` 的响应换成服务端**真实 403 响应体**
 *            （`pbac-permission-denied`）后重开表单，横幅必须走
 *            「无该物料的数据权限」分支，**不得**再引导用户去找质量工程师配方案。
 *
 * 只做导航 + 读 DOM + 调只读接口 + 浏览器内请求替身：不写库、不改接口、不改业务代码。
 * 退出码：0 = 全部断言通过；1 = 存在失败项或探针异常；3 = 环境不可用。
 */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const OUT_DIR = path.resolve(__dirname, '..', 'logs');
const SHOT_DIR = path.resolve(__dirname, '..', '..', 'docs', 'screenshots');
const PORT = Number(process.env.CDP_PORT || 9346);
const WEB = process.env.WEB_BASE || 'http://127.0.0.1:5200/';
const API_BASE = process.env.API_BASE || 'http://127.0.0.1:3100/api/v1';
const CHEN_JING = '11000000-0000-4000-8000-000000000008';
const ORDER_NO = 'INS-20231013-0001';
const PLAN_CODE = 'QP-IQC-304SS';
/** 待检指标：录入表单按**指标名称**渲染（itemCode 只出现在接口与生成证书里），故断言看名称 */
const ITEM_LABELS = ['直径', '抗拉强度', '碳含量', '表面粗糙度'];
const CHROME_ERR_LOG = path.join(OUT_DIR, 'plan-match-ui-probe.chrome.err.log');

/**
 * 服务端对「管辖范围外物料」的真实 403 响应体（2026-09-23 实测原文，见 docs/42 §5）。
 * P2 原样回放给浏览器：不伪造字段、不写库，只验证前端把这枚 403 渲染成了哪一支分支。
 */
const DENIED_403 = JSON.stringify({
  type: 'https://letian-qms.com/errors/pbac-permission-denied',
  title: '权限不足或数据越权',
  status: 403,
  detail:
    '三维 PBAC 安全拦截: 用户 陈静(11000000-0000-4000-8000-000000000008) 无权操作 [匹配质检方案] ' +
    '物料分类 [CAT-FIN-BOLT] / 物料 [MAT-BLT-109-M10] / 供应商 [*]',
  instance: '/api/v1/plans/match?materialCode=MAT-BLT-109-M10&inspectionType=OQC_SH',
  code: 'pbac-permission-denied',
  traceId: 'req-probe',
});

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.mkdirSync(SHOT_DIR, { recursive: true });
const LOG = path.join(OUT_DIR, 'plan-match-ui-probe.log');
fs.writeFileSync(LOG, '');
const log = (...a) => {
  const line = a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ');
  fs.appendFileSync(LOG, line + '\n');
  console.log(line);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 环境不可用（前端 / 后端未监听，浏览器起不来）—— 以退出码 3 收场 */
class Fatal extends Error {}

function httpJson(url, options = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, options, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, body: data });
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(5000, () => req.destroy(new Error('timeout ' + url)));
    if (options.body) req.write(options.body);
    req.end();
  });
}

/** 端口探测：首页返回 HTML，只看"有没有人应答" */
function probeHttp(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on('error', reject);
    req.setTimeout(3000, () => req.destroy(new Error('timeout')));
  });
}

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.handlers = new Map();
  }

  static async connect(wsUrl) {
    if (typeof WebSocket !== 'function') throw new Fatal('当前 Node 没有全局 WebSocket，请用 Node 22+ 运行本探针');
    const ws = new WebSocket(wsUrl);
    await new Promise((res, rej) => {
      ws.onopen = res;
      ws.onerror = () => rej(new Fatal('CDP 握手失败：' + wsUrl));
    });
    const cdp = new Cdp(ws);
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && cdp.pending.has(msg.id)) {
        const { resolve, reject } = cdp.pending.get(msg.id);
        cdp.pending.delete(msg.id);
        msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
        return;
      }
      if (msg.method) for (const handler of cdp.handlers.get(msg.method) ?? []) handler(msg.params);
    };
    return cdp;
  }

  /** 注册 CDP 事件回调（与 id 配对的应答走 pending，互不干扰） */
  on(method, handler) {
    const list = this.handlers.get(method) ?? [];
    list.push(handler);
    this.handlers.set(method, list);
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
  if (r.exceptionDetails) throw new Error('页面内 JS 求值异常：' + JSON.stringify(r.exceptionDetails.exception));
  return r.result.value;
}

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok });
  log(`${ok ? 'PASS' : 'FAIL'} :: ${name}${detail === undefined ? '' : ' :: ' + JSON.stringify(detail)}`);
};

/** 本轮自己拉起的 Chrome profile（跑完删除；复用别人的调试实例时保持 null） */
let spawnedProfile = null;

/** 复用已有调试实例；否则用**全新** profile 拉起无头 Chrome 并返回句柄（复用别人的实例时返回 null） */
async function ensureChrome() {
  try {
    await httpJson(`http://127.0.0.1:${PORT}/json/version`);
    log(`[CDP] 复用已存在的调试实例 127.0.0.1:${PORT}`);
    return null;
  } catch {
    /* 需要自行拉起 */
  }

  if (!fs.existsSync(CHROME)) throw new Fatal(`Chrome 不存在：${CHROME}（可用 CHROME_PATH 覆盖）`);

  // profile 必须每次全新：若复用正被别的 Chrome 占用的目录，新进程会把命令转交给旧实例后直接退出，
  // 调试端口永远不监听 —— 外部表现就是 "Chrome CDP not reachable"。
  const profile = path.join(OUT_DIR, `plan-match-probe-profile-${process.pid}-${Date.now()}`);
  if (!path.resolve(profile).startsWith(path.resolve(OUT_DIR) + path.sep)) {
    throw new Fatal('拒绝在日志目录之外创建 Chrome profile');
  }
  fs.mkdirSync(profile, { recursive: true });
  spawnedProfile = profile;
  log('[CDP] 拉起无头 Chrome，profile =', profile);
  return spawn(
    CHROME,
    [
      '--headless=new',
      `--remote-debugging-port=${PORT}`,
      `--user-data-dir=${profile}`,
      '--remote-allow-origins=*',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--disable-crash-reporter',
      '--no-sandbox',
      '--window-size=1780,1100',
      'about:blank',
    ],
    { stdio: ['ignore', 'ignore', fs.openSync(CHROME_ERR_LOG, 'a')] }
  );
}

async function waitForCdp(attempts = 60) {
  for (let i = 0; i < attempts; i++) {
    try {
      return await httpJson(`http://127.0.0.1:${PORT}/json/version`);
    } catch {
      await sleep(500);
    }
  }
  return null;
}

async function main() {
  // 0) 环境前置：前端 / 后端任一不可达就直接退出码 3，不让 Chrome 空等到超时
  try {
    await probeHttp(WEB);
  } catch (err) {
    throw new Fatal(`前端未监听：${WEB}（先跑 pnpm --filter @letian/web run dev）｜${err.message}`);
  }

  let login;
  try {
    login = await httpJson(`${API_BASE}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userId: CHEN_JING }),
    });
  } catch (err) {
    throw new Fatal(`后端不可达：${API_BASE}（先跑 pnpm --filter @letian/api run dev）｜${err.message}`);
  }
  if (login.status !== 200) throw new Fatal(`陈静登录失败 ${login.status}: ${JSON.stringify(login.body)}`);
  const user = login.body.user ?? {};
  log(
    '陈静登录成功：',
    user.userName ?? user.name ?? '?',
    '· 角色',
    user.roleCode ?? user.role ?? '?',
    '· 生效规则数',
    user.activeRulesCount ?? '?'
  );

  const chrome = await ensureChrome();
  try {
    const version = await waitForCdp();
    if (version === null) throw new Fatal(`Chrome 调试端口 ${PORT} 未就绪，见 ${CHROME_ERR_LOG}`);
    log('[CDP] 浏览器：', version.body.Browser);

    const list = await httpJson(`http://127.0.0.1:${PORT}/json/list`);
    const page = (list.body ?? []).find((t) => t.type === 'page');
    if (page === undefined) throw new Fatal('未找到可调试的页面目标');
    const cdp = await Cdp.connect(page.webSocketDebuggerUrl);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 1780,
      height: 1100,
      deviceScaleFactor: 1,
      mobile: false,
    });

    const consoleErrors = [];
    cdp.on('Runtime.exceptionThrown', (p) => {
      const d = p.exceptionDetails ?? {};
      const text = String(d.exception?.description ?? d.text ?? '').split('\n')[0].slice(0, 160);
      consoleErrors.push('exceptionThrown: ' + text);
    });
    cdp.on('Runtime.consoleAPICalled', (p) => {
      if (p.type === 'error') consoleErrors.push('console.error');
    });

    const shot = async (name) => {
      const r = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
      const buf = Buffer.from(r.data, 'base64');
      const durable = path.join(SHOT_DIR, name);
      fs.writeFileSync(durable, buf);
      fs.writeFileSync(path.join(OUT_DIR, name), buf);
      log('SHOT:', durable);
      return durable;
    };

    /** 轮询页面内条件（不用固定 sleep 赌加载时间）：超时返回 false 并记账 */
    const waitFor = async (expression, timeoutMs, label) => {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        let ok = false;
        try {
          ok = (await evalJs(cdp, expression)) === true;
        } catch {
          ok = false; // 导航中求值会抛错，按"还没好"处理
        }
        if (ok) return true;
        if (Date.now() > deadline) {
          log(`[waitFor] 超时 ${timeoutMs}ms :: ${label}`);
          return false;
        }
        await sleep(500);
      }
    };

    /** 侧栏 / 导航项是否已出现（前缀匹配，容忍菜单项上的角标数字） */
    const hasText = (needle) =>
      `[...document.querySelectorAll('button,a,div,span,li')].some((e) => e.innerText && e.innerText.trim().startsWith(${JSON.stringify(needle)}))`;

    // 1) 先落地同源，再注入会话（与 api.ts 的存储键一致），省去驱动登录页下拉
    const goHome = async () => {
      await cdp.send('Page.navigate', { url: WEB });
      await waitFor(`document.readyState === 'complete'`, 30000, '页面加载完成');
      await evalJs(
        cdp,
        `(() => {
          localStorage.setItem('letian_qms_token', ${JSON.stringify(login.body.token)});
          localStorage.setItem('letian_qms_user', ${JSON.stringify(JSON.stringify(user))});
          return true;
        })()`
      );
      await cdp.send('Page.reload', {});
      // 注入会话后必须真的回到应用内：否则后面的点击会落在登录页上，断言全灭
      await waitFor(`document.body.innerText.includes('陈静')`, 30000, '会话注入后回到应用内');
    };

    /** 打开 INS-20231013-0001 的录入表单：侧栏 → 台账行 → 行内【检验】（= 按当前方案录入） */
    const openIqcForm = async (tag, assertNav) => {
      const navReady = await waitFor(hasText('来料检验'), 25000, `${tag} 侧栏出现【来料检验】`);
      if (assertNav) check(`${tag} 侧栏进入【来料检验】`, navReady);
      if (!navReady) return false;

      await evalJs(
        cdp,
        `(() => {
          const matches = [...document.querySelectorAll('button,a,div,span,li')]
            .filter((e) => e.innerText && e.innerText.trim().startsWith('来料检验'));
          const deep = matches.reduce((best, e) => (e.innerText.trim().length <= best.innerText.trim().length ? e : best));
          (deep.closest('a,button') || deep).click();
          return true;
        })()`
      );

      const rowReady = await waitFor(
        `[...document.querySelectorAll('tbody tr')].some((r) => r.innerText.includes(${JSON.stringify(ORDER_NO)}))`,
        25000,
        `${tag} 台账出现目标行`
      );
      const rowText = await evalJs(
        cdp,
        `(() => {
          const tr = [...document.querySelectorAll('tbody tr')].find((r) => r.innerText.includes(${JSON.stringify(ORDER_NO)}));
          return tr ? tr.innerText.replace(/\\s+/g, ' ').slice(0, 90) : null;
        })()`
      );
      if (assertNav) check(`${tag} 台账含目标行 ${ORDER_NO}`, rowReady, rowText);
      log(`[${tag}] 目标行：`, rowText);
      if (!rowReady) return false;

      const opened = await evalJs(
        cdp,
        `(() => {
          const tr = [...document.querySelectorAll('tbody tr')].find((r) => r.innerText.includes(${JSON.stringify(ORDER_NO)}));
          if (!tr) return 'row-not-found';
          const btn = [...tr.querySelectorAll('button')].find((b) => ['检验', '继续'].includes(b.innerText.trim()));
          if (!btn) return 'button-not-found:' + [...tr.querySelectorAll('button')].map((b) => b.innerText.trim()).join('/');
          btn.click();
          return 'clicked';
        })()`
      );
      if (assertNav) check(`${tag} 点击行内【检验】进入录入表单`, opened === 'clicked', opened);
      log(`[${tag}] 行内按钮：`, opened);
      if (opened !== 'clicked') return false;

      return waitFor(
        `document.querySelector('[data-testid="plan-match-banner"]') !== null`,
        25000,
        `${tag} 录入页提示条出现`
      );
    };

    /** 等提示条稳定到某个状态（loading → ready / error 之间不能抢拍） */
    const waitForBannerStatus = (expected, label) =>
      waitFor(
        `(() => {
          const b = document.querySelector('[data-testid="plan-match-banner"]');
          return b !== null && b.getAttribute('data-status') === ${JSON.stringify(expected)};
        })()`,
        25000,
        label
      );

    const readBanner = () =>
      evalJs(
        cdp,
        `(() => {
          const banner = document.querySelector('[data-testid="plan-match-banner"]');
          const text = document.body.innerText;
          const total = text.match(/检验项总数[:：]?\\s*(\\d+)\\s*项/);
          return {
            bannerStatus: banner ? banner.getAttribute('data-status') : null,
            bannerSource: banner ? banner.getAttribute('data-source') : null,
            bannerPermissionDenied: banner ? banner.getAttribute('data-permission-denied') : null,
            bannerText: banner ? banner.innerText.replace(/\\s+/g, ' ').slice(0, 260) : null,
            totalMatch: total ? Number(total[1]) : null,
            rowCount: [...document.querySelectorAll('tbody tr')].filter((tr) => tr.innerText.trim() !== '').length,
            noNeedHits: (text.match(/无需录入/g) || []).length,
            notReadyHits: (text.match(/清单未就绪/g) || []).length,
            hasPlanCode: text.includes(${JSON.stringify(PLAN_CODE)}),
            items: ${JSON.stringify(ITEM_LABELS)}.filter((c) => text.includes(c)),
          };
        })()`
      );

    // ---------- P1 正例：修复后的录入页 ----------
    await goHome();
    const who = await evalJs(cdp, 'document.body.innerText.slice(0, 200)');
    check(
      '页面以陈静身份进入系统（顶栏可见用户名）',
      who.includes('陈静'),
      who.replace(/\n/g, ' | ').slice(0, 120)
    );
    await openIqcForm('P1', true);
    await waitForBannerStatus('ready', 'P1 提示条进入 ready');

    const fixed = await readBanner();
    log('P1 dom snapshot:', fixed);
    check('P1 横幅 status = ready（方案已命中）', fixed.bannerStatus === 'ready', fixed.bannerStatus);
    check(
      'P1 横幅未走数据权限拦截分支',
      fixed.bannerPermissionDenied !== 'true' && !(fixed.bannerText ?? '').includes('无该物料的数据权限'),
      fixed.bannerPermissionDenied
    );
    check(`P1 横幅展示命中方案 ${PLAN_CODE}`, fixed.hasPlanCode === true);
    check('P1「检验项总数」= 4 项（修复前为 0）', fixed.totalMatch === 4, fixed.totalMatch);
    check('P1 三分区 4 项待检指标全部渲染（直径 / 抗拉强度 / 碳含量 / 表面粗糙度）', fixed.items.length === 4, fixed.items);
    check('P1 不再出现「无需录入」空态', fixed.noNeedHits === 0, fixed.noNeedHits);
    check('P1 不再出现「清单未就绪」空态', fixed.notReadyHits === 0, fixed.notReadyHits);
    const fixedShot = await shot('plan-match-chenjing-fixed.png');
    const errorsAfterPositive = consoleErrors.length;

    // ---------- P2 负例：把 /plans/match 换成服务端真实 403 响应体 ----------
    await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*/api/v1/plans/match*', requestStage: 'Request' }] });
    let paused = 0;
    cdp.on('Fetch.requestPaused', (p) => {
      paused += 1;
      void cdp.send('Fetch.fulfillRequest', {
        requestId: p.requestId,
        responseCode: 403,
        responseHeaders: [{ name: 'content-type', value: 'application/problem+json; charset=utf-8' }],
        body: Buffer.from(DENIED_403, 'utf8').toString('base64'),
      });
    });

    await goHome();
    await openIqcForm('P2', false);
    await waitForBannerStatus('error', 'P2 提示条进入 error');
    const denied = await readBanner();
    log('P2 dom snapshot:', denied);
    check('P2 请求替身已生效（/plans/match 被替换为 403）', paused > 0, paused);
    check('P2 横幅 status = error', denied.bannerStatus === 'error', denied.bannerStatus);
    check('P2 横幅 data-permission-denied = true', denied.bannerPermissionDenied === 'true', denied.bannerPermissionDenied);
    check('P2 横幅标题为「无该物料的数据权限」', (denied.bannerText ?? '').includes('无该物料的数据权限'), denied.bannerText);
    check(
      'P2 文案改指「物料权限」而非引导去建方案',
      (denied.bannerText ?? '').includes('物料权限') && !(denied.bannerText ?? '').includes('请先由质量工程师'),
      denied.bannerText
    );
    check('P2 分区空态不再谎称「无需录入」', denied.noNeedHits === 0, denied.noNeedHits);
    check('P2 分区空态改说「未就绪」并指向上方提示', denied.notReadyHits > 0, denied.notReadyHits);
    check('P2 不渲染任何指标行', denied.items.length === 0, denied.items);
    await shot('plan-match-chenjing-403.png');
    await cdp.send('Fetch.disable');

    check('P1 阶段控制台无未捕获异常 / console.error', errorsAfterPositive === 0, consoleErrors.slice(0, 3));

    const failed = results.filter((r) => !r.ok);
    log(`---- 合计 ${results.length} 条断言，通过 ${results.length - failed.length}，失败 ${failed.length} ----`);
    log('截图：', fixedShot, path.join(SHOT_DIR, 'plan-match-chenjing-403.png'));
    if (failed.length > 0) log('失败项：', failed.map((f) => f.name).join(' / '));
    return failed.length === 0 ? 0 : 1;
  } finally {
    if (chrome !== null) {
      // 只关自己拉起的那个进程树；复用别人的调试实例时 chrome === null，什么都不做
      try {
        chrome.kill();
        log('[CDP] 已关闭本轮拉起的浏览器');
      } catch {
        /* 忽略 */
      }
      await sleep(400);
      // 临时 profile 一并删除，别让 scripts/logs/ 攒一堆浏览器用户目录
      if (spawnedProfile !== null && path.resolve(spawnedProfile).startsWith(path.resolve(OUT_DIR) + path.sep)) {
        // taskkill 之后进程树还在收尾，文件可能短暂被占用 —— 重试几次再放弃
        let removed = false;
        let lastErr = null;
        for (let i = 0; i < 6; i++) {
          try {
            fs.rmSync(spawnedProfile, { recursive: true, force: true });
            removed = true;
            break;
          } catch (err) {
            lastErr = err;
            await sleep(400);
          }
        }
        if (!removed) log('[CDP] 临时 profile 未能删除：', String(lastErr && lastErr.message), spawnedProfile);
      }
    }
  }
}

main().then(
  (code) => {
    log(`==== 陈静录入页方案清单渲染探针结束，退出码 ${code} ====`);
    process.exit(code);
  },
  (err) => {
    if (err instanceof Fatal) {
      log('FATAL :: ' + err.message);
      process.exit(3);
    }
    log('探针异常 :: ' + (err && err.stack ? err.stack : String(err)));
    process.exit(1);
  }
);
