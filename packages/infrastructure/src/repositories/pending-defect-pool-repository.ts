import { Kysely, sql } from 'kysely';
import type {
  PendingDefectPoolRepository as IPendingDefectPoolRepository,
  PendingDefectDraft,
  PendingDefectQuery,
} from '@letian/domain';
import type { PendingDefectItem, PendingDefectStatus } from '@letian/contracts';
import type { Database, PendingMrbItemInsert, PendingMrbItemRow } from '../database/schema.js';
import { buildMaterialPermissionWhere } from './pbac-sql-translator.js';

/** PostgreSQL uuid 列不接受非 uuid 文本，按 id 过滤前先做格式判断避免 22P02 */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 契约 PendingDefectStatusEnum 的 3 个合法取值 */
const PENDING_STATUSES: readonly string[] = ['PENDING_INITIATE', 'INITIATED', 'DISMISSED'];

function toPendingStatus(value: string): PendingDefectStatus {
  if (!PENDING_STATUSES.includes(value)) {
    throw new Error(`PENDING_DEFECT_STATUS_INVALID: 非法的待审核池状态 [${value}]`);
  }
  return value as PendingDefectStatus;
}

/** 模糊检索通配符转义：用户输入里的 % 与 _ 不能退化成全表匹配 */
function likePattern(value: string, mode: 'contains' | 'prefix'): string {
  const escaped = value.replace(/[\\%_]/g, (char) => `\\${char}`);
  return mode === 'prefix' ? `${escaped}%` : `%${escaped}%`;
}

/** 不良率口径：定额数量 / 受检数量，保留 4 位小数（与迁移 015 回填口径一致） */
function defectRateOf(defectQty: number, totalQty: number): number {
  if (totalQty <= 0) return 0;
  return Number(((defectQty / totalQty) * 100).toFixed(4));
}

/**
 * 不合格待审核池仓储 (Kysely + PostgreSQL)
 *
 * 幂等键：`source_order_id` 唯一索引（迁移 015 `uq_pending_mrb_source_order`）。
 * 一张检验单在池中只允许一条记录，入池走 upsert，重复判定不合格不会产生重复条目。
 *
 * 描述性字段（数量/原因/供应商/客户/检验人）在 upsert 时**总是**跟随源检验单刷新；
 * 流程性字段（status / mrb_review_id / review_started_*）只由入池与发起评审两条链路写入，
 * 避免重新判定时把已发起的池记录打回待发起态。
 *
 * 行级权限：三维 PBAC 条件随查询下推 SQL（与 inspection_orders / mrb_reviews 共用
 * `buildMaterialPermissionWhere`），因此 `total` 与当页数据天然同口径，
 * 不需要在用例层"先扫全表再过滤"（docs/21 §9 遗留 1 已闭环）。
 */
export class KyselyPendingDefectPoolRepository implements IPendingDefectPoolRepository {
  constructor(private readonly db: Kysely<Database>) {}

  public async list(
    query: PendingDefectQuery
  ): Promise<{ items: PendingDefectItem[]; total: number }> {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;

    // 同一套过滤条件复用于「当页数据」与「总数统计」，避免两处条件漂移
    const filtered = () => {
      let current = this.db.selectFrom('pendingMrbItems');
      // 环节按前缀匹配：前端页签是 IQC/IPQC/FQC/OQC，物理值是 IQC / IPQC_CT / OQC_SF 等多段编码
      if (query.stage !== undefined && query.stage !== '') {
        current = current.where('sourceStage', 'ilike', likePattern(query.stage, 'prefix'));
      }
      if (query.materialCode !== undefined && query.materialCode !== '') {
        current = current.where(
          'materialCode',
          'ilike',
          likePattern(query.materialCode, 'contains')
        );
      }
      if (query.batchNo !== undefined && query.batchNo !== '') {
        current = current.where('batchNo', 'ilike', likePattern(query.batchNo, 'contains'));
      }
      if (query.status !== undefined && query.status !== '') {
        current = current.where('status', '=', query.status);
      }
      // 三维 PBAC：分类维度经 materials 子查询换算；供应商维度 fail-closed
      // （池表无供应商编码列，限定供应商的规则不匹配任何行，与 /mrb/records 一致）
      if (query.permissions !== undefined) {
        current = current.where(
          buildMaterialPermissionWhere(query.permissions, {
            targetRef: 'pending_mrb_items',
            hasSupplierColumn: false,
          })
        );
      }
      return current;
    };

    const rows = await filtered()
      .selectAll()
      .orderBy('createdAt', 'desc')
      .limit(pageSize)
      .offset((page - 1) * pageSize)
      .execute();

    const countRow = await filtered()
      .select((eb) => eb.fn.countAll().as('total'))
      .executeTakeFirst();

    return {
      items: rows.map((row) => this.mapRow(row)),
      total: countRow ? Number(countRow.total) : 0,
    };
  }

