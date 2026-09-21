import { buildApp } from './app';

const PORT = Number(process.env.PORT) || 3100;
const HOST = process.env.HOST || '0.0.0.0';

async function main() {
  const app = await buildApp({ logger: true });

  try {
    await app.listen({ port: PORT, host: HOST });
    console.log(`[Letian QMS API] Server running on http://${HOST}:${PORT}`);
    console.log(`[Letian QMS API] OpenAPI Gateway base: http://${HOST}:${PORT}/api/v1`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

/**
 * 仅在以入口脚本方式直接运行时才监听端口。
 * 被测试或其他模块 import 时保持零副作用，避免测试进程意外占用 3100 端口。
 */
const entryScript = process.argv[1] ?? '';
if (/[\\/]server\.(ts|js|mjs|cjs)$/.test(entryScript)) {
  void main();
}
