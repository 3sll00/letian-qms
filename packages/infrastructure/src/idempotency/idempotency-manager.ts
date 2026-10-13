import { createHash } from 'crypto';
import { Kysely, sql } from 'kysely';
import { Database } from '../database/schema.js';

export interface IdempotencyRecord {
  userId: string;
  endpoint: string;
  idempotencyKey: string;
  payloadHash: string;
  responseCode: number;
  responseBody: unknown;
  createdAt: Date;
  expiresAt: Date;
}

export interface CheckIdempotencyResult {
  isDuplicate: boolean;
  mismatchedPayload?: boolean;
  cachedResponse?: {
    statusCode: number;
    body: unknown;
  };
}

export class IdempotencyManager {
  constructor(private readonly db: Kysely<Database>) {}

  /**
   * 生成规范化的请求载荷 SHA-256 哈希
   */
  public computePayloadHash(payload: unknown): string {
    return IdempotencyManager.hashPayload(payload);
  }

  public static hashPayload(payload: unknown): string {
    const serializeCanonical = (val: unknown): unknown => {
      if (val === null || typeof val !== 'object') {
        return val;
      }
      if (Array.isArray(val)) {
        return val.map(serializeCanonical);
      }
      const sortedKeys = Object.keys(val as Record<string, unknown>).sort();
      const result: Record<string, unknown> = {};
      for (const key of sortedKeys) {
        result[key] = serializeCanonical((val as Record<string, unknown>)[key]);
      }
      return result;
    };

    const canonical = serializeCanonical(payload ?? {});
    const serialized = typeof payload === 'string' ? payload : JSON.stringify(canonical);
    return createHash('sha-256').update(serialized).digest('hex');
  }

  /**
   * 检查是否重复请求
   * 若找到且未过期：
   * - 若 payloadHash 相同，返回 cachedResponse (isDuplicate: true)
   * - 若 payloadHash 不同，返回 mismatchedPayload: true (表示同一个 key 发送了不同的载荷)
   * 若未找到或已过期，返回 isDuplicate: false
   */
  public async check(
    userId: string,
    endpoint: string,
    idempotencyKey: string,
    payload: unknown
  ): Promise<CheckIdempotencyResult> {
    const payloadHash = this.computePayloadHash(payload);
    const now = new Date();

    const record = await this.db
      .selectFrom('idempotencyKeys')
      .selectAll()
      .where('userId', '=', userId)
      .where('endpoint', '=', endpoint)
      .where('idempotencyKey', '=', idempotencyKey)
      .executeTakeFirst();

    if (!record) {
      return { isDuplicate: false };
    }

    // 检查是否已过期
    if (new Date(record.expiresAt).getTime() <= now.getTime()) {
      // 记录已过期，可以按新请求处理 (同时可触发延迟清理或直接允许覆盖)
      return { isDuplicate: false };
    }

    // 检查载荷哈希是否匹配
    if (record.payloadHash !== payloadHash) {
      return {
        isDuplicate: true,
        mismatchedPayload: true,
      };
    }

    return {
      isDuplicate: true,
      mismatchedPayload: false,
      cachedResponse: {
        statusCode: record.responseCode,
        body: record.responseBody,
      },
    };
  }

  /**
   * 存储/写入幂等结果 (严格 24 小时 TTL)
   */
  public async save(
    userId: string,
    endpoint: string,
    idempotencyKey: string,
    payload: unknown,
    responseCode: number,
    responseBody: unknown,
    ttlHours = 24
  ): Promise<void> {
    const payloadHash = this.computePayloadHash(payload);
    const now = new Date();
    const expiresAt = new Date(now.getTime() + ttlHours * 60 * 60 * 1000);

    // 使用 upsert 机制保证重新写入或插入 (复合主键 user_id, endpoint, idempotency_key)
    await this.db
      .insertInto('idempotencyKeys')
      .values({
        userId,
        endpoint,
        idempotencyKey,
        payloadHash,
        responseCode,
        responseBody: responseBody as any,
        createdAt: now,
        expiresAt,
      })
      .onConflict((oc) =>
        oc.columns(['userId', 'endpoint', 'idempotencyKey']).doUpdateSet({
          payloadHash,
          responseCode,
          responseBody: responseBody as any,
          createdAt: now,
          expiresAt,
        })
      )
      .execute();
  }

  /**
   * 清理已过期记录（兼容旧入口）。
   * limit 默认 1000，调用方循环调用即可完成分批清理。
   */
  public async purgeExpired(limit = 1000, now = new Date()): Promise<number> {
    const result = await sql`
      DELETE FROM idempotency_keys
      WHERE (user_id, endpoint, idempotency_key) IN (
        SELECT user_id, endpoint, idempotency_key
        FROM idempotency_keys
        WHERE expires_at <= ${now}
        ORDER BY expires_at ASC
        LIMIT ${limit}
      )
    `.execute(this.db);

    return Number(result.numAffectedRows || 0);
  }

  /**
   * 运维保留期清理：超过 created_at + retentionHours 的键一律删除；
   * 同时兜底删除 expires_at 已到期的记录，防止历史 TTL 异常导致残留。
   */
  public async purgeOlderThan(
    retentionHours = 24,
    limit = 1000,
    now = new Date()
  ): Promise<number> {
    const cutoff = new Date(now.getTime() - retentionHours * 60 * 60 * 1000);
    const result = await sql`
      DELETE FROM idempotency_keys
      WHERE (user_id, endpoint, idempotency_key) IN (
        SELECT user_id, endpoint, idempotency_key
        FROM idempotency_keys
        WHERE created_at <= ${cutoff} OR expires_at <= ${now}
        ORDER BY created_at ASC
        LIMIT ${limit}
      )
    `.execute(this.db);

    return Number(result.numAffectedRows || 0);
  }
}
