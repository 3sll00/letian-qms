import assert from 'node:assert';
import {
  ErpReadOnlyViolation,
  assertReadOnlyErpSql,
  erpReadOnlyAudit,
  queryErpReadOnly,
  resetErpReadOnlyAudit,
  type ErpQueryRunner,
} from '../sync/erp-readonly.js';

async function main(): Promise<void> {
  console.log('Testing ERP read-only guard...');

  assertReadOnlyErpSql('SELECT typeId, UserCode FROM Ptype WHERE deleted = 0');
  assertReadOnlyErpSql('WITH leaf AS (SELECT typeId FROM Ptype) SELECT * FROM leaf');
  assertReadOnlyErpSql("SELECT N'update' AS tag FROM Ptype");
  console.log('  [OK] SELECT / WITH 放行；字符串字面量里的写关键字不误判');

  const rejected: ReadonlyArray<readonly [string, string]> = [
    ["UPDATE Ptype SET FullName = N'x' WHERE typeId = 1", 'update'],
    ['DELETE FROM Ptype WHERE typeId = 1', 'delete'],
    ['INSERT INTO Ptype (typeId) VALUES (1)', 'insert'],
    ['SELECT * INTO Ptype_backup FROM Ptype', 'into'],
    ['EXEC sp_who', 'exec'],
    ['TRUNCATE TABLE Ptype', 'truncate'],
    ['DROP TABLE Ptype', 'drop'],
    ['ALTER TABLE Ptype ADD x INT', 'alter'],
  ];
  for (const [sqlText, keyword] of rejected) {
    let caught: unknown = null;
    try {
      assertReadOnlyErpSql(sqlText);
    } catch (err) {
      caught = err;
    }
    assert(caught instanceof ErpReadOnlyViolation, `应拦截该语句：${sqlText}`);
    // 首关（非 SELECT/WITH 开头）会先拒绝，故允许「指向关键字」或「首关拒绝」两种原因
    assert(
      (caught as Error).message.includes(keyword) || (caught as Error).message.includes('只允许以 SELECT'),
      `拦截原因应指向 "${keyword}" 或首关拒绝，实际：${(caught as Error).message}`
    );
  }
  console.log(`  [OK] ${rejected.length} 条写语句全部被拦（fail-closed）`);

  let calls = 0;
  const runner: ErpQueryRunner = {
    async query() {
      calls++;
      return { recordset: [] };
    },
  };

  resetErpReadOnlyAudit();
  await assert.rejects(
    () => queryErpReadOnly(runner, "UPDATE Ptype SET FullName = N'x'"),
    ErpReadOnlyViolation
  );
  assert.strictEqual(calls, 0, '写语句不得下发到 ERP 连接');
  assert.strictEqual(erpReadOnlyAudit.length, 0, '被拦的语句不应计入审计');
  console.log('  [OK] 写语句在「下发前」被拦（runner 调用 0 次、审计为空）');

  const rows = await queryErpReadOnly<{ typeId: number }>(runner, 'SELECT typeId FROM Ptype');
  assert.strictEqual(calls, 1, '合法查询应下发 1 次');
  assert.strictEqual(erpReadOnlyAudit.length, 1, '合法查询应计入审计');
  assert.deepStrictEqual(rows, []);
  console.log('  [OK] 合法查询正常下发并计入审计');

  console.log('ERP read-only guard tests passed successfully!');
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
