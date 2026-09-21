import { InspectionItem, InspectionOrder } from '@letian/contracts';

export interface HeatBatchTraceRecord {
  heatBatchNo: string;
  sourceType: 'OUTSOURCE_HEAT_TREATMENT' | 'IQC_RAW_MATERIAL' | 'NONE';
  sourceOrderNo?: string;
  sourceOrderId?: string | undefined;
  inspectedAt?: string | undefined;
  inheritedItems: Array<{
    itemCode: string;
    name: string;
    metricCategory: string;
    measuredVal?: number | undefined;
    measuredText?: string | undefined;
    unit?: string | undefined;
  }>;
}

/**
 * 炉批号历史数据追溯服务 (HeatBatchTraceService)
 * 优先级链路：
 * 1. 优先检索【委外检验 - 热处理工艺】(OQC_HEAT) 已合格工单；
 * 2. 若未找到，回退检索【IQC 来料检验】已合格工单；
 * 3. 若均未找到，返回 NONE 状态，由质检员现场录入。
 */
export class HeatBatchTraceService {
  public static resolveHeatBatchData(params: {
    heatBatchNo: string;
    historicalOrders: readonly InspectionOrder[];
  }): HeatBatchTraceRecord {
    const { heatBatchNo, historicalOrders } = params;

    if (!heatBatchNo || heatBatchNo.trim() === '') {
      return {
        heatBatchNo: '',
        sourceType: 'NONE',
        inheritedItems: []
      };
    }

    const trimmedBatch = heatBatchNo.trim();

    // 1. 优先匹配委外热处理工单 (OQC_HEAT)
    const outsourceHeatOrder = historicalOrders.find(o => 
      o.furnaceHeatNo === trimmedBatch &&
      o.inspectionType === 'OQC_HEAT' &&
      (o.status === 'PASSED' || o.status === 'COMPLETED')
    );

    if (outsourceHeatOrder) {
      return {
        heatBatchNo: trimmedBatch,
        sourceType: 'OUTSOURCE_HEAT_TREATMENT',
        sourceOrderNo: outsourceHeatOrder.orderNo,
        sourceOrderId: outsourceHeatOrder.id,
        inspectedAt: outsourceHeatOrder.updatedAt ?? outsourceHeatOrder.createdAt,
        inheritedItems: HeatBatchTraceService.extractInheritableItems(outsourceHeatOrder.items)
      };
    }

    // 2. 次优匹配 IQC 来料检验单
    const iqcOrder = historicalOrders.find(o =>
      o.furnaceHeatNo === trimmedBatch &&
      o.inspectionType === 'IQC' &&
      (o.status === 'PASSED' || o.status === 'COMPLETED')
    );

    if (iqcOrder) {
      return {
        heatBatchNo: trimmedBatch,
        sourceType: 'IQC_RAW_MATERIAL',
        sourceOrderNo: iqcOrder.orderNo,
        sourceOrderId: iqcOrder.id,
        inspectedAt: iqcOrder.updatedAt ?? iqcOrder.createdAt,
        inheritedItems: HeatBatchTraceService.extractInheritableItems(iqcOrder.items)
      };
    }

    // 3. 均未命中
    return {
      heatBatchNo: trimmedBatch,
      sourceType: 'NONE',
      inheritedItems: []
    };
  }

  private static extractInheritableItems(items: readonly InspectionItem[]) {
    return items
      .filter(i => 
        i.metricCategory === 'MECHANICAL_PERFORMANCE' || 
        i.metricCategory === 'CHEMICAL_COMPOSITION' ||
        i.metricCategory === 'HARDNESS' ||
        i.metricCategory === 'TENSILE_STRENGTH'
      )
      .map(i => ({
        itemCode: i.itemCode,
        name: i.name,
        metricCategory: i.metricCategory,
        measuredVal: i.measuredVal,
        measuredText: i.measuredText,
        unit: i.unit
      }));
  }
}
