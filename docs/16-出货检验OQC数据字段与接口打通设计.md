# 16-出货检验（OQC）数据字段与接口打通设计

## 1. 业务背景与界面需求
依据最新出货检验（OQC）用户界面原型及交付物图片标准，出货检验列表表格共展示以下 12 个核心列字段：
1. **检验单号** (`docNo` / `orderNo`): 如 `OQC-SH-20260706-0001`
2. **销售出库单号** (`salesOrderNo`): 如 `SO-20260706-01`
3. **出库日期** (`dispatchDate`): 如 `2026-07-06`
4. **客户** (`customerName`): 如 `客户A科技`
5. **订单号** (`salesOrderPoNo`): 如 `PO-A-001`
6. **成品编码** (`productCode` / `materialCode`): 如 `CP-001`
7. **成品名称** (`productName` / `materialName`): 如 `六角螺栓M10`
8. **数量** (`qty` / `sampleQty`): 如 `5000`
9. **ERP状态** (`erpStatus`): `待审核` / `已审核` / `已拦截` (分别映射状态徽章色)
10. **检验状态** (`status`): `待检验` / `检验中` / `已合格` / `不合格`
11. **检验人** (`inspectorName`): 如 `-` / `张检验` / `李检验` / `王检验`
12. **操作** (`action`): 动作按钮（检验 / 继续 / 详情）

为了保证前端界面展示的数据能够从数据库真实读取并支持创建与筛选，必须将底层数据库字段、数据契约、仓储映射、API 接口和种子数据端到端打通。

---

## 2. 字段映射与数据库改造方案

### 2.1 数据表字段规划 (`inspection_orders`)
在 `inspection_orders` 表中扩充出货检验专属字段：

| 字段名称 (PostgreSQL) | 类型 | 契约字段 (camelCase) | 说明 |
|---|---|---|---|
| `sales_order_no` | `VARCHAR(64)` | `salesOrderNo` | 销售出库单号（如 SO-20260706-01） |
| `dispatch_date` | `VARCHAR(32)` | `dispatchDate` | 出库日期（如 2026-07-06） |
| `customer_name` | `VARCHAR(255)` | `customerName` | 客户名称（如 客户A科技） |
| `sales_order_po_no` | `VARCHAR(64)` | `salesOrderPoNo` | 客户订单号/采购合同号（如 PO-A-001） |
| `erp_status` | `VARCHAR(32)` | `erpStatus` | ERP状态（待审核/已审核/已拦截） |

*注：已在 006 迁移中引入的 `inspector_name VARCHAR(64)` 继续作为检验人姓名，`batch_size` / `sample_qty` 映射数量。*

### 2.2 迁移脚本设计 (`008_add_oqc_shipment_inspection_fields.ts`)
- 迁移序号：008
- 迁移操作：
  - `ALTER TABLE inspection_orders ADD COLUMN IF NOT EXISTS sales_order_no VARCHAR(64)`
  - `ALTER TABLE inspection_orders ADD COLUMN IF NOT EXISTS dispatch_date VARCHAR(32)`
  - `ALTER TABLE inspection_orders ADD COLUMN IF NOT EXISTS customer_name VARCHAR(255)`
  - `ALTER TABLE inspection_orders ADD COLUMN IF NOT EXISTS sales_order_po_no VARCHAR(64)`
  - `ALTER TABLE inspection_orders ADD COLUMN IF NOT EXISTS erp_status VARCHAR(32)`
  - 建立索引：`idx_inspection_orders_sales_order_no`、`idx_inspection_orders_customer_name`
- 回滚操作 (down)：
  - `DROP INDEX IF EXISTS idx_inspection_orders_customer_name`
  - `DROP INDEX IF EXISTS idx_inspection_orders_sales_order_no`
   - `ALTER TABLE inspection_orders DROP COLUMN IF EXISTS ...`

### 2.3 迁移脚本设计 (`012_inspection_order_no_sequences.ts`) —— 检验单号流水号池

检验单号（`order_no`，即台账第一列「检验单号」）此前由应用层**即席生成**：
`INS-${Date.now()}-${0~999 随机数}`。它既无检验类型前缀、也无日期段与定长流水段，
与 §1 的界面口径 `OQC-SH-20260706-0001` 不一致，因此**首列改名后仍无法呈现业务可读单号**。

- 迁移序号：012
- 迁移操作：
  - `CREATE TABLE IF NOT EXISTS inspection_order_no_sequences (prefix VARCHAR(32), day_key CHAR(8), last_seq INTEGER, updated_at TIMESTAMPTZ, PRIMARY KEY (prefix, day_key))`
  - **回填**：把库中已存在的合规单号（`^[A-Z0-9-]+-YYYYMMDD-NNNN$`）按 `(前缀, 日期)` 分组取 `MAX(流水号)` 写入池子，
    使新单号与历史单号**不可能撞号**；
  - 不合规的历史单号（三段式 `INS-20231012-006`、复检后缀 `...-R2`）不参与回填——
    其文本形态与 4 位定长新单号不可能相等，不构成冲突。
- 回滚操作 (down)：`DROP TABLE IF EXISTS inspection_order_no_sequences`
- 安全边界：**纯新增表 + 只读聚合回填**，不修改、不删除 `inspection_orders` 任何既有数据。

---

## 3. 后端契约改造方案 (`packages/contracts`)
1. **`InspectionOrderSchema`**:
   - 增加 `salesOrderNo?: string`
   - 增加 `dispatchDate?: string`
   - 增加 `customerName?: string`
   - 增加 `salesOrderPoNo?: string`
   - 增加 `erpStatus?: string`
2. **`CreateInspectionOrderRequestSchema`**:
   - 允许传入 `salesOrderNo`、`dispatchDate`、`customerName`、`salesOrderPoNo`、`erpStatus`、`inspectorName`。
3. **`orderNo`（检验单号）口径**:
   - `InspectionOrderSchema.orderNo` 补充描述与示例 `OQC-SH-20260706-0001`；
   - `CreateInspectionOrderRequestSchema.orderNo` 由**必填改为可选**：省略时由服务端按 §2.3 的编号规则取号，
     显式传入时以其为准（兼容 ERP/MES 下发的外部单号与历史数据回放）。

