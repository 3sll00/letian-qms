/**
 * 炉批号数据关联链路验收（docs/47 §6：AC-01 ~ AC-06、AC-09、AC-11）。
 *
 * 用法（仓库根目录，需先起 API 与演示数据）：
 *   pnpm db:demo:heat-trace     # 播种带 TEST2609- 标记的演示单
 *   pnpm verify:heat-batch-trace
 *
 * 判据全部来自**真实 HTTP 响应 + 真实落库回读**，不做任何 Mock；
 * 演示单固定为 docs/47 §3.8 的三组：TEST-HT-2609-001 / -002 / -003。
 */
const API_BASE = process.env.API_BASE || 'http://127.0.0.1:3100/api/v1';

const DEMO = {
  l1Heat: 'TEST-HT-2609-001',
  l2Heat: 'TEST-HT-2609-002',
  noneHeat: 'TEST-HT-2609-003',
  boltMaterial: 'MAT-BLT-109-M10',
  alloyMaterial: 'MAT-35CRMO-08',
  newestHeatOrder: 'OQC-HT-20260923-9103',
  olderHeatOrders: ['OQC-HT-20260923-9101', 'OQC-HT-20260923-9102'],
  iqcOrder: 'IQC-20260923-9002',
  targetOrderNo: 'OQC-SH-20260923-9001',
  emptyTargetOrderNo: 'OQC-SH-20260923-9003',
};

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'} :: ${name}${detail === undefined ? '' : ' :: ' + JSON.stringify(detail)}`);
}

async function httpJson(path, options = {}) {
  const res = await fetch(`${API_BASE}${path}`, options);
  const text = await res.text();
  let body;
  try {
    body = text === '' ? null : JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: res.status, body };
}

let token = '';
const authed = (extra = {}) => ({ authorization: `Bearer ${token}`, ...extra });

async function trace(heatBatchNo, materialCode) {
  const qs = `heatBatchNo=${encodeURIComponent(heatBatchNo)}${
    materialCode === undefined || materialCode === '' ? '' : `&materialCode=${encodeURIComponent(materialCode)}`
  }`;
  return await httpJson(`/inspections/heat-batch-trace?${qs}`, { headers: authed() });
}

async function findOrderByNo(orderNo) {
  const res = await httpJson(`/inspections?orderNo=${encodeURIComponent(orderNo)}&pageSize=5`, {
    headers: authed(),
  });
  const rows = Array.isArray(res.body?.items) ? res.body.items : [];
  return rows.find((row) => row.orderNo === orderNo) ?? null;
}

