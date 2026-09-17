import { sql, type Kysely } from 'kysely';
import type { Database } from '../database/schema.js';

/**
 * 看板聚合读模型 (Kysely + PostgreSQL)
 *
 * 看板指标横跨检验单 / MRB / 审计 / Outbox 多张表，没有单一领域聚合可以承载，
 * 因此单独放一个只读投影类，不进入领域端口。
 *
 * 已明确的口径与局限：
 * 1. 趋势按"工单创建日期"分组，合格率取这些工单的当前状态 —— 库里没有状态变更历史表，
 *    因此无法还原"某天的历史合格率快照"，此处不伪造，仅按当前状态回溯统计；
 * 2. 缺陷 TopN 取自检验单快照里 result=FAILED 的指标项（缺陷名 + 指标分类）；
 * 3. 拦截事件取自审计表中 action=GATE_BLOCKED 的记录，MES 下发状态取自 outbox 事件真实状态；
 *    质检库没有采集物理工位字段，station 用该批次的检验环节替代，不编造工位名。
 */

/** 看板总览（与 /api/v1/dashboard/overview 响应字段一致） */
export interface DashboardOverview {
  totalInspections: number;
  passRate: number;
  pendingCount: number;
  inspectingCount: number;
  failedCount: number;
  inMRBCount: number;
  stageDistribution: { iqcCount: number; ipqcCount: number; oqcCount: number };
  trendSeries: Array<{
    date: string;
    iqcCount: number;
    ipqcCount: number;
    oqcCount: number;
    passRate: number;
  }>;
  topDefects: Array<{ defectName: string; category: string; count: number }>;
  recentActivities: Array<{
    id: string;
    type: string;
    title: string;
    status: string;
    timestamp: string;
  }>;
}

/** 图表看板统计（与 /api/v1/dashboard/stats 响应字段一致，不含设备类指标） */
export interface DashboardStats {
  todayInspections: number;
  yieldRate: number;
  interceptedBatches: number;
  pendingMrb: number;
  defectDistribution: Array<{ name: string; value: number; percentage: string }>;
  weeklyTrend: {
    dates: string[];
    yieldRates: number[];
    inspectionCounts: number[];
    defectCounts: number[];
  };
  interceptionEvents: Array<{
    id: string;
    time: string;
    station: string;
    batch: string;
    item: string;
    mesStatus: string;
  }>;
}

/** 趋势窗口天数（近 7 天） */
const TREND_DAYS = 7;
/** 缺陷 TopN 条数 */
const TOP_DEFECT_LIMIT = 5;
/** 最近动态条数 */
const RECENT_ACTIVITY_LIMIT = 6;

/** 审计资源类别 → 看板动态类型 */
const ACTIVITY_TYPE_BY_RESOURCE: Record<string, string> = {
  INSPECTION_ORDER: 'INSPECTION',
  MRB_RECORD: 'MRB',
  RELEASE_GATE: 'GATE',
  INSPECTION_PLAN: 'PLAN',
  DATA_SYNC: 'SYNC',
  MES_CONFIG: 'SYNC',
};

/** 审计动作 → 中文动作短语 */
const ACTION_LABEL: Record<string, string> = {
  CREATE: '新建',
  UPDATE: '更新',
  STATUS_CHANGE: '状态变更',
  DISPOSE: '处置完成',
  GATE_BLOCKED: '放行拦截',
  AUTH_FAILED: '鉴权失败',
  VALIDATION_REJECTED: '校验拒绝',
  SYNC_TRIGGER: '触发同步',
};

/** outbox 事件状态 → MES 下发状态文案 */
const MES_STATUS_BY_OUTBOX: Record<string, string> = {
  PENDING: '待下发 MES 拦截',
  PUBLISHED: '已下发 MES 拦截',
  FAILED: 'MES 下发失败',
  DEAD_LETTER: 'MES 下发失败',
};

/** 契约检验类型前缀 → 看板工序分组（与旧看板"前缀统计"口径保持一致） */
function stageOf(orderType: string): 'iqc' | 'ipqc' | 'oqc' | null {
  if (orderType.startsWith('IQC')) return 'iqc';
  if (orderType.startsWith('IPQC')) return 'ipqc';
  if (orderType.startsWith('OQC')) return 'oqc';
  return null;
}

function toDateKey(date: Date): string {
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, '0');
  const day = `${date.getDate()}`.padStart(2, '0');
  return `${year}-${month}-${day}`;
}

const WEEKDAY_LABELS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

export class KyselyDashboardRepository {
  constructor(private readonly db: Kysely<Database>) {}

