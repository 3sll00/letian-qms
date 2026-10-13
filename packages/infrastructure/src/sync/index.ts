export * from './erp-readonly.js';
// 仅显式导出 erp-reads 所需符号：它与 erp-source 都导出了 normalizeLimit，
// 用 `export *` 会触发 TS2308 重复导出歧义，故此处按名导出。
export {
  createMssqlErpReads,
  createFixtureErpReads,
  type ErpReads,
  type ErpIncomingInspectionRow,
  type ErpFixtureData,
  INCOMING_INSPECTION_SELECT_SQL,
} from './erp-reads.js';
export * from './erp-source.js';
export * from './ptype-sync.js';
