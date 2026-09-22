import { z } from 'zod';
import { extendZodWithOpenApi } from '@asteasolutions/zod-to-openapi';

extendZodWithOpenApi(z);

/**
 * 批次追溯拓扑关系枚举 (5类关系)
 */
export const TraceRelationTypeEnum = z.enum([
  'RAW_TO_PROCESS',       // 原材料批次到首道工序
  'PROCESS_TO_PROCESS',   // 工序间流转
  'PROCESS_TO_OUTSOURCE', // 工序到委外加工
  'OUTSOURCE_TO_FINISH',  // 委外回厂到成品检
  'FINISH_TO_SHIPMENT',   // 成品到销售发货出库
]).openapi('TraceRelationType');

/**
 * 批次追溯方向枚举 (向上溯源/向下追踪/双向)
 */
export const TraceDirectionEnum = z.enum([
  'FORWARD',  // 向下追踪
  'BACKWARD', // 向上溯源
  'BOTH',     // 双向贯通
]).openapi('TraceDirection');

/**
 * 追溯节点业务状态枚举
 *
 * CONCESSION（特采 / 让步接收）与 MRB 侧 MRBDispositionEnum 的同名取值同义：
 * 由 MRB 评审结论 CONCESSION 回写。该状态下节点必须能同时给出 MRB 单号与客户书面授权件，
 * 二者任一缺失时前端必须显式提示「缺客户授权件」，不得静默按合格展示。
 */
export const TraceNodeStatusEnum = z.enum([
  'PASSED',
  'FAILED',
  'INSPECTING',
  'PENDING',
  'STORED',
  'CONCESSION',
]).openapi('TraceNodeStatus');

/**
 * 批次追溯拓扑节点 Schema
 */
export const TraceNodeSchema = z.object({
  nodeId: z.string().openapi({ description: '拓扑节点标识', example: 'node_raw_01' }),
  batchNo: z.string().openapi({ description: '生产或物料批次号', example: 'LOT-2026-0701' }),
  stageName: z.string().openapi({ description: '工序或环节全称', example: '原材料来料检' }),
  materialName: z.string().openapi({ description: '物料或零件名称', example: '冷镦钢 10B21' }),
  operatorName: z.string().openapi({ description: '执行人/质检员', example: '张检验' }),
  timestamp: z.string().openapi({ description: '节点发生时间', example: '2026-07-06 09:30' }),
  nodeStatus: TraceNodeStatusEnum.default('PASSED').openapi({ description: '节点质量状态' }),
  orderNo: z.string().optional().openapi({ description: '关联合同或检验单号', example: 'IQC20260706-001' }),
  supplierOrCustomer: z.string().optional().openapi({ description: '供应商或客户名称', example: '无锡超匠工光轴制造有限公司' }),
  materialCode: z.string().optional().openapi({ description: '物料编码；主数据未建档时缺省（前端显示 —）', example: 'MAT-35CRMO-08' }),
  furnaceHeatBatchNo: z.string().optional().openapi({ description: '炉批号：钢材炉号 / 热处理炉批号；无炉批概念时缺省', example: '230915-047' }),
  inspectionOrderNo: z.string().optional().openapi({ description: '本节点对应检验单号；该环节尚未建检验单时缺省', example: 'INS-20231011-0001' }),
  mrbNo: z.string().optional().openapi({ description: '特采节点的 MRB 评审单号（nodeStatus=CONCESSION 且已立案时有值）', example: 'MRB-20231011-01' }),
  concessionAttachmentUrl: z.string().optional().openapi({ description: '特采节点的客户书面授权件地址；缺失即表示未取得客户授权' }),
}).openapi('TraceNode');

/**
 * 批次追溯拓扑边 Schema
 */
