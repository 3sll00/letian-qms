import { Kysely } from 'kysely';
import type { MRBReviewRepository as IMRBReviewRepository } from '@letian/domain';
import type {
  MaterialPermission,
  MRBDisposition,
  MRBFailCategory,
  MRBReview,
  MRBStatus,
  MRBUrgencyLevel,
} from '@letian/contracts';
import type { Database, MrbReviewInsert, MrbReviewRow } from '../database/schema.js';
import { buildMaterialPermissionWhere } from './pbac-sql-translator.js';

/** PostgreSQL uuid 列不接受非 uuid 文本，按 id 查询前先做格式判断避免 22P02 错误 */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 契约 MRBFailCategoryEnum 的 4 个合法取值 */
const SOURCE_TYPES: readonly string[] = [
  'INCOMING_FAIL',
  'PROCESS_FAIL',
  'SHIPMENT_FAIL',
  'SUBCONTRACT_FAIL',
];

/** 契约 MRBStatusEnum 的 4 个合法取值 */
const MRB_STATUSES: readonly string[] = ['PENDING_REVIEW', 'UNDER_REVIEW', 'DISPOSED', 'REJECTED'];

/** 契约 MRBDispositionEnum 的 4 个合法处置方式 */
const MRB_DISPOSITIONS: readonly string[] = ['RETURN_TO_VENDOR', 'REWORK', 'CONCESSION', 'SCRAP'];

/** 契约 MRBUrgencyLevelEnum 的 3 个合法紧急程度（DB 列为 varchar，读侧收敛回枚举） */
const MRB_URGENCY_LEVELS: readonly string[] = ['NORMAL', 'URGENT', 'CRITICAL'];

function toUrgencyLevel(value: string): MRBUrgencyLevel {
  return MRB_URGENCY_LEVELS.includes(value) ? (value as MRBUrgencyLevel) : 'NORMAL';
}

/** 读侧投影：MRB 列表查询结果（KPI 字段与契约 PaginatedMRBRecords 对齐） */
export interface MRBListResult {
  total: number;
  pendingCount: number;
  underReviewCount: number;
  totalReviewedCount: number;
  disposedCount: number;
  monthlyReviewRate: number;
  items: MRBReview[];
}

function toSourceType(value: string): MRBFailCategory {
  if (!SOURCE_TYPES.includes(value)) {
    throw new Error(`MRB_SOURCE_TYPE_INVALID: 非法的不合格来源类型 [${value}]`);
  }
  return value as MRBFailCategory;
}

function toMrbStatus(value: string): MRBStatus {
  if (!MRB_STATUSES.includes(value)) {
    throw new Error(`MRB_STATUS_INVALID: 非法的 MRB 状态 [${value}]`);
  }
  return value as MRBStatus;
}

function toMrbDisposition(value: string): MRBDisposition {
  if (!MRB_DISPOSITIONS.includes(value)) {
    throw new Error(`MRB_DISPOSITION_INVALID: 非法的 MRB 处置方式 [${value}]`);
  }
  return value as MRBDisposition;
}

/**
 * 模糊检索通配符转义：用户输入中的 % 与 _ 属于 LIKE 元字符，
 * 不转义会让“按单号搜索”退化成全表匹配（口径失真）。
 */
