import { Kysely, sql } from 'kysely';

/**
 * 迁移 048：职员独立登录口令
 *
 * employees.password_hash —— scrypt 口令哈希（格式 `scrypt:N$r$p$salt$hash`，hex 编码）。
 *
 * 业务口径：
 *   - NULL 表示该职员尚未设置独立口令，登录回落到共享初始口令
 *     （环境变量 DEFAULT_LOGIN_PASSWORD），且登录响应必须带 mustChangePassword=true，
 *     前端据此强制引导其调用 POST /auth/change-password 设置个人密码；
 *   - 一旦写入哈希，共享初始口令对该职员立即失效，只认独立口令；
 *   - 管理员重置口令 = 把本列置回 NULL（等价于回到"初始口令 + 强制改密"流程）。
 *
 * 安全：列内永远只存 scrypt 哈希，严禁明文；本列不得出现在任何读侧 DTO/接口响应中。
 *
 * 幂等：IF NOT EXISTS；down 只回滚本迁移新增列。
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE employees
      ADD COLUMN IF NOT EXISTS password_hash TEXT
  `.execute(db);

  await sql`
    COMMENT ON COLUMN employees.password_hash IS
      'scrypt 登录口令哈希；NULL = 未设独立口令，登录回落共享初始口令且强制改密'
  `.execute(db);

  console.log('[048] 已为 employees 增加独立口令哈希列');
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE employees
      DROP COLUMN IF EXISTS password_hash
  `.execute(db);
  console.log('[048] 已回滚职员独立口令列');
}
