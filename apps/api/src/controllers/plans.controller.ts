import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import {
  InspectionPlanSchema,
  InspectionTypeEnum,
} from '@letian/contracts';
import { NotFoundError } from '@letian/application';
import type { ApiContainer } from '../container';
import { operatorOf } from '../lib/operator';
import {
  getRequestPermissions,
  buildRequestSecurityContext,
  logAuthorizationCheck,
} from '../lib/permission-guard';

const PlanQuerySchema = z.object({
  inspectionType: InspectionTypeEnum.optional(),
  materialCode: z.string().optional(),
  keyword: z.string().optional(),
  // 「生效」语义：该方案存在 status = ACTIVE 的版本
  isActive: z.coerce.boolean().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

const PlanParamsSchema = z.object({
  id: z.string().uuid('方案ID必须为有效UUID'),
});

export const plansController: FastifyPluginAsync<{ container: ApiContainer }> = async (
  fastify,
  options
) => {
  const { container } = options;
  const plans = container.repositories.plans;

  // 1. 获取检验方案列表（一行=一个版本，按 plan_code 聚合展示，注入 PBAC 过滤）
  fastify.get(
    '/',
    {
      schema: {
        querystring: PlanQuerySchema,
      },
    },
    async (request, reply) => {
      const query = request.query as z.infer<typeof PlanQuerySchema>;
      const permissions = await getRequestPermissions(request, container);

      const result = await plans.listPlans({
        page: query.page,
        pageSize: query.pageSize,
        permissions,
        ...(query.inspectionType !== undefined ? { inspectionType: query.inspectionType } : {}),
        ...(query.materialCode !== undefined ? { materialCode: query.materialCode } : {}),
        ...(query.keyword !== undefined ? { keyword: query.keyword } : {}),
        ...(query.isActive !== undefined ? { activeOnly: query.isActive } : {}),
      });

      return reply.status(200).send({
        total: result.total,
        page: query.page,
        pageSize: query.pageSize,
        items: result.list,
        // 兼容别名：早期契约消费方使用 list，与 items 指向同一份当页数据
        list: result.list,
      });
    }
  );

  // 2. 创建检验方案（含首个草稿版本）
  fastify.post(
    '/',
    {
      schema: {
        body: InspectionPlanSchema,
      },
    },
    async (request, reply) => {
      const body = request.body as z.infer<typeof InspectionPlanSchema>;
      const operator = operatorOf(request);
      const securityCtx = await buildRequestSecurityContext(request, container);

      // 查询真实物料分类，确保 PBAC 精确校验
      const material = body.materialCode ? await container.repositories.masterData.findMaterialByCode(body.materialCode) : null;
      const materialCategory = material?.categoryCode ?? 'STANDARD_PARTS';

      // 契约正文的 versions[0] 即首个草稿版本；缺省时创建不含指标项的空草稿，由后续版本升级补充
      const firstVersion = body.versions?.[0];
      const initialItems = firstVersion?.items ?? [];
      const initialVersionNo = firstVersion?.versionNo;
      const samplingScheme = firstVersion?.samplingScheme;
      const aqlLevel = firstVersion?.aqlLevel;
      const strictness = firstVersion?.strictness;

      const plan = await container.useCases.createPlan.execute(
        {
          planCode: body.planCode,
          planName: body.planName,
          inspectionType: body.inspectionType,
          materialCode: body.materialCode,
          materialCategory,
          initialItems,
          createdBy: operator.userId,
          operatorName: operator.userName,
          ...(initialVersionNo !== undefined ? { initialVersionNo } : {}),
          ...(samplingScheme !== undefined ? { samplingScheme } : {}),
          ...(aqlLevel !== undefined ? { aqlLevel } : {}),
          ...(strictness !== undefined ? { strictness } : {}),
        },
        securityCtx
      );

      return reply.status(201).send(plan);
    }
  );

  // 3. 获取检验方案详情（按方案版本行 UUID 查询，会自动聚合同 plan_code 的全部版本）
  fastify.get(
    '/:id',
    {
      schema: {
        params: PlanParamsSchema,
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof PlanParamsSchema>;
      const plan = await plans.findById(id);
      if (!plan) {
        throw new NotFoundError(`检验方案不存在: ${id}`);
      }

      // 校验单条查看权限
      const securityCtx = await buildRequestSecurityContext(request, container);
      const material = plan.materialCode ? await container.repositories.masterData.findMaterialByCode(plan.materialCode) : null;
      const materialCategory = material?.categoryCode ?? 'STANDARD_PARTS';

      securityCtx.assertAccess({
        targetCategory: materialCategory,
        targetMaterialCode: plan.materialCode ?? "*",
        operationName: '查看检验方案详情',
      });

      return reply.status(200).send(plan);
    }
  );
};
