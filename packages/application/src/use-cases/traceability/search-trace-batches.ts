import type { TraceBatchSearchResponse, TraceBatchSummary, TraceNodeStatus } from '@letian/contracts';
import type { ISecurityContext } from '../../security/security-context.js';
import type { IUnitOfWork } from '../../tx/unit-of-work.js';

export interface SearchTraceBatchesCommand {
  /** 批次号 或 炉批号 */
  batchNo?: string;
  /** 订单号：同时匹配检验单号 / 工单号 / 销售出库单号 / 客户采购订单号 */
  orderNo?: string;
  materialCode?: string;
  productName?: string;
  page?: number;
  pageSize?: number;
}

/**
 * 单数据源扫描硬上限。
 *
 * 「批次检索」是人找批次的入口，命中集合本就不大；这里设硬上限是为了杜绝无过滤条件的
 * 全表扫描，**不是**分页手段 —— 真正的分页在归并、去重、权限过滤之后按 page/pageSize 完成。
 */
const SOURCE_SCAN_LIMIT = 500;
const MAX_PAGE_SIZE = 100;
const DEFAULT_PAGE_SIZE = 20;

/** 归并累加器：一个批次一行，两个数据源的字段互补 */
interface MergedBatch {
  batchNo: string;
  /** 是否命中过血缘节点数据源；决定哪些字段具备权威值 */
  hasNode: boolean;
  furnaceHeatBatchNo: string | null;
  materialCode: string | null;
  materialName: string;
  stageName: string | null;
  nodeStatus: TraceNodeStatus | null;
  timestamp: string | null;
  inspectionOrderNo: string | null;
  orderNo: string | null;
  supplierOrCustomer: string | null;
  sources: Array<'TRACE_NODE' | 'INSPECTION_ORDER'>;
  relatedOrderNos: Set<string>;
}

/**
 * 批次检索用例
 *
 * 追溯主键是**批次号**（PRD §3.1），订单号 / 物料编码 / 成品名称只是检索条件。
 * 因此本用例的产出是「命中批次列表」，界面点选其中一行后才以该批次为根开图 ——
 * 避免把同一订单下**并列**的检验环节串成一条并不存在的血缘链（docs/24 §1）。
 *
 * 数据源两路并集：
 *   1. `batch_trace_nodes`：已建立血缘关系的批次（工序名 / 节点状态 / 炉批号以此源为准）；
 *   2. `inspection_orders`：只有检验台账、尚未建血缘节点的批次。
 *
 * 权限：列表场景一律「过滤」而非「抛错」，与检验台账的 PBAC 口径一致；物料分类无法解析时
 * 取 `UNKNOWN`（任何白名单规则都不命中，fail-closed）。
 */
export class SearchTraceBatchesUseCase {
  constructor(private readonly uow: IUnitOfWork) {}

