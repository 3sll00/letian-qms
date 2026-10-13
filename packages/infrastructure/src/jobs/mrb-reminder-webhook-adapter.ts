export interface MrbReminderAlertPayload {
  mrbId: string;
  mrbNo: string;
  sourceOrderNo: string;
  batchNo: string;
  materialCode: string;
  materialName: string;
  status: 'PENDING_REVIEW' | 'UNDER_REVIEW';
  urgencyLevel: 'NORMAL' | 'URGENT' | 'CRITICAL';
  overdueHours: number;
  reminderCount: number;
  defectQty: number;
  defectDescription: string;
  remindedAt: Date;
}

export interface IMrbReminderNotifier {
  sendReminder(payload: MrbReminderAlertPayload): Promise<void>;
}

export interface MrbReminderWebhookConfig {
  webhookUrl?: string;
  timeoutMs?: number;
  headers?: Record<string, string>;
}

/**
 * MRB 超时催办 Webhook 适配器（兼容飞书/钉钉 markdown 机器人消息）。
 * 未配置 URL 时输出结构化控制台告警，作为开发环境安全降级。
 */
export class MrbReminderWebhookAdapter implements IMrbReminderNotifier {
  private readonly webhookUrl: string | undefined;
  private readonly timeoutMs: number;
  private readonly headers: Record<string, string>;

  constructor(config: MrbReminderWebhookConfig = {}) {
    this.webhookUrl =
      config.webhookUrl ||
      process.env.MRB_REMINDER_WEBHOOK_URL ||
      process.env.ALERT_WEBHOOK_URL ||
      undefined;
    this.timeoutMs = config.timeoutMs ?? 5000;
    this.headers = {
      'Content-Type': 'application/json',
      ...(config.headers ?? {}),
    };
  }

  async sendReminder(payload: MrbReminderAlertPayload): Promise<void> {
    const alertBody = {
      msgtype: 'markdown',
      markdown: {
        title: `【QMS 催办】MRB 超过 24 小时未裁决：${payload.mrbNo}`,
        text:
          `### ⚠️ MRB 超时催办\n` +
          `> **MRB 单号**: ${payload.mrbNo}\n` +
          `> **来源检验单**: ${payload.sourceOrderNo}\n` +
          `> **批次号**: ${payload.batchNo}\n` +
          `> **物料**: ${payload.materialName} (${payload.materialCode})\n` +
          `> **状态**: ${payload.status}\n` +
          `> **超时**: ${payload.overdueHours.toFixed(1)} 小时\n` +
          `> **催办次数**: ${payload.reminderCount}\n` +
          `> **不合格数量**: ${payload.defectQty}\n` +
          `> **缺陷描述**: ${payload.defectDescription}\n` +
          `> **催办时间**: ${payload.remindedAt.toISOString()}\n`,
      },
      raw: payload,
    };

    if (!this.webhookUrl) {
      console.warn(
        '[MrbReminderWebhookAdapter] No MRB_REMINDER_WEBHOOK_URL/ALERT_WEBHOOK_URL configured. Reminder logged:',
        JSON.stringify(alertBody)
      );
      return;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(this.webhookUrl, {
        method: 'POST',
        headers: this.headers,
        body: JSON.stringify(alertBody),
        signal: controller.signal,
      });

      if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new Error(`MRB_REMINDER_WEBHOOK_HTTP_${response.status}: ${response.statusText} | ${body}`);
      }
    } finally {
      clearTimeout(timeout);
    }
  }
}
