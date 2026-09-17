import { MaterialPermission } from '@letian/contracts';

/**
 * PBAC 三维行级数据权限评估器 (PBACEvaluator)
 * 纯内存无状态领域服务，对用户拥有的权限策略执行判定：
 * 
 * 三维规则评估逻辑：
 * 1. 若 permissions 为空或被停用（isActive=false），默认拒绝访问；
 * 2. 任意一条启用的 policy 匹配则通过（OR 逻辑关系）；
 * 3. 单条 policy 内部的三维约束满足如下准入要求（空数组或包含 '*' 视为通配放行）：
 *    - materialCategories: 包含目标分类或通配；
 *    - materialCodes: 包含目标编码或通配；
 *    - supplierCodes: 仅当待判定对象具备供应商上下文（targetSupplierCode 非空）时执行包含判定；
 *      若 policy 限定具体供应商而目标无供应商上下文，则该 policy 不匹配（拒绝）。
 */
export class PBACEvaluator {
  /**
   * 判定用户是否具备针对特定物料/供应商上下文的访问/操作权限
   */
  public static hasPermission(params: {
    permissions: readonly MaterialPermission[];
    targetCategory: string;
    targetMaterialCode: string;
    targetSupplierCode?: string;
  }): boolean {
    const { permissions, targetCategory, targetMaterialCode, targetSupplierCode } = params;

    if (!permissions || permissions.length === 0) {
      return false;
    }

    return permissions.some(policy => {
      // 0. 跳过已停用的权限策略（isActive=false 不授予任何访问权）
      if (policy.isActive === false) {
        return false;
      }

      // 1. 评估物料分类维度
      const categoryMatched =
        policy.materialCategories.length === 0 ||
        policy.materialCategories.includes('*') ||
        policy.materialCategories.includes(targetCategory);

      if (!categoryMatched) {
        return false;
      }

      // 2. 评估物料编码维度
      const codeMatched =
        policy.materialCodes.length === 0 ||
        policy.materialCodes.includes('*') ||
        policy.materialCodes.includes(targetMaterialCode);

      if (!codeMatched) {
        return false;
      }

      // 3. 评估供应商维度
      const hasSupplierWildcard =
        policy.supplierCodes.length === 0 || policy.supplierCodes.includes('*');
      const targetHasSupplier = targetSupplierCode !== undefined && targetSupplierCode.trim() !== '';

      if (hasSupplierWildcard) {
        return true;
      }

      // policy 限定了具体供应商：目标必须具备可核对的供应商上下文，否则该 policy 不匹配（拒绝，避免 fail-open）
      if (!targetHasSupplier) {
        return false;
      }

      return policy.supplierCodes.includes(targetSupplierCode as string);
    });
  }

  /**
   * 严格断言权限，未授权时抛出 PBAC_ACCESS_DENIED 异常
   */
  public static assertPermission(params: {
    permissions: readonly MaterialPermission[];
    targetCategory: string;
    targetMaterialCode: string;
    targetSupplierCode?: string;
  }): void {
    if (!this.hasPermission(params)) {
      throw new Error(
        `PBAC_ACCESS_DENIED: 用户缺乏对分类 [${params.targetCategory}] / 物料 [${params.targetMaterialCode}] / 供应商 [${params.targetSupplierCode ?? 'ALL'}] 的数据访问权限`
      );
    }
  }
}
