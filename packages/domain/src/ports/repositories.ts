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
import type { InspectionType } from '@letian/contracts';
import type { ChainAnchor, UpstreamCandidate } from '../services/transfer-gate-service';

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
  findAll(): Promise<readonly InspectionOrder[]>;
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
   * 终判的数量 / 结论落库（合格数、不合格数、综合判定、终判时间、终判备注）。
   *
   * 此前该方法只存在于 Kysely 实现类上、未进入端口，控制器只能绕过用例层直接拿读侧仓储写入
   * （`POST /inspections/:id/status`），导致终判路径**无法在事务内入池**（docs/39 §2 D1）。
   * 进入端口后由 `FinalizeInspectionStatusUseCase` 在事务内调用。
   */
  updateStatsAndVerdict(
    id: string,
    data: {
      passQty?: number;
      failQty?: number;
      judgment?: string;
      completedAt?: Date;
      inspectionNotes?: string;
    }
  ): Promise<void>;
  /**
   * 质量负责人签核（docs/35 §5）：写入真实签核动作的产物（签核人 id / 姓名 / 时间）。
   * 签核人由调用方从会话取，仓储不校验身份；未签核时该行三列为 NULL。
   */
  recordApproval(id: string, approval: { approverId?: string; approverName?: string }): Promise<void>;
  /**
   * 建单传递留痕（docs/48 §4.1 / 迁移 `035`）：把**建单那一次**的传递判定落库，
   * 用于事后回答「这批货当初凭什么放行」—— 上游状态是会变的（MRB 结案 / 复检终判 / 下游冻结），
   * 只靠实时重算查不出历史结论。
   *
   * 纪律：**只作留痕与展示，永远不作判据**（判据一律由领域纯函数实时重算；留痕被读成判据就会出现
   * 「上游已撤销放行、下游仍按旧留痕放行」的静默错误）。与 `docs/47` 的 `heat_source_*` 同型。
   *
   * 未发生建单门禁的单据（例如 MRB 返工复检单走 `CreateReinspectionUseCase`，它必须跳过门禁以免自锁）
   * 不调用本方法，四列保持 NULL；调用方**不得**为了「填满列」而补一个猜出来的结论。
   */
  recordTransferTrace(
    id: string,
    trace: {
      /** 命中的链路锚点值（未命中时回落本单批次号） */
      chainKey: string;
      /** 命中的锚点类型：BATCH / HEAT / WORK_ORDER（取自领域枚举，不在库侧再固化一份） */
      chainKeyKind: string;
      /** 权威上游检验单号（复检轮次时指向复检单）；无上游单时省略 */
      upstreamOrderNo?: string;
      /** 判定理由码（`TransferGateCode`） */
      upstreamGateCode: string;
    }
  ): Promise<void>;
  /**
   * 追加或更新检验单备注（用于下游冻结批处理等业务留痕，不改状态与判据）
   */
  updateNotes(id: string, notes: string): Promise<void>;
  /**
   * 追加检验单备注：在既有备注后追加新行（首条直接写入），不改状态与判据。
   * 供下游冻结批处理追加「链路已终止」留痕使用。
   */
  appendNotes(id: string, notes: string): Promise<void>;
  /**
   * 申请检验单号流水号：同一 (prefix, dayKey) 上单调递增，从 1 开始。
   *
   * 由仓储在**当前事务内**以原子 upsert 实现（依赖数据库行锁），
   * 保证并发建单不重号；事务回滚时流水号随之回滚（不产生空洞）。
   * 与 `formatInspectionOrderNo` 配合组成 `{PREFIX}-{YYYYMMDD}-{NNNN}` 单号。
   */
  allocateOrderNoSequence(prefix: string, dayKey: string): Promise<number>;
  /**
   * 按炉批号取一组检验单（docs/47 §4.4）。
   *
   * 与 `findByBatchNo`（按质检批次号精确匹配）**语义不同、互不替代**：
   *   - 入参是「炉批号」（钢材冶炼炉号 / 热处理炉批号），落 `furnace_heat_batch_no`；
   *   - 匹配走**归一化等值**（迁移 034 的生成列 `furnace_heat_batch_no_norm`），
   *     大小写 / 空格 / 连字符 / 下划线 / 全角空格差异一律视为同一炉批号；
   *   - `materialCode` 可选：传入时限定该物料（调用方需要跨物料回退时自行放宽）；
   *   - 排序由本方法保证：`updated_at DESC NULLS LAST, created_at DESC, order_no DESC`
   *     （即「最近一次终判优先」），调用方不得依赖数据库默认顺序。
   */
  findByFurnaceHeatNo(
    furnaceHeatNo: string,
    options?: { materialCode?: string }
  ): Promise<readonly InspectionOrder[]>;
  /**
   * 炉批号相关的表头业务事实更新（docs/47 §4.1 / §4.5）：炉批号 + 材质牌号 + 执行技术标准 +
   * 检验日期，以及炉批号数据带出源留痕（`heat_source_type` / `heat_source_order_no`）。
   *
   * 字段语义：`undefined` = 不动该列；`''` = 清空为 NULL；非空 = 写入该值。
   * 归一列的生成值由数据库自行维护，调用方只写原值 `furnace_heat_batch_no`。
   */
  updateHeatHeaderFields(
    id: string,
    fields: {
      furnaceHeatNo?: string;
      materialGrade?: string;
      techStandard?: string;
      inspectedDate?: string;
      heatSourceType?: string;
      heatSourceOrderNo?: string;
    }
  ): Promise<void>;
  /**
   * 「合格后传递」链路候选集（docs/48 §4.4 / §2.2）：
   * 按**锚点等值**一次取回上游环节的候选单，供领域纯函数 `canTransferToNextStage` 判定。
   *
   * 三条硬约束（违反其一即重演 docs/47 D6「取到最旧一条」）：
   *   1. 锚点匹配 = `batch_no` ∪ `furnace_heat_batch_no_norm` ∪ `work_order_no`（OR，任一命中即候选）；
   *      炉批号一律走迁移 `034` 的**归一化生成列**，调用方不得自行拼 SQL 归一（记录在注释里，避免第二次转义坑）；
   *   2. 排序在本方法内固定：`updated_at DESC NULLS LAST → created_at DESC → order_no DESC`，
   *      调用方**不得**二次排序，也不得用 `Array.find` 取首条；
   *   3. `matchedAnchors` 由本方法按**行值与锚点实际相等**标注（不是「SQL 命中了哪个 OR 分支」），
   *      否则「批次号恰好等于炉批号」这类巧合格会算出错误的锚点层级。
   */
  findChainCandidates(
    anchors: readonly ChainAnchor[],
    options?: {
      /** 门禁上游环节类型（`predecessorStagesOf(stage)` 的产物）；省略表示不过滤环节 */
      inspectionTypes?: readonly InspectionType[];
      /** 物料编码；省略表示不限物料（跨物料提示计数用，门禁判定必须传） */
      materialCode?: string;
    }
  ): Promise<readonly UpstreamCandidate[]>;
  /**
   * 同锚点、同上游环节，但**物料编码不同**的候选单数量（TBD-03：跨物料只提示、不阻断）。
   *
   * 单独成方法而非在调用方二次过滤：跨物料命中口径必须与 `findChainCandidates` 完全同源，
   * 否则会出现「提示说有跨物料单、实际又没取回来」这类自相矛盾。
   */
  countCrossMaterialCandidates(
    anchors: readonly ChainAnchor[],
    options: { inspectionTypes?: readonly InspectionType[]; materialCode: string }
  ): Promise<number>;
}

