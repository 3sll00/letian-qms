import { InspectionPlan, InspectionPlanVersion } from '@letian/contracts';

/**
 * 质检方案继承解析服务 (PlanInheritanceResolver)
 * 优先级：
 * 1. 物料特定方案（materialCode 精确匹配且有效周期内处于 ACTIVE 态）；
 * 2. 存货分类共享方案（categoryId 匹配且有效周期内处于 ACTIVE 态）；
 * 3. 若均不存在，返回 null。
 */
export class PlanInheritanceResolver {
  public static resolveEffectivePlan(params: {
    materialCode: string;
    categoryId?: string;
    plans: readonly InspectionPlan[];
    targetDateIso?: string;
  }): {
    plan: InspectionPlan;
    activeVersion: InspectionPlanVersion;
    inheritedFrom: 'MATERIAL' | 'CATEGORY';
  } | null {
    const { materialCode, categoryId, plans, targetDateIso } = params;
    const targetTimestamp = targetDateIso ? new Date(targetDateIso).getTime() : Date.now();

    const isVersionDateValid = (v: InspectionPlanVersion): boolean => {
      if (v.effectiveStartDate && new Date(v.effectiveStartDate).getTime() > targetTimestamp) {
        return false;
      }
      if (v.effectiveEndDate && new Date(v.effectiveEndDate).getTime() < targetTimestamp) {
        return false;
      }
      return true;
    };

    // 1. 精确物料匹配
    const materialPlan = plans.find(p => 
      p.materialCode === materialCode && 
      p.versions && 
      p.versions.some(v => v.status === 'ACTIVE' && isVersionDateValid(v))
    );

    if (materialPlan && materialPlan.versions) {
      const activeVersion = materialPlan.versions.find(v => v.status === 'ACTIVE' && isVersionDateValid(v))!;
      return {
        plan: materialPlan,
        activeVersion,
        inheritedFrom: 'MATERIAL'
      };
    }

    // 2. 分类共享匹配
    if (categoryId) {
      const categoryPlan = plans.find(p =>
        p.categoryId === categoryId &&
        (!p.materialCode || p.materialCode.trim() === '') &&
        p.versions &&
        p.versions.some(v => v.status === 'ACTIVE' && isVersionDateValid(v))
      );

      if (categoryPlan && categoryPlan.versions) {
        const activeVersion = categoryPlan.versions.find(v => v.status === 'ACTIVE' && isVersionDateValid(v))!;
        return {
          plan: categoryPlan,
          activeVersion,
          inheritedFrom: 'CATEGORY'
        };
      }
    }

    return null;
  }
}
