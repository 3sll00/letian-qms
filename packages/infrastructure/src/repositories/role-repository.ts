import type { Kysely } from 'kysely';
import type { Role } from '@letian/contracts';
import type { Database, RoleRow } from '../database/schema.js';

/**
 * 角色字典仓储 (Kysely + PostgreSQL)
 *
 * roles 表是角色编码的唯一数据源（003 迁移新增），
 * 同时被 material_permissions.role_code 与 employees.role_code 引用。
 * 只读：角色字典的增删改不在本期范围。
 */
export class KyselyRoleRepository {
  constructor(private readonly db: Kysely<Database>) {}

  /** 全部角色列表（别名兼容） */
  public async listRoles(): Promise<readonly Role[]> {
    return this.listActiveRoles();
  }

  /** 全部启用角色，按 sort_order 升序（前端筛选下拉 / 批量配置下拉共用） */
  public async listActiveRoles(): Promise<readonly Role[]> {
    const rows = await this.db
      .selectFrom('roles')
      .selectAll()
      .where('isActive', '=', true)
      .orderBy('sortOrder', 'asc')
      .orderBy('roleCode', 'asc')
      .execute();

    return rows.map((row) => this.mapRow(row));
  }

  /** 按编码取角色（含停用），用于登录签发时把 roleCode 翻译成 roleName */
  public async findByCode(roleCode: string): Promise<Role | null> {
    const row = await this.db
      .selectFrom('roles')
      .selectAll()
      .where('roleCode', '=', roleCode)
      .executeTakeFirst();

    return row ? this.mapRow(row) : null;
  }

  private mapRow(row: RoleRow): Role {
    return {
      roleCode: row.roleCode,
      roleName: row.roleName,
      isActive: row.isActive,
      sortOrder: row.sortOrder,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      ...(row.description !== null ? { description: row.description } : {}),
    };
  }
}
