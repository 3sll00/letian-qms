import * as http from 'http';
import * as https from 'https';
import { URL } from 'url';

export interface PostJsonOptions {
  headers?: Record<string, string>;
  /** 请求整体超时（含建立连接），默认 5000ms */
  timeoutMs?: number;
}

export interface PostJsonResult {
  /** HTTP 状态码；网络层失败时不会走到 resolve */
  status: number;
  statusText: string;
  /** 响应体文本（UTF-8 解码），非 JSON 亦可 */
  bodyText: string;
}

type HttpTransport = Pick<typeof http, 'request'>;

/**
 * 基于 Node 内置 http/https 的 JSON POST 客户端。
 *
 * 使用它而不是全局 fetch：全局 fetch 要到 Node 18 才内置，而部署目标
 * Windows Server 2008 R2 只能运行 Node 14（最后一个支持该系统的版本）。
 * 不跟随 3xx 重定向（webhook 目标均为固定端点）；非 2xx 不抛错，
 * 由调用方按各自语义处理状态码。
 */
export function postJson(
  url: string,
  body: unknown,
  options: PostJsonOptions = {}
): Promise<PostJsonResult> {
  return new Promise((resolve, reject) => {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      reject(new Error(`INVALID_WEBHOOK_URL: ${url}`));
      return;
    }

    let transport: HttpTransport;
    if (parsed.protocol === 'https:') {
      transport = https;
    } else if (parsed.protocol === 'http:') {
      transport = http;
    } else {
      reject(new Error(`UNSUPPORTED_WEBHOOK_PROTOCOL: ${parsed.protocol}`));
      return;
    }

    const payload = Buffer.from(JSON.stringify(body), 'utf8');
    const timeoutMs = options.timeoutMs ?? 5000;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Content-Length': String(payload.length),
      ...options.headers,
    };

    const req = transport.request(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path: `${parsed.pathname}${parsed.search}`,
        method: 'POST',
        headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          resolve({
            status: res.statusCode ?? 0,
            statusText: res.statusMessage ?? '',
            bodyText: Buffer.concat(chunks).toString('utf8'),
          });
        });
        res.on('error', reject);
      }
    );

    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`WEBHOOK_TIMEOUT_AFTER_${timeoutMs}MS: ${url}`));
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}
