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
 */
export const TraceNodeStatusEnum = z.enum([
  'PASSED',
  'FAILED',
  'INSPECTING',
  'PENDING',
  'STORED',
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
 * 批次追溯全景 DAG 响应 Schema
 */
export const TraceabilityGraphResponseSchema = z.object({
  batchNo: z.string().openapi({ description: '查询目标根批次号', example: 'LOT-2026-FN-01' }),
  hasCycle: z.boolean().default(false).openapi({ description: '整条全链路是否存在循环引用' }),
  nodes: z.array(TraceNodeSchema).openapi({ description: '追溯拓扑所有节点' }),
  edges: z.array(TraceEdgeSchema).openapi({ description: '追溯拓扑有向边集合' }),
}).openapi('TraceabilityGraphResponse');
