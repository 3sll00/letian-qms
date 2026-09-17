import type { TraceabilityGraphResponse } from '@letian/contracts';
import { ApplicationError } from '../../errors/application-error.js';
import type { IPdfExporterPort, ExportResult } from '../../ports/export-port.js';
import type { ISecurityContext } from '../../security/security-context.js';
import type { IUnitOfWork } from '../../tx/unit-of-work.js';
import { PenetrateBatchDagUseCase } from '../traceability/penetrate-batch-dag.js';

export interface ExportTraceReportCommand {
  rootBatchNo: string;
  direction?: 'UPSTREAM' | 'DOWNSTREAM' | 'BOTH';
  operatorId: string;
  operatorName?: string;
}

export class ExportTraceReportUseCase {
  constructor(
    private readonly uow: IUnitOfWork,
    private readonly traceDagUseCase: PenetrateBatchDagUseCase,
    private readonly pdfExporter?: IPdfExporterPort
  ) {}

  public async execute(
    cmd: ExportTraceReportCommand,
    securityCtx?: ISecurityContext
  ): Promise<ExportResult> {
    const graph: TraceabilityGraphResponse = await this.traceDagUseCase.execute(
      {
        batchNo: cmd.rootBatchNo,
        direction: cmd.direction ?? 'BOTH',
      },
      securityCtx
    );

    if (!this.pdfExporter) {
      throw new ApplicationError('EXPORTER_NOT_CONFIGURED', '未配置 PDF 导出适配器', 500);
    }

    const exportResult = await this.pdfExporter.generateDocument({
      title: '乐天紧固件全链路批次穿透追溯报告',
      subTitle: `根批次号: ${cmd.rootBatchNo} | 追溯方向: ${cmd.direction ?? 'BOTH'}`,
      reportNo: `TRC-${cmd.rootBatchNo}`,
      createdAt: new Date().toISOString(),
      watermark: '乐天追溯权威凭证',
      sections: [
        {
          title: '追溯概览与合规拓扑',
          type: 'KEY_VALUE',
          content: {
            rootBatchNo: cmd.rootBatchNo,
            nodeCount: graph.nodes.length,
            edgeCount: graph.edges.length,
            hasCycleWarning: graph.hasCycle ? 'true' : 'false',
          },
        },
        {
          title: '关联批次节点明细',
          type: 'TABLE',
          content: graph.nodes.map((n) => ({
            batchNo: n.batchNo,
            stageName: n.stageName,
            materialName: n.materialName,
            status: n.nodeStatus,
          })),
        },
        {
          title: '拓扑流向与加工工序',
          type: 'TABLE',
          content: graph.edges.map((e) => ({
            sourceBatch: e.sourceBatchNo,
            targetBatch: e.targetBatchNo,
            relationType: e.relationType,
            depth: e.depth,
          })),
        },
      ],
    });

    await this.uow.execute(async (ctx) => {
      await ctx.auditLogs.insert({
        id: crypto.randomUUID(),
        traceId: securityCtx?.traceId ?? crypto.randomUUID(),
        userId: cmd.operatorId,
        userName: cmd.operatorName ?? '追溯系统',
        action: 'UPDATE',
        resourceType: 'BATCH_TRACE',
        resourceId: cmd.rootBatchNo,
        status: 'SUCCESS',
        createdAt: new Date().toISOString(),
      });
    });

    return exportResult;
  }
}
