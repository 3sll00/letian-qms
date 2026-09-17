import { Migrator, Migration, MigrationProvider } from 'kysely';
import { getDatabase } from '../database/connection.js';
import * as initMigration from './001_init_qms_tables.js';
import * as alignToContractsMigration from './002_align_schema_to_contracts.js';

class DynamicMigrationProvider implements MigrationProvider {
  async getMigrations(): Promise<Record<string, Migration>> {
    return {
      '001_init_qms_tables': initMigration,
      '002_align_schema_to_contracts': alignToContractsMigration,
    };
  }
}

export async function runMigrations(direction: 'up' | 'down' = 'up'): Promise<void> {
  const db = getDatabase();

  const migrator = new Migrator({
    db,
    provider: new DynamicMigrationProvider(),
  });

  if (direction === 'up') {
    console.log('[Migrator] Running migrations UP...');
    const { error, results } = await migrator.migrateToLatest();

    results?.forEach((it) => {
      if (it.status === 'Success') {
        console.log(`[Migrator] Migration "${it.migrationName}" was executed successfully.`);
      } else if (it.status === 'Error') {
        console.error(`[Migrator] Failed to execute migration "${it.migrationName}".`);
      }
    });

    if (error) {
      console.error('[Migrator] Failed to migrate:', error);
      process.exit(1);
    }
  } else {
    console.log('[Migrator] Running migration DOWN (step 1)...');
    const { error, results } = await migrator.migrateDown();

    results?.forEach((it) => {
      if (it.status === 'Success') {
        console.log(`[Migrator] Migration "${it.migrationName}" was reverted successfully.`);
      } else if (it.status === 'Error') {
        console.error(`[Migrator] Failed to revert migration "${it.migrationName}".`);
      }
    });

    if (error) {
      console.error('[Migrator] Failed to revert migration:', error);
      process.exit(1);
    }
  }

  await db.destroy();
}

// 允许命令行直接调用: tsx src/migrations/runner.ts up | down
const arg = process.argv[2];
if (arg === 'up' || arg === 'down') {
  runMigrations(arg)
    .then(() => {
      console.log(`[Migrator] Migration ${arg} finished.`);
      process.exit(0);
    })
    .catch((err) => {
      console.error('[Migrator] Fatal error:', err);
      process.exit(1);
    });
}
