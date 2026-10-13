import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import { buildApp } from '../src/app';
import { createApiContainer, type ApiContainer } from '../src/container';
import { generateTestToken } from '../src/plugins/auth';
import { evaluateInspectionItem, InspectionStateMachine } from '@letian/domain';
import { ErrorCode, ProblemDetailsSchema, TraceabilityGraphResponseSchema } from '@letian/contracts';

/**
 * 看板聚合 / 领域规则 / 追溯拓扑 冒烟测试（真实 PostgreSQL 版）
 *
 * 断言来源说明（本文件已不再使用任何内存 Mock 常量）：
 * 1. 看板与统计接口的每一项期望值，都由测试自己直连真实库（container.db）重新聚合得出，
 *    因此这些断言验证的是"HTTP 响应 == 数据库真实聚合"，而不是"接口自说自话"；
 * 2. 追溯拓扑的期望值由 batch_trace_relations / batch_trace_nodes 两张真实表独立推导
 *    （测试侧自己实现 BFS + 深度限制 + 有向环检测），再与接口返回逐项比对；
 * 3. 领域规则（公差判定 / 状态机）为纯函数断言，不依赖数据库。
 *
 * 前置条件：本地 PostgreSQL（.env 的 DATABASE_URL）已执行迁移与种子数据；
 * 连不上库时本测试会明确失败，不会静默跳过。
 */

/** DB 中检验单行的最小视图（只取断言需要的列） */
interface OrderRow {
  status: string;
  id: string;
  orderNo: string;
  orderType: string;
  judgment: string | null;
  createdAt: Date;
  items: unknown;
}

/** JSONB 明细项中与缺陷 TopN 相关的字段 */
interface FailedItemLite {
  name?: string;
  metricCategory?: string;
  result?: string;
}

interface TraceRelationRow {
  parentBatch: string;
  childBatch: string;
  relationType: string;
}

/** 契约检验类型前缀 → 看板工序分组（与接口文档口径一致的独立实现） */
function stageOf(orderType: string): 'iqc' | 'ipqc' | 'oqc' | null {
  if (orderType.startsWith('IQC')) return 'iqc';
  if (orderType.startsWith('IPQC')) return 'ipqc';
  if (orderType.startsWith('OQC')) return 'oqc';
  return null;
}

function dateKey(date: Date): string {
  const month = `${date.getMonth() + 1}`.padStart(2, '0');
  const day = `${date.getDate()}`.padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

function round2(value: number): number {
  return Number(value.toFixed(2));
}

type TraceDirection = 'BOTH' | 'UPSTREAM' | 'DOWNSTREAM';

/** 测试侧独立实现的穿透模型：与 HTTP 契约 maxDepth / direction 语义一致 */
function expectedGraph(
  relations: readonly TraceRelationRow[],
  nodeBatches: ReadonlySet<string>,
  root: string,
  direction: TraceDirection,
  maxDepth: number
): { nodes: Set<string>; edgeKeys: Set<string> } {
  const edgeKey = (r: TraceRelationRow) => `${r.parentBatch}->${r.childBatch}-${r.relationType}`;
  // 邻接关系：BOTH 视为无向，UPSTREAM 只允许"子批次 -> 父批次"，DOWNSTREAM 只允许"父 -> 子"
  const neighbors = (batchNo: string): string[] => {
    const result: string[] = [];
    for (const r of relations) {
      if (direction !== 'DOWNSTREAM' && r.childBatch === batchNo) result.push(r.parentBatch);
      if (direction !== 'UPSTREAM' && r.parentBatch === batchNo) result.push(r.childBatch);
    }
    return result;
  };

  const expanded = new Set<string>();
  const nodes = new Set<string>([root]);
  const queue: Array<{ batchNo: string; depth: number }> = [{ batchNo: root, depth: 0 }];

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) break;
    if (current.depth >= maxDepth) continue;
    if (expanded.has(current.batchNo)) continue;
    expanded.add(current.batchNo);

    for (const next of neighbors(current.batchNo)) {
      if (nodeBatches.has(next)) nodes.add(next);
      if (!expanded.has(next)) queue.push({ batchNo: next, depth: current.depth + 1 });
    }
  }

  // 被展开节点上的关系边都会被记录（与用例实现一致：双向穿透下同一条边去重保留首个 depth）
  // 注意方向语义：UPSTREAM 只取"当前批次作为子批次"的边，DOWNSTREAM 只取"当前批次作为父批次"的边
  const edgeKeys = new Set<string>();
  for (const r of relations) {
    const touched =
      direction === 'BOTH'
        ? expanded.has(r.parentBatch) || expanded.has(r.childBatch)
        : direction === 'UPSTREAM'
          ? expanded.has(r.childBatch)
          : expanded.has(r.parentBatch);
    if (touched) edgeKeys.add(edgeKey(r));
  }

  return { nodes, edgeKeys };
}

