import type { IMaterialPermissionRepository } from '../tx/unit-of-work.js';
import { SecurityContext, type ISecurityContext } from './security-context.js';

export interface IUserPrincipal {
  id: string;
  name: string;
  role: string;
}

/**
 * PBAC 安全上下文装配工厂
 */
export class SecurityContextFactory {
  constructor(private readonly permissionRepo: IMaterialPermissionRepository) {}

  /**
   * 根据当前请求的认证用户 Principal 装配三维 PBAC 安全上下文
   */
  public async createContext(user: IUserPrincipal, traceId?: string): Promise<ISecurityContext> {
    // 用户在全部角色下的生效规则（一人多角色多条规则，评估器按 OR 语义处理）
    const permissions = await this.permissionRepo.findByUserId(user.id);

    return new SecurityContext({
      userId: user.id,
      userName: user.name,
      userRole: user.role,
      permissions,
      ...(traceId !== undefined ? { traceId } : {}),
    });
  }
}
