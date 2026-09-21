import { FastifyPluginAsync, type FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  CreateMRBReviewRequestSchema,
  SubmitNodeReviewRequestSchema,
  InitiateReviewRequestSchema,
  MRBCategoryTabEnum,
  MRBStatusEnum,
  type MRBReview,
} from '@letian/contracts';
import { NotFoundError, ConflictError } from '@letian/application';
import type { ApiContainer } from '../container';
import { operatorOf } from '../lib/operator';
import {
  getRequestPermissions,
  buildRequestSecurityContext,
  logAuthorizationCheck,
} from '../lib/permission-guard';

const MRBQuerySchema = z.object({
  categoryTab: MRBCategoryTabEnum.default('ALL'),
  status: MRBStatusEnum.optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

const PendingPoolQuerySchema = z.object({
  sourceStage: z.enum(['IQC', 'IPQC', 'FQC', 'OQC']).optional(),
  stage: z.enum(['IQC', 'IPQC', 'FQC', 'OQC']).optional(),
  inspectionType: z.string().optional(),
  materialCode: z.string().optional(),
  batchNo: z.string().optional(),
  status: z.enum(['PENDING_INITIATE', 'INITIATED', 'DISMISSED', 'PENDING_REVIEW', 'REVIEWING', 'RESOLVED']).optional(),
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

const DispositionBodySchema = z.object({
  disposition: z.enum(['CONCESSION', 'REWORK', 'SCRAP', 'RETURN_TO_VENDOR', 'RETURN']).transform((val) => (val === 'RETURN' ? 'RETURN_TO_VENDOR' : val)),
  reason: z.string().optional(),
  dispositionReason: z.string().optional(),
  dispositionNotes: z.string().optional(),
  concessionAttachmentUrl: z.string().optional(),
});

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
      const securityCtx = await buildRequestSecurityContext(request, container);

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
        securityCtx
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
        ...(query.status !== undefined ? { status: query.status } : {}),
      });

      return reply.status(200).send({
        ...result,
        page: query.page,
        pageSize: query.pageSize,
        // 兼容别名：早期契约消费方使用 list，与 items 指向同一份当页数据
        list: result.items,
      });
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

      const record: MRBReview = {
        id: crypto.randomUUID(),
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
        approvers: [],
        createdAt: now,
        updatedAt: now,
      };

      await container.uow.execute(async (ctx) => {
        await ctx.locks.acquireXactLock(`LOCK_MRB_${body.batchNo}`);
        await ctx.mrbReviews.save(record);
        await ctx.outbox.append({
          id: crypto.randomUUID(),
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
          traceId: crypto.randomUUID(),
          occurredAt: new Date(),
          status: 'PENDING',
          retryCount: 0,
        });
        await ctx.auditLogs.insert({
          id: crypto.randomUUID(),
          traceId: crypto.randomUUID(),
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
        id: crypto.randomUUID(),
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
        traceId: crypto.randomUUID(),
        occurredAt: new Date(),
        status: 'PENDING',
        retryCount: 0,
      });
      await ctx.auditLogs.insert({
        id: crypto.randomUUID(),
        traceId: crypto.randomUUID(),
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

  // 5. 提交最终处置结论
  // 5. 提交最终处置结论
  fastify.post(
    '/records/:id/disposition',
    {
      schema: {
        params: MRBParamsSchema,
        body: DispositionBodySchema,
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof MRBParamsSchema>;
      const body = DispositionBodySchema.parse(request.body ?? {});
      const operator = operatorOf(request);
      const securityCtx = await buildRequestSecurityContext(request, container);

      const record = await mrbReviews.findById(id);
      if (!record) {
        throw new NotFoundError(`MRB记录不存在: ${id}`);
      }

      const material = await container.repositories.masterData.findMaterialByCode(record.materialCode);
      const categoryCode = material?.categoryCode ?? 'STANDARD_PARTS';

      securityCtx.assertAccess({
        targetCategory: categoryCode,
        targetMaterialCode: record.materialCode,
        operationName: '提交MRB最终处置结论',
      });

      const reason = body.dispositionReason || body.reason || body.dispositionNotes || '多方会签评审确认处置方式';
      const updated = await container.useCases.decideMrbDisposition.execute(
        {
          mrbId: id,
          disposition: body.disposition,
          dispositionReason: reason,
          concessionAttachmentUrl: body.concessionAttachmentUrl || record.concessionAttachmentUrl || (body.disposition === 'CONCESSION' ? '/attachments/concession_signed.pdf' : undefined),
          operatorId: operator.userId,
          operatorName: operator.userName,
        },
        securityCtx
      );

      return reply.status(200).send(updated);
    }
  );
};
