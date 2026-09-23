import type { MaterialPermission, PermissionCheckResponse } from '@letian/contracts';
import { PBACEvaluator } from '@letian/domain';
import type { IUnitOfWork } from '../../tx/unit-of-work.js';

export interface CheckPermissionCommand {
  userId: string;
  materialCode: string;
  supplierCode?: string;
}

/**
 * 权限校验工具用例：校验某用户对特定物料/供应商上下文是否具备访问权限，
 * 返回允许与否与命中的规则（供「系统管理-物料权限管理」底部的权限校验工具使用）。
 *
 * 校验口径与运行时读侧过滤 / 写侧 SecurityContext 完全一致（同一 PBACEvaluator）。
 */
export class CheckPermissionUseCase {
  constructor(private readonly uow: IUnitOfWork) {}

  public async execute(cmd: CheckPermissionCommand): Promise<PermissionCheckResponse> {
    return await this.uow.execute(async (ctx) => {
      const permissions = await ctx.permissions.findByUserId(cmd.userId);
      const material = await ctx.materials.getMaterialByCode(cmd.materialCode);
      const category = material?.categoryCode ?? 'UNKNOWN';

      const matchedRule: MaterialPermission | null = PBACEvaluator.findMatchingRule({
        permissions,
        targetCategory: category,
        targetMaterialCode: cmd.materialCode,
        ...(cmd.supplierCode !== undefined ? { targetSupplierCode: cmd.supplierCode } : {}),
      });

      const allowed = matchedRule !== null;

      const names = new Set(permissions.map((rule) => rule.userName).filter((name) => name !== ''));
      const userName = names.size === 1 ? [...names][0]! : names.size > 1 ? [...names][0]! : '未知用户';

      const supplierText = cmd.supplierCode !== undefined ? ` / 供应商 [${cmd.supplierCode}]` : '';
      const message = allowed
        ? `允许访问：命中规则 [${matchedRule!.roleCode}]，物料 [${cmd.materialCode}]${supplierText}`
        : `拒绝访问：用户对物料分类 [${category}] / 物料 [${cmd.materialCode}]${supplierText} 无权限规则（或规则已停用）`;

      return {
        allowed,
        userId: cmd.userId,
        userName,
        materialCode: cmd.materialCode,
        ...(material?.categoryCode !== undefined ? { materialCategory: material.categoryCode } : {}),
        ...(cmd.supplierCode !== undefined ? { supplierCode: cmd.supplierCode } : {}),
        matchedRule,
        message,
      };
    });
  }
}
