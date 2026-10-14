import { HeatBatchTraceService } from "@letian/domain";
import { randomUUID } from 'node:crypto';
import { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  CreateInspectionOrderRequestSchema,
  BatchRecordInspectionItemsRequestSchema,
  InspectionTypeEnum,
  InspectionStatusEnum,
  ApproveInspectionOrderRequestSchema,
  FinalizeInspectionStatusRequestSchema,
  FurnaceHeatTraceQuerySchema,
  FurnaceHeatTraceResponseSchema,
  UpdateInspectionHeaderRequestSchema,
  TransferPermitBatchRequestSchema,
  TransferPermitBatchResponseSchema,
  CreateTransferOverrideTicketRequestSchema,
  ReviewTransferOverrideTicketRequestSchema,
  ListTransferOverrideTicketsQuerySchema,
  TransferOverrideTicketParamsSchema,
  BatchFreezeTerminatedChainsRequestSchema,
  BatchFreezeTerminatedChainsResponseSchema,
  type InspectionOrder,
  type TransferPermitBatchRequest,
} from '@letian/contracts';
import {
  NotFoundError,
  ValidationFailedError,
  transferPermitQueryOfOrder,
} from '@letian/application';
import type { ApiContainer } from '../container';
import { operatorOf } from '../lib/operator';
import { requestTraceId } from '../lib/trace';
import {
  getRequestPermissions,
  buildRequestSecurityContext,
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

/**
 * 宽松日期字符串 schema：接受 `YYYY-MM-DD` / `YYYY/MM/DD` / `YYYY.MM.DD`
 * （分隔符 `-` `/` `.` 均可），一律归一化为 `YYYY-MM-DD` 再向下传递，
 * 避免接口因分隔符差异被拒（例如脚本/外部系统误用斜杠、点号）。
 * 同时校验真实日历日期，拒绝 `2026-13-01`、`2026-02-30` 之类，
 * 避免非法日期以字符串形式落入 SQL 比较产生静默错误结果。
 */
const isoDateString = (label: string) =>
  z
    .string()
    .transform((s) => s.trim().replace(/[./]/g, '-'))
    .pipe(
      z.string().superRefine((val, ctx) => {
        const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(val);
        if (!m) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `${label} 必须是 YYYY-MM-DD 格式（分隔符支持 - / .）`,
          });
          return;
        }
        const y = Number(m[1]);
        const mo = Number(m[2]);
        const d = Number(m[3]);
        const dt = new Date(y, mo - 1, d);
        if (dt.getFullYear() !== y || dt.getMonth() !== mo - 1 || dt.getDate() !== d) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${label} 不是合法日期` });
        }
      })
    )
    .optional();

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
  /**
   * 「检验状态」派生列语义的多选版本（逗号分隔）：检验进度明细页的多状态组合筛选。
   * 仓储层把每个取值翻译成对应的 status + judgment 谓词后 OR 叠加（多值间为 OR）。
   */
  inspectionStates: commaList(z.enum(['PENDING', 'INSPECTING', 'PASSED', 'FAILED'])).optional(),
  /** 「检验人」多选：逗号分隔的员工 UUID，后端以 inspector_id IN (...) 查询，多值间为 OR */
  inspectors: commaList(z.string().uuid()).optional(),
  /** 「供应商」多选：逗号分隔的供应商编码，后端以 supplier_code IN (...) 查询，多值间为 OR */
  supplierCodes: commaList(z.string().min(1)).optional(),
  /** 「物料」多选：逗号分隔的物料编码，后端以 material_code IN (...) 精确匹配，多值间为 OR */
  materialCodes: commaList(z.string().min(1)).optional(),
  /** 检验日期范围（YYYY-MM-DD，按 createdAt 过滤，含起止当日） */
  dateFrom: isoDateString('dateFrom'),
  dateTo: isoDateString('dateTo'),
  /** 入库日期范围（YYYY-MM-DD，按 inbound_date 过滤，含起止当日）。来料检验台账「入库日期」筛选的统一口径 */
  inboundDateFrom: isoDateString('inboundDateFrom'),
  inboundDateTo: isoDateString('inboundDateTo'),
  /**
   * 回厂日期范围（YYYY-MM-DD，按 return_date 过滤，含起止当日）。
   * 委外检验台账「回厂日期」筛选的统一口径：委外件关注的业务时点是「回厂」而非建单，
   * 因此与 dateFrom/To（created_at 建单时间）、inboundDateFrom/To（来料入库日期）三套口径刻意区分。
   */
  returnDateFrom: isoDateString('returnDateFrom'),
  returnDateTo: isoDateString('returnDateTo'),
  batchNo: z.string().optional(),
  /** 炉批号模糊匹配（出货检验台账「炉批号」筛选框，docs/47 §4.2⑤ / P2） */
  furnaceHeatNo: z.string().optional(),
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
  /** 出库日期区间起点（YYYY-MM-DD，出货检验台账「单据日期」区间筛选，含当日） */
  dispatchDateFrom: isoDateString('dispatchDateFrom'),
  /** 出库日期区间终点（YYYY-MM-DD，出货检验台账「单据日期」区间筛选，含当日） */
  dispatchDateTo: isoDateString('dispatchDateTo'),
  erpStatus: z.string().optional(),
  /**
   * 是否回填「合格后传递」派生字段（canTransfer / transferCode / blockedBy / predecessorOrderNo，docs/48 §4.6）。
   * 默认回填；显式传 `false` 可关闭（批量导出类脚本不需要门禁状态时省掉判定开销）。
   */
  withTransfer: z.enum(['true', 'false']).optional(),
});

const InspectionParamsSchema = z.object({
  id: z.string().uuid('检验单ID必须为有效的UUID'),
});

const CreateReinspectionRequestSchema = z.object({
  reworkRecordNo: z.string().min(1).optional(),
  reworkReason: z.string().min(1).optional(),
  inspectorId: z.string().uuid().optional(),
  inspectorName: z.string().min(1).optional(),
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

/**
 * 给台账行补「合格后传递」派生字段（docs/48 §4.6）。
 *
 * 判定由领域纯函数给出（`CheckTransferPermitUseCase` = 唯一真相的**读侧**），控制器只做字段拼装：
 *   - `canTransfer`  ：本单所在环节的传递许可（true = 上游已放行，或上游缺失按 TBD-01 放行）；
 *   - `transferCode` ：理由码。`allowed=true` + `UPSTREAM_MISSING` 就是「放行但上游缺失」，
 *                     界面据此显示缺失徽标 —— 只看布尔值会把「没查到上游」误当成「已放行」；
 *   - `blockedBy`    ：被阻断时的结构化上游（code / stage / orderNo / status）；
 *   - `predecessorOrderNo` / `chainKey`：权威上游单号与命中的锚点值。
 *
 * 一页最多 100 行，用 `executeBatch`（单事务内批量）而不是逐行调用：逐行 = 100 个事务。
 */
async function withTransferState(
  container: ApiContainer,
  rows: readonly InspectionOrder[]
): Promise<InspectionOrder[]> {
  if (rows.length === 0) {
    return [...rows];
  }
  const permits = await container.useCases.checkTransferPermit.executeBatch(
    rows.map((row) =>
      transferPermitQueryOfOrder({
        inspectionType: row.inspectionType,
        batchNo: row.batchNo,
        ...(row.materialCode !== undefined ? { materialCode: row.materialCode } : {}),
        ...(row.furnaceHeatNo !== undefined ? { furnaceHeatNo: row.furnaceHeatNo } : {}),
        ...(row.workOrderNo !== undefined ? { workOrderNo: row.workOrderNo } : {}),
        orderNo: row.orderNo,
        // 建单留痕：特批豁免放行的单，上游那次阻断已被正式解除，读侧不得再显示成阻断
        ...(row.transferTrace !== undefined ? { transferTrace: row.transferTrace } : {}),
      })
    )
  );

  return rows.map((row, index) => {
    const decision = permits[index]?.decision;
    if (decision === undefined) {
      return row;
    }
    const enriched: InspectionOrder = {
      ...row,
      canTransfer: decision.allowed,
      transferCode: decision.code,
      chainKey: decision.chainKey,
      ...(decision.predecessorOrderNo !== undefined
        ? { predecessorOrderNo: decision.predecessorOrderNo }
        : {}),
      ...(decision.allowed
        ? {}
        : {
            blockedBy: {
              code: decision.code,
              stage: decision.precedentStage ?? decision.stage,
              orderNo: decision.predecessorOrderNo ?? null,
              status: decision.predecessorStatus ?? null,
            },
          }),
    };
    return enriched;
  });
}

export const inspectionsController: FastifyPluginAsync<{ container: ApiContainer }> = async (
  fastify,
  options
) => {
  const { container } = options;
  const orders = container.repositories.orders;

  // 字面路径仅注册 POST 时，GET/HEAD 会被下方 `/:id` 影子路由接走，把
  // 「transfer-permits」这类字面量当成检验单 id 走 UUID 校验 → 400，
  // 将「方法不被支持」误报成「参数错误」。显式 stub 回 405（字面路由
  // 优先于参数路由；RFC 9110 §15.5.6，与 error-handler 的 405 形状一致）。
  const replyMethodNotAllowed = (request: FastifyRequest, reply: FastifyReply, allow: string) =>
    reply
      .status(405)
      .header('Allow', allow)
      .header('Content-Type', 'application/problem+json')
      .send({
        type: 'https://letian-qms.com/errors/method-not-allowed',
        title: '请求方法不被支持',
        status: 405,
        detail: `${request.method} 方法不被该路由支持；允许的方法: ${allow}`,
        instance: request.url,
        code: 'HTTP_405',
        traceId: requestTraceId(request),
      });
  const postOnly405 = (url: string) =>
    fastify.route({
      method: ['GET', 'HEAD'],
      url,
      handler: (request, reply) => replyMethodNotAllowed(request, reply, 'POST'),
    });

  // 查询炉批号溯源联动历史数据 (出货检验录入炉批号时调用)
  //
  //   口径唯一真相：docs/47 §3.2 ~ §3.4。三处此前错位，本轮一并修正（D4/D5/D6/D7/D8/D9）：
  //   ① 关联键是 `furnace_heat_batch_no`（**不是** `batch_no`）—— 用 findByBatchNo 查炉批号
  //      既查不到、又会把「碰巧同名」的批次号单据当成上游来源；
  //   ② 查询走迁移 034 的**归一化生成列**，大小写 / 空格 / 全角空格 / 连字符差异视为同一炉批号；
  //   ③ `materialCode` 真正参与匹配：先同物料，同物料无命中才放宽到跨物料并回 `matchScope = GLOBAL`。
  fastify.get(
    '/heat-batch-trace',
    {
      schema: {
        // 正在编辑的本单 id：从「上游异常提示」（TBD-01）候选里**排除自己**。
        // 本单自身通常处于 INSPECTING（正在录入），若不排除，任何一次查询都会把
        // 自己判成「上游存在尚未终判的检验记录」，在同一炉号上给出假提示。
        querystring: FurnaceHeatTraceQuerySchema,
      },
    },
    async (request, reply) => {
      const query = request.query as z.infer<typeof FurnaceHeatTraceQuerySchema>;
      const materialCode =
        query.materialCode !== undefined && query.materialCode.trim() !== ''
          ? query.materialCode
          : undefined;

      // 仓储侧**不按物料过滤**：物料维度由领域服务分层处理（先同物料 → 同物料无命中才跨物料并标 GLOBAL，
      // 见 docs/47 §3.4 / AC-10）。在 SQL 就把跨物料行滤掉会让「跨物料命中」永远不可达。
      const matchedOrders = await orders.findByFurnaceHeatNo(query.heatBatchNo);
      const excludeOrderId = query.excludeOrderId?.trim() ?? '';
      const scopedOrders =
        excludeOrderId === ''
          ? matchedOrders
          : matchedOrders.filter((order) => order.id !== excludeOrderId);
      const traceResult = HeatBatchTraceService.resolveHeatBatchData({
        heatBatchNo: query.heatBatchNo,
        ...(materialCode !== undefined ? { materialCode } : {}),
        historicalOrders: scopedOrders,
      });

      // 契约校验后再下发：字段口径一旦与 FurnaceHeatTraceResponseSchema 分叉，
      // 在服务端就报错（而不是让前端拿到一个「看起来能用」的漂移体）。
      // 白名单三类指标均在 MetricCategoryEnum 内，正常情况下不会触发校验失败。
      return reply.status(200).send(FurnaceHeatTraceResponseSchema.parse(traceResult));
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

      // 是否出货检验（OQC 系列）查询：决定本列表是否施加「万条呈现上限」。
      // 解析出的检验类型集合全部以 OQC 开头即视为出货检验（覆盖 OQC / OQC_SH / OQC_SF 及委外 OQC_*）；
      // 来料/过程/成品等其它台账不加封顶，保持原行为（尤其 IQC 全量同步后可达数万行）。
      const resolvedTypes: readonly string[] =
        typeFilter.inspectionTypes ??
        (typeFilter.inspectionType !== undefined ? [typeFilter.inspectionType] : []);
      const isOqcQuery =
        resolvedTypes.length > 0 && resolvedTypes.every((t) => t.startsWith('OQC'));

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
        ...(query.materialCodes !== undefined && query.materialCodes.length > 0
          ? { materialCodes: query.materialCodes }
          : {}),
        ...(query.dateFrom !== undefined ? { dateFrom: query.dateFrom } : {}),
        ...(query.dateTo !== undefined ? { dateTo: query.dateTo } : {}),
        ...(query.inboundDateFrom !== undefined ? { inboundDateFrom: query.inboundDateFrom } : {}),
        ...(query.inboundDateTo !== undefined ? { inboundDateTo: query.inboundDateTo } : {}),
        // 委外检验台账「回厂日期」区间：与建单时间 / 入库日期是三套互不干扰的口径
        ...(query.returnDateFrom !== undefined ? { returnDateFrom: query.returnDateFrom } : {}),
        ...(query.returnDateTo !== undefined ? { returnDateTo: query.returnDateTo } : {}),
        ...(query.partner !== undefined ? { partnerKeyword: query.partner } : {}),
        ...(query.batchNo !== undefined ? { batchNo: query.batchNo } : {}),
        ...(query.furnaceHeatNo !== undefined ? { furnaceHeatNo: query.furnaceHeatNo } : {}),
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
        // 出货检验台账「单据日期」区间筛选：与精确匹配互斥，区间优先
        ...(query.dispatchDateFrom !== undefined ? { dispatchDateFrom: query.dispatchDateFrom } : {}),
        ...(query.dispatchDateTo !== undefined ? { dispatchDateTo: query.dispatchDateTo } : {}),
        // 出货检验强制万条呈现上限（见需求「最大呈现上限万条数据」）；其它台账不封顶
        ...(isOqcQuery ? { maxTotal: 10000 } : {}),
        ...(query.erpStatus !== undefined ? { erpStatus: query.erpStatus } : {}),
        ...(query.inspectionState !== undefined ? { inspectionState: query.inspectionState } : {}),
        ...(query.inspectionStates !== undefined && query.inspectionStates.length > 0
          ? { inspectionStates: query.inspectionStates }
          : {}),
      });

      // 「合格后传递」派生字段（docs/48 §4.6）：默认回填；withTransfer=false 时整页跳过判定
      const items =
        query.withTransfer === 'false' ? result.list : await withTransferState(container, result.list);

      return reply.status(200).send({
        total: result.total,
        page: query.page,
        pageSize: query.pageSize,
        items,
        // 兼容别名：早期契约消费方使用 list，与 items 指向同一份当页数据
        list: items,
        statusCounts: result.statusCounts,
        // 命中数超过万条上限时为 true，前端据以提示「结果已截断，请缩小筛选范围」
        capped: result.capped ?? false,
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
          // 030 委外检验录入页业务事实字段（docs/36）：材质牌号 / 执行技术标准 / 检验日期。
          // 契约已声明，控制器必须透传 —— 否则与 006/008 同型：调用方传了也被静默丢弃。
          ...(body.materialGrade !== undefined ? { materialGrade: body.materialGrade } : {}),
          ...(body.techStandard !== undefined ? { techStandard: body.techStandard } : {}),
          ...(body.inspectedDate !== undefined ? { inspectedDate: body.inspectedDate } : {}),
          // 038 证书模板与证书专用字段袋（docs/51）：操作员「填写检验内容前」选定，随建单落库；
          // 与 006/008/030 同型 —— 不透传则前端选好的模板被静默丢弃
          ...(body.certTemplate !== undefined ? { certTemplate: body.certTemplate } : {}),
          ...(body.certFields !== undefined ? { certFields: body.certFields } : {}),
          // 炉批号（Heat No，docs/47 §3.1 / §4.6）：契约早已声明 CreateInspectionOrderRequest.furnaceHeatNo，
          // 建单即落 inspection_orders.furnace_heat_batch_no —— 与 006/008/030 同型，
          // 控制器不透传则「界面上填了炉号、提交后库里仍然为空」（D1/D2）。
          ...(body.furnaceHeatNo !== undefined ? { furnaceHeatNo: body.furnaceHeatNo } : {}),
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
          // 传递门禁特批豁免凭据（docs/48 §8 P2）：契约早已声明 transferOverride，但此前控制器未透传
          // —— 与 006/008/030 同型缺陷：APPROVED 豁免工单号传了也被静默丢弃，建单仍按 422 阻断（探针 AC-P2-05）。
          ...(body.transferOverride !== undefined ? { transferOverride: body.transferOverride } : {}),
          operatorId: operator.userId,
          operatorName: operator.userName,
        },
        securityCtx
      );

      // 「合格后传递」判定回吐（docs/48 §4.6）：建单成功后把本次闸门判定随单返回，
      // 调用方（MES / 前端 / 验收脚本）不必再发一次查询就能知道这张单「凭什么被放行」：
      // UPSTREAM_PASSED（上游合格）/ UPSTREAM_CONCESSION（特采受限放行）/
      // UPSTREAM_REWORK_PASSED（返工复检合格）/ UPSTREAM_MISSING（上游缺失，按 TBD-01 放行留痕）。
      //
      // 为什么用 try/catch 包住：单据此时**已提交**，这里只是读侧补充信息；
      // 若判定查询失败就抛 500，会让调用方以为建单失败而重试，反而制造重复单据。
      try {
        const permit = await container.useCases.checkTransferPermit.execute(
          transferPermitQueryOfOrder({
            inspectionType: order.inspectionType,
            batchNo: order.batchNo,
            ...(order.materialCode !== undefined ? { materialCode: order.materialCode } : {}),
            ...(order.furnaceHeatNo !== undefined ? { furnaceHeatNo: order.furnaceHeatNo } : {}),
            ...(order.workOrderNo !== undefined ? { workOrderNo: order.workOrderNo } : {}),
            orderNo: order.orderNo,
          })
        );
        return reply.status(201).send({ ...order, transferDecision: permit.decision });
      } catch {
        return reply.status(201).send(order);
      }
    }
  );

  // 2.5 「合格后传递」传递许可批量预览（docs/48 §4.6）
  //
  //   纯读接口：不写审计、不写 Outbox、不加排他锁 —— 供列表页 / 看板 / 建单前预览 / MES 关卡共用。
  //   接口本身**不执法**（执法在建单用例与放行关卡），因此这里绝不因「不允许」返回 4xx：
  //   预览要回答的是「能不能传、被谁挡的」，阻断语义由调用方按 decision.code 自行处理。
  fastify.post(
    '/transfer-permits',
    {
      schema: {
        body: TransferPermitBatchRequestSchema,
      },
    },
    async (request, reply) => {
      const body = request.body as TransferPermitBatchRequest;
      const permits = await container.useCases.checkTransferPermit.executeBatch(
        body.items.map((item) => ({
          inspectionType: item.inspectionType,
          batchNo: item.batchNo,
          ...(item.materialCode !== undefined ? { materialCode: item.materialCode } : {}),
          ...(item.furnaceHeatNo !== undefined ? { furnaceHeatNo: item.furnaceHeatNo } : {}),
          ...(item.workOrderNo !== undefined ? { workOrderNo: item.workOrderNo } : {}),
          ...(item.orderNo !== undefined ? { orderNo: item.orderNo } : {}),
        }))
      );

      // 契约校验后再下发：判定字段一旦与 TransferDecisionSchema 分叉，在服务端就报错，
      // 而不是让前端拿到一个「看起来能用」的漂移体（与 /heat-batch-trace 同一纪律）。
      return reply.status(200).send(TransferPermitBatchResponseSchema.parse({ items: permits }));
    }
  );

  postOnly405('/transfer-permits');

  // 2.6 特批豁免工单：提报申请（docs/48 §4.4、TBD-09）
  fastify.post(
    '/transfer-overrides/tickets',
    {
      schema: {
        body: CreateTransferOverrideTicketRequestSchema,
      },
    },
    async (request, reply) => {
      const body = request.body as z.infer<typeof CreateTransferOverrideTicketRequestSchema>;
      const operator = operatorOf(request);
      const securityCtx = await buildRequestSecurityContext(request, container);
      const ticket = await container.useCases.createTransferOverrideTicket.execute(
        {
          ...body,
          applicantId: operator.userId,
          applicantName: operator.userName,
        },
        securityCtx
      );
      return reply.status(201).send(ticket);
    }
  );

  // 2.7 特批豁免工单：列表查询
  fastify.get(
    '/transfer-overrides/tickets',
    {
      schema: {
        querystring: ListTransferOverrideTicketsQuerySchema,
      },
    },
    async (request, reply) => {
      const query = request.query as z.infer<typeof ListTransferOverrideTicketsQuerySchema>;
      const result = await container.useCases.listTransferOverrideTickets.execute({
        ...(query.batchNo !== undefined ? { batchNo: query.batchNo } : {}),
        ...(query.status !== undefined ? { status: query.status } : {}),
        page: query.page,
        pageSize: query.pageSize,
      });
      return reply.status(200).send(result);
    }
  );

  // 2.8 特批豁免工单：审批流（APPROVED / REJECTED）
  fastify.post(
    '/transfer-overrides/tickets/:ticketNo/review',
    {
      schema: {
        params: TransferOverrideTicketParamsSchema,
        body: ReviewTransferOverrideTicketRequestSchema,
      },
    },
    async (request, reply) => {
      const { ticketNo } = request.params as z.infer<typeof TransferOverrideTicketParamsSchema>;
      const body = request.body as z.infer<typeof ReviewTransferOverrideTicketRequestSchema>;
      const operator = operatorOf(request);
      const securityCtx = await buildRequestSecurityContext(request, container);
      assertQualityApprover(operator);
      const ticket = await container.useCases.reviewTransferOverrideTicket.execute(
        ticketNo,
        {
          action: body.action,
          reviewNotes: body.reviewNotes,
          approvalDocNo: body.approvalDocNo,
          reviewerId: operator.userId,
          reviewerName: operator.userName,
        },
        securityCtx
      );
      return reply.status(200).send(ticket);
    }
  );

  // 2.9 下游终止链路安全冻结批处理（docs/48 §5.3、TBD-06）
  fastify.post(
    '/batch-freeze-terminated-chains',
    {
      schema: {
        body: BatchFreezeTerminatedChainsRequestSchema,
      },
    },
    async (request, reply) => {
      const body = request.body as z.infer<typeof BatchFreezeTerminatedChainsRequestSchema>;
      const securityCtx = await buildRequestSecurityContext(request, container);
      const result = await container.useCases.batchFreezeTerminatedChains.execute(
        {
          ...(body.batchNo !== undefined ? { batchNo: body.batchNo } : {}),
          dryRun: body.dryRun === true,
        },
        securityCtx
      );
      return reply.status(200).send(BatchFreezeTerminatedChainsResponseSchema.parse(result));
    }
  );
  postOnly405('/batch-freeze-terminated-chains');

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

  const submitMeasurements = async (request: FastifyRequest, reply: FastifyReply) => {
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
      items: body.items.map((item) => {
        // 炉批号继承留痕（docs/47 §3.6 / D10）：契约接受三个等价别名的「带出原值」，
        // 与两个别名的「修改原因」—— 在这里归一到领域参数（inheritedHeatValue / modificationReason），
        // 下游用例与聚合根只认一份口径。此前整段被丢弃，带出项落库后来源不可考。
        const inheritedHeatValue =
          item.originalInheritedValue ?? item.inheritedHeatValue ?? item.inheritedValue;
        const modificationReason = item.modificationReason ?? item.modifiedReason;
        return {
          itemCode: item.itemCode,
          ...(item.measuredVal !== undefined ? { measuredVal: item.measuredVal } : {}),
          ...(item.measuredText !== undefined ? { measuredText: item.measuredText } : {}),
          ...(item.defectReason !== undefined ? { defectReason: item.defectReason } : {}),
          ...(item.remark !== undefined ? { remark: item.remark } : {}),
          ...(item.inheritedFrom !== undefined ? { inheritedFrom: item.inheritedFrom } : {}),
          ...(inheritedHeatValue !== undefined ? { inheritedHeatValue } : {}),
          ...(item.isManuallyModified !== undefined
            ? { isManuallyModified: item.isManuallyModified }
            : {}),
          ...(modificationReason !== undefined ? { modificationReason } : {}),
          // 不解检（EXEMPT）：契约早收这两栏，此前被丢弃导致免检标记全链路落不下去
          ...(item.isExempt !== undefined ? { isExempt: item.isExempt } : {}),
          ...(item.exemptReason !== undefined ? { exemptReason: item.exemptReason } : {}),
        };
      }),
      // 检验员填写的合格 / 不合格数量随判定一并落库（docs/21 §14）。契约里本就有这两栏，
      // 此前控制器没往下透传，于是「判定即建单」的 MRB 只能取到领域派生兜底值 ——
      // 首次判定时该值恒等于整批抽样数，页面上看起来就是「不合格数量 = 检测数」。
      ...(body.passQty !== undefined ? { passQty: body.passQty } : {}),
      ...(body.failQty !== undefined ? { failQty: body.failQty } : {}),
      operatorId: operator.userId,
      operatorName: operator.userName,
    };

    // 草稿：仅落库实测值，不做整单终判；正式提交：由领域聚合执行综合判定
    const updated: InspectionOrder = body.isDraft
      ? await container.useCases.saveInspectionDraft.execute(command, securityCtx)
      : await container.useCases.recordMeasurementsAndJudge.execute(command, securityCtx);

    return reply.status(200).send(updated);
  };

  fastify.post(
    '/:id/results',
    {
      schema: {
        params: InspectionParamsSchema,
        body: SubmitMeasurementsRequestSchema,
      },
    },
    submitMeasurements
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
    submitMeasurements
  );

  fastify.post(
    '/:id/re-inspection',
    {
      schema: {
        params: InspectionParamsSchema,
        body: CreateReinspectionRequestSchema,
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof InspectionParamsSchema>;
      const body = (request.body ?? {}) as z.infer<typeof CreateReinspectionRequestSchema>;
      const operator = operatorOf(request);
      const securityCtx = await buildRequestSecurityContext(request, container);

      const order = await container.useCases.createReinspection.execute(
        {
          parentOrderId: id,
          ...(body.reworkRecordNo !== undefined ? { reworkRecordNo: body.reworkRecordNo } : {}),
          ...(body.reworkReason !== undefined ? { reworkReason: body.reworkReason } : {}),
          ...(body.inspectorId !== undefined ? { inspectorId: body.inspectorId } : {}),
          ...(body.inspectorName !== undefined ? { inspectorName: body.inspectorName } : {}),
          operatorId: operator.userId,
          operatorName: operator.userName,
        },
        securityCtx
      );

      return reply.status(201).send(order);
    }
  );

  // 4.5 表头业务事实更新 (PATCH /:id/header)：炉批号 / 材质牌号 / 执行技术标准 / 检验日期
  //
  //   docs/47 §4.5 / §4.6 的写入口。此前出货检验表头**没有任何写路径**：录入人在界面上
  //   填的炉号只进页面状态与证书，提交后既不落库、也无法被下游单据按炉批号关联（D1）。
  //
  //   两条信任边界：
  //   ① 溯源留痕（heat_source_type / heat_source_order_no）由用例**在服务端重新解析**，
  //      请求体不接受客户端自称的带出源（与「签核人取自会话」同一条口径）；
  //   ② PBAC 仍然按单据可访问性核验（与 GET /:id 同一判定），不因为「只改几个字段」而放宽。
  fastify.patch(
    '/:id/header',
    {
      schema: {
        params: InspectionParamsSchema,
        body: UpdateInspectionHeaderRequestSchema,
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof InspectionParamsSchema>;
      const body = request.body as z.infer<typeof UpdateInspectionHeaderRequestSchema>;
      const operator = operatorOf(request);
      const securityCtx = await buildRequestSecurityContext(request, container);

      const order = await orders.findById(id);
      if (!order) {
        throw new NotFoundError(`检验单不存在: ${id}`);
      }

      const material = await container.repositories.masterData.findMaterialByCode(order.materialCode);
      const categoryCode = material?.categoryCode ?? 'STANDARD_PARTS';

      securityCtx.assertAccess({
        targetCategory: categoryCode,
        targetMaterialCode: order.materialCode,
        ...(order.supplierCode !== undefined ? { targetSupplierCode: order.supplierCode } : {}),
        operationName: '更新检验单炉批号表头字段',
      });

      // 逐字段条件展开：exactOptionalPropertyTypes 下不能显式传 undefined
      const updated = await container.useCases.updateInspectionHeatFields.execute(
        {
          orderId: id,
          ...(body.furnaceHeatNo !== undefined ? { furnaceHeatNo: body.furnaceHeatNo } : {}),
          ...(body.materialGrade !== undefined ? { materialGrade: body.materialGrade } : {}),
          ...(body.techStandard !== undefined ? { techStandard: body.techStandard } : {}),
          ...(body.inspectedDate !== undefined ? { inspectedDate: body.inspectedDate } : {}),
          // 038 证书模板与证书专用字段袋（docs/51）：与其它表头字段同一「显式传入才写」口径
          ...(body.certTemplate !== undefined ? { certTemplate: body.certTemplate } : {}),
          ...(body.certFields !== undefined ? { certFields: body.certFields } : {}),
          // 委外检验台账三列：加工类型 / 回厂日期 / 加工商快照 —— ERP 同步不携带，
          // 录入页手工补录走本接口落库；契约未声明的键到不了这里（zod 剥掉）
          ...(body.processType !== undefined ? { processType: body.processType } : {}),
          ...(body.returnDate !== undefined ? { returnDate: body.returnDate } : {}),
          ...(body.vendorName !== undefined ? { vendorName: body.vendorName } : {}),
          operatorId: operator.userId,
          operatorName: operator.userName,
        },
        securityCtx
      );

      return reply.status(200).send(updated);
    }
  );

  // 5. 更新检验单状态与判定 (status & verdict)
  //
  //   终判唯一写入口（docs/39 §2 D1）：走 useCases.finalizeInspectionStatus，在同一事务内完成
  //   状态流转、数量 / 结论 / 终判时间落库、**判不合格自动汇入不合格待审核池**与审计留痕。
  //   此前这里直接调读侧仓储写入（无事务、无审计、无入池），导致「判定不合格 -> 入池」
  //   （PRD §3.7）在这条路径上从未发生，MRB 页面自然看不到记录。
  fastify.post(
    "/:id/status",
    {
      schema: {
        params: InspectionParamsSchema,
        body: FinalizeInspectionStatusRequestSchema,
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof InspectionParamsSchema>;
      const body = request.body as z.infer<typeof FinalizeInspectionStatusRequestSchema>;
      const operator = operatorOf(request);
      const securityCtx = await buildRequestSecurityContext(request, container);

      // 逐字段条件展开：exactOptionalPropertyTypes 下不能显式传 undefined
      const updated = await container.useCases.finalizeInspectionStatus.execute(
        {
          orderId: id,
          status: body.status,
          ...(body.judgment !== undefined ? { judgment: body.judgment } : {}),
          ...(body.passQty !== undefined ? { passQty: body.passQty } : {}),
          ...(body.failQty !== undefined ? { failQty: body.failQty } : {}),
          ...(body.sampleQty !== undefined ? { sampleQty: body.sampleQty } : {}),
          ...(body.remark !== undefined ? { remark: body.remark } : {}),
          ...(body.inspectionNotes !== undefined ? { inspectionNotes: body.inspectionNotes } : {}),
          ...(body.preliminaryDisposition !== undefined
            ? { preliminaryDisposition: body.preliminaryDisposition }
            : {}),
          operatorId: operator.userId,
          operatorName: operator.userName,
        },
        securityCtx
      );

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

  // 旧版「/transfer-overrides」三路由（申请 / 审批 / 列表）已删除：
  //   与下方 2.6~2.8 的「/transfer-overrides/tickets」是重复实现，且更不安全 ——
  //   既缺 `assertQualityApprover` 角色门禁（任意登录用户可审批豁免申请），
  //   又直接采信请求体的 `applicantId` / `reviewerId`（可自称申请人与审批人），
  //   也没有 Zod 校验与安全上下文。全仓库无调用方，特此移除以消除第二条无审计路径。
  //   统一走 tickets 路径：`/transfer-overrides/tickets`、`.../tickets/:ticketNo/review`。

  /**
   * 链路终止的下游在制单据安全冻结批处理（TBD-06）
   * POST /api/v1/inspections/batch-freeze-terminated
   */
  fastify.post(
    '/batch-freeze-terminated',
    {
      schema: {
        body: BatchFreezeTerminatedChainsRequestSchema,
      },
    },
    async (request, reply) => {
      const operator = operatorOf(request);
      const body = request.body as z.infer<typeof BatchFreezeTerminatedChainsRequestSchema>;
      const securityCtx = await buildRequestSecurityContext(request, container);
      const result = await container.useCases.batchFreezeTerminatedChains.execute(
        {
          ...(body.batchNo ? { batchNo: body.batchNo } : {}),
          dryRun: body.dryRun === true,
        },
        securityCtx
      );
      return reply.status(200).send(BatchFreezeTerminatedChainsResponseSchema.parse(result));
    }
  );
  postOnly405('/batch-freeze-terminated');
};
