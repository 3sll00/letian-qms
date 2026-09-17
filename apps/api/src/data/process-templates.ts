/**
 * 工序质检配置模板（进程内存储）
 *
 * ⚠️ 数据边界说明（重要）：
 * 1. 契约包没有 ProcessTemplate 的 Schema，数据库也没有对应表；
 *    因此本模块是**进程内可变存储**，POST 新建的模板在进程重启后丢失。
 * 2. 初始两条模板与旧内存数据集保持一致（同 id / 同工序编码），避免前端既有键值变化。
 * 3. 真正落地需要新增 process_templates 表 + 迁移 + 契约 Schema 扩展。
 */

export interface ProcessCheckItem {
  itemCode: string;
  name: string;
  standardText: string;
  nominalValue: number;
  upperTolerance: number;
  lowerTolerance: number;
}

export interface ProcessTemplate {
  id: string;
  processCode: string;
  processName: string;
  inspectionType: string;
  isMandatoryGate: boolean;
  defaultSampleQty: number;
  checkItems: ProcessCheckItem[];
  createdAt: string;
  updatedAt: string;
}

export const PROCESS_TEMPLATES: ProcessTemplate[] = [
  {
    id: 'd1a8e100-7777-4777-8777-000000000001',
    processCode: 'PROC-CT',
    processName: '下料',
    inspectionType: 'IPQC_CT',
    isMandatoryGate: false,
    defaultSampleQty: 8,
    checkItems: [
      {
        itemCode: 'ITEM-LEN-TOTAL',
        name: '下料总长度',
        standardText: '50.00 ± 0.20 mm',
        nominalValue: 50.0,
        upperTolerance: 0.2,
        lowerTolerance: 0.2,
      },
    ],
    createdAt: '2026-07-01T08:00:00Z',
    updatedAt: '2026-07-01T08:00:00Z',
  },
  {
    id: 'd1a8e100-7777-4777-8777-000000000002',
    processCode: 'PROC-FN',
    processName: '搓丝成型',
    inspectionType: 'IPQC_FN',
    isMandatoryGate: true,
    defaultSampleQty: 5,
    checkItems: [
      {
        itemCode: 'ITEM-HEX-AF',
        name: '对边宽度',
        standardText: '19.00 ± 0.10 mm',
        nominalValue: 19.0,
        upperTolerance: 0.1,
        lowerTolerance: 0.1,
      },
    ],
    createdAt: '2026-07-01T08:00:00Z',
    updatedAt: '2026-07-01T08:00:00Z',
  },
];
