// 迁移脚本本身通过 runner 的 DynamicMigrationProvider 注册，
// 不在此处 export *（否则 001/002 各自的 up/down 会在包根形成重名冲突导出）。
export * from './runner.js';
