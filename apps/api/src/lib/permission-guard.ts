import type { FastifyRequest } from 'fastify';
import type { MaterialPermission } from '@letian/contracts';
import {
  SecurityContextFactory,
  type ISecurityContext,
} from '@letian/application';
import type { ApiContainer } from '../container';
import { operatorOf } from './operator';

/**
 * 权限接线公共工具：
 * - 读侧：取当前用户的生效权限规则，供仓储行级过滤；
 * - 写侧：装配 PBAC 安全上下文，传入用例 execute；
 * - 校验日志：fire-and-forget 追加 authorization_logs（PRD：每次敏感查询的行级过滤记录）。
 */

/** 规则是否全通配（全通配用户不受过滤，也不产生校验日志噪音） */
export function isFullWildcard(permissions: readonly MaterialPermission[]): boolean {
  return permissions.some((rule) => {
    const wild = (list: readonly string[]): boolean =>
      list.length === 0 || list.includes('*');
    return wild(rule.materialCategories) && wild(rule.materialCodes) && wild(rule.supplierCodes);
  });
}

/** 当前用户在全部角色下的生效权限规则（无规则返回空数组，由翻译器 fail-closed） */
export async function getRequestPermissions(
  request: FastifyRequest,
  container: ApiContainer
): Promise<readonly MaterialPermission[]> {
  const operator = operatorOf(request);
  const rules = await container.repositories.materialPermissions.findByUserId(operator.userId);
  if (rules.length > 0) {
    return rules;
  }
  const isSuper =
    operator.role === 'ADMIN' ||
    operator.role === 'QA_MANAGER' ||
    operator.role === 'SYSTEM' ||
    request.user?.permissions?.includes('*') === true;
  if (isSuper) {
    return [
      {
        id: '00000000-0000-4000-8000-' + operator.userId.replace(/-/g, '').slice(-12).padStart(12, '0'),
        userId: operator.userId,
        userName: operator.userName,
        roleCode: operator.role,
        materialCategories: ['*'],
        materialCodes: ['*'],
        supplierCodes: ['*'],
        isActive: true,
      },
    ];
  }
  return [];
}

/** 别名：兼容以 container 在前调用点的旧写法 */
export async function activePermissionsOf(
  container: ApiContainer,
  request: FastifyRequest
): Promise<readonly MaterialPermission[]> {
  return getRequestPermissions(request, container);
}

/** 装配写侧 PBAC 安全上下文（request.user 为 JWT 解出的当前身份） */
export async function buildRequestSecurityContext(
  request: FastifyRequest,
  container: ApiContainer
): Promise<ISecurityContext> {
  const operator = operatorOf(request);
  const factory = new SecurityContextFactory(container.repositories.materialPermissions);
  return factory.createContext({
    id: operator.userId,
    name: operator.userName,
    role: operator.role,
  });
}

/** 别名：兼容以 container 在前调用点的旧写法 */
export async function securityContextOf(
  container: ApiContainer,
  request: FastifyRequest
): Promise<ISecurityContext> {
  return buildRequestSecurityContext(request, container);
}

/** 权限规则摘要（写入校验日志 detail，便于人工核查过滤口径） */
export function permissionSummary(permissions: readonly MaterialPermission[]): string {
  const active = permissions.filter((rule) => rule.isActive !== false);
  if (active.length === 0) {
    return '无生效权限规则，行级过滤拒绝全部数据';
  }
  if (isFullWildcard(active)) {
    return '全量通配规则，行级过滤放行全部数据';
  }
  return active
    .map(
      (rule) =>
        `[${rule.roleCode}] 分类=${rule.materialCategories.join(',') || '*'} 编码=${
          rule.materialCodes.join(',') || '*'
        } 供应商=${rule.supplierCodes.join(',') || '*'}`
    )
    .join('; ');
}

export interface AuthLogAppendInput {
  resourceType: string;
  resourceId?: string | undefined;
  materialCode?: string | undefined;
  materialCategory?: string | undefined;
  supplierCode?: string | undefined;
  action: string;
  decision: 'ALLOWED' | 'DENIED';
  matchedRuleId?: string | undefined;
  detail?: string | undefined;
}

export interface AuthorizationCheckInput extends AuthLogAppendInput {
  userId: string;
  userName: string;
  roleCode?: string | undefined;
}

/**
 * fire-and-forget 追加权限校验日志：失败只打印错误，绝不影响业务响应。
 * 调用方（控制器）已携带当前用户身份，这里不再重复解析 JWT。
 */
export function logAuthorizationCheck(
  container: ApiContainer,
  input: AuthorizationCheckInput
): void {
  container.repositories.authorizationLogs
    .append({
      userId: input.userId,
      userName: input.userName,
      ...(input.roleCode !== undefined ? { roleCode: input.roleCode } : {}),
      resourceType: input.resourceType,
      resourceId: input.resourceId,
      materialCode: input.materialCode,
      materialCategory: input.materialCategory,
      supplierCode: input.supplierCode,
      action: input.action,
      decision: input.decision,
      matchedRuleId: input.matchedRuleId,
      detail: input.detail,
    })
    .catch((err: unknown) => {
      console.error(
        '[permission] 权限校验日志写入失败:',
        err instanceof Error ? err.message : String(err)
      );
    });
}

/** 旧签名别名：logAuthorization(container, request, permissions, input)，全通配用户跳过记录 */
export function logAuthorization(
  container: ApiContainer,
  request: FastifyRequest,
  permissions: readonly MaterialPermission[] | undefined,
  input: AuthLogAppendInput
): void {
  if (permissions === undefined || isFullWildcard(permissions)) {
    return;
  }
  const operator = operatorOf(request);
  logAuthorizationCheck(container, {
    userId: operator.userId,
    userName: operator.userName,
    ...(operator.role !== 'SYSTEM' ? { roleCode: operator.role } : {}),
    ...input,
  });
}
