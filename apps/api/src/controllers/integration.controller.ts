import {
  createFixtureErpReads,
  createMssqlErpReads,
  fetchMesCheckReports,
  fetchMesOqcSourceBundle,
  fetchMesProcedures,
  fetchMesProductionTasks,
  getErpConnectionPool,
  syncErpMasterData,
  syncMesAll,
  testMesConnection,
} from '@letian/infrastructure';
import { FastifyPluginAsync } from 'fastify';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  ErpSalesDispatchSyncRequestSchema,
  ErpSourcePreviewQuerySchema,
  ErpSourceSyncRequestSchema,
  ErrorCode,
  IntegrationConfigSchema,
  MesPagedQuerySchema,
  OqcSourcesQuerySchema,
  SystemTypeEnum,
  type IntegrationConfig,
  type IntegrationSyncLog,
} from '@letian/contracts';
import {
  ApplicationError,
  NotFoundError,
  type IIncomingInspectionSource,
  type SyncErpIncomingInspectionsInput,
  type ISalesDispatchSource,
  type SyncErpSalesDispatchInput,
  type IOutsourceInspectionSource,
  type SyncErpOutsourceInspectionsInput,
  SyncErpOutsourceInspectionsUseCase,
} from '@letian/application';
import type { ApiContainer } from '../container';
import { MES_EQUIPMENT_CATALOG, MES_INTERCEPTION_RULES } from '../data/mes-gateway';
import { appendDbAuditLog } from '../lib/audit-log';