  public async getOverview(): Promise<DashboardOverview> {
    const statusRows = await this.db
      .selectFrom('inspectionOrders')
      .select((eb) => ['status', eb.fn.countAll().as('count')])
      .groupBy('status')
      .execute();

    const statusCounts: Record<string, number> = {};
    for (const row of statusRows) {
      statusCounts[row.status] = Number(row.count);
    }

    const totalInspections = Object.values(statusCounts).reduce((sum, value) => sum + value, 0);
    // 合格口径包含已判定合格(PASSED)与已结单归档(COMPLETED)两类
    const passedCount = (statusCounts['PASSED'] ?? 0) + (statusCounts['COMPLETED'] ?? 0);
    const passRate =
      totalInspections > 0 ? Number(((passedCount / totalInspections) * 100).toFixed(2)) : 0;

    const typeRows = await this.db
      .selectFrom('inspectionOrders')
      .select((eb) => ['orderType', eb.fn.countAll().as('count')])
      .groupBy('orderType')
      .execute();

    const stageDistribution = { iqcCount: 0, ipqcCount: 0, oqcCount: 0 };
    for (const row of typeRows) {
      const stage = stageOf(row.orderType);
      const count = Number(row.count);
      if (stage === 'iqc') stageDistribution.iqcCount += count;
      else if (stage === 'ipqc') stageDistribution.ipqcCount += count;
      else if (stage === 'oqc') stageDistribution.oqcCount += count;
    }

    const mrbInReviewCount = await this.countMrbInReview();

    // 原生 SQL 的结果列名会被 CamelCasePlugin 按 snake_case -> camelCase 重写，
    // 这里显式加带引号的别名固定键名（与 batch-trace-repository 的写法一致）。
    const dayRows = await sql<{
      day: string;
      orderType: string;
      total: string;
      passed: string;
    }>`
      SELECT to_char(created_at, 'YYYY-MM-DD') AS day,
             order_type AS "orderType",
             count(*)::int AS total,
             count(*) FILTER (WHERE status IN ('PASSED', 'COMPLETED'))::int AS passed
      FROM inspection_orders
      GROUP BY 1, 2
    `.execute(this.db);

    const trendSeries = this.buildTrend(dayRows.rows);

    const defectRows = await this.queryFailedItems(TOP_DEFECT_LIMIT);
    const topDefects = defectRows.map((row) => ({
      defectName: row.name,
      category: row.category,
      count: row.count,
    }));

    const recentActivities = await this.queryRecentActivities();

    return {
      totalInspections,
      passRate,
      pendingCount: statusCounts['PENDING'] ?? 0,
      inspectingCount: statusCounts['INSPECTING'] ?? 0,
      failedCount: statusCounts['FAILED'] ?? 0,
      inMRBCount: mrbInReviewCount,
      stageDistribution,
      trendSeries,
      topDefects,
      recentActivities,
    };
  }

  public async getStats(): Promise<DashboardStats> {
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    const todayRow = await this.db
      .selectFrom('inspectionOrders')
      .select((eb) => eb.fn.countAll().as('total'))
      .where('createdAt', '>=', todayStart)
      .executeTakeFirst();

    const statusRows = await this.db
      .selectFrom('inspectionOrders')
      .select((eb) => ['status', eb.fn.countAll().as('count')])
      .groupBy('status')
      .execute();

    const statusCounts: Record<string, number> = {};
    let totalOrders = 0;
    for (const row of statusRows) {
      const count = Number(row.count);
      statusCounts[row.status] = count;
      totalOrders += count;
    }
    const passedCount =
      (statusCounts['PASSED'] ?? 0) + (statusCounts['COMPLETED'] ?? 0) + (statusCounts['IN_MRB_REVIEW'] ?? 0);
    const yieldRate = totalOrders > 0 ? Number(((passedCount / totalOrders) * 100).toFixed(2)) : 0;

    const mrbPendingRow = await this.db
      .selectFrom('mrbReviews')
      .select((eb) => eb.fn.countAll().as('total'))
      .where('status', '=', 'PENDING_REVIEW')
      .executeTakeFirst();

    const interceptedRow = await sql<{ total: string }>`
      SELECT count(DISTINCT entity_id)::int AS total
      FROM audit_logs
      WHERE action = 'GATE_BLOCKED'
    `.execute(this.db);

    const defectRows = await this.queryFailedItems(TOP_DEFECT_LIMIT);
    const defectTotal = defectRows.reduce((sum, row) => sum + row.count, 0);
    const defectDistribution = defectRows.map((row) => ({
      name: row.name,
      value: row.count,
      percentage: defectTotal > 0 ? `${((row.count / defectTotal) * 100).toFixed(1)}%` : '0.0%',
    }));

    const defectDayRows = await sql<{ day: string; total: string }>`
      SELECT to_char(o.created_at, 'YYYY-MM-DD') AS day, count(*)::int AS total
      FROM inspection_orders o, jsonb_array_elements(o.items) AS item
      WHERE item->>'result' = 'FAILED'
      GROUP BY 1
    `.execute(this.db);

    const dayRows = await sql<{
      day: string;
      total: string;
      passed: string;
    }>`
      SELECT to_char(created_at, 'YYYY-MM-DD') AS day,
             count(*)::int AS total,
             count(*) FILTER (WHERE status IN ('PASSED', 'COMPLETED', 'IN_MRB_REVIEW'))::int AS passed
      FROM inspection_orders
      GROUP BY 1
    `.execute(this.db);

    const weeklyTrend = this.buildWeeklyTrend(dayRows.rows, defectDayRows.rows);
    const interceptionEvents = await this.queryInterceptionEvents();

    return {
      todayInspections: todayRow ? Number(todayRow.total) : 0,
      yieldRate,
      interceptedBatches: interceptedRow.rows[0] ? Number(interceptedRow.rows[0].total) : 0,
      pendingMrb: mrbPendingRow ? Number(mrbPendingRow.total) : 0,
      defectDistribution,
      weeklyTrend,
      interceptionEvents,
    };
  }

