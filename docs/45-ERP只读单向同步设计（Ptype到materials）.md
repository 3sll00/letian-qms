# 45-ERP 只读单向同步设计（ERP -> QMS，Ptype -> materials）

需求原文：用户指令「把 ERP 和 QMS 做成只读同步：ERP -> QMS 单向只读，QMS 绝对不回写 ERP；先别做实时，先做定时同步（10 分钟或 1 小时）；告诉我需要动哪些文件、怎么验证、怎么保证只读；先同步一张表（Ptype 物料）跑通再扩」。

> 一句话口径：**ERP 是只读的上游主数据源，QMS 只往自己的镜像表写；任何"回写 ERP"的代码路径必须在下发 SQL 之前就被拦死。**

---

## 1. 现状核查（2026-09-23 实测）

| 事实 | 证据 |
|:---|:---|
| ERP 连接配置齐备 | `.env` 的 `ERP_DB_HOST/PORT/NAME/USER/PASSWORD` 均已填写（本机到 `:3433` 的 TCP 探测为**不可达**，故本轮所有验证走本地样例源） |
| 连接池在 `packages/infrastructure/src/adapters/erp-pool.ts` | `getErpConnectionPool()` / `closeErpConnectionPool()` |
| 运行期后端**不**直连 ERP | `packages/infrastructure/src/adapters/erp-adapter.ts` 注释与实现：ERP 数据已同步为本地镜像表，`ErpPort` 全部委托给 `KyselyMasterDataRepository` |
| 真正的 ERP 取数在离线脚本 | `packages/infrastructure/src/scripts/sync-master-data.ts`（`Stock` / `Btype` / `Ptype` 三段 upsert）；`adapters/external-adapters.ts` 另有 3 处直连查询 |
| 既有同步的三个缺陷 | ① `materials.category_code` **全表硬编码 `'FASTENER'`**，而库内合法分类是 `CAT-*`（实测 17 行全部 `CAT-*`），等于写入一个不存在的分类；② 无任何只读守门，脚本里手写 SQL 可直发；③ 无审计、无调度、异常被 `catch {}` 静默吞掉 |

---

## 2. 只读闸门：三道，缺一不可

| # | 闸门 | 位置 | 拦不住时会发生什么 |
|:--|:---|:---|:---|
| ① | **运行期断言**：SQL 必须以 `SELECT` / `WITH` 开头，且不得出现写关键字（`insert/update/delete/merge/truncate/drop/alter/create/into/exec/...`），命中即**抛错中止** | `packages/infrastructure/src/sync/erp-readonly.ts` | 同步整体失败（fail-closed），不会"警告后继续写" |
| ② | **单一入口**：`queryErpReadOnly()` 是唯一的 ERP 取数函数，内部先过 ①，并写入审计 | 同上 | 静态门禁 `pnpm verify:erp-readonly` 判 FAIL |
| ③ | **账号权限**（运维）：ERP 侧给 QMS 的登录只授 `db_datareader`（SQL Server 侧执行），需要更强隔离时可加 `ApplicationIntent=ReadOnly` | ERP 数据库管理员 | 即使前两道被改坏，物理上仍写不进去 |

设计取舍：**不做"记日志继续跑"**。只读约定一旦被一次手误破坏，产出的是**外部系统的脏数据**，事后清理成本远高于同步失败重跑。

---

## 3. 需要动哪些文件（逐项）

### 3.1 新增（本轮已落码）

| 文件 | 作用 |
|:---|:---|
| `packages/infrastructure/src/sync/erp-readonly.ts` | 闸门 ① + ②：`assertReadOnlyErpSql()` / `queryErpReadOnly()` / 审计数组 `erpReadOnlyAudit` |
| `packages/infrastructure/src/sync/erp-source.ts` | `ErpSource` 端口 + 两套实现：`createMssqlErpSource(pool)`（真 ERP，唯一低层下单点）、`loadFixtureErpSource(file)`（本地样例） |
| `packages/infrastructure/src/sync/ptype-sync.ts` | `Ptype -> materials` 映射与 upsert（幂等：按 `material_code`）；**分类不进 ERP**，映射不到就跳过并记账 |
| `packages/infrastructure/src/sync/index.ts` | 导出（已挂到 `packages/infrastructure/src/index.ts`） |
| `packages/infrastructure/src/scripts/sync-ptype.ts` | CLI：`--source=fixture\|erp`、`--limit`、`--category`、`--map`、`--dry-run`；退出码 `2` = 被只读闸门拦截 |
| `packages/infrastructure/fixtures/erp-ptype.sample.json` | 本地样例源（3 行），无 ERP 也能跑通最小闭环 |
| `packages/infrastructure/fixtures/erp-category-map.sample.json` | 分类映射样例：key = ERP 分类编码（`parentCode`）或料号前缀，`*` 为兜底 |
| `packages/infrastructure/src/__tests__/erp-readonly.test.ts` | 守门负面自检：8 条写语句必须被拦、写语句不得下发到连接（runner 调用 0 次）、合法查询计入审计 |
| `scripts/testing/erp-readonly-check.cjs` | 静态门禁：谁还能直连 ERP（豁免清单**冻结**，新增即 FAIL） |
| `scripts/testing/erp-sync-verify.cjs` | 端到端验收：真跑同步 + 逐字段对账 + 幂等 + 更新路径 + 只读审计，跑完清理 |

