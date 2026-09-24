import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { ApiContainer } from '../container';
import { operatorOf } from '../lib/operator';
import { requestTraceId } from '../lib/trace';

const ReleaseGateParamsSchema = z.object({
  batchNo: z.string().min(1, '批次号不能为空'),
});

/**
 * 成品检强制关卡放行校验控制器（MES 过站 / 出货前调用）
 *
 * 架构约束（docs/48 §8 硬约束 4 收敛后）：
 * 1. **判定不在本文件**：规则唯一实现在 `@letian/domain` 的 `evaluateStageVerdict`，
 *    由 `CheckReleaseGateUseCase` 调用 —— 与「合格后传递」建单门禁同一份口径。
 *    本控制器只把判定结果翻译成 HTTP（200 / 409 problem+json），不写任何 if 判定上游是否合格。
 * 2. 纯读语义：除了审计日志与 Outbox 事件（阻断也要留痕，供「这批为什么放不了」追溯）
 *    之外不写任何业务数据，不修改检验单状态。
 * 3. 409 阻断必须给出精确原因码（沿用既有取值，客户端零改动）：
 *    - GATE_NOT_INSPECTED（该批次无检验单）
 *    - GATE_INSPECTING    （检验尚未完成 / 返工复检中）
 *    - GATE_UNDER_MRB     （不合格正在进行 MRB 评审）
 *    - GATE_FAILED        （不合格且无生效放行结论；含链路终止）
 *    同时下发 `gateCode`（传递门禁理由码）与 `terminateChain`，供 MES 区分「等一等」与「整链终止」。
 */
export const releaseGatesController: FastifyPluginAsync<{ container: ApiContainer }> = async (
  fastify,
  options
) => {
  const { container } = options;

  fastify.get(
    '/:batchNo',
    {
      schema: {
        params: ReleaseGateParamsSchema,
      },
    },
    async (request, reply) => {
      const { batchNo } = request.params as z.infer<typeof ReleaseGateParamsSchema>;
      const operator = operatorOf(request);

      const result = await container.useCases.checkReleaseGate.execute({
        batchNo,
        gateType: 'OUTBOUND_SHIPMENT',
        operatorId: operator.userId,
        operatorName: operator.userName,
      });

      if (result.allowed) {
        return reply.status(200).send({
          allowed: true,
          batchNo: result.batchNo,
          inspectionOrderNo: result.inspectionOrderNo ?? null,
          inspectionStatus: result.inspectionStatus ?? null,
          overallDecision: result.overallDecision ?? null,
          // 受限放行（特采）：出货前必须能举证客户书面授权件
          dispositionDecision: result.releaseScope === 'CONCESSION' ? 'CONCESSION' : null,
          releaseScope: result.releaseScope ?? 'STANDARD',
          gateCode: result.gateCode,
          releasedAt: new Date().toISOString(),
          message: result.reason,
        });
      }

      const code = result.code ?? 'gate-failed';
      return reply
        .status(409)
        .header('Content-Type', 'application/problem+json')
        .send({
          type: `https://letian-qms.com/errors/${code}`,
          title: '成品检强制关卡拦截',
          status: 409,
          detail: result.reason,
          instance: request.url,
          code,
          traceId: requestTraceId(request),
          batchNo,
          requiredGate: 'OQC',
          gateCode: result.gateCode,
          inspectionOrderNo: result.inspectionOrderNo ?? null,
          mrbNo: result.mrbNo ?? null,
          terminateChain: result.terminateChain,
        });
    }
  );
};
