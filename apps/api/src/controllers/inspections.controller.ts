import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import {
  CreateInspectionOrderRequestSchema,
  BatchRecordInspectionItemsRequestSchema,
  InspectionTypeEnum,
  InspectionStatusEnum,
  type InspectionOrder,
} from '@letian/contracts';
import { NotFoundError, ValidationFailedError } from '@letian/application';
import type { ApiContainer } from '../container';
import { operatorOf } from '../lib/operator';

/**
 * 录入实测值请求体：复用契约的批量录入 Schema，去掉由路径参数 :id 提供的 orderId
 */
const SubmitMeasurementsRequestSchema = BatchRecordInspectionItemsRequestSchema.omit({
  orderId: true,
});

const InspectionQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  inspectionType: InspectionTypeEnum.optional(),
  /** 前端台账页签分组（IQC / IPQC / FQC / OQC），与 inspectionType 互斥使用 */
  type: z.string().optional(),
  status: InspectionStatusEnum.optional(),
  batchNo: z.string().optional(),
  materialCode: z.string().optional(),
  keyword: z.string().optional(),
});

const InspectionParamsSchema = z.object({
  id: z.string().uuid('检验单ID必须为有效的UUID'),
});

/** 需要强制放行关卡的成品检类型 */
const MANDATORY_GATE_TYPES: readonly string[] = ['OQC_SF', 'OQC_SH'];

/**
 * 台账页签分组 → 契约检验类型集合。
 * FQC（成品入库终检）在契约中对应 IPQC_FN，与前端 plans 页签文案口径一致。
 */
const GROUP_TO_TYPES: Record<string, readonly string[]> = {
  IQC: ['IQC'],
  IPQC: ['IPQC_CT', 'IPQC_RL', 'IPQC_FN'],
  FQC: ['IPQC_FN'],
  OQC: ['OQC_SF', 'OQC_SH'],
};

