import { FastifyPluginAsync, type FastifyReply, type FastifyRequest } from "fastify";
import { z } from "zod";
import {
  QualityReportDataSchema,
  ReportSectionEnum,
  ReportTemplateScopeEnum,
  type InspectionItem,
  type InspectionOrder,
  type QualityReportData,
  type QualityReportTemplate,
  type ReportItemDecision,
  type ReportSection,
} from "@letian/contracts";
import { NotFoundError, ValidationFailedError } from "@letian/application";
import type { ApiContainer } from "../container";
import { appendDbAuditLog } from "../lib/audit-log";

const TemplateQuerySchema = z.object({
  scope: ReportTemplateScopeEnum.optional(),
  applicableType: z.string().optional(),
});

const ExportReportRequestSchema = z.object({
  orderId: z.string().uuid().optional(),
  orderNo: z.string().min(1).optional(),
  templateId: z.string().uuid().optional(),
  sections: z.array(ReportSectionEnum).optional(),
  format: z.enum(["PDF", "EXCEL", "JSON"]).default("PDF"),
});

const ALL_SECTIONS: readonly ReportSection[] = [
  "APPEARANCE",
  "DIMENSION",
  "MECHANICAL_PERFORMANCE",
  "CHEMICAL_COMPOSITION",
];

const ELEMENT_NAMES: Record<string, string> = {
  C: "碳",
  Si: "硅",
  Mn: "锰",
  P: "磷",
  S: "硫",
  Cr: "铬",
  Ni: "镍",
  Mo: "钼",
  Cu: "铜",
  V: "钒",
  Ti: "钛",
};

const CHINESE_ELEMENT_SYMBOLS: Record<string, string> = Object.fromEntries(
  Object.entries(ELEMENT_NAMES).map(([symbol, name]) => [name, symbol])
);

function normalizedText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  return text === "" ? undefined : text;
}

