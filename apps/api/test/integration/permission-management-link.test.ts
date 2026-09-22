import assert from 'node:assert/strict';
import { buildApp } from '../../src/app';
import { createApiContainer, type ApiContainer } from '../../src/container';
import { generateTestToken } from '../../src/plugins/auth';
import { AuthUserSchema, MaterialPermissionSchema } from '@letian/contracts';

/**
 * 物料权限管理 (PBAC) 字段与接口打通回归测试
 *
 * 覆盖【系统管理 - 物料权限管理】的「用户权限列表」与用户/角色数据源：
 * 1. GET /api/v1/permissions/materials 的每一个字段必须与 material_permissions 物理列逐条一致
 *    （用户姓名 / 用户ID / 角色 / 三维 JSONB 白名单 / 启停位），并满足 MaterialPermissionSchema；
 * 2. PUT /api/v1/permissions/materials/:id **不携带 userName** 也必须成功
 *    （userName 是 employees.name 的冗余快照，服务端兜底补全；此前契约必填导致编辑弹窗必失败）；
 * 3. GET /api/v1/auth/users 的 roleCode / roleName 必须来自 employees.role_code + roles.role_name，
 *    不得静默退化为 'GUEST'（此前仓储 mapEmployee 未映射该列）；
 * 4. 同一 (用户, 角色) 重复创建必须 409，与 uq_permission_user_role 约束口径一致。
 *
 * 测试自建临时规则并在 finally 中物理删除，可重复执行。
 */
