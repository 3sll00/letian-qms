import { FastifyPluginAsync, type FastifyReply, type FastifyRequest } from 'fastify';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  CreateMRBReviewRequestSchema,
  SubmitNodeReviewRequestSchema,
  InitiateReviewRequestSchema,
  MRBCategoryTabEnum,
  MRBDispositionEnum,
  MRBStatusEnum,
  MRBApproverActionSchema,
  PendingDefectStatusEnum,
  type MRBReview,
} from '@letian/contracts';
import { NotFoundError } from '@letian/application';
import type { ApiContainer } from '../container';
import { operatorOf } from '../lib/operator';
import {
  getRequestPermissions,
  buildRequestSecurityContext,
} from '../lib/permission-guard';

/** 日期入参格式：`YYYY-MM-DD` */
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * 宽松日期字符串 schema：接受 `YYYY-MM-DD` / `YYYY/MM/DD` / `YYYY.MM.DD`
 * （分隔符 `-` `/` `.` 均可），一律归一化为 `YYYY-MM-DD` 再向下传递。
 * 同时校验真实日历日期，拒绝 `2026-13-01`、`2026-02-30` 之类。
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

const MRBQuerySchema = z.object({
  categoryTab: MRBCategoryTabEnum.default('ALL'),
  /**
   * 评审状态过滤：支持单值或逗号分隔多值。
   * 页面「已评审」页签 = `DISPOSED,REJECTED`（2026-09-23 起原「已处置」页签已并入「已评审」，谓词不变，见 docs/19 §4.1）。
   * 逐项按 MRBStatusEnum 校验，非法值直接 400，绝不静默忽略。
   */
  status: z
    .string()
    .optional()
    .transform((value) =>
      value === undefined
        ? undefined
        : value
            .split(',')
            .map((item) => item.trim())
            .filter((item) => item !== '')
    )
    .pipe(z.array(MRBStatusEnum).nonempty().optional()),
  /** MRB 单号模糊检索 */
  mrbNo: z.string().trim().min(1).optional(),
  /** 来源检验单号模糊检索 */
  sourceOrderNo: z.string().trim().min(1).optional(),
  /** 处置方式过滤：退货 / 返工 / 特采 / 报废 */
  disposition: MRBDispositionEnum.optional(),
  /** 发现日期下界（含） */
  dateFrom: isoDateString('dateFrom'),
  /** 发现日期上界（含） */
  dateTo: isoDateString('dateTo'),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

/**
 * `YYYY-MM-DD` → 本地日界时间点。
 * `offsetDays = 0` 取当日 00:00:00（含），`offsetDays = 1` 取次日 00:00:00（不含），
 * 二者构成「日界右开区间」，避免 `<= 23:59:59` 写法丢毫秒。
 */
function localDayBoundary(date: string, offsetDays: number): Date {
  const [yearText = '1970', monthText = '01', dayText = '01'] = date.split('-');
  return new Date(
    Number(yearText),
    Number(monthText) - 1,
    Number(dayText) + offsetDays,
    0,
    0,
    0,
    0
  );
}

const PendingPoolQuerySchema = z.object({
  sourceStage: z.enum(['IQC', 'IPQC', 'FQC', 'OQC']).optional(),
  stage: z.enum(['IQC', 'IPQC', 'FQC', 'OQC']).optional(),
  inspectionType: z.string().optional(),
  materialCode: z.string().optional(),
  batchNo: z.string().optional(),
  /**
   * 池状态：只接受契约三态。004 建表时的历史词表（PENDING_REVIEW / REVIEWING / RESOLVED）
   * 已由迁移 015 归一，此处不再兼容，传入旧值直接 400（口径收敛，见 docs/21 §9 遗留 3）。
   */
  status: PendingDefectStatusEnum.optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

const MRBParamsSchema = z.object({
  id: z.string().uuid('MRB记录ID必须为有效UUID'),
});

/**
 * 前端会签页提交体：在契约 SubmitNodeReviewRequest 基础上允许 APPOVE/REJECT 简写，
 * 并接受前端已选定的责任角色与签署人姓名（契约正文不含这两个字段，但会签记录需要落库）。
 */
const SignatureRequestSchema = z.object({
  action: z.enum(['APPROVE', 'REJECT', 'APPROVED', 'REJECTED']),
  comment: z.string().default(''),
  roleCode: z.string().optional(),
  approverName: z.string().optional(),
  signatureUrl: z.string().optional(),
});

/**
 * 处置提交体：与契约 `DisposeMRBRequest` 同名同义
 * （`dispositionReason` 为页面字段名，`dispositionNotes`/`reason` 为兼容别名，值统一落
 * `mrb_reviews.disposition_notes`）；`approvers` 省略时沿用会签历史。
 * 特采附件**不做任何默认兜底**：缺失即由用例抛 400 CONCESSION_NOT_SIGNED_OFF。
 */
const CustomerSignOffBodySchema = z.object({
  customerName: z.string().trim().min(1),
  signOffDocumentUrl: z.string().trim().min(1),
  agreed: z.literal(true),
});

const DispositionBodySchema = z
  .object({
    disposition: z
      .enum(['CONCESSION', 'REWORK', 'SCRAP', 'RETURN_TO_VENDOR', 'RETURN'])
      .transform((val) => (val === 'RETURN' ? 'RETURN_TO_VENDOR' : val)),
    dispositionReason: z.string().min(2).optional(),
    dispositionNotes: z.string().min(2).optional(),
    reason: z.string().optional(),
    approvers: z.array(MRBApproverActionSchema).default([]),
    concessionAttachmentUrl: z.string().optional(),
  })
  .refine(
    (value) =>
      value.dispositionReason !== undefined ||
      value.dispositionNotes !== undefined ||
      value.reason !== undefined,
    { message: '必须提供处置决议理由（dispositionReason / dispositionNotes）', path: ['dispositionReason'] }
  );

/** 分类页签 -> MRB 不合格来源类型 (MRBFailCategoryEnum) */
const CATEGORY_TAB_TO_SOURCE: Partial<Record<
  z.infer<typeof MRBCategoryTabEnum>,
  MRBReview['sourceType']
>> = {
  IQC_DEFECT: 'INCOMING_FAIL',
  IPQC_DEFECT: 'PROCESS_FAIL',
  OQC_DEFECT: 'SHIPMENT_FAIL',
};

export const mrbController: FastifyPluginAsync<{ container: ApiContainer }> = async (
  fastify,
  options
) => {
  const { container } = options;
  const mrbReviews = container.repositories.mrbReviews;

  // 0. 待审核池接口：查询各环节未发起评审的不合格记录（支持多条件筛选）
  fastify.get(
    '/pending-pool',
    {
      schema: {
        querystring: PendingPoolQuerySchema,
      },
    },
    async (request, reply) => {
      const query = request.query as z.infer<typeof PendingPoolQuerySchema>;
      // 行级权限随查询下推 SQL（分类维度按 materials.category_code 换算），
      // 因此这里传权限规则而不是应用层安全上下文，见 docs/21 §9 遗留 1
      const permissions = await getRequestPermissions(request, container);

      const result = await container.useCases.pendingMRBPool.getPendingList(
        {
          stage: query.sourceStage ?? query.stage ?? query.inspectionType,
          sourceStage: query.sourceStage ?? query.stage ?? query.inspectionType,
          inspectionType: query.sourceStage ?? query.stage ?? query.inspectionType,
          materialCode: query.materialCode,
          batchNo: query.batchNo,
          status: query.status,
          page: query.page,
          pageSize: query.pageSize,
        },
        permissions
      );

      return reply.status(200).send({
        items: result.items,
        list: result.items,
        total: result.total,
        page: query.page,
        pageSize: query.pageSize,
      });
    }
  );

  // 0.1 待审核池接口：逐条发起独立评审，生成 MRB 工单
  fastify.post(
    '/pending-pool/initiate',
    {
      schema: {
        body: InitiateReviewRequestSchema,
      },
    },
    async (request, reply) => {
      const body = request.body as z.infer<typeof InitiateReviewRequestSchema>;
      const operator = operatorOf(request);
      const securityCtx = await buildRequestSecurityContext(request, container);

      const review = await container.useCases.pendingMRBPool.initiateReview(
        body,
        operator,
        securityCtx
      );

      return reply.status(201).send(review);
    }
  );

  // 1. 查询 MRB 不合格评审记录列表（支持四大分类 Tab 与 KPI 统计，注入三维 PBAC 行级过滤）
  fastify.get(
    '/records',
    {
      schema: {
        querystring: MRBQuerySchema,
      },
    },
    async (request, reply) => {
      const query = request.query as z.infer<typeof MRBQuerySchema>;
      const sourceType = CATEGORY_TAB_TO_SOURCE[query.categoryTab];
      const permissions = await getRequestPermissions(request, container);

      // KPI 统计与列表数据均受当前用户 PBAC 规则严格过滤
      const result = await mrbReviews.listMrbReviews({
        page: query.page,
        pageSize: query.pageSize,
        permissions,
        ...(sourceType !== undefined ? { sourceType } : {}),
        ...(query.status !== undefined ? { statuses: query.status } : {}),
        ...(query.mrbNo !== undefined ? { mrbNo: query.mrbNo } : {}),
        ...(query.sourceOrderNo !== undefined ? { sourceOrderNo: query.sourceOrderNo } : {}),
        ...(query.disposition !== undefined ? { disposition: query.disposition } : {}),
        ...(query.dateFrom !== undefined
          ? { createdFrom: localDayBoundary(query.dateFrom, 0) }
          : {}),
        ...(query.dateTo !== undefined
          ? { createdToExclusive: localDayBoundary(query.dateTo, 1) }
          : {}),
      });

      // 不合格待审核池「待发起评审」计数（docs/39 §2 D3）：
      // 池条目按两阶段口径不进 MRB 处置列表，页面若没有这个计数，
      // 「判不合格后看不到记录」就与「根本没入池」无法区分。
      // 与列表同一套 PBAC 规则过滤（分类经 materials、供应商经源检验单换算）。
      const pendingPool = await container.repositories.pendingDefects.list({
        status: 'PENDING_INITIATE',
        permissions,
        page: 1,
        pageSize: 1,
      });

      return reply.status(200).send({
        ...result,
        pendingPoolCount: pendingPool.total,
        page: query.page,
        pageSize: query.pageSize,
        // 兼容别名：早期契约消费方使用 list，与 items 指向同一份当页数据
        list: result.items,
      });
    }
  );

  fastify.get(
    '/:id',
    {
      schema: {
        params: MRBParamsSchema,
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof MRBParamsSchema>;
      const record = await mrbReviews.findById(id);
      if (!record) {
        throw new NotFoundError(`MRB记录不存在: ${id}`);
      }

      const securityCtx = await buildRequestSecurityContext(request, container);
      const material = await container.repositories.masterData.findMaterialByCode(record.materialCode);
      const sourceOrder = await container.repositories.orders.findByOrderNo(record.sourceOrderNo);
      securityCtx.assertAccess({
        targetCategory: material?.categoryCode ?? 'STANDARD_PARTS',
        targetMaterialCode: record.materialCode,
        ...(sourceOrder?.supplierCode !== undefined
          ? { targetSupplierCode: sourceOrder.supplierCode }
          : {}),
        operationName: '查看MRB详情',
      });

      return reply.status(200).send(record);
    }
  );

  // 2. 创建 MRB 不合格评审单
  fastify.post(
    '/records',
    {
      schema: {
        body: CreateMRBReviewRequestSchema,
      },
    },
    async (request, reply) => {
      const body = request.body as z.infer<typeof CreateMRBReviewRequestSchema>;
      const operator = operatorOf(request);
      const securityCtx = await buildRequestSecurityContext(request, container);

      // 验证物料分类及创建权限
      const material = await container.repositories.masterData.findMaterialByCode(body.materialCode);
      const categoryCode = material?.categoryCode ?? 'STANDARD_PARTS';

      securityCtx.assertAccess({
        targetCategory: categoryCode,
        targetMaterialCode: body.materialCode,
        operationName: '创建MRB评审单',
      });

      const now = new Date().toISOString();

      // 手工建单路径可选关联池条目：仅当池中确有该条目时才写外键（避免 FK 违约）
      const linkedPoolItem =
        body.pendingDefectId !== undefined
          ? await container.repositories.pendingDefects.findById(body.pendingDefectId)
          : null;

      const record: MRBReview = {
        id: randomUUID(),
        mrbNo: `MRB-${body.sourceType.slice(0, 3)}-${Date.now().toString().slice(-6)}-${Math.floor(
          Math.random() * 900 + 100
        )}`,
        sourceType: body.sourceType,
        sourceOrderNo: body.sourceOrderNo,
        batchNo: body.batchNo,
        materialCode: body.materialCode,
        materialName: body.materialName,
        defectDescription: body.defectDescription,
        defectQty: body.defectQty,
        status: 'PENDING_REVIEW',
        // 手工建单没有发起弹窗，紧急程度取默认值；池发起路径由 initiate 接口透传
        urgencyLevel: 'NORMAL',
        approvers: [],
        createdAt: now,
        updatedAt: now,
        ...(linkedPoolItem !== null ? { pendingDefectId: linkedPoolItem.id } : {}),
      };

      await container.uow.execute(async (ctx) => {
        await ctx.locks.acquireXactLock(`LOCK_MRB_${body.batchNo}`);
        await ctx.mrbReviews.save(record);
        await ctx.outbox.append({
          id: randomUUID(),
          aggregateType: 'MRBReview',
          aggregateId: record.id ?? '',
          eventType: 'MRBReviewCreated',
          payload: {
            mrbId: record.id,
            mrbNo: record.mrbNo,
            sourceOrderNo: record.sourceOrderNo,
            batchNo: record.batchNo,
            sourceType: record.sourceType,
          },
          traceId: randomUUID(),
          occurredAt: new Date(),
          status: 'PENDING',
          retryCount: 0,
        });
        await ctx.auditLogs.insert({
          id: randomUUID(),
          traceId: randomUUID(),
          userId: operator.userId,
          userName: operator.userName,
          action: 'CREATE',
          resourceType: 'MRB_REVIEW',
          resourceId: record.id ?? '',
          status: 'SUCCESS',
          diffPatch: { mrbNo: record.mrbNo, sourceOrderNo: record.sourceOrderNo },
          createdAt: now,
        });
      });

      return reply.status(201).send(record);
    }
  );

  /** 节点会签：驳回直接终止流程；通过则进入会签中（全部节点签署完成由处置接口收口） */
  async function submitSignature(
    id: string,
    body: z.infer<typeof SignatureRequestSchema>,
    request: FastifyRequest
  ): Promise<MRBReview> {
    const operator = operatorOf(request);
    const securityCtx = await buildRequestSecurityContext(request, container);

    const existing = await mrbReviews.findById(id);
    if (!existing) {
      throw new NotFoundError(`MRB记录不存在: ${id}`);
    }

    const material = await container.repositories.masterData.findMaterialByCode(existing.materialCode);
    const categoryCode = material?.categoryCode ?? 'STANDARD_PARTS';

    securityCtx.assertAccess({
      targetCategory: categoryCode,
      targetMaterialCode: existing.materialCode,
      operationName: 'MRB节点会签',
    });

    const isApprove = body.action === 'APPROVE' || body.action === 'APPROVED';
    const finalAction: 'APPROVED' | 'REJECTED' = isApprove ? 'APPROVED' : 'REJECTED';
    const now = new Date().toISOString();

    const signedRecord: MRBReview = {
      ...existing,
      status: isApprove ? 'UNDER_REVIEW' : 'REJECTED',
      approvers: [
        ...existing.approvers,
        {
          roleCode: body.roleCode ?? operator.role,
          userId: operator.userId,
          userName: body.approverName ?? operator.userName,
          action: finalAction,
          comment: body.comment,
          ...(body.signatureUrl !== undefined ? { signatureUrl: body.signatureUrl } : {}),
          signedAt: now,
        },
      ],
      updatedAt: now,
    };

    await container.uow.execute(async (ctx) => {
      await ctx.locks.acquireXactLock(`LOCK_MRB_${existing.batchNo}`);
      await ctx.mrbReviews.save(signedRecord);
      await ctx.outbox.append({
        id: randomUUID(),
        aggregateType: 'MRBReview',
        aggregateId: id,
        eventType: isApprove ? 'MRBNodeApproved' : 'MRBNodeRejected',
        payload: {
          mrbId: id,
          mrbNo: existing.mrbNo,
          action: finalAction,
          approverId: operator.userId,
          comment: body.comment,
        },
        traceId: randomUUID(),
        occurredAt: new Date(),
        status: 'PENDING',
        retryCount: 0,
      });
      await ctx.auditLogs.insert({
        id: randomUUID(),
        traceId: randomUUID(),
        userId: operator.userId,
        userName: operator.userName,
        action: 'UPDATE',
        resourceType: 'MRB_REVIEW',
        resourceId: id,
        status: 'SUCCESS',
        diffPatch: { action: finalAction, comment: body.comment },
        createdAt: now,
      });
    });

    return signedRecord;
  }

  // 3. 提交节点会签意见（旧标准路径：/records/:id/sign）
  fastify.post(
    '/records/:id/sign',
    {
      schema: {
        params: MRBParamsSchema,
        body: SignatureRequestSchema,
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof MRBParamsSchema>;
      const body = request.body as z.infer<typeof SignatureRequestSchema>;
      const record = await submitSignature(id, body, request);
      return reply.status(200).send(record);
    }
  );

  // 4. 提交节点评审意见（契约对齐路径：/records/:id/reviews）
  fastify.post(
    '/records/:id/reviews',
    {
      schema: {
        params: MRBParamsSchema,
        body: SubmitNodeReviewRequestSchema,
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof MRBParamsSchema>;
      const body = request.body as z.infer<typeof SubmitNodeReviewRequestSchema>;
      const record = await submitSignature(
        id,
        {
          action: body.action,
          comment: body.comment,
          ...(body.signatureUrl !== undefined ? { signatureUrl: body.signatureUrl } : {}),
        },
        request
      );
      return reply.status(200).send(record);
    }
  );

  fastify.post(
    '/records/:id/customer-sign-off',
    {
      schema: {
        params: MRBParamsSchema,
        body: CustomerSignOffBodySchema,
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof MRBParamsSchema>;
      const body = request.body as z.infer<typeof CustomerSignOffBodySchema>;
      const operator = operatorOf(request);
      const securityCtx = await buildRequestSecurityContext(request, container);
      const updated = await container.useCases.customerSignOff.execute({
        mrbId: id,
        customerName: body.customerName,
        signOffDocumentUrl: body.signOffDocumentUrl,
        agreed: body.agreed,
        operatorId: operator.userId,
        operatorName: operator.userName,
      }, securityCtx);
      return reply.status(200).send(updated);
    }
  );

  // 5. 提交最终处置结论
  const submitDisposition = async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as z.infer<typeof MRBParamsSchema>;
    const body = request.body as z.infer<typeof DispositionBodySchema>;
    const operator = operatorOf(request);
    const securityCtx = await buildRequestSecurityContext(request, container);

    const record = await mrbReviews.findById(id);
    if (!record) {
      throw new NotFoundError(`MRB记录不存在: ${id}`);
    }

    const material = await container.repositories.masterData.findMaterialByCode(record.materialCode);
    const categoryCode = material?.categoryCode ?? 'STANDARD_PARTS';
    const sourceOrder = await container.repositories.orders.findByOrderNo(record.sourceOrderNo);

    securityCtx.assertAccess({
      targetCategory: categoryCode,
      targetMaterialCode: record.materialCode,
      ...(sourceOrder?.supplierCode !== undefined ? { targetSupplierCode: sourceOrder.supplierCode } : {}),
      operationName: '提交MRB最终处置结论',
    });

    const reason =
      body.dispositionReason || body.dispositionNotes || body.reason || '多方会签评审确认处置方式';
    const updated = await container.useCases.decideMrbDisposition.execute(
      {
        mrbId: id,
        disposition: body.disposition,
        dispositionReason: reason,
        approvers: body.approvers,
        // 特采附件只认「本次提交」或「单据已有」的客户书面签核件，绝不生成默认路径
        ...(body.concessionAttachmentUrl !== undefined
          ? { concessionAttachmentUrl: body.concessionAttachmentUrl }
          : record.concessionAttachmentUrl !== undefined
            ? { concessionAttachmentUrl: record.concessionAttachmentUrl }
            : {}),
        operatorId: operator.userId,
        operatorName: operator.userName,
      },
      securityCtx
    );

    // 契约响应体 = MRBRecord 本体 + 处置连带产物（DisposeMRBResponse）：
    // 返工（REWORK）处置会在同一事务内生成下一轮复检单，这里把复检单标识一并回吐，
    // 前端无需按批次号反查即可展示「已生成复检单 {单号}」（此前用例已算出却被丢弃）。
    // 注意：响应体仍是 MRB 单据本身（此前把用例包装对象 { mrbReview } 当 DTO 下发，
    // 前端拿到后 status/disposition 全为 undefined，见 docs/20 §3.2 D6），
    // 这里只是在其上追加两个可选字段，非返工处置的响应与旧版逐字段一致。
    return reply.status(200).send({
      ...updated.mrbReview,
      ...(updated.reinspectionOrderId !== undefined
        ? { reinspectionOrderId: updated.reinspectionOrderId }
        : {}),
      ...(updated.reinspectionOrderNo !== undefined
        ? { reinspectionOrderNo: updated.reinspectionOrderNo }
        : {}),
    });
  };

  fastify.post(
    '/:id/disposition',
    {
      schema: {
        params: MRBParamsSchema,
        body: DispositionBodySchema,
      },
    },
    submitDisposition
  );

  fastify.post(
    '/records/:id/disposition',
    {
      schema: {
        params: MRBParamsSchema,
        body: DispositionBodySchema,
      },
    },
    submitDisposition
  );
};