function optionalNumber(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function decisionOf(item: InspectionItem): ReportItemDecision {
  if (item.isExempt || item.result === "EXEMPT") return "EXEMPT";
  if (item.result === "PASSED" || item.result === "FAILED") return item.result;
  return "PENDING";
}

function sectionOf(item: InspectionItem): ReportSection {
  const category = String(item.metricCategory ?? "DIMENSION");
  if (category === "APPEARANCE") return "APPEARANCE";
  if (category === "CHEMICAL_COMPOSITION" || category === "TEXT_INTERVAL") {
    return "CHEMICAL_COMPOSITION";
  }
  if (
    category === "MECHANICAL_PERFORMANCE" ||
    category === "HARDNESS" ||
    category === "TENSILE_STRENGTH" ||
    category === "COATING_THICKNESS"
  ) {
    return "MECHANICAL_PERFORMANCE";
  }
  return "DIMENSION";
}

function bySeq(left: InspectionItem, right: InspectionItem): number {
  return (left.seq ?? 0) - (right.seq ?? 0);
}

function numericRequirement(item: InspectionItem): string | undefined {
  const nominal = optionalNumber(item.nominalValue);
  const upper = optionalNumber(item.upperTolerance);
  const lower = optionalNumber(item.lowerTolerance);
  if (nominal !== undefined && upper !== undefined && lower !== undefined) {
    return `${nominal - lower} ~ ${nominal + upper}`;
  }
  if (nominal !== undefined && upper !== undefined) return `≤ ${nominal + upper}`;
  if (nominal !== undefined && lower !== undefined) return `≥ ${nominal - lower}`;
  if (nominal !== undefined) return `标准值 ${nominal}`;
  return undefined;
}

function standardRequirement(item: InspectionItem): string {
  const standardText = normalizedText(item.standardText);
  if (standardText !== undefined) return standardText;
  const numeric = numericRequirement(item);
  if (numeric !== undefined) return numeric;
  const accepted = item.acceptableValues?.filter((value) => value.trim() !== "");
  if (accepted !== undefined && accepted.length > 0) {
    return `可接受值：${accepted.join(" / ")}`;
  }
  return "—";
}

function measuredResult(item: InspectionItem): string {
  const measuredText = normalizedText(item.measuredText);
  if (measuredText !== undefined) return measuredText;
  const measuredVal = optionalNumber(item.measuredVal);
  return measuredVal !== undefined ? String(measuredVal) : "未检";
}

function measuredValue(item: InspectionItem): number | undefined {
  return optionalNumber(item.measuredVal);
}

function elementSymbolOf(item: InspectionItem): string {
  const tokens = [item.itemCode, item.name]
    .flatMap((value) => String(value).toUpperCase().split(/[^A-Z]+/))
    .filter((token) => token !== "");
  for (const token of tokens) {
    const symbol = Object.keys(ELEMENT_NAMES).find(
      (key) => key.toUpperCase() === token
    );
    if (symbol !== undefined) return symbol;
  }
  for (const [name, symbol] of Object.entries(CHINESE_ELEMENT_SYMBOLS)) {
    if (item.name.includes(name)) return symbol;
  }
  return item.itemCode;
}

function buildReportData(
  order: InspectionOrder,
  template: QualityReportTemplate,
  requestedSections: readonly ReportSection[]
): QualityReportData {
  const items = [...(order.items ?? [])].sort(bySeq);
  const requested = new Set(requestedSections);
  const templateEnabled = new Set(template.enabledSections);
  const enabled = (section: ReportSection) =>
    requested.has(section) && templateEnabled.has(section);
  const itemsOf = (section: ReportSection) =>
    items.filter((item) => sectionOf(item) === section);

  const appearanceItems = enabled("APPEARANCE")
    ? itemsOf("APPEARANCE").map((item) => ({
        itemCode: item.itemCode,
        name: item.name,
        standardText: standardRequirement(item),
        measuredResult: measuredResult(item),
        conclusion: decisionOf(item),
        ...(normalizedText(item.defectReason) !== undefined
          ? { defectDescription: normalizedText(item.defectReason) }
          : {}),
      }))
    : [];

  const dimensionItems = enabled("DIMENSION")
    ? itemsOf("DIMENSION").map((item) => ({
        itemCode: item.itemCode,
        name: item.name,
        ...(optionalNumber(item.nominalValue) !== undefined
          ? { nominalValue: optionalNumber(item.nominalValue) }
          : {}),
        ...(optionalNumber(item.upperTolerance) !== undefined
          ? { upperTolerance: optionalNumber(item.upperTolerance) }
          : {}),
        ...(optionalNumber(item.lowerTolerance) !== undefined
          ? { lowerTolerance: optionalNumber(item.lowerTolerance) }
          : {}),
        ...(measuredValue(item) !== undefined ? { measuredVal: measuredValue(item) } : {}),
        ...(normalizedText(item.unit) !== undefined ? { unit: normalizedText(item.unit) } : {}),
        ...(item.sampleSize !== undefined ? { sampleSize: item.sampleSize } : {}),
        conclusion: decisionOf(item),
      }))
    : [];

  const mechanicalItems = enabled("MECHANICAL_PERFORMANCE")
    ? itemsOf("MECHANICAL_PERFORMANCE").map((item) => ({
        itemCode: item.itemCode,
        name: item.name,
        standardRequirement: standardRequirement(item),
        ...(optionalNumber(item.nominalValue) !== undefined
          ? { nominalValue: optionalNumber(item.nominalValue) }
          : {}),
        ...(measuredValue(item) !== undefined ? { measuredVal: measuredValue(item) } : {}),
        ...(normalizedText(item.unit) !== undefined ? { unit: normalizedText(item.unit) } : {}),
        // 继承来源只印真实留痕（docs/47 §3.6 / D10）：无来源即缺省，不得硬编码来源。
        ...(item.inheritedFrom !== undefined ? { inheritedFrom: item.inheritedFrom } : {}),
        isManuallyModified: Boolean(item.isManuallyModified),
        conclusion: decisionOf(item),
      }))
    : [];

  const chemicalItems = enabled("CHEMICAL_COMPOSITION")
    ? itemsOf("CHEMICAL_COMPOSITION").map((item) => {
        const element = elementSymbolOf(item);
        const nominal = optionalNumber(item.nominalValue);
        const lower = optionalNumber(item.lowerTolerance);
        const upper = optionalNumber(item.upperTolerance);
        return {
          element,
          elementName: ELEMENT_NAMES[element] ?? item.name,
          ...(normalizedText(item.standardText) !== undefined
            ? { standardText: normalizedText(item.standardText) }
            : {}),
          ...(nominal !== undefined && lower !== undefined
            ? { standardMin: nominal - lower }
            : {}),
          ...(nominal !== undefined && upper !== undefined
            ? { standardMax: nominal + upper }
            : {}),
          ...(measuredValue(item) !== undefined ? { measuredVal: measuredValue(item) } : {}),
          conclusion: decisionOf(item),
        };
      })
    : [];

  return QualityReportDataSchema.parse({
    reportNo: `RPT-${order.orderNo}`,
    orderNo: order.orderNo,
    templateId: template.id,
    templateCode: template.templateCode,
    materialCode: order.materialCode,
    materialName: order.materialName,
    ...(normalizedText(order.specification) !== undefined
      ? { materialSpec: normalizedText(order.specification) }
      : {}),
    batchNo: order.batchNo,
    ...(normalizedText(order.furnaceHeatNo) !== undefined
      ? { furnaceHeatNo: normalizedText(order.furnaceHeatNo) }
      : {}),
    ...(normalizedText(order.supplierName) !== undefined
      ? { supplierName: normalizedText(order.supplierName) }
      : {}),
    ...(normalizedText(order.customerName) !== undefined
      ? { customerName: normalizedText(order.customerName) }
      : {}),
    inspectionDate:
      normalizedText(order.inspectedDate) ??
      normalizedText(order.completedAt) ??
      normalizedText(order.createdAt) ??
      "",
    ...(normalizedText(order.inspectorName) !== undefined
      ? { inspectorName: normalizedText(order.inspectorName) }
      : {}),
    overallDecision:
      order.overallDecision ??
      (order.status === "PASSED" || order.status === "COMPLETED"
        ? "PASSED"
        : order.status === "FAILED"
          ? "FAILED"
          : "PENDING"),
    appearanceSection: {
      enabled: enabled("APPEARANCE"),
      items: appearanceItems,
    },
    dimensionSection: {
      enabled: enabled("DIMENSION"),
      items: dimensionItems,
    },
    mechanicalSection: {
      enabled: enabled("MECHANICAL_PERFORMANCE"),
      items: mechanicalItems,
    },
    chemicalSection: {
      enabled: enabled("CHEMICAL_COMPOSITION"),
      elements: chemicalItems,
    },
  });
}

export const reportTemplatesController: FastifyPluginAsync<{
  container: ApiContainer;
}> = async (fastify, options) => {
  const { container } = options;

  const handleGetTemplates = async (
    request: FastifyRequest,
    reply: FastifyReply
  ) => {
    const query = request.query as z.infer<typeof TemplateQuerySchema>;
    let templates = await container.reportEngine.listTemplates();
    if (query.scope) {
      templates = templates.filter((template) => template.scope === query.scope);
    }
    if (query.applicableType && query.applicableType !== "ALL") {
      templates = templates.filter((template) => {
        const applicableType = (template as { applicableType?: string }).applicableType;
        return applicableType === undefined || applicableType === "ALL" || applicableType === query.applicableType;
      });
    }
    return reply.status(200).send({
      items: templates,
      list: templates,
      total: templates.length,
    });
  };

  fastify.get("/report-templates", { schema: { querystring: TemplateQuerySchema } }, handleGetTemplates);
  fastify.get("/reports/templates", { schema: { querystring: TemplateQuerySchema } }, handleGetTemplates);

  fastify.post(
    "/reports/export",
    {
      schema: {
        body: ExportReportRequestSchema,
      },
    },
    async (request, reply) => {
      const body = request.body as z.infer<typeof ExportReportRequestSchema>;
      if (!body.orderId && !body.orderNo) {
        throw new ValidationFailedError('导出质检报告必须提供 orderId 或 orderNo');
      }

      const templates = await container.reportEngine.listTemplates();
      const template = body.templateId
        ? templates.find((item) => item.id === body.templateId)
        : templates.find((item) => item.isDefault) ?? templates[0];
      if (template === undefined) {
        throw new NotFoundError(`报告模板未找到: ${body.templateId ?? "DEFAULT"}`);
      }

      let order: InspectionOrder | null = null;
      if (body.orderId) {
        order = await container.repositories.orders.findById(body.orderId);
        if (!order) throw new NotFoundError(`检验单未找到: ${body.orderId}`);
      }
      if (body.orderNo) {
        const byOrderNo = await container.repositories.orders.findByOrderNo(body.orderNo);
        if (!byOrderNo) throw new NotFoundError(`检验单未找到: ${body.orderNo}`);
        if (order && order.id !== byOrderNo.id) {
          throw new ValidationFailedError('orderId 与 orderNo 指向不同的检验单');
        }
        order = byOrderNo;
      }
      if (!order) {
        throw new ValidationFailedError('导出质检报告必须提供 orderId 或 orderNo');
      }

      const reportData = buildReportData(order, template, body.sections ?? ALL_SECTIONS);
      const auditExport = () =>
        appendDbAuditLog(container.uow, request, {
          action: "UPDATE",
          resourceType: "QUALITY_REPORT",
          resourceId: reportData.orderNo,
          diffPatch: {
            templateId: template.id,
            templateCode: template.templateCode,
            format: body.format,
            sections: body.sections ?? ALL_SECTIONS,
          },
        });

      if (body.format === "JSON") {
        await auditExport();
        return reply.status(200).send({
          success: true,
          reportData,
        });
      }

      const rendered = await container.reportEngine.renderReport(
        template.id,
        reportData,
        body.format
      );
      await auditExport();

      reply.header("Content-Type", rendered.mimeType);
      reply.header(
        "Content-Disposition",
        `attachment; filename*=UTF-8''${encodeURIComponent(rendered.fileName)}`
      );
      return reply.send(Buffer.from(rendered.buffer));
    }
  );
};
