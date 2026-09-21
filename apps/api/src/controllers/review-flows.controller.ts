import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { ApiContainer } from '../container';
import { operatorOf } from '../lib/operator';
import { NotFoundError } from '@letian/application';
import { ReviewFlowSchema } from '@letian/contracts';

export const reviewFlowsController: FastifyPluginAsync<{ container: ApiContainer }> = async (
  fastify,
  options
) => {
  const { container } = options;
  const repo = container.repositories.reviewFlows;

  // 1. 获取所有评审流程列表
  fastify.get('/', async (_request, reply) => {
    const flows = await repo.listAll();
    return reply.status(200).send({
      total: flows.length,
      items: flows,
    });
  });

  // 2. 按适用类别获取当前生效的流程定义
  fastify.get('/applicable/:category', async (request, reply) => {
    const { category } = request.params as { category: string };
    const flow = await repo.findApplicableFlow(category);
    if (!flow) {
      throw new NotFoundError(`未找到适用于 ${category} 的有效评审流程定义`);
    }
    return reply.status(200).send(flow);
  });

  // 3. 按 ID 获取单条流程
  fastify.get('/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const flow = await repo.findById(id);
    if (!flow) {
      throw new NotFoundError(`流程定义不存在: ${id}`);
    }
    return reply.status(200).send(flow);
  });

  // 4. 保存或更新流程定义
  fastify.post(
    '/',
    {
      schema: {
        body: ReviewFlowSchema,
      },
    },
    async (request, reply) => {
      const flow = request.body as z.infer<typeof ReviewFlowSchema>;
      const operator = operatorOf(request);

      await repo.save(flow);

      await container.repositories.auditLogs.append({
        id: crypto.randomUUID(),
        traceId: (request.headers['x-trace-id'] as string) || `trace_${Date.now()}`,
        userId: operator.userId,
        userName: operator.userName,
        action: 'UPDATE',
        resourceType: 'REVIEW_FLOW',
        resourceId: flow.flowCode,
        status: 'SUCCESS',
        diffPatch: {
          flowCode: flow.flowCode,
          applicableType: flow.applicableType,
          nodeCount: flow.nodes.length,
        },
        createdAt: new Date().toISOString(),
      });

      return reply.status(200).send({
        success: true,
        message: '评审流程配置已更新并落库',
        flow,
      });
    }
  );

  // 5. 切换流程激活状态
  fastify.post('/:id/toggle-active', async (request, reply) => {
    const { id } = request.params as { id: string };
    const flow = await repo.findById(id);
    if (!flow) {
      throw new NotFoundError(`流程定义不存在: ${id}`);
    }

    const updated = {
      ...flow,
      isActive: !flow.isActive,
    };

    await repo.save(updated);

    return reply.status(200).send({
      success: true,
      id: flow.id,
      isActive: updated.isActive,
    });
  });
};
