import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import {
  InspectionTypeEnum,
  DataTypeEnum,
  MetricCategoryEnum,
} from '@letian/contracts';
import { NotFoundError } from '@letian/application';
import type { ApiContainer } from '../container';
import { PROCESS_TEMPLATES } from '../data/process-templates';
import { appendDbAuditLog } from '../lib/audit-log';

/**
 * 工序质检配置模板
 * 指标字段与契约 InspectionPlanItemSchema 保持同名同义：
 * 公差均为正数量级，合格区间为 [nominalValue - lowerTolerance, nominalValue + upperTolerance]
 *
 * 存储边界见 data/process-templates.ts：进程内存储，非持久化。
 */
const ProcessCheckItemSchema = z.object({
  itemCode: z.string().min(1, '指标编码不能为空'),
  name: z.string().min(1, '指标名称不能为空'),
  dataType: DataTypeEnum.default('NUMERIC'),
  metricCategory: MetricCategoryEnum.default('DIMENSION'),
  standardText: z.string().min(1, '判定标准不能为空'),
  nominalValue: z.number(),
  upperTolerance: z.number().min(0, '上公差不能为负数'),
  lowerTolerance: z.number().min(0, '下公差不能为负数'),
});

const CreateProcessTemplateSchema = z.object({
  processCode: z.string().min(1, '工序编码不能为空'),
  processName: z.string().min(1, '工序名称不能为空'),
  inspectionType: InspectionTypeEnum,
  isMandatoryGate: z.boolean().default(false),
  defaultSampleQty: z.number().int().min(1).default(5),
  checkItems: z.array(ProcessCheckItemSchema).default([]),
});

const ProcessTemplateParamsSchema = z.object({
  id: z.string().uuid('工序模板ID必须为有效UUID'),
});

export const processSettingsController: FastifyPluginAsync<{ container: ApiContainer }> = async (
  fastify,
  options
) => {
  const { container } = options;

  // 1. 获取工序质检配置模板列表
  fastify.get('/templates', async (_request, reply) => {
    return reply.status(200).send({
      total: PROCESS_TEMPLATES.length,
      items: PROCESS_TEMPLATES,
      // 兼容别名：早期契约消费方使用 list，与 items 指向同一份数据
      list: PROCESS_TEMPLATES,
    });
  });

  // 2. 创建工序质检配置模板
  fastify.post(
    '/templates',
    {
      schema: {
        body: CreateProcessTemplateSchema,
      },
    },
    async (request, reply) => {
      const body = request.body as z.infer<typeof CreateProcessTemplateSchema>;

      const id = crypto.randomUUID();
      const now = new Date().toISOString();

      const newTemplate = {
        id,
        processCode: body.processCode,
        processName: body.processName,
        inspectionType: body.inspectionType,
        isMandatoryGate: body.isMandatoryGate,
        defaultSampleQty: body.defaultSampleQty,
        checkItems: body.checkItems.map((it) => ({
          itemCode: it.itemCode,
          name: it.name,
          standardText: it.standardText,
          nominalValue: it.nominalValue,
          upperTolerance: it.upperTolerance,
          lowerTolerance: it.lowerTolerance,
        })),
        createdAt: now,
        updatedAt: now,
      };

      PROCESS_TEMPLATES.unshift(newTemplate);

      // 模板本身不落库，但"新建工序配置"属于关键质量配置变更，审计流水仍然落库留痕
      await appendDbAuditLog(container.uow, request, {
        action: 'CREATE',
        resourceType: 'PROCESS_TEMPLATE',
        resourceId: id,
        diffPatch: { processCode: body.processCode, processName: body.processName },
      });

      return reply.status(201).send(newTemplate);
    }
  );

  // 3. 获取单个工序质检配置详情
  fastify.get(
    '/templates/:id',
    {
      schema: {
        params: ProcessTemplateParamsSchema,
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof ProcessTemplateParamsSchema>;
      const template = PROCESS_TEMPLATES.find((t) => t.id === id);
      if (!template) {
        throw new NotFoundError(`工序模板配置不存在: ${id}`);
      }
      return reply.status(200).send(template);
    }
  );
};
