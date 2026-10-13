import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import {
  CreateInspectionPlanRequestSchema,
  TogglePlanVersionStatusRequestSchema,
  UpgradePlanVersionRequestSchema,
  InspectionTypeEnum,
  MatchInspectionPlanQuerySchema,
  ErrorCode,
} from '@letian/contracts';
import { ApplicationError, NotFoundError, ValidationFailedError } from '@letian/application';
import type { ApiContainer } from '../container';
import { operatorOf } from '../lib/operator';
import {
  getRequestPermissions,
  buildRequestSecurityContext,
  assertPlanApprover,
} from '../lib/permission-guard';
import {
  buildPlanImportTemplate,
  parsePlanImportPdf,
  parsePlanImportWorkbook,
  type PlanImportMasterData,
} from '../lib/plan-import';

const PlanQuerySchema = z.object({
  inspectionType: InspectionTypeEnum.optional(),
  materialCode: z.string().optional(),
  // 产品分类（存货分类编码）：经主数据 materials.category_code 反查命中方案
  categoryCode: z.string().optional(),
  keyword: z.string().optional(),
  // 「生效」语义：该方案存在 status = ACTIVE 的版本
  isActive: z.coerce.boolean().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

const PlanParamsSchema = z.object({
  id: z.string().uuid('方案ID必须为有效UUID'),
});

const PlanVersionParamsSchema = z.object({
  versionId: z.string().uuid('方案版本ID必须为有效UUID'),
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
        ...(query.categoryCode !== undefined ? { categoryCode: query.categoryCode } : {}),
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

  // 2. 质检方案 KPI 聚合（供「质检方案设计」页 4 张卡片直接渲染）
  //    口径：只施加 PBAC 物料权限过滤，不受列表筛选条件与分页影响；
  //    严禁用当页列表数据推算全局 KPI（方案数超过一页时数字必然失真）。
  fastify.get('/stats', async (request, reply) => {
    const permissions = await getRequestPermissions(request, container);
    const stats = await plans.getPlanStats({ permissions });
    return reply.status(200).send(stats);
  });

  // 3. 质检方案自动匹配 (只读)：按「物料编码 + 检验类型」命中已启用方案，返回待检指标清单
  //    供「检验录入」页渲染指标清单，并把 planVersionId 原样回传给建单接口完成方案快照绑定。
  //    与建单接口的服务端自动匹配共用 findActivePlan，匹配口径唯一 (docs/17-检验录入界面说明与质检方案匹配口径.md §7)。
  fastify.get(
    '/match',
    {
      schema: {
        querystring: MatchInspectionPlanQuerySchema,
      },
    },
    async (request, reply) => {
      const query = request.query as z.infer<typeof MatchInspectionPlanQuerySchema>;

      // PBAC 物料权限校验先于方案查询，避免向越权用户泄露方案是否存在。
      // 方案域对象**无供应商属性**（方案表无 supplier_code 列，检验标准不分供应商），
      // 故供应商维度不参与判定：只核对物料分类 + 物料编码 —— 否则三维限定账号
      //（如 IQC 检验员陈静：分类 + 编码 + 供应商）在录入页恒 403、指标清单恒空。
      // 口径见 docs/42-质检方案域PBAC供应商维度错配修复设计.md §3。
      const securityCtx = await buildRequestSecurityContext(request, container);
      const material = await container.repositories.masterData.findMaterialByCode(query.materialCode);
      securityCtx.assertAccess({
        targetCategory: material?.categoryCode ?? 'UNKNOWN',
        targetMaterialCode: query.materialCode,
        supplierDimension: 'NOT_APPLICABLE',
        operationName: '匹配质检方案',
      });

      // 分类级兜底：物料无专属方案时下沉到该物料所属存货分类的通用方案（docs/17 §7.3）
      const plan = await plans.findActivePlan(query.materialCode, query.inspectionType, material?.categoryCode);
      if (!plan) {
        throw new NotFoundError(
          `未找到适用于物料 [${query.materialCode}]、检验类型 [${query.inspectionType}] 的已启用质检方案`,
          ErrorCode.INSPECTION_PLAN_NOT_FOUND
        );
      }

      const version = plan.versions?.find((candidate) => candidate.status === 'ACTIVE');
      if (!version) {
        throw new ApplicationError(
          ErrorCode.INSPECTION_PLAN_NOT_ACTIVE,
          `质检方案 [${plan.planCode}] 当前无已启用的有效版本`,
          400
        );
      }

      const planVersionId = version.id ?? plan.id;
      if (!planVersionId || version.items.length === 0) {
        throw new ApplicationError(
          ErrorCode.INSPECTION_PLAN_NOT_FOUND,
          `质检方案 [${plan.planCode}] 版本 [${version.versionNo}] 缺少版本行标识或指标项，无法生成检验项`,
          400
        );
      }

      return reply.status(200).send({
        planCode: plan.planCode,
        planName: plan.planName,
        // 命中来源由两级匹配规则直接推导：material_code 与请求物料编码相等即物料专属方案，
        // 否则必为 material_code 为空串的分类通用方案（两级取值互斥，不存在歧义）
        matchSource: plan.materialCode === query.materialCode ? 'MATERIAL' : 'MATERIAL_CATEGORY',
        planVersionId,
        versionNo: version.versionNo,
        inspectionType: plan.inspectionType,
        // 039：同时回传适用类型全集，录入页可据实展示「本方案还适用于哪些检验类型」
        inspectionTypes: plan.inspectionTypes ?? [plan.inspectionType],
        materialCode: plan.materialCode ?? query.materialCode,
        samplingScheme: version.samplingScheme,
        aqlLevel: version.aqlLevel,
        strictness: version.strictness,
        items: version.items,
        matchedAt: new Date().toISOString(),
      });
    }
  );

  // 4. 创建检验方案（保存即启用，不再进草稿）。planCode 可省略：留空时由服务端按 `QP-{YYYYMMDD}-{NNN}` 取号
  fastify.post(
    '/',
    {
      schema: {
        body: CreateInspectionPlanRequestSchema,
      },
    },
    async (request, reply) => {
      const body = request.body as z.infer<typeof CreateInspectionPlanRequestSchema>;
      const operator = operatorOf(request);
      const securityCtx = await buildRequestSecurityContext(request, container);

      // 查询真实物料分类，确保 PBAC 精确校验
      const material = body.materialCode ? await container.repositories.masterData.findMaterialByCode(body.materialCode) : null;
      const materialCategory = material?.categoryCode ?? 'STANDARD_PARTS';
      // 方案分类归属：显式声明优先，其次回落到绑定物料的真实分类（分类级兜底匹配依据）
      const planCategoryCode = body.categoryCode ?? material?.categoryCode ?? undefined;

      // 契约正文的 versions[0] 即首个版本（保存即启用）。指标项为空时由领域规则拒绝（PLAN_EMPTY_ITEMS -> 400）：
      // 禁止放行空版本，否则建单时方案快照给不出待检指标清单（与 /plans/match 的口径一致）
      const firstVersion = body.versions?.[0];
      const initialItems = firstVersion?.items ?? [];
      const initialVersionNo = firstVersion?.versionNo;
      const samplingScheme = firstVersion?.samplingScheme;
      const aqlLevel = firstVersion?.aqlLevel;
      const strictness = firstVersion?.strictness;
      // 生效日期为可选：前端（新建/导入弹窗）不再暴露，但契约仍允许直传，
      // 服务端原样落 sampling_config；缺省 = 长期有效（findActivePlan 以 IS NULL 放行）。
      const effectiveStartDate = firstVersion?.effectiveStartDate;
      const effectiveEndDate = firstVersion?.effectiveEndDate;

      const plan = await container.useCases.createPlan.execute(
        {
          // 方案编码留空即服务端取号（见 @letian/domain 的 inspection-plan-number）：
          // 页面「复制方案」与新建弹窗都走这条路，不再由前端拼 `-C{时间戳}` 之类的伪编码
          ...(body.planCode !== undefined ? { planCode: body.planCode } : {}),
          planName: body.planName,
          inspectionType: body.inspectionType,
          ...(body.inspectionTypes !== undefined ? { inspectionTypes: body.inspectionTypes } : {}),
          materialCode: body.materialCode,
          ...(planCategoryCode !== undefined ? { categoryCode: planCategoryCode } : {}),
          materialCategory,
          initialItems,
          createdBy: operator.userId,
          operatorName: operator.userName,
          ...(initialVersionNo !== undefined ? { initialVersionNo } : {}),
          ...(samplingScheme !== undefined ? { samplingScheme } : {}),
          ...(aqlLevel !== undefined ? { aqlLevel } : {}),
          ...(strictness !== undefined ? { strictness } : {}),
          ...(effectiveStartDate !== undefined ? { effectiveStartDate } : {}),
          ...(effectiveEndDate !== undefined ? { effectiveEndDate } : {}),
        },
        securityCtx
      );

      return reply.status(201).send(plan);
    }
  );

  // 5. 方案版本启停（审批）：仅质量主管可启用 / 停用某个版本
  fastify.post(
    '/versions/:versionId/status',
    {
      schema: {
        params: PlanVersionParamsSchema,
        body: TogglePlanVersionStatusRequestSchema,
      },
    },
    async (request, reply) => {
      const { versionId } = request.params as z.infer<typeof PlanVersionParamsSchema>;
      const { action } = request.body as z.infer<typeof TogglePlanVersionStatusRequestSchema>;
      const operator = operatorOf(request);
      // 方案启停是配置变更类动作，按角色门禁（登录 JWT 不带 permissions，故不能用权限位）
      assertPlanApprover(operator);
      const securityCtx = await buildRequestSecurityContext(request, container);

      // 目标版本由 URL 的版本行 UUID 唯一确定：findById 会把「版本行 id」解析成其所属方案，
      // 再由领域状态机保证单激活态（同方案旧 ACTIVE 自动转 INACTIVE）与「空版本不可启用」。
      const plan = await container.useCases.togglePlanVersion.execute(
        {
          planId: versionId,
          versionId,
          action,
          operatorId: operator.userId,
        },
        securityCtx
      );

      return reply.status(200).send(plan);
    }
  );

  // 6. 方案版本升版：以 URL 版本行为模板，为该方案再产出一个草稿版本
  //    门禁口径：升版只产出 DRAFT、不改变生效状态，故与「新建方案」POST / 同级 —— 只做 PBAC
  //    物料权限校验（用例内 assertAccess），不做角色门禁；改变生效状态的 …/status 才需质量主管。
  fastify.post(
    '/versions/:versionId/upgrade',
    {
      schema: {
        params: PlanVersionParamsSchema,
        body: UpgradePlanVersionRequestSchema,
      },
    },
    async (request, reply) => {
      const { versionId } = request.params as z.infer<typeof PlanVersionParamsSchema>;
      const body = request.body as z.infer<typeof UpgradePlanVersionRequestSchema>;
      const operator = operatorOf(request);
      const securityCtx = await buildRequestSecurityContext(request, container);

      // 省略的字段一律不透传（用 undefined 表达"沿用模板版本行"，避免把"字段缺席"写成空串/空数组）
      const plan = await container.useCases.upgradePlanVersion.execute(
        {
          planId: versionId,
          versionId,
          createdBy: operator.userId,
          ...(body.versionNo !== undefined ? { newVersionNo: body.versionNo } : {}),
          ...(body.items !== undefined ? { items: body.items } : {}),
          ...(body.samplingScheme !== undefined ? { samplingScheme: body.samplingScheme } : {}),
          ...(body.aqlLevel !== undefined ? { aqlLevel: body.aqlLevel } : {}),
          ...(body.strictness !== undefined ? { strictness: body.strictness } : {}),
          ...(body.effectiveStartDate !== undefined
            ? { effectiveStartDate: body.effectiveStartDate }
            : {}),
          ...(body.effectiveEndDate !== undefined
            ? { effectiveEndDate: body.effectiveEndDate }
            : {}),
        },
        securityCtx
      );

      return reply.status(201).send(plan);
    }
  );

  // 7. 获取检验方案详情（按方案版本行 UUID 查询，会自动聚合同 plan_code 的全部版本）
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

  // 8. Excel 导入模板下载（GET /plans/import-template）
  //    模板列定义与解析器同源（lib/plan-import.ts 的 PLAN_IMPORT_COLUMNS），检验项目取值来自
  //    契约包预置清单（与新建弹窗勾选清单同源），「填写说明 / 物料参照」页的分类、物料实时取主数据
  //    —— 模板即当前可用取值域。
  fastify.get('/import-template', async (request, reply) => {
    const masterData = await loadPlanImportMasterData(container);
    const buffer = await buildPlanImportTemplate(masterData);
    reply.header(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    );
    reply.header(
      'Content-Disposition',
      `attachment; filename="plan-import-template.xlsx"; filename*=UTF-8''${encodeURIComponent('质检方案导入模板.xlsx')}`
    );
    return reply.send(buffer);
  });

  // 9. Excel / PDF 批量导入方案（POST /plans/import）
  //    multipart/form-data，文件字段名 file，接受 .xlsx 与表格型 .pdf（上限 10MB，超限明确拒绝）。
  //    解析（xlsx 读单元格 / pdf 抽文字层还原表格）→ 同一套组内一致性 + 预置清单校验 →
  //    逐组调 CreatePlanUseCase 落库（与 POST /plans 同一写路径，审计 / Outbox / 服务端取号 /
  //    保存即启用口径完全一致），结果按 新建/跳过(判重)/失败 三态回显。
  fastify.post('/import', async (request, reply) => {
    const operator = operatorOf(request);
    const securityCtx = await buildRequestSecurityContext(request, container);

    const file = await request.file();
    if (file === undefined || file.fieldname !== 'file') {
      throw new ValidationFailedError('请求中缺少上传文件（multipart 字段名：file，格式 .xlsx / .pdf）');
    }
    const fileName = file.filename ?? '';
    const isPdf = /\.pdf$/i.test(fileName);
    if (!isPdf && !/\.xlsx$/i.test(fileName)) {
      throw new ValidationFailedError(
        `仅支持 .xlsx 或 .pdf 格式的导入文件，当前文件：${fileName === '' ? '(未命名)' : fileName}`
      );
    }
    let buffer: Buffer;
    try {
      buffer = await file.toBuffer();
    } catch {
      throw new ValidationFailedError('文件上传不完整或超出大小上限（10MB），请压缩或拆分后重试');
    }
    if (file.file.truncated) {
      throw new ValidationFailedError('文件超出大小上限（10MB），请拆分后重试');
    }

    const masterData = await loadPlanImportMasterData(container);
    // PDF：抽文字层还原表格后走同一校验/落库链路；xlsx：照常读工作表
    const parsed = isPdf
      ? parsePlanImportPdf(buffer, masterData)
      : await parsePlanImportWorkbook(buffer, masterData);

    const created: {
      planCode: string;
      planName: string;
      versionNo: string;
      itemCount: number;
      rows: number[];
    }[] = [];
    const skipped: { planName: string; rows: number[]; existingPlanCode: string }[] = [];
    const failed: { planName: string; rows: number[]; reason: string }[] = [...parsed.failures];

    for (const group of parsed.groups) {
      // 重复导入保护：同「名称 + 物料 + 分类 + 主类型」的既有方案不重复创建
      const duplicateCode = await plans.findDuplicatePlanCode({
        planName: group.planName,
        materialCode: group.materialCode,
        categoryCode: group.categoryCode,
        inspectionType: group.inspectionTypes[0] ?? 'IQC',
      });
      if (duplicateCode !== null) {
        skipped.push({ planName: group.planName, rows: group.rows, existingPlanCode: duplicateCode });
        continue;
      }

      try {
        const plan = await container.useCases.createPlan.execute(
          {
            planName: group.planName,
            inspectionType: group.inspectionTypes[0] as (typeof group.inspectionTypes)[number],
            inspectionTypes: group.inspectionTypes,
            ...(group.materialCode !== '' ? { materialCode: group.materialCode } : {}),
            categoryCode: group.categoryCode,
            materialCategory: group.materialCategory,
            initialItems: group.items,
            createdBy: operator.userId,
            operatorName: operator.userName,
            initialVersionNo: group.versionNo,
            samplingScheme: group.samplingScheme,
            aqlLevel: group.aqlLevel,
            strictness: group.strictness,
          },
          securityCtx
        );
        created.push({
          planCode: plan.planCode,
          planName: group.planName,
          versionNo: group.versionNo,
          itemCount: group.items.length,
          rows: group.rows,
        });
      } catch (err) {
        failed.push({
          planName: group.planName,
          rows: group.rows,
          reason: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return reply.status(200).send({
      fileName,
      totalRows: parsed.totalRows,
      planCount: created.length + skipped.length + failed.length,
      created,
      skipped,
      failed,
    });
  });
};

/**
 * 导入所需主数据快照：分类 / 物料 一次性拉取（解析与模板生成都用它）。
 * 检验项目不再取自 ERP 检验项目字典 —— 与新建弹窗同口径，改用契约包的预置检验项目清单
 * （plan-presets.ts）：模板说明页与解析器读同一份常量，不需要查库。
 */
async function loadPlanImportMasterData(container: ApiContainer): Promise<PlanImportMasterData> {
  const [categories, materials] = await Promise.all([
    container.repositories.masterData.getInventoryCategories(),
    container.repositories.masterData.getMaterials(),
  ]);
  return {
    categories: [...categories],
    materials: [...materials],
  };
}
