import { MaterialPermission } from '@letian/contracts';

/**
 * 供应商维度判定模式
 *
 * - `ENFORCE`（默认，全仓既有行为）：规则限定了具体供应商时，目标必须具备可核对的供应商上下文，
 *   否则该规则不匹配（fail-closed，防 fail-open）；
 * - `NOT_APPLICABLE`：**被判定对象自身不具备供应商属性**时使用（如质检方案 / 检验标准等
 *   "方案域"对象：方案表无 supplier_code 列，业务上标准也不分供应商）。此时供应商维度不参与判定：
 *   规则的三维里只核对物料分类 + 物料编码，命中即放行 ——
 *   "仅限定供应商"（分类与编码均通配）的规则在该模式下等价于物料维度全通配。
 *
 * 口径见 docs/42-质检方案域PBAC供应商维度错配修复设计.md §3。
 */
export type SupplierDimensionMode = 'ENFORCE' | 'NOT_APPLICABLE';

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
 *      传入 supplierDimension='NOT_APPLICABLE'（对象无供应商属性）时该维度不参与判定。
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
    supplierDimension?: SupplierDimensionMode;
  }): boolean {
    return this.findMatchingRule(params) !== null;
  }

  /**
   * 返回第一条命中的生效规则（权限校验工具需要展示"命中了哪条规则"）。
   * 判定语义与 hasPermission 完全一致：任一启用 policy 匹配即返回该 policy，否则 null。
   */
  public static findMatchingRule(params: {
    permissions: readonly MaterialPermission[];
    targetCategory: string;
    targetMaterialCode: string;
    targetSupplierCode?: string;
    supplierDimension?: SupplierDimensionMode;
  }): MaterialPermission | null {
    const { permissions, targetCategory, targetMaterialCode, targetSupplierCode } = params;
    const supplierDimension = params.supplierDimension ?? 'ENFORCE';

    if (!permissions || permissions.length === 0) {
      return null;
    }

    for (const policy of permissions) {
      // 0. 跳过已停用的权限策略（isActive=false 不授予任何访问权）
      if (policy.isActive === false) {
        continue;
      }

      // 1. 评估物料分类维度
      const categoryMatched =
        policy.materialCategories.length === 0 ||
        policy.materialCategories.includes('*') ||
        policy.materialCategories.includes(targetCategory);

      if (!categoryMatched) {
        continue;
      }

      // 2. 评估物料编码维度
      const codeMatched =
        policy.materialCodes.length === 0 ||
        policy.materialCodes.includes('*') ||
        policy.materialCodes.includes(targetMaterialCode);

      if (!codeMatched) {
        continue;
      }

      // 3. 评估供应商维度
      //    对象无供应商属性（方案域）时该维度不适用：分类 + 编码命中即视为匹配
      if (supplierDimension === 'NOT_APPLICABLE') {
        return policy;
      }

      const hasSupplierWildcard =
        policy.supplierCodes.length === 0 || policy.supplierCodes.includes('*');
      const targetHasSupplier = targetSupplierCode !== undefined && targetSupplierCode.trim() !== '';

      if (hasSupplierWildcard) {
        return policy;
      }

      // policy 限定了具体供应商：目标必须具备可核对的供应商上下文，否则该 policy 不匹配（拒绝，避免 fail-open）
      if (!targetHasSupplier) {
        continue;
      }

      if (policy.supplierCodes.includes(targetSupplierCode as string)) {
        return policy;
      }
    }

    return null;
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