  /** MRB 评审中（待评审 + 会签中）数量 */
  private async countMrbInReview(): Promise<number> {
    const row = await this.db
      .selectFrom('mrbReviews')
      .select((eb) => eb.fn.countAll().as('total'))
      .where('status', 'in', ['PENDING_REVIEW', 'UNDER_REVIEW'])
      .executeTakeFirst();

    return row ? Number(row.total) : 0;
  }

  /** 检验项缺陷 TopN（JSONB 明细里 result=FAILED 的指标项按名称归类） */
  private async queryFailedItems(limit: number): Promise<Array<{ name: string; category: string; count: number }>> {
    const result = await sql<{ name: string; category: string; count: string }>`
      SELECT item->>'name' AS name,
             coalesce(item->>'metricCategory', 'DIMENSION') AS category,
             count(*)::int AS count
      FROM inspection_orders o, jsonb_array_elements(o.items) AS item
      WHERE item->>'result' = 'FAILED'
      GROUP BY 1, 2
      ORDER BY count DESC, name ASC
      LIMIT ${limit}
    `.execute(this.db);

    return result.rows.map((row) => ({
      name: row.name,
      category: row.category,
      count: Number(row.count),
    }));
  }

  private async queryRecentActivities(): Promise<DashboardOverview['recentActivities']> {
    const rows = await this.db
      .selectFrom('auditLogs')
      .select(['id', 'entityName', 'entityId', 'action', 'status', 'occurredAt'])
      .orderBy('occurredAt', 'desc')
      .limit(RECENT_ACTIVITY_LIMIT)
      .execute();

    return rows.map((row) => ({
      id: row.id,
      type: ACTIVITY_TYPE_BY_RESOURCE[row.entityName] ?? 'AUDIT',
      title: `${row.entityId} ${ACTION_LABEL[row.action] ?? row.action}`,
      status: row.status,
      timestamp: row.occurredAt.toISOString(),
    }));
  }

  /**
   * 拦截事件：审计表中的放行拦截记录
   *   item      = 审计里记录的拦截原因；
   *   station   = 该批次检验单的检验环节（质检库未采集物理工位）；
   *   mesStatus = outbox 中该批次拦截事件的真实下发状态。
   */
  private async queryInterceptionEvents(): Promise<DashboardStats['interceptionEvents']> {
    const rows = await this.db
      .selectFrom('auditLogs')
      .leftJoin('inspectionOrders', 'inspectionOrders.batchNo', 'auditLogs.entityId')
      .leftJoin('outboxEvents', (join) =>
        join
          .onRef('outboxEvents.aggregateId', '=', 'auditLogs.entityId')
          .on('outboxEvents.eventType', '=', 'RELEASE_GATE_BLOCKED')
      )
      .select([
        'auditLogs.id as id',
        'auditLogs.entityId as batchNo',
        'auditLogs.diffPatch as diffPatch',
        'auditLogs.occurredAt as occurredAt',
        'inspectionOrders.orderType as orderType',
        'outboxEvents.status as outboxStatus',
      ])
      .where('auditLogs.action', '=', 'GATE_BLOCKED')
      .orderBy('auditLogs.occurredAt', 'desc')
      .limit(RECENT_ACTIVITY_LIMIT)
      .execute();

    return rows.map((row) => {
      const patch = row.diffPatch as Record<string, unknown>;
      const reason = typeof patch['reason'] === 'string' ? patch['reason'] : '放行被阻断';
      const occurredAt = row.occurredAt;
      const time = `${`${occurredAt.getHours()}`.padStart(2, '0')}:${`${occurredAt.getMinutes()}`.padStart(2, '0')}:${`${occurredAt.getSeconds()}`.padStart(2, '0')}`;

      return {
        id: row.id,
        time,
        station: row.orderType !== null ? `${row.orderType} 检验环节` : '检验环节未采集',
        batch: row.batchNo,
        item: reason,
        mesStatus:
          row.outboxStatus !== null
            ? MES_STATUS_BY_OUTBOX[row.outboxStatus] ?? 'MES 状态未知'
            : '未生成 MES 拦截事件',
      };
    });
  }

