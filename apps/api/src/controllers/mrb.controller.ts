import { FastifyPluginAsync, type FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  CreateMRBReviewRequestSchema,
  SubmitNodeReviewRequestSchema,
  MRBCategoryTabEnum,
  MRBStatusEnum,
  type MRBReview,
} from '@letian/contracts';
import { NotFoundError, ConflictError } from '@letian/application';
import type { ApiContainer } from '../container';
import { operatorOf } from '../lib/operator';

const MRBQuerySchema = z.object({
  categoryTab: MRBCategoryTabEnum.default('ALL'),
  status: MRBStatusEnum.optional(),
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

  // 1. 查询 MRB 不合格评审记录列表（支持四大分类 Tab 与 KPI 统计）
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

      // KPI 统计口径固定为全量，不受页签与状态筛选影响
      const result = await mrbReviews.listMrbReviews({
        page: query.page,
        pageSize: query.pageSize,
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
  //
  // 说明：application 层的 TriggerMrbReviewUseCase 语义是"由不合格检验单自动触发"，
  // 它要求检验单必须处于 FAILED、并把检验单推进为 IN_MRB_REVIEW，与本接口
  // 契约中"自由录入来源单号 / 批次 / 缺陷描述"的语义并不一致，
  // 因此这里在同一事务内直接落库评审单 + Outbox 事件 + 审计日志，不经过该用例。
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
    body: {
      action: 'APPROVE' | 'REJECT';
      comment: string;
      roleCode?: string;
      approverName?: string;
    },
    request: FastifyRequest
  ): Promise<MRBReview> {
    const existing = await mrbReviews.findById(id);
    if (!existing) {
      throw new NotFoundError(`MRB评审记录不存在: ${id}`);
    }

    // 终态校验放在用例之前，保持 409 ConflictError 的既有对外语义
    if (existing.status === 'DISPOSED' || existing.status === 'REJECTED') {
      throw new ConflictError('该 MRB 评审流程已处置完毕或已被驳回，无法重复会签');
    }

    const operator = operatorOf(request);

    return await container.useCases.advanceMrbStep.execute({
      mrbId: id,
      action: body.action,
      operatorId: operator.userId,
      operatorRole: body.roleCode ?? operator.role,
      ...(body.approverName !== undefined ? { operatorName: body.approverName } : {}),
      ...(body.comment !== '' ? { comment: body.comment } : {}),
    });
  }

  // 3. 提交节点会签意见（契约路径）
  fastify.post(
    '/records/:id/submit-review',
    {
      schema: {
        params: MRBParamsSchema,
        body: SubmitNodeReviewRequestSchema,
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof MRBParamsSchema>;
      const body = request.body as z.infer<typeof SubmitNodeReviewRequestSchema>;

      const updated = await submitSignature(
        id,
        {
          action: body.action === 'APPROVED' ? 'APPROVE' : 'REJECT',
          comment: body.comment,
        },
        request
      );

      return reply.status(200).send(updated);
    }
  );

  // 4. 提交节点会签意见（前端会签页使用：可携带责任角色与签署人姓名）
  fastify.post(
    '/records/:id/signatures',
    {
      schema: {
        params: MRBParamsSchema,
        body: SignatureRequestSchema,
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof MRBParamsSchema>;
      const body = request.body as z.infer<typeof SignatureRequestSchema>;

      const updated = await submitSignature(
        id,
        {
          action: body.action.startsWith('APPROVE') ? 'APPROVE' : 'REJECT',
          comment: body.comment,
          ...(body.roleCode !== undefined ? { roleCode: body.roleCode } : {}),
          ...(body.approverName !== undefined ? { approverName: body.approverName } : {}),
        },
        request
      );

      return reply.status(200).send(updated);
    }
  );
};
