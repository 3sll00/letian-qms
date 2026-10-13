import { buildApp } from './app';
import { createApiContainer } from './container';
import {
  MesSyncJob,
  MrbReminderJob,
  OutboxDispatcherJob,
  RetentionCleanupJob,
  readMesSyncOptionsFromEnv,
  readMrbReminderOptionsFromEnv,
  readOutboxDispatcherOptionsFromEnv,
  readRetentionCleanupOptionsFromEnv,
} from '@letian/infrastructure';

const PORT = Number(process.env.PORT) || 3100;
const HOST = process.env.HOST || '0.0.0.0';

async function main() {
  // server 显式持有容器：HTTP 用例与后台作业共享同一连接池/事务基础设施，
  // 同时保证 app.close() 时作业先停止、连接池再销毁。
  const container = createApiContainer();
  const app = await buildApp({ logger: true, container });

  // MES 自动同步调度：随服务启动、随服务关闭。
  const syncOptions = readMesSyncOptionsFromEnv();
  const mesSyncJob = new MesSyncJob(syncOptions);

  const { enabled: outboxEnabled, ...outboxOptions } = readOutboxDispatcherOptionsFromEnv();
  const outboxJob = new OutboxDispatcherJob(container.db, {
    ...outboxOptions,
    logger: (message) => app.log.info(message),
  });

  const { enabled: mrbReminderEnabled, ...mrbReminderOptions } = readMrbReminderOptionsFromEnv();
  const mrbReminderJob = new MrbReminderJob(container.db, {
    ...mrbReminderOptions,
    logger: (message) => app.log.info(message),
  });

  const { enabled: retentionEnabled, ...retentionOptions } = readRetentionCleanupOptionsFromEnv();
  const retentionJob = new RetentionCleanupJob(container.db, {
    ...retentionOptions,
    logger: (message) => app.log.info(message),
  });

  app.addHook('onClose', async () => {
    mesSyncJob.stop();
    outboxJob.stop();
    mrbReminderJob.stop();
    retentionJob.stop();
    await container.dispose();
  });

  if (syncOptions.enabled) {
    mesSyncJob.start();
  } else {
    app.log.info('[MES自动同步] 已关闭（MES_SYNC_ENABLED=false）');
  }

  if (outboxEnabled) {
    outboxJob.start();
  } else {
    app.log.info('[Outbox投递] 已关闭（OUTBOX_DISPATCHER_ENABLED=false）');
  }

  if (mrbReminderEnabled) {
    mrbReminderJob.start();
  } else {
    app.log.info('[MRB催办] 已关闭（MRB_REMINDER_ENABLED=false）');
  }

  if (retentionEnabled) {
    retentionJob.start();
  } else {
    app.log.info('[保留期清理] 已关闭（RETENTION_CLEANUP_ENABLED=false）');
  }

  try {
    await app.listen({ port: PORT, host: HOST });
    console.log(`[Letian QMS API] Server running on http://${HOST}:${PORT}`);
    console.log(`[Letian QMS API] OpenAPI Gateway base: http://${HOST}:${PORT}/api/v1`);
  } catch (err) {
    mesSyncJob.stop();
    outboxJob.stop();
    mrbReminderJob.stop();
    retentionJob.stop();
    await container.dispose().catch(() => undefined);
    app.log.error(err);
    process.exit(1);
  }
}

/**
 * 仅在以入口脚本方式直接运行时才监听端口。
 * 被测试或其他模块 import 时保持零副作用，避免测试进程意外占用 3100 端口。
 */
const entryScript = process.argv[1] ?? '';
if (/[\\/]server\.(ts|js|mjs|cjs)$/.test(entryScript)) {
  void main();
}
