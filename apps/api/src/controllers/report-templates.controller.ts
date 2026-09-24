import { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import {
  ReportTemplateScopeEnum,
  ReportSectionEnum,
  type QualityReportData,
} from "@letian/contracts";
import { NotFoundError } from "@letian/application";
import type { ApiContainer } from "../container";
import { appendDbAuditLog } from "../lib/audit-log";

const TemplateQuerySchema = z.object({
  scope: ReportTemplateScopeEnum.optional(),
  applicableType: z.string().optional(),
});

const ExportReportRequestSchema = z.object({
  orderId: z.string().uuid().optional(),
  orderNo: z.string().optional(),
  templateId: z.string().optional(),
  sections: z.array(ReportSectionEnum).optional(),
  format: z.enum(["PDF", "EXCEL", "HTML", "JSON"]).default("PDF"),
  reportData: z.any().optional(),
});

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

export const reportTemplatesController: FastifyPluginAsync<{
  container: ApiContainer;
}> = async (fastify, options) => {
  const { container } = options;

  const handleGetTemplates = async (request: any, reply: any) => {
    const query = request.query as z.infer<typeof TemplateQuerySchema>;
    let templates = await container.reportEngine.listTemplates();
    if (query.scope) {
      templates = templates.filter((t: any) => t.scope === query.scope);
    }
    if (query.applicableType && query.applicableType !== "ALL") {
      templates = templates.filter(
        (t: any) => (t as any).applicableType === undefined || (t as any).applicableType === "ALL" || (t as any).applicableType === query.applicableType
      );
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

      let finalReportData: QualityReportData;

      if (body.reportData) {
        finalReportData = body.reportData as QualityReportData;
      } else {
        const orderId = body.orderId;
        const orderNo = body.orderNo;
        if (!orderId && !orderNo) {
          return reply.status(400).send({
            statusCode: 400,
            error: "BAD_REQUEST",
            message: "导出质检报告必须提供 orderId、orderNo 或 reportData",
          });
        }

        let order: any = null;
        if (orderId) {
          order = await container.repositories.orders.findById(orderId);
        }
        if (!order && orderNo) {
          order = await container.repositories.orders.findByOrderNo(orderNo);
        }
        if (!order) {
          throw new NotFoundError("检验单未找到: " + (orderId ?? orderNo));
        }

        const items: any[] = order.items ?? [];

        const appearanceItems = items
          .filter(
            (i) =>
              i.metricCategory === "APPEARANCE" ||
              i.itemCode?.includes("APP") ||
              i.name?.includes("外观") ||
              i.name?.includes("表面")
          )
          .map((i) => ({
            itemCode: i.itemCode ?? "APP-01",
            name: i.name ?? "外观质量",
            standardText: i.standardVal ?? "无瑕疵、光洁",
            measuredResult: i.measuredText ?? (i.measuredVal !== undefined ? String(i.measuredVal) : "合格"),
            conclusion: (i.isExempt ? "EXEMPT" : (i.judgment === "FAILED" ? "FAILED" : "PASSED")) as "PASSED" | "FAILED" | "EXEMPT",
          }));

        const dimensionItems = items
          .filter(
            (i) =>
              i.metricCategory === "DIMENSIONAL" ||
              i.metricCategory === "GEOMETRIC" ||
              (!i.metricCategory && (i.nominal !== undefined || i.upperTolerance !== undefined))
          )
          .map((i) => ({
            itemCode: i.itemCode ?? "DIM-01",
            name: i.name ?? "几何尺寸",
            nominalValue: i.nominal !== undefined ? Number(i.nominal) : undefined,
            upperTolerance: i.upperTolerance !== undefined ? Number(i.upperTolerance) : undefined,
            lowerTolerance: i.lowerTolerance !== undefined ? Number(i.lowerTolerance) : undefined,
            measuredVal: i.measuredVal !== undefined ? Number(i.measuredVal) : undefined,
            conclusion: (i.isExempt ? "EXEMPT" : (i.judgment === "FAILED" ? "FAILED" : "PASSED")) as "PASSED" | "FAILED" | "EXEMPT",
            unit: i.unit ?? "mm",
          }));

        const mechanicalItems = items
          .filter(
            (i) =>
              i.metricCategory === "MECHANICAL_PERFORMANCE" ||
              i.metricCategory === "HARDNESS" ||
              i.metricCategory === "TENSILE_STRENGTH" ||
              i.name?.includes("硬度") ||
              i.name?.includes("抗拉") ||
              i.name?.includes("屈服")
          )
          .map((i) => ({
            itemCode: i.itemCode ?? "MECH-01",
            name: i.name ?? "力学性能",
            standardRequirement: i.standardVal ?? (String(i.lowerTolerance ?? "") + " ~ " + String(i.upperTolerance ?? "")),
            measuredVal: i.measuredVal !== undefined ? Number(i.measuredVal) : undefined,
            conclusion: (i.isExempt ? "EXEMPT" : (i.judgment === "FAILED" ? "FAILED" : "PASSED")) as "PASSED" | "FAILED" | "EXEMPT",
            unit: i.unit ?? "MPa",
            isManuallyModified: Boolean(i.isManuallyModified),
            // 继承来源只印真实留痕（docs/47 §3.6 / D10）：无来源即缺省，
            // 不得再把缺失值硬编码成 OUTSOURCE_HEAT_TREATMENT —— 那会让证书谎称每行都从委外热处理带出。
            ...(i.inheritedFrom !== undefined ? { inheritedFrom: i.inheritedFrom } : {}),
          }));

        const chemicalItems = items
          .filter(
            (i) =>
              i.metricCategory === "CHEMICAL_COMPOSITION" ||
              ["C", "Si", "Mn", "P", "S", "Cr", "Ni", "Mo"].includes(i.name)
          )
          .map((i) => {
            const el = String(i.name).toUpperCase();
            return {
              element: el,
              elementName: ELEMENT_NAMES[el] ?? i.name,
              measuredVal: Number(i.measuredVal ?? 0),
              conclusion: (i.isExempt ? "EXEMPT" : (i.judgment === "FAILED" ? "FAILED" : "PASSED")) as "PASSED" | "FAILED" | "EXEMPT",
            };
          });

        const enabledSections = body.sections ?? ["APPEARANCE", "DIMENSION", "MECHANICAL_PERFORMANCE", "CHEMICAL_COMPOSITION"];

        finalReportData = {
          reportNo: "RPT-" + order.orderNo,
          orderNo: order.orderNo,
          materialCode: order.materialCode,
          materialName: order.materialName,
          batchNo: order.batchNo,
          inspectionDate: order.inspectionDate ? new Date(order.inspectionDate).toISOString() : new Date().toISOString(),
          inspectorName: order.inspectorName ?? "质检专员",
          overallDecision: order.overallDecision === "FAILED" ? "FAILED" : (order.overallDecision === "CONCESSION" ? "CONCESSION" : "PASSED"),
          appearanceSection: {
            enabled: enabledSections.includes("APPEARANCE"),
            items: appearanceItems,
          },
          dimensionSection: {
            enabled: enabledSections.includes("DIMENSION"),
            items: dimensionItems,
          },
          mechanicalSection: {
            enabled: enabledSections.includes("MECHANICAL_PERFORMANCE"),
            items: mechanicalItems,
          },
          chemicalSection: {
            enabled: enabledSections.includes("CHEMICAL_COMPOSITION"),
            elements: chemicalItems,
          },
        };
      }

      if (body.format === "JSON") {
        return reply.status(200).send({
          success: true,
          reportData: finalReportData,
        });
      }

      const targetFormat = body.format === "EXCEL" ? "EXCEL" : "PDF";
      const rendered = await container.reportEngine.renderReport(
        body.templateId ?? "TMPL-STD-A4-01",
        finalReportData,
        targetFormat
      );

      await appendDbAuditLog(container.uow, request, {
        action: "UPDATE",
        resourceType: "QUALITY_REPORT",
        resourceId: finalReportData.orderNo,
        diffPatch: {
          templateId: body.templateId,
          format: body.format,
          sections: body.sections,
        },
      });

      reply.header("Content-Type", rendered.mimeType);
      reply.header(
        "Content-Disposition",
        "attachment; filename=" + encodeURIComponent(rendered.fileName)
      );

      return reply.send(Buffer.from(rendered.buffer));
    }
  );
};
