import type {
  InspectionPlan as InspectionPlanDTO,
  InspectionPlanItem as InspectionPlanItemDTO,
} from '@letian/contracts';
import {
  InspectionPlan,
  formatInspectionPlanCode,
  INSPECTION_PLAN_CODE_PREFIX,
  toLocalDayKey,
} from '@letian/domain';
import { ValidationFailedError } from '../../errors/application-error.js';
import type { ISecurityContext } from '../../security/security-context.js';
import type { IUnitOfWork } from '../../tx/unit-of-work.js';

export interface CreatePlanCommand extends Omit<InspectionPlanDTO, 'planCode'> {
  /**
   * 方案编码。留空时由服务端按 `QP-{YYYYMMDD}-{NNN}` 取号
   * （见 @letian/domain 的 inspection-plan-number；调用方指定的语义化编码如 `QP-IQC-304SS` 仍然合法）
   */
  planCode?: string;
  categoryName?: string;
  initialVersionNo?: string;
  initialItems: InspectionPlanItemDTO[];
  samplingScheme?: string;
  aqlLevel?: string;
  strictness?: string;
  effectiveStartDate?: string;
  effectiveEndDate?: string;
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
        targetCategory: cmd.categoryName ?? cmd.categoryId ?? "*",
        targetMaterialCode: cmd.materialCode ?? "*",
      });
    }

    return await this.uow.execute(async (ctx) => {
      const planId = crypto.randomUUID();
      // 方案编码：调用方未指定时由服务端取号。取号在同一 UoW 事务内原子完成，
      // 并发建方案不重号、事务回滚则流水号一并回滚（见迁移 017）。
      // new Date() 只取一次：否则跨零点时"日期段"与"流水号键"会落到不同的日子上。
      const dayKey = toLocalDayKey(new Date());
      const planCode =
        cmd.planCode !== undefined && cmd.planCode.trim() !== ''
          ? cmd.planCode.trim()
          : formatInspectionPlanCode(
              dayKey,
              await ctx.inspectionPlans.allocatePlanCodeSequence(
                INSPECTION_PLAN_CODE_PREFIX,
                dayKey
              )
            );
      const plan = new InspectionPlan({
        id: planId,
        planCode,
        planName: cmd.planName,
        materialCode: cmd.materialCode ?? undefined,
        categoryCode: cmd.categoryCode ?? undefined,
        materialCategory: cmd.categoryName ?? cmd.categoryId ?? "GENERAL",
        inspectionType: cmd.inspectionType,
        ...(cmd.inspectionTypes !== undefined ? { inspectionTypes: cmd.inspectionTypes } : {}),
      });

      // 创建首个版本并直接启用（产品口径：方案不再走「草稿 → 审批」链路，
      // 不合适的方案由用户在方案列表直接「停用」）。
      // activateVersion 内部含空指标项守门（PLAN_ACTIVE_EMPTY_ITEMS）与单激活态保证。
      const versionId = crypto.randomUUID();
      const versionNo = cmd.initialVersionNo ?? 'V1.0';
      try {
        plan.createDraftVersion({
          id: versionId,
          versionNo,
          items: cmd.initialItems,
          ...(cmd.samplingScheme !== undefined ? { samplingScheme: cmd.samplingScheme } : {}),
          ...(cmd.aqlLevel !== undefined ? { aqlLevel: cmd.aqlLevel } : {}),
          ...(cmd.strictness !== undefined ? { strictness: cmd.strictness } : {}),
          ...(cmd.effectiveStartDate !== undefined
            ? { effectiveStartDate: cmd.effectiveStartDate }
            : {}),
          ...(cmd.effectiveEndDate !== undefined ? { effectiveEndDate: cmd.effectiveEndDate } : {}),
          createdBy: cmd.createdBy,
        });
      } catch (err: unknown) {
        // 领域规则（PLAN_EMPTY_ITEMS 空指标项 / PLAN_DRAFT_ALREADY_EXISTS 重复草稿）是调用方口径问题，
        // 必须收敛为契约错误字典内的 validation-failed（400），不得冒成 500 系统内部异常
        const msg = err instanceof Error ? err.message : String(err);
        throw new ValidationFailedError(msg, [{ name: 'versions', reason: msg }]);
      }
      plan.activateVersion(versionId);

      await ctx.inspectionPlans.save(plan.toDTO());

      // 写入 Outbox 事件
      await ctx.outbox.append({
        id: crypto.randomUUID(),
        aggregateType: 'InspectionPlan',
        aggregateId: planId,
        eventType: 'INSPECTION_PLAN_CREATED',
        payload: {
          planId,
          planCode,
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
          planCode,
          materialCode: cmd.materialCode,
          categoryCode: cmd.categoryCode ?? null,
          inspectionType: cmd.inspectionType,
          inspectionTypes: cmd.inspectionTypes ?? [cmd.inspectionType],
          versionNo,
        },
        createdAt: new Date().toISOString(),
      });

      return plan.toDTO();
    });
  }
}
