/**
 * 「合格后传递」链路门禁验收（docs/48-合格后传递通用链路规则设计与改造方案.md §6）
 *
 * 覆盖：AC-01 ~ AC-13、AC-16 ~ AC-19、AC-035（建单留痕五连）、AC-P2（豁免审批流一单一核销 /
 *       下游冻结批处理幂等 / 传递链 KPI —— docs/48 §8 P2 三项的端到端断言）。
 *
 * 用法（仓库根目录，需先起 API）：
 *   pnpm dev:api          # 另开一个终端
 *   pnpm verify:transfer-gate
 *
 * 三条纪律（与 docs/47 的 verify:* 同型）：
 *   ① 判据只来自**真实 HTTP 响应 + 真实落库回读**，不做任何 Mock；
 *   ② 夹具批次一律 `GATE2609-` 前缀，与演示批次 `TEST2609-` 完全隔离（互不覆盖、互不清理）；
 *   ③ 夹具用于构造上游状态（SQL 直插），被测行为的**动作与判据全部走 API**，不绕过门禁。
 *
 * 环境变量：API_BASE（默认 http://127.0.0.1:3100/api/v1）、DATABASE_URL（默认本机 letian_qms_db）。
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const API_BASE = process.env.API_BASE || 'http://127.0.0.1:3100/api/v1';
const DB_URL =
  process.env.DATABASE_URL ||
  'postgresql://letian_user:letian_secure_pass_2026@127.0.0.1:5433/letian_qms_db';
/** 张强（QA_MANAGER，material_categories = ["*"]）：写侧 PBAC 三维校验不会拦住夹具批次 */
const OPERATOR_ID = '11000000-0000-4000-8000-000000000001';
const PREFIX = 'GATE2609';

/** pg 依赖解析：scripts/ 不是工作区包，回退到 pnpm 存储目录（与其它脚本同一写法） */
function resolvePg() {
  try {
    return require('pg');
  } catch {
    const store = path.join(__dirname, '..', '..', 'node_modules', '.pnpm');
    const entry = fs.readdirSync(store).find((dir) => dir.startsWith('pg@'));
    if (!entry) throw new Error('未找到 pg 依赖，请先 pnpm install');
    return require(path.join(store, entry, 'node_modules', 'pg'));
  }
}

const MATERIALS = {
  BLANK: { code: 'MAT-SCR-M6-25', name: '高强度螺柱 M6*25 (冷镦毛坯)' },
  BOLT: { code: 'MAT-BLT-109-M10', name: '10.9级六角头螺栓 M10*45 (成品)' },
};

/** 真实存在的启用方案（inspection_plans）：夹具行的 plan_id / plan_version_id 指向它，保证外键语义真实 */
const PLAN_BY_TYPE = {
  IQC: '21000000-0000-4000-8000-000000000001',
  IPQC_CT: '23000000-0000-4000-8000-000000000001',
  IPQC_FN: '25000000-0000-4000-8000-000000000001',
  OQC_HEAT: '26000000-0000-4000-8000-000000000202',
  OQC_SH: '27000000-0000-4000-8000-000000000002',
};

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: Boolean(ok) });
  const line = (ok ? 'PASS' : 'FAIL') + ' :: ' + name + (detail === undefined ? '' : ' :: ' + JSON.stringify(detail));
  console.log(line);
}

let token = '';
function authed(extra) {
  return Object.assign({ authorization: 'Bearer ' + token }, extra || {});
}

async function httpJson(pathname, options) {
  const res = await fetch(API_BASE + pathname, options || {});
  const text = await res.text();
  let body;
  try {
    body = text === '' ? null : JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: res.status, body };
}

async function post(pathname, body) {
  return await httpJson(pathname, {
    method: 'POST',
    headers: authed({ 'content-type': 'application/json' }),
    body: JSON.stringify(body),
  });
}

const { Client } = resolvePg();
const client = new Client({ connectionString: DB_URL });
async function q(text, params) {
  const res = await client.query(text, params || []);
  return res.rows;
}

/**
 * OQC 出货检验的出货信息（真实出货单必有：销售出库单号 / 出库日期 / 客户 / ERP 出库单状态）。
 * 夹具必须同样携带 —— 否则会污染「OQC 台账必须返回出货字段」这类全库断言。
 */
const SHIPPING = {
  salesOrderNo: PREFIX + '-SO-0001',
  dispatchDate: '2026-09-23',
  customerName: 'P0 验收客户（夹具）',
  erpStatus: 'SYNCED',
};
const isOqcType = (type) => typeof type === 'string' && type.startsWith('OQC_');
/** 出货信息：仅 OQC 类型携带，其余留空（与真实数据同构） */
function shippingOf(type) {
  return isOqcType(type)
    ? SHIPPING
    : { salesOrderNo: null, dispatchDate: null, customerName: null, erpStatus: null };
}

/**
 * 清理本探针自有夹具（**仅 GATE2609- 前缀，绝不触碰 TEST2609- 演示数据**）。
 * 为什么必须清：夹具是临时现场 —— 留着会污染其它「全库扫描」型断言
 * （如 OQC 台账字段校验会随机命中一张无出货信息的夹具单）。
 * 删除顺序按依赖：pending_mrb_items（唯一外键指向 inspection_orders）→ mrb_reviews
 * → 追溯节点 / 追溯边 → 检验单。审计日志不删（审计表有防篡改 trigger，且留痕正是证据）。
 */
async function purgeFixtures(label) {
  const like = PREFIX + '%';
  const removed = [];
  const del = async (table, column) => {
    const res = await client.query(
      'DELETE FROM ' + table + ' WHERE ' + column + ' LIKE $1',
      [like]
    );
    if (res.rowCount > 0) removed.push(table + '=' + res.rowCount);
  };
  await del('pending_mrb_items', 'batch_no');
  await del('pending_mrb_items', 'source_order_no');
  await del('transfer_override_tickets', 'batch_no');
  await del('mrb_reviews', 'batch_no');
  await del('batch_trace_nodes', 'batch_no');
  await del('batch_trace_relations', 'parent_batch');
  await del('batch_trace_relations', 'child_batch');
  await del('inspection_orders', 'batch_no');
  console.log(
    '--- ' + label + '夹具清理（仅 ' + PREFIX + '-*，TEST2609-* 不动）：' +
      (removed.length === 0 ? '无残留' : removed.join(', ')) +
      ' ---'
  );
}

/** 造上游夹具：直插 inspection_orders（不经门禁，用于构造「上游已处于某状态」的前置条件） */
async function seedOrder(o) {
  const material = o.material || MATERIALS.BLANK;
  const plan = PLAN_BY_TYPE[o.type];
  const stamp = o.updatedAt || new Date();
  const ship = shippingOf(o.type);
  await q(
    'INSERT INTO inspection_orders' +
      ' (id, order_no, order_type, plan_id, plan_version_id, batch_no, material_code, material_name,' +
      '  sample_qty, status, judgment, work_order_no, furnace_heat_batch_no, plan_snapshot,' +
      '  sales_order_no, dispatch_date, customer_name, erp_status, created_at, updated_at)' +
      ' SELECT $1,$2,$3,$4,$4,$5,$6,$7,5,$8,$9,$10,$11,' +
      '  jsonb_build_object(' +
      "    'planId', p.id," +
      "    'planCode', p.plan_code," +
      "    'planName', p.plan_name," +
      "    'versionId', p.id," +
      "    'versionNo', p.version," +
      "    'samplingScheme', COALESCE(p.sampling_config->>'samplingScheme', 'GB_T_2828')," +
      "    'aqlLevel', COALESCE(p.sampling_config->>'aqlLevel', 'II')," +
      "    'strictness', COALESCE(p.sampling_config->>'strictness', 'NORMAL')," +
      "    'items', COALESCE(p.items, '[]'::jsonb)," +
      "    'snapshotAt', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"')" +
      '  ),' +
      '  $13, $14, $15, $16, $12, $12' +
      ' FROM inspection_plans p WHERE p.id = $4' +
      ' ON CONFLICT (order_no) DO UPDATE SET status = EXCLUDED.status, judgment = EXCLUDED.judgment,' +
      '  plan_snapshot = EXCLUDED.plan_snapshot, sales_order_no = EXCLUDED.sales_order_no,' +
      '  dispatch_date = EXCLUDED.dispatch_date, customer_name = EXCLUDED.customer_name,' +
      '  erp_status = EXCLUDED.erp_status,' +
      '  updated_at = EXCLUDED.updated_at, created_at = EXCLUDED.created_at',
    [
      crypto.randomUUID(),
      o.orderNo,
      o.type,
      plan,
      o.batch,
      material.code,
      material.name,
      o.status,
      o.judgment === undefined ? null : o.judgment,
      o.workOrderNo === undefined ? null : o.workOrderNo,
      o.furnaceHeatNo === undefined ? null : o.furnaceHeatNo,
      stamp,
      ship.salesOrderNo,
      ship.dispatchDate,
      ship.customerName,
      ship.erpStatus,
    ]
  );
  return o.orderNo;
}

