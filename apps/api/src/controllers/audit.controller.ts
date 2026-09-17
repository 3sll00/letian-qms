import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import {
  AuditActionEnum,
  AuditStatusEnum,
} from '@letian/contracts';
import type { ApiContainer } from '../container';

const AuditLogQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  action: AuditActionEnum.optional(),
  status: AuditStatusEnum.optional(),
  resourceType: z.string().optional(),
  resourceId: z.string().optional(),
});

export const auditController: FastifyPluginAsync<{ container: ApiContainer }> = async (
  fastify,
  options
) => {
  const auditLogs = options.container.repositories.auditLogs;

  // 1. 获取系统操作日志汇总统计卡片
  // 严格对齐 OpenAPI 的 AuditStatsResponse: { totalLogs, successCount, failedCount, todayCount }
  fastify.get('/stats', async (_request, reply) => {
    const stats = await auditLogs.getStats();
    return reply.status(200).send(stats);
  });

  // 2. 分页获取系统关键操作审计日志列表（append-only 防篡改流）
  fastify.get(
    '/logs',
    {
      schema: {
        querystring: AuditLogQuerySchema,
      },
    },
    async (request, reply) => {
      const query = request.query as z.infer<typeof AuditLogQuerySchema>;

      const result = await auditLogs.queryLogs({
        limit: query.pageSize,
        offset: (query.page - 1) * query.pageSize,
        ...(query.action !== undefined ? { action: query.action } : {}),
        ...(query.status !== undefined ? { status: query.status } : {}),
        ...(query.resourceType !== undefined ? { resourceType: query.resourceType } : {}),
        ...(query.resourceId !== undefined ? { resourceId: query.resourceId } : {}),
      });

      return reply.status(200).send({
        total: result.total,
        page: query.page,
        pageSize: query.pageSize,
        items: result.items,
        // 兼容别名：早期契约消费方使用 list，与 items 指向同一份当页数据
        list: result.items,
      });
    }
  );
};