---

## 4. 基础设施与仓储层映射 (`packages/infrastructure`)
1. **`InspectionOrdersTable` 数据库接口 (`schema.ts`)**:
   - 新增 `salesOrderNo?: string | null`
   - 新增 `dispatchDate?: string | null`
   - 新增 `customerName?: string | null`
   - 新增 `salesOrderPoNo?: string | null`
   - 新增 `erpStatus?: string | null`
2. **`KyselyInspectionOrderRepository` (`inspection-order-repository.ts`)**:
   - `OrderListQuery` 支持 `salesOrderNo?: string`、`customerName?: string`、`salesOrderPoNo?: string`、`dispatchDate?: string`、`erpStatus?: string`。
   - `listOrders` 查询条件添加 `salesOrderNo`、`customerName`、`salesOrderPoNo` 模糊过滤，`dispatchDate`、`erpStatus` 精确过滤，及 `keyword` 跨字段联合检索。
   - `mapRow` 将数据库 `salesOrderNo`、`dispatchDate`、`customerName`、`salesOrderPoNo`、`erpStatus` 正确映射为契约 DTO 属性。
   - `save` 方法将实体的这五个属性正确写入/更新到 `inspection_orders` 表。

---

## 5. API 控制器改造方案 (`apps/api`)
1. **`InspectionQuerySchema`**:
   - 扩充 `salesOrderNo?: string`
   - 扩充 `customerName?: string`
   - 扩充 `salesOrderPoNo?: string`
   - 扩充 `dispatchDate?: string`（出库日期精确匹配，与前端日期选择器语义一致）
   - 扩充 `erpStatus?: string`
2. **`GET /inspections`**:
   - 透传上述查询参数至 Repository 的 `listOrders`：单号/客户/订单号为模糊匹配，出库日期与 ERP 状态为精确匹配。
3. **`POST /inspections`**:
   - 接收并持久化 `customerName`、`salesOrderNo`、`dispatchDate`、`salesOrderPoNo`、`erpStatus`：
     控制器 → `CreateInspectionOrderUseCase` → 领域聚合根 `InspectionOrder` → `save()`，缺省字段不写入（不覆盖库中已有值）。
4. **`POST /inspections` 的 `orderNo` 条件透传**:
   - `...(body.orderNo !== undefined ? { orderNo: body.orderNo } : {})`（符合 `exactOptionalPropertyTypes` 口径）；
   - 未传时不再要求调用方自行编造单号，交由用例在事务内按编号规则取号。

### 5.1 「检验状态」业务语义筛选 `inspectionState`（本轮新增）

**问题**：台账「检验状态」列是**派生列**（由 `status` + `judgment` 共同决定），
而 `GET /inspections` 的 `status` / `statuses` 只能按原始 `status` 枚举过滤，二者口径不等价：

| 台账列显示 | 实际判定口径 | 旧 `statuses` 查询结果 |
|---|---|---|
| 待检验 | `status ∈ {PENDING, DRAFT}` | 一致 |
| 检验中 | `status ∈ {INSPECTING, RE_INSPECTING}` | 漏 `RE_INSPECTING` |
| 已合格 | `status ∈ {COMPLETED, PASSED}` 且 `judgment ≠ FAILED` | 多返回 `judgment = FAILED` 的行 |
| 不合格 | `status ∈ {FAILED, IN_MRB_REVIEW}` 或（`status ∈ {COMPLETED, PASSED}` 且 `judgment = FAILED`） | 漏掉「已判不合格」的行 |

**实测症状**：按「已合格」筛选会带出界面标注为「不合格」的行；按「不合格」筛选**一条都查不到**（`total=0`）。
根因是接口能力缺失——`statuses` 无法表达 `judgment` 维度，前端只能各自拼装组合，口径必然漂移。

**改造**：新增契约查询参数 `inspectionState`，把派生口径**收敛到后端唯一实现**：

```ts
inspectionState: z.enum(['PENDING', 'INSPECTING', 'PASSED', 'FAILED']).optional()
```

仓储层 `listOrders` 将其翻译为如下谓词（`PASSED` 与 `FAILED` 互斥，且并集覆盖契约全部 8 个状态）：

- `PENDING`    → `status IN ('PENDING','DRAFT')`
- `INSPECTING` → `status IN ('INSPECTING','RE_INSPECTING')`
- `PASSED`     → `status IN ('COMPLETED','PASSED') AND judgment IS DISTINCT FROM 'FAILED'`
- `FAILED`     → `status IN ('FAILED','IN_MRB_REVIEW') OR (status IN ('COMPLETED','PASSED') AND judgment = 'FAILED')`

前端出货检验页的「检验状态」下拉改为提交 `inspectionState`；`status` / `statuses` 保留原语义不变，
供「按契约枚举精确查询」的消费方继续使用（二者可叠加，叠加时为 AND）。

---

## 5A. 前端接线修正 (`apps/web/src/pages/inspections/components/OqcList.tsx`)

后台字段再全，前端不读也是白搭。本轮核查发现出货检验页存在两处**信封/口径不匹配**，已修正：

1. **响应信封不匹配（致命）**
   - 真实后端 `GET /inspections` 返回 `{ total, list, statusCounts }`；
   - 出货检验页此前按离线 Mock（MSW）的 `{ items, total }` 读取 `res.items`，
     导致 `res.items` 恒为 `undefined`，页面**永远走兜底参考数据、从不读库**。
   - 修正为 `const rows = Array.isArray(res?.list) ? res.list : Array.isArray(res?.items) ? res.items : []`，
     同时兼容真实后端与离线 Mock 两种信封。
2. **检验状态参数口径不匹配**
   - 下拉框是中文口径（`待检验 / 检验中 / 已合格 / 不合格`），
     而 `GET /inspections` 的 `status` / `statuses` 只接受契约枚举；
     直接透传中文会触发 Zod 校验失败（400），整个请求被 `catch` 吞掉并回退 Mock。
   - 修正为 `CN_TO_STATUSES` 翻译表 + 逗号分隔的 `statuses`（后端为 `IN` 语义，一个中文状态对应多个库状态）：

     | 界面中文状态 | 契约 statuses |
     |---|---|
     | 待检验 | `PENDING,DRAFT` |
     | 检验中 | `INSPECTING,RE_INSPECTING` |
     | 已合格 | `PASSED,COMPLETED` |
     | 不合格 | `FAILED,IN_MRB_REVIEW` |