/** 造 MRB 夹具（SQL 直插，不触发自动建单路径） */
async function seedMrb(o) {
  const material = o.material || MATERIALS.BLANK;
  const stamp = o.updatedAt || new Date();
  await q(
    'INSERT INTO mrb_reviews' +
      ' (id, mrb_no, source_type, source_order_no, batch_no, material_code, material_name,' +
      '  defect_description, defect_qty, status, disposition, concession_attachment_url, created_at, updated_at)' +
      ' VALUES ($1,$2,$3,$4,$5,$6,$7,$8,1,$9,$10,$11,$12,$12)' +
      ' ON CONFLICT (mrb_no) DO UPDATE SET status = EXCLUDED.status, disposition = EXCLUDED.disposition,' +
      '  concession_attachment_url = EXCLUDED.concession_attachment_url, updated_at = EXCLUDED.updated_at',
    [
      crypto.randomUUID(),
      o.mrbNo,
      o.sourceType || 'PROCESS_FAIL',
      o.sourceOrderNo,
      o.batch,
      material.code,
      material.name,
      'P0 验收夹具：上游不合格',
      o.status,
      o.disposition === undefined ? null : o.disposition,
      o.attachmentUrl === undefined ? null : o.attachmentUrl,
      stamp,
    ]
  );
  return o.mrbNo;
}

async function createOrder(payload) {
  // OQC 单必须携带出货信息（与真实出货单同构，避免污染「OQC 台账必须返回出货字段」等全库断言）
  const body = isOqcType(payload.inspectionType)
    ? Object.assign({}, SHIPPING, payload)
    : payload;
  return await post('/inspections', body);
}

async function permitOf(item) {
  const res = await post('/inspections/transfer-permits', { items: [item] });
  return { status: res.status, decision: res.body && res.body.items ? res.body.items[0].decision : null, body: res.body };
}

/** 建单响应里的传递结论：放行（201）在顶层，被阻断（422）在 details 内 —— 统一取值 */
function decisionOf(res) {
  if (!res || !res.body || typeof res.body !== 'object') return null;
  if (res.body.details && res.body.details.transferDecision) return res.body.details.transferDecision;
  return res.body.transferDecision || null;
}

/** 传递理由码；取不到时回 null，让该条断言失败而不是中断整轮验收 */
function codeOf(res) {
  const decision = decisionOf(res);
  return decision ? decision.code : null;
}

async function ledgerRow(orderNo) {
  const res = await httpJson('/inspections?orderNo=' + encodeURIComponent(orderNo) + '&pageSize=5', {
    headers: authed(),
  });
  const items = res.body && Array.isArray(res.body.items) ? res.body.items : [];
  return items.find((row) => row.orderNo === orderNo) || null;
}

async function mrbOfOrder(orderNo) {
  const rows = await q(
    'SELECT id, mrb_no, status, disposition, concession_attachment_url FROM mrb_reviews' +
      ' WHERE source_order_no = $1 ORDER BY updated_at DESC LIMIT 1',
    [orderNo]
  );
  return rows[0] || null;
}

async function orderRowOf(orderNo) {
  const rows = await q('SELECT id, order_no, status, judgment FROM inspection_orders WHERE order_no = $1', [orderNo]);
  return rows[0] || null;
}

async function nodeRowOf(batchNo) {
  const rows = await q('SELECT batch_no, node_status, inspection_order_no FROM batch_trace_nodes WHERE batch_no = $1', [batchNo]);
  return rows[0] || null;
}

const ORDER_DTO_CACHE = new Map();
async function orderIdOf(orderNo) {
  if (!ORDER_DTO_CACHE.has(orderNo)) {
    const row = await orderRowOf(orderNo);
    ORDER_DTO_CACHE.set(orderNo, row ? row.id : null);
  }
  return ORDER_DTO_CACHE.get(orderNo);
}