const SyncHistoryQuerySchema = z.object({
  systemType: SystemTypeEnum.optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

/** 旧版 MES 配置维护接口的请求体（字段名沿用历史契约） */
const UpdateMESConfigSchema = z.object({
  mesEndpointUrl: z.string().url('MES端点必须为有效URL').optional(),
  authSecretKey: z.string().min(6, '密钥最小长度为6位').optional(),
  syncIntervalMinutes: z.number().int().min(1).max(1440).optional(),
  enableAutoGateCheck: z.boolean().optional(),
});

/** 手动同步触发请求体：兼容契约的 {systemType,syncScope} 与历史 {target} 两种写法 */
const TriggerSyncRequestSchema = z.object({
  systemType: SystemTypeEnum.optional(),
  syncScope: z.enum(['ALL', 'INCREMENTAL']).default('INCREMENTAL'),
  target: z.string().min(1).optional(),
});

const EquipmentParamsSchema = z.object({
  id: z.string().min(1),
});

const EquipmentStatusSchema = z.object({
  status: z.enum(['ONLINE', 'INTERCEPTED', 'OFFLINE']),
});

const ConfigParamsSchema = z.object({
  systemType: SystemTypeEnum,
});

/** 默认轮询间隔（分钟），与契约 cronSchedule 默认值 '0 *&#47;5 * * * *' 一致 */
const DEFAULT_SYNC_INTERVAL_MINUTES = 5;

/** cron 表达式 → 轮询分钟数（仅识别标准的 "0 *&#47;N * * * *" 形式，其余回退默认值） */
function cronToIntervalMinutes(cron: string): number {
  const matched = /^\S+\s+\*\/(\d+)\s/.exec(cron);
  return matched ? Number(matched[1]) : DEFAULT_SYNC_INTERVAL_MINUTES;
}

/** 轮询分钟数 → cron 表达式（与 cronToIntervalMinutes 互为逆映射） */
function intervalMinutesToCron(minutes: number): string {
  return `0 */${minutes} * * * *`;
}

/** 历史 target 取值 → 外部系统类型 */
function targetToSystemType(target: string | undefined): 'MES' | 'ERP' {
  return target === 'ERP_MASTER_DATA' ? 'ERP' : 'MES';
}

function externalServiceError(
  systemType: 'MES' | 'ERP',
  status: 500 | 503,
  detail: string
): ApplicationError {
  return new ApplicationError({
    code: systemType === 'ERP' ? ErrorCode.ERP_SYNC_FAILED : ErrorCode.MES_GATEWAY_TIMEOUT,
    title: `${systemType} 数据服务异常`,
    status,
    detail,
  });
}

export const integrationController: FastifyPluginAsync<{ container: ApiContainer }> = async (
  fastify,
  options
) => {
  const { container } = options;
  const integration = container.repositories.integration;
  const masterData = container.repositories.masterData;

  // 1. 集成配置列表（契约 IntegrationConfigSchema；密钥不回显）
  fastify.get('/configs', async (_request, reply) => {
    return reply.status(200).send(await integration.listConfigs());
  });

  // 2. 按系统类型读取集成配置
  fastify.get(
    '/configs/:systemType',
    { schema: { params: ConfigParamsSchema } },
    async (request, reply) => {
      const { systemType } = request.params as z.infer<typeof ConfigParamsSchema>;
      const config = await integration.findConfig(systemType);
      if (!config) {
        throw new NotFoundError(`未找到 [${systemType}] 集成配置`);
      }
      return reply.status(200).send(config);
    }
  );

  // 3. 更新集成配置（按 system_type UPSERT）
  fastify.put(
    '/configs/:systemType',
    {
      schema: {
        params: ConfigParamsSchema,
        body: IntegrationConfigSchema.partial().omit({ systemType: true }),
      },
    },
    async (request, reply) => {
      const { systemType } = request.params as z.infer<typeof ConfigParamsSchema>;
      const body = request.body as Partial<Omit<IntegrationConfig, 'systemType'>>;

      const existing = await integration.findConfig(systemType);
      if (!existing) {
        throw new NotFoundError(`未找到 [${systemType}] 集成配置，无法更新未注册的系统`);
      }

      const merged: IntegrationConfig = {
        ...existing,
        ...(body.serviceUrl !== undefined ? { serviceUrl: body.serviceUrl } : {}),
        ...(body.authToken !== undefined ? { authToken: body.authToken } : {}),
        ...(body.subscribedWorkshops !== undefined
          ? { subscribedWorkshops: body.subscribedWorkshops }
          : {}),
        ...(body.subscribedProcesses !== undefined
          ? { subscribedProcesses: body.subscribedProcesses }
          : {}),
        ...(body.cronSchedule !== undefined ? { cronSchedule: body.cronSchedule } : {}),
        ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
      };

      await integration.upsertConfig(merged);
      await appendDbAuditLog(container.uow, request, {
        action: 'UPDATE',
        resourceType: 'INTEGRATION_CONFIG',
        resourceId: merged.id ?? systemType,
        diffPatch: {
          systemType,
          serviceUrl: merged.serviceUrl,
          enabled: merged.enabled,
          // 密钥属于敏感字段，审计日志仅记录「已变更」
          ...(body.authToken !== undefined ? { authToken: '[MASKED]' } : {}),
        },
      });

      return reply.status(200).send(merged);
    }
  );

  // 4. 旧版 MES 配置查询（字段名沿用历史契约，取值全部来自 integration_configs 的 MES 行）
  fastify.get('/mes/config', async (_request, reply) => {
    const config = await integration.findConfig('MES');
    if (!config) {
      throw new NotFoundError('未找到 MES 集成配置');
    }

    return reply.status(200).send({
      ...config,
      mesEndpointUrl: config.serviceUrl,
      syncIntervalMinutes: cronToIntervalMinutes(config.cronSchedule),
      enableAutoGateCheck: config.enabled,
      authSecretKey: '[MASKED]',
    });
  });

  // 5. 旧版 MES 配置更新（映射到 integration_configs 的 MES 行）
  fastify.put(
    '/mes/config',
    {
      schema: {
        body: UpdateMESConfigSchema,
      },
    },
    async (request, reply) => {
      const body = request.body as z.infer<typeof UpdateMESConfigSchema>;

      const existing = await integration.findConfig('MES');
      if (!existing) {
        throw new NotFoundError('未找到 MES 集成配置');
      }

      const merged: IntegrationConfig = {
        ...existing,
        ...(body.mesEndpointUrl !== undefined ? { serviceUrl: body.mesEndpointUrl } : {}),
        ...(body.authSecretKey !== undefined ? { authToken: body.authSecretKey } : {}),
        ...(body.syncIntervalMinutes !== undefined
          ? { cronSchedule: intervalMinutesToCron(body.syncIntervalMinutes) }
          : {}),
        ...(body.enableAutoGateCheck !== undefined ? { enabled: body.enableAutoGateCheck } : {}),
      };

      await integration.upsertConfig(merged);
      await appendDbAuditLog(container.uow, request, {
        action: 'UPDATE',
        resourceType: 'MES_CONFIG',
        resourceId: merged.id ?? 'MES',
        diffPatch: {
          ...(body.mesEndpointUrl !== undefined ? { mesEndpointUrl: body.mesEndpointUrl } : {}),
          ...(body.syncIntervalMinutes !== undefined
            ? { syncIntervalMinutes: body.syncIntervalMinutes }
            : {}),
          ...(body.enableAutoGateCheck !== undefined
            ? { enableAutoGateCheck: body.enableAutoGateCheck }
            : {}),
          ...(body.authSecretKey !== undefined ? { authSecretKey: '[MASKED]' } : {}),
        },
      });

      return reply.status(200).send({
        ...merged,
        mesEndpointUrl: merged.serviceUrl,
        syncIntervalMinutes: cronToIntervalMinutes(merged.cronSchedule),
        enableAutoGateCheck: merged.enabled,
        authSecretKey: '[MASKED]',
      });
    }
  );

  // 6. 手动触发外部数据同步
  //
  // ⚠️ 说明：本环境没有任何可达的外部 MES/ERP 服务，因此这里不伪造"已从外部系统拉取 N 条"，
  // 而是对本地已镜像的主数据 / 检验工单做一次真实清点，把真实行数写入 integration_sync_logs，
  // 让同步流水与库中数据一致。接入真实外部系统时需要替换这里的清点逻辑为远端调用。
  fastify.post(
    '/sync/trigger',
    {
      schema: {
        body: TriggerSyncRequestSchema,
      },
    },
    async (request, reply) => {
      const body = request.body as z.infer<typeof TriggerSyncRequestSchema>;
      const systemType = body.systemType ?? targetToSystemType(body.target);
      const target = body.target ?? (systemType === 'ERP' ? 'ERP_MASTER_DATA' : 'MES_PRODUCTION_BATCHES');

            let recordsCount = 0;
      let syncDetails: any = null;

      if (systemType === 'MES') {
        try {
          const mesResult = await syncMesAll();
          recordsCount =
            mesResult.syncedWorkshops +
            mesResult.syncedInspectionOrders +
            mesResult.syncedTraceNodes;
          syncDetails = mesResult.details;
        } catch (mesErr: any) {
          fastify.log.error(mesErr, 'MES 数据同步异常');
        }
      } else {
        const [materials, suppliers, customers, workshops, employees] = await Promise.all([
          masterData.getMaterials(),
          masterData.getSuppliers(),
          masterData.getCustomers(),
          masterData.getWorkshops(),
          masterData.getEmployees(),
        ]);
        recordsCount =
          materials.length +
          suppliers.length +
          customers.length +
          workshops.length +
          employees.length;
      }

      const syncLogId = randomUUID();
      const batchNo = `SYNC-${systemType}-${Date.now().toString().slice(-8)}`;

      const syncLog: IntegrationSyncLog = {
        id: syncLogId,
        batchNo,
        systemType,
        syncDirection: 'PULL',
        status: 'SUCCESS',
        recordsCount,
        createdAt: new Date().toISOString(),
      };

      // task_name 列宽 VARCHAR(64)：明细 JSON 会超宽触发 22001，
      // 明细已持久化在下方 audit diffPatch 与响应体，任务名保持短名
      await integration.appendSyncLog(
        syncLog,
        systemType === 'ERP' ? '本地 ERP 主数据镜像清点' : 'MES车间生产与质检实绩数据同步'
      );

      await appendDbAuditLog(container.uow, request, {
        action: 'SYNC_TRIGGER',
        resourceType: 'DATA_SYNC',
        resourceId: syncLogId,
        diffPatch: { target, systemType, recordsCount, details: syncDetails },
      });

      return reply.status(200).send({
        syncLogId,
        batchNo,
        target,
        systemType,
        syncDirection: 'PULL',
        status: 'SUCCESS',
        recordsCount,
        details: syncDetails,
        message:
          systemType === 'ERP'
            ? `已清点本地 ERP 主数据镜像 ${recordsCount} 条记录`
            : `已从 MES 测试库 (mes_letian_test) 同步 ${recordsCount} 条生产质检数据`,
        syncedAt: syncLog.createdAt,
      });
    }
  );

  // ERP主数据即时同步（供前端主数据页面一键同步调用）
  fastify.post('/sync', async (request, reply) => {
    try {
      const result = await syncErpMasterData();
      return reply.status(200).send({
        success: true,
        message: 'ERP主数据同步完成',
        details: result,
      });
    } catch (err) {
      throw externalServiceError('ERP', 500, err instanceof Error ? err.message : '同步异常');
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // ERP 来料检验拉取并生成 QMS 来料检验单（第①段闭环：ERP 读取 -> QMS 建单）
  // ─────────────────────────────────────────────────────────────────────────

  /** 构造来料检验数据源：useFixture 走本地样例（无 ERP 也能演示），否则直连 ERP（不可达返回 null） */
  async function buildIncomingInspectionSource(
    body: { useFixture?: boolean | undefined; rows?: unknown[] | undefined } | undefined
  ): Promise<{ source: IIncomingInspectionSource; fixture: boolean } | null> {
    if (body?.useFixture && Array.isArray(body.rows)) {
      return {
        source: createFixtureErpReads({ incomingInspections: body.rows as any }),
        fixture: true,
      };
    }
    const pool = await getErpConnectionPool();
    if (!pool) return null;
    return { source: createMssqlErpReads(pool), fixture: false };
  }

  /** 解析当前操作人（审计/建单归属）；未登录时回落系统账号 */
  function resolveSyncOperator(request: any): { operatorId: string; operatorName: string } {
    const actor = request?.user;
    if (actor) {
      return {
        operatorId: actor.userId ?? actor.id ?? 'SYS-ERP-SYNC',
        operatorName: actor.userName ?? actor.name ?? 'ERP同步服务',
      };
    }
    return { operatorId: 'SYS-ERP-SYNC', operatorName: 'ERP同步服务' };
  }

  // GET /erp/incoming-inspections —— 只读预览：拉取 ERP 来料检验，不建单（供前端「从 ERP 拉单」前确认）
  fastify.get(
    '/erp/incoming-inspections',
    { schema: { querystring: ErpSourcePreviewQuerySchema } },
    async (request, reply) => {
      const query = request.query as z.infer<typeof ErpSourcePreviewQuerySchema>;
      const built = await buildIncomingInspectionSource(undefined);
      if (!built) {
        throw externalServiceError('ERP', 503, 'ERP 数据库连接不可用（ERP_DB_* 未配置或网络不可达），无法拉取来料检验');
      }
      try {
        const rows = await built.source.fetchIncomingInspections(query.limit ?? 500);
        return reply.status(200).send({
          success: true,
          source: built.fixture ? 'FIXTURE' : 'ERP',
          total: rows.length,
          items: rows,
        });
      } catch (err) {
        throw externalServiceError('ERP', 500, err instanceof Error ? err.message : '拉取异常');
      }
    }
  );

  // POST /erp/incoming-inspections/sync —— 拉取 ERP 来料检验并生成 QMS 来料检验单（IQC）
  //   - 真实环境：直连 ERP，逐行映射为 IQC 建单（方案快照/审计/Outbox 经 CreateInspectionOrderUseCase 生效）
  //   - 本地演示：body.useFixture=true 且 body.rows 提供样例行，走 fixture 源
  //   - ERP 不可达：返回 503，明确提示无法拉取（与 syncErpMasterData 口径一致）
  fastify.post(
    '/erp/incoming-inspections/sync',
    {
      schema: {
        body: ErpSourceSyncRequestSchema,
      },
    },
    async (request, reply) => {
      const body = request.body as z.infer<typeof ErpSourceSyncRequestSchema>;
      const built = await buildIncomingInspectionSource(body);
      if (!built) {
        throw externalServiceError('ERP', 503, 'ERP 数据库连接不可用（ERP_DB_* 未配置或网络不可达），无法拉取来料检验');
      }

      const operator = resolveSyncOperator(request);
      // exactOptionalPropertyTypes：limit 仅在明确传入时赋值
      const execInput: SyncErpIncomingInspectionsInput = { source: built.source, operator };
      if (body.limit !== undefined) execInput.limit = body.limit;
      try {
        const result = await container.useCases.syncErpIncomingInspections.execute(execInput);

        await appendDbAuditLog(container.uow, request, {
          action: 'SYNC_TRIGGER',
          resourceType: 'ERP_INCOMING_INSPECTION',
          resourceId: 'ERP->QMS',
          diffPatch: {
            source: built.fixture ? 'FIXTURE' : 'ERP',
            total: result.total,
            created: result.created,
            skipped: result.skipped,
            failed: result.failed,
            failures: result.failures,
          },
        });

        return reply.status(200).send({
          success: true,
          message: `已从 ERP 拉取来料检验并生成 ${result.created} 张 QMS 来料检验单（跳过 ${result.skipped} 张已存在，失败 ${result.failed} 张）`,
          ...result,
        });
      } catch (err) {
        throw externalServiceError('ERP', 500, err instanceof Error ? err.message : '同步异常');
      }
    }
  );

  // ─────────────────────────────────────────────────────────────────────────
  // ERP 委外加工单拉取并生成 QMS 委外检验单（委外检验闭环：ERP 读取 -> QMS 建单 OQC_SF/MACH/HEAT）
  // ─────────────────────────────────────────────────────────────────────────

  /** 构造委外加工单数据源：useFixture 走本地样例（无 ERP 也能演示），否则直连 ERP（不可达返回 null） */
  async function buildOutsourceSource(
    body: { useFixture?: boolean | undefined; rows?: unknown[] | undefined } | undefined
  ): Promise<{ source: IOutsourceInspectionSource; fixture: boolean } | null> {
    if (body?.useFixture && Array.isArray(body.rows)) {
      return {
        source: createFixtureErpReads({ outsourceInspections: body.rows as any }),
        fixture: true,
      };
    }
    const pool = await getErpConnectionPool();
    if (!pool) return null;
    return { source: createMssqlErpReads(pool), fixture: false };
  }

  // GET /erp/outsource-inspections —— 只读预览：拉取 ERP 委外加工单，不建单（供前端「从 ERP 拉单」前确认）
  fastify.get(
    '/erp/outsource-inspections',
    { schema: { querystring: ErpSourcePreviewQuerySchema } },
    async (request, reply) => {
      const query = request.query as z.infer<typeof ErpSourcePreviewQuerySchema>;
      const built = await buildOutsourceSource(undefined);
      if (!built) {
        throw externalServiceError('ERP', 503, 'ERP 数据库连接不可用（ERP_DB_* 未配置或网络不可达），无法拉取委外加工单');
      }
      try {
        const rows = await built.source.fetchOutsourceInspections(query.limit ?? 500);
        return reply.status(200).send({
          success: true,
          source: built.fixture ? 'FIXTURE' : 'ERP',
          total: rows.length,
          items: rows,
        });
      } catch (err) {
        throw externalServiceError('ERP', 500, err instanceof Error ? err.message : '拉取异常');
      }
    }
  );

  // POST /erp/outsource-inspections/sync —— 拉取 ERP 委外加工单并生成 QMS 委外检验单
  //   - 真实环境：直连 ERP，逐行按明细备注关键词分类（表面/机加/热处理，默认表面）后映射为 OQC 建单
  //   - 本地演示：body.useFixture=true 且 body.rows 提供样例行，走 fixture 源
  //   - ERP 不可达：返回 503
  fastify.post(
    '/erp/outsource-inspections/sync',
    {
      schema: {
        body: ErpSourceSyncRequestSchema,
      },
    },
    async (request, reply) => {
      const body = request.body as z.infer<typeof ErpSourceSyncRequestSchema>;
      const built = await buildOutsourceSource(body);
      if (!built) {
        throw externalServiceError('ERP', 503, 'ERP 数据库连接不可用（ERP_DB_* 未配置或网络不可达），无法拉取委外加工单');
      }

      const operator = resolveSyncOperator(request);
      const execInput: SyncErpOutsourceInspectionsInput = { source: built.source, operator };
      if (body.limit !== undefined) execInput.limit = body.limit;
      try {
        const result = await container.useCases.syncErpOutsourceInspections.execute(execInput);

        await appendDbAuditLog(container.uow, request, {
          action: 'SYNC_TRIGGER',
          resourceType: 'ERP_OUTSOURCE_INSPECTION',
          resourceId: 'ERP->QMS',
          diffPatch: {
            source: built.fixture ? 'FIXTURE' : 'ERP',
            total: result.total,
            created: result.created,
            createdByType: result.createdByType,
            skipped: result.skipped,
            failed: result.failed,
            failures: result.failures,
          },
        });

        return reply.status(200).send({
          success: true,
          message: `已从 ERP 拉取委外加工单并生成 ${result.created} 张 QMS 委外检验单（表面处理 ${result.createdByType.OQC_SF ?? 0} / 机加工 ${result.createdByType.OQC_MACH ?? 0} / 热处理 ${result.createdByType.OQC_HEAT ?? 0}；跳过 ${result.skipped}，失败 ${result.failed}）`,
          ...result,
        });
      } catch (err) {
        throw externalServiceError('ERP', 500, err instanceof Error ? err.message : '同步异常');
      }
    }
  );

  // ─────────────────────────────────────────────────────────────────────────
  // ERP 销售出库拉取并生成 QMS 出货检验单（出货检验第①段闭环：ERP 读取 -> QMS 建单 OQC_SH）
  // ─────────────────────────────────────────────────────────────────────────

  /** 构造销售出库数据源：useFixture 走本地样例（无 ERP 也能演示），否则直连 ERP（不可达返回 null） */
  async function buildSalesDispatchSource(
    body: { useFixture?: boolean | undefined; rows?: unknown[] | undefined } | undefined
  ): Promise<{ source: ISalesDispatchSource; fixture: boolean } | null> {
    if (body?.useFixture && Array.isArray(body.rows)) {
      return {
        source: createFixtureErpReads({ salesDispatches: body.rows as any }),
        fixture: true,
      };
    }
    const pool = await getErpConnectionPool();
    if (!pool) return null;
    return { source: createMssqlErpReads(pool), fixture: false };
  }

  // GET /erp/sales-dispatches —— 只读预览：拉取 ERP 销售出库，不建单（供前端「从 ERP 拉单」前确认）
  fastify.get(
    '/erp/sales-dispatches',
    { schema: { querystring: ErpSourcePreviewQuerySchema } },
    async (request, reply) => {
      const query = request.query as z.infer<typeof ErpSourcePreviewQuerySchema>;
      const built = await buildSalesDispatchSource(undefined);
      if (!built) {
        throw externalServiceError('ERP', 503, 'ERP 数据库连接不可用（ERP_DB_* 未配置或网络不可达），无法拉取销售出库');
      }
      try {
        const rows = await built.source.fetchSalesDispatch(query.limit ?? 500);
        return reply.status(200).send({
          success: true,
          source: built.fixture ? 'FIXTURE' : 'ERP',
          total: rows.length,
          items: rows,
        });
      } catch (err) {
        throw externalServiceError('ERP', 500, err instanceof Error ? err.message : '拉取异常');
      }
    }
  );

  // POST /erp/sales-dispatches/sync —— 拉取 ERP 销售出库并生成 QMS 出货检验单（OQC_SH）
  //   - 真实环境：直连 ERP，逐行映射为 OQC_SH 建单（方案快照/审计/Outbox 经 CreateInspectionOrderUseCase 生效）
  //   - 本地演示：body.useFixture=true 且 body.rows 提供样例行，走 fixture 源
  //   - ERP 不可达：返回 503，明确提示无法拉取（与 syncErpIncomingInspections 口径一致）
  fastify.post(
    '/erp/sales-dispatches/sync',
    {
      schema: {
        body: ErpSalesDispatchSyncRequestSchema,
      },
    },
    async (request, reply) => {
      const body = request.body as z.infer<typeof ErpSalesDispatchSyncRequestSchema>;
      const built = await buildSalesDispatchSource(body);
      if (!built) {
        throw externalServiceError('ERP', 503, 'ERP 数据库连接不可用（ERP_DB_* 未配置或网络不可达），无法拉取销售出库');
      }

      const operator = resolveSyncOperator(request);
      const execInput: SyncErpSalesDispatchInput = { source: built.source, operator };
      if (body.limit !== undefined) execInput.limit = body.limit;
      if (body.offset !== undefined) execInput.offset = body.offset;
      try {
        const result = await container.useCases.syncErpSalesDispatch.execute(execInput);

        await appendDbAuditLog(container.uow, request, {
          action: 'SYNC_TRIGGER',
          resourceType: 'ERP_SALES_DISPATCH',
          resourceId: 'ERP->QMS',
          diffPatch: {
            source: built.fixture ? 'FIXTURE' : 'ERP',
            total: result.total,
            created: result.created,
            skipped: result.skipped,
            failed: result.failed,
            failures: result.failures,
          },
        });

        return reply.status(200).send({
          success: true,
          message: `已从 ERP 拉取销售出库并生成 ${result.created} 张 QMS 出货检验单（跳过 ${result.skipped} 张已存在，失败 ${result.failed} 张）`,
          ...result,
        });
      } catch (err) {
        throw externalServiceError('ERP', 500, err instanceof Error ? err.message : '同步异常');
      }
    }
  );

  // ─────────────────────────────────────────────────────────────────────────
  // 出货检验（OQC）数据聚合接口
  //
  // 按用户给定口径，把出货检验单所需的五路输入组装为一个统一视图：
  //   ① 出货批次 / 销售订单  → ERP DlySale + DlyNdx（管家婆销售出库）
  //   ② 成品追溯链            → MES t_production_task + 批次 + t_pro_task_serial_number
  //   ③ 过程检验结果          → MES t_check_report + t_check_report_parameter
  //   ④ 物料 / 客户信息       → ERP Ptype + Btype（已镜像到本地 PG materials / customers）
  //   ⑤ 质检方案              → QMS 自建方案（items 软链 ERP TestItem）
  //
  // 判定与回写（用户明确口径）：
  //   - 判定由 QMS 产生（合格数/不合格数/不合格原因），本接口在 judgment 段回显；
  //   - 不回写 ERP：ERP 无对应的出货检验单表，写不进去，判定结果仅存 QMS 供出货放行。
  //
  // 容错：各外部源单独 try/catch，MES/ERP 不可达时仅标记 available=false 并留空，
  //       不整接口 500（聚合接口的核心价值就是"能拿到的都拿到"）。
  // ─────────────────────────────────────────────────────────────────────────
  fastify.get(
    '/oqc/sources',
    { schema: { querystring: OqcSourcesQuerySchema } },
    async (request, reply) => {
      const query = request.query as z.infer<typeof OqcSourcesQuerySchema>;
      const orderId = query.orderId;
      const materialCode = query.materialCode;
      const batchNo = query.batchNo;
      const customerName = query.customerName;

    // ① QMS 出货检验单（锚点）
    let order: any = null;
    if (orderId) {
      try {
        order = await container.repositories.orders.findById(orderId);
      } catch {
        order = null;
      }
      if (!order) {
        throw new NotFoundError(`出货检验单不存在: ${orderId}`);
      }
    }

    const matCode = materialCode ?? order?.materialCode;
    const batNo = batchNo ?? order?.batchNo;
    const custName = customerName ?? order?.customerName;
    const soNo = order?.salesOrderNo;
    const planId = order?.planId;

    // ④ 物料 / 客户主数据（ERP Ptype + Btype 镜像，落本地 PG，可达）
    let material: any = null;
    let customer: any = null;
    try {
      if (matCode) material = await container.repositories.masterData.getMaterialByCode(matCode);
      const customers = await container.repositories.masterData.getCustomers();
      customer =
        customers.find((c: any) => c.customerName === custName) ??
        customers.find((c: any) => (c.customerName ?? '').includes(custName ?? '')) ??
        null;
    } catch {
      // masterData 不可达：降级留空
    }

    // ⑤ 质检方案（QMS 自建 + ERP TestItem 软链）
    let qualityPlan: any = null;
    try {
      if (planId) qualityPlan = await container.repositories.plans.findById(planId);
    } catch {
      // 方案不可达：降级留空
    }

    // ①' ERP 销售出库（最佳努力：直连可达则取实时，否则用 QMS 单上已落库的 ERP 字段）
    let erpSalesDispatch: any = null;
    let erpLive = false;
    const pool = await getErpConnectionPool();
    if (pool) {
      try {
        const erpRows = await createMssqlErpReads(pool).fetchSalesDispatch(500);
        erpSalesDispatch =
          erpRows.find((r: any) => (soNo && r.number === soNo) || (matCode && r.ptypeUserCode === matCode)) ??
          null;
        erpLive = true;
      } catch {
        erpLive = false;
      }
    }

    // ②③ MES 追溯链 + 过程检验（最佳努力：MES 不可达则标记并留空）
    let productionTrace: Record<string, unknown>[] = [];
    let serials: Record<string, unknown>[] = [];
    let processInspections: Record<string, unknown>[] = [];
    let mesAvailable = false;
    try {
      const bundle = await fetchMesOqcSourceBundle({
        ...(matCode !== undefined ? { materialCode: matCode } : {}),
        ...(batNo !== undefined ? { batchNo: batNo } : {}),
        ...(soNo !== undefined ? { salesOrderNo: soNo } : {}),
      });
      productionTrace = bundle.productionTrace;
      serials = bundle.serials;
      processInspections = bundle.processInspections;
      mesAvailable = true;
    } catch {
      mesAvailable = false;
    }

    // ①' 出货批次 / 销售订单视图（ERP 实时优先，否则回退 QMS 单上已落库的 ERP 字段）
    const salesDispatch = order
      ? {
          salesOrderNo: order.salesOrderNo ?? null,
          customerName: order.customerName ?? null,
          batchNo: order.batchNo ?? null,
          dispatchDate: order.dispatchDate ?? null,
          erpStatus: order.erpStatus ?? null,
          salesOrderPoNo: order.salesOrderPoNo ?? null,
          totalQty: order.totalQty ?? null,
          source: erpLive && erpSalesDispatch ? 'ERP_LIVE' : 'QMS_MIRRORED',
          erpRow: erpSalesDispatch,
        }
      : erpSalesDispatch
        ? {
            salesOrderNo: erpSalesDispatch.number,
            customerName: erpSalesDispatch.customerName,
            batchNo: erpSalesDispatch.blockNo,
            dispatchDate: erpSalesDispatch.date,
            erpStatus: null,
            salesOrderPoNo: null,
            totalQty: erpSalesDispatch.qty,
            source: 'ERP_LIVE',
            erpRow: erpSalesDispatch,
          }
        : null;

    return reply.status(200).send({
      success: true,
      orderId: order?.id ?? null,
      orderNo: order?.orderNo ?? null,
      materialCode: matCode ?? null,
      batchNo: batNo ?? null,
      customerName: custName ?? null,
      sources: {
        salesDispatch: { available: !!salesDispatch, live: erpLive, data: salesDispatch },
        productionTrace: {
          available: mesAvailable && productionTrace.length > 0,
          live: mesAvailable,
          count: productionTrace.length,
          data: productionTrace,
          serials,
        },
        processInspections: {
          available: mesAvailable && processInspections.length > 0,
          live: mesAvailable,
          count: processInspections.length,
          data: processInspections,
        },
        materialAndCustomer: {
          available: !!(material || customer),
          data: { material, customer },
        },
        qualityPlan: { available: !!qualityPlan, data: qualityPlan },
      },
      // 判定：由 QMS 产生（合格数/不合格数/不合格原因）
      judgment: {
        source: 'QMS',
        status: order?.status ?? null,
        judgment: order?.judgment ?? null,
        sampleQty: order?.sampleQty ?? null,
        qualifiedQty: order?.passQty ?? null,
        unqualifiedQty: order?.failQty ?? null,
        inspectorName: order?.inspectorName ?? null,
        inspectedDate: order?.inspectedDate ?? null,
        notes: order?.inspectionNotes ?? null,
      },
      // 回写：不回写 ERP（ERP 无出货检验单表）
      writeback: {
        toErp: false,
        reason: 'ERP 无对应的出货检验单表，判定结果仅存 QMS，供出货放行使用',
      },
    });
  });

  // MES车间生产与质检数据即时同步（直连 mes_letian_test，安全隔离）
  fastify.post('/mes/sync', async (request, reply) => {
    try {
      const result = await syncMesAll();
      return reply.status(200).send({
        success: result.success,
        message: result.success ? 'MES车间生产与质检数据同步完成' : 'MES数据同步异常',
        details: result,
      });
    } catch (err) {
      throw externalServiceError('MES', 500, err instanceof Error ? err.message : 'MES同步异常');
    }
  });

  // MES测试数据库实时连接健康探测
  fastify.get('/mes/status', async (_request, reply) => {
    try {
      const status = await testMesConnection();
      return reply.status(200).send({
        success: status.connected,
        ...status,
      });
    } catch (err) {
      throw externalServiceError('MES', 500, err instanceof Error ? err.message : '连接异常');
    }
  });

  // 查询 MES 实时生产任务单列表 (只读 mes_letian_test.t_production_task)
  fastify.get(
    '/mes/tasks',
    { schema: { querystring: MesPagedQuerySchema } },
    async (request, reply) => {
      try {
        const query = request.query as z.infer<typeof MesPagedQuerySchema>;
        const rows = await fetchMesProductionTasks({
          ...(query.search !== undefined ? { search: query.search } : {}),
          page: query.page,
          pageSize: query.pageSize,
        });
        return reply.status(200).send({
          page: query.page,
          pageSize: query.pageSize,
          items: rows,
        });
      } catch (err) {
        throw externalServiceError('MES', 500, err instanceof Error ? err.message : '查询MES任务单失败');
      }
    }
  );

  // 查询 MES 现场检验报告列表 (只读 mes_letian_test.t_check_report)
  fastify.get(
    '/mes/check-reports',
    { schema: { querystring: MesPagedQuerySchema } },
    async (request, reply) => {
      try {
        const query = request.query as z.infer<typeof MesPagedQuerySchema>;
        const rows = await fetchMesCheckReports({
          ...(query.search !== undefined ? { search: query.search } : {}),
          page: query.page,
          pageSize: query.pageSize,
        });
        return reply.status(200).send({
          page: query.page,
          pageSize: query.pageSize,
          items: rows,
        });
      } catch (err) {
        throw externalServiceError('MES', 500, err instanceof Error ? err.message : '查询MES检验单失败');
      }
    }
  );

  // 查询 MES 工序字典清单 (只读 mes_letian_test.t_procedure)
  fastify.get('/mes/procedures', async (_request, reply) => {
    try {
      const rows = await fetchMesProcedures();
      return reply.status(200).send({
        items: rows,
      });
    } catch (err) {
      throw externalServiceError('MES', 500, err instanceof Error ? err.message : '查询MES工序列表失败');
    }
  });
  // 7. 历史数据同步流水（取自 integration_sync_logs）
  fastify.get(
    '/sync/history',
    {
      schema: {
        querystring: SyncHistoryQuerySchema,
      },
    },
    async (request, reply) => {
      const query = request.query as z.infer<typeof SyncHistoryQuerySchema>;

      const result = await integration.listSyncLogs({
        page: query.page,
        pageSize: query.pageSize,
        ...(query.systemType !== undefined ? { systemType: query.systemType } : {}),
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

  // 8. MES 工控机与 PLC 停机联动设备清单（进程内静态目录，见 data/mes-gateway.ts 的数据边界说明）
  fastify.get('/equipment', async (_request, reply) => {
    return reply.status(200).send(MES_EQUIPMENT_CATALOG);
  });

  // 9. 手动拦截/解除拦截（仅改写进程内状态，重启后恢复初始值）
  fastify.put(
    '/equipment/:id/status',
    {
      schema: {
        params: EquipmentParamsSchema,
        body: EquipmentStatusSchema,
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof EquipmentParamsSchema>;
      const { status } = request.body as z.infer<typeof EquipmentStatusSchema>;

      const equipment = MES_EQUIPMENT_CATALOG.find((item) => item.id === id);
      if (!equipment) {
        throw new NotFoundError(`未找到工控设备映射: ${id}`);
      }

      const previousStatus = equipment.status;
      equipment.status = status;

      await appendDbAuditLog(container.uow, request, {
        action: 'UPDATE',
        resourceType: 'MES_EQUIPMENT',
        resourceId: id,
        diffPatch: { equipmentCode: equipment.equipmentCode, from: previousStatus, to: status },
      });

      return reply.status(200).send(equipment);
    }
  );

  // 10. 质量门禁自动阻断规则策略库（进程内静态目录，只读）
  fastify.get('/rules', async (_request, reply) => {
    return reply.status(200).send(MES_INTERCEPTION_RULES);
  });
};
