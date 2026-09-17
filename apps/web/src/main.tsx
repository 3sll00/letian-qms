import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';
import './index.css';
import { enableMocking } from './mocks';

function renderMockStartupError(err: unknown) {
  const rootElement = document.getElementById('root');
  const message = err instanceof Error ? err.message : String(err);
  if (rootElement) {
    rootElement.innerHTML = `
      <div style="min-height:100vh;display:flex;align-items:center;justify-content:center;background:#020617;color:#e2e8f0;font-family:system-ui,sans-serif;">
        <div style="max-width:480px;padding:32px;border:1px solid #334155;border-radius:12px;background:#0f172a;">
          <h1 style="font-size:18px;font-weight:600;color:#f8fafc;margin:0 0 12px;">质量管理系统启动失败</h1>
          <p style="font-size:13px;color:#94a3b8;margin:0 0 12px;">
            Mock 服务初始化失败，页面无法加载实时质检数据。请刷新重试，或联系系统管理员。
          </p>
          <pre style="font-size:12px;color:#f87171;background:#020617;border:1px solid #7f1d1d;border-radius:8px;padding:12px;white-space:pre-wrap;word-break:break-all;margin:0;">${message}</pre>
        </div>
      </div>`;
  }
}

// Enable MSW before rendering React root
enableMocking()
  .then(() => {
    const rootElement = document.getElementById('root');
    if (rootElement) {
      ReactDOM.createRoot(rootElement).render(
        <React.StrictMode>
          <App />
        </React.StrictMode>
      );
    }
  })
  .catch((err) => {
    console.error('Failed to start MSW mock server:', err);
    renderMockStartupError(err);
  });