  public async findById(id: string): Promise<PendingDefectItem | null> {
    if (!UUID_PATTERN.test(id)) {
      return null;
    }
    const row = await this.db
      .selectFrom('pendingMrbItems')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
    return row ? this.mapRow(row) : null;
  }

  public async findBySourceOrderId(sourceOrderId: string): Promise<PendingDefectItem | null> {
    // 列类型为 UUID（迁移 018）：非 UUID 文本直接查会抛 22P02，先判定格式再查
    if (!UUID_PATTERN.test(sourceOrderId)) {
      return null;
    }
    const row = await this.db
      .selectFrom('pendingMrbItems')
      .selectAll()
      .where('sourceOrderId', '=', sourceOrderId)
      .executeTakeFirst();
    return row ? this.mapRow(row) : null;
  }

  public async save(item: PendingDefectDraft): Promise<void> {
    const defectQty = item.defectQty;
    const totalQty = item.totalQty;
    const status = toPendingStatus(item.status);

    const writable = {
      sourceOrderNo: item.orderNo,
      sourceStage: item.inspectionType,
      materialCode: item.materialCode,
      materialName: item.materialName,
      batchNo: item.batchNo,
      defectQty,
      totalQty,
      defectRate: defectRateOf(defectQty, totalQty),
      failReason: item.defectDescription,
      failedItems: JSON.stringify(item.failedItems ?? []),
      defectItemCode: item.defectItemCode ?? null,
      supplierName: item.supplierName ?? null,
      customerName: item.customerName ?? null,
      inspectorId: item.inspectorId ?? null,
      inspectorName: item.inspectorName ?? null,
    };

    const insertValues: PendingMrbItemInsert = {
      ...writable,
      sourceOrderId: item.inspectionOrderId,
      status,
      mrbReviewId: item.mrbId ?? null,
      reviewStartedAt: null,
      reviewStartedBy: null,
      ...(item.id !== undefined && UUID_PATTERN.test(item.id) ? { id: item.id } : {}),
    };

    await this.db
      .insertInto('pendingMrbItems')
      .values(insertValues)
      .onConflict((oc) =>
        oc.column('sourceOrderId').doUpdateSet({
          ...writable,
          // 已撤销（DISMISSED）的条目若被重新判定不合格，允许回到待发起态；
          // 已发起评审（INITIATED）的条目保持不动，避免打断在途评审
          status: sql`case when pending_mrb_items.status = 'DISMISSED' then ${status} else pending_mrb_items.status end`,
        })
      )
      .execute();
  }

  public async markInitiated(
    id: string,
    mrbReviewId: string,
    operatorName?: string
  ): Promise<void> {
    // 池条目 ID 与源单 ID 都是 UUID；非法入参没有任何可命中的行，直接返回
    if (!UUID_PATTERN.test(id)) {
      return;
    }
    await this.db
      .updateTable('pendingMrbItems')
      .set({
        status: 'INITIATED',
        mrbReviewId,
        reviewStartedAt: new Date(),
        reviewStartedBy: operatorName ?? null,
      })
      .where((eb) => eb.or([eb('id', '=', id), eb('sourceOrderId', '=', id)]))
      .execute();
  }

  public async markDismissed(id: string, operatorName?: string): Promise<void> {
    if (!UUID_PATTERN.test(id)) {
      return;
    }
    await this.db
      .updateTable('pendingMrbItems')
      .set({
        status: 'DISMISSED',
        reviewStartedAt: new Date(),
        reviewStartedBy: operatorName ?? null,
      })
      .where((eb) => eb.or([eb('id', '=', id), eb('sourceOrderId', '=', id)]))
      .execute();
  }

  private mapRow(row: PendingMrbItemRow): PendingDefectItem {
    const defectQty = Number(row.defectQty);
    const totalQty = Number(row.totalQty ?? row.defectQty ?? 0);
    return {
      id: row.id,
      inspectionOrderId: row.sourceOrderId,
      orderNo: row.sourceOrderNo,
      inspectionType: row.sourceStage,
      batchNo: row.batchNo,
      materialCode: row.materialCode,
      materialName: row.materialName,
      defectQty,
      totalQty,
      defectRate: Number(row.defectRate ?? defectRateOf(defectQty, totalQty)),
      defectDescription: row.failReason,
      status: toPendingStatus(row.status),
      createdAt: row.createdAt.toISOString(),
      // 可空派生列一律条件展开，绝不写入 undefined（exactOptionalPropertyTypes）
      ...(row.defectItemCode !== null ? { defectItemCode: row.defectItemCode } : {}),
      ...(row.supplierName !== null ? { supplierName: row.supplierName } : {}),
      ...(row.customerName !== null ? { customerName: row.customerName } : {}),
      ...(row.inspectorId !== null ? { inspectorId: row.inspectorId } : {}),
      ...(row.inspectorName !== null ? { inspectorName: row.inspectorName } : {}),
      ...(row.mrbReviewId !== null ? { mrbId: row.mrbReviewId } : {}),
    };
  }
}