async function runPermissionManagementLinkTests() {
  console.log('--- 物料权限管理字段与接口打通回归测试（真实 PostgreSQL） ---');

  const container: ApiContainer = createApiContainer();
  const app = await buildApp({ logger: false, container });
  const db = container.db;

  const token = generateTestToken({
    userId: '11000000-0000-4000-8000-000000000001',
    userName: '张强',
    role: 'QA_MANAGER',
  });
  const authHeader = { authorization: `Bearer ${token}` };

  /** 临时规则挂载的用户与角色：赵志明（种子职员，初始无任何权限规则）× 通用质检员 */
  const testUserId = '11000000-0000-4000-8000-000000000005';
  const testRoleCode = 'INSPECTOR';
  let createdRuleId: string | null = null;

  try {
    // ---------- 1. 用户 / 角色数据源打通（D2） ----------
    const roleRows = await db.selectFrom('roles').select(['roleCode', 'roleName']).execute();
    const roleNames = new Map(roleRows.map((r) => [r.roleCode, r.roleName]));
    const employeeRows = await db
      .selectFrom('employees')
      .select(['id', 'name', 'roleCode'])
      .execute();

    const usersRes = await app.inject({ method: 'GET', url: '/api/v1/auth/users' });
    assert.equal(usersRes.statusCode, 200, '职员用户列表必须返回 200');
    const users = JSON.parse(usersRes.body) as Array<Record<string, unknown>>;
    assert.equal(users.length, employeeRows.length, '用户列表条数应等于职员档案条数');

    for (const user of users) {
      assert.equal(AuthUserSchema.safeParse(user).success, true, '用户项必须满足 AuthUserSchema');
      const emp = employeeRows.find((e) => e.id === user.id);
      assert.ok(emp, `用户 ${String(user.name)} 必须存在于职员档案`);
      assert.equal(user.name, emp.name, '用户姓名必须取 employees.name');
      // roleCode 允许在员工未配置主角色时回落为 GUEST，但一旦库中有值就必须原样透出
      if (emp.roleCode !== null) {
        assert.equal(user.roleCode, emp.roleCode, '用户主角色必须取 employees.role_code');
        assert.equal(user.roleName, roleNames.get(emp.roleCode), '角色名称必须取 roles.role_name');
      }
    }
    const roleCarryingUsers = users.filter((u) => u.roleCode !== 'GUEST').length;
    assert.ok(roleCarryingUsers > 0, '至少应有一名员工透出真实主角色，不得全部退化为 GUEST');
    console.log(`✓ GET /api/v1/auth/users 的 roleCode/roleName 与 employees.role_code + roles.role_name 一致（${roleCarryingUsers} 名员工带真实主角色）`);

    // ---------- 2. 列表字段与物理列逐条一致 ----------
    const listRes = await app.inject({
      method: 'GET',
      url: '/api/v1/permissions/materials?page=1&pageSize=100',
      headers: authHeader,
    });
    assert.equal(listRes.statusCode, 200, '权限规则列表必须返回 200');
    const listBody = JSON.parse(listRes.body) as {
      total: number;
      items: Array<Record<string, unknown>>;
    };

    const dbRows = await db
      .selectFrom('materialPermissions')
      .select([
        'id',
        'userId',
        'userName',
        'roleCode',
        'materialCategories',
        'materialCodes',
        'supplierCodes',
        'isActive',
      ])
      .execute();
    assert.equal(listBody.total, dbRows.length, '列表 total 应等于 material_permissions 行数');

    for (const item of listBody.items) {
      assert.equal(
        MaterialPermissionSchema.safeParse(item).success,
        true,
        '列表项必须满足 MaterialPermissionSchema'
      );
      const row = dbRows.find((r) => r.id === item.id);
      assert.ok(row, `列表项 ${String(item.id)} 必须存在于 material_permissions`);
      assert.equal(item.userId, row.userId, '用户ID 必须取 user_id 列');
      assert.equal(item.userName, row.userName, '用户姓名必须取 user_name 列');
      assert.equal(item.roleCode, row.roleCode, '角色必须取 role_code 列');
      assert.equal(item.isActive, row.isActive, '状态必须取 is_active 列');
      assert.deepEqual(item.materialCategories, row.materialCategories, '物料分类必须取 material_categories 列');
      assert.deepEqual(item.materialCodes, row.materialCodes, '物料编码必须取 material_codes 列');
      assert.deepEqual(item.supplierCodes, row.supplierCodes, '供应商必须取 supplier_codes 列');
    }
    console.log('✓ GET /api/v1/permissions/materials 七项字段与 material_permissions 物理列逐条一致');

    // ---------- 3. 创建（不回传 userName）→ 服务端按职员档案补全 ----------
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/v1/permissions/materials',
      headers: authHeader,
      payload: {
        userId: testUserId,
        roleCode: testRoleCode,
        materialCategories: ['CAT-RAW-WIRE'],
        materialCodes: ['MAT-304SS-05'],
        supplierCodes: [],
        isActive: true,
      },
    });
    assert.equal(createRes.statusCode, 201, `创建权限规则应返回 201，实际 ${createRes.statusCode}`);
    const created = JSON.parse(createRes.body) as Record<string, unknown>;
    createdRuleId = created.id as string;
    assert.equal(created.userName, '赵志明', 'userName 缺省时应从职员档案补全');

    const persisted = await db
      .selectFrom('materialPermissions')
      .select(['userName', 'materialCategories', 'isActive'])
      .where('id', '=', createdRuleId)
      .executeTakeFirstOrThrow();
    assert.equal(persisted.userName, '赵志明', '落库的 user_name 应为补全后的姓名');

    // ---------- 4. 重复创建同 (用户, 角色) 必须 409 ----------
    const dupRes = await app.inject({
      method: 'POST',
      url: '/api/v1/permissions/materials',
      headers: authHeader,
      payload: { userId: testUserId, roleCode: testRoleCode },
    });
    assert.equal(dupRes.statusCode, 409, '同一 (用户, 角色) 重复创建应返回 409');

    // ---------- 5. 编辑保存不携带 userName 必须成功（D1 回归） ----------
    const updateRes = await app.inject({
      method: 'PUT',
      url: `/api/v1/permissions/materials/${createdRuleId}`,
      headers: authHeader,
      payload: { isActive: false },
    });
    assert.equal(
      updateRes.statusCode,
      200,
      `不带 userName 的编辑保存应返回 200，实际 ${updateRes.statusCode}: ${updateRes.body}`
    );
    const updated = JSON.parse(updateRes.body) as Record<string, unknown>;
    assert.equal(updated.userName, '赵志明', '未回传 userName 时服务端必须兜底补全，不得清空');
    assert.equal(updated.isActive, false, '启停位应更新为新值');
    assert.deepEqual(
      updated.materialCategories,
      ['CAT-RAW-WIRE'],
      '部分更新不得丢失未提交的三维维度'
    );

    const afterUpdate = await db
      .selectFrom('materialPermissions')
      .select(['userName', 'isActive', 'materialCategories'])
      .where('id', '=', createdRuleId)
      .executeTakeFirstOrThrow();
    assert.equal(afterUpdate.userName, '赵志明', '落库 user_name 不得为空');
    assert.equal(afterUpdate.isActive, false, '落库 is_active 应为 false');
    assert.deepEqual(afterUpdate.materialCategories, ['CAT-RAW-WIRE'], '落库三维维度保持原值');
    console.log('✓ POST / PUT /permissions/materials 的 userName 兜底、部分更新与 409 冲突口径全部符合预期');
  } finally {
    if (createdRuleId !== null) {
      await db.deleteFrom('materialPermissions').where('id', '=', createdRuleId).execute();
    }
    await app.close();
    await db.destroy();
  }
}

runPermissionManagementLinkTests()
  .then(() => {
    console.log('=== 物料权限管理字段与接口打通回归测试全部通过 ===');
    process.exit(0);
  })
  .catch((err) => {
    console.error('=== 物料权限管理字段与接口打通回归测试失败 ===');
    console.error(err);
    process.exit(1);
  });