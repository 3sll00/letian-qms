import { ErrorCode, type ErrorCodeType, type MaterialPermission } from '@letian/contracts';
import { PBACEvaluator, type SupplierDimensionMode } from '@letian/domain';
import { ForbiddenError } from '../errors/application-error.js';

/**
 * 经过认证的用户三维 PBAC 安全上下文
 */
export interface ISecurityContext {
  readonly userId: string;
  readonly userName: string;
  readonly userRole: string;
  readonly permissions: readonly MaterialPermission[];
  readonly traceId?: string;

  /**
   * 校验用户是否对特定物料/分类/供应商具备数据访问或操作权限
   */
  hasPermission(target: {
    targetCategory: string;
    targetMaterialCode: string;
    targetSupplierCode?: string;
    supplierDimension?: SupplierDimensionMode;
  }): boolean;

  /**
   * 严格断言权限，若未命中则抛出标准化 ForbiddenError (PBAC_PERMISSION_DENIED)
   */
  assertPermission(target: {
    targetCategory: string;
    targetMaterialCode: string;
    targetSupplierCode?: string;
    supplierDimension?: SupplierDimensionMode;
    operationName?: string;
  }): void;

  /**
   * 别名方法：保持向后兼容
   */
  assertAccess(target: {
    targetCategory: string;
    targetMaterialCode: string;
    targetSupplierCode?: string;
    supplierDimension?: SupplierDimensionMode;
    operationName?: string;
  }): void;
}

export class SecurityContext implements ISecurityContext {
  public readonly userId: string;
  public readonly userName: string;
  public readonly userRole: string;
  public readonly permissions: readonly MaterialPermission[];
  public readonly traceId?: string;

  constructor(params: {
    userId: string;
    userName: string;
    userRole: string;
    permissions: readonly MaterialPermission[];
    traceId?: string;
  }) {
    this.userId = params.userId;
    this.userName = params.userName;
    this.userRole = params.userRole;
    this.permissions = params.permissions;
    if (params.traceId !== undefined) {
      this.traceId = params.traceId;
    }
  }

  public hasPermission(target: {
    targetCategory: string;
    targetMaterialCode: string;
    targetSupplierCode?: string;
    supplierDimension?: SupplierDimensionMode;
  }): boolean {
    return PBACEvaluator.hasPermission({
      permissions: this.permissions,
      targetCategory: target.targetCategory,
      targetMaterialCode: target.targetMaterialCode,
      ...(target.targetSupplierCode !== undefined
        ? { targetSupplierCode: target.targetSupplierCode }
        : {}),
      ...(target.supplierDimension !== undefined
        ? { supplierDimension: target.supplierDimension }
        : {}),
    });
  }

  public assertPermission(target: {
    targetCategory: string;
    targetMaterialCode: string;
    targetSupplierCode?: string;
    supplierDimension?: SupplierDimensionMode;
    operationName?: string;
  }): void {
    const allowed = this.hasPermission(target);
    if (!allowed) {
      const op = target.operationName ? `操作 [${target.operationName}] ` : '';
      const errParams: { message: string; code?: ErrorCodeType; traceId?: string } = {
        message: `三维 PBAC 安全拦截: 用户 ${this.userName}(${this.userId}) 无权${op}物料分类 [${target.targetCategory}] / 物料 [${target.targetMaterialCode}] / 供应商 [${target.targetSupplierCode ?? '*'}]`,
      };
      if (this.traceId !== undefined) {
        errParams.traceId = this.traceId;
      }
      throw new ForbiddenError(
        errParams.message,
        ErrorCode.PBAC_PERMISSION_DENIED,
        errParams.traceId
      );
    }
  }

  public assertAccess(target: {
    targetCategory: string;
    targetMaterialCode: string;
    targetSupplierCode?: string;
    supplierDimension?: SupplierDimensionMode;
    operationName?: string;
  }): void {
    this.assertPermission(target);
  }
}
