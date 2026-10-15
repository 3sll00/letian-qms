import path from 'node:path';
import Fastify, { FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import { zodValidatorPlugin, errorHandlerPlugin, authPlugin } from './plugins';
import { createApiContainer, type ApiContainer } from './container';
import {
  authController,
  reviewFlowsController,
  dashboardController,
  releaseGatesController,
  inspectionsController,
  mrbController,
  auditController,
  traceController,
  plansController,
  processSettingsController,
  integrationController,
  masterDataController,
  exportController,
  reportTemplatesController,
  permissionsController,
  equipmentController,
} from './controllers';

export interface BuildAppOptions {
  logger?: boolean;
  /**
   * 依赖容器。缺省时由 buildApp 自行创建一个（连接真实 PostgreSQL），
   * 并在 app.close() 时销毁连接池；由调用方注入时生命周期由调用方负责。
   */
  container?: ApiContainer;
}

export async function buildApp(options: BuildAppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: options.logger ?? false,
  });

  const container = options.container ?? createApiContainer();
  const ownsContainer = options.container === undefined;

  // 1. 注册核心通用中间件与跨域
  await app.register(cors, {
    origin: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  });

  // 1.1 multipart 表单解析（方案 Excel 导入 POST /api/v1/plans/import 使用）：
  //     单文件、上限 10MB；超限的文件流被截断并由路由侧明确拒绝，不静默入库
  await app.register(multipart, {
    limits: { fileSize: 10 * 1024 * 1024, files: 1 },
  });

  // 2. 注册 Zod 契约校验与 RFC 7807 统一错误响应插件
  await app.register(zodValidatorPlugin);
  await app.register(errorHandlerPlugin);

  // 3. 注册 JWT 身份认证插件（按路由进行策略鉴权）
  await app.register(authPlugin, { container });

  // 4. 根健康检查（免鉴权，供探针使用）
  app.get('/health', async () => {
    return {
      status: 'UP',
      service: 'letian-qms-api',
      timestamp: new Date().toISOString(),
    };
  });

  // 5. 开发态登录入口（免鉴权）：非生产环境注册，生产环境下 authController 自身不注册任何路由
  await app.register(authController, { prefix: '/api/v1/auth', container });

  // 6. 注册对齐 OpenAPI 规范的所有业务控制器 (前缀: /api/v1)
  //    全部业务路由挂在受保护作用域内：先执行 authenticate，再进入各控制器
  await app.register(
    async (v1) => {
      v1.addHook('onRequest', v1.authenticate);

      // 质量总览看板
      await v1.register(dashboardController, { prefix: '/dashboard', container });

      // 成品检放行强制关卡（纯读幂等校验）
      await v1.register(releaseGatesController, { prefix: '/release-gates', container });

      // 检验单与指标录入
      await v1.register(inspectionsController, { prefix: '/inspections', container });

      // MRB 不合格品评审与处置
      await v1.register(mrbController, { prefix: '/mrb', container });

      // MRB 评审流程设置
      await v1.register(reviewFlowsController, { prefix: '/review-flows', container });

      // 操作审计日志与统计卡片
      await v1.register(auditController, { prefix: '/audit', container });

      // 批次全链路双向追溯（历史路径）
      await v1.register(traceController, { prefix: '/trace', container });
      // 批次全链路双向追溯（对齐前端调用路径 /api/v1/traceability/graph/:batchNo）
      await v1.register(traceController, { prefix: '/traceability/graph', container });
      // 质量追溯看板：批次检索（/traceability/batches）与订单检验环节（/traceability/orders/:orderNo）
      await v1.register(traceController, { prefix: '/traceability', container });

      // 质检方案库
      await v1.register(plansController, { prefix: '/plans', container });

      // 工艺质检流程设置与工序模板
      await v1.register(processSettingsController, { prefix: '/process-settings', container });

      // MES/ERP 外部数据同步与网关配置
      await v1.register(integrationController, { prefix: '/integration', container });

      // ERP 主数据档案（供应商 / 客户 / 存货 / 车间 / 职员 / 分类树）
      await v1.register(masterDataController, { prefix: '/master-data', container });

      // 报表与检验数据导出
      await v1.register(exportController, { prefix: '/export', container });

      // 质检报告多模板与四段式导出
      await v1.register(reportTemplatesController, { container });

      // 系统管理 - 物料权限管理、角色字典与校验日志
      await v1.register(permissionsController, { prefix: '/permissions', container });

      // 系统管理 - 设备管理台账（迁移 049：编码自动发号，字段全部可选）
      await v1.register(equipmentController, { prefix: '/equipments', container });
    },
    { prefix: '/api/v1' }
  );

  // 6.5 生产态托管前端静态文件（客户内网单进程部署：API + 静态 Web 同端口）。
  //     开发态不启用（SERVE_WEB 未设置且 NODE_ENV != production），前端仍走 Vite 31100 代理。
  //     注意：SPA 回退不在此处注册 —— 根级 setNotFoundHandler 已被 errorHandlerPlugin 占用，
  //     重复注册会抛 FST_ERR_DUPLICATED_NOT_FOUND_HANDLER；回退逻辑并入该插件（见 error-handler.ts）。
  if (process.env.SERVE_WEB === '1' || process.env.NODE_ENV === 'production') {
    const publicDir = path.resolve(__dirname, process.env.WEB_PUBLIC_DIR ?? '../public');
    await app.register(fastifyStatic, {
      root: publicDir,
      prefix: '/',
      wildcard: false,
    });
  }

  // 7. 关闭应用时释放容器自建的连接池，避免测试进程残留连接
  if (ownsContainer) {
    app.addHook('onClose', async () => {
      await container.dispose();
    });
  }

  return app;
}
