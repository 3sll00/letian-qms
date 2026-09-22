import { HeatBatchTraceService } from "@letian/domain";
import { randomUUID } from 'node:crypto';
import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import {
  CreateInspectionOrderRequestSchema,
  BatchRecordInspectionItemsRequestSchema,
  InspectionTypeEnum,
  InspectionStatusEnum,
  ApproveInspectionOrderRequestSchema,
  type InspectionOrder,
} from '@letian/contracts';
import { NotFoundError, ValidationFailedError } from '@letian/application';
import type { ApiContainer } from '../container';
import { operatorOf } from '../lib/operator';
import {
  getRequestPermissions,
  buildRequestSecurityContext,
  logAuthorizationCheck,
  assertQualityApprover,
} from '../lib/permission-guard';

/**
 * 录入实测值请求体：复用契约的批量录入 Schema，去掉由路径参数 :id 提供的 orderId
 */
const SubmitMeasurementsRequestSchema = BatchRecordInspectionItemsRequestSchema.omit({
  orderId: true,
});

/** 逗号分隔的多值查询参数：`a,b,c` -> ['a','b','c']，再由给定 schema 逐个校验 */
function commaList<T extends z.ZodTypeAny>(item: T) {
  return z
    .string()
    .transform((value) =>
      value
        .split(',')
        .map((part) => part.trim())
        .filter((part) => part !== '')
    )
    .pipe(z.array(item).max(100));
}

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const InspectionQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  inspectionType: InspectionTypeEnum.optional(),
  /** 「检验类型」多选：逗号分隔的契约枚举，后端以 order_type IN (...) 查询，多值间为 OR */
  inspectionTypes: commaList(InspectionTypeEnum).optional(),
  /** 前端台账页签分组（IQC / IPQC / FQC / OQC），与 inspectionType / inspectionTypes 互斥使用 */
  type: z.string().optional(),
  status: InspectionStatusEnum.optional(),
  /** 「检验状态」多选：逗号分隔的契约枚举，后端以 status IN (...) 查询，多值间为 OR */
  statuses: commaList(InspectionStatusEnum).optional(),
  /**
   * 台账「检验状态」派生列语义筛选（待检验 / 检验中 / 已合格 / 不合格）。
   * 该列由 status + judgment 共同决定，无法用 statuses 表达，
   * 因此由仓储层统一翻译，保证筛选结果与台账列显示一致（见 docs 16 §5.1）。
   */
  inspectionState: z.enum(['PENDING', 'INSPECTING', 'PASSED', 'FAILED']).optional(),
  /** 「检验人」多选：逗号分隔的员工 UUID，后端以 inspector_id IN (...) 查询，多值间为 OR */
  inspectors: commaList(z.string().uuid()).optional(),
  /** 「供应商」多选：逗号分隔的供应商编码，后端以 supplier_code IN (...) 查询，多值间为 OR */
  supplierCodes: commaList(z.string().min(1)).optional(),
  /** 检验日期范围（YYYY-MM-DD，按 createdAt 过滤，含起止当日） */
  dateFrom: z.string().regex(DATE_PATTERN, 'dateFrom 必须是 YYYY-MM-DD 格式').optional(),
  dateTo: z.string().regex(DATE_PATTERN, 'dateTo 必须是 YYYY-MM-DD 格式').optional(),
  batchNo: z.string().optional(),
  /** 入库单号模糊匹配（来料检验台账「入库单号」列，006 字段扩展；迁移 021 起物理列为 inbound_no） */
  inboundNo: z.string().optional(),
  materialCode: z.string().optional(),
  outsourceNo: z.string().optional(),
  processType: z.string().optional(),
  /** 供应商名称 / 客户名称 模糊匹配 */
  partner: z.string().optional(),
  keyword: z.string().optional(),
  /** 「检验单号 / 入库单号」模糊匹配（order_no OR inbound_no），供来料检验台账单号筛选 */
  docKeyword: z.string().optional(),
  /** 「物料编号 / 物料名称」模糊匹配（material_code OR material_name），供来料检验台账物料筛选 */
  materialKeyword: z.string().optional(),
  /**
   * 「检验工单」= 检验单号（order_no）模糊匹配，供过程检验台账单号筛选。
   * 与 docKeyword 刻意区分：本参数只命中 order_no，不含 inbound_no（过程检验无入库单概念），
   * 口径见 docs/28-过程检验台账工单号双筛选项数据字段与接口打通设计.md §2.1。
   */
  orderNo: z.string().optional(),
  /** 「生产工单」= MES 生产工单号（work_order_no，物理列为空时以 batch_no 兜底）模糊匹配，供过程检验台账 */
  workOrderNo: z.string().optional(),
  operatorName: z.string().optional(),
  equipmentCode: z.string().optional(),
  threadSpec: z.string().optional(),
  inspectionTeam: z.string().optional(),
  processStep: z.string().optional(),
  salesOrderNo: z.string().optional(),
  customerName: z.string().optional(),
  salesOrderPoNo: z.string().optional(),
  /** 出库日期精确匹配（YYYY-MM-DD，出货检验台账专用） */
  dispatchDate: z.string().optional(),
  erpStatus: z.string().optional(),
});

