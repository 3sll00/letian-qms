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
    const userPermission = await this.permissionRepo.findByUserId(user.id);
    const permissions = userPermission ? [userPermission] : [];

    return new SecurityContext({
      userId: user.id,
      userName: user.name,
      userRole: user.role,
      permissions,
      ...(traceId !== undefined ? { traceId } : {}),
    });
  }
}
