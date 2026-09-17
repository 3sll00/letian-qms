import { sql, type Expression, type ExpressionBuilder, type Kysely, type SqlBool } from 'kysely';
import type { InspectionOrderRepository as IInspectionOrderRepository } from '@letian/domain';
import type { InspectionOrder, InspectionStatus, InspectionType } from '@letian/contracts';
import type {
  Database,
  InspectionOrderRow,
  InspectionOrderUpdate,
} from '../database/schema.js';

/** 契约 InspectionStatusEnum 的 8 个合法取值，用于把 string 收窄为 InspectionStatus */
const INSPECTION_STATUSES: readonly string[] = [
  'PENDING',
  'INSPECTING',
  'DRAFT',
  'PASSED',
  'FAILED',
  'IN_MRB_REVIEW',
  'RE_INSPECTING',
  'COMPLETED',
];

/** PostgreSQL uuid 列不接受非 uuid 文本，按 id 查询前先做格式判断避免 22P02 错误 */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 契约 InspectionTypeEnum 的 6 个合法取值 */
const INSPECTION_TYPES: readonly string[] = [
  'IQC',
  'IPQC_CT',
  'IPQC_RL',
  'IPQC_FN',
  'OQC_SF',
  'OQC_SH',
];

function isInspectionType(value: string): value is InspectionType {
  return INSPECTION_TYPES.includes(value);
}

/** 把外部传入的检验类型字符串收窄为契约枚举，非法取值直接报错而不是静默全表扫描 */
function toInspectionType(value: string): InspectionType {
  if (!isInspectionType(value)) {
    throw new Error(`ORDER_TYPE_INVALID: 非法的检验类型 [${value}]`);
  }
  return value;
}

/** ILIKE 模式串转义：% 与 _ 是通配符，用户输入必须按字面量匹配 */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

function isInspectionStatus(value: string): value is InspectionStatus {
  return INSPECTION_STATUSES.includes(value);
}

/** 把外部传入的状态字符串收窄为契约枚举，非法取值直接报错而不是静默返回空列表 */
function toInspectionStatus(value: string): InspectionStatus {
  if (!isInspectionStatus(value)) {
    throw new Error(`ORDER_STATUS_INVALID: 非法的检验工单状态 [${value}]`);
  }
  return value;
}

/** 检验单台账列表查询条件（读侧投影，不属于领域端口） */
export interface OrderListQuery {
  inspectionType?: string;
  /** 前端页签分组（IQC/IPQC/FQC/OQC）对应的类型集合，与 inspectionType 互斥使用 */
  inspectionTypes?: readonly string[];
  status?: string;
  batchNo?: string;
  materialCode?: string;
  /** 批次号 / 物料编码 / 物料名称 / 工单号 的模糊匹配 */
  keyword?: string;
  page: number;
  pageSize: number;
}

/** 检验单台账列表查询结果：当页数据 + 命中总数 + 全表状态计数 */
export interface OrderListResult {
  total: number;
  list: InspectionOrder[];
  statusCounts: Record<string, number>;
}

/**
 * 检验工单仓储 (Kysely + PostgreSQL)
 *
 * 注意：契约 DTO 既没有 batchQty 也没有 workshopCode，
 * 因此 total_qty / workshop_code 只在首次插入时写 NULL，冲突更新时刻意不动，
 * 避免把 ERP/MES 同步写入的原始批量与车间信息覆盖掉。
 */
export class KyselyInspectionOrderRepository implements IInspectionOrderRepository {
  constructor(private readonly db: Kysely<Database>) {}

  public async findById(id: string): Promise<InspectionOrder | null> {
    if (!UUID_PATTERN.test(id)) {
      return null;
    }

    const row = await this.db
      .selectFrom('inspectionOrders')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();

    return row ? this.mapRow(row) : null;
  }