const InspectionParamsSchema = z.object({
  id: z.string().uuid('检验单ID必须为有效的UUID'),
});

/** 需要强制放行关卡的成品检类型 */
const MANDATORY_GATE_TYPES: readonly string[] = ['OQC_SF', 'OQC_SH'];

/** 委外检验 (OQC) 全部工艺分类，供「委外检验」台账与七分类细分页签复用 */
const OUTSOURCE_TYPES: readonly string[] = [
  'OQC_SF',
  'OQC_HEAT',
  'OQC_BLACK',
  'OQC_ZINC',
  'OQC_NICKEL',
  'OQC_PHOSPH',
  'OQC_DACRO',
  'OQC_MACH',
];

/**
 * 台账页签分组 → 契约检验类型集合。
 * FQC（成品入库终检）在契约中对应 IPQC_FN，与前端 plans 页签文案口径一致。
 */
const GROUP_TO_TYPES: Record<string, readonly string[]> = {
  IQC: ['IQC'],
  IPQC: ['IPQC_CT', 'IPQC_RL', 'IPQC_FN'],
  IPQC_CT: ['IPQC_CT'],
  IPQC_RL: ['IPQC_RL'],
  IPQC_FN: ['IPQC_FN'],
  FQC: ['IPQC_FN'],
  OQC: ['OQC_SF', 'OQC_SH'],
  OQC_SH: ['OQC_SH'],
  OQC_SF: ['OQC_SF'],
  OQC_HEAT: ['OQC_HEAT'],
  OQC_MACH: ['OQC_MACH'],
  /** 委外检验台账：表面处理 + 七分类工艺 */
  OUTSOURCE: OUTSOURCE_TYPES,
};

/**
 * 「检验类型」多选候选全集。
 * 直接取自契约枚举，避免新增委外工艺分类时前后端口径漂移。
 */
const INSPECTION_TYPE_OPTIONS: readonly string[] = [...InspectionTypeEnum.options];

/** 「检验状态」多选候选全集（与契约 InspectionStatusEnum 一致，顺序即展示顺序） */
const INSPECTION_STATUS_OPTIONS: readonly string[] = [
  'PENDING',
  'INSPECTING',
  'DRAFT',
  'PASSED',
  'FAILED',
  'IN_MRB_REVIEW',
  'RE_INSPECTING',
  'COMPLETED',
];