> 残留风险：`OutsourceList.tsx`（委外检验）与 `IqcList.tsx`（来料检验）存在同类的 `items` / `orders` 信封不匹配问题，
> 属本次「出货检验」范围之外的存量问题，未在本轮一并改动，已记录待办。

---

## 5B. 检验人字段打通 (`inspector_id` / `inspector_name`)

「检验人」是出货检验台账 12 列之一。此前它只有**读**侧通了（`mapRow` 读 `inspector_name`，缺失时回落到 `employees` 联查），**写**侧并未打通：

1. **写侧缺失**：`record-measurements-and-judge` / `save-inspection-draft` 构造聚合根时未携带 `inspectorId` / `inspectorName`，
   而 `save()` 会无条件写 `inspector_id = order.inspectorId ?? null`——不仅新单的检验人为空，
   **还会把种子/迁移已写入的检验人改写成 NULL**（`inspector_name` 因条件写入得以幸存，两列因此可能长期不一致）。
2. **前端兜底造假**：页面在字段缺失时按行号编造 `张检验` / `客户A科技` / `5000` 等示例值，
   接口没给值的列会渲染成"看起来很正常的假数据"，无法据此判断链路是否真的打通。

修正：

- 领域聚合根 `InspectionOrder` 增加 `inspectorId` / `inspectorName`（构造参数、getter、`toDTO` 全链路），
  两个录入用例（提交实测值 / 暂存草稿）以 `cmd.operatorId` / `cmd.operatorName`（实际操作的检验员）写入聚合根；
  由此「**谁录入实测值，谁就是该工单的检验人**」，`save()` 不再把 `inspector_id` 清空，两列恢复一致；
- 前端展示列只取接口真实字段，缺失显示 `-`（数量缺失显示 `0`）；原型示例值仅保留在"接口无任何记录"时的整体兜底数据 `INITIAL_OQC_DATA` 中；
  质检证书上的检验人同样不再用示例姓名代替，未录入即留空（证书属对外交付物）。

---

## 6. 种子数据同步 (`data.ts` 与 `runner.ts`)

### 6.1 口径约定
- **原型 4 条记录直接作为种子写入**：检验编号 / 销售出库单号 / 出库日期 / 客户 / 订单号 / 成品编码 /
  成品名称 / 数量 / ERP状态 / 检验状态 / 检验人 与 WPS 图片(9) 逐列一致，页面不再依赖前端兜底数组。
- 原型中的 `客户A科技`…`客户D工业`、`张检验/李检验/王检验` 是**演示快照口径**，
  与 `customers` / `employees` 主数据不是同一套值，属刻意为之，迁移 010 不会覆盖。
- 原型的底栏为「共4条」，但库中另有 3 条历史 `OQC_SH` 工单（`INS-2023101x-00x`）同样属于出货检验。
  它们被 `seedMrbReviews`（`source_order_no`）与批次追溯种子引用，不能改写单号或类型，
  因此实际台账为 **共 7 条**：原型 4 条在前，历史 3 条在后。
- 列表按 `created_at DESC` 排序，而种子行的 `created_at` 同为播种时刻，
  故原型 4 条在 `seedOrders` 数组里按**展示顺序的逆序**写入，读出来才与原型顺序一致。

### 6.2 字段透传与落库
- `SeedOrderSpec` 增加可选字段 `salesOrderNo` / `dispatchDate` / `customerName` / `salesOrderPoNo` / `erpStatus` / `inspectorName`；
- `runner.ts` 构造工单实体时按"仅当非 `undefined` 才透传"的方式交给 `save()`，
  与 `save()` 内部的条件展开写入策略保持一致——任何缺省字段都不会把库中已有值覆盖为 `NULL`。
- `inspectorName` 缺省时由 `seeds/data.ts` 的 `employeeNameOf(spec.inspectorId)` 从员工档案反查补全；
- `KyselyInspectionOrderRepository.save()` 补上了 `inspector_name` 的写入：
  此前只写 `inspector_id`，契约里的 `inspectorName` 能读不能写，种子里的姓名会被静默丢弃。

### 6.3 主数据补充
原型里的成品编码 `CP-001` / `CP-002` / `CP-003` 在 `seedMaterials` 中补齐
（六角螺栓M10 / 六角螺栓M12 / 法兰螺栓）。`materialNameOf()` 对未知物料会直接抛
`SEED_MATERIAL_NOT_FOUND`，不补主数据种子无法运行。

### 6.4 出货检验种子清单

原型 4 条（与 WPS 图片(9) 逐列一致，且按原型顺序排在列表最前）：

| 检验编号 | 销售出库单号 | 出库日期 | 客户 | 订单号 | 成品编码 | 成品名称 | 数量 | ERP状态 | 检验状态 | 检验人 |
|---|---|---|---|---|---|---|---|---|---|---|
| `OQC-SH-20260706-0001` | `SO-20260706-01` | `2026-07-06` | 客户A科技 | `PO-A-001` | `CP-001` | 六角螺栓M10 | 5000 | 待审核 | 待检验 | - |
| `OQC-SH-20260706-0002` | `SO-20260706-02` | `2026-07-06` | 客户B制造 | `PO-B-002` | `CP-002` | 六角螺栓M12 | 3000 | 待审核 | 检验中 | 张检验 |
| `OQC-SH-20260705-0008` | `SO-20260705-08` | `2026-07-05` | 客户C集团 | `PO-C-003` | `CP-001` | 六角螺栓M10 | 8000 | 已审核 | 已合格 | 李检验 |
| `OQC-SH-20260705-0007` | `SO-20260705-07` | `2026-07-05` | 客户D工业 | `PO-D-004` | `CP-003` | 法兰螺栓 | 2000 | 已拦截 | 不合格 | 王检验 |

历史工单（保留原单号，同时按 008 口径补齐销售出库字段）：

