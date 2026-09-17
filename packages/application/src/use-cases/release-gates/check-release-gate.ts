import type { MandatoryGateCheckResponse } from '@letian/contracts';
import { ApplicationError } from '../../errors/application-error.js';
import type { ISecurityContext } from '../../security/security-context.js';
import type { IUnitOfWork } from '../../tx/unit-of-work.js';

export interface CheckReleaseGateCommand {
  batchNo: string;
  gateType?: 'PROCESS_TRANSFER' | 'OUTBOUND_SHIPMENT';
  operatorId: string;
  operatorName?: string;
}

/**
 * 强制放行关卡校验用例 (Mandatory Release Gate Check)
 * 
 * 关键规则与约束：
 * 1. 并发互斥保护：进入 Unit of Work 必须调用 ctx.locks.acquireXactLock(batchNo) 获取 PostgreSQL 事务级咨询排他锁 (pg_advisory_xact_lock)；
 * 2. 状态机严格校验：
 *    - 检查该批次的所有检验工单；
 *    - 工单必须处于已完成终态（COMPLETED）；
 *    - 终判结论必须为 PASSED 或 让步特采通过（MRB 处置为 CONCESSION 且流程归档已完成）；
 *    - 存在未完成、检验不合格且未获特采批准、或尚在 MRB 流程中的工单，直接判定放行失败并阻断；
 * 3. 审计日志与 Outbox：
 *    - 放行通过或阻断均记录审计日志 (action: 'STATUS_CHANGE' 或 'GATE_BLOCKED')；
 *    - 阻断时如由强制拦截模式触发，可抛出 422 GATE_BLOCKED ApplicationError 或返回结构化放行阻断响应。
 */
export class CheckReleaseGateUseCase {
  constructor(private readonly uow: IUnitOfWork) {}

  public async execute(
    cmd: CheckReleaseGateCommand,
    securityCtx?: ISecurityContext
  ): Promise<MandatoryGateCheckResponse> {
    return await this.uow.execute(async (ctx) => {
      // 1. 获取 PostgreSQL 事务级咨询排他锁 (pg_advisory_xact_lock)
      await ctx.locks.acquireXactLock(`RELEASE_GATE_${cmd.batchNo}`);

      // 2. 查询批次关联的所有检验单
      const orders = await ctx.inspectionOrders.findByBatchNo(cmd.batchNo);
      if (!orders || orders.length === 0) {
        // 记录拦截审计
        await ctx.auditLogs.insert({
          traceId: securityCtx?.traceId ?? crypto.randomUUID(),
          userId: cmd.operatorId,
          userName: cmd.operatorName ?? '系统操作员',
          action: 'GATE_BLOCKED',
          resourceType: 'RELEASE_GATE',
          resourceId: cmd.batchNo,
          status: 'REJECTED',
          diffPatch: { reason: '未找到批次对应的检验工单，禁止放行' },
          createdAt: new Date().toISOString(),
        });

        throw new ApplicationError(
          'RELEASE_GATE_BLOCKED',
          `批次 [${cmd.batchNo}] 无任何检验工单记录，严禁放行`,
          422
        );
      }

      // 3. PBAC 数据权限隔离校验
      if (securityCtx) {
        const firstOrder = orders[0];
        if (firstOrder) {
          securityCtx.assertAccess({
            targetCategory: 'STANDARD_PARTS',
            targetMaterialCode: firstOrder.materialCode,
            ...(firstOrder.supplierCode !== undefined
              ? { targetSupplierCode: firstOrder.supplierCode }
              : {}),
          });
        }
      }

      // 4. 校验所有工单状态与判定结果
      let allowNextStep = true;
      let reason: string | undefined = undefined;
      let latestStatus = orders[0]!.status;

      for (const order of orders) {
        const status = order.status;
        const decision = order.overallDecision;
        latestStatus = status;

        if (status !== 'COMPLETED') {
          allowNextStep = false;
          reason = `批次工单 [${order.orderNo}] 处于未完成状态 [${status}]，禁止放行`;
          break;
        }

        if (decision === 'FAILED') {
          // 检查是否有对应的 MRB 评审处置通过（例如让步接收 CONCESSION）
          const mrb = await ctx.mrbReviews.findByOrderNo(order.orderNo);
          if (!mrb || mrb.status !== 'DISPOSED' || mrb.disposition !== 'CONCESSION') {
            allowNextStep = false;
            reason = `批次工单 [${order.orderNo}] 检验不合格，且无生效让步接收(CONCESSION)特采单`;
            break;
          }
        }
      }

      // 5. 写入审计日志与 Outbox 领域事件
      const traceId = securityCtx?.traceId ?? crypto.randomUUID();
      if (!allowNextStep) {
        await ctx.auditLogs.insert({
          traceId,
          userId: cmd.operatorId,
          userName: cmd.operatorName ?? '系统操作员',
          action: 'GATE_BLOCKED',
          resourceType: 'RELEASE_GATE',
          resourceId: cmd.batchNo,
          status: 'REJECTED',
          diffPatch: { reason, gateType: cmd.gateType ?? 'OUTBOUND_SHIPMENT' },
          createdAt: new Date().toISOString(),
        });

        await ctx.outbox.append({
          id: crypto.randomUUID(),
          aggregateType: 'ReleaseGate',
          aggregateId: cmd.batchNo,
          eventType: 'RELEASE_GATE_BLOCKED',
          payload: {
            batchNo: cmd.batchNo,
            gateType: cmd.gateType ?? 'OUTBOUND_SHIPMENT',
            reason,
          },
          traceId,
          occurredAt: new Date(),
          status: 'PENDING',
          retryCount: 0,
        });

        const res: MandatoryGateCheckResponse = {
          batchNo: cmd.batchNo,
          isPassed: false,
          status: latestStatus,
          mandatoryGate: true,
          allowNextStep: false,
        };
        if (reason !== undefined) {
          res.reason = reason;
        }
        return res;
      }

      // 放行通过
      await ctx.auditLogs.insert({
        traceId,
        userId: cmd.operatorId,
        userName: cmd.operatorName ?? '系统操作员',
        action: 'STATUS_CHANGE',
        resourceType: 'RELEASE_GATE',
        resourceId: cmd.batchNo,
        status: 'SUCCESS',
        diffPatch: { allowNextStep: true, gateType: cmd.gateType ?? 'OUTBOUND_SHIPMENT' },
        createdAt: new Date().toISOString(),
      });

      await ctx.outbox.append({
        id: crypto.randomUUID(),
        aggregateType: 'ReleaseGate',
        aggregateId: cmd.batchNo,
        eventType: 'RELEASE_GATE_PASSED',
        payload: {
          batchNo: cmd.batchNo,
          gateType: cmd.gateType ?? 'OUTBOUND_SHIPMENT',
          operatorId: cmd.operatorId,
        },
        traceId,
        occurredAt: new Date(),
        status: 'PENDING',
        retryCount: 0,
      });

      const res: MandatoryGateCheckResponse = {
        batchNo: cmd.batchNo,
        isPassed: true,
        status: latestStatus,
        mandatoryGate: true,
        allowNextStep: true,
      };
      return res;
    });
  }
}
