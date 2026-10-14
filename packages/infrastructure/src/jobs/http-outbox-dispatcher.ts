import type { EventDispatcher } from './outbox-dispatcher-job.js';
import { postJson } from './webhook-http.js';

export interface HttpOutboxDispatcherOptions {
  /** 通用 Outbox Sink URL；也可通过 OUTBOX_SINK_URL / OUTBOX_TARGET_URL 配置 */
  targetUrl?: string;
  timeoutMs?: number;
  headers?: Record<string, string>;
}

/**
 * 默认 HTTP Outbox Sink：POST 原始领域事件给外部事件网关。
 *
 * 投递是 at-least-once：下游必须以 `id` / `Idempotency-Key` 去重。
 * 未配置 Sink URL 时明确抛错进入重试，绝不把“没有发出去”误标成 PUBLISHED。
 */
export class HttpOutboxDispatcher implements EventDispatcher {
  private readonly targetUrl: string | undefined;
  private readonly timeoutMs: number;
  private readonly headers: Record<string, string>;

  constructor(options: HttpOutboxDispatcherOptions = {}) {
    this.targetUrl =
      options.targetUrl ||
      process.env.OUTBOX_SINK_URL ||
      process.env.OUTBOX_TARGET_URL ||
      undefined;
    this.timeoutMs = options.timeoutMs ?? 5000;
    this.headers = options.headers ?? {};
  }

  async dispatch(event: {
    id: string;
    aggregateType: string;
    aggregateId: string;
    eventType: string;
    payload: Record<string, unknown>;
  }): Promise<void> {
    if (!this.targetUrl) {
      throw new Error('OUTBOX_SINK_URL_NOT_CONFIGURED: 未配置 Outbox 事件投递目标');
    }

    const response = await postJson(this.targetUrl, event, {
      headers: {
        'Idempotency-Key': event.id,
        'X-Outbox-Event-Id': event.id,
        'X-Outbox-Event-Type': event.eventType,
        ...this.headers,
      },
      timeoutMs: this.timeoutMs,
    });

    if (response.status < 200 || response.status >= 300) {
      throw new Error(
        `OUTBOX_SINK_HTTP_${response.status}: ${response.statusText}${response.bodyText ? ` | ${response.bodyText}` : ''}`
      );
    }
  }
}
