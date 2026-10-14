import type { FastifyRequest } from 'fastify';
// Node 14 没有全局 crypto 对象（WebCrypto 全局是 Node 18+），randomUUID 必须显式导入，
// 否则在客户 2008 R2 的 Node 14 运行时抛 ReferenceError（2026-10-14 设备管理上线实测踩中）
import { randomUUID } from 'node:crypto';
import type { AuditAction, AuditStatus } from '@letian/contracts';
import type { IUnitOfWork } from '@letian/application';
import { operatorOf } from './operator';
import { requestTraceId } from './trace';

export interface DbAuditLogInput {
  action: AuditAction;
  resourceType: string;
  resourceId: string;
  diffPatch?: Record<string, unknown>;
  status?: AuditStatus;
  /** 覆盖默认操作人（默认取当前登录用户） */
  userId?: string;
  userName?: string;
}

/**
 * 向 PostgreSQL 的 audit_logs（append-only）写入一条审计流水。
 *
 * 与 use-case 内部的 ctx.auditLogs.insert 等价，区别只是调用点在没有对应用例的
 * 读侧/配置类接口上（例如集成配置变更、手动同步触发）。
 * 单独开一个事务执行，是为了不与调用方的业务事务互相影响。
 */
export async function appendDbAuditLog(
  uow: IUnitOfWork,
  request: FastifyRequest,
  input: DbAuditLogInput
): Promise<void> {
  const operator = operatorOf(request);

  await uow.execute(async (ctx) => {
    await ctx.auditLogs.insert({
      id: randomUUID(),
      traceId: requestTraceId(request),
      userId: input.userId ?? operator.userId,
      userName: input.userName ?? operator.userName,
      action: input.action,
      resourceType: input.resourceType,
      resourceId: input.resourceId,
      status: input.status ?? 'SUCCESS',
      ...(input.diffPatch !== undefined ? { diffPatch: input.diffPatch } : {}),
      createdAt: new Date().toISOString(),
    });
  });
}