(async () => {
  console.log(`--- 炉批号关联链路验收（API=${API_BASE}） ---`);
  const login = await httpJson('/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ userId: '11000000-0000-4000-8000-000000000001' }),
  });
  token = login.body?.token ?? '';
  if (token === '') {
    console.error('登录失败，无法继续：', login.status, login.body);
    process.exit(2);
  }

  // ---------- AC-01 / AC-02：L1 委外热处理命中且不与 IQC 混合 ----------
  const ac01 = await trace(DEMO.l1Heat, DEMO.boltMaterial);
  check('AC-01 该炉号存在委外热处理源单（HTTP 200）', ac01.status === 200, ac01.status);
  check(
    'AC-01 来源 = OUTSOURCE_HEAT_TREATMENT（Banner 显示「委外热处理」）',
    ac01.body?.sourceType === 'OUTSOURCE_HEAT_TREATMENT',
    ac01.body?.sourceType
  );
  check(
    'AC-01 源单号已回吐（界面可显示源单据）',
    typeof ac01.body?.sourceOrderNo === 'string' && ac01.body.sourceOrderNo !== '',
    ac01.body?.sourceOrderNo
  );
  check('AC-01 命中范围 = MATERIAL（同物料命中）', ac01.body?.matchScope === 'MATERIAL', ac01.body?.matchScope);

  const ac02Source = await findOrderByNo(ac01.body?.sourceOrderNo ?? '');
  check(
    'AC-02 命中单据确为 OQC_HEAT 类型（Banner 显示委外热处理）',
    ac02Source?.inspectionType === 'OQC_HEAT',
    ac02Source?.inspectionType
  );
  const iqcItems = (await findOrderByNo('IQC-20260923-9001'))?.items ?? [];
  const inheritedCodes = (ac01.body?.inheritedItems ?? []).map((it) => it.itemCode);
  const leaked = inheritedCodes.filter((code) => iqcItems.some((item) => item.itemCode === code));
  check('AC-02 L1 命中时不混入 L2（IQC）的指标项', leaked.length === 0, { inheritedCodes, leaked });

  // ---------- AC-05：同级别多张取最近一次终判 ----------
  check(
    'AC-05 同炉批号命中「最近一次终判」的那张（OQC-HT-20260923-9103）',
    ac01.body?.sourceOrderNo === DEMO.newestHeatOrder,
    { actual: ac01.body?.sourceOrderNo, expected: DEMO.newestHeatOrder }
  );
  check(
    'AC-05 未命中更早终判的两张',
    !DEMO.olderHeatOrders.includes(ac01.body?.sourceOrderNo ?? ''),
    ac01.body?.sourceOrderNo
  );

  // ---------- AC-06：归一化（大小写 / 空格 / 全角空格 / 连字符 / 下划线） ----------
  const variants = ['test-ht_2609-001', '  TEST-HT-2609-001  ', 'TEST　HT　2609　001', 'test ht 2609 001'];
  for (const variant of variants) {
    const res = await trace(variant, DEMO.boltMaterial);
    check(
      `AC-06 写法变体 [${variant}] 归一后命中同一源单`,
      res.status === 200 && res.body?.sourceOrderNo === ac01.body?.sourceOrderNo && res.body?.sourceType === ac01.body?.sourceType,
      { status: res.status, sourceOrderNo: res.body?.sourceOrderNo }
    );
  }

  // ---------- AC-03：只有 IQC 时的 L2 回退（并逐项核对带出值 = 源单实测值） ----------
  const ac03 = await trace(DEMO.l2Heat, DEMO.alloyMaterial);
  check('AC-03 来源 = IQC_RAW_MATERIAL（Banner 显示来料检验 IQC）', ac03.body?.sourceType === 'IQC_RAW_MATERIAL', ac03.body?.sourceType);
  check('AC-03 源单号已回吐', ac03.body?.sourceOrderNo === DEMO.iqcOrder, ac03.body?.sourceOrderNo);
  const iqcSource = await findOrderByNo(DEMO.iqcOrder);
  const sourceItems = new Map((iqcSource?.items ?? []).map((item) => [item.itemCode, item]));
  const mismatched = (ac03.body?.inheritedItems ?? []).filter((it) => {
    const source = sourceItems.get(it.itemCode);
    return source === undefined || source.measuredVal !== it.measuredVal;
  });
  check(
    'AC-03 带出的力学 / 化学成分实测值与源单逐项一致（且只带白名单项）',
    (ac03.body?.inheritedItems ?? []).length >= 3 && mismatched.length === 0,
    { inherited: (ac03.body?.inheritedItems ?? []).map((it) => `${it.itemCode}=${it.measuredVal}`), mismatched: mismatched.map((it) => it.itemCode) }
  );

  // ---------- AC-04：两处均无 -> 静默空态 ----------
  const ac04 = await trace(DEMO.noneHeat, DEMO.boltMaterial);
  check(
    'AC-04 查无记录时返回 NONE 且不带任何值、不报错（HTTP 200）',
    ac04.status === 200 && ac04.body?.sourceType === 'NONE' && (ac04.body?.inheritedItems ?? []).length === 0,
    { status: ac04.status, sourceType: ac04.body?.sourceType, items: (ac04.body?.inheritedItems ?? []).length }
  );

  // ---------- TBD-01：同炉异常提示（只提示、不带值、不阻断；docs/47 §3.9） ----------
  check(
    'TBD-01 组①（同炉 MRB 未结案）：带出照常 + UPSTREAM_UNDER_MRB 提示',
    ac01.body?.sourceType === 'OUTSOURCE_HEAT_TREATMENT' &&
      ac01.body?.upstreamWarning?.code === 'UPSTREAM_UNDER_MRB' &&
      (ac01.body?.upstreamWarning?.orderNos ?? []).includes('OQC-HT-20260923-9104'),
    ac01.body?.upstreamWarning
  );
  check(
    'TBD-01 带出成功时的提示文案说明「数据来自最近终判合格」（避免误读为直接可用的同炉数据）',
    /最近终判合格/.test(ac01.body?.upstreamWarning?.message ?? ''),
    ac01.body?.upstreamWarning?.message
  );

  const tbd01Failed = await trace('TEST-HT-2609-004', DEMO.boltMaterial);
  check(
    'TBD-01 组④（同炉不合格）：空态 NONE + UPSTREAM_FAILED 提示（HTTP 200、不带任何值）',
    tbd01Failed.status === 200 &&
      tbd01Failed.body?.sourceType === 'NONE' &&
      (tbd01Failed.body?.inheritedItems ?? []).length === 0 &&
      tbd01Failed.body?.upstreamWarning?.code === 'UPSTREAM_FAILED',
    {
      status: tbd01Failed.status,
      sourceType: tbd01Failed.body?.sourceType,
      items: (tbd01Failed.body?.inheritedItems ?? []).length,
      warning: tbd01Failed.body?.upstreamWarning,
    }
  );
  check(
    'TBD-01 不合格提示带出真实命中单 OQC-HT-20260923-9105，并说明未带出该炉数据',
    (tbd01Failed.body?.upstreamWarning?.orderNos ?? []).includes('OQC-HT-20260923-9105') &&
      /该炉批号上游存在不合格记录/.test(tbd01Failed.body?.upstreamWarning?.message ?? '') &&
      /未带出该炉数据/.test(tbd01Failed.body?.upstreamWarning?.message ?? ''),
    tbd01Failed.body?.upstreamWarning?.message
  );

  // 自单排除口径（前端录入页必须带 excludeOrderId）：
  // 不排除时，本单自身（检验中）会被判成「上游存在尚未终判的检验记录」——这是**假提示**；
  // 排除后同一炉号必须静默，否则组③「上游两处均无」的演示单会凭空冒出提示条。
  const tbd01Raw = await trace(DEMO.noneHeat, DEMO.boltMaterial);
  check(
    'TBD-01 未排除本单：本单自身（检验中）被判为上游未终判（印证界面必须带 excludeOrderId）',
    tbd01Raw.body?.upstreamWarning?.code === 'UPSTREAM_INSPECTING',
    tbd01Raw.body?.upstreamWarning
  );
  const noneRow = await findOrderByNo(DEMO.emptyTargetOrderNo);
  const tbd01Self = await httpJson(
    `/inspections/heat-batch-trace?heatBatchNo=${encodeURIComponent(DEMO.noneHeat)}${
      typeof noneRow?.id === 'string' ? `&excludeOrderId=${encodeURIComponent(noneRow.id)}` : ''
    }`,
    { headers: authed() }
  );
  check(
    'TBD-01 带 excludeOrderId 排除本单后：无异常炉号不返回任何提示（AC-04 静默空态不被污染）',
    tbd01Self.status === 200 &&
      tbd01Self.body?.upstreamWarning === undefined &&
      typeof noneRow?.id === 'string',
    { status: tbd01Self.status, warning: tbd01Self.body?.upstreamWarning, orderId: noneRow?.id ?? null }
  );

  // ---------- AC-11：表头字段落库 + 回读 + 台账列 ----------
  await findOrderByNo(DEMO.targetOrderNo); // 触发一次列表查询，确认目标单可见
  const target = await httpJson(`/inspections?orderNo=${encodeURIComponent(DEMO.targetOrderNo)}&pageSize=5`, { headers: authed() });
  const targetRow = (target.body?.items ?? []).find((row) => row.orderNo === DEMO.targetOrderNo) ?? null;
  check('AC-11 目标单可从台账查到（准备写表头）', targetRow !== null && typeof targetRow?.id === 'string');

  const headerPayload = {
    furnaceHeatNo: DEMO.l1Heat,
    materialGrade: 'ML40Cr',
    techStandard: 'GB/T 3098.1-2010',
    inspectedDate: '2026-09-23',
  };
  const patched = await httpJson(`/inspections/${encodeURIComponent(targetRow.id)}/header`, {
    method: 'PATCH',
    headers: authed({ 'content-type': 'application/json' }),
    body: JSON.stringify(headerPayload),
  });
  check('AC-11 PATCH /inspections/{id}/header 落库成功（HTTP 200）', patched.status === 200, patched.status);
  check(
    'AC-11 服务端重新解析带出源并落留痕（不接受前端自称来源）',
    patched.body?.sourceType === 'OUTSOURCE_HEAT_TREATMENT' && patched.body?.sourceOrderNo === DEMO.newestHeatOrder,
    { sourceType: patched.body?.sourceType, sourceOrderNo: patched.body?.sourceOrderNo }
  );

  const reopened = await httpJson(`/inspections/${encodeURIComponent(targetRow.id)}`, { headers: authed() });
  check(
    'AC-11 重开该单：炉号 / 材质 / 标准 / 检验日期已回显',
    reopened.body?.furnaceHeatNo === headerPayload.furnaceHeatNo &&
      reopened.body?.materialGrade === headerPayload.materialGrade &&
      reopened.body?.techStandard === headerPayload.techStandard &&
      reopened.body?.inspectedDate === headerPayload.inspectedDate,
    {
      furnaceHeatNo: reopened.body?.furnaceHeatNo,
      materialGrade: reopened.body?.materialGrade,
      techStandard: reopened.body?.techStandard,
      inspectedDate: reopened.body?.inspectedDate,
    }
  );
  check(
    'AC-11 溯源留痕已落库（heatSourceType / heatSourceOrderNo）',
    reopened.body?.heatSourceType === 'OUTSOURCE_HEAT_TREATMENT' &&
      reopened.body?.heatSourceOrderNo === DEMO.newestHeatOrder,
    { heatSourceType: reopened.body?.heatSourceType, heatSourceOrderNo: reopened.body?.heatSourceOrderNo }
  );
  const listed = await findOrderByNo(DEMO.targetOrderNo);
  check('AC-11 台账行「炉号」列取到真实字段（不再回落 batchNo）', listed?.furnaceHeatNo === headerPayload.furnaceHeatNo, listed?.furnaceHeatNo);

  // ---------- AC-09：清空炉批号 -> 留痕归零（服务端侧；界面回滚见 OqcRecordForm） ----------
  const cleared = await httpJson(`/inspections/${encodeURIComponent(targetRow.id)}/header`, {
    method: 'PATCH',
    headers: authed({ 'content-type': 'application/json' }),
    body: JSON.stringify({ furnaceHeatNo: '' }),
  });
  check('AC-09 清空炉批号返回 200', cleared.status === 200, cleared.status);
  const afterClear = await httpJson(`/inspections/${encodeURIComponent(targetRow.id)}`, { headers: authed() });
  check(
    'AC-09 清空后炉号为空且溯源留痕一并归零（不留上一炉的源单号）',
    (afterClear.body?.furnaceHeatNo === undefined || afterClear.body?.furnaceHeatNo === '') &&
      afterClear.body?.heatSourceType === undefined &&
      afterClear.body?.heatSourceOrderNo === undefined,
    {
      furnaceHeatNo: afterClear.body?.furnaceHeatNo,
      heatSourceType: afterClear.body?.heatSourceType,
      heatSourceOrderNo: afterClear.body?.heatSourceOrderNo,
    }
  );

  // 复位演示单：把炉号写回，便于界面演示（仍为 TEST 标记行，可被 db:test:purge 清掉）
  const restored = await httpJson(`/inspections/${encodeURIComponent(targetRow.id)}/header`, {
    method: 'PATCH',
    headers: authed({ 'content-type': 'application/json' }),
    body: JSON.stringify({ furnaceHeatNo: DEMO.l1Heat }),
  });
  check('AC-09 复位（写回炉批号）成功，演示单恢复可用状态', restored.status === 200, restored.status);

  const passed = results.filter((r) => r.ok).length;
  console.log(`\n[${passed === results.length ? 'PASS' : 'FAIL'}] 炉批号关联链路验收：${passed}/${results.length}`);
  process.exit(passed === results.length ? 0 : 1);
})().catch((err) => {
  console.error('验收脚本异常：', err);
  process.exit(2);
});