export const TraceEdgeSchema = z.object({
  id: z.string().uuid().optional().openapi({ description: '关系边唯一标识' }),
  sourceBatchNo: z.string().openapi({ description: '源批次号', example: 'LOT-2026-0701' }),
  targetBatchNo: z.string().openapi({ description: '目标批次号', example: 'LOT-2026-CT-01' }),
  relationType: TraceRelationTypeEnum.openapi({ description: '工序流转关系类别' }),
  depth: z.number().int().default(1).openapi({ description: '追溯展开层级深度', example: 1 }),
  isCycle: z.boolean().default(false).openapi({ description: '是否属于成环闭环节点 (由 SQL CYCLE 标定)' }),
  hasCycleWarning: z.boolean().default(false).openapi({ description: '是否存在成环告警 (供前端标红警示)' }),
}).openapi('TraceEdge');

/**
 * 影响面统计 Schema（根批次的上下游可达规模）
 *
 * 口径：沿 batch_trace_relations 的 parent_batch → child_batch 方向做递归闭包，
 * downstream* 统计下游可达集合，upstreamBatchCount 统计上游可达集合；闭包深度上限 10 层，
 * 与图谱穿透保持一致，遇到环路按路径数组去重（见 docs/24 §5.3）。
 *
 * 命名注意：节点表只有单一 supplier_or_customer 列承载外部单位，**不区分客户与供应商**，
 * 因此这里命名 downstreamParties / downstreamPartyCount，界面上写「下游单位」，不得写「客户数」。
 */
export const TraceImpactSummarySchema = z.object({
  downstreamBatchCount: z.number().int().nonnegative().openapi({ description: '下游可达批次数量', example: 3 }),
  upstreamBatchCount: z.number().int().nonnegative().openapi({ description: '上游可达批次数量', example: 5 }),
  downstreamOrderCount: z.number().int().nonnegative().openapi({ description: '下游节点关联单据号去重数量', example: 2 }),
  downstreamPartyCount: z.number().int().nonnegative().openapi({ description: '下游节点外部单位去重数量', example: 2 }),
  downstreamOrderNos: z.array(z.string()).openapi({ description: '下游节点关联单据号清单（去重升序）' }),
  downstreamParties: z.array(z.string()).openapi({ description: '下游节点外部单位清单（去重升序）' }),
}).openapi('TraceImpactSummary');

/**
 * 批次追溯全景 DAG 响应 Schema
 */
export const TraceabilityGraphResponseSchema = z.object({
  batchNo: z.string().openapi({ description: '查询目标根批次号', example: 'LOT-2026-FN-01' }),
  hasCycle: z.boolean().default(false).openapi({ description: '整条全链路是否存在循环引用' }),
  nodes: z.array(TraceNodeSchema).openapi({ description: '追溯拓扑所有节点' }),
  edges: z.array(TraceEdgeSchema).openapi({ description: '追溯拓扑有向边集合' }),
  impact: TraceImpactSummarySchema.openapi({ description: '根批次影响面统计（与穿透方向无关，恒按生产流向计算）' }),
}).openapi('TraceabilityGraphResponse');

/**
 * 批次检索结果行 Schema
 *
 * 数据来源为 batch_trace_nodes（已建血缘的批次）与 inspection_orders（有检验台账的批次）两路并集，
 * sources 标明命中来源，便于前端区分「已建血缘」与「仅有检验台账、尚无血缘」两类批次。
 */
export const TraceBatchSummarySchema = z.object({
  batchNo: z.string().openapi({ description: '批次号（追溯主键）', example: 'LOT-2026-FN-01' }),
  furnaceHeatBatchNo: z.string().optional().openapi({ description: '炉批号（无则缺省）' }),
  materialCode: z.string().optional().openapi({ description: '物料编码（主数据未建档时缺省）' }),
  materialName: z.string().openapi({ description: '物料名称' }),
  stageName: z.string().optional().openapi({ description: '当前/最近工序环节名；仅有检验台账时缺省' }),
  nodeStatus: TraceNodeStatusEnum.optional().openapi({ description: '节点质量状态；仅有检验台账时缺省' }),
  timestamp: z.string().optional().openapi({ description: '节点发生时间或检验台账创建时间' }),
  inspectionOrderNo: z.string().optional().openapi({ description: '该批次最近一张检验单号' }),
  orderNo: z.string().optional().openapi({ description: '关联来源单据号（工单/采购单/销售出库单等）' }),
  supplierOrCustomer: z.string().optional().openapi({ description: '外部单位名称' }),
  sources: z.array(z.enum(['TRACE_NODE', 'INSPECTION_ORDER'])).default([]).openapi({ description: '本行命中来源' }),
  relatedOrderNos: z.array(z.string()).default([]).openapi({ description: '该批次关联的检验单号清单（去重升序）' }),
}).openapi('TraceBatchSummary');

