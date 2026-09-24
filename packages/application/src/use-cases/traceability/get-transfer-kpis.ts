import { IUnitOfWork } from '../../tx/unit-of-work.js';
import { TransferKpis, StageTransferKpi } from '@letian/contracts';

export interface GetTransferKpisQuery {
  startDate?: string;
  endDate?: string;
}

export class GetTransferKpisUseCase {
  constructor(private readonly uow: IUnitOfWork) {}

  public async execute(query?: GetTransferKpisQuery): Promise<TransferKpis> {
    return this.uow.execute(async (ctx) => {
      const orders = await ctx.inspectionOrders.findAll();

      let passCount = 0;
      let missingUpstreamCount = 0;
      let concessionPassCount = 0;
      let reworkPassCount = 0;
      let overridePassCount = 0;
      let blockedCount = 0;
      let terminatedCount = 0;

      const stageMap: Record<string, StageTransferKpi> = {
        IQC: { total: 0, passed: 0, blocked: 0, concession: 0, override: 0, missingUpstream: 0 },
        IPQC: { total: 0, passed: 0, blocked: 0, concession: 0, override: 0, missingUpstream: 0 },
        OQC_OUTSOURCE: { total: 0, passed: 0, blocked: 0, concession: 0, override: 0, missingUpstream: 0 },
        OQC_SH: { total: 0, passed: 0, blocked: 0, concession: 0, override: 0, missingUpstream: 0 },
      };

      const getStageKey = (type: string): string => {
        if (type.startsWith('IQC')) return 'IQC';
        if (type.startsWith('IPQC')) return 'IPQC';
        if (type === 'OQC_SH') return 'OQC_SH';
        // 委外七分类（OQC_SF / OQC_HEAT / OQC_BLACK / OQC_ZINC / OQC_NICKEL / OQC_PHOSPH / OQC_DACRO / OQC_MACH）
        // 全部归 OQC_OUTSOURCE —— 此前只认 SF/HEAT/MACH 三个，其余四个委外类型会掉进 OTHER
        if (type.startsWith('OQC_')) return 'OQC_OUTSOURCE';
        return 'OTHER';
      };

      for (const order of orders) {
        const dto = order as any;
        const stageKey = getStageKey(dto.inspectionType);
        if (!stageMap[stageKey]) {
          stageMap[stageKey] = { total: 0, passed: 0, blocked: 0, concession: 0, override: 0, missingUpstream: 0 };
        }
        stageMap[stageKey].total += 1;

        // 根据留痕字段 upstreamGateCode 统计
        const gateCode = (dto as any).upstreamGateCode ?? (dto as any).transferTrace?.upstreamGateCode;

        if (gateCode === 'UPSTREAM_OVERRIDDEN') {
          overridePassCount += 1;
          stageMap[stageKey].override += 1;
        } else if (gateCode === 'UPSTREAM_MISSING') {
          missingUpstreamCount += 1;
          stageMap[stageKey].missingUpstream += 1;
        } else if (gateCode === 'UPSTREAM_CONCESSION') {
          concessionPassCount += 1;
          stageMap[stageKey].concession += 1;
        } else if (gateCode === 'UPSTREAM_REWORK_PASSED') {
          reworkPassCount += 1;
          stageMap[stageKey].passed += 1;
        } else if (
          gateCode === 'UPSTREAM_FAILED' ||
          gateCode === 'UPSTREAM_INSPECTING' ||
          gateCode === 'UPSTREAM_UNDER_MRB'
        ) {
          blockedCount += 1;
          stageMap[stageKey].blocked += 1;
        } else if (gateCode === 'CHAIN_TERMINATED') {
          terminatedCount += 1;
          blockedCount += 1;
          stageMap[stageKey].blocked += 1;
        } else {
          // 缺省/UPSTREAM_PASSED
          passCount += 1;
          stageMap[stageKey].passed += 1;
        }
      }

      const total = orders.length;

      // 比率指标计算（0~100 保留 1 位小数）
      const blockRate = total > 0 ? Number(((blockedCount / total) * 100).toFixed(1)) : 0.0;
      const concessionRate = total > 0 ? Number(((concessionPassCount / total) * 100).toFixed(1)) : 0.0;
      const overrideRate = total > 0 ? Number(((overridePassCount / total) * 100).toFixed(1)) : 0.0;
      const missingUpstreamRate = total > 0 ? Number(((missingUpstreamCount / total) * 100).toFixed(1)) : 0.0;

      // 平均阻断处置时长（小时）：从下游首次被门禁阻断到该下游单最终放行（特采/复检/豁免）的耗时
      // 口径来源：docs/48 §12.5 / docs/50
      // 起点 = 该批次最早一条 audit_logs.action='GATE_BLOCKED' 的 createdAt
      // 终点 = 当前下游检验单 createdAt（放行途径：UPSTREAM_CONCESSION / UPSTREAM_REWORK_PASSED / UPSTREAM_OVERRIDDEN）
      // MRB 评审时间计入；尚未放行的阻断不计入分母。
      const blockedLogsPage = await ctx.auditLogs.queryLogs({
        action: 'GATE_BLOCKED',
        resourceType: 'INSPECTION_ORDER',
        limit: 1,
      });
      const earliestBlockedByBatch: Record<string, string> = {};
      if (blockedLogsPage.total > 0) {
        const allBlocked = await ctx.auditLogs.queryLogs({
          action: 'GATE_BLOCKED',
          resourceType: 'INSPECTION_ORDER',
          limit: blockedLogsPage.total,
        });
        for (const log of allBlocked.items) {
          const batchNo = log.resourceId;
          const current = earliestBlockedByBatch[batchNo];
          if (current === undefined || log.createdAt < current) {
            earliestBlockedByBatch[batchNo] = log.createdAt;
          }
        }
      }

      let totalDurationHours = 0;
      let durationCount = 0;

      for (const order of orders) {
        const dto = order as any;
        const gateCode = (dto as any).upstreamGateCode ?? (dto as any).transferTrace?.upstreamGateCode;
        const isReleased =
          gateCode === 'UPSTREAM_CONCESSION' ||
          gateCode === 'UPSTREAM_REWORK_PASSED' ||
          gateCode === 'UPSTREAM_OVERRIDDEN';
        if (!isReleased) continue;

        const start = earliestBlockedByBatch[dto.batchNo];
        const end = dto.createdAt;
        if (start !== undefined && end !== undefined) {
          const diffMs = Math.max(0, new Date(end).getTime() - new Date(start).getTime());
          if (diffMs > 0) {
            totalDurationHours += diffMs / (1000 * 3600);
            durationCount += 1;
          }
        }
      }

      const averageBlockDurationHours =
        durationCount > 0 ? Number((totalDurationHours / durationCount).toFixed(1)) : 0.0;

      return {
        totalInspections: total,
        passCount,
        missingUpstreamCount,
        concessionPassCount,
        reworkPassCount,
        overridePassCount,
        blockedCount,
        terminatedCount,
        blockRate,
        concessionRate,
        overrideRate,
        missingUpstreamRate,
        averageBlockDurationHours,
        stageBreakdown: stageMap,
        generatedAt: new Date().toISOString(),
      };
    });
  }
}
