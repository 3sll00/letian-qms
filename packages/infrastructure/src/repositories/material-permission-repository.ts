import { sql, type Kysely, type SqlBool } from 'kysely';
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

/** ILIKE 模式串转义：% 与 _ 是通配符，用户输入必须按字面量匹配 */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/** 权限规则分页列表查询条件（含停用规则，供权限管理页） */
export interface PermissionListQuery {
  userName?: string;
  roleCode?: string;
  materialCode?: string;
  page: number;
  pageSize: number;
}

/** 权限规则分页列表结果 */
export interface PermissionListResult {
  total: number;
  items: MaterialPermission[];
  list: MaterialPermission[];
}

/**
 * 物料行级数据权限 (PBAC) 仓储 (Kysely + PostgreSQL)
 *
 * 同时实现领域端口 PBACPermissionRepository 与应用端口 IMaterialPermissionRepository。
 * 表 UNIQUE 约束为 (user_id, role_code)，即一个用户在一个角色下只有一条规则。
 *
 * 读取语义分层：
 * - findByUserId / findPermissionsByRole(s) / listAllActive：只返回生效规则，
 *   供运行时权限评估与读侧过滤；
 * - listAll：返回全部规则（含停用），供权限管理页的台账展示。
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

  /**
   * 返回用户在**全部角色**下的生效规则。
   *
   * UNIQUE(user_id, role_code) 允许一人多角色多条规则，评估器本身是 OR 语义，
   * 因此这里必须返回全部规则而不是 limit 1 的最新一条。
   */
  public async findByUserId(userId: string): Promise<readonly MaterialPermission[]> {
    const rows = await this.db
      .selectFrom('materialPermissions')
      .selectAll()
      .where('isActive', '=', true)
      .where('userId', '=', userId)
      .orderBy('updatedAt', 'desc')
      .execute();

    return rows.map((row) => this.mapRow(row));
  }

  /** 权限管理页台账：全部规则（含停用），支持按姓名 / 角色 / 物料编码筛选 */
  public async listAll(query: PermissionListQuery): Promise<PermissionListResult> {
    let listQuery = this.db.selectFrom('materialPermissions').selectAll();
    let countQuery = this.db.selectFrom('materialPermissions').select((eb) => eb.fn.countAll().as('total'));

    if (query.userName !== undefined && query.userName !== '') {
      const pattern = `%${escapeLike(query.userName)}%`;
      listQuery = listQuery.where('userName', 'ilike', pattern);
      countQuery = countQuery.where('userName', 'ilike', pattern);
    }
    if (query.roleCode !== undefined && query.roleCode !== '') {
      listQuery = listQuery.where('roleCode', '=', query.roleCode);
      countQuery = countQuery.where('roleCode', '=', query.roleCode);
    }
    if (query.materialCode !== undefined && query.materialCode !== '') {
      // jsonb 数组的 ? 运算符：字符串是否作为数组元素存在
      const exists = sql<SqlBool>`material_codes ? ${query.materialCode}`;
      listQuery = listQuery.where(exists);
      countQuery = countQuery.where(exists);
    }

    const rows = await listQuery
      .orderBy('updatedAt', 'desc')
      .limit(query.pageSize)
      .offset((query.page - 1) * query.pageSize)
      .execute();

    const countRow = await countQuery.executeTakeFirst();
    const items = rows.map((row) => this.mapRow(row));
    return {
      total: countRow ? Number(countRow.total) : 0,
      items,
      list: items,
    };
  }

  /** 创建（或按 user_id + role_code 冲突时覆盖）一条权限规则 */
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

  /** 按主键更新一条规则（三维维度 / 用户 / 角色 / 启停） */
  public async updateById(
    id: string,
    fields: {
      userId: string;
      userName: string;
      roleCode: string;
      materialCategories: string[];
      materialCodes: string[];
      supplierCodes: string[];
      isActive: boolean;
    }
  ): Promise<boolean> {
    const result = await this.db
      .updateTable('materialPermissions')
      .set({
        userId: fields.userId,
        userName: fields.userName,
        roleCode: fields.roleCode,
        materialCategories: JSON.stringify(fields.materialCategories),
        materialCodes: JSON.stringify(fields.materialCodes),
        supplierCodes: JSON.stringify(fields.supplierCodes),
        isActive: fields.isActive,
        updatedAt: new Date(),
      })
      .where('id', '=', id)
      .executeTakeFirst();

    return Number(result.numUpdatedRows) > 0;
  }

  /** 物理删除一条规则 */
  public async deleteById(id: string): Promise<boolean> {
    const result = await this.db
      .deleteFrom('materialPermissions')
      .where('id', '=', id)
      .executeTakeFirst();

    return Number(result.numDeletedRows) > 0;
  }

  /** 按角色批量改写：该角色下所有规则的三维维度统一覆盖 */
  public async updateAllByRole(
    roleCode: string,
    fields: {
      materialCategories: string[];
      materialCodes: string[];
      supplierCodes: string[];
      isActive: boolean;
    }
  ): Promise<number> {
    const result = await this.db
      .updateTable('materialPermissions')
      .set({
        materialCategories: JSON.stringify(fields.materialCategories),
        materialCodes: JSON.stringify(fields.materialCodes),
        supplierCodes: JSON.stringify(fields.supplierCodes),
        isActive: fields.isActive,
        updatedAt: new Date(),
      })
      .where('roleCode', '=', roleCode)
      .executeTakeFirst();

    return Number(result.numUpdatedRows);
  }

  public async listAllActive(): Promise<MaterialPermission[]> {
    const rows = await this.db
      .selectFrom('materialPermissions')
      .selectAll()
      .where('isActive', '=', true)
      .execute();

    return rows.map((row) => this.mapRow(row));
  }

  public async findById(id: string): Promise<MaterialPermission | null> {
    const row = await this.db
      .selectFrom('materialPermissions')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();

    return row ? this.mapRow(row) : null;
  }

  /** 用户在全部角色下的规则（含停用），供冲突检测与台账诊断 */
  public async findAllForUser(userId: string): Promise<readonly MaterialPermission[]> {
    const rows = await this.db
      .selectFrom('materialPermissions')
      .selectAll()
      .where('userId', '=', userId)
      .orderBy('updatedAt', 'desc')
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
