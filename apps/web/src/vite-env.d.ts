/// <reference types="vite/client" />

/**
 * Vite 注入到客户端的编译期环境变量。
 *
 * VITE_USE_MOCK：置为字符串 'true' 时才启用 MSW 离线 Mock（见 src/mocks/browser.ts）。
 * 未设置或其它取值时前端直连真实后端 /api/v1。
 *
 * VITE_API_BASE：构建期固化的 API 绝对基址（如 http://192.168.1.10:3000），
 * 未设置时按 src/lib/api.ts 的 resolveApiBase 优先级链回退到相对路径。
 */
interface ImportMetaEnv {
  readonly VITE_USE_MOCK?: string;
  readonly VITE_API_BASE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

/**
 * Electron 桌面端（apps/desktop）通过 preload 的 contextBridge 注入的运行时能力；
 * 纯浏览器环境为 undefined，业务代码使用前需可选链判空。
 */
interface Window {
  desktop?: {
    /** 服务器 API 基址（用户在「服务器设置」中配置并持久化），未配置时返回空串 */
    getServerUrl?: () => string | null;
    /** 打开桌面端「服务器设置」窗口 */
    openSettings?: () => void;
  };
}
