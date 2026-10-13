import { FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';

/**
 * Zod 契约校验插件
 *
 * 说明：Fastify 5 的 FastifySchema 已把 body/querystring/params/headers/response
 * 声明为 unknown，Zod Schema 可直接赋给这些槽位，因此这里不再做模块类型增强，
 * 避免与框架自身的声明冲突。
 */
const zodValidatorPluginAsync: FastifyPluginAsync = async (fastify) => {
  fastify.setValidatorCompiler(({ schema }) => {
    if (schema === undefined || schema === null) {
      return (data: unknown) => ({ value: data });
    }
    if (typeof (schema as { safeParse?: unknown }).safeParse !== 'function') {
      throw new Error('API route schema must be a Zod schema from the contracts layer');
    }
    const zodSchema = schema as {
      safeParse: (data: unknown) => { success: true; data: unknown } | { success: false; error: unknown };
    };
    return (data: unknown) => {
      const result = zodSchema.safeParse(data);
      if (!result.success) {
        return { error: result.error as Error };
      }
      return { value: result.data };
    };
  });

  fastify.setSerializerCompiler(({ schema }) => {
    if (schema === undefined || schema === null) {
      return (data: unknown) => JSON.stringify(data);
    }
    if (typeof (schema as { safeParse?: unknown }).safeParse !== 'function') {
      throw new Error('API response schema must be a Zod schema from the contracts layer');
    }
    const zodSchema = schema as {
      safeParse: (data: unknown) => { success: true; data: unknown } | { success: false; error: { issues: unknown } };
    };
    return (data: unknown) => {
      const result = zodSchema.safeParse(data);
      if (!result.success) {
        fastify.log.warn({ issues: result.error.issues }, 'Response serialization validation warning');
      }
      return JSON.stringify(result.success ? result.data : data);
    };
  });
};

export const zodValidatorPlugin = fp(zodValidatorPluginAsync, {
  name: 'fastify-zod-validator',
  fastify: '5.x',
});
