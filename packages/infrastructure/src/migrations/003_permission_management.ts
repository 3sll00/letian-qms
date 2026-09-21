import { Kysely, sql } from 'kysely';

/**
 * 003 —— 权限管理体系补全：角色字典、权限校验日志、员工主角色与外键关联。
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  // 1. 角色字典 roles
  await sql`
    CREATE TABLE IF NOT EXISTS roles (
      role_code VARCHAR(64) PRIMARY KEY,
      role_name VARCHAR(64) NOT NULL,
      description VARCHAR(255),
      is_active BOOLEAN NOT NULL DEFAULT true,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `.execute(db);

  // 预置系统初始角色，避免已有 material_permissions 挂载外键时发生外键违例
  await sql`
    INSERT INTO roles (role_code, role_name, description, sort_order)
    VALUES
      ('QA_MANAGER', '质量主管', '质量总览与全量物料数据权限', 10),
      ('PROCESS_ENGINEER', '工艺工程师', '质检方案与工艺参数维护', 20),
      ('IQC_INSPECTOR', 'IQC检验员', '来料检验', 30),
      ('IPQC_INSPECTOR', 'IPQC检验员', '过程检验', 40),
      ('OQC_INSPECTOR', 'OQC检验员', '出货检验', 50),
      ('SURFACE_TREATMENT_ENGINEER', '表面处理工程师', '表面处理工序质量', 60),
      ('WORKSHOP_LEADER', '车间班组长', '车间现场管理', 70),
      ('RESTRICTED_VIEWER', '受限访问', '演示用受限角色（默认停用规则）', 90)
    ON CONFLICT (role_code) DO NOTHING
  `.execute(db);

  // 2. 权限校验日志 authorization_logs（PRD：保留周期至少 180 天）
  await sql`
    CREATE TABLE IF NOT EXISTS authorization_logs (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL,
      user_name VARCHAR(64) NOT NULL,
      role_code VARCHAR(64),
      resource_type VARCHAR(64) NOT NULL,
      resource_id VARCHAR(255),
      material_code VARCHAR(64),
      material_category VARCHAR(64),
      supplier_code VARCHAR(64),
      action VARCHAR(64) NOT NULL,
      decision VARCHAR(16) NOT NULL DEFAULT 'ALLOWED',
      matched_rule_id UUID,
      detail TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT authorization_logs_decision_check CHECK (decision IN ('ALLOWED', 'DENIED'))
    )
  `.execute(db);
  await sql`CREATE INDEX IF NOT EXISTS idx_authorization_logs_created_at ON authorization_logs(created_at)`.execute(db);
  await sql`CREATE INDEX IF NOT EXISTS idx_authorization_logs_user ON authorization_logs(user_id)`.execute(db);

  // 3. 职员档案挂主角色
  await sql`ALTER TABLE employees ADD COLUMN IF NOT EXISTS role_code VARCHAR(64)`.execute(db);

  // 4. 外键关联：权限规则 → 职员档案 / 角色字典（幂等添加）
  await sql`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'fk_permission_user'
      ) THEN
        ALTER TABLE material_permissions
          ADD CONSTRAINT fk_permission_user FOREIGN KEY (user_id) REFERENCES employees(id) ON DELETE CASCADE;
      END IF;
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'fk_permission_role'
      ) THEN
        ALTER TABLE material_permissions
          ADD CONSTRAINT fk_permission_role FOREIGN KEY (role_code) REFERENCES roles(role_code) ON DELETE RESTRICT;
      END IF;
    END $$;
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE material_permissions DROP CONSTRAINT IF EXISTS fk_permission_role`.execute(db);
  await sql`ALTER TABLE material_permissions DROP CONSTRAINT IF EXISTS fk_permission_user`.execute(db);
  await sql`ALTER TABLE employees DROP COLUMN IF EXISTS role_code`.execute(db);
  await sql`DROP TABLE IF EXISTS authorization_logs CASCADE`.execute(db);
  await sql`DROP TABLE IF EXISTS roles CASCADE`.execute(db);
}
