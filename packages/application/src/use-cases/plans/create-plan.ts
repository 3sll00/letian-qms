import type {
  InspectionPlan as InspectionPlanDTO,
  InspectionPlanItem as InspectionPlanItemDTO,
} from '@letian/contracts';
import { InspectionPlan } from '@letian/domain';
import type { ISecurityContext } from '../../security/security-context.js';
import type { IUnitOfWork } from '../../tx/unit-of-work.js';

export interface CreatePlanCommand extends InspectionPlanDTO {
  materialCategory: string;
  initialVersionNo?: string;
  initialItems: InspectionPlanItemDTO[];
  samplingScheme?: string;
  aqlLevel?: string;
  strictness?: string;
  createdBy: string;
  /** 审计日志展示用操作人姓名，缺省时用 createdBy */
  operatorName?: string;
}

/**
 * 方案创建用例
 */
export class CreatePlanUseCase {
  constructor(private readonly uow: IUnitOfWork) {}

  public async execute(cmd: CreatePlanCommand, securityCtx?: ISecurityContext): Promise<InspectionPlanDTO> {
    if (securityCtx) {
      securityCtx.assertAccess({
        targetCategory: cmd.materialCategory,
        targetMaterialCode: cmd.materialCode,
      });
    }

    return await this.uow.execute(async (ctx) => {
      const planId = crypto.randomUUID();
      const plan = new InspectionPlan({
        id: planId,
        planCode: cmd.planCode,
        planName: cmd.planName,
        materialCode: cmd.materialCode,
        materialCategory: cmd.materialCategory,
        inspectionType: cmd.inspectionType,
      });

      // 创建初始草稿版本
      const versionId = crypto.randomUUID();
      const versionNo = cmd.initialVersionNo ?? 'V1.0';
      plan.createDraftVersion({
        id: versionId,
        versionNo,
        items: cmd.initialItems,
        ...(cmd.samplingScheme !== undefined ? { samplingScheme: cmd.samplingScheme } : {}),
        ...(cmd.aqlLevel !== undefined ? { aqlLevel: cmd.aqlLevel } : {}),
        ...(cmd.strictness !== undefined ? { strictness: cmd.strictness } : {}),
        createdBy: cmd.createdBy,
      });

      await ctx.inspectionPlans.save(plan.toDTO());

      // 写入 Outbox 事件
      await ctx.outbox.append({
        id: crypto.randomUUID(),
        aggregateType: 'InspectionPlan',
        aggregateId: planId,
        eventType: 'INSPECTION_PLAN_CREATED',
        payload: {
          planId,
          planCode: cmd.planCode,
          materialCode: cmd.materialCode,
          versionNo,
        },
        traceId: securityCtx?.traceId ?? crypto.randomUUID(),
        occurredAt: new Date(),
        status: 'PENDING',
        retryCount: 0,
      });

      // 写入不可变审计日志
      // （与其余用例一致：方案库的新增属于关键质量配置变更，必须进入 append-only 审计流）
      await ctx.auditLogs.insert({
        id: crypto.randomUUID(),
        traceId: securityCtx?.traceId ?? crypto.randomUUID(),
        userId: cmd.createdBy,
        userName: cmd.operatorName ?? cmd.createdBy,
        action: 'CREATE',
        resourceType: 'INSPECTION_PLAN',
        resourceId: planId,
        status: 'SUCCESS',
        diffPatch: {
          planCode: cmd.planCode,
          materialCode: cmd.materialCode,
          inspectionType: cmd.inspectionType,
          versionNo,
        },
        createdAt: new Date().toISOString(),
      });

      return plan.toDTO();
    });
  }
}
