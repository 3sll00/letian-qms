import { postJson } from './webhook-http.js';

export interface DeadLetterAlertPayload {
  eventId: string;
  aggregateType: string;
  aggregateId: string;
  eventType: string;
  retryCount: number;
  errorReason: string;
  failedAt: Date;
  payload?: Record<string, unknown>;
}

export interface IDeadLetterAlertNotifier {
  sendAlert(payload: DeadLetterAlertPayload): Promise<void>;
}

export interface WebhookConfig {
  webhookUrl?: string;
  timeoutMs?: number;
  headers?: Record<string, string>;
}

export class DeadLetterWebhookAdapter implements IDeadLetterAlertNotifier {
  private readonly webhookUrl: string | undefined;
  private readonly timeoutMs: number;
  private readonly headers: Record<string, string>;

  constructor(config?: WebhookConfig) {
    this.webhookUrl =
      config?.webhookUrl ||
      process.env.DEAD_LETTER_WEBHOOK_URL ||
      process.env.ALERT_WEBHOOK_URL ||
      undefined;
    this.timeoutMs = config?.timeoutMs ?? 5000;
    this.headers = {
      'Content-Type': 'application/json',
      ...(config?.headers || {}),
    };
  }

  async sendAlert(payload: DeadLetterAlertPayload): Promise<void> {
    const alertBody = {
      msgtype: 'markdown',
      markdown: {
        title: '【QMS 告警】Outbox 消息进入死信队列 (DEAD_LETTER)',
        text: `### 🚨 QMS Outbox 投递连续失败告警\n` +
          `> **事件 ID**: ${payload.eventId}\n` +
          `> **聚合类型**: ${payload.aggregateType} (ID: ${payload.aggregateId})\n` +
          `> **事件类型**: ${payload.eventType}\n` +
          `> **重试次数**: ${payload.retryCount} (已达上限，进入 DEAD_LETTER)\n` +
          `> **失败原因**: ${payload.errorReason}\n` +
          `> **失败时间**: ${payload.failedAt.toISOString()}\n`,
      },
      raw: payload,
    };

    if (!this.webhookUrl) {
      // 未配置 WebHook URL 时，打出结构化控制台错误日志，作为安全降级
      console.warn(`[DeadLetterWebhookAdapter] No DEAD_LETTER_WEBHOOK_URL configured. Alert logged:`, JSON.stringify(alertBody));
      return;
    }

    try {
      const response = await postJson(this.webhookUrl, alertBody, {
        headers: this.headers,
        timeoutMs: this.timeoutMs,
      });

      if (response.status < 200 || response.status >= 300) {
        throw new Error(`WEBHOOK_HTTP_${response.status}: ${response.statusText} | ${response.bodyText}`);
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[DeadLetterWebhookAdapter] Failed to send webhook alert:`, message);
      throw err;
    }
  }
}
