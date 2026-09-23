/**
 * MRB 不合格品处置 —— 字段 / 契约 / API 打通验收（真实 PostgreSQL + 真实 HTTP）
 *
 * 覆盖 docs/21-MRB不合格品处置数据字段与接口打通设计.md §7 的验收口径：
 * 池表新增列回吐、发起评审四参数落库、池条目状态机回填、会签、特采凭证强制校验、
 * 处置响应形态（裸 MRBRecord）与闭环时间/裁决人落库；§11 的「返工处置响应回吐复检单标识」
 * （自建来源单走完整链路：建单 -> 越界判定 -> 自动入池并自动建 MRB 单（docs/43，无人工发起环节）
 *  -> REWORK 处置 -> 库内复检行逐字段核对）。
 *
 * 前置条件：
 *   1. 数据库已迁移到 019 且 `pnpm db:seed` 已执行（脚本按演示数据断言，末尾会还原）；
 *   2. 目标 API 已启动，地址用 MRB_WIRING_BASE 指定（默认 http://127.0.0.1:3101/api/v1）。
 *      注意：请勿把它指向 :3100 常驻实例，避免与人工操作相互干扰。
 *
 * 用法：
 *   pnpm run verify:mrb-wiring
 *   MRB_WIRING_BASE=http://127.0.0.1:3102/api/v1 node scripts/testing/mrb-wiring-verify.cjs
 *
 * 退出码 0 = 全部断言通过（当前 35 条）；非 0 = 存在 FAIL。
 */
const fs = require('node:fs');
const path = require('node:path');

const BASE = process.env.MRB_WIRING_BASE ?? 'http://127.0.0.1:3101/api/v1';
const DB =
  process.env.DATABASE_URL ??
  'postgresql://letian_user:letian_secure_pass_2026@127.0.0.1:5432/letian_qms_db';

/**
 * pg 依赖解析：仓库用 pnpm 隔离式 node_modules，scripts/ 不是工作区包，
 * 直接 require('pg') 在部分环境下解析不到，这里回退到 .pnpm 存储目录。
 */
function resolvePg() {
  try {
    return require('pg');
  } catch {
    const store = path.join(__dirname, '..', '..', 'node_modules', '.pnpm');
    const entry = fs
      .readdirSync(store)
      .filter((name) => name.startsWith('pg@'))
      .sort()
      .pop();
    if (entry === undefined) throw new Error('未找到 pg 依赖，无法执行数据库断言');
    return require(path.join(store, entry, 'node_modules', 'pg'));
  }
}

const { Client } = resolvePg();

let pass = 0;
let fail = 0;
/** 返工链路的清理回调：断言中途抛错时也要保证不把验收行留在库里（见末尾 catch） */
let reworkCleanup = null;
const check = (name, ok, extra) => {
  if (ok) {
    pass++;
    console.log('PASS :: ' + name + (extra !== undefined ? ' :: ' + JSON.stringify(extra) : ''));
  } else {
    fail++;
    console.log('FAIL :: ' + name + ' :: ' + JSON.stringify(extra));
  }
};

