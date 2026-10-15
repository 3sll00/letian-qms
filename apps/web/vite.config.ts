import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

// 后端 API 进程地址（apps/api，.env 中的 API_PORT=3100；3000 常被其他本地项目占用）。
// 前端 dev server 端口默认 31100（避开 5173 / 5174 等常用冲突端口），可由环境变量 VITE_PORT / WEB_PORT 覆盖。
// /api/* 全部反向代理到后端地址，浏览器侧仍是同源请求。
const API_TARGET = process.env.VITE_API_TARGET ?? 'http://127.0.0.1:3100';
const WEB_PORT = Number(process.env.VITE_PORT ?? process.env.WEB_PORT ?? 31100);

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      '@letian/contracts': path.resolve(__dirname, '../../packages/contracts/src'),
      // 领域层源码直连：录入页复用 evaluateInspectionItem 做客户端实时判标，
      // 与后端落库复判共用同一份判定口径（见 docs/17-检验录入界面说明与质检方案匹配口径.md §7）
      '@letian/domain': path.resolve(__dirname, '../../packages/domain/src'),
      // domain 为 Node 14 部署包显式引入 'node:crypto'；浏览器端改走全局 crypto 垫片
      'node:crypto': path.resolve(__dirname, './src/shims/node-crypto.ts'),
    },
  },
  server: {
    port: WEB_PORT,
    host: true,
    proxy: {
      '/api': {
        target: API_TARGET,
        changeOrigin: true,
      },
    },
  },
  preview: {
    port: WEB_PORT,
    host: true,
  },
});
