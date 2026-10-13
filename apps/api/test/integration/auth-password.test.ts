import assert from 'node:assert/strict';
import { buildApp } from '../../src/app';
import { createApiContainer, type ApiContainer } from '../../src/container';

/**
 * 职员独立登录口令回归测试（迁移 048，真实 PostgreSQL）
 *
 * 口径：
 * 1. employees.password_hash IS NULL → 登录用共享初始口令，响应带 mustChangePassword=true；
 * 2. POST /auth/change-password 凭「用户名 + 旧口令」设置独立口令 → 写 scrypt 哈希；
 * 3. 设置后共享初始口令对该职员立即失效（401），独立口令可登录且不再带强制改密标记；
 * 4. 旧口令错误的改密请求返回 401 且留审计；新口令过弱被契约 400 拦截；
 * 5. 管理员重置 = password_hash 置 NULL → 回到「初始口令 + 强制改密」流程；
 * 6. password_hash 不出现在任何对外响应中（/auth/users、登录响应均不含哈希）。
 *
 * 测试结束把目标职员的 password_hash 复位为 NULL，保证可重复运行。
 */

/** 种子职员：质量主管 张强（docs/seeds 固定 UUID） */
const TARGET_EMP_ID = '11000000-0000-4000-8000-000000000001';
const TARGET_NAME = '张强';
const SHARED_PASSWORD = process.env.DEFAULT_LOGIN_PASSWORD || '123456';
const NEW_PASSWORD = 'LtQms@Test2026';
const SECOND_PASSWORD = 'LtQms@Reset2026';