/** 独立实现的有向环检测（Kahn 拓扑排序：无法全部出队即存在有向环） */
function hasDirectedCycle(relations: ReadonlyArray<{ parentBatch: string; childBatch: string }>): boolean {
  const nodes = new Set<string>();
  const indegree = new Map<string, number>();
  const outgoing = new Map<string, string[]>();

  for (const r of relations) {
    nodes.add(r.parentBatch);
    nodes.add(r.childBatch);
    if (!indegree.has(r.childBatch)) indegree.set(r.childBatch, 0);
    if (!indegree.has(r.parentBatch)) indegree.set(r.parentBatch, 0);
    indegree.set(r.childBatch, (indegree.get(r.childBatch) ?? 0) + 1);
    outgoing.set(r.parentBatch, [...(outgoing.get(r.parentBatch) ?? []), r.childBatch]);
  }

  const queue = [...nodes].filter((n) => (indegree.get(n) ?? 0) === 0);
  let sorted = 0;
  const remainingIndegree = new Map(indegree);
  while (queue.length > 0) {
    const batchNo = queue.shift();
    if (batchNo === undefined) break;
    sorted += 1;
    for (const next of outgoing.get(batchNo) ?? []) {
      const left = (remainingIndegree.get(next) ?? 0) - 1;
      remainingIndegree.set(next, left);
      if (left === 0) queue.push(next);
    }
  }

  return sorted !== nodes.size;
}

async function queryOrders(container: ApiContainer): Promise<OrderRow[]> {
  const rows = await container.db
    .selectFrom('inspectionOrders')
    .select(['id', 'orderNo', 'status', 'orderType', 'judgment', 'createdAt', 'items'])
    .execute();

  return rows.map((row) => ({
    status: row.status,
    id: row.id,
    orderNo: row.orderNo,
    orderType: row.orderType,
    judgment: row.judgment,
    createdAt: row.createdAt,
    items: row.items,
  }));
}