  public async findByOrderNo(orderNo: string): Promise<InspectionOrder | null> {
    const row = await this.db
      .selectFrom('inspectionOrders')
      .selectAll()
      .where('orderNo', '=', orderNo)
      .executeTakeFirst();

    return row ? this.mapRow(row) : null;
  }

  public async findByBatchNo(batchNo: string): Promise<readonly InspectionOrder[]> {
    const rows = await this.db
      .selectFrom('inspectionOrders')
      .selectAll()
      .where('batchNo', '=', batchNo)
      .orderBy('createdAt', 'asc')
      .execute();

    return rows.map((row) => this.mapRow(row));
  }

  public async save(order: InspectionOrder): Promise<void> {
    const now = new Date();

    // 插入值内联书写（不预先标注 Insertable 类型），让 Kysely 按 ValueExpression 逐列校验
    await this.db
      .insertInto('inspectionOrders')
      .values({
        orderNo: order.orderNo,
        // plan_id 只能从方案快照里取，DTO 本身不直接暴露 planId
        planId: order.planSnapshot.planId,
        orderType: order.inspectionType,
        batchNo: order.batchNo,
        materialCode: order.materialCode,
        materialName: order.materialName,
        supplierCode: order.supplierCode ?? null,
        customerCode: order.customerCode ?? null,
        inspectorId: order.inspectorId ?? null,
        totalQty: null,
        workshopCode: null,
        sampleQty: order.sampleQty,
        passQty: order.passQty,
        failQty: order.failQty,
        isMandatoryGate: order.isMandatoryGate,
        status: order.status,
        judgment: order.overallDecision ?? null,
        inspectionNotes: order.inspectionNotes ?? null,
        planVersionId: order.planVersionId,
        // jsonb 列必须显式字符串化：node-postgres 会把 JS 数组渲染成 PG 数组字面量("{"a","b"}")，
        // 该文本不是合法 JSON，PG 会直接报 22P02 invalid input syntax for type json
        planSnapshot: JSON.stringify(order.planSnapshot),
        items: JSON.stringify(order.items),
        updatedAt: now,
        ...(order.id !== undefined ? { id: order.id } : {}),
      })
      .onConflict((oc) =>
        oc.column('orderNo').doUpdateSet({
          orderType: order.inspectionType,
          planId: order.planSnapshot.planId,
          batchNo: order.batchNo,
          materialCode: order.materialCode,
          materialName: order.materialName,
          supplierCode: order.supplierCode ?? null,
          customerCode: order.customerCode ?? null,
          inspectorId: order.inspectorId ?? null,
          sampleQty: order.sampleQty,
          // 更新路径下 Kysely 已解包该列类型，直接传 number 即可
          passQty: order.passQty,
          failQty: order.failQty,
          isMandatoryGate: order.isMandatoryGate,
          status: order.status,
          judgment: order.overallDecision ?? null,
          inspectionNotes: order.inspectionNotes ?? null,
          planVersionId: order.planVersionId,
          planSnapshot: JSON.stringify(order.planSnapshot),
          items: JSON.stringify(order.items),
          updatedAt: now,
        })
      )
      .execute();
  }