### 3.2 `sync-master-data.ts`（既有脚本）要改什么

1. **分类别再硬编码**：把 `categoryCode: 'FASTENER'` 换成与 `ptype-sync.ts` 相同的映射口径（映射不到就跳过并记账），否则每跑一次就往 `materials` 里灌一批非法分类；
2. **取数改走闸门**：三段查询改用 `createMssqlErpSource()` / `queryErpReadOnly()`，不再直接 `pool.request().query()`；
3. **别再静默 `catch {}`**：单行失败要计数并在摘要里输出（当前实现会把约束错误整批吞掉，对外只报 `Synced done.`）；
4. **纳入调度**：见 §6。`Stock` / `Btype` 两段按同样模式迁移即可，逻辑不变。

### 3.3 `ErpAdapter` 要改什么

**不改**。它现在的语义是"读 QMS 本地镜像表"，正是只读单向同步想要的终态：ERP 的连接只存在于同步层（CLI + 闸门），运行期 API 完全不碰 ERP。若要改，只建议补一行注释指向本文件，避免后来者以为它可以直连 ERP。

### 3.4 `materials` 镜像表要改什么

**本轮不改表结构**：

- `material_code` 已有 `UNIQUE` 约束，upsert 幂等性由它保证（本机实测两次同步：`inserted 3 -> unchanged 3`、表总行数不变）；
- 镜像新鲜度用既有 `updated_at` 表达（`onConflict.doUpdateSet` 会刷新）；
- 若后续需要**审计每次同步批次**（行数、开始/结束时间、失败原因），再新增 `erp_sync_runs` 台账表（迁移 034）—— 属 §7 的下一步，当前不引入迁移，避免为最小闭环增加风险。

---

## 4. 最小可运行方案（先跑通 Ptype，再扩表）

```powershell
# 0) 前置：库已启动并迁移到最新
pnpm db:local:start ; pnpm db:migrate

# 1) 空跑（只算不写）：确认数据源与分类映射都对
pnpm erp:sync:ptype -- --dry-run

# 2) 真跑：3 行样例物料写入 materials（本地样例源，不连 ERP）
pnpm erp:sync:ptype

# 3) 一键端到端验收（含幂等 / 更新路径 / 只读审计，跑完自动清理测试行）
pnpm verify:erp-sync

# 4) 换真 ERP：只改一个参数（需要本机到 ERP 网络可达 + 账号具备 db_datareader）
pnpm erp:sync:ptype -- --source=erp --limit=500 --map=packages/infrastructure/fixtures/erp-category-map.sample.json

# 5) 只读静态门禁：确认没有旁路
pnpm verify:erp-readonly
```

扩表顺序建议：`Ptype`（已通）-> `Btype`（供应商/客户）-> `Stock`（仓库）-> 单据类（`DlyndxSC` 等，需先与业务确认增量口径与时间窗）。

---

## 5. 验证方法（怎么证明"同步成功"且"没回写"）

### 5.1 自动化（本轮实测结果）

| # | 验证项 | 命令 | 结果（2026-09-23 实测） |
|:--|:---|:---|:---|
| 1 | 只读守门单测 | `pnpm --filter @letian/infrastructure test` | ✅ 8 条写语句全被拦；写语句 runner 调用 **0 次**、审计为空 |
| 2 | 静态门禁 | `pnpm verify:erp-readonly` | ✅ PASS（扫描 155 个 `.ts`；违规 0；遗留豁免 2 项打 WARN） |
| 3 | 端到端同步 | `pnpm verify:erp-sync` | ✅ **8/8 PASS**：首轮 `inserted=3`；逐字段对账 3 行 x 4 字段一致；二次同步 `unchanged=3` 且总行数 `20 -> 20`；改源后 `updated=1`；清理后残留 0 |
| 4 | 真库现状 | `SELECT material_code, material_name, spec_model, unit, category_code FROM materials WHERE material_code LIKE 'ERP-FIX-%'` | ✅ 验收后 0 行（探针自清） |

### 5.2 手工对账（真 ERP 到位后，按源库直查比对）

