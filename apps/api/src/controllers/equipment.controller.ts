import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import {
  CreateEquipmentRequestSchema,
  EquipmentListQuerySchema,
  EquipmentListResponseSchema,
} from '@letian/contracts';
import type { ApiContainer } from '../container';
import type { CreateEquipmentInput } from '@letian/infrastructure';
import { appendDbAuditLog } from '../lib/audit-log';

/** 空串/纯空白 → undefined（表单字段「不强制填写」的服务端口径） */
function toClean(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === '' ? undefined : trimmed;
}

/** 请求体 → 仓储入参：全部可选，落库前去掉空白值 */
function normalizeCreateBody(body: z.infer<typeof CreateEquipmentRequestSchema>): CreateEquipmentInput {
  const name = toClean(body.name);
  const model = toClean(body.model);
  const factorySerialNo = toClean(body.factorySerialNo);
  const equipmentType = toClean(body.equipmentType);
  const workshop = toClean(body.workshop);
  const status = toClean(body.status);
  const purchaseDate = toClean(body.purchaseDate);
  const warrantyPeriod = toClean(body.warrantyPeriod);
  return {
    ...(name !== undefined ? { name } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(factorySerialNo !== undefined ? { factorySerialNo } : {}),
    ...(equipmentType !== undefined ? { equipmentType } : {}),
    ...(workshop !== undefined ? { workshop } : {}),
    ...(status !== undefined ? { status } : {}),
    ...(purchaseDate !== undefined ? { purchaseDate } : {}),
    ...(warrantyPeriod !== undefined ? { warrantyPeriod } : {}),
  };
}

/**
 * 设备管理控制器（系统管理 → 设备管理，迁移 049）。
 *
 * 轻量路径：列表 + 新增直达仓储（与存货分类同口径），写后补一条 append-only 审计。
 * 编码（000001 起 6 位顺序码）由仓储在事务内原子发号，请求体不接受编码字段。
 */
export const equipmentController: FastifyPluginAsync<{ container: ApiContainer }> = async (
  fastify,
  options
) => {
  const { container } = options;
  const equipmentRepo = container.repositories.equipment;

  // 1. 设备台账列表（分页 + 关键字 / 状态 / 车间筛选）
  fastify.get(
    '/',
    {
      schema: {
        querystring: EquipmentListQuerySchema,
        response: { 200: EquipmentListResponseSchema },
      },
    },
    async (request, reply) => {
      const query = request.query as z.infer<typeof EquipmentListQuerySchema>;
      const result = await equipmentRepo.list({
        page: query.page,
        pageSize: query.pageSize,
        ...(query.keyword !== undefined ? { keyword: query.keyword } : {}),
        ...(query.status !== undefined ? { status: query.status } : {}),
        ...(query.workshop !== undefined ? { workshop: query.workshop } : {}),
      });
      return reply.status(200).send({
        total: result.total,
        page: query.page,
        pageSize: query.pageSize,
        items: result.items,
        list: result.list,
      });
    }
  );

  // 2. 新增设备：服务端自动发号（000001 起），字段全部可选
  fastify.post(
    '/',
    { schema: { body: CreateEquipmentRequestSchema } },
    async (request, reply) => {
      const body = request.body as z.infer<typeof CreateEquipmentRequestSchema>;
      const input = normalizeCreateBody(body);
      const created = await equipmentRepo.create(input);
      await appendDbAuditLog(container.uow, request, {
        action: 'CREATE',
        resourceType: 'EQUIPMENT',
        resourceId: created.equipmentCode,
        diffPatch: { ...input },
      });
      return reply.status(201).send(created);
    }
  );
};
