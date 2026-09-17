import { Kysely } from 'kysely';
import type { PBACPermissionRepository } from '@letian/domain';
import type { IMaterialPermissionRepository } from '@letian/application';
import type { MaterialPermission } from '@letian/contracts';
import type { Database, MaterialPermissionRow } from '../database/schema.js';

/** jsonb 数组列在类型上是 string[]，但库中存量数据可能是别的形状，读取时按运行时形状收窄 */
function toJsonStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === 'string');
}

/**
 * 物料行级数据权限 (PBAC) 仓储 (Kysely + PostgreSQL)
 *
 * 同时实现领域端口 PBACPermissionRepository 与应用端口 IMaterialPermissionRepository。
 * 所有读方法均只返回 is_active = true 的生效规则。
 * 表 UNIQUE 约束为 (user_id, role_code)，即一个用户在一个角色下只有一条规则。
 */
export class KyselyMaterialPermissionRepository
  implements PBACPermissionRepository, IMaterialPermissionRepository
{
  constructor(private readonly db: Kysely<Database>) {}

  public async findPermissionsByRole(roleCode: string): Promise<readonly MaterialPermission[]> {
    const rows = await this.db
      .selectFrom('materialPermissions')
      .selectAll()
      .where('isActive', '=', true)
      .where('roleCode', '=', roleCode)
      .execute();

    return rows.map((row) => this.mapRow(row));
  }

  public async findPermissionsByRoles(roleCodes: readonly string[]): Promise<readonly MaterialPermission[]> {
    if (roleCodes.length === 0) {
      return [];
    }

    const rows = await this.db
      .selectFrom('materialPermissions')
      .selectAll()
      .where('isActive', '=', true)
      .where('roleCode', 'in', [...roleCodes])
      .execute();

    return rows.map((row) => this.mapRow(row));
  }

  public async findByUserId(userId: string): Promise<MaterialPermission | null> {
    const row = await this.db
      .selectFrom('materialPermissions')
      .selectAll()
      .where('isActive', '=', true)
      .where('userId', '=', userId)
      .orderBy('updatedAt', 'desc')
      .limit(1)
      .executeTakeFirst();

    return row ? this.mapRow(row) : null;
  }

  public async save(permission: MaterialPermission): Promise<void> {
    const now = new Date();

    // 插入值内联书写（不预先标注 Insertable 类型），让 Kysely 按 ValueExpression 逐列校验
    await this.db
      .insertInto('materialPermissions')
      .values({
        userId: permission.userId,
        roleCode: permission.roleCode,
        userName: permission.userName,
        // jsonb 数组列必须显式序列化，否则 node-postgres 会渲染成 PG 数组字面量导致 22P02
        materialCategories: JSON.stringify(permission.materialCategories),
        materialCodes: JSON.stringify(permission.materialCodes),
        supplierCodes: JSON.stringify(permission.supplierCodes),
        isActive: permission.isActive,
        updatedAt: now,
        ...(permission.id !== undefined ? { id: permission.id } : {}),
      })
      .onConflict((oc) =>
        oc.columns(['userId', 'roleCode']).doUpdateSet({
          userName: permission.userName,
          materialCategories: JSON.stringify(permission.materialCategories),
          materialCodes: JSON.stringify(permission.materialCodes),
          supplierCodes: JSON.stringify(permission.supplierCodes),
          isActive: permission.isActive,
          updatedAt: now,
        })
      )
      .execute();
  }

  public async listAllActive(): Promise<MaterialPermission[]> {
    const rows = await this.db
      .selectFrom('materialPermissions')
      .selectAll()
      .where('isActive', '=', true)
      .execute();

    return rows.map((row) => this.mapRow(row));
  }

  private mapRow(row: MaterialPermissionRow): MaterialPermission {
    return {
      id: row.id,
      userId: row.userId,
      userName: row.userName,
      roleCode: row.roleCode,
      materialCategories: toJsonStringArray(row.materialCategories),
      materialCodes: toJsonStringArray(row.materialCodes),
      supplierCodes: toJsonStringArray(row.supplierCodes),
      isActive: row.isActive,
    };
  }
}