(async () => {
  const db = new Client({ connectionString: DB });
  await db.connect();
  const login = await fetch(BASE + '/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
  const { token } = await login.json();
  const H = { authorization: 'Bearer ' + token, 'content-type': 'application/json' };
  const req = async (method, reqPath, body) => {
    const r = await fetch(BASE + reqPath, {
      method,
      headers: H,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    let parsed = null;
    try {
      parsed = await r.json();
    } catch {}
    return { status: r.status, body: parsed };
  };

  // 1. 池字段全量：015 新增列必须能一路回吐到接口
  const pool = await req('GET', '/mrb/pending-pool?status=PENDING_INITIATE&page=1&pageSize=20');
  const item = (pool.body.items ?? [])[0];
  check('GET /mrb/pending-pool 待发起评审', pool.status === 200 && pool.body.total >= 1, {
    total: pool.body.total,
  });
  check('池条目含供应商', item?.supplierName === '广州发黑厂', { supplierName: item?.supplierName });
  check('池条目含不合格指标项', item?.defectItemCode === 'COA-001', {
    defectItemCode: item?.defectItemCode,
  });
  check('池条目含检验人', item?.inspectorName === '李检验', { inspectorName: item?.inspectorName });
  check('池条目含受检数量与不良率', item?.totalQty === 200 && item?.defectRate === 12.5, {
    totalQty: item?.totalQty,
    defectRate: item?.defectRate,
  });

  // 1.5 池 PBAC 三维行级权限随查询下推 SQL（docs/21 §9 遗留 1 闭环验证）
  //     期望值一律从库内实际分布推导，不写死种子条数，避免种子调整后断言失真。
  const categoryRows = (
    await db.query(
      'select m.category_code as cat, count(*)::int as n ' +
        'from pending_mrb_items p left join materials m on m.material_code = p.material_code ' +
        'group by 1'
    )
  ).rows;
  const poolTotal = categoryRows.reduce((sum, row) => sum + row.n, 0);
  const countOfCategories = (cats) =>
    categoryRows
      .filter((row) => row.cat !== null && cats.includes(row.cat))
      .reduce((sum, row) => sum + row.n, 0);
  const codesOfCategories = async (cats) =>
    (
      await db.query(
        'select p.material_code as code from pending_mrb_items p ' +
          'join materials m on m.material_code = p.material_code ' +
          'where m.category_code = any($1) order by p.material_code',
        [cats]
      )
    ).rows.map((row) => row.code);

  // JWT 只带 userId，PBAC 规则由服务端按 userId 现场查库，所以换身份只需换登录入参
  const asUser = async (userId, reqPath) => {
    const loginRes = await fetch(BASE + '/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userId }),
    });
    const { token: userToken } = await loginRes.json();
    const r = await fetch(BASE + reqPath, {
      headers: { authorization: 'Bearer ' + userToken },
    });
    return { status: r.status, body: await r.json().catch(() => null) };
  };

  // 张强：QA_MANAGER + 三维全通配规则 -> 全量放行
  const wildcardPool = await asUser(
    '11000000-0000-4000-8000-000000000001',
    '/mrb/pending-pool?page=1&pageSize=100'
  );
  check(
    '池 PBAC 全通配（张强）可见全部条目',
    wildcardPool.body.total === poolTotal && wildcardPool.body.items.length === poolTotal,
    { total: wildcardPool.body.total, expect: poolTotal }
  );

  // 刘芳：分类白名单 ['CAT-FINISH','CAT-FIN-BOLT','CAT-FIN-MACH']，无编码/供应商限定
  // -> 分类维度必须经 materials.category_code 子查询换算后下推 SQL
  const liuCategories = ['CAT-FINISH', 'CAT-FIN-BOLT', 'CAT-FIN-MACH'];
  const liuExpected = countOfCategories(liuCategories);
  const liuExpectedCodes = (await codesOfCategories(liuCategories)).sort();
  const liuPool = await asUser(
    '11000000-0000-4000-8000-000000000003',
    '/mrb/pending-pool?page=1&pageSize=100'
  );
  check(
    '池 PBAC 分类维度下推（刘芳：成品件分类白名单）',
    liuPool.body.total === liuExpected &&
      liuExpected > 0 &&
      liuExpected < poolTotal &&
      JSON.stringify(liuPool.body.items.map((i) => i.materialCode).sort()) ===
        JSON.stringify(liuExpectedCodes),
    {
      total: liuPool.body.total,
      expectTotal: liuExpected,
      codes: liuPool.body.items.map((i) => i.materialCode),
      expectCodes: liuExpectedCodes,
    }
  );

  // 过滤口径必须同时约束 total：翻到只够一页之外时应回空页但仍报全量命中数
  const liuPage2 = await asUser(
    '11000000-0000-4000-8000-000000000003',
    '/mrb/pending-pool?page=2&pageSize=1'
  );
  check(
    '池 PBAC 过滤后 total 与当页数据同口径',
    liuPage2.body.total === liuExpected &&
      liuPage2.body.items.length === Math.max(0, liuExpected - 1),
    { total: liuPage2.body.total, expectTotal: liuExpected, pageItems: liuPage2.body.items.length }
  );

  // 陈静：规则三维同时限定分类/编码/供应商，而池表没有供应商编码列。
  // 限定供应商的规则不得被放宽成"分类命中即可见"（fail-closed），否则会横向越权。
  const chenJingPool = await asUser(
    '11000000-0000-4000-8000-000000000008',
    '/mrb/pending-pool?page=1&pageSize=100'
  );
  check(
    '池 PBAC 供应商维度 fail-closed（陈静）',
    chenJingPool.body.total === 0 && chenJingPool.body.items.length === 0,
    { total: chenJingPool.body.total }
  );

  // 王建国：唯一规则 is_active=false -> 无生效规则 -> fail-closed 拒绝一切
  const wangPool = await asUser(
    '11000000-0000-4000-8000-000000000004',
    '/mrb/pending-pool?page=1&pageSize=100'
  );
  check('池 PBAC 无生效规则 fail-closed（王建国）', wangPool.body.total === 0, {
    total: wangPool.body.total,
  });

  // 旧状态词表（004 建表口径）不再兼容：契约只收口三态，旧值必须 400 而不是静默映射
  const legacyStatus = await req('GET', '/mrb/pending-pool?status=PENDING_REVIEW&page=1&pageSize=20');
  check('池旧状态别名不再兼容（PENDING_REVIEW -> 400）', legacyStatus.status === 400, {
    status: legacyStatus.status,
    code: legacyStatus.body?.code,
  });

  // 2. 环节前缀匹配（IPQC -> IPQC_CT / IPQC_FN）
  const ipqc = await req('GET', '/mrb/pending-pool?stage=IPQC&page=1&pageSize=20');
  check(
    '环节前缀筛选 IPQC 命中多段编码',
    ipqc.body.total >= 2 && (ipqc.body.items ?? []).every((i) => i.inspectionType.startsWith('IPQC')),
    { total: ipqc.body.total, types: (ipqc.body.items ?? []).map((i) => i.inspectionType) }
  );

  // 3. MRB 列表新字段 + 派生检验人
  //    「派生检验人」由 source_order_no 关联 inspection_orders 带出；列表窗口里可能混入其它用例 /
  //    探针跑完后遗留的「源单已删」历史行（派生值天然为空），所以断言口径按库内可回溯的那条评审
  //    工单对齐，而不是赌列表前 N 条。
  const recs = await req('GET', '/mrb/records?page=1&pageSize=100');
  const traceableMrb = (
    await db.query(
      `select m.mrb_no, io.inspector_name
         from mrb_reviews m
         join inspection_orders io on io.order_no = m.source_order_no
        where io.inspector_name is not null
        order by m.created_at desc
        limit 1`
    )
  ).rows[0];
  const tracedItem = (recs.body.items ?? []).find((r) => r.mrbNo === traceableMrb?.mrb_no);
  check(
    '列表回吐派生检验人（与 inspection_orders.inspector_name 对齐）',
    traceableMrb !== undefined && tracedItem?.inspectorName === traceableMrb.inspector_name,
    {
      mrbNo: traceableMrb?.mrb_no,
      expected: traceableMrb?.inspector_name,
      got: tracedItem?.inspectorName,
    }
  );
  check(
    '列表回吐 urgencyLevel/reviewFlowId',
    (recs.body.items ?? []).length >= 1 &&
      (recs.body.items ?? []).every((r) => r.urgencyLevel !== undefined),
    (recs.body.items ?? []).map((r) => [r.mrbNo, r.urgencyLevel, r.reviewFlowId !== undefined])
  );

  // 4. 池发起评审：flowId / urgencyLevel / reviewNotes / pendingDefectId 必须全部落库
  const flowId = '50000000-0000-4000-8000-000000000004';
  const init = await req('POST', '/mrb/pending-pool/initiate', {
    pendingDefectId: item.inspectionOrderId,
    flowId,
    urgencyLevel: 'URGENT',
    reviewNotes: '字段打通验收：选用来料/委外评审流程',
  });
  check('POST /mrb/pending-pool/initiate 返回 201', init.status === 201, init.status);
  const mrb = init.body;
  const mrbRow = (
    await db.query(
      'select id, source_order_no, urgency_level, review_flow_id, review_notes, pending_defect_id, status from mrb_reviews where id=$1',
      [mrb.id]
    )
  ).rows[0];
  check('MRB 落 urgency_level=URGENT', mrbRow?.urgency_level === 'URGENT', mrbRow?.urgency_level);
  check('MRB 落 review_flow_id', mrbRow?.review_flow_id === flowId, mrbRow?.review_flow_id);
  check(
    'MRB 落 review_notes',
    mrbRow?.review_notes === '字段打通验收：选用来料/委外评审流程',
    mrbRow?.review_notes
  );
  const poolRow = (
    await db.query(
      'select id, status, mrb_review_id, review_started_by, total_qty, supplier_name from pending_mrb_items where source_order_id=$1',
      [item.inspectionOrderId]
    )
  ).rows[0];
  check(
    '池条目转 INITIATED + 回填 MRB',
    poolRow?.status === 'INITIATED' && poolRow?.mrb_review_id === mrb.id,
    poolRow
  );
  check('MRB 回填 pending_defect_id 外键', mrbRow?.pending_defect_id === poolRow?.id, {
    pendingDefectId: mrbRow?.pending_defect_id,
    poolId: poolRow?.id,
  });
  check(
    '池条目记录发起人',
    poolRow?.review_started_by !== null && poolRow?.review_started_by !== undefined,
    poolRow?.review_started_by
  );

  // 5. 会签
  const sign = await req('POST', '/mrb/records/' + mrb.id + '/sign', {
    roleCode: 'QA_MGR',
    approverName: '张强',
    action: 'APPROVED',
    comment: '会签通过',
  });
  check(
    'POST /mrb/records/:id/sign -> UNDER_REVIEW',
    sign.status === 200 && sign.body.status === 'UNDER_REVIEW',
    sign.body?.status
  );

  // 6. 特采无客户凭证必须被拦截（不得有伪造兜底）
  const bad = await req('POST', '/mrb/records/' + mrb.id + '/disposition', {
    disposition: 'CONCESSION',
    dispositionReason: '验收：特采无凭证应被拦截',
  });
  check('特采缺客户凭证 -> 400', bad.status === 400, {
    status: bad.status,
    code: bad.body?.code,
  });

  // 7. 携带凭证处置：响应必须是裸 MRBRecord
  const okRes = await req('POST', '/mrb/records/' + mrb.id + '/disposition', {
    disposition: 'CONCESSION',
    dispositionReason: '验收：客户已书面同意让步接收',
    concessionAttachmentUrl: '/attachments/verify-concession.pdf',
  });
  check(
    '处置返回裸 MRBRecord（非包装对象）',
    okRes.status === 200 && okRes.body.mrbReview === undefined && okRes.body.status === 'DISPOSED',
    { status: okRes.status, keys: okRes.body && Object.keys(okRes.body).slice(0, 6) }
  );
  const disposed = (
    await db.query(
      'select disposed_at, disposed_by, concession_attachment_url, approvers from mrb_reviews where id=$1',
      [mrb.id]
    )
  ).rows[0];
  check(
    '处置闭环时间/裁决人落库',
    disposed?.disposed_at !== null && disposed?.disposed_by !== null,
    { disposedAt: disposed?.disposed_at, disposedBy: disposed?.disposed_by }
  );
  check(
    '特采凭证按提交值落库（无伪造兜底）',
    disposed?.concession_attachment_url === '/attachments/verify-concession.pdf',
    disposed?.concession_attachment_url
  );

  // 7.5 返工处置（REWORK）响应必须回吐复检单标识（docs/21 §11 契约 DisposeMRBResponse）
  //     来源单自建，走完整链路：建单 -> 越界录入判定 FAILED -> 自动入待审核池 -> 发起评审
  //     -> 处置 REWORK -> 校验响应体与库内复检行，避免依赖演示池的存量状态。
  const reworkStamp = Date.now();
  const reworkInboundNo = 'RK-WIRING-REWORK-' + reworkStamp;
  const reworkSpec = 'Φ5.0mm / 盘圆 / 304HC-WIRING';
  const reworkPlan = (
    await db.query(
      "select id, inspection_stage, material_code from inspection_plans where version_status='ACTIVE' and material_code<>'' and inspection_stage='IQC' and items @> '[{\"dataType\":\"NUMERIC\"}]'::jsonb order by plan_code, version limit 1"
    )
  ).rows[0];
  const reworkCreate = await req('POST', '/inspections', {
    orderNo: 'WIRING-REWORK-INS-' + reworkStamp,
    inspectionType: reworkPlan.inspection_stage,
    materialCode: reworkPlan.material_code,
    materialName: '返工链路验收物料',
    batchNo: 'WIRING-REWORK-B-' + reworkStamp,
    sampleQty: 5,
    planVersionId: reworkPlan.id,
    inboundNo: reworkInboundNo,
    inboundDate: '2026-08-20',
    specification: reworkSpec,
    unit: 'WIRING-UNIT',
  });
  const reworkOrder = reworkCreate.body ?? {};
  const reworkNumeric = (reworkOrder.items ?? []).find((it) => it.dataType === 'NUMERIC');
  const reworkFail = await req('POST', '/inspections/' + reworkOrder.id + '/submit-measurements', {
    items: (reworkOrder.items ?? []).map((it) =>
      it.dataType === 'NUMERIC'
        ? {
            itemCode: it.itemCode,
            measuredVal:
              it.itemCode === reworkNumeric.itemCode
                ? (it.nominalValue ?? 0) + (it.upperTolerance ?? 0) + 1
                : (it.nominalValue ?? 0),
          }
        : {
            itemCode: it.itemCode,
            measuredText: ((it.standardText ?? '合格').split(/[,，/|]/)[0] ?? '合格').trim(),
          }
    ),
    isDraft: false,
  });
  // 判定不合格即自动建单（docs/43：无人工发起环节）—— 直接取终判事务内生成的 MRB 单，
  // 旧口径「入池 -> 人工发起」已废止，验收口径同步为「自动入池 + 自动建单」。
  const reworkMrbRow = (
    await db.query('select id, mrb_no, status from mrb_reviews where source_order_no=$1', [
      reworkOrder.orderNo,
    ])
  ).rows[0];
  const reworkMrb = reworkMrbRow ?? {};
  check(
    '返工链路前置：建单 201 / 越界判定不合格并自动进入 MRB 评审 / 自动建单命中 PENDING_REVIEW',
    reworkCreate.status === 201 &&
      reworkFail.status === 200 &&
      reworkFail.body?.status === 'IN_MRB_REVIEW' &&
      reworkMrbRow !== undefined &&
      reworkMrbRow.status === 'PENDING_REVIEW',
    {
      create: reworkCreate.status,
      judge: reworkFail.body?.status,
      mrbNo: reworkMrbRow?.mrb_no,
      mrbStatus: reworkMrbRow?.status,
    }
  );

  const reworkRound =
    (
      await db.query('select count(*)::int as c from inspection_orders where batch_no=$1', [
        reworkOrder.batchNo,
      ])
    ).rows[0].c + 1;
  const expectedReinspectionNo = reworkOrder.orderNo + '-R' + reworkRound;
  const reworkRes = await req('POST', '/mrb/records/' + reworkMrb.id + '/disposition', {
    disposition: 'REWORK',
    dispositionReason: '返工链路验收：验证处置响应回吐复检单标识',
  });
  check(
    'REWORK 处置响应回吐复检单标识（reinspectionOrderNo = {原单号}-R{轮次}）',
    reworkRes.status === 200 &&
      reworkRes.body?.disposition === 'REWORK' &&
      reworkRes.body?.reinspectionOrderNo === expectedReinspectionNo &&
      typeof reworkRes.body?.reinspectionOrderId === 'string',
    {
      status: reworkRes.status,
      got: reworkRes.body?.reinspectionOrderNo,
      expected: expectedReinspectionNo,
      id: reworkRes.body?.reinspectionOrderId,
    }
  );

  const reinspectionRow = (
    await db.query(
      'select id, order_no, status, inbound_no, specification, unit from inspection_orders where id=$1',
      [reworkRes.body?.reinspectionOrderId]
    )
  ).rows[0];
  check(
    '复检行按响应标识落库（id / order_no 对齐，状态 PENDING）',
    reinspectionRow !== undefined &&
      reinspectionRow.order_no === expectedReinspectionNo &&
      reinspectionRow.status === 'PENDING',
    reinspectionRow
  );
  check(
    '复检行沿承原单批次凭证快照（inbound_no / specification / unit 逐字段等于原单，不回查主数据）',
    reinspectionRow !== undefined &&
      reinspectionRow.inbound_no === reworkInboundNo &&
      reinspectionRow.specification === reworkSpec &&
      reinspectionRow.unit === 'WIRING-UNIT',
    {
      inboundNo: reinspectionRow?.inbound_no,
      specification: reinspectionRow?.specification,
      unit: reinspectionRow?.unit,
    }
  );
  check(
    '返工处置后源单翻转为 RE_INSPECTING',
    (
      await db.query('select status from inspection_orders where id=$1', [reworkOrder.id])
    ).rows[0]?.status === 'RE_INSPECTING'
  );

  reworkCleanup = async () => {
    await db.query('delete from mrb_reviews where id=$1', [reworkMrb.id]);
    await db.query('delete from batch_trace_relations where parent_batch=$1 or child_batch=$2', [
      reworkOrder.orderNo + ':FAIL',
      expectedReinspectionNo,
    ]);
    // 池条目由 source_order_id 外键级联回收，这里只需清掉本次批次的源单与复检单
    await db.query('delete from inspection_orders where batch_no=$1', [reworkOrder.batchNo]);
  };

  // 8. 评审流程设置子页字段打通（docs/21 §10）：流程说明 + 节点四字段 + 启停真实落库
  //    该子页此前三处断链（E1 说明恒空 / E2 节点四列对不上契约 / E3 启停假成功）已在 019 闭环。
  const flowsRes = await req('GET', '/review-flows');
  const flows = flowsRes.body?.items ?? [];
  check(
    'GET /review-flows 回吐 description 与节点 roleName/isRequired/allowConcession',
    flowsRes.status === 200 &&
      flows.length >= 1 &&
      flows.every(
        (f) =>
          typeof f.description === 'string' &&
          f.description.length > 0 &&
          f.nodes.length >= 1 &&
          f.nodes.every(
            (n) =>
              typeof n.roleName === 'string' &&
              n.roleName.length > 0 &&
              typeof n.isRequired === 'boolean' &&
              typeof n.allowConcession === 'boolean'
          )
      ),
    flows.map((f) => [f.flowCode, f.description, f.nodes.length])
  );
  const flowWithNodes = flows.find((f) => f.nodes.length >= 1) ?? { nodes: [] };
  const maxLevel = Math.max(...flowWithNodes.nodes.map((n) => n.nodeLevel));
  check(
    '节点顺序唯一取 nodeLevel，且仅终审层级 allowConcession=true',
    flowWithNodes.nodes.length >= 1 &&
      flowWithNodes.nodes.every(
        (n) => n.allowConcession === (n.nodeLevel === maxLevel) && Number.isInteger(n.nodeLevel)
      ),
    flowWithNodes.nodes.map((n) => [n.nodeLevel, n.roleName, n.isRequired, n.allowConcession])
  );
  const dbFlows = (
    await db.query('select flow_code, description from review_flows order by flow_code')
  ).rows;
  const apiDescByCode = new Map(flows.map((f) => [f.flowCode, f.description ?? null]));
  check(
    '接口 description 与 review_flows.description 逐条一致',
    dbFlows.length === flows.length &&
      dbFlows.every((r) => (r.description ?? null) === (apiDescByCode.get(r.flow_code) ?? null)),
    { db: dbFlows.length, api: flows.length }
  );
  const toggleTarget = flows.find((f) => f.isActive === true) ?? flows[0];
  const isActiveOf = async (flowCode) =>
    (await db.query('select is_active from review_flows where flow_code=$1', [flowCode])).rows[0]
      ?.is_active;
  const activeBefore = await isActiveOf(toggleTarget.flowCode);
  // 必须带空对象体：Fastify 对 content-type=application/json 的空体直接 400，
  // 前端 api.post(path, {}) 也是这个形态，这里如实复现真实调用。
  const toggled = await req('POST', '/review-flows/' + toggleTarget.id + '/toggle-active', {});
  const activeAfter = await isActiveOf(toggleTarget.flowCode);
  const restored = await req('POST', '/review-flows/' + toggleTarget.id + '/toggle-active', {});
  const activeRestored = await isActiveOf(toggleTarget.flowCode);
  check(
    'POST /review-flows/:id/toggle-active 真实落库 is_active（往返还原）',
    toggled.status === 200 &&
      restored.status === 200 &&
      activeAfter === !activeBefore &&
      toggled.body?.isActive === activeAfter &&
      activeRestored === activeBefore,
    { flowCode: toggleTarget.flowCode, before: activeBefore, after: activeAfter, restored: activeRestored }
  );

  // 清理：还原演示数据（池条目回待发起、工单回 FAILED、删除验收生成的 MRB）
  await db
    .query('update mrb_reviews set pending_defect_id=null where id=$1', [mrb.id])
    .catch(() => {});
  await db.query('delete from mrb_reviews where id=$1', [mrb.id]);
  await db.query(
    "update pending_mrb_items set status='PENDING_INITIATE', mrb_review_id=null, review_started_at=null, review_started_by=null where source_order_id=$1",
    [item.inspectionOrderId]
  );
  await db.query("update inspection_orders set status='FAILED' where id=$1", [
    item.inspectionOrderId,
  ]);
  if (reworkCleanup) await reworkCleanup();
  console.log('== 结果: ' + pass + '/' + (pass + fail) + ' 通过 ==');
  await db.end();
  process.exit(fail === 0 ? 0 : 1);
})().catch(async (e) => {
  // 中途抛错也必须回收返工链路的验收行，避免污染演示库
  if (reworkCleanup) await reworkCleanup().catch(() => {});
  console.error('ERR', e.message);
  process.exit(1);
});