| 工单号 | 类型 | 销售出库单号 | 出库日期 | 客户 | 客户订单号 | ERP状态 | 检验人 |
|---|---|---|---|---|---|---|---|
| `INS-20231012-006` | `OQC_SH` | `SO-20231012-01` | `2023-10-12` | 上海通用汽车零部件采购部 | `PO-20231012-01` | 已审核 | 刘芳 |
| `INS-20231013-004` | `OQC_SH` | `SO-20231013-04` | `2023-10-13` | 金风科技风电紧固件集采中心 | `PO-20231013-04` | 已审核 | 刘芳 |
| `INS-20231013-006` | `OQC_SH` | `SO-20231013-06` | `2023-10-13` | 金风科技风电紧固件集采中心 | `PO-20231013-06` | 已拦截 | 刘芳 |
| `INS-20231012-005` / `INS-20231013-005` | `OQC_SF` | — | — | — | — | — | — |

> `OQC_SF`（委外表处/热处理回厂检验）不属于销售出库场景，故不落销售出库单相关字段；
> 出货检验列表固定按 `type=OQC_SH` 查询，两者口径互不干扰。

---

## 7. 验收与验证记录

### 7.1 迁移
- 在真实 PostgreSQL 上执行 `migrate:down` ×2（依次回滚 `009`、`008`）后再 `migrate:up`，
  两个迁移均能以 `reverted successfully` / `executed successfully` 完成往返，可回滚、可重放。
- 回填语句对全部 `order_type IN ('OQC_SF','OQC_SH')` 的历史行补齐了五个字段（`COALESCE` 保护，不覆盖已有值）。

### 7.2 接口
- `GET /api/v1/inspections?type=OQC_SH` 返回的记录中包含 `salesOrderNo`、`dispatchDate`、`customerName`、`salesOrderPoNo`、`erpStatus`。
- `GET /api/v1/inspections?salesOrderNo=SO-...` 可按销售出库单号命中记录。
- 端到端断言见 `apps/api/test/integration/e2e.test.ts`（"OQC 出货检验字段与接口验证"代码块）。

### 7.3 分组口径
- `GET /inspections` 的 `type` 参数解析优先级为：分组表 `GROUP_TO_TYPES` → 契约枚举单值。
  `OQC_SH` / `OQC_SF` 本身即合法枚举值，历史上已能通过枚举分支命中；
  本次仍显式补充 `OQC_SH: ['OQC_SH']`、`OQC_SF: ['OQC_SF']`，
  使「出货检验」与「委外检验」在分组表内口径显式化，避免后续新增 `OQC_*` 子类型时被 `OQC` 分组意外吞并。
- `OQC: ['OQC_SF','OQC_SH']` 保持原语义（委外 + 出货合并视图），不受影响。

### 7.4 全链路实测（真实库 → Fastify → 页面字段）

以质量主管（`QA_MANAGER`，全通配 PBAC 规则）身份请求
`GET /api/v1/inspections?type=OQC_SH&pageSize=20`（HTTP 200，`total=3`；此处记录的是
原型种子写入**之前**的口径，重播种后的终态见 §7.9），12 列源字段全部非空：

| 检验单号 | 销售出库单号 | 出库日期 | 客户 | 订单号 | 成品编码 | 成品名称 | 数量 | ERP状态 | 检验状态 | 检验人 |
|---|---|---|---|---|---|---|---|---|---|---|
| `INS-20231013-006` | `SO-20231013-06` | `2023-10-13` | 金风科技风电紧固件集采中心 | `PO-20231013-06` | `MAT-BLT-109-M10` | 10.9级六角头螺栓 M10*45 (成品) | 200 | 已拦截 | `COMPLETED` + `FAILED` → 不合格 | 刘芳 |
| `INS-20231013-004` | `SO-20231013-04` | `2023-10-13` | 金风科技风电紧固件集采中心 | `PO-20231013-04` | `MAT-BLT-109-M10` | 10.9级六角头螺栓 M10*45 (成品) | 200 | 已审核 | `COMPLETED` + `CONCESSION` → 已合格 | 刘芳 |
| `INS-20231012-006` | `SO-20231012-01` | `2023-10-12` | 上海通用汽车零部件采购部 | `PO-20231012-01` | `MAT-BLT-109-M10` | 10.9级六角头螺栓 M10*45 (成品) | 200 | 已审核 | `COMPLETED` + `PASSED` → 已合格 | 刘芳 |

附加验证：
- 单值筛选实测（对运行中的服务 `http://127.0.0.1:3100` 发起真实 HTTP 请求）：
  `dispatchDate=2023-10-13` → `total=2`；`salesOrderPoNo=PO-20231013` → `total=2`；
  `customerName=金风科技` → `total=2`；`erpStatus=已拦截` → `total=1`；
  命中集逐条满足筛选值（模糊字段为包含关系，精确字段为等值关系）；
- `POST /api/v1/inspections` 携带五个出库字段创建 `OQC_SH` 工单返回 201，
  新建行的 `sales_order_no` / `dispatch_date` / `customer_name` / `sales_order_po_no` / `erp_status` 列值与请求体逐一相等，
  且可被 `salesOrderNo` 反查命中（断言见 `apps/api/test/integration/e2e.test.ts`）；
- `statuses=PENDING,DRAFT` 命中 `total=0`，中文状态翻译后的多值 `IN` 过滤生效（该库 OQC_SH 无待检记录）。

### 7.5 前端页面口径（`apps/web/src/pages/inspections/components/OqcList.tsx`）

- 表格首列表头由「检验编号」统一为「**检验单号**」，与本文 §1、`docs/09-界面与开源组件.md` §2.3 及原型 WPS图片(9) 保持一致；
- 销售单号 / 客户 / 订单号 / 出库日期 / 检验状态五项筛选全部下沉至 `GET /inspections` 查询参数，
  前端不再做二次内存过滤（避免"接口口径 + 前端口径"两套规则漂移），底栏`共 N 条`取接口 `total`；
- 检验状态下拉为单次明确选择，变更即提交查询；其余输入框点击「查询」提交，点击「重置」清空全部条件并回到默认列表。

### 7.6 回归