  public async execute(
    cmd: SearchTraceBatchesCommand,
    securityCtx?: ISecurityContext
  ): Promise<TraceBatchSearchResponse> {
    const page = Math.max(1, Math.trunc(cmd.page ?? 1));
    const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, Math.trunc(cmd.pageSize ?? DEFAULT_PAGE_SIZE)));

    const filter = {
      ...(cmd.batchNo !== undefined ? { batchNo: cmd.batchNo } : {}),
      ...(cmd.orderNo !== undefined ? { orderNo: cmd.orderNo } : {}),
      ...(cmd.materialCode !== undefined ? { materialCode: cmd.materialCode } : {}),
      ...(cmd.productName !== undefined ? { productName: cmd.productName } : {}),
      limit: SOURCE_SCAN_LIMIT,
    };

    const visible = await this.uow.execute(async (ctx) => {
      const byBatch = new Map<string, MergedBatch>();

      for (const row of await ctx.traceDags.searchNodes(filter)) {
        const entry = SearchTraceBatchesUseCase.upsert(byBatch, row.batchNo);
        entry.hasNode = true;
        entry.sources.push('TRACE_NODE');
        entry.furnaceHeatBatchNo = row.furnaceHeatBatchNo;
        entry.materialCode = row.materialCode;
        entry.materialName = row.materialName;
        entry.stageName = row.stageName;
        entry.nodeStatus = row.nodeStatus;
        entry.timestamp = row.occurredAt;
        entry.inspectionOrderNo = row.inspectionOrderNo;
        entry.orderNo = row.orderNo;
        entry.supplierOrCustomer = row.supplierOrCustomer;
        for (const orderNo of row.relatedOrderNos) {
          entry.relatedOrderNos.add(orderNo);
        }
        if (row.inspectionOrderNo !== null) {
          entry.relatedOrderNos.add(row.inspectionOrderNo);
        }
      }

      for (const row of await ctx.traceDags.searchOrderBatches(filter)) {
        const entry = SearchTraceBatchesUseCase.upsert(byBatch, row.batchNo);
        entry.sources.push('INSPECTION_ORDER');
        entry.furnaceHeatBatchNo ??= row.furnaceHeatBatchNo;
        entry.materialCode ??= row.materialCode;
        if (!entry.hasNode) {
          entry.materialName = row.materialName;
        }
        entry.timestamp ??= row.occurredAt;
        entry.supplierOrCustomer ??= row.supplierOrCustomer;
        for (const orderNo of row.relatedOrderNos) {
          entry.relatedOrderNos.add(orderNo);
        }
      }

      if (!securityCtx) {
        return Array.from(byBatch.values());
      }

      const allowed: MergedBatch[] = [];
      for (const entry of byBatch.values()) {
        const material =
          entry.materialCode !== null
            ? await ctx.materials.getMaterialByCode(entry.materialCode)
            : await ctx.materials.getMaterialByName(entry.materialName);
        const granted = securityCtx.hasPermission({
          targetCategory: material?.categoryCode ?? 'UNKNOWN',
          targetMaterialCode: material?.materialCode ?? entry.materialCode ?? entry.materialName,
        });
        if (granted) {
          allowed.push(entry);
        }
      }
      return allowed;
    });

    visible.sort((left, right) => {
      const leftAt = left.timestamp ?? '';
      const rightAt = right.timestamp ?? '';
      // 时间倒序（最近的批次优先）；时间相同或均缺失时按批次号稳定排序，保证分页可复现
      return leftAt === rightAt ? left.batchNo.localeCompare(right.batchNo) : rightAt.localeCompare(leftAt);
    });

    const start = (page - 1) * pageSize;
    return {
      total: visible.length,
      page,
      pageSize,
      items: visible.slice(start, start + pageSize).map((entry) => SearchTraceBatchesUseCase.toSummary(entry)),
    };
  }

  private static upsert(byBatch: Map<string, MergedBatch>, batchNo: string): MergedBatch {
    const existing = byBatch.get(batchNo);
    if (existing) {
      return existing;
    }

    const created: MergedBatch = {
      batchNo,
      hasNode: false,
      furnaceHeatBatchNo: null,
      materialCode: null,
      materialName: batchNo,
      stageName: null,
      nodeStatus: null,
      timestamp: null,
      inspectionOrderNo: null,
      orderNo: null,
      supplierOrCustomer: null,
      sources: [],
      relatedOrderNos: new Set<string>(),
    };
    byBatch.set(batchNo, created);
    return created;
  }

  private static toSummary(entry: MergedBatch): TraceBatchSummary {
    return {
      batchNo: entry.batchNo,
      ...(entry.furnaceHeatBatchNo !== null ? { furnaceHeatBatchNo: entry.furnaceHeatBatchNo } : {}),
      ...(entry.materialCode !== null ? { materialCode: entry.materialCode } : {}),
      materialName: entry.materialName,
      ...(entry.stageName !== null ? { stageName: entry.stageName } : {}),
      ...(entry.nodeStatus !== null ? { nodeStatus: entry.nodeStatus } : {}),
      ...(entry.timestamp !== null ? { timestamp: entry.timestamp } : {}),
      ...(entry.inspectionOrderNo !== null ? { inspectionOrderNo: entry.inspectionOrderNo } : {}),
      ...(entry.orderNo !== null ? { orderNo: entry.orderNo } : {}),
      ...(entry.supplierOrCustomer !== null ? { supplierOrCustomer: entry.supplierOrCustomer } : {}),
      sources: entry.sources,
      relatedOrderNos: Array.from(entry.relatedOrderNos).sort(),
    };
  }
}
