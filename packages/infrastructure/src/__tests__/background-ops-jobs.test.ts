import assert from 'node:assert/strict';
import { createDatabaseConnection } from '../database/connection.js';
import { KyselyMRBReviewRepository } from '../repositories/mrb-review-repository.js';
import { KyselyOutboxRepository } from '../repositories/outbox-repository.js';
import {
  MrbReminderJob,
  OutboxDispatcherJob,
  RetentionCleanupJob,
  type DeadLetterAlertPayload,
  type IDeadLetterAlertNotifier,
  type IMrbReminderNotifier,
  type MrbReminderAlertPayload,
} from '../jobs/index.js';

/**
 * QMS-009 后台运维任务真实库回归：
 * 1. Outbox 第 5 次失败进入 DEAD_LETTER 且告警送达后才写 dead_letter_alerted_at；
 * 2. MRB 超过 24h 未裁决自动催办、计数并升级为 CRITICAL；
 * 3. authorization_logs >180 天与 idempotency_keys >24h 被分批清理。
 */

class CapturingDeadLetterNotifier implements IDeadLetterAlertNotifier {
  public readonly payloads: DeadLetterAlertPayload[] = [];
  async sendAlert(payload: DeadLetterAlertPayload): Promise<void> {
    this.payloads.push(payload);
  }
}

class CapturingMrbNotifier implements IMrbReminderNotifier {
  public readonly payloads: MrbReminderAlertPayload[] = [];
  async sendReminder(payload: MrbReminderAlertPayload): Promise<void> {
    this.payloads.push(payload);
  }
}