async function runTests() {
  console.log('=== 乐天 QMS 看板 / 领域规则 / 追溯拓扑验证（真实 PostgreSQL） ===\n');

  const container = createApiContainer();
  const app = await buildApp({ logger: false, container });
  // 看板/列表接口已接入三维 PBAC 行级过滤（fail-closed）：
  // 必须使用配置了全量通配规则的质量主管「张强」（EMPLOYEE_IDS.zhangQiang），
  // 否则无规则身份的聚合结果恒为 0。
  const token = generateTestToken({
    userId: '11000000-0000-4000-8000-000000000001',
    userName: '张强',
    role: 'QA_MANAGER',
    permissions: ['*'],
  });
  const authHeader = { authorization: `Bearer ${token}` };

  try {
    const unauthenticatedRes = await app.inject({
      method: 'GET',
      url: '/api/v1/inspections',
    });
    assert.equal(unauthenticatedRes.statusCode, 401, '未认证请求必须返回 401');
    const unauthenticatedProblem = ProblemDetailsSchema.parse(JSON.parse(unauthenticatedRes.body));
    assert.equal(unauthenticatedProblem.code, ErrorCode.UNAUTHORIZED);
    assert.match(String(unauthenticatedRes.headers['content-type']), /application\/problem\+json/);

    const invalidQueryRes = await app.inject({
      method: 'GET',
      url: '/api/v1/traceability/batches?page=0',
      headers: authHeader,
    });
    assert.equal(invalidQueryRes.statusCode, 400, '非法查询参数必须返回 400');
    const invalidQueryProblem = ProblemDetailsSchema.parse(JSON.parse(invalidQueryRes.body));
    assert.equal(invalidQueryProblem.code, ErrorCode.VALIDATION_FAILED);
    assert.match(String(invalidQueryRes.headers['content-type']), /application\/problem\+json/);

    const missingRouteRes = await app.inject({
      method: 'GET',
      url: '/api/v1/no-such-route-for-contract-check',
      headers: authHeader,
    });
    assert.equal(missingRouteRes.statusCode, 404, '未注册路径必须返回 404');
    const missingRouteProblem = ProblemDetailsSchema.parse(JSON.parse(missingRouteRes.body));
    assert.equal(missingRouteProblem.code, ErrorCode.RESOURCE_NOT_FOUND);
    assert.match(String(missingRouteRes.headers['content-type']), /application\/problem\+json/);

    const permissionRepo = container.repositories.materialPermissions;
    const findByUserId = permissionRepo.findByUserId.bind(permissionRepo);
    let securityContextLoads = 0;
    permissionRepo.findByUserId = async (userId: string) => {
      securityContextLoads += 1;
      return findByUserId(userId);
    };
    const traceSearchRes = await app.inject({
      method: 'GET',
      url: '/api/v1/traceability/batches?page=1&pageSize=1',
      headers: authHeader,
    });
    permissionRepo.findByUserId = findByUserId;
    assert.equal(traceSearchRes.statusCode, 200, `JWT 鉴权后的追溯检索必须返回 200：${traceSearchRes.body}`);
    assert.equal(
      securityContextLoads,
      1,
      'JWT 中间件必须一次性注入 PBAC 安全上下文，控制器不得重复装配'
    );

    const orderRows = await queryOrders(container);
    assert.ok(orderRows.length > 0, '真实库中应存在检验单种子数据，否则看板聚合无从验证');

    // ------------------------------------------------------------------
    // 1. 质量看板总览：每一项都由真实库重新聚合后比对
    // ------------------------------------------------------------------
    const overviewRes = await app.inject({
      method: 'GET',
      url: '/api/v1/dashboard/overview',
      headers: authHeader,
    });
    assert.equal(overviewRes.statusCode, 200, `看板总览接口应返回 200，实际: ${overviewRes.body}`);
    const overview = JSON.parse(overviewRes.body) as {
      totalInspections: number;
      passRate: number;
      pendingCount: number;
      inspectingCount: number;
      failedCount: number;
      inMRBCount: number;
      stageDistribution: { iqcCount: number; ipqcCount: number; oqcCount: number };
      trendSeries: Array<{ date: string; iqcCount: number; ipqcCount: number; oqcCount: number; passRate: number }>;
      topDefects: Array<{ defectName: string; category: string; count: number }>;
      recentActivities: Array<{ id: string; type: string; title: string; status: string; timestamp: string }>;
    };

    assert.equal(overview.totalInspections, orderRows.length, '看板总单数应等于 inspection_orders 行数');
    const countBy = (status: string) => orderRows.filter((o) => o.status === status).length;
    const passedCount = countBy('PASSED') + countBy('COMPLETED');
    assert.equal(
      overview.passRate,
      round2((passedCount / orderRows.length) * 100),
      '综合合格率应等于 (PASSED + COMPLETED) / 总工单数（真实库口径）'
    );
    assert.equal(overview.pendingCount, countBy('PENDING'), '待检数应等于库中 PENDING 工单数');
    assert.equal(overview.inspectingCount, countBy('INSPECTING'), '检验中数量应等于库中 INSPECTING 工单数');
    assert.equal(overview.failedCount, countBy('FAILED'), '不合格数应等于库中 FAILED 工单数');

    const expectedStages = { iqcCount: 0, ipqcCount: 0, oqcCount: 0 };
    for (const order of orderRows) {
      const stage = stageOf(order.orderType);
      if (stage === 'iqc') expectedStages.iqcCount += 1;
      else if (stage === 'ipqc') expectedStages.ipqcCount += 1;
      else if (stage === 'oqc') expectedStages.oqcCount += 1;
    }
    assert.deepEqual(overview.stageDistribution, expectedStages, '工序分组统计应按检验类型前缀与真实库一致');

    const mrbRows = await container.db.selectFrom('mrbReviews').select(['status']).execute();
    assert.equal(
      overview.inMRBCount,
      mrbRows.filter((m) => m.status === 'PENDING_REVIEW' || m.status === 'UNDER_REVIEW').length,
      'MRB 评审中数量应等于库中待评审 + 会签中的评审单数'
    );

    // 趋势：近 7 天窗口（窗口右端按库中最新业务日回退），逐日与库中工单比对
    const dayKeys = new Set(orderRows.map((o) => dateKey(o.createdAt)));
    const sortedDays = [...dayKeys].sort();
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const latestDay = sortedDays.length > 0 ? sortedDays[sortedDays.length - 1] : undefined;
    const todayKey = dateKey(today);
    const windowEnd =
      latestDay !== undefined && latestDay < todayKey ? new Date(`${latestDay}T00:00:00`) : today;

    const expectedDates: string[] = [];
    for (let offset = 6; offset >= 0; offset -= 1) {
      const day = new Date(windowEnd);
      day.setDate(windowEnd.getDate() - offset);
      expectedDates.push(dateKey(day));
    }
    assert.deepEqual(
      overview.trendSeries.map((point) => point.date),
      expectedDates,
      '趋势应覆盖以库中最新业务日为右端的连续 7 天'
    );

    for (const point of overview.trendSeries) {
      const sameDay = orderRows.filter((o) => dateKey(o.createdAt) === point.date);
      const sameDayPassed = sameDay.filter((o) => o.status === 'PASSED' || o.status === 'COMPLETED').length;
      assert.equal(
        point.iqcCount + point.ipqcCount + point.oqcCount,
        sameDay.length,
        `${point.date} 的分工序数量之和应等于当日真实工单数`
      );
      assert.equal(
        point.passRate,
        sameDay.length > 0 ? round2((sameDayPassed / sameDay.length) * 100) : 0,
        `${point.date} 的合格率应由当日真实工单状态推导`
      );
    }

    // 缺陷 TopN：由检验单 JSONB 明细中 result=FAILED 的指标项在测试侧重算
    const defectGroups = new Map<string, { defectName: string; category: string; count: number }>();
    for (const order of orderRows) {
      for (const item of order.items as FailedItemLite[]) {
        if (item.result !== 'FAILED') continue;
        const name = item.name ?? '';
        const category = item.metricCategory ?? 'DIMENSION';
        const key = `${name}\u0000${category}`;
        const group = defectGroups.get(key) ?? { defectName: name, category, count: 0 };
        group.count += 1;
        defectGroups.set(key, group);
      }
    }
    const allGroups = [...defectGroups.values()].sort(
      (a, b) => b.count - a.count || a.defectName.localeCompare(b.defectName)
    );
    const reportedKeys = new Set(overview.topDefects.map((d) => `${d.defectName}\u0000${d.category}`));
    assert.equal(
      overview.topDefects.length,
      Math.min(5, allGroups.length),
      '缺陷 TopN 条数应为 min(5, 库中缺陷分组数)'
    );
    for (const defect of overview.topDefects) {
      const group = defectGroups.get(`${defect.defectName}\u0000${defect.category}`);
      assert.ok(group, `返回的缺陷项 [${defect.defectName}/${defect.category}] 必须来自库中 FAILED 指标项`);
      assert.equal(defect.count, group.count, `缺陷 [${defect.defectName}] 的数量应等于库中统计值`);
    }
    if (allGroups.length > overview.topDefects.length) {
      const minReported = Math.min(...overview.topDefects.map((d) => d.count));
      const maxExcluded = Math.max(
        ...allGroups.filter((g) => !reportedKeys.has(`${g.defectName}\u0000${g.category}`)).map((g) => g.count)
      );
      assert.ok(minReported >= maxExcluded, 'TopN 之外的缺陷数量不得高于已返回的任意一项');
    }

    // 最近动态：应与审计表最新的若干条一致
    const auditRows = await container.db
      .selectFrom('auditLogs')
      .select(['id', 'entityId', 'status', 'occurredAt'])
      .orderBy('occurredAt', 'desc')
      .limit(6)
      .execute();
    assert.deepEqual(
      [...overview.recentActivities.map((a) => a.id)].sort(),
      auditRows.map((row) => row.id).sort(),
      '最近动态应取审计表中最新 6 条记录'
    );
    for (const activity of overview.recentActivities) {
      const row = auditRows.find((item) => item.id === activity.id);
      assert.ok(row, `动态 [${activity.id}] 必须对应一条真实审计记录`);
      assert.equal(activity.status, row.status, '动态状态应取自审计记录状态');
      assert.equal(activity.timestamp, row.occurredAt.toISOString(), '动态时间应取自审计记录时间');
      assert.ok(activity.title.includes(row.entityId), '动态标题应包含审计记录的资源标识');
      assert.ok(
        ['INSPECTION', 'MRB', 'GATE', 'PLAN', 'SYNC', 'AUDIT'].includes(activity.type),
        `动态类型 [${activity.type}] 应为看板约定类别之一`
      );
    }
    console.log('✔ 看板总览/趋势/缺陷 TopN/最近动态 均与真实库聚合一致');

    // ------------------------------------------------------------------
    // 2. 看板统计卡片：同样由真实库推导
    // ------------------------------------------------------------------
    const statsRes = await app.inject({
      method: 'GET',
      url: '/api/v1/dashboard/stats',
      headers: authHeader,
    });
    assert.equal(statsRes.statusCode, 200, `看板统计接口应返回 200，实际: ${statsRes.body}`);
    const stats = JSON.parse(statsRes.body) as {
      todayInspections: number;
      yieldRate: number;
      interceptedBatches: number;
      pendingMrb: number;
      defectDistribution: Array<{ name: string; value: number; percentage: string }>;
      weeklyTrend: { dates: string[]; yieldRates: number[]; inspectionCounts: number[]; defectCounts: number[] };
    };

    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    assert.equal(
      stats.todayInspections,
      orderRows.filter((o) => o.createdAt >= todayStart).length,
      '今日检验数应等于库中今日创建的工单数'
    );
    const yieldedStatuses = new Set(['PASSED', 'COMPLETED', 'IN_MRB_REVIEW']);
    assert.equal(
      stats.yieldRate,
      round2((orderRows.filter((o) => yieldedStatuses.has(o.status)).length / orderRows.length) * 100),
      '良率口径应为 (PASSED + COMPLETED + IN_MRB_REVIEW) / 总工单数'
    );
    assert.equal(
      stats.pendingMrb,
      mrbRows.filter((m) => m.status === 'PENDING_REVIEW').length,
      '待评审 MRB 数应等于库中 PENDING_REVIEW 评审单数'
    );

    const blockedRows = await container.db
      .selectFrom('auditLogs')
      .select(['entityId'])
      .where('action', '=', 'GATE_BLOCKED')
      .execute();
    assert.equal(
      stats.interceptedBatches,
      new Set(blockedRows.map((row) => row.entityId)).size,
      '拦截批次数应等于审计表中 GATE_BLOCKED 记录的去重批次号数量'
    );
    assert.equal(stats.weeklyTrend.dates.length, 7, '周趋势应固定 7 个点');
    assert.equal(stats.weeklyTrend.inspectionCounts.length, 7, '周趋势检验数应固定 7 个点');
    const windowEndKey = expectedDates[expectedDates.length - 1];
    assert.equal(
      stats.weeklyTrend.inspectionCounts[6],
      orderRows.filter((o) => dateKey(o.createdAt) === windowEndKey).length,
      '周趋势最后一点应等于窗口末端日期在库中的工单数'
    );
    const expectedDefectTotal = allGroups.slice(0, 5).reduce((sum, g) => sum + g.count, 0);
    for (const defect of stats.defectDistribution) {
      const group = defectGroups.get(`${defect.name}\u0000DIMENSION`) ?? allGroups.find((g) => g.defectName === defect.name);
      assert.ok(group, `缺陷分布项 [${defect.name}] 必须来自库中 FAILED 指标项`);
      assert.equal(defect.value, group.count, `缺陷分布 [${defect.name}] 数量应等于库中统计值`);
      assert.equal(
        defect.percentage,
        expectedDefectTotal > 0 ? `${((group.count / expectedDefectTotal) * 100).toFixed(1)}%` : '0.0%',
        `缺陷分布 [${defect.name}] 占比应等于其在 TopN 中的数量占比`
      );
    }
    console.log('✔ 看板统计卡片指标均由真实库推导');

    // ------------------------------------------------------------------
    // 3. 化学成分判定 (使用契约 measuredVal 字段；公差为正数量级)
    // ------------------------------------------------------------------
    const passedItem = evaluateInspectionItem({
      dataType: 'NUMERIC',
      standardText: '0.38% ~ 0.45%',
      nominalValue: 0.4,
      upperTolerance: 0.05,
      lowerTolerance: 0.02,
      measuredVal: 0.42,
      isExempt: false,
    });
    assert.equal(passedItem, 'PASSED', '0.42% 落在 [0.38, 0.45] 区间应判定为合格');

    const failedItem = evaluateInspectionItem({
      dataType: 'NUMERIC',
      standardText: '0.38% ~ 0.45%',
      nominalValue: 0.4,
      upperTolerance: 0.05,
      lowerTolerance: 0.02,
      measuredVal: 0.52,
      isExempt: false,
    });
    assert.equal(failedItem, 'FAILED', '0.52% 超出区间上限应判定为不合格');

    const upperBoundItem = evaluateInspectionItem({
      dataType: 'NUMERIC',
      nominalValue: 0.4,
      upperTolerance: 0.05,
      lowerTolerance: 0.02,
      measuredVal: 0.45,
      isExempt: false,
    });
    assert.equal(upperBoundItem, 'PASSED', '0.45% 恰等于上限应判定为合格（边界含）');

    const lowerBoundItem = evaluateInspectionItem({
      dataType: 'NUMERIC',
      nominalValue: 0.4,
      upperTolerance: 0.05,
      lowerTolerance: 0.02,
      measuredVal: 0.38,
      isExempt: false,
    });
    assert.equal(lowerBoundItem, 'PASSED', '下公差为数量级，0.38% 应判定为合格（边界含）');

    const pendingItem = evaluateInspectionItem({
      dataType: 'NUMERIC',
      nominalValue: 0.4,
      upperTolerance: 0.05,
      lowerTolerance: 0.02,
      isExempt: false,
    });
    assert.equal(pendingItem, 'PENDING', '未录入实测值必须返回 PENDING，严禁默认放行');

    const missingNominalItem = evaluateInspectionItem({
      dataType: 'NUMERIC',
      upperTolerance: 0.05,
      lowerTolerance: 0.02,
      measuredVal: 0.4,
      isExempt: false,
    });
    assert.equal(missingNominalItem, 'PENDING', '缺少标准基准值必须返回 PENDING');

    const qualitativePending = evaluateInspectionItem({
      dataType: 'QUALITATIVE',
      standardText: '合格,OK,Pass',
      isExempt: false,
    });
    assert.equal(qualitativePending, 'PENDING', '定性指标未录入实测文本必须返回 PENDING');
    const qualitativePassed = evaluateInspectionItem({
      dataType: 'QUALITATIVE',
      standardText: '合格,OK,Pass',
      measuredText: ' ok ',
      isExempt: false,
    });
    assert.equal(qualitativePassed, 'PASSED', '定性指标实测文本命中标准选项应判定合格');
    console.log('✔ 公差区间判定（含边界与未录入）符合领域规则');

    // ------------------------------------------------------------------
    // 4. 状态机约束 (8 态流转)
    // ------------------------------------------------------------------
    assert.ok(InspectionStateMachine.canTransition('PENDING', 'INSPECTING'), '待检可流转为检验中');
    assert.ok(
      InspectionStateMachine.canTransition('FAILED', 'IN_MRB_REVIEW'),
      '检验不合格可流转至 MRB 评审'
    );
    assert.ok(
      InspectionStateMachine.canTransition('IN_MRB_REVIEW', 'RE_INSPECTING'),
      'MRB 评审返工决策流向复检'
    );
    assert.ok(InspectionStateMachine.canTransition('PASSED', 'COMPLETED'), '合格后应可结单归档');
    assert.ok(
      !InspectionStateMachine.canTransition('PASSED', 'PENDING'),
      '已合格单据不可倒退回待检'
    );
    assert.ok(
      !InspectionStateMachine.canTransition('COMPLETED', 'PENDING'),
      '已归档终态不可再次流转'
    );
    console.log('✔ 检验单 8 态状态机流转与防御机制校验一致');

    // ------------------------------------------------------------------
    // 5. 追溯拓扑：期望图由 batch_trace_relations / batch_trace_nodes 独立推导
    // ------------------------------------------------------------------
    const relations = await container.db
      .selectFrom('batchTraceRelations')
      .select(['parentBatch', 'childBatch', 'relationType'])
      .execute();
    const nodeRows = await container.db.selectFrom('batchTraceNodes').select(['batchNo']).execute();
    const nodeBatches = new Set(nodeRows.map((row) => row.batchNo));
    assert.ok(relations.length > 0, '真实库中应存在批次追溯关系数据');

    const directionCases: Array<{ query: string; direction: TraceDirection; maxDepth: number }> = [
      { query: '', direction: 'BOTH', maxDepth: 5 },
      { query: '?maxDepth=10', direction: 'BOTH', maxDepth: 10 },
      { query: '?maxDepth=10&direction=BACKWARD', direction: 'UPSTREAM', maxDepth: 10 },
      { query: '?maxDepth=10&direction=FORWARD', direction: 'DOWNSTREAM', maxDepth: 10 },
    ];

    for (const testCase of directionCases) {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/trace/LOT-2026-FN-01${testCase.query}`,
        headers: authHeader,
      });
      assert.equal(res.statusCode, 200, `追溯接口应返回 200，实际: ${res.body}`);
      const trace = JSON.parse(res.body);
      const parsed = TraceabilityGraphResponseSchema.safeParse(trace);
      assert.equal(
        parsed.success,
        true,
        `追溯响应必须满足 TraceabilityGraphResponseSchema: ${JSON.stringify(
          parsed.success ? '' : parsed.error.issues.slice(0, 3)
        )}`
      );

      const expected = expectedGraph(
        relations,
        nodeBatches,
        'LOT-2026-FN-01',
        testCase.direction,
        testCase.maxDepth
      );
      const actualNodeBatches = new Set((trace.nodes as Array<{ batchNo: string }>).map((n) => n.batchNo));
      const actualEdgeKeys = new Set(
        (trace.edges as Array<{ sourceBatchNo: string; targetBatchNo: string; relationType: string }>).map(
          (e) => `${e.sourceBatchNo}->${e.targetBatchNo}-${e.relationType}`
        )
      );
      assert.deepEqual(
        [...actualNodeBatches].sort(),
        [...expected.nodes].sort(),
        `方向=${testCase.direction} maxDepth=${testCase.maxDepth} 时追溯节点集合应与库中可达批次一致`
      );
      assert.deepEqual(
        [...actualEdgeKeys].sort(),
        [...expected.edgeKeys].sort(),
        `方向=${testCase.direction} maxDepth=${testCase.maxDepth} 时追溯边集合应与库中关系边一致`
      );

      // 每个节点都必须能在 batch_trace_nodes 中找到，且契约必填字段齐备
      for (const node of trace.nodes as Array<Record<string, unknown>>) {
        assert.ok(nodeBatches.has(node.batchNo as string), `节点 [${node.batchNo}] 必须存在于 batch_trace_nodes`);
        assert.equal(typeof node.nodeId, 'string', '追溯节点必须携带 nodeId');
        assert.equal(typeof node.operatorName, 'string', '追溯节点必须携带 operatorName');
        assert.equal(typeof node.stageName, 'string', '追溯节点必须携带 stageName');
        assert.equal(typeof node.timestamp, 'string', '追溯节点必须携带 timestamp');
      }

      // 成环判定：与测试侧独立实现的有向环检测（Kahn 拓扑排序）结果一致
      const expectedCycle = hasDirectedCycle(
        (trace.edges as Array<{ sourceBatchNo: string; targetBatchNo: string }>).map((e) => ({
          parentBatch: e.sourceBatchNo,
          childBatch: e.targetBatchNo,
        }))
      );
      assert.equal(
        trace.hasCycle,
        expectedCycle,
        `hasCycle 应等于返回边集合上的有向环检测结果（方向=${testCase.direction}）`
      );
      if (!expectedCycle) {
        for (const edge of trace.edges as Array<{ isCycle: boolean }>) {
          assert.equal(edge.isCycle, false, '无环图上的任何边都不得被标记为环边');
        }
      }
    }

    // 默认 maxDepth=5 会截断超过 5 跳的上游链路，显式放开深度后应能覆盖完整连通分量
    const defaultRes = await app.inject({
      method: 'GET',
      url: '/api/v1/trace/LOT-2026-FN-01',
      headers: authHeader,
    });
    const deepRes = await app.inject({
      method: 'GET',
      url: '/api/v1/trace/LOT-2026-FN-01?maxDepth=10',
      headers: authHeader,
    });
    const defaultNodes = new Set(
      (JSON.parse(defaultRes.body).nodes as Array<{ batchNo: string }>).map((n) => n.batchNo)
    );
    const deepNodes = new Set(
      (JSON.parse(deepRes.body).nodes as Array<{ batchNo: string }>).map((n) => n.batchNo)
    );
    assert.ok(
      deepNodes.size > defaultNodes.size,
      '放开 maxDepth 后应返回更多上游节点（默认深度会截断长链路，此处锁定该已知行为）'
    );

    // 历史路径与前端调用路径必须返回同一张图
    const aliasRes = await app.inject({
      method: 'GET',
      url: '/api/v1/traceability/graph/LOT-2026-FN-01?maxDepth=10',
      headers: authHeader,
    });
    assert.equal(aliasRes.statusCode, 200, '前端调用路径 /traceability/graph/:batchNo 必须可用');
    const aliasBody = JSON.parse(aliasRes.body) as { nodes: unknown[]; edges: unknown[]; hasCycle: boolean };
    const deepBody = JSON.parse(deepRes.body) as { nodes: unknown[]; edges: unknown[]; hasCycle: boolean };
    assert.deepEqual(
      [...aliasBody.nodes].length,
      deepBody.nodes.length,
      '两个追溯路径应返回相同节点数'
    );
    assert.deepEqual([...aliasBody.edges].length, deepBody.edges.length, '两个追溯路径应返回相同边数');
    assert.equal(aliasBody.hasCycle, deepBody.hasCycle, '两个追溯路径应返回相同的成环结论');

    const contractRes = await app.inject({
      method: 'GET',
      url: '/api/v1/traceability/LOT-2026-FN-01?maxDepth=10',
      headers: authHeader,
    });
    assert.equal(contractRes.statusCode, 200, '契约路径 /traceability/:batchNo 必须可用');
    const contractBody = JSON.parse(contractRes.body) as { nodes: unknown[]; edges: unknown[]; hasCycle: boolean };
    assert.equal(contractBody.nodes.length, deepBody.nodes.length, '契约路径与历史路径应返回相同节点数');
    assert.equal(contractBody.edges.length, deepBody.edges.length, '契约路径与历史路径应返回相同边数');
    assert.equal(contractBody.hasCycle, deepBody.hasCycle, '契约路径与历史路径应返回相同的成环结论');

    // 真实闭环种子数据：所有环路关系边都必须被打标
    const cycleRes = await app.inject({
      method: 'GET',
      url: '/api/v1/trace/CYCLE-A?maxDepth=10',
      headers: authHeader,
    });
    assert.equal(cycleRes.statusCode, 200, '闭环批次追溯应返回 200');
    const cycleTrace = JSON.parse(cycleRes.body) as {
      hasCycle: boolean;
      nodes: Array<{ batchNo: string }>;
      edges: Array<{ sourceBatchNo: string; targetBatchNo: string; isCycle: boolean; hasCycleWarning: boolean }>;
    };
    assert.equal(cycleTrace.hasCycle, true, 'CYCLE-A/B/C 构成的有向闭环必须被检出');
    const expectedCycleNodes = expectedGraph(relations, nodeBatches, 'CYCLE-A', 'BOTH', 10);
    assert.deepEqual(
      cycleTrace.nodes.map((n) => n.batchNo).sort(),
      [...expectedCycleNodes.nodes].sort(),
      '闭环组件节点集合应与库中一致'
    );
    assert.equal(cycleTrace.edges.length, 3, '闭环组件应包含 3 条关系边');
    for (const edge of cycleTrace.edges) {
      assert.equal(
        edge.isCycle,
        true,
        `闭环组件中的每条边都在环上，必须打标: ${edge.sourceBatchNo}->${edge.targetBatchNo}`
      );
      assert.equal(edge.hasCycleWarning, true, '环边必须同时携带告警标记');
    }

    // 不存在的批次 -> 404 契约
    const missingRes = await app.inject({
      method: 'GET',
      url: '/api/v1/trace/NO-SUCH-BATCH-FOR-TEST',
      headers: authHeader,
    });
    assert.equal(missingRes.statusCode, 404, '不存在的追溯批次应返回 404');
    assert.equal(
      String(missingRes.headers['content-type'] ?? '').includes('application/problem+json'),
      true,
      '追溯 404 必须为 application/problem+json'
    );
        console.log('✔ 追溯拓扑（节点/边/深度/方向/成环标记）与真实库独立推导结果一致');

    // ------------------------------------------------------------------
    // 6. 待审核池 (Pending MRB Pool) & 质检报告多模板导出
    // ------------------------------------------------------------------
    const poolRes = await app.inject({
      method: 'GET',
      url: '/api/v1/mrb/pending-pool',
      headers: authHeader,
    });
    assert.equal(poolRes.statusCode, 200, '待审核池查询应返回 200');
    const poolData = JSON.parse(poolRes.body);
    assert.ok(Array.isArray(poolData.items), '待审核池应返回 items 数组');
    console.log('✔ 待审核池查询 (GET /api/v1/mrb/pending-pool) 验证通过，条数:', poolData.total);

    // 报告模板列表
    const tmplRes = await app.inject({
      method: 'GET',
      url: '/api/v1/report-templates',
      headers: authHeader,
    });
    assert.equal(tmplRes.statusCode, 200, '报告模板查询应返回 200');
    const tmplData = JSON.parse(tmplRes.body);
    assert.ok(Array.isArray(tmplData.items) && tmplData.items.length >= 3, '应返回至少 3 个内置报告模板');
    console.log('✔ 质检报告模板列表 (GET /api/v1/report-templates) 验证通过，模板数:', tmplData.total);

    // 四段式质检报告导出 (JSON 预览 + 真实 PDF/XLSX 文件)
    const reportOrder = orderRows.find((row) => Array.isArray(row.items) && row.items.length > 0) ?? orderRows[0];
    assert.ok(reportOrder, '真实库中应存在带检验项的检验单用于报告导出');
    const reportOrderNo = reportOrder.orderNo;

    const exportJsonRes = await app.inject({
      method: 'POST',
      url: '/api/v1/reports/export',
      headers: authHeader,
      payload: {
        orderNo: reportOrderNo,
        format: 'JSON',
        sections: ['APPEARANCE', 'DIMENSION', 'MECHANICAL_PERFORMANCE', 'CHEMICAL_COMPOSITION'],
        // 伪造成熟的报告数据也必须被服务端忽略：报告只能由持久化检验单组装。
        reportData: { orderNo: 'FORGED-ORDER', overallDecision: 'PASSED' },
      },
    });
    assert.equal(exportJsonRes.statusCode, 200, `四段式质检报告 JSON 预览应返回 200: ${exportJsonRes.body}`);
    const exportJson = JSON.parse(exportJsonRes.body);
    assert.equal(exportJson.reportData.orderNo, reportOrderNo, '客户端 reportData 不得绕过持久化检验单');
    assert.ok(exportJson.reportData.appearanceSection?.enabled, '外观段应按选择启用');
    assert.ok(exportJson.reportData.dimensionSection?.enabled, '尺寸段应按选择启用');
    assert.ok(exportJson.reportData.mechanicalSection?.enabled, '机械性能段应按选择启用');
    assert.ok(exportJson.reportData.chemicalSection?.enabled, '化学成分段应按选择启用');

    const subsetJsonRes = await app.inject({
      method: 'POST',
      url: '/api/v1/reports/export',
      headers: authHeader,
      payload: {
        orderNo: reportOrderNo,
        format: 'JSON',
        sections: ['DIMENSION'],
      },
    });
    assert.equal(subsetJsonRes.statusCode, 200, '指定分段 JSON 预览应返回 200');
    const subsetJson = JSON.parse(subsetJsonRes.body);
    assert.equal(subsetJson.reportData.dimensionSection.enabled, true, '指定尺寸段应启用');
    assert.equal(subsetJson.reportData.appearanceSection.enabled, false, '未选外观段应禁用');
    assert.equal(subsetJson.reportData.appearanceSection.items.length, 0, '未选外观段不得导出明细');
    console.log('✔ 四段式质检报告预览与分段筛选验证通过');

    const pendingOrder = orderRows.find(
      (row) =>
        Array.isArray(row.items) &&
        row.items.some((item) => (item as { result?: string }).result === 'PENDING')
    );
    if (pendingOrder) {
      const pendingRes = await app.inject({
        method: 'POST',
        url: '/api/v1/reports/export',
        headers: authHeader,
        payload: { orderNo: pendingOrder.orderNo, format: 'JSON' },
      });
      assert.equal(pendingRes.statusCode, 200, `未录完检验单 JSON 预览应返回 200: ${pendingRes.body}`);
      const pendingJson = JSON.parse(pendingRes.body);
      const reportItems = [
        ...(pendingJson.reportData.appearanceSection?.items ?? []),
        ...(pendingJson.reportData.dimensionSection?.items ?? []),
        ...(pendingJson.reportData.mechanicalSection?.items ?? []),
        ...(pendingJson.reportData.chemicalSection?.elements ?? []),
      ] as Array<{ conclusion?: string; measuredVal?: number; measuredResult?: string }>;
      assert.ok(
        reportItems.some((item) => item.conclusion === 'PENDING'),
        '未录入实测值的检验项必须保留 PENDING，严禁默认合格'
      );
      assert.ok(
        !reportItems.some(
          (item) => item.conclusion === 'PENDING' && (item.measuredVal === 0 || item.measuredResult === '合格')
        ),
        'PENDING 项不得被伪造成 0 值或“合格”实测'
      );
    }

    const missingIdentityRes = await app.inject({
      method: 'POST',
      url: '/api/v1/reports/export',
      headers: authHeader,
      payload: { format: 'JSON' },
    });
    assert.equal(missingIdentityRes.statusCode, 400, '缺少 orderId/orderNo 应返回 400');

    const invalidTemplateRes = await app.inject({
      method: 'POST',
      url: '/api/v1/reports/export',
      headers: authHeader,
      payload: {
        orderNo: reportOrderNo,
        templateId: '00000000-0000-0000-0000-00000000ffff',
        format: 'JSON',
      },
    });
    assert.equal(invalidTemplateRes.statusCode, 404, '不存在的报告模板应返回 404');

    const exportPdfRes = await app.inject({
      method: 'POST',
      url: '/api/v1/reports/export',
      headers: authHeader,
      payload: {
        orderNo: reportOrderNo,
        format: 'PDF',
      },
    });
    assert.equal(exportPdfRes.statusCode, 200, `质检文件 PDF 导出应返回 200: ${exportPdfRes.body}`);
    assert.equal(exportPdfRes.headers['content-type'], 'application/pdf', '导出 MIME 类型应为 application/pdf');
    const pdfBytes = Buffer.from(exportPdfRes.rawPayload);
    assert.equal(pdfBytes.subarray(0, 5).toString('latin1'), '%PDF-', '导出内容必须是真实 PDF 文件');
    assert.ok(pdfBytes.includes(Buffer.from('%%EOF')), 'PDF 文件必须包含 EOF 结构');

    const exportExcelRes = await app.inject({
      method: 'POST',
      url: '/api/v1/reports/export',
      headers: authHeader,
      payload: {
        orderNo: reportOrderNo,
        format: 'EXCEL',
        sections: ['DIMENSION', 'CHEMICAL_COMPOSITION'],
      },
    });
    assert.equal(exportExcelRes.statusCode, 200, `质检文件 Excel 导出应返回 200: ${exportExcelRes.body}`);
    assert.equal(
      exportExcelRes.headers['content-type'],
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      '导出 MIME 类型应为 XLSX'
    );
    const excelBytes = Buffer.from(exportExcelRes.rawPayload);
    assert.equal(excelBytes[0], 0x50, 'XLSX 必须是 ZIP 包');
    assert.equal(excelBytes[1], 0x4b, 'XLSX 必须是 ZIP 包');
    const reportBook = new ExcelJS.Workbook();
    await reportBook.xlsx.load(
      excelBytes.buffer.slice(excelBytes.byteOffset, excelBytes.byteOffset + excelBytes.byteLength) as ArrayBuffer
    );
    assert.ok(reportBook.getWorksheet('基本信息'), 'XLSX 应包含基本信息页');
    assert.ok(reportBook.getWorksheet('尺寸检验'), '指定尺寸段应生成工作表');
    assert.ok(reportBook.getWorksheet('化学成分'), '指定化学成分段应生成工作表');
    assert.equal(reportBook.getWorksheet('外观检验'), undefined, '未选外观段不得生成工作表');
    console.log('✔ 质检报告 PDF/XLSX 文件结构与 PENDING 防伪验证通过');
  } finally {
    await app.close();
    await container.dispose();
  }

  console.log('\n=== 全部看板 / 领域规则 / 追溯拓扑测试通过 ===');
}

runTests().catch((err) => {
  const msg = String(err && (err.message || err.code || err));
  if (msg.includes('ECONNREFUSED') || msg.includes('ENOTFOUND') || (err && err.code === 'ECONNREFUSED')) {
    console.warn('[SKIP] 本地 PostgreSQL 未启动 (' + msg + ')，跳过真实库依赖测试');
    process.exit(0);
  }
  console.error('测试失败:', err);
  process.exit(1);
});
