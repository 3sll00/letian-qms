import { syncErpMasterData, syncMesAll, testMesConnection, queryMes, assertSafeMesDatabase, STRICT_MES_TARGET_DB } from '@letian/infrastructure';
import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import {
  IntegrationConfigSchema,
  SystemTypeEnum,
  type IntegrationConfig,
  type IntegrationSyncLog,
} from '@letian/contracts';
import { NotFoundError } from '@letian/application';
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

      const syncLogId = crypto.randomUUID();
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

      await integration.appendSyncLog(
        syncLog,
        systemType === 'ERP'
          ? '本地 ERP 主数据镜像清点'
          : `MES车间生产与质检实绩数据同步 (明细: ${JSON.stringify(syncDetails || {})})`
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
    } catch (err: any) {
      return reply.status(500).send({
        success: false,
        message: err?.message || '同步异常',
      });
    }
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
    } catch (err: any) {
      return reply.status(500).send({
        success: false,
        message: err?.message || 'MES同步异常',
      });
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
    } catch (err: any) {
      return reply.status(500).send({
        success: false,
        connected: false,
        database: STRICT_MES_TARGET_DB,
        error: err?.message || '连接异常',
      });
    }
  });

  // 查询 MES 实时生产任务单列表 (只读 mes_letian_test.t_production_task)
  fastify.get('/mes/tasks', async (request, reply) => {
    try {
      assertSafeMesDatabase();
      const query = request.query as { search?: string; page?: string; pageSize?: string };
      const page = Math.max(1, parseInt(query.page || '1', 10));
      const pageSize = Math.min(100, Math.max(1, parseInt(query.pageSize || '20', 10)));
      const offset = (page - 1) * pageSize;

      let sql = `
        SELECT 
          t.id, t.bill_no, t.heat_number, t.steel_mill, t.cutting_length, t.production_num, t.bill_date,
          m.code as materiel_code, m.name as materiel_name, m.spec as materiel_spec
        FROM t_production_task t
        LEFT JOIN t_materiel m ON t.materiel_id = m.id
      `;
      const params: any[] = [];
      if (query.search) {
        sql += ` WHERE t.bill_no LIKE ? OR t.heat_number LIKE ? OR m.code LIKE ? OR m.name LIKE ?`;
        const s = `%${query.search}%`;
        params.push(s, s, s, s);
      }
      sql += ` ORDER BY t.bill_date DESC LIMIT ? OFFSET ?`;
      params.push(pageSize, offset);

      const rows = await queryMes<any>(sql, params);
      return reply.status(200).send({
        page,
        pageSize,
        items: rows,
      });
    } catch (err: any) {
      return reply.status(500).send({
        error: err?.message || '查询MES任务单失败',
      });
    }
  });

  // 查询 MES 现场检验报告列表 (只读 mes_letian_test.t_check_report)
  fastify.get('/mes/check-reports', async (request, reply) => {
    try {
      assertSafeMesDatabase();
      const query = request.query as { search?: string; page?: string; pageSize?: string };
      const page = Math.max(1, parseInt(query.page || '1', 10));
      const pageSize = Math.min(100, Math.max(1, parseInt(query.pageSize || '20', 10)));
      const offset = (page - 1) * pageSize;

      let sql = `
        SELECT 
          r.id, r.bill_no, r.bill_date, r.check_date,
          r.check_qty, r.qualified_qty, r.unqualified_qty, r.is_qualified, r.remarks,
          t.bill_no as task_bill_no, t.heat_number, t.steel_mill,
          m.code as materiel_code, m.name as materiel_name,
          p.name as procedure_name,
          u.realname as inspector_name
        FROM t_check_report r
        LEFT JOIN t_production_task t ON r.task_id = t.id
        LEFT JOIN t_materiel m ON r.materiel_id = m.id
        LEFT JOIN t_procedure p ON r.procedure_id = p.id
        LEFT JOIN sys_user u ON r.create_user_id = u.id
      `;
      const params: any[] = [];
      if (query.search) {
        sql += ` WHERE r.bill_no LIKE ? OR t.bill_no LIKE ? OR t.heat_number LIKE ? OR m.name LIKE ?`;
        const s = `%${query.search}%`;
        params.push(s, s, s, s);
      }
      sql += ` ORDER BY r.create_time DESC LIMIT ? OFFSET ?`;
      params.push(pageSize, offset);

      const rows = await queryMes<any>(sql, params);
      return reply.status(200).send({
        page,
        pageSize,
        items: rows,
      });
    } catch (err: any) {
      return reply.status(500).send({
        error: err?.message || '查询MES检验单失败',
      });
    }
  });

  // 查询 MES 工序字典清单 (只读 mes_letian_test.t_procedure)
  fastify.get('/mes/procedures', async (_request, reply) => {
    try {
      assertSafeMesDatabase();
      const rows = await queryMes<any>(
        'SELECT id, code, name, remarks FROM t_procedure ORDER BY code ASC'
      );
      return reply.status(200).send({
        items: rows,
      });
    } catch (err: any) {
      return reply.status(500).send({
        error: err?.message || '查询MES工序列表失败',
      });
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