function likePattern(value: string): string {
  return `%${value.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
}

/**
 * MRB 评审单仓储 (Kysely + PostgreSQL)
 *
 * 注意：契约 DTO 不含 workshopCode，因此 workshop_code 只在首次插入时写 NULL，
 * 冲突更新时刻意不动，避免覆盖其他链路写入的车间归属。
 */
export class KyselyMRBReviewRepository implements IMRBReviewRepository {
  constructor(private readonly db: Kysely<Database>) {}

  public async findById(id: string): Promise<MRBReview | null> {
    if (!UUID_PATTERN.test(id)) {
      return null;
    }

    const row = await this.db
      .selectFrom('mrbReviews')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();

    return row ? this.mapRow(row) : null;
  }

  /** 按批次号取最新的评审单（放行关卡按批次校验特采结论时使用） */
  public async findByBatchNo(batchNo: string): Promise<MRBReview | null> {
    const row = await this.db
      .selectFrom('mrbReviews')
      .selectAll()
      .where('batchNo', '=', batchNo)
      .orderBy('updatedAt', 'desc')
      .executeTakeFirst();

    return row ? this.mapRow(row) : null;
  }

  /**
   * 读侧投影：MRB 列表分页 + KPI 统计（仅用于 API 列表页）
   *
   * monthlyReviewRate 口径：本月创建的评审单中已处置(DISPOSED)占比；
   * 本月无单据时返回 0，避免除零与"凭空 88.9%"式假数据。
   */
  public async listMrbReviews(query: {
    sourceType?: string;
    /** 单状态过滤（兼容既有调用） */
    status?: string;
    /** 多状态过滤（列表页「已评审」= DISPOSED + REJECTED 需要）；与 status 同时给出时以本条为准 */
    statuses?: readonly string[];
    /** MRB 单号模糊检索 */
    mrbNo?: string;
    /** 来源检验单号模糊检索 */
    sourceOrderNo?: string;
    /** 处置方式过滤（退货 / 返工 / 特采 / 报废） */
    disposition?: string;
    /** 发现日期下界（含） */
    createdFrom?: Date;
    /** 发现日期上界（不含），由控制器按「日界右开区间」计算 */
    createdToExclusive?: Date;
    /** 三维 PBAC 权限过滤（MRB 表无供应商列，限定供应商的规则按 fail-closed 不匹配） */
    permissions?: readonly MaterialPermission[];
    page: number;
    pageSize: number;
  }): Promise<MRBListResult> {
    let listQuery = this.db.selectFrom('mrbReviews').selectAll();
    let countQuery = this.db.selectFrom('mrbReviews').select((eb) => eb.fn.countAll().as('total'));

    if (query.sourceType !== undefined) {
      const sourceType = toSourceType(query.sourceType);
      listQuery = listQuery.where('sourceType', '=', sourceType);
      countQuery = countQuery.where('sourceType', '=', sourceType);
    }
    const statuses =
      query.statuses !== undefined && query.statuses.length > 0
        ? query.statuses.map((value) => toMrbStatus(value))
        : query.status !== undefined
          ? [toMrbStatus(query.status)]
          : [];
    if (statuses.length > 0) {
      listQuery = listQuery.where('status', 'in', statuses);
      countQuery = countQuery.where('status', 'in', statuses);
    }
    if (query.mrbNo !== undefined) {
      const pattern = likePattern(query.mrbNo);
      listQuery = listQuery.where('mrbNo', 'ilike', pattern);
      countQuery = countQuery.where('mrbNo', 'ilike', pattern);
    }
    if (query.sourceOrderNo !== undefined) {
      const pattern = likePattern(query.sourceOrderNo);
      listQuery = listQuery.where('sourceOrderNo', 'ilike', pattern);
      countQuery = countQuery.where('sourceOrderNo', 'ilike', pattern);
    }
    if (query.disposition !== undefined) {
      const disposition = toMrbDisposition(query.disposition);
      listQuery = listQuery.where('disposition', '=', disposition);
      countQuery = countQuery.where('disposition', '=', disposition);
    }
    if (query.createdFrom !== undefined) {
      listQuery = listQuery.where('createdAt', '>=', query.createdFrom);
      countQuery = countQuery.where('createdAt', '>=', query.createdFrom);
    }
    if (query.createdToExclusive !== undefined) {
      listQuery = listQuery.where('createdAt', '<', query.createdToExclusive);
      countQuery = countQuery.where('createdAt', '<', query.createdToExclusive);
    }
    if (query.permissions !== undefined) {
      const pbacWhere = buildMaterialPermissionWhere(query.permissions, {
        targetRef: 'mrb_reviews',
        hasSupplierColumn: false,
      });
      listQuery = listQuery.where(pbacWhere);
      countQuery = countQuery.where(pbacWhere);
    }

    const rows = await listQuery
      .orderBy('createdAt', 'desc')
      .limit(query.pageSize)
      .offset((query.page - 1) * query.pageSize)
      .execute();

    // 读侧派生「检验人」：mrb_reviews 无该物理列，按 source_order_no = order_no 关联 inspection_orders 带出。
    // 用一次 IN 查询构建映射，避免 N+1 与 join 列表投影的类型歧义。
    const sourceOrderNos = [...new Set(rows.map((row) => row.sourceOrderNo))];
    const inspectorByOrderNo = new Map<string, string>();
    if (sourceOrderNos.length > 0) {
      const inspectorRows = await this.db
        .selectFrom('inspectionOrders')
        .select(['orderNo', 'inspectorName'])
        .where('orderNo', 'in', sourceOrderNos)
        .execute();
      for (const row of inspectorRows) {
        if (row.inspectorName !== null && row.inspectorName !== undefined) {
          inspectorByOrderNo.set(row.orderNo, row.inspectorName);
        }
      }
    }

    const countRow = await countQuery.executeTakeFirst();

    const statusRows = await this.db
      .selectFrom('mrbReviews')
      .select((eb) => ['status', eb.fn.countAll().as('count')])
      .groupBy('status')
      .execute();

    const statusCounts: Record<string, number> = {};
    for (const row of statusRows) {
      statusCounts[row.status] = Number(row.count);
    }

    const monthStart = new Date();
    monthStart.setDate(1);
    monthStart.setHours(0, 0, 0, 0);

    const monthRows = await this.db
      .selectFrom('mrbReviews')
      .select((eb) => ['status', eb.fn.countAll().as('count')])
      .where('createdAt', '>=', monthStart)
      .groupBy('status')
      .execute();

    const monthCounts: Record<string, number> = {};
    for (const row of monthRows) {
      monthCounts[row.status] = Number(row.count);
    }
    const monthTotal = Object.values(monthCounts).reduce((sum, value) => sum + value, 0);
    const disposedCount = statusCounts['DISPOSED'] ?? 0;
    const monthlyReviewRate =
      monthTotal > 0 ? Number((((monthCounts['DISPOSED'] ?? 0) / monthTotal) * 100).toFixed(2)) : 0;

    return {
      total: countRow ? Number(countRow.total) : 0,
      pendingCount: statusCounts['PENDING_REVIEW'] ?? 0,
      underReviewCount: statusCounts['UNDER_REVIEW'] ?? 0,
      // 累计已评审口径与前端 mock 层保持一致：评审中 + 已处置 + 已驳回
      totalReviewedCount:
        (statusCounts['UNDER_REVIEW'] ?? 0) +
        disposedCount +
        (statusCounts['REJECTED'] ?? 0),
      disposedCount,
      monthlyReviewRate,
      items: rows.map((row) => {
        const record = this.mapRow(row);
        const inspectorName = inspectorByOrderNo.get(row.sourceOrderNo);
        // 可空派生列一律条件展开，绝不写入 undefined（exactOptionalPropertyTypes）
        return inspectorName !== undefined ? { ...record, inspectorName } : record;
      }),
    };
  }

  public async findByReviewNo(reviewNo: string): Promise<MRBReview | null> {
    const row = await this.db
      .selectFrom('mrbReviews')
      .selectAll()
      .where('mrbNo', '=', reviewNo)
      .executeTakeFirst();

    return row ? this.mapRow(row) : null;
  }

  public async findByOrderNo(orderNo: string): Promise<MRBReview | null> {
    const row = await this.db
      .selectFrom('mrbReviews')
      .selectAll()
      .where('sourceOrderNo', '=', orderNo)
      .orderBy('updatedAt', 'desc')
      .executeTakeFirst();

    return row ? this.mapRow(row) : null;
  }

  public async save(review: MRBReview): Promise<void> {
    const now = new Date();

    const writable = {
      mrbNo: review.mrbNo,
      sourceType: review.sourceType,
      sourceOrderNo: review.sourceOrderNo,
      batchNo: review.batchNo,
      materialCode: review.materialCode,
      materialName: review.materialName,
      defectDescription: review.defectDescription,
      defectQty: review.defectQty,
      status: review.status,
      disposition: review.disposition ?? null,
      dispositionNotes: review.dispositionNotes ?? null,
      approvers: JSON.stringify(review.approvers),
      concessionAttachmentUrl: review.concessionAttachmentUrl ?? null,
      // 015：发起参数与处置闭环字段
      pendingDefectId: review.pendingDefectId ?? null,
      reviewFlowId: review.reviewFlowId ?? null,
      urgencyLevel: review.urgencyLevel,
      reviewNotes: review.reviewNotes ?? null,
      disposedAt: review.disposedAt !== undefined ? new Date(review.disposedAt) : null,
      disposedBy: review.disposedBy ?? null,
      updatedAt: now,
    };

    const insertValues: MrbReviewInsert = {
      ...writable,
      workshopCode: null,
      ...(review.id !== undefined ? { id: review.id } : {}),
    };

    await this.db
      .insertInto('mrbReviews')
      .values(insertValues)
      .onConflict((oc) => oc.column('mrbNo').doUpdateSet(writable))
      .execute();
  }

  private mapRow(row: MrbReviewRow): MRBReview {
    return {
      id: row.id,
      mrbNo: row.mrbNo,
      sourceType: row.sourceType,
      sourceOrderNo: row.sourceOrderNo,
      batchNo: row.batchNo,
      materialCode: row.materialCode,
      materialName: row.materialName,
      defectDescription: row.defectDescription,
      defectQty: Number(row.defectQty),
      status: row.status,
      approvers: row.approvers,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      urgencyLevel: toUrgencyLevel(row.urgencyLevel),
      // 可空列一律用条件展开省略，绝不写入 undefined
      ...(row.disposition !== null ? { disposition: row.disposition } : {}),
      ...(row.dispositionNotes !== null ? { dispositionNotes: row.dispositionNotes } : {}),
      ...(row.concessionAttachmentUrl !== null
        ? { concessionAttachmentUrl: row.concessionAttachmentUrl }
        : {}),
      ...(row.pendingDefectId !== null ? { pendingDefectId: row.pendingDefectId } : {}),
      ...(row.reviewFlowId !== null ? { reviewFlowId: row.reviewFlowId } : {}),
      ...(row.reviewNotes !== null ? { reviewNotes: row.reviewNotes } : {}),
      ...(row.disposedAt !== null ? { disposedAt: row.disposedAt.toISOString() } : {}),
      ...(row.disposedBy !== null ? { disposedBy: row.disposedBy } : {}),
    };
  }
}
