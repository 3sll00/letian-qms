import { FastifyPluginAsync } from 'fastify';
import type { ApiContainer } from '../container';
import { getRequestPermissions, logAuthorizationCheck } from '../lib/permission-guard';
import { operatorOf } from '../lib/operator';

/**
 * 质量总览看板控制器
 *
 * 全部指标由 KyselyDashboardRepository 基于真实库聚合：
 * - /overview 与旧内存口径一致（总数 / 合格率 / 状态计数 / 工序分布 / 7 日趋势 / 缺陷 TopN / 最近动态）
 * - /stats 为图表看板口径（今日检验、良率、拦截批次、缺陷分布、周趋势、拦截事件），不含设备类指标
 * 均支持三维 PBAC 行级数据隔离。
 */
export const dashboardController: FastifyPluginAsync<{ container: ApiContainer }> = async (
  fastify,
  options
) => {
  const { container } = options;
  const dashboard = container.repositories.dashboard;

  fastify.get('/overview', async (request, reply) => {
    const operator = operatorOf(request);
    const permissions = await getRequestPermissions(request, container);
    const overview = await dashboard.getOverview(permissions);

    // 记录看板敏感数据读取审计
    logAuthorizationCheck(container, {
      userId: operator.userId,
      userName: operator.userName,
      roleCode: operator.role,
      resourceType: 'DASHBOARD',
      resourceId: 'OVERVIEW',
      action: 'READ',
      decision: 'ALLOWED',
      detail: `看板质量总览加载成功（受 ${permissions.length} 条 PBAC 规则隔离）`,
    });

    return reply.status(200).send(overview);
  });

  fastify.get('/stats', async (request, reply) => {
    const operator = operatorOf(request);
    const permissions = await getRequestPermissions(request, container);
    const stats = await dashboard.getStats(permissions);

    logAuthorizationCheck(container, {
      userId: operator.userId,
      userName: operator.userName,
      roleCode: operator.role,
      resourceType: 'DASHBOARD',
      resourceId: 'STATS',
      action: 'READ',
      decision: 'ALLOWED',
      detail: `看板统计图表加载成功（受 ${permissions.length} 条 PBAC 规则隔离）`,
    });

    return reply.status(200).send(stats);
  });
};
