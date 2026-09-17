import {
  OpenAPIRegistry,
  OpenApiGeneratorV31,
  extendZodWithOpenApi,
} from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';

import {
  ProblemDetailsSchema,
  AuditActionEnum,
  AuditStatusEnum,
  AuditLogSchema,
  AuditStatsResponseSchema,
  MaterialPermissionSchema,
  TraceRelationTypeEnum,
  TraceNodeStatusEnum,
  TraceNodeSchema,
  TraceEdgeSchema,
  TraceabilityGraphResponseSchema,
  MRBStatusEnum,
  MRBDispositionEnum,
  MRBFailCategoryEnum,
  MRBReviewSchema,
  ReviewFlowSchema,
  InspectionTypeEnum,
  InspectionStatusEnum,
  DataTypeEnum,
  MetricCategoryEnum,
  InspectionItemSchema,
  InspectionPlanItemSchema,
  InspectionPlanVersionSchema,
  InspectionPlanSnapshotSchema,
  InspectionOrderSchema,
  SystemTypeEnum,
  SyncDirectionEnum,
  SyncStatusEnum,
  IntegrationSyncLogSchema,
  IntegrationConfigSchema,
  OutboxEventSchema,
} from '../schemas';

// 启用 zod-to-openapi 扩展
extendZodWithOpenApi(z);

/**
 * 构建并返回全系统 OpenAPI 3.1 注册中心实例
 */