export const inspectionsController: FastifyPluginAsync<{ container: ApiContainer }> = async (
  fastify,
  options
) => {
  const { container } = options;
  const orders = container.repositories.orders;

  // 查询炉批号溯源联动历史数据 (出货检验录入炉批号时调用)
  fastify.get(
    '/heat-batch-trace',
    {
      schema: {
        querystring: z.object({
          heatBatchNo: z.string().min(1, '炉批号不能为空'),
          materialCode: z.string().optional(),
        }),
      },
    },
    async (request, reply) => {
      const query = request.query as { heatBatchNo: string; materialCode?: string };
      const matchedOrders = await orders.findByBatchNo(query.heatBatchNo);
      const traceResult = HeatBatchTraceService.resolveHeatBatchData({
        heatBatchNo: query.heatBatchNo,
        historicalOrders: matchedOrders,
      });
      return reply.status(200).send(traceResult);
    }
  );


  // 0.5 过程检验 (IPQC) 工序级概览统计看板
  fastify.get('/ipqc-overview', async (_request, reply) => {
    const stats = await orders.getIpqcOverviewStats();
    return reply.status(200).send(stats);
  });

  // 1. 获取检验单列表 (支持筛选与分页，三维 PBAC 行级隔离)
  fastify.get(
    '/',
    {
      schema: {
        querystring: InspectionQuerySchema,
      },
    },
    async (request, reply) => {
      const query = request.query as z.infer<typeof InspectionQuerySchema>;
      const permissions = await getRequestPermissions(request, container);

      // 「检验类型」三个入口互斥，优先级：多选 inspectionTypes > 页签分组 type > 单值 inspectionType；
      // 多值一律落到 inspectionTypes，由仓储层 order_type IN (...) 查询（多值间为 OR）。
      let typeFilter: { inspectionType?: string; inspectionTypes?: readonly string[] } = {};
      if (query.inspectionTypes !== undefined && query.inspectionTypes.length > 0) {
        typeFilter = { inspectionTypes: query.inspectionTypes };
      } else if (query.type !== undefined) {
        // 页签分组优先按集合过滤；若传入的 type 本身就是合法契约类型，则按精确类型过滤
        const typeGroup = GROUP_TO_TYPES[query.type];
        const exactType = InspectionTypeEnum.safeParse(query.type).success ? query.type : undefined;
        if (typeGroup !== undefined) typeFilter = { inspectionTypes: typeGroup };
        else if (exactType !== undefined) typeFilter = { inspectionType: exactType };
      } else if (query.inspectionType !== undefined) {
        typeFilter = { inspectionType: query.inspectionType };
      }

      // 「检验状态」多选优先于单值，多值以 status IN (...) 查询（多值间为 OR）
      const statusFilter: { status?: string; statuses?: readonly string[] } =
        query.statuses !== undefined && query.statuses.length > 0
          ? { statuses: query.statuses }
          : query.status !== undefined
            ? { status: query.status }
            : {};

      const result = await orders.listOrders({
        page: query.page,
        pageSize: query.pageSize,
        ...typeFilter,
        ...statusFilter,
        permissions,
        ...(query.inspectors !== undefined && query.inspectors.length > 0
          ? { inspectors: query.inspectors }
          : {}),
        ...(query.supplierCodes !== undefined && query.supplierCodes.length > 0
          ? { supplierCodes: query.supplierCodes }
          : {}),
        ...(query.dateFrom !== undefined ? { dateFrom: query.dateFrom } : {}),
        ...(query.dateTo !== undefined ? { dateTo: query.dateTo } : {}),
        ...(query.partner !== undefined ? { partnerKeyword: query.partner } : {}),
        ...(query.batchNo !== undefined ? { batchNo: query.batchNo } : {}),
        ...(query.inboundNo !== undefined ? { inboundNo: query.inboundNo } : {}),
        ...(query.materialCode !== undefined ? { materialCode: query.materialCode } : {}),
        ...(query.outsourceNo !== undefined ? { outsourceNo: query.outsourceNo } : {}),
        ...(query.processType !== undefined ? { processType: query.processType } : {}),
        ...(query.keyword !== undefined ? { keyword: query.keyword } : {}),
        ...(query.docKeyword !== undefined ? { docKeyword: query.docKeyword } : {}),
        ...(query.materialKeyword !== undefined ? { materialKeyword: query.materialKeyword } : {}),
        ...(query.orderNo !== undefined ? { orderNo: query.orderNo } : {}),
        ...(query.workOrderNo !== undefined ? { workOrderNo: query.workOrderNo } : {}),
        ...(query.operatorName !== undefined ? { operatorName: query.operatorName } : {}),
        ...(query.equipmentCode !== undefined ? { equipmentCode: query.equipmentCode } : {}),
        ...(query.threadSpec !== undefined ? { threadSpec: query.threadSpec } : {}),
        ...(query.inspectionTeam !== undefined ? { inspectionTeam: query.inspectionTeam } : {}),
        ...(query.processStep !== undefined ? { processStep: query.processStep } : {}),
        ...(query.salesOrderNo !== undefined ? { salesOrderNo: query.salesOrderNo } : {}),
        ...(query.customerName !== undefined ? { customerName: query.customerName } : {}),
        ...(query.salesOrderPoNo !== undefined ? { salesOrderPoNo: query.salesOrderPoNo } : {}),
        ...(query.dispatchDate !== undefined ? { dispatchDate: query.dispatchDate } : {}),
        ...(query.erpStatus !== undefined ? { erpStatus: query.erpStatus } : {}),
        ...(query.inspectionState !== undefined ? { inspectionState: query.inspectionState } : {}),
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

  // 1.5 检验明细筛选候选（检验人来自库中真实承担过检验的员工；类型/状态为契约枚举全集）
  fastify.get('/filters', async (_request, reply) => {
    const inspectors = await orders.listInspectorFacets();
    return reply.status(200).send({
      inspectors,
      inspectionTypes: INSPECTION_TYPE_OPTIONS,
      statuses: INSPECTION_STATUS_OPTIONS,
    });
  });

  // 2. 创建检验单：绑定方案版本快照（精确指定或按物料自动匹配），注入 PBAC 校验
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
      const securityCtx = await buildRequestSecurityContext(request, container);

      // 方案绑定口径 (docs/17-检验录入界面说明与质检方案匹配口径.md §7)：
      //   1) 显式传入 planVersionId -> 必须是真实存在的方案版本行主键，否则 404（禁止静默降级为其它方案）；
      //   2) 未传入 -> 交由用例按「物料编码 + 检验类型」自动匹配已启用方案，匹配不到返回 400 inspection-plan-not-found。
      const planBinding: { planId?: string; planVersionNo?: string } = {};
      if (body.planVersionId !== undefined) {
        const resolved = await container.repositories.plans.findVersionById(body.planVersionId);
        if (!resolved) {
          throw new NotFoundError(`质检方案版本不存在: ${body.planVersionId}`);
        }
        planBinding.planId = resolved.version.id ?? body.planVersionId;
        planBinding.planVersionNo = resolved.version.versionNo;
      }

      const order = await container.useCases.createInspectionOrder.execute(
        {
          // 检验单号可省略：省略时由用例按 `{PREFIX}-{YYYYMMDD}-{NNNN}` 规则在事务内取号
          ...(body.orderNo !== undefined ? { orderNo: body.orderNo } : {}),
          inspectionType: body.inspectionType,
          materialCode: body.materialCode,
          // 物料名称省略时不传：由用例按 materialCode 从存货档案 materials.material_name 补齐
          ...(body.materialName !== undefined ? { materialName: body.materialName } : {}),
          batchNo: body.batchNo,
          // 报检批量：契约 totalQty 显式传入时以它为批量数；未传时以送检数占位。
          // （batch_qty 不是物理列，此处只用于聚合根的 AQL 抽样默认值；台账「数量」列 = total_qty，
          //  由下方 totalQty 透传写入，见 docs/29 §5.3）
          batchQty: body.totalQty ?? body.sampleQty,
          sampleSize: body.sampleQty,
          ...planBinding,
          mandatoryGate:
            body.isMandatoryGate ?? MANDATORY_GATE_TYPES.includes(body.inspectionType),
          ...(body.supplierCode !== undefined ? { supplierCode: body.supplierCode } : {}),
          ...(body.supplierName !== undefined ? { supplierName: body.supplierName } : {}),
          // 006 来料检验 (IQC) 入库单号 / 入库日期 / 规格型号 / 计量单位
          // （此前 create 契约声明了这些字段但控制器未透传，调用方传了也会被静默丢弃）
          ...(body.inboundNo !== undefined ? { inboundNo: body.inboundNo } : {}),
          ...(body.inboundDate !== undefined ? { inboundDate: body.inboundDate } : {}),
          ...(body.specification !== undefined ? { specification: body.specification } : {}),
          ...(body.spec !== undefined ? { spec: body.spec } : {}),
          ...(body.unit !== undefined ? { unit: body.unit } : {}),
          // 008 出货检验 (OQC_SH)：销售出库单号 / 出库日期 / 客户 / 客户订单号 / ERP 出库单状态
          ...(body.customerName !== undefined ? { customerName: body.customerName } : {}),
          ...(body.salesOrderNo !== undefined ? { salesOrderNo: body.salesOrderNo } : {}),
          ...(body.dispatchDate !== undefined ? { dispatchDate: body.dispatchDate } : {}),
          ...(body.salesOrderPoNo !== undefined ? { salesOrderPoNo: body.salesOrderPoNo } : {}),
          ...(body.erpStatus !== undefined ? { erpStatus: body.erpStatus } : {}),
          ...(body.outsourceNo !== undefined ? { outsourceNo: body.outsourceNo } : {}),
          ...(body.processType !== undefined ? { processType: body.processType } : {}),
          ...(body.returnDate !== undefined ? { returnDate: body.returnDate } : {}),
          ...(body.vendorName !== undefined ? { vendorName: body.vendorName } : {}),
          // 台账「检验人」列（inspection_orders.inspector_id / inspector_name）：契约早已声明 inspectorName，
          // 但此前控制器两条都没透传，建单传入的检验人被静默丢弃 -> 台账「检验人」恒为 --（见 docs/30 §3）
          ...(body.inspectorId !== undefined ? { inspectorId: body.inspectorId } : {}),
          ...(body.inspectorName !== undefined ? { inspectorName: body.inspectorName } : {}),
          // 007 过程检验 (IPQC) 台账字段：契约早已声明，但此前控制器未透传 -> 传了也被静默丢弃
          // （与 docs/26 §5 同型）。这里收拢进 ipqcProcess 分组下发，避免契约 operatorName/
          // operatorId（机台作业员）与下面的「当前操作人」同名撞车（见 docs/29 §5.3）。
          ...(body.totalQty !== undefined ? { totalQty: body.totalQty } : {}),
          ipqcProcess: {
            ...(body.workOrderNo !== undefined ? { workOrderNo: body.workOrderNo } : {}),
            ...(body.blankingLength !== undefined ? { blankingLength: body.blankingLength } : {}),
            ...(body.operatorName !== undefined ? { operatorName: body.operatorName } : {}),
            ...(body.operatorId !== undefined ? { operatorId: body.operatorId } : {}),
            ...(body.equipmentCode !== undefined ? { equipmentCode: body.equipmentCode } : {}),
            ...(body.equipmentName !== undefined ? { equipmentName: body.equipmentName } : {}),
            ...(body.threadSpec !== undefined ? { threadSpec: body.threadSpec } : {}),
            ...(body.inspectionTeam !== undefined ? { inspectionTeam: body.inspectionTeam } : {}),
            ...(body.processStep !== undefined ? { processStep: body.processStep } : {}),
            ...(body.completedAt !== undefined ? { completedAt: body.completedAt } : {}),
          },
          operatorId: operator.userId,
          operatorName: operator.userName,
        },
        securityCtx
      );

      return reply.status(201).send(order);
    }
  );

  // 3. 获取检验单详情 (PBAC 单据可访问性核验)
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

      const securityCtx = await buildRequestSecurityContext(request, container);
      const material = await container.repositories.masterData.findMaterialByCode(order.materialCode);
      const categoryCode = material?.categoryCode ?? 'STANDARD_PARTS';

      securityCtx.assertAccess({
        targetCategory: categoryCode,
        targetMaterialCode: order.materialCode,
        ...(order.supplierCode !== undefined ? { targetSupplierCode: order.supplierCode } : {}),
        operationName: '查看检验单详情',
      });

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
      const securityCtx = await buildRequestSecurityContext(request, container);

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
        ? await container.useCases.saveInspectionDraft.execute(command, securityCtx)
        : await container.useCases.recordMeasurementsAndJudge.execute(command, securityCtx);

      return reply.status(200).send(updated);
    }
  );

  // 5. 更新检验单状态与判定 (status & verdict)
  fastify.post(
    "/:id/status",
    {
      schema: {
        params: InspectionParamsSchema,
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof InspectionParamsSchema>;
      const body = request.body as {
        status: string;
        remark?: string;
        judgment?: string;
        passQty?: number;
        failQty?: number;
        sampleQty?: number;
        inspectionNotes?: string;
      };

      const order = await orders.findById(id);
      if (!order) {
        throw new NotFoundError("检验单不存在: " + id);
      }

      if (body.status) {
        await orders.updateStatus(id, body.status, body.remark || body.inspectionNotes);
      }

      const isFinished = ["PASSED", "COMPLETED", "FAILED"].includes(body.status);
      const updatePayload: { passQty?: number; failQty?: number; judgment?: string; completedAt?: Date; inspectionNotes?: string } = {};
      if (body.passQty !== undefined) updatePayload.passQty = body.passQty;
      if (body.failQty !== undefined) updatePayload.failQty = body.failQty;
      if (body.judgment !== undefined) updatePayload.judgment = body.judgment;
      const note = body.inspectionNotes ?? body.remark;
      if (note !== undefined) {
        updatePayload.inspectionNotes = note;
      }
      if (isFinished) updatePayload.completedAt = new Date();

      await orders.updateStatsAndVerdict(id, updatePayload);

      const updated = await orders.findById(id);
      return reply.status(200).send(updated);
    }
  );

  // 6. 质量负责人签核（docs/35 §5）
  //
  //   制造证书的「质量负责人」栏此前没有任何数据源（永远留白）。本路由写入**真实签核动作**：
  //   签核人 = 当前登录用户（不接受请求体自称的签核人），时间 = 服务端 now()。
  //   approver_id 指向 employees 外键：登录账号可能不是员工档案（如系统账号），
  //   此时只记姓名、不写外键 —— 宁可少一个外键，也不写一条指向不存在员工的引用（会直接 500）。
  fastify.post(
    '/:id/approve',
    {
      schema: {
        params: InspectionParamsSchema,
        body: ApproveInspectionOrderRequestSchema,
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof InspectionParamsSchema>;
      const body = request.body as z.infer<typeof ApproveInspectionOrderRequestSchema>;
      const operator = operatorOf(request);
      assertQualityApprover(operator);

      const order = await orders.findById(id);
      if (!order) {
        throw new NotFoundError(`检验单不存在: ${id}`);
      }

      const employees = await container.repositories.masterData.getEmployees();
      const matched = employees.find((employee) => employee.id === operator.userId);

      const approverName = matched?.name ?? operator.userName;

      // 签核动作与审计留痕写在同一个事务里：签核意见进审计日志（append-only 且可追溯），
      // 不写检验单备注（备注记的是检验过程，两个渠道互不覆盖）。
      await container.uow.execute(async (ctx) => {
        await ctx.inspectionOrders.recordApproval(id, {
          ...(matched?.id !== undefined ? { approverId: matched.id } : {}),
          approverName,
        });
        await ctx.auditLogs.insert({
          id: randomUUID(),
          traceId: randomUUID(),
          userId: operator.userId,
          userName: approverName,
          // 审计 action 取值受 audit_logs_action_check 约束（没有 APPROVE 这一档），签核是对单据的一次更新
          action: 'UPDATE',
          resourceType: 'INSPECTION_ORDER',
          resourceId: id,
          status: 'SUCCESS',
          diffPatch: {
            event: 'QUALITY_APPROVAL',
            orderNo: order.orderNo,
            approverName,
            ...(body.remark !== undefined ? { remark: body.remark } : {}),
          },
          // 契约 AuditLog.createdAt 是 ISO 字符串（与物理列 timestamptz 的映射在仓储层完成）
          createdAt: new Date().toISOString(),
        });
      });

      const updated = await orders.findById(id);
      return reply.status(200).send(updated);
    }
  );
};