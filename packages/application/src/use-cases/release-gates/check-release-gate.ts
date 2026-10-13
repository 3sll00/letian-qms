import type {
  InspectionOrder as InspectionOrderDTO,
  InspectionStatus,
  MRBDisposition,
  OverallDecision,
  TransferGateCode,
} from '@letian/contracts';
import { ErrorCode, type ErrorCodeType } from '@letian/contracts';
import { evaluateStageVerdict, pickAuthoritativeUpstream } from '@letian/domain';
import type { ISecurityContext } from '../../security/security-context.js';
import type { IUnitOfWork } from '../../tx/unit-of-work.js';

export interface CheckReleaseGateCommand {
  batchNo: string;
  gateType?: 'PROCESS_TRANSFER' | 'OUTBOUND_SHIPMENT';
  operatorId: string;
  operatorName?: string;
}

/**
 * 放行关卡判定结果（唯一实现，控制器只负责翻译成 HTTP）。
 *
 * `code` 沿用既有 `ErrorCode.GATE_*` 取值（MES 客户端**零改动**）；`gateCode` 是传递门禁的
 * 结构化理由码（`TransferGateCode`），供看板 / 报表按码分支。两者由**同一次判定**产出，
 * 因此不可能出现「关卡说合格、门禁说不合格」的矛盾（docs/48 §8 硬约束 4）。
 */
export interface ReleaseGateCheckResult {
  batchNo: string;
  allowed: boolean;
  /** 阻断原因码（既有的 GATE_* 语义，保持客户端兼容）；放行时为 undefined */
  code?: ErrorCodeType;
  /** 传递判定理由码（领域唯一真相的产出） */
  gateCode: TransferGateCode;
  reason: string;
  mandatoryGate: boolean;
  /** 参与判定的检验单（未找到任何检验单时缺省） */
  inspectionOrderNo?: string;
  inspectionStatus?: InspectionStatus;
  overallDecision?: OverallDecision;
  mrbNo?: string;
  mrbDisposition?: MRBDisposition;
  /** 退货 / 报废：整链终止（下游不得建单，已建未终判单冻结） */
  terminateChain: boolean;
  /** 受限放行（特采）：出货前必须能举证客户书面授权件 */
  releaseScope?: 'STANDARD' | 'CONCESSION';
}

/** 关卡类型与唯一可作为该关卡判据的检验类型 */
const RELEASE_GATE_STAGE = {
  PROCESS_TRANSFER: 'IPQC_FN',
  OUTBOUND_SHIPMENT: 'OQC_SH',
} as const;

/**
 * 成品 / 出货放行关卡校验（Mandatory Release Gate）。
 *
 * **与传递门禁同规则**（docs/48 §2.3 场景 4、§8 硬约束 4）：判定单张检验单是否已放行这件事
 * 只有一份实现 —— `@letian/domain` 的 `evaluateStageVerdict`。本用例只做三件**不涉及规则**的事：
 *   ① 挑出本批次的成品检单（多张时按 §2.4「最近一次终判 + 复检轮次最高」取权威，不用 `orders[0]`）；
 *   ② 按来源检验单号取该单的 MRB 结论，不借用同批次其它环节的 MRB；
 *   ③ 落审计与 Outbox（放行 `RELEASE_GATE_PASSED`，阻断 `RELEASE_GATE_BLOCKED`，终止 `CHAIN_TERMINATED`）。
 *
 * 与旧实现的两个实质差异（均来自 TBD-02 与 docs/48 §8）：
 *   - **判定合格即可放行**（不再要求 `status = COMPLETED`）—— 与传递门禁同批统一，避免一个放行一个阻断；
 *   - 阻断结果**作为返回值**而非异常抛出，使审计与 Outbox 不会随异常回滚（旧实现抛 422 时留痕一并消失）。
 */
export class CheckReleaseGateUseCase {
  constructor(private readonly uow: IUnitOfWork) {}

