import type {
  InspectionPlan as InspectionPlanDTO,
  InspectionPlanItem as InspectionPlanItemDTO,
  InspectionPlanVersion as InspectionPlanVersionDTO,
} from '@letian/contracts';
import { InspectionPlan, nextInspectionPlanVersionNo } from '@letian/domain';
import { ApplicationError, ValidationFailedError } from '../../errors/application-error.js';
import type { ISecurityContext } from '../../security/security-context.js';
import type { IUnitOfWork } from '../../tx/unit-of-work.js';

export interface UpgradePlanVersionCommand {
  /** 方案版本行 UUID（仓储 `findById` 会先按版本行命中、再聚合该 plan_code 的全部版本） */
  planId: string;
  /** 模板版本行 UUID：省略的指标项与抽样参数一律取自该版本行 */
  versionId: string;
  /**
   * 新版本号。省略时按领域规则 `nextInspectionPlanVersionNo` 在现有最大版本号上自动升位
   * （如 v2.5 → v2.6），口径与 `plan_code` 服务端取号（TBD-11）完全对称。
   */
  newVersionNo?: string;
  /** 省略即沿用模板版本行的指标项 */
  items?: InspectionPlanItemDTO[];
  samplingScheme?: string;
  aqlLevel?: string;
  strictness?: string;
  /** 生效周期**不继承**模板版本行：省略即长期有效（照抄旧周期会让新草稿「出生即过期」） */
  effectiveStartDate?: string;
  effectiveEndDate?: string;
  createdBy: string;
}

/**
 * 方案升版用例（以指定版本行为模板，为新版本创建一个草稿）
 *
 * 与 `CreatePlanUseCase` 同口径：领域规则（`PLAN_EMPTY_ITEMS` 空指标项 /
 * `PLAN_DRAFT_ALREADY_EXISTS` 已有草稿）属调用方口径问题，必须收敛为 400 `validation-failed`，
 * 不得冒成 500 系统内部异常。
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
        // 错误码一律小写短横线（契约约定：code 用于拼装合法的 RFC 7807 type URI）
        throw new ApplicationError('plan-not-found', `未找到质检方案 [${cmd.planId}]`, 404);
      }

      // 从物料主数据解析真实分类；查不到时 UNKNOWN 不命中任何白名单（fail-closed）
      const material = await ctx.materials.getMaterialByCode(planDto.materialCode ?? "");
      const materialCategory = material?.categoryCode ?? 'UNKNOWN';

      // 包装为 domain 聚合以执行版本升版行为
      const plan = new InspectionPlan({
        id: planDto.id ?? cmd.planId,
        planCode: planDto.planCode,
        planName: planDto.planName,
        materialCode: planDto.materialCode ?? undefined,
        materialCategory,
        inspectionType: planDto.inspectionType,
        versions: planDto.versions ? [...planDto.versions] : [],
      });

      if (securityCtx) {
        securityCtx.assertAccess({
          targetCategory: plan.getMaterialCategory() ?? "*",
          targetMaterialCode: plan.getMaterialCode() ?? "*",
        });
      }

      const versions: InspectionPlanVersionDTO[] = planDto.versions ?? [];
      const source = versions.find((version) => version.id === cmd.versionId);
      if (!source) {
        // 模板版本行必须存在：它由 URL 唯一指定，缺失即调用方给错了版本行，不做"回退到某个版本"的猜测
        throw new ValidationFailedError(
          `PLAN_SOURCE_VERSION_NOT_FOUND: 方案 [${planDto.planCode}] 不存在版本行 [${cmd.versionId}]`,
          [{ name: 'versionId', reason: 'URL 指定的版本行不属于该方案' }]
        );
      }

      // 版本号：省略即服务端升位（与 plan_code 取号同口径，见 docs/17 §7.5.7 / §7.5.8）
      const explicitVersionNo = cmd.newVersionNo?.trim();
      const versionNo =
        explicitVersionNo !== undefined && explicitVersionNo !== ''
          ? explicitVersionNo
          : nextInspectionPlanVersionNo(versions.map((version) => version.versionNo));

      // 指标项与抽样参数：省略即沿用模板版本行；生效周期**不**继承（见命令字段注释）
      const items = cmd.items ?? source.items;
      const samplingScheme = cmd.samplingScheme ?? source.samplingScheme;
      const aqlLevel = cmd.aqlLevel ?? source.aqlLevel;
      const strictness = cmd.strictness ?? source.strictness;

      const versionId = crypto.randomUUID();
      try {
        plan.createDraftVersion({
          id: versionId,
          versionNo,
          items,
          ...(samplingScheme !== undefined ? { samplingScheme } : {}),
          ...(aqlLevel !== undefined ? { aqlLevel } : {}),
          ...(strictness !== undefined ? { strictness } : {}),
          ...(cmd.effectiveStartDate !== undefined
            ? { effectiveStartDate: cmd.effectiveStartDate }
            : {}),
          ...(cmd.effectiveEndDate !== undefined ? { effectiveEndDate: cmd.effectiveEndDate } : {}),
          createdBy: cmd.createdBy,
        });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new ValidationFailedError(msg, [{ name: 'versions', reason: msg }]);
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
          sourceVersionNo: source.versionNo,
          newVersionNo: versionNo,
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
