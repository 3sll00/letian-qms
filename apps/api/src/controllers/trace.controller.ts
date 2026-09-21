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
