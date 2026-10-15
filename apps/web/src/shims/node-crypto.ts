/**
 * node:crypto 的浏览器端垫片（vite resolve.alias 指向本文件）。
 * @letian/domain 为兼容 Node 14 部署包显式 `import { randomUUID } from 'node:crypto'`，
 * 浏览器侧等价能力即全局 crypto.randomUUID()。
 */
export const randomUUID = (): string => crypto.randomUUID();
