import type { InspectionPlan as InspectionPlanDTO } from '@letian/contracts';
import { InspectionPlan } from '@letian/domain';
import { ApplicationError } from '../../errors/application-error.js';
import type { ISecurityContext } from '../../security/security-context.js';
import type { IUnitOfWork } from '../../tx/unit-of-work.js';

export interface TogglePlanVersionCommand {
  planId: string;
  versionId: string;
  action: 'ACTIVATE' | 'DEACTIVATE';
  operatorId: string;
}

/**
 * 方案启停用例
 */
export class TogglePlanVersionUseCase {
  constructor(private readonly uow: IUnitOfWork) {}

  public async execute(
    cmd: TogglePlanVersionCommand,
    securityCtx?: ISecurityContext
  ): Promise<InspectionPlanDTO> {
    return await this.uow.execute(async (ctx) => {
      const planDto = await ctx.inspectionPlans.findById(cmd.planId);
      if (!planDto) {
        throw new ApplicationError('PLAN_NOT_FOUND', `未找到质检方案 [${cmd.planId}]`, 404);
      }

      // 包装为 domain 聚合以执行版本启停状态机行为
      const plan = new InspectionPlan({
        id: planDto.id ?? cmd.planId,
        planCode: planDto.planCode,
        planName: planDto.planName,
        materialCode: planDto.materialCode,
        materialCategory: 'STANDARD_PARTS',
        inspectionType: planDto.inspectionType,
        versions: planDto.versions ? [...planDto.versions] : [],
      });

      if (securityCtx) {
        securityCtx.assertAccess({
          targetCategory: plan.getMaterialCategory(),
          targetMaterialCode: plan.getMaterialCode(),
        });
      }

      try {
        if (cmd.action === 'ACTIVATE') {
          plan.activateVersion(cmd.versionId);
        } else {
          plan.deactivateVersion(cmd.versionId);
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new ApplicationError('PLAN_TOGGLE_FAILED', msg, 400);
      }

      await ctx.inspectionPlans.save(plan.toDTO());

      await ctx.outbox.append({
        id: crypto.randomUUID(),
        aggregateType: 'InspectionPlan',
        aggregateId: plan.getId(),
        eventType:
          cmd.action === 'ACTIVATE'
            ? 'INSPECTION_PLAN_ACTIVATED'
            : 'INSPECTION_PLAN_DEACTIVATED',
        payload: {
          planId: plan.getId(),
          versionId: cmd.versionId,
          action: cmd.action,
          operatorId: cmd.operatorId,
        },
        traceId: securityCtx?.traceId ?? crypto.randomUUID(),
        occurredAt: new Date(),
        status: 'PENDING',
        retryCount: 0,
      });

      return plan.toDTO();
    });
  }
}
