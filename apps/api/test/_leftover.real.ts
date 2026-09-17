import { createDatabaseConnection } from '@letian/infrastructure';

async function main(): Promise<void> {
  const db = createDatabaseConnection();
  try {
    const deleted = await db
      .deleteFrom('inspectionOrders')
      .where('orderNo', 'like', 'HTTP-ACC-%')
      .executeTakeFirst();
    console.log('删除行数=' + Number(deleted.numDeletedRows));
    const after = await db
      .selectFrom('inspectionOrders')
      .select((eb) => eb.fn.countAll().as('c'))
      .executeTakeFirstOrThrow();
    const e2e = await db
      .selectFrom('inspectionOrders')
      .select((eb) => eb.fn.countAll().as('c'))
      .where('orderNo', 'like', 'E2E-%')
      .executeTakeFirstOrThrow();
    console.log(`当前检验单总数=${Number(after.c)}，其中 E2E 残留=${Number(e2e.c)}`);
  } finally {
    await db.destroy();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