async function main() {
  console.log('--- 「合格后传递」链路门禁验收（API=' + API_BASE + '）---');
  await client.connect();
  // 先清上一次运行的夹具：保证本轮判据不受上轮残留影响（幂等可重跑）
  await purgeFixtures('运行前');

  const login = await httpJson('/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ userId: OPERATOR_ID }),
  });
  token = login.body && login.body.token ? login.body.token : '';
  if (token === '') {
    console.error('登录失败，无法继续：', login.status, login.body);
    process.exit(2);
  }

  // ================= AC-01：同批次 IQC 合格 -> IPQC_CT 放行 =================
  await seedOrder({ orderNo: PREFIX + '-A1-IQC', type: 'IQC', batch: PREFIX + '-A1', status: 'COMPLETED', judgment: 'PASSED', updatedAt: new Date(Date.now() - 3600e3) });
  const ac01 = await createOrder({ inspectionType: 'IPQC_CT', materialCode: MATERIALS.BLANK.code, batchNo: PREFIX + '-A1', sampleQty: 5, totalQty: 100 });
  check('AC-01 上游 IQC 合格 -> 建 IPQC_CT 返回 201', ac01.status === 201, { status: ac01.status, body: ac01.status === 201 ? undefined : ac01.body });
  const ac01d = ac01.body && ac01.body.transferDecision;
  check('AC-01 transferDecision.allowed = true 且 code = UPSTREAM_PASSED', ac01d && ac01d.allowed === true && ac01d.code === 'UPSTREAM_PASSED', ac01d);
  check('AC-01 predecessorOrderNo = 上游 IQC 单号', ac01d && ac01d.predecessorOrderNo === PREFIX + '-A1-IQC', ac01d && { predecessorOrderNo: ac01d.predecessorOrderNo, chainKeyKind: ac01d.chainKeyKind, chainKey: ac01d.chainKey });

  // ================= AC-035：建单传递留痕（迁移 035，docs/48 §4.1） =================
  // 判据（三条）：
  //   ① 建单那一次的判定必须**持久化**到四列（否则「这批货当初凭什么放行」事后查不到）；
  //   ② 台账接口按 `transferTrace` 下发，且与**实时**字段（canTransfer / transferCode）分键，互不覆盖；
  //   ③ 无上游单时 `upstream_order_no` 写 **NULL 而不是空串**（空串会让「从未留痕」与「留痕为空」无法区分）。
  // 注：本块用独立夹具（-A35 / -A35B），与 AC-01 不共享状态。
  const traceRowOf = async (orderNo) =>
    orderNo
      ? (await q(
          'SELECT chain_key, chain_key_kind, upstream_order_no, upstream_gate_code' +
            ' FROM inspection_orders WHERE order_no = $1',
          [orderNo]
        ))[0]
      : null;
  await seedOrder({ orderNo: PREFIX + '-A35-IQC', type: 'IQC', batch: PREFIX + '-A35', status: 'COMPLETED', judgment: 'PASSED', updatedAt: new Date(Date.now() - 3600e3) });
  const ac35 = await createOrder({ inspectionType: 'IPQC_CT', materialCode: MATERIALS.BLANK.code, batchNo: PREFIX + '-A35', sampleQty: 5, totalQty: 100 });
  const ac35No = ac35.body && ac35.body.orderNo;
  const ac35r = await traceRowOf(ac35No);
  check(
    'AC-035① 放行场景留痕四列齐全（chain_key / chain_key_kind / upstream_order_no / upstream_gate_code）',
    !!ac35r &&
      ac35r.chain_key === PREFIX + '-A35' &&
      ac35r.chain_key_kind === 'BATCH' &&
      ac35r.upstream_order_no === PREFIX + '-A35-IQC' &&
      ac35r.upstream_gate_code === 'UPSTREAM_PASSED',
    ac35r
  );
  const ac35led = ac35No ? await ledgerRow(ac35No) : null;
  check(
    'AC-035② 台账下发 transferTrace，且与实时判定分键（canTransfer / transferCode 仍为实时值）',
    !!ac35led &&
      !!ac35led.transferTrace &&
      ac35led.transferTrace.upstreamOrderNo === PREFIX + '-A35-IQC' &&
      ac35led.transferTrace.upstreamGateCode === 'UPSTREAM_PASSED' &&
      ac35led.transferCode === 'UPSTREAM_PASSED',
    ac35led && {
      transferTrace: ac35led.transferTrace,
      canTransfer: ac35led.canTransfer,
      transferCode: ac35led.transferCode,
    }
  );
  // 环节类型用 IPQC_CT：与 AC-06 同型（该物料有下料工序的生效方案），换 IPQC_RL 会因匹配不到方案建不出单，
  // 那样断言失败的原因是「没建单」而不是「留痕没写」，属于夹具自伤。
  const ac35b = await createOrder({ inspectionType: 'IPQC_CT', materialCode: MATERIALS.BLANK.code, batchNo: PREFIX + '-A35B', sampleQty: 5, totalQty: 100 });
  const ac35br = await traceRowOf(ac35b.body && ac35b.body.orderNo);
  check(
    'AC-035③ 上游缺失（TBD-01）场景：理由码照留痕，上游单号写 NULL 而非空串',
    !!ac35br &&
      ac35br.upstream_gate_code === 'UPSTREAM_MISSING' &&
      ac35br.upstream_order_no === null &&
      ac35br.chain_key === PREFIX + '-A35B',
    ac35br
  );
  // ④⑤ 漂移检测（docs/48 §12.3 第 3 条）：留痕列**只作留痕**、判据永远实时重算 —— 因此必须能测出两者是否漂移。
  //    ④ 无漂移基线：建单当时写下的四列 == 现在实时重算出的三元组（链锚点 / 上游单号 / 判定码）。
  //    ⑤ 人为制造漂移：把上游 IQC 改成不合格 → 留痕**不变**（历史就是历史）、实时**转为阻断**，
  //       漂移可被检出且**实时优先**（若哪天有人拿留痕当判据，这条会红）。
  const ac35d = ac35led && ac35led.transferTrace
    ? {
        traceChainKey: ac35led.transferTrace.chainKey,
        traceUpstreamOrderNo: ac35led.transferTrace.upstreamOrderNo,
        traceUpstreamGateCode: ac35led.transferTrace.upstreamGateCode,
        liveChainKey: ac35led.chainKey,
        liveUpstreamOrderNo: ac35led.predecessorOrderNo,
        liveGateCode: ac35led.transferCode,
      }
    : null;
  check(
    'AC-035④ 漂移检测基线：建单当时的留痕 == 现在实时重算（链锚点 / 上游单号 / 判定码）',
    !!ac35d &&
      ac35d.traceChainKey === ac35d.liveChainKey &&
      ac35d.traceUpstreamOrderNo === ac35d.liveUpstreamOrderNo &&
      ac35d.traceUpstreamGateCode === ac35d.liveGateCode,
    ac35d
  );
  await q("UPDATE inspection_orders SET judgment = 'FAILED', status = 'FAILED' WHERE order_no = $1", [PREFIX + '-A35-IQC']);
  const ac35r2 = await traceRowOf(ac35No);
  const ac35led2 = ac35No ? await ledgerRow(ac35No) : null;
  check(
    'AC-035⑤ 上游事后判不合格：留痕不变（UPSTREAM_PASSED）而实时转阻断（UPSTREAM_FAILED）→ 漂移可检出、实时优先',
    !!ac35r2 &&
      !!ac35led2 &&
      ac35r2.upstream_gate_code === 'UPSTREAM_PASSED' &&
      ac35led2.transferCode === 'UPSTREAM_FAILED' &&
      ac35led2.canTransfer === false,
    ac35led2 && { trace: ac35r2.upstream_gate_code, live: ac35led2.transferCode, canTransfer: ac35led2.canTransfer }
  );

  // ================= AC-02：IQC 不合格（无 MRB）-> 阻断 + 留痕 =================
  await seedOrder({ orderNo: PREFIX + '-A2-IQC', type: 'IQC', batch: PREFIX + '-A2', status: 'FAILED', judgment: 'FAILED' });
  const ac02 = await createOrder({ inspectionType: 'IPQC_CT', materialCode: MATERIALS.BLANK.code, batchNo: PREFIX + '-A2', sampleQty: 5, totalQty: 100 });
  const ac02d = ac02.body && ac02.body.details ? ac02.body.details.transferDecision : null;
  check('AC-02 返回 422 且 code = transfer-blocked', ac02.status === 422 && ac02.body && ac02.body.code === 'transfer-blocked', { status: ac02.status, code: ac02.body && ac02.body.code });
  check('AC-02 理由码 = UPSTREAM_FAILED', ac02d && ac02d.code === 'UPSTREAM_FAILED', ac02d && { code: ac02d.code, reason: ac02d.reason });
  check('AC-02 blockedBy.orderNo = 上游 IQC 单（界面可直接指出被谁挡）', ac02.body && ac02.body.details && ac02.body.details.blockedBy && ac02.body.details.blockedBy.orderNo === PREFIX + '-A2-IQC', ac02.body && ac02.body.details && ac02.body.details.blockedBy);
  // 物理列口径：审计仓储把 resourceType / resourceId 分别落到 entity_name / entity_id（见 audit-log-repository.ts）
  const ac02Audit = await q("SELECT count(*)::int AS n FROM audit_logs WHERE action = 'GATE_BLOCKED' AND entity_name = 'INSPECTION_ORDER' AND entity_id = $1", [PREFIX + '-A2']);
  check('AC-02 审计留痕 GATE_BLOCKED（阻断不随事务回滚）', ac02Audit[0].n >= 1, ac02Audit[0]);
  const ac02Outbox = await q("SELECT count(*)::int AS n FROM outbox_events WHERE event_type = 'TRANSFER_BLOCKED' AND payload->>'batchNo' = $1", [PREFIX + '-A2']);
  check('AC-02 Outbox 留痕 TRANSFER_BLOCKED', ac02Outbox[0].n >= 1, ac02Outbox[0]);
  const ac02Orders = await q('SELECT count(*)::int AS n FROM inspection_orders WHERE batch_no = $1', [PREFIX + '-A2']);
  check('AC-02 被阻断的建单未落库（该批次只有夹具 1 行）', ac02Orders[0].n === 1, ac02Orders[0]);

  // ================= AC-03：IPQC_FN 合格/不合格 -> 委外 OQC_HEAT =================
  await seedOrder({ orderNo: PREFIX + '-A3-FN', type: 'IPQC_FN', batch: PREFIX + '-A3', material: MATERIALS.BOLT, status: 'COMPLETED', judgment: 'PASSED' });
  const ac03a = await createOrder({ inspectionType: 'OQC_HEAT', materialCode: MATERIALS.BOLT.code, batchNo: PREFIX + '-A3', sampleQty: 5, totalQty: 50, furnaceHeatNo: PREFIX + '-HT-A3' });
  check('AC-03① 成品检合格 -> 建委外 OQC_HEAT 201 + UPSTREAM_PASSED', ac03a.status === 201 && ac03a.body.transferDecision && ac03a.body.transferDecision.code === 'UPSTREAM_PASSED', { status: ac03a.status, decision: ac03a.body && ac03a.body.transferDecision });
  await seedOrder({ orderNo: PREFIX + '-A3B-FN', type: 'IPQC_FN', batch: PREFIX + '-A3B', material: MATERIALS.BOLT, status: 'FAILED', judgment: 'FAILED' });
  const ac03b = await createOrder({ inspectionType: 'OQC_HEAT', materialCode: MATERIALS.BOLT.code, batchNo: PREFIX + '-A3B', sampleQty: 5, totalQty: 50 });
  check('AC-03② 成品检不合格 -> 委外被阻断 422 UPSTREAM_FAILED', ac03b.status === 422 && codeOf(ac03b) === 'UPSTREAM_FAILED', { status: ac03b.status, code: codeOf(ac03b) });

  // ================= AC-04：委外 OQC_HEAT 合格/不合格 -> 出货 OQC_SH =================
  await seedOrder({ orderNo: PREFIX + '-A4-HT', type: 'OQC_HEAT', batch: PREFIX + '-A4', material: MATERIALS.BOLT, status: 'COMPLETED', judgment: 'PASSED' });
  const ac04a = await createOrder({ inspectionType: 'OQC_SH', materialCode: MATERIALS.BOLT.code, batchNo: PREFIX + '-A4', sampleQty: 5, totalQty: 50 });
  check('AC-04① 委外合格 -> 建出货检验 201 + UPSTREAM_PASSED', ac04a.status === 201 && codeOf(ac04a) === 'UPSTREAM_PASSED', { status: ac04a.status, decision: decisionOf(ac04a) });
  await seedOrder({ orderNo: PREFIX + '-A4B-HT', type: 'OQC_HEAT', batch: PREFIX + '-A4B', material: MATERIALS.BOLT, status: 'FAILED', judgment: 'FAILED' });
  const ac04b = await createOrder({ inspectionType: 'OQC_SH', materialCode: MATERIALS.BOLT.code, batchNo: PREFIX + '-A4B', sampleQty: 5, totalQty: 50 });
  check('AC-04② 委外不合格 -> 出货检验被阻断 422 UPSTREAM_FAILED', ac04b.status === 422 && codeOf(ac04b) === 'UPSTREAM_FAILED', { status: ac04b.status, code: codeOf(ac04b) });

  // ================= AC-05：上游仍在检验中 -> 阻断 =================
  await seedOrder({ orderNo: PREFIX + '-A5-IQC', type: 'IQC', batch: PREFIX + '-A5', status: 'INSPECTING' });
  const ac05 = await createOrder({ inspectionType: 'IPQC_CT', materialCode: MATERIALS.BLANK.code, batchNo: PREFIX + '-A5', sampleQty: 5, totalQty: 100 });
  check('AC-05 上游检验中 -> 422 UPSTREAM_INSPECTING（不得因「没有不合格」而放行）', ac05.status === 422 && codeOf(ac05) === 'UPSTREAM_INSPECTING', { status: ac05.status, code: codeOf(ac05) });

  // ================= AC-06：上游未建单 -> 放行但留痕（TBD-01） =================
  const ac06 = await createOrder({ inspectionType: 'IPQC_CT', materialCode: MATERIALS.BLANK.code, batchNo: PREFIX + '-A6', sampleQty: 5, totalQty: 100 });
  check('AC-06 上游缺失 -> 建单 201（放行不阻断）', ac06.status === 201, { status: ac06.status, body: ac06.status === 201 ? undefined : ac06.body });
  check('AC-06 但显式标记 code = UPSTREAM_MISSING（留痕）', ac06.status === 201 && codeOf(ac06) === 'UPSTREAM_MISSING', decisionOf(ac06));
  const ac06Row = ac06.status === 201 ? await ledgerRow(ac06.body.orderNo) : null;
  check('AC-06 台账行带 canTransfer=true + transferCode=UPSTREAM_MISSING（界面显示「上游环节缺失」）', ac06Row && ac06Row.canTransfer === true && ac06Row.transferCode === 'UPSTREAM_MISSING', ac06Row && { canTransfer: ac06Row.canTransfer, transferCode: ac06Row.transferCode, chainKey: ac06Row.chainKey });

  // ================= AC-07：不合格 + MRB 未结案 -> 阻断并给出 MRB 单号 =================
  await seedOrder({ orderNo: PREFIX + '-A7-IQC', type: 'IQC', batch: PREFIX + '-A7', status: 'IN_MRB_REVIEW', judgment: 'FAILED' });
  await seedMrb({ mrbNo: PREFIX + '-A7-MRB', sourceOrderNo: PREFIX + '-A7-IQC', batch: PREFIX + '-A7', status: 'UNDER_REVIEW', sourceType: 'INCOMING_FAIL' });
  const ac07 = await createOrder({ inspectionType: 'IPQC_CT', materialCode: MATERIALS.BLANK.code, batchNo: PREFIX + '-A7', sampleQty: 5, totalQty: 100 });
  check('AC-07 上游 MRB 评审中 -> 422 UPSTREAM_UNDER_MRB', ac07.status === 422 && codeOf(ac07) === 'UPSTREAM_UNDER_MRB', { status: ac07.status, code: codeOf(ac07) });
  check('AC-07 响应带 mrbNo', ac07.status === 422 && decisionOf(ac07) !== null && decisionOf(ac07).mrbNo === PREFIX + '-A7-MRB', decisionOf(ac07));

  // ================= AC-08：让步接收解锁（含节点回写、缺授权件不放行） =================
  const ac08Create = await createOrder({ inspectionType: 'IPQC_FN', materialCode: MATERIALS.BOLT.code, batchNo: PREFIX + '-A8', sampleQty: 5, totalQty: 60 });
  check('AC-08 前置：成品检建单 201（上游缺失按 TBD-01 放行留痕）', ac08Create.status === 201 && codeOf(ac08Create) === 'UPSTREAM_MISSING', { status: ac08Create.status, code: codeOf(ac08Create) });
  const ac08Fin = await post('/inspections/' + ac08Create.body.id + '/status', { status: 'FAILED', judgment: 'FAILED', failQty: 2, remark: 'P0 验收：成品检不合格' });
  check('AC-08 前置：终判不合格 200', ac08Fin.status === 200, { status: ac08Fin.status, body: ac08Fin.status === 200 ? undefined : ac08Fin.body });
  const ac08Mrb = await mrbOfOrder(ac08Create.body.orderNo);
  check('AC-08 前置：判不合格同事务自动建 MRB（不留人工环节）', ac08Mrb !== null, ac08Mrb && { mrbNo: ac08Mrb.mrb_no, status: ac08Mrb.status });
  const ac08NodeBefore = await nodeRowOf(PREFIX + '-A8');
  check('AC-08 前置：追溯节点已登记且状态 = FAILED', ac08NodeBefore !== null && ac08NodeBefore.node_status === 'FAILED', ac08NodeBefore);
  const ac08Pre = await createOrder({ inspectionType: 'OQC_SH', materialCode: MATERIALS.BOLT.code, batchNo: PREFIX + '-A8', sampleQty: 5, totalQty: 50 });
  check('AC-08 前置：MRB 未结案 -> 出货检验 422 UPSTREAM_UNDER_MRB', ac08Pre.status === 422 && codeOf(ac08Pre) === 'UPSTREAM_UNDER_MRB', { status: ac08Pre.status, code: codeOf(ac08Pre) });
  const ac08Dispose = await post('/mrb/records/' + ac08Mrb.id + '/disposition', {
    disposition: 'CONCESSION',
    dispositionReason: '客户书面同意让步接收（P0 验收）',
    concessionAttachmentUrl: 'https://letian-qms.local/attachments/' + PREFIX + '-A8-concession.pdf',
  });
  check('AC-08 前置：MRB 处置让步接收 200', ac08Dispose.status === 200, { status: ac08Dispose.status, body: ac08Dispose.status === 200 ? undefined : ac08Dispose.body });
  const ac08NodeAfter = await nodeRowOf(PREFIX + '-A8');
  check('AC-08③ 追溯节点状态由 FAILED 升为 CONCESSION（看板不再显示不合格）', ac08NodeAfter !== null && ac08NodeAfter.node_status === 'CONCESSION', { before: ac08NodeBefore && ac08NodeBefore.node_status, after: ac08NodeAfter && ac08NodeAfter.node_status });
  const ac08a = await createOrder({ inspectionType: 'OQC_SH', materialCode: MATERIALS.BOLT.code, batchNo: PREFIX + '-A8', sampleQty: 5, totalQty: 50 });
  check('AC-08① 让步接收（授权件在位）-> 出货检验 201 + 受限放行 UPSTREAM_CONCESSION', ac08a.status === 201 && codeOf(ac08a) === 'UPSTREAM_CONCESSION', { status: ac08a.status, decision: decisionOf(ac08a) });
  const ac08aEvidence = decisionOf(ac08a) ? decisionOf(ac08a).permitEvidence : null;
  check('AC-08① permitEvidence = MRB_CONCESSION 且 attachmentRequired = true（下游须可举证）', ac08aEvidence !== null && ac08aEvidence.kind === 'MRB_CONCESSION' && ac08aEvidence.attachmentRequired === true, ac08aEvidence);
  await q('UPDATE mrb_reviews SET concession_attachment_url = NULL WHERE mrb_no = $1', [ac08Mrb.mrb_no]);
  const ac08b = await createOrder({ inspectionType: 'OQC_SH', materialCode: MATERIALS.BOLT.code, batchNo: PREFIX + '-A8', sampleQty: 5, totalQty: 50 });
  check('AC-08② 清空客户授权件后 -> 仍 422（缺件即不解锁）', ac08b.status === 422 && codeOf(ac08b) === 'UPSTREAM_FAILED', { status: ac08b.status, code: codeOf(ac08b) });
  await q('UPDATE mrb_reviews SET concession_attachment_url = $2 WHERE mrb_no = $1', [ac08Mrb.mrb_no, 'https://letian-qms.local/attachments/' + PREFIX + '-A8-concession.pdf']);

  // ================= AC-09 / AC-10 / AC-18：返工 -> 复检 -> 解锁 =================
  const ac09Create = await createOrder({ inspectionType: 'IPQC_FN', materialCode: MATERIALS.BOLT.code, batchNo: PREFIX + '-A9', sampleQty: 5, totalQty: 60 });
  const ac09Fin = await post('/inspections/' + ac09Create.body.id + '/status', { status: 'FAILED', judgment: 'FAILED', failQty: 1, remark: 'P0 验收：返工分支前置' });
  const ac09Mrb = await mrbOfOrder(ac09Create.body.orderNo);
  check('AC-09 前置：MRB 已生成且未结案', ac09Fin.status === 200 && ac09Mrb !== null, ac09Mrb && { mrbNo: ac09Mrb.mrb_no, status: ac09Mrb.status });
  const ac09Dispose = await post('/mrb/records/' + ac09Mrb.id + '/disposition', { disposition: 'REWORK', dispositionReason: '返工后复检（P0 验收）' });
  check('AC-09 前置：MRB 处置返工 200 且返回复检单号', ac09Dispose.status === 200 && ac09Dispose.body !== null && typeof ac09Dispose.body === 'object' && typeof ac09Dispose.body.reinspectionOrderNo === 'string', { status: ac09Dispose.status, body: ac09Dispose.status === 200 ? undefined : ac09Dispose.body });
  const reinspectionNo = ac09Dispose.body && ac09Dispose.body.reinspectionOrderNo ? ac09Dispose.body.reinspectionOrderNo : null;
  const reinspectionRoundOk = typeof reinspectionNo === 'string' && /-R\d+$/.test(reinspectionNo);
  check('AC-18 复检单未被自身门禁自锁（必须建成功，且单号为 -R{n} 轮次口径）', reinspectionRoundOk, { reinspectionOrderNo: reinspectionNo, roundPattern: reinspectionRoundOk });
  const ac09Source = await orderRowOf(ac09Create.body.orderNo);
  check('AC-18 源单转入 RE_INSPECTING（返工轮次进行中）', ac09Source !== null && ac09Source.status === 'RE_INSPECTING', ac09Source);
  const ac09 = await createOrder({ inspectionType: 'OQC_SH', materialCode: MATERIALS.BOLT.code, batchNo: PREFIX + '-A9', sampleQty: 5, totalQty: 50 });
  check('AC-09 复检未终判 -> 422 UPSTREAM_REINSPECTING', ac09.status === 422 && codeOf(ac09) === 'UPSTREAM_REINSPECTING', { status: ac09.status, code: codeOf(ac09) });
  const reinspectionId = await orderIdOf(reinspectionNo);
  const ac10Fin = await post('/inspections/' + reinspectionId + '/status', { status: 'PASSED', judgment: 'PASSED', passQty: 5, remark: 'P0 验收：返工复检合格' });
  check('AC-10 前置：复检单终判合格 200', ac10Fin.status === 200, { status: ac10Fin.status, body: ac10Fin.status === 200 ? undefined : ac10Fin.body });
  const ac10 = await createOrder({ inspectionType: 'OQC_SH', materialCode: MATERIALS.BOLT.code, batchNo: PREFIX + '-A9', sampleQty: 5, totalQty: 50 });
  check('AC-10 复检合格 -> 201 + UPSTREAM_REWORK_PASSED', ac10.status === 201 && codeOf(ac10) === 'UPSTREAM_REWORK_PASSED', { status: ac10.status, decision: decisionOf(ac10) });
  check('AC-10 predecessorOrderNo = 复检单号（不是原单号）', ac10.status === 201 && decisionOf(ac10) !== null && decisionOf(ac10).predecessorOrderNo === reinspectionNo, { decision: decisionOf(ac10), expected: reinspectionNo });
  const ac10Source = await orderRowOf(ac09Create.body.orderNo);
  check('AC-10 源单随返工闭环归档 COMPLETED', ac10Source !== null && ac10Source.status === 'COMPLETED', ac10Source);

  // ================= AC-11：复检再判不合格 -> 不得放行 =================
  await seedOrder({ orderNo: PREFIX + '-A11-FN', type: 'IPQC_FN', batch: PREFIX + '-A11', material: MATERIALS.BOLT, status: 'FAILED', judgment: 'FAILED' });
  await seedOrder({ orderNo: PREFIX + '-A11-FN-R1', type: 'IPQC_FN', batch: PREFIX + '-A11', material: MATERIALS.BOLT, status: 'FAILED', judgment: 'FAILED', updatedAt: new Date() });
  await seedMrb({ mrbNo: PREFIX + '-A11-MRB', sourceOrderNo: PREFIX + '-A11-FN', batch: PREFIX + '-A11', material: MATERIALS.BOLT, status: 'DISPOSED', disposition: 'REWORK' });
  const ac11 = await createOrder({ inspectionType: 'OQC_SH', materialCode: MATERIALS.BOLT.code, batchNo: PREFIX + '-A11', sampleQty: 5, totalQty: 50 });
  check('AC-11 复检单再判不合格（无新结论）-> 422 UPSTREAM_FAILED', ac11.status === 422 && codeOf(ac11) === 'UPSTREAM_FAILED', { status: ac11.status, code: codeOf(ac11) });
  check('AC-11 权威上游 = 复检单（轮次最高者胜）', ac11.status === 422 && decisionOf(ac11) !== null && decisionOf(ac11).predecessorOrderNo === PREFIX + '-A11-FN-R1', decisionOf(ac11));
  const ac11Fin = await post('/inspections/' + (await orderIdOf(reinspectionNo)) + '/status', { status: 'FAILED', judgment: 'FAILED', failQty: 1, remark: 'P0 验收：返工复检再判不合格（真实链路）' });
  const ac11b = await createOrder({ inspectionType: 'OQC_SH', materialCode: MATERIALS.BOLT.code, batchNo: PREFIX + '-A9', sampleQty: 5, totalQty: 50 });
  const ac11bCode = codeOf(ac11b);
  check('AC-11（真实链路）复检再判不合格 -> 一律不放行（复检过一次不等于放行）', ac11Fin.status === 200 && ac11b.status === 422 && ['UPSTREAM_FAILED', 'UPSTREAM_UNDER_MRB'].includes(ac11bCode), { finalize: ac11Fin.status, create: ac11b.status, code: ac11bCode });

  // ================= AC-12 / AC-13：退货 / 报废 -> 整链终止 =================
  await seedOrder({ orderNo: PREFIX + '-A12-FN', type: 'IPQC_FN', batch: PREFIX + '-A12', material: MATERIALS.BOLT, status: 'FAILED', judgment: 'FAILED' });
  await seedOrder({ orderNo: PREFIX + '-A12-SH', type: 'OQC_SH', batch: PREFIX + '-A12', material: MATERIALS.BOLT, status: 'INSPECTING' });
  await seedMrb({ mrbNo: PREFIX + '-A12-MRB', sourceOrderNo: PREFIX + '-A12-FN', batch: PREFIX + '-A12', material: MATERIALS.BOLT, status: 'DISPOSED', disposition: 'RETURN_TO_VENDOR' });
  const ac12 = await createOrder({ inspectionType: 'OQC_SH', materialCode: MATERIALS.BOLT.code, batchNo: PREFIX + '-A12', sampleQty: 5, totalQty: 50 });
  check('AC-12① 退货 -> 422 CHAIN_TERMINATED 且 terminateChain = true', ac12.status === 422 && codeOf(ac12) === 'CHAIN_TERMINATED' && decisionOf(ac12) !== null && decisionOf(ac12).terminateChain === true, { status: ac12.status, decision: decisionOf(ac12) });
  const ac12Row = await ledgerRow(PREFIX + '-A12-SH');
  check('AC-12② 已建未终判单被标记冻结（台账 canTransfer=false + transferCode=CHAIN_TERMINATED）', ac12Row !== null && ac12Row.canTransfer === false && ac12Row.transferCode === 'CHAIN_TERMINATED', ac12Row && { canTransfer: ac12Row.canTransfer, transferCode: ac12Row.transferCode, blockedBy: ac12Row.blockedBy });
  const ac12Kept = await orderRowOf(PREFIX + '-A12-SH');
  check('AC-12② 冻结不删除、不改写原状态（仍存在且仍为 INSPECTING）', ac12Kept !== null && ac12Kept.status === 'INSPECTING', ac12Kept);
  const ac12Outbox = await q("SELECT count(*)::int AS n FROM outbox_events WHERE event_type = 'CHAIN_TERMINATED' AND payload->>'batchNo' = $1", [PREFIX + '-A12']);
  check('AC-12③ Outbox 有 CHAIN_TERMINATED', ac12Outbox[0].n >= 1, ac12Outbox[0]);

  await seedOrder({ orderNo: PREFIX + '-A13-FN', type: 'IPQC_FN', batch: PREFIX + '-A13', material: MATERIALS.BOLT, status: 'FAILED', judgment: 'FAILED' });
  await seedMrb({ mrbNo: PREFIX + '-A13-MRB', sourceOrderNo: PREFIX + '-A13-FN', batch: PREFIX + '-A13', material: MATERIALS.BOLT, status: 'DISPOSED', disposition: 'SCRAP' });
  const ac13 = await createOrder({ inspectionType: 'OQC_SH', materialCode: MATERIALS.BOLT.code, batchNo: PREFIX + '-A13', sampleQty: 5, totalQty: 50 });
  check('AC-13 报废 -> 与退货同构：422 CHAIN_TERMINATED + terminateChain', ac13.status === 422 && codeOf(ac13) === 'CHAIN_TERMINATED' && decisionOf(ac13) !== null && decisionOf(ac13).terminateChain === true, { status: ac13.status, decision: decisionOf(ac13) });

  // AC-12（真实回写链路）：MRB 处置退货时，把该链路下游已建未终判单冻结并留痕
  const ac12cCreate = await createOrder({ inspectionType: 'IPQC_FN', materialCode: MATERIALS.BOLT.code, batchNo: PREFIX + '-A12C', sampleQty: 5, totalQty: 60 });
  await post('/inspections/' + ac12cCreate.body.id + '/status', { status: 'FAILED', judgment: 'FAILED', failQty: 1, remark: 'P0 验收：链路终止回写前置' });
  const ac12cMrb = await mrbOfOrder(ac12cCreate.body.orderNo);
  await seedOrder({ orderNo: PREFIX + '-A12C-SH', type: 'OQC_SH', batch: PREFIX + '-A12C', material: MATERIALS.BOLT, status: 'INSPECTING' });
  const ac12cDispose = await post('/mrb/records/' + ac12cMrb.id + '/disposition', { disposition: 'RETURN_TO_VENDOR', dispositionReason: '整链退货（P0 验收：回写冻结）' });
  const ac12cFrozenAudit = await q("SELECT count(*)::int AS n FROM audit_logs WHERE action = 'STATUS_CHANGE' AND diff_patch->>'frozen' = 'true' AND diff_patch->>'mrbNo' = $1", [ac12cMrb.mrb_no]);
  const ac12cOutbox = await q("SELECT count(*)::int AS n FROM outbox_events WHERE event_type = 'CHAIN_TERMINATED' AND payload->>'mrbNo' = $1", [ac12cMrb.mrb_no]);
  check('AC-12②（真实回写）MRB 判退货 -> 下游未终判单被冻结且留痕（审计 frozen=true）', ac12cDispose.status === 200 && ac12cFrozenAudit[0].n >= 1, { dispose: ac12cDispose.status, frozenAuditRows: ac12cFrozenAudit[0].n });
  check('AC-12③（真实回写）Outbox CHAIN_TERMINATED 带 frozenOrderNos', ac12cOutbox[0].n >= 1, ac12cOutbox[0]);

  // ================= AC-16：同批次同环节多张单 -> 取最近一次终判 =================
  await seedOrder({ orderNo: PREFIX + '-A16-IQC-OLD', type: 'IQC', batch: PREFIX + '-A16', status: 'FAILED', judgment: 'FAILED', updatedAt: new Date(Date.now() - 3 * 3600e3) });
  await seedOrder({ orderNo: PREFIX + '-A16-IQC-MID', type: 'IQC', batch: PREFIX + '-A16', status: 'FAILED', judgment: 'FAILED', updatedAt: new Date(Date.now() - 2 * 3600e3) });
  await seedOrder({ orderNo: PREFIX + '-A16-IQC-NEW', type: 'IQC', batch: PREFIX + '-A16', status: 'COMPLETED', judgment: 'PASSED', updatedAt: new Date(Date.now() - 1 * 3600e3) });
  const ac16a = await createOrder({ inspectionType: 'IPQC_CT', materialCode: MATERIALS.BLANK.code, batchNo: PREFIX + '-A16', sampleQty: 5, totalQty: 100 });
  check('AC-16① 最近一次终判合格 -> 放行，且上游取最新那张', ac16a.status === 201 && ac16a.body.transferDecision.code === 'UPSTREAM_PASSED' && ac16a.body.transferDecision.predecessorOrderNo === PREFIX + '-A16-IQC-NEW', { status: ac16a.status, decision: ac16a.body && ac16a.body.transferDecision });
  await seedOrder({ orderNo: PREFIX + '-A16-IQC-NEW', type: 'IQC', batch: PREFIX + '-A16', status: 'FAILED', judgment: 'FAILED', updatedAt: new Date() });
  const ac16b = await createOrder({ inspectionType: 'IPQC_CT', materialCode: MATERIALS.BLANK.code, batchNo: PREFIX + '-A16', sampleQty: 5, totalQty: 100 });
  check('AC-16② 反转（最近一张不合格）-> 阻断，且仍取最新那张', ac16b.status === 422 && ac16b.body.details.transferDecision.code === 'UPSTREAM_FAILED' && ac16b.body.details.transferDecision.predecessorOrderNo === PREFIX + '-A16-IQC-NEW', { status: ac16b.status, decision: ac16b.body && ac16b.body.details && ac16b.body.details.transferDecision });
  const ac16Ordering = await q('SELECT order_no, created_at, updated_at FROM inspection_orders WHERE batch_no = $1 ORDER BY created_at ASC', [PREFIX + '-A16']);
  check('AC-16 结果与 created_at 升序无关（最早一张是 OLD=更早的判定，未被取用）', ac16Ordering.length >= 3 && ac16Ordering[0].order_no === PREFIX + '-A16-IQC-OLD', ac16Ordering.map((r) => r.order_no));

  // ================= AC-17：出货检验不合格 -> 放行关卡 409 =================
  await seedOrder({ orderNo: PREFIX + '-A17-SH', type: 'OQC_SH', batch: PREFIX + '-A17', material: MATERIALS.BOLT, status: 'FAILED', judgment: 'FAILED' });
  const ac17 = await httpJson('/release-gates/' + PREFIX + '-A17', { headers: authed() });
  check('AC-17 出货检验不合格 -> 关卡 409 problem+json，code = gate-failed', ac17.status === 409 && ac17.body && ac17.body.code === 'gate-failed', { status: ac17.status, code: ac17.body && ac17.body.code, contentType: ac17.body && ac17.body.type });
  check('AC-17 同时下发 gateCode = UPSTREAM_FAILED（与传递门禁同源）', ac17.body && ac17.body.gateCode === 'UPSTREAM_FAILED', ac17.body && { gateCode: ac17.body.gateCode, detail: ac17.body.detail });
  const ac17Audit = await q("SELECT count(*)::int AS n FROM audit_logs WHERE action = 'GATE_BLOCKED' AND entity_name = 'RELEASE_GATE' AND entity_id = $1", [PREFIX + '-A17']);
  check('AC-17 关卡阻断留痕（审计 GATE_BLOCKED 不再随异常回滚）', ac17Audit[0].n >= 1, ac17Audit[0]);
  // 对照组：同一套关卡在「全链合格」时必须放行（否则 409 只是「一律拦」的假象）
  await seedOrder({ orderNo: PREFIX + '-A17P-HT', type: 'OQC_HEAT', batch: PREFIX + '-A17P', material: MATERIALS.BOLT, status: 'COMPLETED', judgment: 'PASSED', updatedAt: new Date(Date.now() - 3600e3) });
  await seedOrder({ orderNo: PREFIX + '-A17P-SH', type: 'OQC_SH', batch: PREFIX + '-A17P', material: MATERIALS.BOLT, status: 'COMPLETED', judgment: 'PASSED' });
  const ac17Pass = await httpJson('/release-gates/' + PREFIX + '-A17P', { headers: authed() });
  check('AC-17（对照）全链合格（委外合格 + 出货合格）时关卡放行 200 + gateCode = UPSTREAM_PASSED', ac17Pass.status === 200 && ac17Pass.body.gateCode === 'UPSTREAM_PASSED' && ac17Pass.body.releaseScope === 'STANDARD', { status: ac17Pass.status, gateCode: ac17Pass.body && ac17Pass.body.gateCode, releaseScope: ac17Pass.body && ac17Pass.body.releaseScope });

  // ================= AC-19：并发一致性 =================
  await seedOrder({ orderNo: PREFIX + '-A19-IQC', type: 'IQC', batch: PREFIX + '-A19', status: 'FAILED', judgment: 'FAILED' });
  const ac19Parallel = await Promise.all([
    createOrder({ inspectionType: 'IPQC_CT', materialCode: MATERIALS.BLANK.code, batchNo: PREFIX + '-A19', sampleQty: 5, totalQty: 100 }),
    createOrder({ inspectionType: 'IPQC_CT', materialCode: MATERIALS.BLANK.code, batchNo: PREFIX + '-A19', sampleQty: 5, totalQty: 100 }),
    createOrder({ inspectionType: 'IPQC_CT', materialCode: MATERIALS.BLANK.code, batchNo: PREFIX + '-A19', sampleQty: 5, totalQty: 100 }),
  ]);
  const ac19Codes = ac19Parallel.map((r) => (r.body && r.body.details ? r.body.details.transferDecision.code : null));
  const ac19OrderNos = ac19Parallel.map((r) => (r.body && r.body.details ? r.body.details.blockedBy.orderNo : null));
  check('AC-19 并发 3 张建单结论一致（全部 422 同一理由码与同一上游单）', ac19Parallel.every((r) => r.status === 422) && new Set(ac19Codes).size === 1 && new Set(ac19OrderNos).size === 1, { codes: ac19Codes, upstream: ac19OrderNos });
  const ac19Rows = await q('SELECT count(*)::int AS n FROM inspection_orders WHERE batch_no = $1', [PREFIX + '-A19']);
  check('AC-19 并发下无部分写入（该批次只有夹具 1 行）', ac19Rows[0].n === 1, ac19Rows[0]);
  const ac19PassParallel = await Promise.all([
    createOrder({ inspectionType: 'IPQC_CT', materialCode: MATERIALS.BLANK.code, batchNo: PREFIX + '-A1', sampleQty: 5, totalQty: 100 }),
    createOrder({ inspectionType: 'IPQC_CT', materialCode: MATERIALS.BLANK.code, batchNo: PREFIX + '-A1', sampleQty: 5, totalQty: 100 }),
  ]);
  const ac19NoDup = new Set(ac19PassParallel.map((r) => (r.body ? r.body.orderNo : null)));
  check('AC-19 并发放行场景：两单均 201 且单号不重复（尾号流水不撞号）', ac19PassParallel.every((r) => r.status === 201) && ac19NoDup.size === 2, { statuses: ac19PassParallel.map((r) => r.status), orderNos: [...ac19NoDup] });

  // ================= AC-P2：豁免审批流（一单一核销，docs/48 §7 TBD-09 / §8 P2） =================
  // 前置：批次 -P2A 上游 IQC 不合格（无 MRB）-> 下游建单按 UPSTREAM_FAILED 阻断（豁免通道的靶场景）
  await seedOrder({ orderNo: PREFIX + '-P2A-IQC', type: 'IQC', batch: PREFIX + '-P2A', material: MATERIALS.BLANK, status: 'FAILED', judgment: 'FAILED' });
  const p2aBlocked = await createOrder({ inspectionType: 'IPQC_CT', materialCode: MATERIALS.BLANK.code, batchNo: PREFIX + '-P2A', sampleQty: 5, totalQty: 100 });
  check('AC-P2-01 前置：上游不合格 -> 建单 422 UPSTREAM_FAILED', p2aBlocked.status === 422 && codeOf(p2aBlocked) === 'UPSTREAM_FAILED', { status: p2aBlocked.status, code: codeOf(p2aBlocked) });

  const p2aTicket = await post('/inspections/transfer-overrides/tickets', {
    batchNo: PREFIX + '-P2A', materialCode: MATERIALS.BLANK.code, inspectionType: 'IPQC_CT',
    reason: '客户紧急试制批次，质量负责人特批放行（P0 验收夹具）', applicantId: OPERATOR_ID,
  });
  check('AC-P2-02 提报豁免申请单 -> 201 + status = PENDING', p2aTicket.status === 201 && p2aTicket.body !== null && p2aTicket.body.status === 'PENDING' && typeof p2aTicket.body.ticketNo === 'string', { status: p2aTicket.status, body: p2aTicket.body });
  const p2aTicketNo = p2aTicket.body && p2aTicket.body.ticketNo;

  const p2aEarly = await createOrder({ inspectionType: 'IPQC_CT', materialCode: MATERIALS.BLANK.code, batchNo: PREFIX + '-P2A', sampleQty: 5, totalQty: 100,
    transferOverride: { reason: 'P0 验收：PENDING 核销应被拒', approverId: OPERATOR_ID, ticketNo: p2aTicketNo } });
  check('AC-P2-03 PENDING 申请单核销建单 -> 422（非 APPROVED 不可核销）', p2aEarly.status === 422, { status: p2aEarly.status, body: p2aEarly.body });

  const p2aReview = await post('/inspections/transfer-overrides/tickets/' + encodeURIComponent(p2aTicketNo) + '/review', {
    action: 'APPROVE', reviewerId: OPERATOR_ID, reviewNotes: '同意放行（P0 验收夹具）', approvalDocNo: 'QA-OVR-' + PREFIX + '-001',
  });
  check('AC-P2-04 审批 APPROVE -> status = APPROVED', p2aReview.status === 200 && p2aReview.body && p2aReview.body.status === 'APPROVED', { status: p2aReview.status, body: p2aReview.body });

  const p2aOrder = await createOrder({ inspectionType: 'IPQC_CT', materialCode: MATERIALS.BLANK.code, batchNo: PREFIX + '-P2A', sampleQty: 5, totalQty: 100,
    transferOverride: { reason: '客户紧急试制批次，质量负责人特批放行', approverId: OPERATOR_ID, ticketNo: p2aTicketNo, approvalDocNo: 'QA-OVR-' + PREFIX + '-001' } });
  check('AC-P2-05 豁免建单 -> 201（门禁阻断被特批放行）', p2aOrder.status === 201, { status: p2aOrder.status, body: p2aOrder.status === 201 ? undefined : p2aOrder.body });
  const p2aOrderNo = p2aOrder.body && p2aOrder.body.orderNo;
  const p2aTrace = await q('SELECT upstream_gate_code, upstream_order_no, chain_key FROM inspection_orders WHERE order_no = $1', [p2aOrderNo]);
  check('AC-P2-05 留痕 upstream_gate_code = UPSTREAM_OVERRIDDEN 且上游单号指向被豁免的上游单', p2aTrace.length === 1 && p2aTrace[0].upstream_gate_code === 'UPSTREAM_OVERRIDDEN' && p2aTrace[0].upstream_order_no === PREFIX + '-P2A-IQC', p2aTrace[0]);
  const p2aTicketAfter = await q('SELECT status, consumed_order_no FROM transfer_override_tickets WHERE ticket_no = $1', [p2aTicketNo]);
  check('AC-P2-05 工单核销 -> CONSUMED 且 consumed_order_no = 新单号（一单一核销）', p2aTicketAfter.length === 1 && p2aTicketAfter[0].status === 'CONSUMED' && p2aTicketAfter[0].consumed_order_no === p2aOrderNo, p2aTicketAfter[0]);
  const p2aOutbox = await q("SELECT count(*)::int AS n FROM outbox_events WHERE event_type = 'TRANSFER_GATE_OVERRIDDEN' AND payload->>'orderNo' = $1", [p2aOrderNo]);
  check('AC-P2-06 Outbox TRANSFER_GATE_OVERRIDDEN（下游系统可订阅豁免事件）', p2aOutbox[0].n >= 1, p2aOutbox[0]);
  const p2aAudit = await q("SELECT count(*)::int AS n FROM audit_logs WHERE action = 'STATUS_CHANGE' AND diff_patch->>'orderNo' = $1 AND diff_patch->>'originalGateCode' = 'UPSTREAM_FAILED'", [p2aOrderNo]);
  check('AC-P2-06 审计留痕含原判定码与豁免原因（事后可解释为什么放行）', p2aAudit[0].n >= 1, p2aAudit[0]);

  // 读侧口径（2026-10-12 修复项）：特批放行的单在台账 / 预览上必须呈现为「已放行 · 特批豁免」，
  // 不能重算出建单当初那条 UPSTREAM_FAILED 阻断码 —— 否则现场看到的与实际放行状态自相矛盾。
  const p2aLedger = await ledgerRow(p2aOrderNo);
  check(
    'AC-P2-14 台账读侧：特批单 canTransfer=true + transferCode=UPSTREAM_OVERRIDDEN 且无 blockedBy',
    p2aLedger !== null &&
      p2aLedger.canTransfer === true &&
      p2aLedger.transferCode === 'UPSTREAM_OVERRIDDEN' &&
      (p2aLedger.blockedBy === undefined || p2aLedger.blockedBy === null),
    p2aLedger === null ? null : { canTransfer: p2aLedger.canTransfer, transferCode: p2aLedger.transferCode, blockedBy: p2aLedger.blockedBy }
  );
  const p2aPermit = await post('/inspections/transfer-permits', {
    items: [{ inspectionType: 'IPQC_CT', batchNo: PREFIX + '-P2A', materialCode: MATERIALS.BLANK.code, orderNo: p2aOrderNo }],
  });
  const p2aPermitDecision =
    p2aPermit.body && Array.isArray(p2aPermit.body.items) && p2aPermit.body.items[0]
      ? p2aPermit.body.items[0].decision
      : null;
  check(
    'AC-P2-14 传递许可预览与台账同口径（allowed=true + code=UPSTREAM_OVERRIDDEN）',
    p2aPermit.status === 200 && p2aPermitDecision !== null && p2aPermitDecision !== undefined &&
      p2aPermitDecision.allowed === true && p2aPermitDecision.code === 'UPSTREAM_OVERRIDDEN',
    p2aPermitDecision === null || p2aPermitDecision === undefined ? { status: p2aPermit.status } : { allowed: p2aPermitDecision.allowed, code: p2aPermitDecision.code }
  );
  check(
    'AC-P2-14 特批只解除建单那次阻断（仍如实回指被豁免的上游单与原判定）',
    p2aPermitDecision !== null && p2aPermitDecision !== undefined &&
      p2aPermitDecision.precedentStage === 'IQC' &&
      p2aPermitDecision.predecessorOrderNo === PREFIX + '-P2A-IQC',
    p2aPermitDecision === null || p2aPermitDecision === undefined ? null : { precedentStage: p2aPermitDecision.precedentStage, predecessorOrderNo: p2aPermitDecision.predecessorOrderNo }
  );

  const p2aReuse = await createOrder({ inspectionType: 'IPQC_CT', materialCode: MATERIALS.BLANK.code, batchNo: PREFIX + '-P2A', sampleQty: 5, totalQty: 100,
    transferOverride: { reason: 'P0 验收：已核销工单复用应被拒', approverId: OPERATOR_ID, ticketNo: p2aTicketNo } });
  check('AC-P2-07 CONSUMED 工单复用 -> 422（一单一核销硬约束）', p2aReuse.status === 422, { status: p2aReuse.status, body: p2aReuse.body });

  const p2bTicket = await post('/inspections/transfer-overrides/tickets', {
    batchNo: PREFIX + '-P2A', materialCode: MATERIALS.BLANK.code, inspectionType: 'IPQC_CT',
    reason: 'P0 验收：将被驳回的申请单', applicantId: OPERATOR_ID,
  });
  const p2bReject = await post('/inspections/transfer-overrides/tickets/' + encodeURIComponent(p2bTicket.body.ticketNo) + '/review', {
    action: 'REJECT', reviewerId: OPERATOR_ID, reviewNotes: '证据不足，驳回',
  });
  const p2bUse = await createOrder({ inspectionType: 'IPQC_CT', materialCode: MATERIALS.BLANK.code, batchNo: PREFIX + '-P2A', sampleQty: 5, totalQty: 100,
    transferOverride: { reason: 'P0 验收：被驳回工单核销应被拒', approverId: OPERATOR_ID, ticketNo: p2bTicket.body && p2bTicket.body.ticketNo } });
  check('AC-P2-08 REJECTED 申请单不可核销 -> 422', p2bReject.status === 200 && p2bUse.status === 422, { review: p2bReject.status, create: p2bUse.status });

  const p2cTicket = await post('/inspections/transfer-overrides/tickets', {
    batchNo: PREFIX + '-P2C', materialCode: MATERIALS.BLANK.code, inspectionType: 'IPQC_CT',
    reason: 'P0 验收：开给别的批次的豁免单', applicantId: OPERATOR_ID,
  });
  await post('/inspections/transfer-overrides/tickets/' + encodeURIComponent(p2cTicket.body.ticketNo) + '/review', {
    action: 'APPROVE', reviewerId: OPERATOR_ID,
  });
  const p2cUse = await createOrder({ inspectionType: 'IPQC_CT', materialCode: MATERIALS.BLANK.code, batchNo: PREFIX + '-P2A', sampleQty: 5, totalQty: 100,
    transferOverride: { reason: 'P0 验收：挪用别批工单应被拒', approverId: OPERATOR_ID, ticketNo: p2cTicket.body && p2cTicket.body.ticketNo } });
  check('AC-P2-09 豁免单目标批次不匹配 -> 422（批次/物料/类型三元组绑定，不可挪用）', p2cUse.status === 422, { status: p2cUse.status, body: p2cUse.body });

  // ================= AC-P2：下游冻结批处理（docs/48 §4.8 / TBD-06 / §8 P2②） =================
  await seedOrder({ orderNo: PREFIX + '-P2F-FN', type: 'IPQC_FN', batch: PREFIX + '-P2F', material: MATERIALS.BOLT, status: 'FAILED', judgment: 'FAILED' });
  await seedOrder({ orderNo: PREFIX + '-P2F-SH', type: 'OQC_SH', batch: PREFIX + '-P2F', material: MATERIALS.BOLT, status: 'INSPECTING' });
  await seedMrb({ mrbNo: PREFIX + '-P2F-MRB', sourceOrderNo: PREFIX + '-P2F-FN', batch: PREFIX + '-P2F', material: MATERIALS.BOLT, status: 'DISPOSED', disposition: 'SCRAP' });

  const p2fDry = await post('/inspections/batch-freeze-terminated-chains', { dryRun: true, batchNo: PREFIX + '-P2F' });
  const p2fDryHit = p2fDry.body && Array.isArray(p2fDry.body.frozenOrders) && p2fDry.body.frozenOrders.some((o) => o.orderNo === PREFIX + '-P2F-SH');
  const p2fNotesBefore = await q('SELECT inspection_notes FROM inspection_orders WHERE order_no = $1', [PREFIX + '-P2F-SH']);
  check('AC-P2-10 dryRun=true 命中在途下游单但不写备注（预演零副作用）', p2fDry.status === 200 && p2fDryHit && (p2fNotesBefore[0].inspection_notes === null || !String(p2fNotesBefore[0].inspection_notes).includes('链路已终止')), { status: p2fDry.status, hit: p2fDryHit, notes: p2fNotesBefore[0] });

  const p2fRun = await post('/inspections/batch-freeze-terminated-chains', { batchNo: PREFIX + '-P2F' });
  const p2fAfter = await q('SELECT inspection_notes, status FROM inspection_orders WHERE order_no = $1', [PREFIX + '-P2F-SH']);
  const p2fAudit = await q("SELECT count(*)::int AS n FROM audit_logs WHERE action = 'STATUS_CHANGE' AND diff_patch->>'sourceMrbNo' = $1 AND diff_patch->>'frozen' = 'true'", [PREFIX + '-P2F-MRB']);
  check('AC-P2-11 执行冻结 -> 备注含链终止标记且单据状态不变（仍 INSPECTING，冻结不删除不改状态）', p2fRun.status === 200 && String(p2fAfter[0].inspection_notes || '').includes('链路已终止') && p2fAfter[0].status === 'INSPECTING', { status: p2fRun.status, row: p2fAfter[0] });
  check('AC-P2-11 冻结审计 STATUS_CHANGE frozen = true（含来源 MRB 单号可溯源）', p2fAudit[0].n >= 1, p2fAudit[0]);

  const p2fAuditCount = p2fAudit[0].n;
  await post('/inspections/batch-freeze-terminated-chains', { batchNo: PREFIX + '-P2F' });
  const p2fTwice = await q('SELECT inspection_notes FROM inspection_orders WHERE order_no = $1', [PREFIX + '-P2F-SH']);
  const p2fAuditTwice = await q("SELECT count(*)::int AS n FROM audit_logs WHERE action = 'STATUS_CHANGE' AND diff_patch->>'sourceMrbNo' = $1 AND diff_patch->>'frozen' = 'true'", [PREFIX + '-P2F-MRB']);
  const p2fNoteCount = (String(p2fTwice[0].inspection_notes || '').match(/链路已终止/g) || []).length;
  check('AC-P2-12 幂等：重复执行不重复追加备注、不重复审计', p2fNoteCount === 1 && p2fAuditTwice[0].n === p2fAuditCount, { noteCount: p2fNoteCount, auditBefore: p2fAuditCount, auditAfter: p2fAuditTwice[0].n });

  // ================= AC-P2：传递链 KPI（GET /traceability/transfer-kpis，docs/48 §12.5） =================
  const p2kpi = await httpJson('/traceability/transfer-kpis', { headers: authed() });
  const kpi = p2kpi.body || {};
  check('AC-P2-13 KPI 接口 200 且聚合字段齐全（含 stageBreakdown / generatedAt）', p2kpi.status === 200 && typeof kpi.totalInspections === 'number' && typeof kpi.overridePassCount === 'number' && typeof kpi.blockedCount === 'number' && typeof kpi.averageBlockDurationHours === 'number' && kpi.stageBreakdown !== undefined && typeof kpi.generatedAt === 'string', { status: p2kpi.status });
  check('AC-P2-13 本探针贡献的豁免放行已计入（overridePassCount >= 1）', p2kpi.status === 200 && kpi.overridePassCount >= 1, { overridePassCount: kpi.overridePassCount });
  check('AC-P2-13 口径自洽：blockedCount <= totalInspections 且 blockRate ∈ [0,100]', p2kpi.status === 200 && kpi.blockedCount <= kpi.totalInspections && kpi.blockRate >= 0 && kpi.blockRate <= 100, { blockedCount: kpi.blockedCount, totalInspections: kpi.totalInspections, blockRate: kpi.blockRate });

  return null;
}

main()
  .then(async () => {
    const failed = results.filter((r) => !r.ok);
    console.log('=== 汇总：' + (results.length - failed.length) + '/' + results.length + ' 通过 ===');
    await purgeFixtures('运行后').catch(() => {});
    await client.end().catch(() => {});
    process.exit(failed.length === 0 ? 0 : 1);
  })
  .catch(async (error) => {
    console.error('探针异常终止：', error);
    await purgeFixtures('异常退出').catch(() => {});
    await client.end().catch(() => {});
    process.exit(2);
  });