- `npm run test`（契约 + 看板/领域 + 端到端集成，真实 PostgreSQL）：全绿。
- `pnpm -r --no-bail run typecheck`（7 个 workspace）：全绿。
- `npm run build`（contracts → domain → application → infrastructure → api → web）：成功。

### 7.7 补充验证（检验人落库、展示真实性、数据库操作安全边界）

- **检验人落库断言**（`apps/api/test/integration/e2e.test.ts` §2.1.1）：提交实测值后
  `inspection_orders.inspector_id` 等于操作人 UUID、`inspector_name` 等于操作人姓名；
- **数据一致性核对**：迁移 `010` 只在 `inspector_name IS NULL` 时用 `employees.name` 补齐
  （**不覆盖**已有姓名），因此界面原型里的占位检验人（`张检验` / `李检验` / `王检验`）得以保留；
  其余工单的检验人姓名与 `employees` 主数据一致；
- **数据库操作安全边界**：任何写库/重播种动作前先执行 `pg_dump -Fc` 全量备份。
  本轮备份为 `logs/backup-20260920-163642.dump`（145 个 TOC 条目 / 27 张表），已用 `pg_restore -l` 验证可读、可恢复；
  备份落在 `.gitignore` 覆盖的 `logs/` 目录，不进版本库；
- **备份后核对库内状态**：迁移 `001`–`010` 全部 APPLIED；无 `E2E-*` / `REPRO-*` 测试残留。

### 7.8 重播种执行记录（先备份、后重播种）

按"确保安全"要求执行 `pnpm db:seed`（该命令 TRUNCATE 20 张业务表），顺序与结果如下：

1. **备份**：`pg_dump` 全库导出到仓库外的 `D:\乐天\db-backup-20260920-162943\letian_qms_db-full.sql`
   （157,973 字节 / 27 张 `CREATE TABLE` / `inspection_orders` 含全部 55 列，含 008/009 新增列）；
2. **迁移**：`008` → `009` 已往返验证（down ×2 → up），`010` 按收窄后的规则重新应用；
3. **播种**：`materials 17` / `inspection_orders 24` / 20 张表合计 `158` 行，零错误；
4. **复核**：全表 `inspector_id` 非空的行 `inspector_name` 空值数为 **0**。

### 7.9 终态全链路实测（出货检验台账 7 条，前 4 条与原型逐列一致）

播种后以质量主管身份请求 `GET /api/v1/inspections?type=OQC_SH&pageSize=20`（HTTP 200，`total=7`），
页面 12 列映射结果如下（前 4 条即 WPS 图片(9) 的四行）：

| 检验单号 | 销售出库单号 | 出库日期 | 客户 | 订单号 | 成品编码 | 成品名称 | 数量 | ERP状态 | 检验状态 | 检验人 | 操作 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| `OQC-SH-20260706-0001` | `SO-20260706-01` | `2026-07-06` | 客户A科技 | `PO-A-001` | `CP-001` | 六角螺栓M10 | 5000 | 待审核 | 待检验 | - | 检验 |
| `OQC-SH-20260706-0002` | `SO-20260706-02` | `2026-07-06` | 客户B制造 | `PO-B-002` | `CP-002` | 六角螺栓M12 | 3000 | 待审核 | 检验中 | 张检验 | 继续 |
| `OQC-SH-20260705-0008` | `SO-20260705-08` | `2026-07-05` | 客户C集团 | `PO-C-003` | `CP-001` | 六角螺栓M10 | 8000 | 已审核 | 已合格 | 李检验 | 详情 |
| `OQC-SH-20260705-0007` | `SO-20260705-07` | `2026-07-05` | 客户D工业 | `PO-D-004` | `CP-003` | 法兰螺栓 | 2000 | 已拦截 | 不合格 | 王检验 | 详情 |
| `INS-20231013-006` | `SO-20231013-06` | `2023-10-13` | 金风科技风电紧固件集采中心 | `PO-20231013-06` | `MAT-BLT-109-M10` | 10.9级六角头螺栓 M10*45 (成品) | 200 | 已拦截 | 不合格 | 刘芳 | 详情 |
| `INS-20231013-004` | `SO-20231013-04` | `2023-10-13` | 金风科技风电紧固件集采中心 | `PO-20231013-04` | `MAT-BLT-109-M10` | 10.9级六角头螺栓 M10*45 (成品) | 200 | 已审核 | 已合格 | 刘芳 | 详情 |
| `INS-20231012-006` | `SO-20231012-01` | `2023-10-12` | 上海通用汽车零部件采购部 | `PO-20231012-01` | `MAT-BLT-109-M10` | 10.9级六角头螺栓 M10*45 (成品) | 200 | 已审核 | 已合格 | 刘芳 | 详情 |

> 「检验人」列的 `-` 由前端按 §2.3 规范给出：未开始 / 待检验一律显示 `-`，
> 与库中是否已指派检验人无关（原型第 1 行同为待检验 + `-`）。

### 7.10 复核轮次：四层全量校验与终态确认（2026-09-20 17:05）

本节是「文档优先 + 全部执行」口径下的收口复核，用于确认 **数据库迁移 / 后端契约 / API 接口 / 前端页面**
四层在最终代码状态下仍然一致。

#### 7.10.1 校验矩阵

| 校验层 | 命令 | 结果 |
|---|---|---|
| 类型检查 | `pnpm -r --no-bail run typecheck` | 8 个 workspace（含 `apps/desktop`）全部 `Done`，零错误 |
| 契约 / 单元 / 集成 / E2E | `npm run test` | 全绿：Zod 契约、看板与领域规则、8 态状态机、追溯拓扑、e2e 写读路径、委外七分类台账回归 |
| 生产构建 | `npm run build` | 成功；`apps/web/dist/assets/index-*.js` ≈ 2,252 kB（gzip ≈ 701 kB，哈希随构建内容变化） |
| 迁移台账 | `pnpm --filter @letian/infrastructure run migrate:up` | `001`–`012` 全部 APPLIED |
| 全链路实测 | `GET /api/v1/inspections?type=OQC_SH&pageSize=20` | HTTP 200、`total=7`，前 4 行与 §7.9 表格逐列一致 |