  /** 近 7 天趋势（工单创建日分组） */
  private buildTrend(
    rows: Array<{ day: string; orderType: string; total: string; passed: string }>
  ): DashboardOverview['trendSeries'] {
    const byDay = new Map<string, { iqc: number; ipqc: number; oqc: number; total: number; passed: number }>();

    for (const row of rows) {
      const bucket = byDay.get(row.day) ?? { iqc: 0, ipqc: 0, oqc: 0, total: 0, passed: 0 };
      const stage = stageOf(row.orderType);
      const total = Number(row.total);
      if (stage === 'iqc') bucket.iqc += total;
      else if (stage === 'ipqc') bucket.ipqc += total;
      else if (stage === 'oqc') bucket.oqc += total;
      bucket.total += total;
      bucket.passed += Number(row.passed);
      byDay.set(row.day, bucket);
    }

    return this.lastDays(TREND_DAYS, byDay.keys()).map((date) => {
      const bucket = byDay.get(date);
      if (!bucket) {
        return { date, iqcCount: 0, ipqcCount: 0, oqcCount: 0, passRate: 0 };
      }
      return {
        date,
        iqcCount: bucket.iqc,
        ipqcCount: bucket.ipqc,
        oqcCount: bucket.oqc,
        passRate: bucket.total > 0 ? Number(((bucket.passed / bucket.total) * 100).toFixed(2)) : 0,
      };
    });
  }

  private buildWeeklyTrend(
    dayRows: Array<{ day: string; total: string; passed: string }>,
    defectRows: Array<{ day: string; total: string }>
  ): DashboardStats['weeklyTrend'] {
    const byDay = new Map<string, { total: number; passed: number }>();
    for (const row of dayRows) {
      byDay.set(row.day, { total: Number(row.total), passed: Number(row.passed) });
    }

    const defectsByDay = new Map<string, number>();
    for (const row of defectRows) {
      defectsByDay.set(row.day, Number(row.total));
    }

    const dates = this.lastDays(TREND_DAYS, byDay.keys());
    return {
      // x 轴标签取该日真实星期（周一…周日），不再写死序列
      dates: dates.map((date) => WEEKDAY_LABELS[new Date(`${date}T00:00:00`).getDay()] ?? date),
      yieldRates: dates.map((date) => {
        const bucket = byDay.get(date);
        if (!bucket || bucket.total === 0) return 0;
        return Number(((bucket.passed / bucket.total) * 100).toFixed(2));
      }),
      inspectionCounts: dates.map((date) => byDay.get(date)?.total ?? 0),
      defectCounts: dates.map((date) => defectsByDay.get(date) ?? 0),
    };
  }

  /**
   * 取最近 N 天的日期（含今天，升序）。
   *
   * 若库里最新业务日期早于今天（历史数据集），窗口右端回退到该业务日期，
   * 否则整条曲线全是 0、看板看不出任何趋势；此处只回退统计窗口，不编造数据。
   */
  private lastDays(days: number, existing: Iterable<string>): string[] {
    const keys = Array.from(existing).sort();
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const latest = keys.length > 0 ? keys[keys.length - 1] : undefined;
    const end = latest !== undefined && latest < toDateKey(today) ? new Date(`${latest}T00:00:00`) : today;

    const result: string[] = [];
    for (let offset = days - 1; offset >= 0; offset -= 1) {
      const day = new Date(end);
      day.setDate(end.getDate() - offset);
      result.push(toDateKey(day));
    }
    return result;
  }
}