```sql
-- ① ERP 侧（SQL Server，只读）
SELECT COUNT(*) AS erp_rows FROM Ptype WHERE deleted = 0 AND sonnum = 0 AND UserCode IS NOT NULL AND UserCode <> N'';

-- ② QMS 侧（PostgreSQL）
SELECT COUNT(*) AS qms_rows FROM materials WHERE material_code IN (SELECT UserCode FROM ...);
```

更实际的做法是**按批次抽样对字段**（分类不是 ERP 字段，不参与对账）：

```sql
-- QMS 侧抽样：对照 ERP 导出样例逐列比对 material_code / material_name / spec_model / unit
SELECT material_code, material_name, spec_model, unit, updated_at
  FROM materials
 WHERE updated_at > now() - interval '10 minutes'   -- 只看本轮同步动过的行
 ORDER BY updated_at DESC
 LIMIT 50;
```

判据三条：① 本轮动过的行数 = ERP 侧符合过滤条件的行数（受 `--limit` 约束时按 `TOP` 口径）；② 抽样行四字段与 ERP 导出一致；③ `pnpm verify:erp-readonly` 仍 PASS 且审计里**只有 SELECT**。

---

## 6. 定时同步（先 10 分钟 / 1 小时，不做实时）

Windows 任务计划程序（无需驻留进程，失败可查日志）：

```powershell
# 每小时一次（真 ERP）
schtasks /Create /TN "LetianQMS-ERP-Sync-Ptype" /SC HOURLY /MO 1 `
  /TR "cmd /c cd /d D:\乐天\letian-qms && pnpm erp:sync:ptype -- --source=erp >> logs\erp-sync-ptype.log 2>&1" /F

# 若要 10 分钟一次：把 /SC HOURLY /MO 1 换成 /SC MINUTE /MO 10
# 查看 / 立即跑一次 / 删除
schtasks /Query /TN "LetianQMS-ERP-Sync-Ptype" /V /FO LIST
schtasks /Run   /TN "LetianQMS-ERP-Sync-Ptype"
schtasks /Delete /TN "LetianQMS-ERP-Sync-Ptype" /F
```

要点：

1. **单实例**：任务计划程序默认"若已在运行则不启动新实例"，天然避免重叠；
2. **失败可见**：退出码 `2` 表示被只读闸门拦住（按事故处理），`1` 是普通失败；日志追加到 `logs/erp-sync-ptype.log`；
3. **不做实时**：ERP 主数据变动不频繁，定时 + 幂等 upsert 已足够；实时推送要 ERP 侧配合（触发器 / 变更表），属另一期；
4. **QMS -> ERP 方向**：本设计**不提供**任何写回路径；将来若业务需要（例如回写检验结论），必须另立设计文档，并单独申请 ERP 侧写权限与审计。

---

## 7. 遗留与下一步

| # | 遗留 | 处置 |
|:--|:---|:---|
| R1 | `scripts/sync-master-data.ts` 与 `adapters/external-adapters.ts` 仍直连 ERP、绕过守门 | 按 §3.2 迁移到 `queryErpReadOnly()`；在收口前，静态门禁 `pnpm verify:erp-readonly` 会把它们打印为 WARN，并把"豁免清单"锁死（新增旁路直接 FAIL） |
| R2 | `sync-master-data.ts` 的 `categoryCode: 'FASTENER'` 硬编码未删 | 先别在真库跑这条老命令；收口时按 §3.2 第 1 条替换 |
| R3 | ERP `DlyndxSC.Number` 流水段形态、两条 2023 历史行是否补号 | 沿用 `docs/35` §R1 / §R2：拿到 ERP 导出样例后按先例补断言，业务代码不动 |
| R4 | 分类映射表当前是样例（`parentCode` 即 `CAT-*`） | 拿到 ERP 真实分类编码后替换 `erp-category-map.sample.json`；映射不到的行会**跳过并记账**，不会写错分类 |
| R5 | 无同步批次台账 | 需要时新建迁移 034 `erp_sync_runs`（批次号 / 表名 / 起止时间 / 源行数 / 增改数 / 跳过数 / 状态 / 错误） |

---

## 8. 变更记录

| 版本 | 日期 | 变更 |
|:---|:---|:---|
| v1.0.0 | 2026-09-23 | 新建。定稿 ERP -> QMS 单向只读口径与三道闸门；落码 `sync/` 四件套 + CLI + 样例源 + 分类映射 + 只读单测 + 静态门禁 + 端到端验收；实测 `pnpm verify:erp-sync` 8/8、`pnpm verify:erp-readonly` PASS；明确 `ErpAdapter` 不改、`materials` 本轮不改表结构，并登记 R1~R5 |