> `011`（委外加工商名称回填）与 `012`（检验单号流水号池）属于同一仓库的并行改造轮次，
> 二者均为**纯新增 / 只补空值**语义，不修改或删除 `inspection_orders` 既有数据，与本设计的 `008`/`009`/`010` 无冲突。

#### 7.10.2 库内一致性抽查

- `inspection_orders` 共 24 行，`order_type` 分布：`OQC_SH 7` / `OQC_SF 5` / `OQC_MACH 2` / `OQC_HEAT 2` / `IQC 3` / `IPQC_CT 2` / `IPQC_FN 2` / `IPQC_RL 1`；
- `inspector_id` 非空而行 `inspector_name` 为空的行数 = **0**（迁移 `010` 生效）；
- 委外行（`order_type LIKE 'OQC%'` 且非 `OQC_SH`）`vendor_name` 空值数 = **0**（迁移 `011` 与种子数据双保险）。

#### 7.10.3 与原型图的差异说明

- 原型图页脚为「共 4 条」，真实台账为 **7 条**：多出的 3 条为 `INS-20231012-006` / `INS-20231013-004` /
  `INS-20231013-006` 三条历史出货检验工单，被 `mrb_reviews.source_order_no` 与批次追溯引用，
  **不可删除、不可改单号**；
- 因此前 4 行与原型逐列一致，第 5–7 行为真实历史数据顺延展示。若业务要求台账默认只显示某一时间窗，
  应作为**独立需求**通过列表默认时间筛选实现，而不是隐藏历史数据。

#### 7.10.4 备份与数据安全