async function main(): Promise<void> {
  const db = createDatabaseConnection();
  const runId = crypto.randomUUID();
  const outboxId = crypto.randomUUID();
  const mrbId = crypto.randomUUID();
  const oldAuthorizationLogId = crypto.randomUUID();
  const freshAuthorizationLogId = crypto.randomUUID();
  const idempotencyUserId = crypto.randomUUID();
  const endpoint = `ops-job-test-${runId}`;

  try {
    console.log('=== 后台运维任务真实库回归测试 ===');

    // ------------------------------------------------------------------
    // 1. Outbox：5 次失败 -> DEAD_LETTER + 告警
    // ------------------------------------------------------------------
    await db.insertInto('outboxEvents').values({
      id: outboxId,
      aggregateType: 'TEST',
      aggregateId: runId,
      eventType: 'OPS_TEST_EVENT',
      payload: { runId },
      status: 'PENDING',
      retryCount: 0,
      // 固定为全表最早创建时间：processBatch(batchSize=1) 只会先取测试事件，
      // 避免回归测试误消费库中真实待投递事件。
      createdAt: new Date('1970-01-01T00:00:00.000Z'),
      processedAt: null,
      nextRetryAt: null,
      deadLetterAlertedAt: null,
      traceId: `ops-test-${runId}`,
      errorReason: null,
    }).execute();

    let dispatchCount = 0;
    const deadLetterNotifier = new CapturingDeadLetterNotifier();
    const outboxJob = new OutboxDispatcherJob(db, {
      batchSize: 1,
      maxRetries: 5,
      backoffScheduleMs: [0, 0, 0, 0, 0],
      runOnStart: false,
      dispatcher: {
        dispatch: async () => {
          dispatchCount++;
          throw new Error(`dispatch failed ${dispatchCount}`);
        },
      },
      webhookAdapter: deadLetterNotifier,
      logger: () => undefined,
    });

    for (let attempt = 1; attempt <= 4; attempt++) {
      const result = await outboxJob.processBatch(new Date(Date.now() + 1000));
      assert.equal(result.failedCount, 1, `第 ${attempt} 次失败应重新排队等待下一次投递`);
      const failed = await db.selectFrom('outboxEvents').selectAll()
        .where('id', '=', outboxId).executeTakeFirstOrThrow();
      assert.equal(failed.status, 'FAILED');
      assert.equal(failed.retryCount, attempt);
      assert.ok(failed.nextRetryAt instanceof Date, 'FAILED 事件必须带 next_retry_at');
    }

    const fifth = await outboxJob.processBatch(new Date(Date.now() + 1000));
    assert.equal(fifth.deadLetterCount, 1, '第 5 次失败必须进入死信');
    assert.equal(dispatchCount, 5, '下游 Sink 应恰好被尝试 5 次');

    const deadLetter = await db.selectFrom('outboxEvents').selectAll()
      .where('id', '=', outboxId).executeTakeFirstOrThrow();
    assert.equal(deadLetter.status, 'DEAD_LETTER');
    assert.equal(deadLetter.retryCount, 5, '死信必须保留恰好 5 次失败计数');
    assert.equal(deadLetterNotifier.payloads.length, 1, '转死信必须触发一次告警');
    assert.equal(deadLetterNotifier.payloads[0]?.eventId, outboxId);
    assert.ok(deadLetter.deadLetterAlertedAt instanceof Date, '告警送达后必须落 dead_letter_alerted_at');

    const dueAfterDeadLetter = await new KyselyOutboxRepository(db)
      .findPendingEvents(100, new Date(Date.now() + 1000));
    assert.equal(
      dueAfterDeadLetter.some((event) => event.id === outboxId),
      false,
      'DEAD_LETTER 不得再次进入待投递队列'
    );
    assert.equal(dispatchCount, 5, 'DEAD_LETTER 不得再次投递');
    assert.equal(deadLetterNotifier.payloads.length, 1, '死信告警已成功送达后不得重复告警');
    console.log('✔ Outbox 五次失败转死信并告警');

    // ------------------------------------------------------------------
    // 2. MRB：超过 24h 未裁决 -> 自动催办 + CRITICAL 标红
    // ------------------------------------------------------------------
    // 固定为全表最早发起时间：batchSize=1 时只处理探针单，避免误催办真实超期 MRB。
    const oldMrbCreatedAt = new Date('1970-01-01T00:00:00.000Z');
    await db.insertInto('mrbReviews').values({
      id: mrbId,
      mrbNo: `MRB-OPS-${runId.slice(0, 8)}`,
      sourceType: 'INCOMING_FAIL',
      sourceOrderNo: `OPS-IQC-${runId.slice(0, 8)}`,
      batchNo: `OPS-B-${runId.slice(0, 8)}`,
      materialCode: 'OPS-MAT',
      materialName: '运维测试物料',
      workshopCode: null,
      defectDescription: '后台催办测试',
      defectQty: 10,
      status: 'PENDING_REVIEW',
      disposition: null,
      dispositionNotes: null,
      approvers: [],
      concessionAttachmentUrl: null,
      pendingDefectId: null,
      reviewFlowId: null,
      urgencyLevel: 'NORMAL',
      reviewNotes: null,
      disposedAt: null,
      disposedBy: null,
      createdAt: oldMrbCreatedAt,
      updatedAt: oldMrbCreatedAt,
      lastRemindedAt: null,
      reminderCount: 0,
    }).execute();

    const mrbNotifier = new CapturingMrbNotifier();
    const mrbJob = new MrbReminderJob(db, {
      batchSize: 1,
      overdueAfterMs: 24 * 60 * 60 * 1000,
      repeatIntervalMs: 24 * 60 * 60 * 1000,
      runOnStart: false,
      notifier: mrbNotifier,
      logger: () => undefined,
    });

    const mrbResult = await mrbJob.runOnce(new Date());
    assert.equal(mrbResult.reminded, 1, '超期未裁决 MRB 必须被催办');
    assert.equal(mrbNotifier.payloads.length, 1);
    assert.equal(mrbNotifier.payloads[0]?.mrbId, mrbId);

    const remindedMrb = await db.selectFrom('mrbReviews').selectAll()
      .where('id', '=', mrbId).executeTakeFirstOrThrow();
    assert.equal(remindedMrb.reminderCount, 1);
    assert.equal(remindedMrb.urgencyLevel, 'CRITICAL', '超时催办必须把单据升级为 CRITICAL 标红');
    assert.ok(remindedMrb.lastRemindedAt instanceof Date);

    const stillDue = await new KyselyMRBReviewRepository(db).findOverdueUndecided({
      overdueBefore: new Date(),
      remindAgainBefore: new Date(Date.now() - 24 * 60 * 60 * 1000),
      limit: 100,
    });
    assert.equal(
      stillDue.some((review) => review.id === mrbId),
      false,
      '重复检查周期内不得反复催办同一 MRB'
    );
    assert.equal(mrbNotifier.payloads.length, 1);
    console.log('✔ MRB 超过 24 小时未裁决自动催办');

    // ------------------------------------------------------------------
    // 3. 保留期：authorization_logs 180d + idempotency_keys 24h
    // ------------------------------------------------------------------
    // 在事务内运行并强制回滚：既能验证全局分批删除语义，
    // 又不会真正清除共享开发库中已有的历史日志/幂等键。
    const rollbackCleanup = new Error('__TEST_ROLLBACK__');
    let cleanupResult: Awaited<ReturnType<RetentionCleanupJob['runOnce']>> | null = null;
    try {
      await db.transaction().execute(async (trx) => {
        // 固定为全表最早创建时间：确保 LIMIT 批次先命中探针行。
        const oldAuthorizationCreatedAt = new Date('1970-01-01T00:00:00.000Z');
        await trx.insertInto('authorizationLogs').values([
          {
            id: oldAuthorizationLogId,
            userId: idempotencyUserId,
            userName: '运维测试员',
            roleCode: 'TEST',
            resourceType: 'OPS_JOB_TEST',
            resourceId: runId,
            materialCode: null,
            materialCategory: null,
            supplierCode: null,
            action: 'READ',
            decision: 'ALLOWED',
            matchedRuleId: null,
            detail: '181 天前权限日志',
            createdAt: oldAuthorizationCreatedAt,
          },
          {
            id: freshAuthorizationLogId,
            userId: idempotencyUserId,
            userName: '运维测试员',
            roleCode: 'TEST',
            resourceType: 'OPS_JOB_TEST',
            resourceId: runId,
            materialCode: null,
            materialCategory: null,
            supplierCode: null,
            action: 'READ',
            decision: 'ALLOWED',
            matchedRuleId: null,
            detail: '未到期权限日志',
            createdAt: new Date(),
          },
        ]).execute();

        await trx.insertInto('idempotencyKeys').values([
          {
            userId: idempotencyUserId,
            endpoint,
            idempotencyKey: 'old-key',
            payloadHash: 'a'.repeat(64),
            responseCode: 200,
            responseBody: { old: true },
            createdAt: oldAuthorizationCreatedAt,
            expiresAt: new Date(Date.now() - 60 * 60 * 1000),
          },
          {
            userId: idempotencyUserId,
            endpoint,
            idempotencyKey: 'fresh-key',
            payloadHash: 'b'.repeat(64),
            responseCode: 200,
            responseBody: { old: false },
            createdAt: new Date(),
            expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
          },
        ]).execute();

        const retentionJob = new RetentionCleanupJob(trx, {
          authorizationLogRetentionDays: 180,
          idempotencyRetentionHours: 24,
          batchSize: 10,
          maxBatchesPerKind: 3,
          runOnStart: false,
          logger: () => undefined,
        });
        cleanupResult = await retentionJob.runOnce(new Date());

        assert.ok(cleanupResult.authorizationLogsDeleted >= 1);
        assert.ok(cleanupResult.idempotencyKeysDeleted >= 1);
        assert.equal(
          await trx.selectFrom('authorizationLogs').select('id').where('id', '=', oldAuthorizationLogId).executeTakeFirst(),
          undefined,
          '超过 180 天的权限校验日志必须被清理'
        );
        assert.ok(
          await trx.selectFrom('authorizationLogs').select('id').where('id', '=', freshAuthorizationLogId).executeTakeFirst(),
          '未超过 180 天的权限校验日志必须保留'
        );
        assert.equal(
          await trx.selectFrom('idempotencyKeys').select('idempotencyKey')
            .where('userId', '=', idempotencyUserId)
            .where('endpoint', '=', endpoint)
            .where('idempotencyKey', '=', 'old-key')
            .executeTakeFirst(),
          undefined,
          '超过 24 小时的幂等键必须被清理'
        );
        assert.ok(
          await trx.selectFrom('idempotencyKeys').select('idempotencyKey')
            .where('userId', '=', idempotencyUserId)
            .where('endpoint', '=', endpoint)
            .where('idempotencyKey', '=', 'fresh-key')
            .executeTakeFirst(),
          '未超过 24 小时的幂等键必须保留'
        );
        throw rollbackCleanup;
      });
    } catch (error: unknown) {
      if (error !== rollbackCleanup) throw error;
    }
    assert.ok(cleanupResult, '保留期清理作业必须返回删除统计');
    console.log('✔ 180 天权限日志与 24 小时幂等键分批清理');

    console.log('=== 后台运维任务回归测试全部通过 ===');
  } finally {
    await db.deleteFrom('outboxEvents').where('id', '=', outboxId).execute().catch(() => undefined);
    await db.deleteFrom('mrbReviews').where('id', '=', mrbId).execute().catch(() => undefined);
    await db.deleteFrom('authorizationLogs').where('id', 'in', [oldAuthorizationLogId, freshAuthorizationLogId]).execute().catch(() => undefined);
    await db.deleteFrom('idempotencyKeys')
      .where('userId', '=', idempotencyUserId)
      .where('endpoint', '=', endpoint)
      .execute()
      .catch(() => undefined);
    await db.destroy();
  }
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  const code = typeof err === 'object' && err !== null && 'code' in err ? (err as { code?: string }).code : undefined;
  if (code === 'ECONNREFUSED' || code === 'ENOTFOUND' || message.includes('ECONNREFUSED')) {
    console.warn('[SKIP] 本地 PostgreSQL 未启动，跳过后台运维任务真实库测试');
    process.exit(0);
  }
  console.error('后台运维任务测试失败:', err);
  process.exit(1);
});