  /**
   * 读侧投影：检验单台账分页列表 + 全表状态计数
   * 仅用于 API 列表页，不参与领域写路径。
   */
  public async listOrders(query: OrderListQuery): Promise<OrderListResult> {
    const filter = (eb: ExpressionBuilder<Database, 'inspectionOrders'>): Expression<SqlBool> => {
      const list: Expression<SqlBool>[] = [];
      if (query.inspectionType !== undefined) {
        list.push(eb('orderType', '=', toInspectionType(query.inspectionType)));
      } else if (query.inspectionTypes !== undefined && query.inspectionTypes.length > 0) {
        list.push(eb('orderType', 'in', query.inspectionTypes.map((v) => toInspectionType(v))));
      }
      if (query.status !== undefined) {
        list.push(eb('status', '=', toInspectionStatus(query.status)));
      }
      if (query.batchNo !== undefined) {
        list.push(eb('batchNo', 'ilike', `%${escapeLike(query.batchNo)}%`));
      }
      if (query.materialCode !== undefined) {
        list.push(eb('materialCode', 'ilike', `%${escapeLike(query.materialCode)}%`));
      }
      if (query.keyword !== undefined && query.keyword !== '') {
        const pattern = `%${escapeLike(query.keyword)}%`;
        list.push(
          eb.or([
            eb('batchNo', 'ilike', pattern),
            eb('materialCode', 'ilike', pattern),
            eb('materialName', 'ilike', pattern),
            eb('orderNo', 'ilike', pattern),
          ])
        );
      }
      // 同一组筛选条件必须同时作用于分页查询与计数查询，否则 total 与数据不一致
      return list.length > 0 ? eb.and(list) : sql<SqlBool>`1 = 1`;
    };

    const rows = await this.db
      .selectFrom('inspectionOrders')
      .selectAll()
      .where(filter)
      .orderBy('createdAt', 'desc')
      .limit(query.pageSize)
      .offset((query.page - 1) * query.pageSize)
      .execute();

    const countRow = await this.db
      .selectFrom('inspectionOrders')
      .select((eb) => eb.fn.countAll().as('total'))
      .where(filter)
      .executeTakeFirst();
    const total = countRow ? Number(countRow.total) : 0;

    // 状态计数用于看板卡片，按全表统计（不受筛选条件影响）
    const statusRows = await this.db
      .selectFrom('inspectionOrders')
      .select((eb) => ['status', eb.fn.countAll().as('count')])
      .groupBy('status')
      .execute();

    const statusCounts: Record<string, number> = {};
    for (const row of statusRows) {
      statusCounts[row.status] = Number(row.count);
    }

    return { total, list: rows.map((row) => this.mapRow(row)), statusCounts };
  }

  public async updateStatus(id: string, status: string, remark?: string): Promise<void> {
    const targetStatus = toInspectionStatus(status);

    const now = new Date();

    // remark 仅用于补齐"备注仍为空"的工单：WHERE inspection_notes IS NULL 保证
    // 任何已存在的备注都不会被这次状态流转覆盖，也不会为空值写入 note。
    if (remark !== undefined && remark !== '') {
      await this.db
        .updateTable('inspectionOrders')
        .set({ inspectionNotes: remark, updatedAt: now })
        .where('id', '=', id)
        .where('inspectionNotes', 'is', null)
        .execute();
    }

    const updateValues: InspectionOrderUpdate = { status: targetStatus, updatedAt: now };

    await this.db
      .updateTable('inspectionOrders')
      .set(updateValues)
      .where('id', '=', id)
      .execute();
  }

  private mapRow(row: InspectionOrderRow): InspectionOrder {
    return {
      id: row.id,
      orderNo: row.orderNo,
      inspectionType: row.orderType,
      status: row.status,
      materialCode: row.materialCode,
      materialName: row.materialName,
      batchNo: row.batchNo,
      // NUMERIC 列在部分驱动配置下会以字符串返回，这里统一收敛为 number
      sampleQty: Number(row.sampleQty),
      passQty: Number(row.passQty),
      failQty: Number(row.failQty),
      isMandatoryGate: row.isMandatoryGate,
      planVersionId: row.planVersionId,
      planSnapshot: row.planSnapshot,
      items: row.items,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      // 可空列一律用条件展开省略，绝不写入 undefined（exactOptionalPropertyTypes 要求）
      ...(row.supplierCode !== null ? { supplierCode: row.supplierCode } : {}),
      ...(row.customerCode !== null ? { customerCode: row.customerCode } : {}),
      ...(row.inspectorId !== null ? { inspectorId: row.inspectorId } : {}),
      ...(row.judgment !== null ? { overallDecision: row.judgment } : {}),
      ...(row.inspectionNotes !== null ? { inspectionNotes: row.inspectionNotes } : {}),
    };
  }
}