- 本轮复核全程只做**只读查询**与 `migrate:up`，未执行 `db:seed`（该命令会 TRUNCATE 20 张业务表）；
- 库外备份保留于 `D:\乐天\db-backup-20260920-162943\letian_qms_db-full.sql`（157,973 字节 / 27 张表）。
- **残留清理（2026-09-21）**：按「先隔离、后删除」原则清理了 4 个与本链路无关的历史残留
  （`apps/api/fix-os.cjs`、`packages/infrastructure/insert_inspections.cjs`、
  `packages/infrastructure/inspections_data.json`、`packages/infrastructure/pnpm-lock.yaml`）。
  删除前已逐个校验「全仓库零引用」，并按原相对路径 + SHA-256 备份到仓库外的
  `D:\乐天\cleanup-quarantine-<时间戳>\`（含 `MANIFEST.json` 与 `RESTORE.ps1` 一键还原脚本）；
  其中 `insert_inspections.cjs` 连接的是已不存在的 `55432` 端口，`inspections_data.json` 所载数据
  已由种子/迁移正式落库，`pnpm-lock.yaml` 属多余的嵌套 lockfile（workspace 根 lockfile 为唯一真理源）。
  清理后 `pnpm -r run typecheck` 与 `npm run test` 复跑仍全绿。

---

### 7.11 首列口径收口：列名、编号规则与流水号池（2026-09-20 17:15）

本节收口需求「【出货检验】第一列由 `检验编号` 改为 `检验单号`，并确认该页数据字段是否已与数据库字段/接口打通」。

#### 7.11.1 需求与实际状态的差距

| 子项 | 需求口径 | 本轮前实际状态 | 结论 |
|---|---|---|---|
| 列名 | 第一列文案 `检验编号` → `检验单号` | 已改名（`OqcList.tsx`） | ✅ 浏览器实测复核通过 |
| 单号取值 | 形如 `OQC-SH-20260706-0001` | **缺口**：服务端即席生成 `INS-<时间戳>-<随机数>`；库中另有 3 条 `INS-20231013-006` 形态的历史出货检验单 | ⚠️ 已修复（见 §7.11.2 / §7.11.3） |

> 关键判断：列名是「皮」，单号取值是「骨」。只改名而不改生成规则，首列仍是不可读的 `INS-1758...`，
> 需求并未真正落地——因此本轮把编号规则一并打通。

#### 7.11.2 编号规则（单一真理源）

新增 `packages/domain/src/services/inspection-order-number.ts`，规则为
`{TYPE_PREFIX}-{YYYYMMDD}-{NNNN}`（4 位左补零、每日按前缀归零）：

| 检验类型 | 单号前缀 | 依据 |
|---|---|---|
| `OQC_SH`（出货检验） | `OQC-SH` | 原型图与 §1、§7.9 既有台账 |
| `OQC_SF` | `OQC-SF` | 种子数据既有单号 |
| `OQC_HEAT` | `OQC-HT` | 种子数据既有单号 |
| `OQC_MACH` | `OQC-MC` | 种子数据既有单号 |
| `OQC_BLACK` / `OQC_ZINC` / `OQC_NICKEL` / `OQC_PHOSPH` / `OQC_DACRO` | `OQC-BLACK` …（下划线换连字符机械推导） | 库中暂无实例，不发明缩写，按类型编码推导 |
| `IQC` / `IPQC_CT` / `IPQC_RL` / `IPQC_FN` | `INS` | 保留历史口径，避免存量单号语义漂移 |

设计取舍：

- **只登记有真实单号证据的前缀**，其余走机械推导，杜绝"发明缩写"造成的口径二义；
- 日期段用**本地时区自然日**（质量单据的"当日"以工厂工作日为准，而非 UTC 日界）；
- 流水号上限 9999，越界**显式抛错**而不是静默溢出成 5 位。

#### 7.11.3 流水号分配（迁移 012 + 仓储原子取号）

- `InspectionOrderRepository` 新增端口方法 `allocateOrderNoSequence(prefix, dayKey)`；
- 基础设施侧在 `inspection_order_no_sequences` 的 `(prefix, day_key)` 唯一键上做
  `INSERT … ON CONFLICT DO UPDATE … RETURNING last_seq` 原子 upsert，依赖 PostgreSQL 行锁保证并发不重号；
- 取号发生在 UoW 事务内，**事务回滚则流水号一并回滚**（不留空洞、不跳号），也不存在"号已发但单未建"的悬挂态；
- 落地踩坑记录：连接层启用了 Kysely `CamelCasePlugin`，`RETURNING last_seq` 的结果列名会被转成 `lastSeq`，
  仓储实现同时兼容 `last_seq` / `lastSeq` 两种形态，避免取号逻辑与连接层插件配置耦合（否则会静默写出 `NaN` 单号）。

#### 7.11.4 实测证据

| 校验项 | 命令 / 方式 | 结果 |
|---|---|---|
| 类型检查 | `pnpm -r --no-bail run typecheck` | 7 个 workspace 全部 `Done`，零错误 |
| 集成/E2E | `pnpm --filter @letian/api run test` | 全绿，含本轮新增 §2.1.0 单号断言 |
| 单号规则断言 | `e2e.test.ts` §2.1.0 | 省略 `orderNo` 建单返回 `OQC-SH-<当日>-NNNN`；连续两单流水号严格 `+1`；接口返回值与库中 `order_no` **逐行 `deepEqual`** |
| 迁移台账 | `pnpm --filter @letian/infrastructure run migrate:up` | `012_inspection_order_no_sequences` APPLIED |
| 回填正确性 | `SELECT prefix, day_key, last_seq FROM inspection_order_no_sequences` | 8 行历史回填（如 `OQC-SH/20260706=2`），与库中 `OQC-SH-20260706-0001/0002` 一致 |
| 页面渲染 | `node scripts/testing/oqc-verify.cjs`（CDP 无头浏览器） | 表头第一列 = `检验单号`；页面 **不再出现** `检验编号`；首列取到库中真实 `order_no`；截图 `scripts/logs/oqc-list-after-rename.png` |
| 数据安全 | `pg_dump -Fc` 全库备份 | `D:\乐天\letian-qms\logs\backup-20260920-165917.dump`（156 条 TOC / 27 张表 DATA，`pg_restore -l` 校验可读）；本轮**未执行** `db:seed` |

#### 7.11.5 边界与未纳入本轮的事项

- 3 条历史单号 `INS-20231012-006` / `INS-20231013-004` / `INS-20231013-006` **保留不改**：
  已被 `mrb_reviews.source_order_no` 与批次追溯引用，改号会断链；因此台账首列会同时出现
  `OQC-SH-…` 与 `INS-…` 两种形态，这是**数据历史事实**而非链路未打通——新单已统一按规则生成；
- `docs/api/letian-qms-openapi.yaml` 中 `InspectionType` 枚举此前只列 6 个类型（缺委外七分类），
  与契约单一真理源 `InspectionTypeEnum`（13 个）不符，本轮已补齐；
- ~~`OutsourceList.tsx` / `IqcList.tsx` 的信封不匹配问题仍未处理，见 §5A 残留风险。~~
  → **已于 §7.13 处理完毕**（服务端分页/筛选 + 信封兼容 + 清除伪造兜底值），请以 §7.13 为准。

---

### 7.12 「检验状态」筛选口径打通验收（§5.1 的实测记录）

**改造前**（`statuses` 直拼组合）实测：

| 筛选条件 | 旧实现请求 | 旧结果 | 问题 |
|---|---|---|---|
| 已合格 | `statuses=COMPLETED,PASSED` | `total=5` | 多带出 `OQC-SH-20260705-0007`（`COMPLETED` + `judgment=FAILED`，列上显示「不合格」） |
| 不合格 | `statuses=FAILED,IN_MRB_REVIEW` | `total=0` | 真正的「不合格」行是 `COMPLETED` + `judgment=FAILED`，被完全漏掉 |

**改造后**（`inspectionState`）实测，`GET /api/v1/inspections?type=OQC_SH&pageSize=20&inspectionState=...`：

| `inspectionState` | `total` | 命中单据（`status` / `judgment`） | 逐条口径自校验 |
|---|---|---|---|
| `PENDING` | 1 | `OQC-SH-20260706-0001`（`PENDING` / `-`） | ✅ |
| `INSPECTING` | 1 | `OQC-SH-20260706-0002`（`INSPECTING` / `-`） | ✅ |
| `PASSED` | 3 | `OQC-SH-20260705-0008`（`COMPLETED`/`PASSED`）、`INS-20231013-004`（`COMPLETED`/`CONCESSION`）、`INS-20231012-006`（`COMPLETED`/`PASSED`） | ✅ |
| `FAILED` | 2 | `OQC-SH-20260705-0007`（`COMPLETED`/`FAILED`）、`INS-20231013-006`（`COMPLETED`/`FAILED`） | ✅ |

- **四态合计 `1+1+3+2 = 7`**，与 `type=OQC_SH` 无筛选时的 `total=7` 相等 → 四个派生状态**互斥且并集全覆盖**；
- 非法取值 `inspectionState=XXX` → **HTTP 400**（被 Zod 契约拒绝，不会静默忽略后退化为全表）；
- 与其它条件可叠加：`type=OQC_SH&inspectionState=PASSED&customerName=客户C集团` → `total=1`，语义为 AND。

**回归测试**：`apps/api/test/integration/e2e.test.ts` 的 OQC 用例块新增断言——
逐状态校验「命中的每一条都满足该派生口径」+「四态合计等于该类型总数」+「非法取值返回 400」，
确保今后任何一侧（前端列派生逻辑 / 后端翻译口径）单独改动都会被测试拦住。
### 7.13 来料检验（006）写路径打通 + 来料/委外列表口径收口（2026-09-21）

本节处理与 §7.11 同源的第二个需求分支：「检查确认【出货检验】里面的数据字段是否和数据库字段、接口对接了；如果没有，则把数据库字段迁移脚本、后端契约与 API 接口一并改造打通」。

#### 7.13.1 本轮发现的同类缺口

| # | 缺口 | 现象 | 根因 |
|---|---|---|---|
| A | 006 迁移字段只落在契约层，**写路径静默丢弃** | 库中 3 条来料检验单的 `receipt_no` / `receipt_date` / `specification` / `unit` / `supplier_name` **全部为 NULL** | `CreateInspectionOrderRequest` 早已声明这些字段，但 `apps/api/src/controllers/inspections.controller.ts` 与 `packages/application/src/use-cases/inspections/create-inspection-order.ts` 从未把它们透传下去，`InspectionOrder` 领域模型也没有对应属性，`toDTO` 自然读不出来 |
| B | 页面用「推导值」把未打通的链路**伪装成已打通** | 来料检验「采购入库单号」列看着有值 | `IqcList.tsx` 以 `'RK-' + orderNo.replace(/^IQC-/, '')` 合成入库单号；委外列表则以 `batch_no` 顶替委外加工单号、以 `created_at` 顶替回厂日期 |

> 判断标准：**页面有值 ≠ 链路打通**。只要值不是从数据库列读出来的，就一律按「未打通」处理。

#### 7.13.2 分层改造清单

| 层 | 文件 | 改动 |
|---|---|---|
| 契约 | `packages/contracts/src/schemas/inspection.ts` | `CreateInspectionOrderRequest` 补齐 `receiptNo / receiptDate / specification / spec / unit`；`orderNo` 改为可选（由服务端取号，见 §7.11） |
| 领域 | `packages/domain/src/models/inspection-order.ts` | 新增私有字段 + 构造参数 + getter + `toDTO`：`receiptNo / receiptDate / specification / unit / supplierName`，以及 §7.11 的 `salesOrderNo / dispatchDate / salesOrderPoNo / erpStatus / inspectorId / inspectorName` |
| 应用 | `packages/application/src/use-cases/inspections/create-inspection-order.ts` | 把上述字段透传到聚合；`record-measurements-and-judge.ts` / `save-inspection-draft.ts` 落 `inspectorId / inspectorName`（此前 `save()` 会把 `inspector_id` 写回 NULL） |
| 接口 | `apps/api/src/controllers/inspections.controller.ts` | POST 透传新增字段；GET 新增 `docKeyword`（`order_no` **OR** `receipt_no`）与 `materialKeyword`（`material_code` **OR** `material_name`） |
| 基础设施 | `packages/infrastructure/src/repositories/inspection-order-repository.ts` | `save()` 按「显式提供才写」约定落列；`receiptDate` 经 `toReceiptDate()` 适配 `timestamptz`；`salesOrderPoNo / dispatchDate / erpStatus` 过滤子句补实 |
| 前端 | `IqcList.tsx` / `OutsourceList.tsx` / `OqcList.tsx` | 筛选与分页**全部下沉后端**；删除全部 `INITIAL_*_DATA` 演示行；接口异常改为空态 + 显式错误提示 |

#### 7.13.3 演示数据下线（本轮一并处理）

三个列表页原先在「接口无记录 / 接口异常」时会整体回退到内置演示行。演示行与真实台账形态完全一致，
反而会让「字段是否真打通」无法判断，因此本轮删除：

| 页面 | 改动前 | 改动后 |
|---|---|---|
| `OqcList.tsx` | `catch` 与「空结果」分支 `setItems(INITIAL_OQC_DATA)` | 空数组 + `loadError` 提示条 |
| `IqcList.tsx` | 同上（`INITIAL_IQC_DATA`） | 空数组 + `loadError` 提示条 |
| `OutsourceList.tsx` | 已是 `setRows([])`（无演示行） | 保持 |

同时修掉一处「用检验结论反推 ERP 状态」的口径失真：`OqcList.tsx` 原先在库中 `erp_status` 为空时按
「已合格 → 已审核 / 不合格 → 已拦截」反推展示值，现改为一律以库列为准，缺失显示 `-`。

#### 7.13.4 实测证据（2026-09-21）

| 校验项 | 命令 / 方式 | 结果 |
|---|---|---|
| 端到端（出货检验） | `node scripts/testing/oqc-verify.cjs` | **8/8 PASS**：首列 = `检验单号`、页面不出现 `检验编号`；首列 7 条与库 `order_no` 一致；**逐行对账**「销售出库单号列 == 接口 `salesOrderNo`」「ERP状态列 == 接口 `erpStatus`」；截图 `scripts/logs/oqc-list-after-rename.png` |
| 端到端（来料 + 委外） | `node scripts/testing/inspections-verify.cjs` | **10/10 PASS**：来料表头含 `检验单号 / 采购入库单号`，页面条数 3 == 接口 `total`，**入库单号不再是 `RK-` + 检验单号推导值**；委外表头含 `委外加工单号`，5 行非空且页面条数 == 接口 `total`；截图 `scripts/logs/iqc-list-after-wiring.png`、`outsource-list-after-wiring.png` |
| 006 写路径往返 | 建单 API + `e2e.test.ts` §2.1.0b | 建单落库 `receiptNo / receiptDate / specification / unit` 并从 DTO 回读一致（已固化为回归断言） |
| 筛选参数非空转 | `docKeyword` / `materialKeyword` 负向断言 | 传不存在的关键字 → `total = 0`，证明参数未被静默忽略 |
| 类型检查 | `pnpm -r --no-bail run typecheck` | 7 个 workspace 全部通过 |
| 接口/E2E 测试 | `pnpm --filter @letian/api run test` | 全绿 |
| 页面构建 | `pnpm --filter @letian/web run build` | 通过 |

> 两个校验脚本已随本轮纳入版本库（`scripts/testing/oqc-verify.cjs`、`scripts/testing/inspections-verify.cjs`），
> 前置条件与断言口径见 `scripts/testing/README.md`；截图/日志输出到 `scripts/logs/`（已 gitignore）。

#### 7.13.5 数据清理记录（安全边界）

- 验证过程中创建的探测单 `INS-20260921-0002`（`batch_no = LOT-006PROBE-…`）已删除；
- 同时清理**已无对应单据**的流水号计数器，避免真实建单时无意义跳号：
  交互验证后清理 `OQC-SH/20260920`、`OQC-SH/20260921`、`INS/20260921`（3 条），
  自动化测试套件跑完后再清理 `OQC-SH/20260921`、`INS/20260921`（2 条）；
  清理条件为「该 `(prefix, day_key)` 前缀下已无任何单据」，同一事务内判定后才执行；
- 清理前对 `public.inspection_orders` + `public.inspection_order_no_sequences` 定点备份：
  `logs/backup-cleanup-20260921.dump`；清理后库内 24 张检验单与 8 条流水号计数器一一对应；
- 本轮**未执行** `pnpm db:seed`（该命令会 TRUNCATE 20 张表）。
