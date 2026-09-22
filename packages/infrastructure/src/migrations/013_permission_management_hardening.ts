import { Kysely, sql } from 'kysely';

/**
 * 迁移 013：物料权限管理 (PBAC) 字段链路加固
 *
 * 背景：物料权限管理页面的三类规则字段（物料分类 / 物料编码 / 供应商）与启停位
 * 在 003 迁移中已建表落地，但全链路核查（docs/18）发现三处缺口：
 *
 *  1. `employees.role_code`（003 新增列）**没有外键约束**，可以指向 roles 中不存在的
 *     角色编码，导致物料权限规则挂载 `fk_permission_role` 时外键违例；
 *  2. `material_permissions.user_name` 是冗余展示列，历史行为空时列表「用户姓名」
 *     列会渲染空白；
 *  3. 列表页「按物料编码筛选」走 `material_codes ? $1`（JSONB 包含运算符），
 *     但该列只有普通 B-Tree 索引，检索退化为顺序扫描；运行时热路径
 *     `findByUserId` 与日志「按用户 + 倒序分页」同样缺少匹配索引。
 *
 * 本迁移遵循「幂等、只补不删、不覆盖业务语义」原则（与 010/011 同构）：
 *  - 所有 DDL 均带存在性判断或 IF NOT EXISTS，可重复执行；
 *  - 数据回填仅在空值时生效，**不覆盖**既有值（保留演示口径，如「张三 (测试质检员)」）；
 *  - 唯一例外是历史权限校验日志的 `role_code` 纠正（此前因仓储未映射 employees.role_code
 *    而全部落库为 'GUEST'），只把能匹配到职员档案且值不一致的行回正为真实主角色。
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  // ---------------------------------------------------------------------------
  // 1. 清理 employees.role_code 中的脏角色编码，为第 2 步加外键扫清障碍
  // ---------------------------------------------------------------------------
  await sql`
    UPDATE employees
    SET role_code = NULL
    WHERE role_code IS NOT NULL
      AND role_code NOT IN (SELECT role_code FROM roles)
  `.execute(db);

  // ---------------------------------------------------------------------------
  // 2. 职员主角色 → 角色字典 外键（幂等添加）
  //    ON DELETE SET NULL：角色字典条目删除时，职员主角色回落为空（默认 GUEST 口径），
  //    而不是连带删除职员档案或阻塞角色维护。
  // ---------------------------------------------------------------------------
  await sql`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'fk_employee_role'
      ) THEN
        ALTER TABLE employees
          ADD CONSTRAINT fk_employee_role FOREIGN KEY (role_code)
          REFERENCES roles(role_code) ON DELETE SET NULL;
      END IF;
    END $$;
  `.execute(db);

  // ---------------------------------------------------------------------------
  // 3. 冗余展示列 user_name 空值回填（不覆盖既有姓名）
  //    与 010（检验人姓名对齐 employees.name）同构：只补空，不改写演示口径。
  // ---------------------------------------------------------------------------
  await sql`
    UPDATE material_permissions AS p
    SET user_name = e.name
    FROM employees AS e
    WHERE p.user_id = e.id
      AND (p.user_name IS NULL OR p.user_name = '');
  `.execute(db);

  // ---------------------------------------------------------------------------
  // 4. 物料编码维度检索索引：列表页 `material_codes ? $1` 使用 JSONB 包含运算符，
  //    必须 GIN 索引才能走索引扫描；jsonb_path_ops 体积更小且完全覆盖 `?` / `@>`。
  // ---------------------------------------------------------------------------
  await sql`
    CREATE INDEX IF NOT EXISTS idx_permissions_material_codes
      ON material_permissions USING gin (material_codes jsonb_path_ops)
  `.execute(db);

  // ---------------------------------------------------------------------------
  // 5. 运行时权限评估热路径：findByUserId / findAllForUser 按 user_id 过滤
  // ---------------------------------------------------------------------------
  await sql`
    CREATE INDEX IF NOT EXISTS idx_permissions_user
      ON material_permissions (user_id)
  `.execute(db);

  // ---------------------------------------------------------------------------
  // 6. 权限校验日志：按用户 + 时间倒序分页（物料权限管理 → 权限校验日志 Tab）
  // ---------------------------------------------------------------------------
  await sql`
    CREATE INDEX IF NOT EXISTS idx_authorization_logs_user_created
      ON authorization_logs (user_id, created_at DESC)
  `.execute(db);

  // ---------------------------------------------------------------------------
  // 7. 历史校验日志角色错标纠正
  //    此前 KyselyMasterDataRepository.mapEmployee 未映射 employees.role_code，
  //    登录签发的 JWT 与校验日志的 role_code 恒为 'GUEST'。此处按职员主角色回正，
  //    只更新「能匹配到职员档案、且职员已有真实主角色、且日志值与之不同」的行。
  // ---------------------------------------------------------------------------
  await sql`
    UPDATE authorization_logs AS l
    SET role_code = e.role_code
    FROM employees AS e
    WHERE l.user_id = e.id
      AND e.role_code IS NOT NULL
      AND l.role_code IS DISTINCT FROM e.role_code;
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX IF EXISTS idx_authorization_logs_user_created`.execute(db);
  await sql`DROP INDEX IF EXISTS idx_permissions_user`.execute(db);
  await sql`DROP INDEX IF EXISTS idx_permissions_material_codes`.execute(db);
  await sql`ALTER TABLE employees DROP CONSTRAINT IF EXISTS fk_employee_role`.execute(db);
  // 数据回填类变更不可逆（与 010 口径一致）：被回正的日志角色无法推断"原值"，
  // 保留空实现让 Migrator 的 down 流程可正常推进。
}