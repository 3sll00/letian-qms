import { HeatBatchTraceService, type HeatTraceSourceType } from '@letian/domain';
import { NotFoundError } from '../../errors/application-error.js';
import type { ISecurityContext } from '../../security/security-context.js';
import type { IUnitOfWork } from '../../tx/unit-of-work.js';

/**
 * 检验单「炉批号相关表头字段」更新命令（docs/47 §4.5）。
 *
 * 覆盖 炉批号 / 材质牌号 / 执行技术标准 / 检验日期 四个**表头业务事实**字段 ——
 * 此前出货检验（OQC_SH）表头根本没有写路径：录入人在界面上填的炉号只进证书与页面状态，
 * 提交后既不落库、也无法被后续单据关联（docs/47 D1）。
 */
export interface UpdateInspectionHeatFieldsCommand {
  orderId: string;
  /** 炉批号；空串 = 清空（连带清空溯源留痕）；缺省 = 不改动该列 */
  furnaceHeatNo?: string;
  materialGrade?: string;
  techStandard?: string;
  inspectedDate?: string;
  operatorId: string;
  operatorName: string;
}

export interface UpdateInspectionHeatFieldsResult {
  orderId: string;
  orderNo: string;
  /** 更新后的炉批号（清空后为 null） */
  furnaceHeatNo: string | null;
  /** 服务端解析出的带出源：NONE 表示该炉批号在本物料下没有可用上游记录 */
  sourceType: HeatTraceSourceType;
  sourceOrderNo: string | null;
  /** 命中范围：MATERIAL = 同物料命中（可作为留痕）；GLOBAL = 跨物料命中（只提示、不留痕） */
  matchScope: 'MATERIAL' | 'GLOBAL';
  /** 解析出的带出项数量（供界面回执与探针断言，不落库） */
  inheritedItemCount: number;
}

/**
 * 炉批号表头更新用例（`PATCH /inspections/{id}/header`）。
 *
 * 两条硬口径：
 * 1. **带出源由服务端重新解析**，请求体不接受客户端自称来源
 *    （与「签核人取自会话」同一条信任边界，docs/47 §4.6）；
 * 2. 只有 `matchScope = MATERIAL`（同物料命中）才写入溯源留痕 —— 跨物料命中只是给录入人的
 *    提示，把别的物料的炉次记成本单的溯源来源会让「本单数据从哪来」的结论失真（docs/47 §3.4）。
 */
export class UpdateInspectionHeatFieldsUseCase {
  constructor(private readonly uow: IUnitOfWork) {}

  public async execute(
    cmd: UpdateInspectionHeatFieldsCommand,
    securityCtx?: ISecurityContext
  ): Promise<UpdateInspectionHeatFieldsResult> {
    return await this.uow.execute(async (ctx) => {
      const existing = await ctx.inspectionOrders.findById(cmd.orderId);
      if (existing === null) {
        throw new NotFoundError(`检验单不存在: ${cmd.orderId}`);
      }

      const nextHeatNo = cmd.furnaceHeatNo === undefined ? undefined : cmd.furnaceHeatNo.trim();

      // 服务端解析（仅当本次确实写了非空炉批号）
      let sourceType: HeatTraceSourceType = 'NONE';
      let sourceOrderNo: string | null = null;
      let matchScope: 'MATERIAL' | 'GLOBAL' = 'GLOBAL';
      let inheritedItemCount = 0;

      if (nextHeatNo !== undefined && nextHeatNo !== '') {
        // 仓储侧**不按物料过滤**：跨物料回落（先同物料、同物料无命中才放宽并标 GLOBAL，docs/47 §3.4）
        // 由领域服务判定；若 SQL 先把跨物料行滤掉，「跨物料命中」这条口径永远不可达（AC-10 提示静默消失）。
        const candidates = await ctx.inspectionOrders.findByFurnaceHeatNo(nextHeatNo);

        // 自单不参与关联（避免把自己当上游）
        const trace = HeatBatchTraceService.resolveHeatBatchData({
          heatBatchNo: nextHeatNo,
          materialCode: existing.materialCode,
          historicalOrders: candidates.filter((candidate) => candidate.id !== existing.id),
        });

        matchScope = trace.matchScope;
        inheritedItemCount = trace.inheritedItems.length;
        if (trace.sourceType !== 'NONE' && trace.matchScope === 'MATERIAL') {
          sourceType = trace.sourceType;
          sourceOrderNo = trace.sourceOrderNo ?? null;
        }
      }

      await ctx.inspectionOrders.updateHeatHeaderFields(cmd.orderId, {
        ...(cmd.furnaceHeatNo !== undefined ? { furnaceHeatNo: cmd.furnaceHeatNo } : {}),
        ...(cmd.materialGrade !== undefined ? { materialGrade: cmd.materialGrade } : {}),
        ...(cmd.techStandard !== undefined ? { techStandard: cmd.techStandard } : {}),
        ...(cmd.inspectedDate !== undefined ? { inspectedDate: cmd.inspectedDate } : {}),
        // 炉批号被显式写入（含清空）时，溯源留痕随之一起落库 / 清空：
        // 空串在仓储侧落 NULL，避免「新炉号 + 旧源单号」错配（docs/47 §4.4）。
        ...(cmd.furnaceHeatNo !== undefined
          ? {
              heatSourceType: sourceType === 'NONE' ? '' : sourceType,
              heatSourceOrderNo: sourceOrderNo ?? '',
            }
          : {}),
      });

      await ctx.auditLogs.insert({
        id: crypto.randomUUID(),
        traceId: securityCtx?.traceId ?? crypto.randomUUID(),
        userId: cmd.operatorId,
        userName: cmd.operatorName,
        action: 'UPDATE',
        resourceType: 'INSPECTION_ORDER',
        resourceId: cmd.orderId,
        status: 'SUCCESS',
        diffPatch: {
          field: 'HEAT_HEADER',
          orderNo: existing.orderNo,
          ...(cmd.furnaceHeatNo !== undefined ? { furnaceHeatNo: nextHeatNo } : {}),
          ...(cmd.materialGrade !== undefined ? { materialGrade: cmd.materialGrade } : {}),
          ...(cmd.techStandard !== undefined ? { techStandard: cmd.techStandard } : {}),
          ...(cmd.inspectedDate !== undefined ? { inspectedDate: cmd.inspectedDate } : {}),
          heatSourceType: sourceType,
          heatSourceOrderNo: sourceOrderNo,
          matchScope,
          inheritedItemCount,
        },
        createdAt: new Date().toISOString(),
      });

      return {
        orderId: cmd.orderId,
        orderNo: existing.orderNo,
        furnaceHeatNo: nextHeatNo === undefined ? (existing.furnaceHeatNo ?? null) : nextHeatNo === '' ? null : nextHeatNo,
        sourceType,
        sourceOrderNo,
        matchScope,
        inheritedItemCount,
      };
    });
  }
}
