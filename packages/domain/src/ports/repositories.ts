import {
  InspectionOrder,
  InspectionPlan,
  ReviewFlow,
  MRBReview,
  PendingDefectItem,
  MaterialPermission,
  AuditLog,
  TraceNode,
  TraceEdge,
  TraceNodeStatus,
} from '@letian/contracts';

/**
 * 质检方案仓储端口
 */
export interface InspectionPlanRepository {
  findById(id: string): Promise<InspectionPlan | null>;
  /**
   * 按「物料编码 + 检验类型」解析当前生效方案，可选传入物料所属分类以启用分类级兜底：
   * 物料专属方案优先，未命中时下沉到该分类的通用方案（material_code 为空串）。
   */
  findActivePlan(
    materialCode: string,
    inspectionType: string,
    materialCategory?: string
  ): Promise<InspectionPlan | null>;
  save(plan: InspectionPlan): Promise<void>;
  /**
   * 申请方案编码流水号：同一 (prefix, dayKey) 上单调递增，从 1 开始。
   *
   * 由仓储在**当前事务内**以原子 upsert 实现（依赖数据库行锁），
   * 保证并发建方案不重号；事务回滚时流水号随之回滚（不产生空洞）。
   * 与 `formatInspectionPlanCode` 配合组成 `QP-{YYYYMMDD}-{NNN}` 方案编码，
   * 口径见 @letian/domain 的 inspection-plan-number。
   */
  allocatePlanCodeSequence(prefix: string, dayKey: string): Promise<number>;
}

/**
 * 检验工单仓储端口
 */
export interface InspectionOrderRepository {
  findById(id: string): Promise<InspectionOrder | null>;
  findByOrderNo(orderNo: string): Promise<InspectionOrder | null>;
  findByBatchNo(batchNo: string): Promise<readonly InspectionOrder[]>;
  /**
   * 按订单标识取一组检验单：同一标识可能命中「检验单号 / 工单号 / 销售出库单号 / 客户采购订单号」
   * 四个字段中的任意一个，用于组装订单维度的检验环节台账（docs/24 §5.3）。
   */
  findByOrderKey(orderKey: string): Promise<readonly InspectionOrder[]>;
  save(order: InspectionOrder): Promise<void>;
  updateStatus(id: string, status: string, remark?: string): Promise<void>;
  /**
   * 质量负责人签核（docs/35 §5）：写入真实签核动作的产物（签核人 id / 姓名 / 时间）。
   * 签核人由调用方从会话取，仓储不校验身份；未签核时该行三列为 NULL。
   */
  recordApproval(id: string, approval: { approverId?: string; approverName?: string }): Promise<void>;
  /**
   * 申请检验单号流水号：同一 (prefix, dayKey) 上单调递增，从 1 开始。
   *
   * 由仓储在**当前事务内**以原子 upsert 实现（依赖数据库行锁），
   * 保证并发建单不重号；事务回滚时流水号随之回滚（不产生空洞）。
   * 与 `formatInspectionOrderNo` 配合组成 `{PREFIX}-{YYYYMMDD}-{NNNN}` 单号。
   */
  allocateOrderNoSequence(prefix: string, dayKey: string): Promise<number>;
}

/**
 * MRB 评审单仓储端口
 */
export interface MRBReviewRepository {
  findById(id: string): Promise<MRBReview | null>;
  findByReviewNo(reviewNo: string): Promise<MRBReview | null>;
  findByOrderNo(orderNo: string): Promise<MRBReview | null>;
  save(review: MRBReview): Promise<void>;
}

/**
 * 评审流定义仓储端口
 */
export interface ReviewFlowRepository {
  findApplicableFlow(failCategory: string): Promise<ReviewFlow | null>;
  findById(id: string): Promise<ReviewFlow | null>;
  listAll(): Promise<ReviewFlow[]>;
  save(flow: ReviewFlow): Promise<void>;
}

/**
 * 不合格待审核池查询条件
 *
 * PBAC 三维行级过滤随查询一并下推 SQL（`permissions`）：
 * - 分类维度由 `materials.category_code` 子查询换算（池表只有 `material_code`，不需要冗余列）；
 * - 供应商维度按 fail-closed 处理 —— 池表没有供应商编码列，限定供应商的规则不匹配任何行，
 *   与 `GET /mrb/records` 的既有口径一致（docs/21 §6.5）。
 * `total` 必须是**同一套条件过滤后**的总数，不得用当页数据推算。
 */
export interface PendingDefectQuery {
  /** 检验环节（IQC / IPQC / FQC / OQC）：按前缀匹配，兼容 IPQC_CT / OQC_SF 等多段编码 */
  stage?: string | undefined;
  materialCode?: string | undefined;
  batchNo?: string | undefined;
  /** 池状态（PENDING_INITIATE / INITIATED / DISMISSED）；省略表示不过滤 */
  status?: string | undefined;
  /** 三维 PBAC 权限规则；传空数组表示「无生效规则」= fail-closed 不可见任何行 */
  permissions?: readonly MaterialPermission[] | undefined;
  page?: number | undefined;
  pageSize?: number | undefined;
}

