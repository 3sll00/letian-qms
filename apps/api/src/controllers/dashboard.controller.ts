import { FastifyPluginAsync } from 'fastify';
import type { ApiContainer } from '../container';

/**
 * 质量总览看板控制器
 *
 * 全部指标由 KyselyDashboardRepository 基于真实库聚合：
 * - /overview 与旧内存口径一致（总数 / 合格率 / 状态计数 / 工序分布 / 7 日趋势 / 缺陷 TopN / 最近动态）
 * - /stats 为图表看板口径（今日检验、良率、拦截批次、缺陷分布、周趋势、拦截事件），不含设备类指标
 */
export const dashboardController: FastifyPluginAsync<{ container: ApiContainer }> = async (
  fastify,
  options
) => {
  const dashboard = options.container.repositories.dashboard;

  fastify.get('/overview', async (_request, reply) => {
    const overview = await dashboard.getOverview();
    return reply.status(200).send(overview);
  });

  fastify.get('/stats', async (_request, reply) => {
    const stats = await dashboard.getStats();
    return reply.status(200).send(stats);
  });
};