/**
 * 批次检索响应 Schema
 */
export const TraceBatchSearchResponseSchema = z.object({
  total: z.number().int().nonnegative().openapi({ description: '命中批次总数' }),
  page: z.number().int().positive().openapi({ description: '当前页码（1 起）' }),
  pageSize: z.number().int().positive().openapi({ description: '每页条数' }),
  items: z.array(TraceBatchSummarySchema).openapi({ description: '当页批次行' }),
}).openapi('TraceBatchSearchResponse');

/**
 * 订单检验环节行 Schema
 *
 * 这是**订单维度的检验台账视图**，不是血缘链路：同一订单下多条检验环节彼此是并列关系，
 * 不构成批次上下游，因此界面标题必须写「本订单检验环节」，不得写「完整质量追溯链路」。
 */
export const TraceOrderChainStageSchema = z.object({
  seq: z.number().int().positive().openapi({ description: '工艺序位（按检验类型映射，非时间排序）', example: 1 }),
  stageName: z.string().openapi({ description: '环节名称（检验类型中文名）', example: '下料检' }),
  orderNo: z.string().openapi({ description: '检验单号', example: 'INS-20231012-0002' }),
  orderType: z.string().openapi({ description: '契约检验类型枚举值', example: 'IPQC_CT' }),
  batchNo: z.string().openapi({ description: '本环节受检批次号' }),
  sourceDocNo: z.string().optional().openapi({ description: '来源单据号（工单 / 委外单 / 采购收货单 / 销售出库单）' }),
  status: TraceNodeStatusEnum.openapi({ description: '由检验单状态与终判派生' }),
  judgment: z.enum(['PASSED', 'FAILED', 'CONCESSION']).optional().openapi({ description: '终判结论（未终判时缺省；CONCESSION 即特采）' }),
  inspectorName: z.string().optional().openapi({ description: '检验人姓名' }),
  occurredAt: z.string().optional().openapi({ description: '环节发生时间（优先终检时间，其次建单时间）' }),
  durationMinutes: z.number().int().nonnegative().optional().openapi({ description: '耗时分钟数；无终检时间时缺省，前端显示 —' }),
}).openapi('TraceOrderChainStage');

/**
 * 订单检验环节响应 Schema
 */
export const TraceOrderChainResponseSchema = z.object({
  orderNo: z.string().openapi({ description: '查询用的订单标识原值' }),
  matchedBy: z.enum(['SALES_ORDER_PO_NO', 'SALES_ORDER_NO', 'WORK_ORDER_NO', 'ORDER_NO']).openapi({ description: '命中的订单字段' }),
  customerName: z.string().optional().openapi({ description: '客户名称' }),
  erpStatus: z.string().optional().openapi({ description: 'ERP 出库单状态（待审核 / 已审核 / 已拦截）' }),
  salesOrderNo: z.string().optional().openapi({ description: '销售出库单号' }),
  salesOrderPoNo: z.string().optional().openapi({ description: '客户采购订单号' }),
  batchNos: z.array(z.string()).openapi({ description: '本订单涉及的批次号清单（去重升序）' }),
  materialCode: z.string().optional().openapi({ description: '成品编码' }),
  materialName: z.string().optional().openapi({ description: '成品名称' }),
  totalQty: z.number().optional().openapi({ description: '出货数量' }),
  stages: z.array(TraceOrderChainStageSchema).openapi({ description: '检验环节明细（按工艺序位升序）' }),
}).openapi('TraceOrderChainResponse');
