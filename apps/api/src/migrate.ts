/**
 * 独立迁移入口：客户服务器上没有 pnpm/tsx，用打包后的 migrate.exe 执行数据库迁移。
 * 用法（编译后）：
 *   node dist/migrate.js          → 执行 up（升到最新）
 *   node dist/migrate.js down     → 回退一步（一般不用）
 * pkg 打包：letian-qms-migrate.exe
 */
import { runMigrations } from '@letian/infrastructure';

const direction = process.argv[2] === 'down' ? 'down' : 'up';

runMigrations(direction)
  .then(() => {
    console.log(`[Letian QMS Migrate] 完成：${direction}`);
    process.exit(0);
  })
  .catch((err) => {
    console.error('[Letian QMS Migrate] 失败：', err);
    process.exit(1);
  });
