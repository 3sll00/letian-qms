/// <reference types="vite/client" />

/**
 * Vite 注入到客户端的编译期环境变量。
 *
 * VITE_USE_MOCK：置为字符串 'true' 时才启用 MSW 离线 Mock（见 src/mocks/browser.ts）。
 * 未设置或其它取值时前端直连真实后端 /api/v1。
 */
interface ImportMetaEnv {
  readonly VITE_USE_MOCK?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
