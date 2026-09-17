import { setupWorker } from 'msw/browser';
import { handlers } from './handlers';

export const worker = setupWorker(...handlers);

/**
 * 是否启用 MSW 拦截。
 *
 * 默认关闭：前端直连真实后端（Vite `server.proxy` 把 `/api/*` 转发到 apps/api）。
 * 仅在显式设置 `VITE_USE_MOCK=true` 时启用离线 Mock，用于后端未启动时的界面走查。
 */
export function isMockEnabled(): boolean {
  return import.meta.env.VITE_USE_MOCK === 'true';
}

export async function enableMocking(): Promise<void> {
  if (!isMockEnabled()) {
    return;
  }
  await worker.start({
    onUnhandledRequest: 'bypass',
    serviceWorker: {
      url: '/mockServiceWorker.js',
    },
  });
}