/**
 * 待审核池入池草稿
 * `id` 由数据库生成（入池时不预先分配），`createdAt` 取库内 NOW()（即真实汇入时间）
 */
export type PendingDefectDraft = Omit<PendingDefectItem, 'id' | 'createdAt'> & {
  id?: string | undefined;
  /** 判不合格的检验项快照（落 failed_items JSONB，供追溯） */
  failedItems?: unknown[] | undefined;
};

/**
 * 不合格待审核池仓储端口
 *
 * 池的唯一幂等键是 `source_order_id`（一张检验单在池中只允许一条记录），
 * 入池 = upsert，发起评审 = markInitiated（回填 mrb_review_id）。
 */
export interface PendingDefectPoolRepository {
  list(query: PendingDefectQuery): Promise<{ items: PendingDefectItem[]; total: number }>;
  findById(id: string): Promise<PendingDefectItem | null>;
  /**
   * 按源检验单 ID 定位池条目。入参必须是检验单 UUID：
   * 列类型是 UUID 且带外键（迁移 018），传单号等非 UUID 文本会直接抛 22P02，
   * 因此实现侧必须先做 UUID 校验，非法入参一律返回 null（由调用方回退按单号查检验单）。
   */
  findBySourceOrderId(sourceOrderId: string): Promise<PendingDefectItem | null>;
  save(item: PendingDefectDraft): Promise<void>;
  markInitiated(id: string, mrbReviewId: string, operatorName?: string): Promise<void>;
  markDismissed(id: string, operatorName?: string): Promise<void>;
}

/**
 * PBAC 数据权限仓储端口
 */
export interface PBACPermissionRepository {
  findPermissionsByRole(roleCode: string): Promise<readonly MaterialPermission[]>;
  findPermissionsByRoles(roleCodes: readonly string[]): Promise<readonly MaterialPermission[]>;
}

/**
 * 审计日志仓储端口（只增不改）
 */
export interface AuditLogRepository {
  append(log: AuditLog): Promise<void>;
  query(params: {
    targetType?: string;
    targetId?: string;
    operatorId?: string;
    limit?: number;
  }): Promise<readonly AuditLog[]>;
}

/** 批次检索过滤条件：字段之间为 AND 语义，字段内为模糊匹配；`limit` 为单源硬上限 */
export interface BatchTraceSearchFilter {
  /** 批次号 或 炉批号 */
  batchNo?: string;
  /** 订单号：匹配来源单据号 / 检验单号 / 销售出库单号 / 客户采购订单号 / 工单号 */
  orderNo?: string;
  materialCode?: string;
  productName?: string;
  limit: number;
}

/**
 * 批次检索命中行（单数据源视角）。
 * 两个数据源各有各的自然字段，缺失项一律为 `null`，由用例层按 `batchNo` 归并。
 */
export interface BatchTraceCandidate {
  batchNo: string;
  furnaceHeatBatchNo: string | null;
  materialCode: string | null;
  materialName: string;
  stageName: string | null;
  nodeStatus: TraceNodeStatus | null;
  occurredAt: string | null;
  inspectionOrderNo: string | null;
  orderNo: string | null;
  supplierOrCustomer: string | null;
  /** 该批次关联的检验单号（仅检验台账数据源可提供） */
  relatedOrderNos: string[];
}

/** 影响面统计：根批次沿生产流向的上下游可达规模 */
export interface TraceImpactCounts {
  downstreamBatchCount: number;
  upstreamBatchCount: number;
  downstreamOrderNos: string[];
  downstreamParties: string[];
}

/**
 * 批次追溯图拓扑仓储端口
 */
export interface BatchTraceRepository {
  findNode(batchNo: string): Promise<TraceNode | null>;
  findEdges(batchNo: string, direction: 'UPSTREAM' | 'DOWNSTREAM' | 'BOTH'): Promise<readonly TraceEdge[]>;
  saveNode(node: TraceNode): Promise<void>;
  saveEdge(edge: TraceEdge): Promise<void>;
  /**
   * 批次检索（数据源 1）：`batch_trace_nodes`，即已建立血缘关系的批次。
   * 过滤条件全部下沉 SQL，调用方不得二次过滤。
   */
  searchNodes(filter: BatchTraceSearchFilter): Promise<readonly BatchTraceCandidate[]>;
  /**
   * 批次检索（数据源 2）：`inspection_orders` 按 `batch_no` 聚合，即只有检验台账、尚无血缘节点的批次。
   */
  searchOrderBatches(filter: BatchTraceSearchFilter): Promise<readonly BatchTraceCandidate[]>;
  /**
   * 影响面统计：沿 `parent_batch → child_batch`（生产流向）做递归闭包，
   * 分别统计下游 / 上游可达批次，以及下游节点上的关联单据号与外部单位。
   */
  countImpact(batchNo: string, maxDepth?: number): Promise<TraceImpactCounts>;
}