async function runAuthPasswordTests() {
  console.log('--- 职员独立口令 / 强制改密 回归测试（真实 PostgreSQL） ---');

  const container: ApiContainer = createApiContainer();
  const app = await buildApp({ logger: false, container });
  const db = container.db;

  let pass = 0;
  let fail = 0;
  const check = (name: string, cond: boolean, extra?: unknown) => {
    if (cond) {
      pass += 1;
      console.log(`  ✔ ${name}`);
    } else {
      fail += 1;
      console.error(`  ✘ ${name}`, extra ?? '');
    }
  };

  try {
    // 前置：确保目标职员处于「未设独立口令」基线
    await container.repositories.masterData.setEmployeePasswordHash(TARGET_EMP_ID, null);

    // ---- 1. 初始口令登录：mustChangePassword ----
    const login1 = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { userName: TARGET_NAME, password: SHARED_PASSWORD },
    });
    check('初始口令登录返回 200', login1.statusCode === 200, login1.body);
    const login1Body = login1.json() as {
      mustChangePassword?: boolean;
      user?: { userId?: string };
      token?: string;
    };
    check(
      '初始口令登录标记 mustChangePassword=true',
      login1Body.mustChangePassword === true,
      login1Body
    );
    check('登录响应不携带口令哈希', !('passwordHash' in login1Body) && !('passwordHash' in (login1Body.user ?? {})));
    check('登录响应 userId 正确', login1Body.user?.userId === TARGET_EMP_ID, login1Body.user);

    // ---- 2. 错误初始口令 ----
    const loginWrong = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { userName: TARGET_NAME, password: 'wrong-password' },
    });
    check('错误口令登录返回 401', loginWrong.statusCode === 401, loginWrong.body);

    // ---- 3. 旧口令错误时改密被拒 ----
    const changeBadOld = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/change-password',
      payload: {
        userName: TARGET_NAME,
        oldPassword: 'wrong-password',
        newPassword: NEW_PASSWORD,
      },
    });
    check('旧口令错误改密返回 401', changeBadOld.statusCode === 401, changeBadOld.body);

    // ---- 4. 弱口令被契约拦截 ----
    const changeWeak = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/change-password',
      payload: {
        userName: TARGET_NAME,
        oldPassword: SHARED_PASSWORD,
        newPassword: 'short',
      },
    });
    check('过短新口令返回 400', changeWeak.statusCode === 400, changeWeak.body);

    // ---- 5. 正常改密 ----
    const changeOk = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/change-password',
      payload: {
        userName: TARGET_NAME,
        oldPassword: SHARED_PASSWORD,
        newPassword: NEW_PASSWORD,
      },
    });
    check('正常改密返回 200', changeOk.statusCode === 200, changeOk.body);

    const cred = await container.repositories.masterData.getEmployeeCredential(TARGET_EMP_ID);
    check(
      '库内写入 scrypt 自描述格式哈希（非明文）',
      typeof cred?.passwordHash === 'string' &&
        cred.passwordHash.startsWith('scrypt:') &&
        !cred.passwordHash.includes(NEW_PASSWORD)
    );

    // ---- 6. 改密后：初始口令失效，新口令可登录且不再强制改密 ----
    const loginOld = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { userName: TARGET_NAME, password: SHARED_PASSWORD },
    });
    check('改密后初始口令登录返回 401', loginOld.statusCode === 401, loginOld.body);

    const loginNew = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { userName: TARGET_NAME, password: NEW_PASSWORD },
    });
    check('改密后新口令登录返回 200', loginNew.statusCode === 200, loginNew.body);
    const loginNewBody = loginNew.json() as { mustChangePassword?: boolean };
    check('独立口令登录不携带 mustChangePassword', loginNewBody.mustChangePassword !== true);

    // ---- 7. 审计留痕（改密成功 1 条 UPDATE，失败 1 条 AUTH_FAILED）----
    const auditRows = await db
      .selectFrom('auditLogs')
      .select(['action', 'status', 'entityName'])
      .where('entityName', '=', 'employee_credential')
      .where('entityId', '=', TARGET_EMP_ID)
      .execute();
    check(
      '改密成功已写 UPDATE/SUCCESS 审计',
      auditRows.some((r) => r.action === 'UPDATE' && r.status === 'SUCCESS'),
      auditRows
    );
    check(
      '改密失败已写 AUTH_FAILED/REJECTED 审计',
      auditRows.some((r) => r.action === 'AUTH_FAILED' && r.status === 'REJECTED'),
      auditRows
    );

    // ---- 8. 管理员重置（password_hash 置 NULL）回到初始口令流程 ----
    const resetOk = await container.repositories.masterData.setEmployeePasswordHash(
      TARGET_EMP_ID,
      null
    );
    check('口令哈希重置写入成功', resetOk === true);

    const loginReset = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { userName: TARGET_NAME, password: SHARED_PASSWORD },
    });
    const loginResetBody = loginReset.json() as { mustChangePassword?: boolean };
    check(
      '重置后初始口令重新可用且再次标记强制改密',
      loginReset.statusCode === 200 && loginResetBody.mustChangePassword === true,
      loginReset.body
    );

    // ---- 9. /auth/users 响应不泄露口令哈希 ----
    const usersRes = await app.inject({ method: 'GET', url: '/api/v1/auth/users' });
    if (usersRes.statusCode === 200) {
      const users = usersRes.json() as Array<Record<string, unknown>>;
      check('/auth/users 响应不含 passwordHash', users.every((u) => !('passwordHash' in u)));
    }

    // 再设一次独立口令并复位，顺带覆盖「二次改密用旧独立口令自证」路径
    await container.repositories.masterData.setEmployeePasswordHash(TARGET_EMP_ID, null);
    const reChange = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/change-password',
      payload: {
        userName: TARGET_NAME,
        oldPassword: SHARED_PASSWORD,
        newPassword: SECOND_PASSWORD,
      },
    });
    check('复位后可再次设置独立口令', reChange.statusCode === 200, reChange.body);
    const reChangeWithHash = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/change-password',
      payload: {
        userName: TARGET_NAME,
        oldPassword: SECOND_PASSWORD,
        newPassword: NEW_PASSWORD,
      },
    });
    check('以独立口令为旧口令再次改密成功', reChangeWithHash.statusCode === 200, reChangeWithHash.body);
  } finally {
    // 复位：测试不留下独立口令，保证用例可重复运行且不影响演示环境
    await container.repositories.masterData.setEmployeePasswordHash(TARGET_EMP_ID, null);
    await db.destroy();
  }

  console.log(`\n[RESULT] PASS=${pass} FAIL=${fail}`);
  if (fail > 0) process.exit(1);
}

runAuthPasswordTests().catch((err) => {
  console.error('[FATAL]', err);
  process.exit(1);
});
