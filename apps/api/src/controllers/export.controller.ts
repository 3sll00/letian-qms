import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { InspectionTypeEnum, type InspectionOrder } from '@letian/contracts';
import { ApplicationError } from '@letian/application';
import type { ApiContainer } from '../container';
import { appendDbAuditLog } from '../lib/audit-log';

const ExportQuerySchema = z.object({
  format: z.enum(['csv', 'xlsx']).default('csv'),
  inspectionType: InspectionTypeEnum.optional(),
  batchNo: z.string().optional(),
  keyword: z.string().optional(),
});

/** 单次分页拉取行数（导出需要全量数据，按页循环读取以避免一次性大查询） */
const EXPORT_PAGE_SIZE = 200;
/** 安全上限，避免异常条件下无界循环 */
const EXPORT_MAX_ROWS = 20000;

/** CSV 单元格转义：含分隔符/引号/换行时用双引号包裹并转义内部引号 */
function csvCell(value: string | number | undefined | null): string {
  if (value === undefined || value === null) return '';
  const text = String(value);
  if (/[",\n\r]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

export const exportController: FastifyPluginAsync<{ container: ApiContainer }> = async (
  fastify,
  options
) => {
  const { container } = options;
  const orders = container.repositories.orders;

  fastify.get(
    '/inspections',
    {
      schema: {
        querystring: ExportQuerySchema,
      },
    },
    async (request, reply) => {
      const query = request.query as z.infer<typeof ExportQuerySchema>;

      // xlsx 需要 Excel 导出适配器实现（application 层的 IExcelExporterPort），
      // 当前仓库没有该适配器；此前会静默返回 CSV 字节但文件名后缀为 .csv，
      // 对下游导入方属于"格式与内容不符"，因此这里明确拒绝而不是继续返回 CSV。
      if (query.format === 'xlsx') {
        throw new ApplicationError(
          'EXPORTER_NOT_CONFIGURED',
          '当前未配置 Excel 导出适配器，暂不支持 format=xlsx，请使用 format=csv',
          501
        );
      }

      // 循环分页读取全量命中数据
      const collected: InspectionOrder[] = [];
      let page = 1;
      let total = 0;
      do {
        const result = await orders.listOrders({
          page,
          pageSize: EXPORT_PAGE_SIZE,
          ...(query.inspectionType !== undefined ? { inspectionType: query.inspectionType } : {}),
          ...(query.batchNo !== undefined ? { batchNo: query.batchNo } : {}),
          ...(query.keyword !== undefined ? { keyword: query.keyword } : {}),
        });
        total = result.total;
        collected.push(...result.list);
        page += 1;
      } while (collected.length < total && collected.length < EXPORT_MAX_ROWS);

      const headers = ['检验单号', '检验类型', '批次号', '物料编码', '物料名称', '状态', '综合结论', '质检员', '创建时间'];
      const rows = collected.map((item) => [
        csvCell(item.orderNo),
        csvCell(item.inspectionType),
        csvCell(item.batchNo),
        csvCell(item.materialCode),
        csvCell(item.materialName),
        csvCell(item.status),
        csvCell(item.overallDecision ?? '无'),
        csvCell(item.inspectorId ?? '未指派'),
        csvCell(item.createdAt ?? ''),
      ]);

      const csvContent = [headers.join(','), ...rows.map((r) => r.join(','))].join('\n');

      await appendDbAuditLog(container.uow, request, {
        action: 'UPDATE',
        resourceType: 'EXPORT_TASK',
        resourceId: `export-inspections-${Date.now()}`,
        diffPatch: { count: collected.length, total, format: query.format },
      });

      reply.header('Content-Type', 'text/csv; charset=utf-8');
      reply.header('Content-Disposition', `attachment; filename="inspections-export-${Date.now()}.csv"`);
      return reply.send(csvContent);
    }
  );
};