export const inspectionsController: FastifyPluginAsync<{ container: ApiContainer }> = async (
  fastify,
  options
) => {
  const { container } = options;
  const orders = container.repositories.orders;

  // 1. 获取检验单列表 (支持筛选与分页)
  fastify.get(
    '/',
    {
      schema: {
        querystring: InspectionQuerySchema,
      },
    },
    async (request, reply) => {
      const query = request.query as z.infer<typeof InspectionQuerySchema>;

      // 页签分组优先按集合过滤；若传入的 type 本身就是合法契约类型，则按精确类型过滤
      const typeGroup = query.type !== undefined ? GROUP_TO_TYPES[query.type] : undefined;
      const exactType =
        query.type !== undefined && InspectionTypeEnum.safeParse(query.type).success
          ? query.type
          : undefined;

      const result = await orders.listOrders({
        page: query.page,
        pageSize: query.pageSize,
        ...(query.inspectionType !== undefined ? { inspectionType: query.inspectionType } : {}),
        ...(typeGroup === undefined && exactType !== undefined ? { inspectionType: exactType } : {}),
        ...(typeGroup !== undefined ? { inspectionTypes: typeGroup } : {}),
        ...(query.status !== undefined ? { status: query.status } : {}),
        ...(query.batchNo !== undefined ? { batchNo: query.batchNo } : {}),
        ...(query.materialCode !== undefined ? { materialCode: query.materialCode } : {}),
        ...(query.keyword !== undefined ? { keyword: query.keyword } : {}),
      });

      return reply.status(200).send({
        total: result.total,
        page: query.page,
        pageSize: query.pageSize,
        items: result.list,
        // 兼容别名：早期契约消费方使用 list，与 items 指向同一份当页数据
        list: result.list,
        statusCounts: result.statusCounts,
      });
    }
  );

  // 2. 创建检验单：按 planVersionId 精确绑定方案版本快照
  fastify.post(
    '/',
    {
      schema: {
        body: CreateInspectionOrderRequestSchema,
      },
    },
    async (request, reply) => {
      const body = request.body as z.infer<typeof CreateInspectionOrderRequestSchema>;
      const operator = operatorOf(request);

      // planVersionId 必须是真实存在的方案版本行主键，否则无法生成快照，禁止静默降级为"自动匹配"
      const resolved = await container.repositories.plans.findVersionById(body.planVersionId);
      if (!resolved) {
        throw new NotFoundError(`质检方案版本不存在: ${body.planVersionId}`);
      }

      const order = await container.useCases.createInspectionOrder.execute({
        orderNo: body.orderNo,
        inspectionType: body.inspectionType,
        materialCode: body.materialCode,
        materialName: body.materialName,
        batchNo: body.batchNo,
        // 契约工单 DTO 不含批量总数，以送检数占位（batch_qty 列保持 NULL，不被覆盖）
        batchQty: body.sampleQty,
        sampleSize: body.sampleQty,
        planId: resolved.version.id ?? body.planVersionId,
        planVersionNo: resolved.version.versionNo,
        mandatoryGate:
          body.isMandatoryGate ?? MANDATORY_GATE_TYPES.includes(body.inspectionType),
        ...(body.supplierCode !== undefined ? { supplierCode: body.supplierCode } : {}),
        operatorId: operator.userId,
        operatorName: operator.userName,
      });

      return reply.status(201).send(order);
    }
  );

  // 3. 获取检验单详情
  fastify.get(
    '/:id',
    {
      schema: {
        params: InspectionParamsSchema,
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof InspectionParamsSchema>;
      const order = await orders.findById(id);
      if (!order) {
        throw new NotFoundError(`检验单不存在: ${id}`);
      }
      return reply.status(200).send(order);
    }
  );

  // 4. 录入检验指标实测值与自动判定 (submit-measurements)
  fastify.post(
    '/:id/submit-measurements',
    {
      schema: {
        params: InspectionParamsSchema,
        body: SubmitMeasurementsRequestSchema,
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof InspectionParamsSchema>;
      const body = request.body as z.infer<typeof SubmitMeasurementsRequestSchema>;
      const operator = operatorOf(request);

      const order = await orders.findById(id);
      if (!order) {
        throw new NotFoundError(`检验单不存在: ${id}`);
      }

      // 指标编码必须属于本工单的方案快照，否则给出 400 校验明细（而不是领域层笼统的判定失败）
      const knownCodes = new Set((order.items ?? []).map((item) => item.itemCode));
      const unknownItemCodes = body.items
        .map((item) => item.itemCode)
        .filter((itemCode) => !knownCodes.has(itemCode));

      if (unknownItemCodes.length > 0) {
        throw new ValidationFailedError(
          `以下指标编码不属于当前检验单的质检方案: ${unknownItemCodes.join(', ')}`,
          unknownItemCodes.map((itemCode) => ({
            name: itemCode,
            reason: '该指标编码不在本检验单的 planSnapshot.items 中',
          }))
        );
      }

      const command = {
        orderId: id,
        // 逐个字段条件展开：契约解析结果是 `T | undefined`，而命令行类型开启
        // exactOptionalPropertyTypes，必须省略 undefined 才能通过类型检查
        items: body.items.map((item) => ({
          itemCode: item.itemCode,
          ...(item.measuredVal !== undefined ? { measuredVal: item.measuredVal } : {}),
          ...(item.measuredText !== undefined ? { measuredText: item.measuredText } : {}),
          ...(item.defectReason !== undefined ? { defectReason: item.defectReason } : {}),
          ...(item.remark !== undefined ? { remark: item.remark } : {}),
        })),
        operatorId: operator.userId,
        operatorName: operator.userName,
      };

      // 草稿：仅落库实测值，不做整单终判；正式提交：由领域聚合执行综合判定
      const updated: InspectionOrder = body.isDraft
        ? await container.useCases.saveInspectionDraft.execute(command)
        : await container.useCases.recordMeasurementsAndJudge.execute(command);

      return reply.status(200).send(updated);
    }
  );
};
