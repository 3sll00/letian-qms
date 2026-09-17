import type {
  InspectionPlan as InspectionPlanDTO,
  InspectionPlanVersion as InspectionPlanVersionDTO,
} from '@letian/contracts';
import { InspectionPlan } from '@letian/domain';
import { ApplicationError } from '../../errors/application-error.js';
import type { ISecurityContext } from '../../security/security-context.js';
import type { IUnitOfWork } from '../../tx/unit-of-work.js';

export interface UpgradePlanVersionCommand extends Partial<InspectionPlanVersionDTO> {
  planId: string;
  newVersionNo: string;
  items: InspectionPlanVersionDTO['items'];
  aqlRule?: Record<string, unknown>;
  createdBy: string;
}

/**
 * 方案升版用例 (创建新草稿版本)
 */
export class UpgradePlanVersionUseCase {
  constructor(private readonly uow: IUnitOfWork) {}

  public async execute(
    cmd: UpgradePlanVersionCommand,
    securityCtx?: ISecurityContext
  ): Promise<InspectionPlanDTO> {
    return await this.uow.execute(async (ctx) => {
      const planDto = await ctx.inspectionPlans.findById(cmd.planId);
      if (!planDto) {
        throw new ApplicationError('PLAN_NOT_FOUND', `未找到质检方案 [${cmd.planId}]`, 404);
      }

      // 包装为 domain 聚合以执行版本升版行为
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

      const versionId = crypto.randomUUID();
      try {
        plan.createDraftVersion({
          id: versionId,
          versionNo: cmd.newVersionNo,
          items: cmd.items,
          createdBy: cmd.createdBy,
        });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new ApplicationError('PLAN_UPGRADE_FAILED', msg, 400);
      }

      await ctx.inspectionPlans.save(plan.toDTO());

      await ctx.outbox.append({
        id: crypto.randomUUID(),
        aggregateType: 'InspectionPlan',
        aggregateId: plan.getId(),
        eventType: 'INSPECTION_PLAN_UPGRADED',
        payload: {
          planId: plan.getId(),
          planCode: plan.getPlanCode(),
          newVersionNo: cmd.newVersionNo,
          newVersionId: versionId,
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