/**
 * MRB 评审单仓储端口
 */
export interface MRBReviewRepository {
  findById(id: string): Promise<MRBReview | null>;
  findByReviewNo(reviewNo: string): Promise<MRBReview | null>;
  findByOrderNo(orderNo: string): Promise<MRBReview | null>;
  /**
   * 按批次号取**最新**评审单（`updated_at DESC`）。
   *
   * 此前该方法只存在于 Kysely 实现类上（`mrb-review-repository.ts:102`），未进端口 —— 放行关卡控制器
   * 只能绕过端口直接依赖实现类（分层漏洞，docs/48 §4.4）。传递门禁需要「本批次有没有生效的 MRB 结论」，
   * 与放行关卡是同一个问题，故一并收进端口。
   */
  findByBatchNo(batchNo: string): Promise<MRBReview | null>;
  /**
   * 按**来源检验单号**批量取评审单（传递门禁专用，避免逐个候选单 N+1 查询）。
   *
   * 同一来源单可能存在多张评审单（返工再判不合格时按 TBD-05 新开，见 docs/48 §7），
   * 排序由本方法固定为 `updated_at DESC`；调用方按 `sourceOrderNo` 取首条即「最新结论」，
   * 不得依赖数据库默认顺序。
   */
  findBySourceOrderNos(orderNos: readonly string[]): Promise<readonly MRBReview[]>;
  /**
   * 查找结论为报废(SCRAP)或退货(RETURN_TO_VENDOR)的终止评审单（用于下游冻结批处理）
   */
  findTerminatedReviews(batchNo?: string): Promise<readonly MRBReview[]>;
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
 * - 供应商维度**经源检验单换算**（池表无 `supplier_code` 列，按 `source_order_id` 关联
 *   `inspection_orders.supplier_code`）；源单缺失即不命中该规则（fail-closed）。
 *   此前对限定供应商的规则整条跳过，导致三维限定用户「台账看得到、池里看不到」（docs/39 §2 D2）。
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

export interface TransferOverrideTicketRecord {
  id: string;
  ticketNo: string;
  batchNo: string;
  materialCode: string;
  inspectionType: string;
  workOrderNo?: string | null;
  furnaceHeatNo?: string | null;
  upstreamOrderNo?: string | null;
  upstreamGateCode: string;
  reason: string;
  applicantId: string;
  applicantName?: string | null;
  status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'CONSUMED';
  reviewerId?: string | null;
  reviewerName?: string | null;
  reviewNotes?: string | null;
  approvalDocNo?: string | null;
  consumedOrderId?: string | null;
  consumedOrderNo?: string | null;
  createdAt: Date;
  reviewedAt?: Date | null;
  consumedAt?: Date | null;
}

export interface TransferOverrideRepository {
  createTicket(data: Omit<TransferOverrideTicketRecord, 'id' | 'ticketNo' | 'status' | 'createdAt' | 'reviewedAt' | 'consumedAt'>): Promise<TransferOverrideTicketRecord>;
  findById(id: string): Promise<TransferOverrideTicketRecord | null>;
  findByTicketNo(ticketNo: string): Promise<TransferOverrideTicketRecord | null>;
  findActiveApprovedTicket(params: { batchNo: string; materialCode: string; inspectionType: string }): Promise<TransferOverrideTicketRecord | null>;
  reviewTicket(id: string, review: { status: 'APPROVED' | 'REJECTED'; reviewerId: string; reviewerName?: string; reviewNotes?: string; approvalDocNo?: string }): Promise<TransferOverrideTicketRecord>;
  consumeTicket(id: string, consumption: { orderId: string; orderNo: string }): Promise<TransferOverrideTicketRecord>;
  listTickets(params?: { batchNo?: string; materialCode?: string; status?: string; page?: number; pageSize?: number }): Promise<{ items: TransferOverrideTicketRecord[]; total: number }>;
}