  public async execute(
    cmd: CheckReleaseGateCommand,
    securityCtx?: ISecurityContext
  ): Promise<ReleaseGateCheckResult> {
    return await this.uow.execute(async (ctx) => {
      // 与建单门禁共用同一把批次锁：避免「关卡校验」与「同批次建单」交错读到中间态
      await ctx.locks.acquireXactLock(`LOCK_ORDER_${cmd.batchNo}`);

      const traceId = securityCtx?.traceId ?? crypto.randomUUID();
      const gateType = cmd.gateType ?? 'OUTBOUND_SHIPMENT';
      const requiredStage = RELEASE_GATE_STAGE[gateType];
      const orders = await ctx.inspectionOrders.findByBatchNo(cmd.batchNo);

      const record = async (result: ReleaseGateCheckResult): Promise<ReleaseGateCheckResult> => {
        const basePatch = {
          gateType,
          gateCode: result.gateCode,
          inspectionOrderNo: result.inspectionOrderNo ?? null,
          mrbNo: result.mrbNo ?? null,
          terminateChain: result.terminateChain,
          reason: result.reason,
        };
        await ctx.auditLogs.insert({
          id: crypto.randomUUID(),
          traceId,
          userId: cmd.operatorId,
          userName: cmd.operatorName ?? '系统操作员',
          action: result.allowed ? 'STATUS_CHANGE' : 'GATE_BLOCKED',
          resourceType: 'RELEASE_GATE',
          resourceId: cmd.batchNo,
          status: result.allowed ? 'SUCCESS' : 'REJECTED',
          diffPatch: basePatch,
          createdAt: new Date().toISOString(),
        });
        await ctx.outbox.append({
          id: crypto.randomUUID(),
          aggregateType: 'ReleaseGate',
          aggregateId: cmd.batchNo,
          eventType: result.allowed ? 'RELEASE_GATE_PASSED' : 'RELEASE_GATE_BLOCKED',
          payload: {
            batchNo: cmd.batchNo,
            gateType,
            gateCode: result.gateCode,
            inspectionOrderNo: result.inspectionOrderNo ?? null,
            mrbNo: result.mrbNo ?? null,
            reason: result.reason,
            operatorId: cmd.operatorId,
          },
          traceId,
          occurredAt: new Date(),
          status: 'PENDING',
          retryCount: 0,
        });
        if (result.terminateChain) {
          // 链路终止单独成事件：ERP / 委外系统据此冻结发运与委外发出（TBD-07）
          await ctx.outbox.append({
            id: crypto.randomUUID(),
            aggregateType: 'ReleaseGate',
            aggregateId: cmd.batchNo,
            eventType: 'CHAIN_TERMINATED',
            payload: {
              batchNo: cmd.batchNo,
              gateType,
              inspectionOrderNo: result.inspectionOrderNo ?? null,
              mrbNo: result.mrbNo ?? null,
              reason: result.reason,
            },
            traceId,
            occurredAt: new Date(),
            status: 'PENDING',
            retryCount: 0,
          });
        }
        return result;
      };

      // 1. 未找到任何检验单 -> 未受检阻断（不可放行）
      if (orders.length === 0) {
        return await record({
          batchNo: cmd.batchNo,
          allowed: false,
          code: ErrorCode.GATE_NOT_INSPECTED,
          gateCode: 'UPSTREAM_MISSING',
          reason: `批次 [${cmd.batchNo}] 尚未进行关卡检验(${requiredStage})，禁止放行`,
          mandatoryGate: true,
          terminateChain: false,
        });
      }

      // 2. PBAC 数据权限隔离校验（取首单物料判定，fail-closed）
      if (securityCtx) {
        const firstOrder = orders[0]!;
        const material = await ctx.materials.getMaterialByCode(firstOrder.materialCode);
        securityCtx.assertAccess({
          targetCategory: material?.categoryCode ?? 'UNKNOWN',
          targetMaterialCode: firstOrder.materialCode,
          ...(firstOrder.supplierCode !== undefined
            ? { targetSupplierCode: firstOrder.supplierCode }
            : {}),
        });
      }

      // 3. 挑权威关卡检验单：过程放行只认 IPQC_FN，出货放行只认 OQC_SH。
      //    该批次只有其它环节的检验单 -> 等同「本关卡未受检」，必须阻断。
      //    不允许拿 OQC_SF 替代 OQC_SH，或拿其他 IPQC 环节替代成品检。
      const gateCandidates = orders.filter((order) => order.inspectionType === requiredStage);
      if (gateCandidates.length === 0) {
        return await record({
          batchNo: cmd.batchNo,
          allowed: false,
          code: ErrorCode.GATE_NOT_INSPECTED,
          gateCode: 'UPSTREAM_MISSING',
          reason: `批次 [${cmd.batchNo}] 无关卡检验(${requiredStage})单，禁止放行`,
          mandatoryGate: true,
          terminateChain: false,
        });
      }

      // 同类型多张按 §2.4（复检轮次最高 -> 最近一次终判）
      const inspection = pickAuthoritativeUpstream(
        gateCandidates.map((order) => ({ order }))
      )!.order as InspectionOrderDTO;

      // 4. 只认与权威检验单关联的 MRB，不借用同批次其它环节的放行结论。
      const mrb = await ctx.mrbReviews.findByOrderNo(inspection.orderNo);

      // 5. 判定：与传递门禁**同一份**领域纯函数
      const verdict = evaluateStageVerdict(inspection, mrb ?? undefined);

      const result: ReleaseGateCheckResult = {
        batchNo: cmd.batchNo,
        allowed: verdict.allowed,
        gateCode: verdict.code,
        reason: verdict.reason,
        mandatoryGate: true,
        inspectionOrderNo: inspection.orderNo,
        inspectionStatus: inspection.status,
        ...(inspection.overallDecision !== undefined
          ? { overallDecision: inspection.overallDecision }
          : {}),
        ...(verdict.mrbNo !== undefined ? { mrbNo: verdict.mrbNo } : {}),
        ...(verdict.mrbDisposition !== undefined ? { mrbDisposition: verdict.mrbDisposition } : {}),
        terminateChain: verdict.terminateChain,
        ...(verdict.code === 'UPSTREAM_CONCESSION'
          ? { releaseScope: 'CONCESSION' as const }
          : verdict.allowed
            ? { releaseScope: 'STANDARD' as const }
            : {}),
        ...(verdict.allowed ? {} : { code: httpGateCodeOf(verdict.code) }),
      };

      return await record(result);
    });
  }
}

/**
 * 传递理由码 -> 既有 HTTP 关卡原因码（客户端兼容映射，**只做展示层翻译，不参与判定**）。
 */
function httpGateCodeOf(gateCode: TransferGateCode): ErrorCodeType {
  switch (gateCode) {
    case 'UPSTREAM_UNDER_MRB':
      return ErrorCode.GATE_UNDER_MRB;
    case 'UPSTREAM_INSPECTING':
    case 'UPSTREAM_REINSPECTING':
      return ErrorCode.GATE_INSPECTING;
    case 'UPSTREAM_FAILED':
    case 'CHAIN_TERMINATED':
    default:
      return ErrorCode.GATE_FAILED;
  }
}
