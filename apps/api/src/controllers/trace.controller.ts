import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { TraceDirectionEnum } from '@letian/contracts';
import type { ApiContainer } from '../container';
import { operatorOf } from '../lib/operator';
import {
  buildRequestSecurityContext,
  logAuthorizationCheck,
} from '../lib/permission-guard';

const TraceQuerySchema = z.object({
  direction: TraceDirectionEnum.default('BOTH'),
  maxDepth: z.coerce.number().int().min(1).max(10).default(5),
});

const TraceParamsSchema = z.object({
  batchNo: z.string().min(1, '批次号不能为空'),
});

/**
 * 批次检索查询条件。
 *
 * 追溯主键是批次号（PRD §3.1），订单号 / 物料编码 / 成品名称只是**检索条件**：
 * 命中结果是一张批次清单，界面点选某一行后才以该批次为根开图（docs/24 §5.3）。
 * 过滤条件全部下沉 SQL，前端不得二次过滤。
 */
const TraceBatchSearchQuerySchema = z.object({
  /** 批次号 或 炉批号，模糊匹配 */
  batchNo: z.string().min(1).optional(),
  /** 订单号：同时匹配检验单号 / 工单号 / 销售出库单号 / 客户采购订单号 */
  orderNo: z.string().min(1).optional(),
  materialCode: z.string().min(1).optional(),
  productName: z.string().min(1).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

const TraceOrderParamsSchema = z.object({
  orderNo: z.string().min(1, '订单号不能为空'),
});

/**
 * 契约 TraceDirectionEnum(FORWARD/BACKWARD) → 用例穿透方向(DOWNSTREAM/UPSTREAM) 映射。
 * FORWARD 表示沿生产流向（原材料 → 成品 → 发货）正向穿透，即图上的 source → target。
 */
const DIRECTION_TO_COMMAND = {
  FORWARD: 'DOWNSTREAM',
  BACKWARD: 'UPSTREAM',
  BOTH: 'BOTH',
} as const;

/**
 * 批次全链路双向追溯控制器
 *
 * 响应结构对齐契约 TraceabilityGraphResponse：{ batchNo, hasCycle, nodes, edges }。
 * 图数据与成环保护全部由 PenetrateBatchDagUseCase 基于 batch_trace_nodes / batch_trace_relations 计算。
 * 注入三维 PBAC 节点级权限过滤与起始批次安全上下文。
 */
export const traceController: FastifyPluginAsync<{ container: ApiContainer }> = async (
  fastify,
  options
) => {
  const { container } = options;

  // 批次检索：先出「命中批次清单」，再由界面点选开图。
  // 静态路径 /batches 必须早于参数路径 /:batchNo 注册，避免被参数路由抢先匹配。
  fastify.get(
    '/batches',
    {
      schema: {
        querystring: TraceBatchSearchQuerySchema,
      },
    },
    async (request, reply) => {
      const query = request.query as z.infer<typeof TraceBatchSearchQuerySchema>;
      const operator = operatorOf(request);
      const securityCtx = await buildRequestSecurityContext(request, container);

      const result = await container.useCases.searchTraceBatches.execute(
        {
          ...(query.batchNo !== undefined ? { batchNo: query.batchNo } : {}),
          ...(query.orderNo !== undefined ? { orderNo: query.orderNo } : {}),
          ...(query.materialCode !== undefined ? { materialCode: query.materialCode } : {}),
          ...(query.productName !== undefined ? { productName: query.productName } : {}),
          page: query.page,
          pageSize: query.pageSize,
        },
        securityCtx
      );

      logAuthorizationCheck(container, {
        userId: operator.userId,
        userName: operator.userName,
        roleCode: operator.role,
        resourceType: 'BATCH_TRACE',
        resourceId: `batches:${query.batchNo ?? query.orderNo ?? query.materialCode ?? query.productName ?? '*'}`,
        action: 'READ',
        decision: 'ALLOWED',
        detail: `批次检索命中 ${result.total} 个受权批次，当页返回 ${result.items.length} 行`,
      });

      return reply.status(200).send(result);
    }
  );

  // 订单维度检验环节台账：「本订单检验环节」，不是血缘链路（docs/24 §4 R5）。
  fastify.get(
    '/orders/:orderNo',
    {
      schema: {
        params: TraceOrderParamsSchema,
      },
    },
    async (request, reply) => {
      const { orderNo } = request.params as z.infer<typeof TraceOrderParamsSchema>;
      const operator = operatorOf(request);
      const securityCtx = await buildRequestSecurityContext(request, container);

      const chain = await container.useCases.getOrderTraceChain.execute({ orderNo }, securityCtx);

      logAuthorizationCheck(container, {
        userId: operator.userId,
        userName: operator.userName,
        roleCode: operator.role,
        resourceType: 'BATCH_TRACE',
        resourceId: orderNo,
        action: 'READ',
        decision: 'ALLOWED',
        detail: `订单 [${orderNo}] 检验环节台账查询成功，返回 ${chain.stages.length} 个环节`,
      });

      return reply.status(200).send(chain);
    }
  );

  fastify.get(
    '/:batchNo',
    {
      schema: {
        params: TraceParamsSchema,
        querystring: TraceQuerySchema,
      },
    },
    async (request, reply) => {
      const { batchNo } = request.params as z.infer<typeof TraceParamsSchema>;
      const { direction, maxDepth } = request.query as z.infer<typeof TraceQuerySchema>;
      const operator = operatorOf(request);
      const securityCtx = await buildRequestSecurityContext(request, container);

      const graph = await container.useCases.penetrateBatchDag.execute(
        {
          batchNo,
          direction: DIRECTION_TO_COMMAND[direction],
          maxDepth,
          operatorId: operator.userId,
          operatorName: operator.userName,
        },
        securityCtx
      );

      // 记录敏感追溯图谱访问日志
      logAuthorizationCheck(container, {
        userId: operator.userId,
        userName: operator.userName,
        roleCode: operator.role,
        resourceType: 'BATCH_TRACE',
        resourceId: batchNo,
        action: 'READ',
        decision: 'ALLOWED',
        detail: `追溯批次 [${batchNo}] 图谱查询成功，过滤后返回 ${graph.nodes.length} 个受权节点`,
      });

      return reply.status(200).send(graph);
    }
  );
};
