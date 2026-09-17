import { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { ErrorCode, type InspectionOrder } from '@letian/contracts';
import type { ApiContainer } from '../container';
import { requestTraceId } from '../lib/trace';

const ReleaseGateParamsSchema = z.object({
  batchNo: z.string().min(1, '批次号不能为空'),
});

/** 需要成品检(OQC)的检验类型 */
const OQC_TYPES = ['OQC_SF', 'OQC_SH'] as const;

/**
 * 成品检强制关卡放行状态纯读校验控制器
 *
 * 关键架构约束：
 * 1. MES 过站前调用，纯读幂等无副作用
 * 2. 绝不写审计日志，绝不触发写操作
 * 3. 409 阻断必须给出精确原因码：
 *    - GATE_NOT_INSPECTED (未找到检验单或未送检)
 *    - GATE_INSPECTING (检验尚未完成)
 *    - GATE_FAILED (检验不合格且未取得让步接收)
 *    - GATE_UNDER_MRB (不合格正在进行 MRB 评审)
 *
 * 放行判定规则与 application/use-cases/release-gates/check-release-gate.ts 保持一致：
 * 工单必须处于终态 COMPLETED，且 overallDecision 不为 FAILED；
 * 若 overallDecision 为 FAILED，则必须存在状态为 DISPOSED 且处置方式为
 * CONCESSION(让步接收) 的 MRB 评审单，否则阻断。
 *
 * 阻断响应必须与全局错误处理器一样，以 application/problem+json 返回，
 * 并携带 traceId，客户端才能用同一套逻辑解析所有失败响应。
 */
function blocked(
  request: FastifyRequest,
  reply: FastifyReply,
  batchNo: string,
  code: string,
  detail: string
) {
  return reply
    .status(409)
    .header('Content-Type', 'application/problem+json')
    .send({
      type: `https://letian-qms.com/errors/${code}`,
      title: '成品检强制关卡拦截',
      status: 409,
      detail,
      instance: request.url,
      code,
      traceId: requestTraceId(request),
      batchNo,
      requiredGate: 'OQC',
    });
}

function allowed(
  reply: FastifyReply,
  order: InspectionOrder,
  disposition: string | null,
  message: string
) {
  return reply.status(200).send({
    allowed: true,
    batchNo: order.batchNo,
    inspectionOrderNo: order.orderNo,
    inspectionStatus: order.status,
    overallDecision: order.overallDecision ?? null,
    dispositionDecision: disposition,
    releasedAt: new Date().toISOString(),
    message,
  });
}

export const releaseGatesController: FastifyPluginAsync<{ container: ApiContainer }> = async (
  fastify,
  options
) => {
  const { container } = options;
  const orders = container.repositories.orders;
  const mrbReviews = container.repositories.mrbReviews;

  fastify.get(
    '/:batchNo',
    {
      schema: {
        params: ReleaseGateParamsSchema,
      },
    },
    async (request, reply) => {
      const { batchNo } = request.params as z.infer<typeof ReleaseGateParamsSchema>;

      // 优先取该批次的成品检验单(OQC)，其次回退到该批次的任意检验单
      const batchOrders = await orders.findByBatchNo(batchNo);
      const inspection =
        batchOrders.find((item) =>
          (OQC_TYPES as readonly string[]).includes(item.inspectionType)
        ) ?? batchOrders[0];

      // 1. 未找到检验单 -> 未受检阻断
      if (!inspection) {
        return blocked(
          request,
          reply,
          batchNo,
          ErrorCode.GATE_NOT_INSPECTED,
          `批次 [${batchNo}] 尚未进行成品出厂检验(OQC)，禁止放行入库或发货`
        );
      }

      const mrbRecord = await mrbReviews.findByBatchNo(batchNo);

      // 2. 尚未结单归档 -> 分流给出精确原因
      if (inspection.status !== 'COMPLETED') {
        // 2.1 已判定不合格或已进入 MRB 流程
        if (inspection.status === 'FAILED' || inspection.status === 'IN_MRB_REVIEW') {
          if (mrbRecord && (mrbRecord.status === 'PENDING_REVIEW' || mrbRecord.status === 'UNDER_REVIEW')) {
            return blocked(
              request,
              reply,
              batchNo,
              ErrorCode.GATE_UNDER_MRB,
              `批次 [${batchNo}] 检验不合格，当前正在 MRB 不合格品评审流程中 (单号: ${mrbRecord.mrbNo})`
            );
          }
          return blocked(
            request,
            reply,
            batchNo,
            ErrorCode.GATE_FAILED,
            `批次 [${batchNo}] 检验不合格，且无生效的让步接收(CONCESSION)特采结论，系统强行阻断`
          );
        }

        // 2.2 待检 / 检验中 / 暂存 / 复检中，或已判定合格但尚未结单归档
        const pendingHint =
          inspection.status === 'PASSED'
            ? '检验已判定合格但尚未结单归档'
            : '正在检验中或待检验，尚未得出最终放行结论';
        return blocked(
          request,
          reply,
          batchNo,
          ErrorCode.GATE_INSPECTING,
          `批次 [${batchNo}] ${pendingHint} (当前状态: ${inspection.status})`
        );
      }

      // 3. 已结单归档：核对最终判定结论
      if (inspection.overallDecision === 'FAILED') {
        // 3.1 仍在 MRB 评审中 -> 阻断
        if (mrbRecord && (mrbRecord.status === 'PENDING_REVIEW' || mrbRecord.status === 'UNDER_REVIEW')) {
          return blocked(
            request,
            reply,
            batchNo,
            ErrorCode.GATE_UNDER_MRB,
            `批次 [${batchNo}] 检验不合格，当前正在 MRB 不合格品评审流程中 (单号: ${mrbRecord.mrbNo})`
          );
        }

        // 3.2 已处置为让步接收(特采) -> 受限放行
        if (mrbRecord && mrbRecord.status === 'DISPOSED' && mrbRecord.disposition === 'CONCESSION') {
          return allowed(
            reply,
            inspection,
            'CONCESSION',
            '批次经 MRB 专家评审判定为特采/让步放行，允许受限流转'
          );
        }

        // 3.3 其余情况（含 MRB 判定返工/退货/报废、或未发起 MRB）-> 阻断
        return blocked(
          request,
          reply,
          batchNo,
          ErrorCode.GATE_FAILED,
          `批次 [${batchNo}] 检验不合格，且无生效的让步接收(CONCESSION)特采结论，系统强行阻断`
        );
      }

      // 4. 判定合格（PASSED / CONCESSION）-> 放行
      return allowed(
        reply,
        inspection,
        inspection.overallDecision === 'CONCESSION' ? 'CONCESSION' : null,
        '批次已通过成品全检，准予放行过站'
      );
    }
  );
};