export function createLetianQmsOpenApiRegistry(): OpenAPIRegistry {
  const registry = new OpenAPIRegistry();

  // 1. 注册核心 Schema 组件
  registry.register('ProblemDetails', ProblemDetailsSchema);
  registry.register('AuditAction', AuditActionEnum);
  registry.register('AuditStatus', AuditStatusEnum);
  registry.register('AuditLog', AuditLogSchema);
  registry.register('AuditStatsResponse', AuditStatsResponseSchema);
  registry.register('MaterialPermission', MaterialPermissionSchema);
  registry.register('TraceRelationType', TraceRelationTypeEnum);
  registry.register('TraceNodeStatus', TraceNodeStatusEnum);
  registry.register('TraceNode', TraceNodeSchema);
  registry.register('TraceEdge', TraceEdgeSchema);
  registry.register('TraceabilityGraphResponse', TraceabilityGraphResponseSchema);
  registry.register('MRBStatus', MRBStatusEnum);
  registry.register('MRBDisposition', MRBDispositionEnum);
  registry.register('MRBFailCategory', MRBFailCategoryEnum);
  registry.register('MRBReview', MRBReviewSchema);
  registry.register('ReviewFlow', ReviewFlowSchema);
  registry.register('InspectionType', InspectionTypeEnum);
  registry.register('InspectionStatus', InspectionStatusEnum);
  registry.register('DataType', DataTypeEnum);
  registry.register('MetricCategory', MetricCategoryEnum);
  registry.register('InspectionItem', InspectionItemSchema);
  registry.register('InspectionPlanItem', InspectionPlanItemSchema);
  registry.register('InspectionPlanVersion', InspectionPlanVersionSchema);
  registry.register('InspectionPlanSnapshot', InspectionPlanSnapshotSchema);
  registry.register('InspectionOrder', InspectionOrderSchema);
  registry.register('IntegrationSystemType', SystemTypeEnum);
  registry.register('SyncDirection', SyncDirectionEnum);
  registry.register('SyncStatus', SyncStatusEnum);
  registry.register('IntegrationSyncLog', IntegrationSyncLogSchema);
  registry.register('IntegrationConfig', IntegrationConfigSchema);
  registry.register('OutboxEvent', OutboxEventSchema);

  // 2. 注册核心 API 路由路径
  // 检验单列表查询
  registry.registerPath({
    method: 'get',
    path: '/api/v1/inspections',
    summary: '查询质检单列表',
    tags: ['Inspection'],
    request: {
      query: z.object({
        type: InspectionTypeEnum.optional(),
        status: InspectionStatusEnum.optional(),
        batchNo: z.string().optional(),
      }),
    },
    responses: {
      200: {
        description: '成功返回质检单列表',
        content: {
          'application/json': {
            schema: z.object({
              items: z.array(InspectionOrderSchema),
              total: z.number().int(),
            }),
          },
        },
      },
      500: {
        description: '内部服务器错误',
        content: {
          'application/problem+json': {
            schema: ProblemDetailsSchema,
          },
        },
      },
    },
  });

  // 检验单详情
  registry.registerPath({
    method: 'get',
    path: '/api/v1/inspections/{id}',
    summary: '根据ID获取质检单详情（包含指标项实测值）',
    tags: ['Inspection'],
    request: {
      params: z.object({
        id: z.string().uuid(),
      }),
    },
    responses: {
      200: {
        description: '成功返回质检单详情',
        content: {
          'application/json': {
            schema: InspectionOrderSchema,
          },
        },
      },
      404: {
        description: '质检单未找到',
        content: {
          'application/problem+json': {
            schema: ProblemDetailsSchema,
          },
        },
      },
    },
  });

  // 质检指标录入与实时判定
  registry.registerPath({
    method: 'post',
    path: '/api/v1/inspections/{id}/items',
    summary: '提交质检指标实测记录并自动触发公差判定',
    tags: ['Inspection'],
    request: {
      params: z.object({
        id: z.string().uuid(),
      }),
      body: {
        content: {
          'application/json': {
            schema: z.object({
              items: z.array(
                z.object({
                  itemCode: z.string(),
                  measuredVal: z.number().nullable().optional(),
                  measuredText: z.string().nullable().optional(),
                  sampleSeq: z.number().int().default(1),
                })
              ),
            }),
          },
        },
      },
    },
    responses: {
      200: {
        description: '指标录入成功，返回判定后的工单',
        content: {
          'application/json': {
            schema: InspectionOrderSchema,
          },
        },
      },
    },
  });

  // 成品/出货放行强制拦截关卡查询 (MANDATORY_GATE)
  registry.registerPath({
    method: 'get',
    path: '/api/v1/inspections/release-gates/check',
    summary: 'ERP/MES 阻断放行强校验关卡',
    tags: ['InspectionGate'],
    request: {
      query: z.object({
        batchNo: z.string(),
        targetType: z.enum(['PROCESS_TO_WAREHOUSE', 'WAREHOUSE_TO_CUSTOMER']),
      }),
    },
    responses: {
      200: {
        description: '检验通过，允许放行流转',
        content: {
          'application/json': {
            schema: z.object({
              allowed: z.boolean(),
              batchNo: z.string(),
              inspectionId: z.string().uuid(),
              status: InspectionStatusEnum,
              reason: z.string().optional(),
            }),
          },
        },
      },
      409: {
        description: '质量门禁强制阻断（未检验/检验中/检验不合格/MRB评审中）',
        content: {
          'application/problem+json': {
            schema: ProblemDetailsSchema,
          },
        },
      },
    },
  });

  // MRB 评审流程与决策
  registry.registerPath({
    method: 'post',
    path: '/api/v1/mrb/{id}/decision',
    summary: '提交 MRB 不合格品评审决策',
    tags: ['MRB'],
    request: {
      params: z.object({
        id: z.string().uuid(),
      }),
      body: {
        content: {
          'application/json': {
            schema: z.object({
              stepId: z.string().uuid(),
              decision: z.enum(['AGREE', 'REJECT']),
              disposition: MRBDispositionEnum,
              comment: z.string(),
              signature: z.string().optional(),
              customerApprovalUrl: z.string().url().optional(),
            }),
          },
        },
      },
    },
    responses: {
      200: {
        description: '决策成功，返回最新评审单',
        content: {
          'application/json': {
            schema: MRBReviewSchema,
          },
        },
      },
    },
  });

  // 批次追溯链 DAG 拓扑查询
  registry.registerPath({
    method: 'get',
    path: '/api/v1/traceability/{batchNo}',
    summary: '查询批次正反向追溯拓扑 DAG 图',
    tags: ['Traceability'],
    request: {
      params: z.object({
        batchNo: z.string(),
      }),
      query: z.object({
        direction: z.enum(['FORWARD', 'BACKWARD', 'BOTH']).default('BOTH'),
        maxDepth: z.number().int().min(1).max(20).default(10),
      }),
    },
    responses: {
      200: {
        description: '返回追溯图节点与边拓扑结构',
        content: {
          'application/json': {
            schema: TraceabilityGraphResponseSchema,
          },
        },
      },
    },
  });

  // 审计日志查询
  registry.registerPath({
    method: 'get',
    path: '/api/v1/audit/logs',
    summary: '查询操作审计日志列表',
    tags: ['Audit'],
    request: {
      query: z.object({
        action: AuditActionEnum.optional(),
        entityName: z.string().optional(),
        operatorId: z.string().optional(),
        limit: z.number().int().default(50),
        offset: z.number().int().default(0),
      }),
    },
    responses: {
      200: {
        description: '返回审计日志分页列表',
        content: {
          'application/json': {
            schema: z.object({
              items: z.array(AuditLogSchema),
              total: z.number().int(),
            }),
          },
        },
      },
    },
  });

  // 审计统计指标卡片
  registry.registerPath({
    method: 'get',
    path: '/api/v1/audit/stats',
    summary: '获取审计关键指标卡片数据',
    tags: ['Audit'],
    responses: {
      200: {
        description: '成功返回审计概览统计数据',
        content: {
          'application/json': {
            schema: AuditStatsResponseSchema,
          },
        },
      },
    },
  });

  return registry;
}

/**
 * 根据注册的 Zod Schema 自动生成符合 OpenAPI 3.1 规范的 JSON 对象
 */
export function generateLetianQmsOpenApiDocument(): ReturnType<OpenApiGeneratorV31['generateDocument']> {
  const registry = createLetianQmsOpenApiRegistry();
  const generator = new OpenApiGeneratorV31(registry.definitions);

  return generator.generateDocument({
    openapi: '3.1.0',
    info: {
      title: '乐天紧固件质量管理系统 (Letian QMS) 契约API',
      version: '2.5.0',
      description:
        '乐天 QMS 工业级质量中台 API 规范。由 packages/contracts 单一真理源自动生成，提供 IQC/IPQC/OQC 质检生命周期、MRB 不合格品会签、MANDATORY_GATE 门禁、DAG 批次质量追溯与 ERP/MES 集成接口。',
    },
    servers: [
      {
        url: 'http://localhost:3000',
        description: '本地开发调试环境',
      },
    ],
  });
}
