# 委外检验 (OQC) 数据字段与接口打通设计

> 版本：v1.0.0 · 更新时间：2026-09-20
> 关联模块：委外检验（表面处理检验 / 机加工检验 / 热处理检验）
> 关联文档：`docs/01-PRD.md` §3.4、`docs/03-数据模型.md` §2.1、`docs/09-界面与开源组件.md` §2.4

---

## 1. 背景与问题定位

【委外检验】模块在界面上分为三个页签：

| 页签 | 契约检验类型 | 说明 |
|:---|:---|:---|
| 表面处理检验 | `OQC_SF`（及 `OQC_ZINC` / `OQC_NICKEL` / `OQC_BLACK` / `OQC_PHOSPH` / `OQC_DACRO`） | 含「加工类型」列 |
| 机加工检验 | `OQC_MACH` | 无「加工类型」列 |
| 热处理检验 | `OQC_HEAT` | 无「加工类型」列 |

改造前的实际状态（改造前已通过真实 PostgreSQL + 真实 HTTP 层复核）：

1. **接口 500**：`GET /api/v1/inspections?inspectionType=OQC_MACH`（`OQC_HEAT` 同理）返回
   `500 internal-server-error`。根因是仓储层 `INSPECTION_TYPES` 白名单只列了 6 个契约类型，
   `toInspectionType()` 对 `OQC_MACH` / `OQC_HEAT` 直接抛错。
2. **字段未落库**：表格的「委外加工单号 / 加工类型 / 加工商 / 回厂日期」四列在前端用
   `batchNo`、写死的厂名（如「苏州机加工厂」）和 `createdAt` 兜底伪造，`inspection_orders`
   表中并不存在对应物理列。
3. **前端假数据兜底**：接口失败或返回空时，`OutsourceList.tsx` 回落到写死的
   `INITIAL_OUTSOURCE_DATA`，界面看似有数据，实际与数据库完全脱钩，形成「假打通」。
4. **检验人恒为空**：`inspector_name` 从未写入，前端再以「张检验」等写死姓名兜底。
5. **导航角标漏统计**：侧边栏「委外检验」角标仅统计 `OQC_SF`，`OQC_MACH` / `OQC_HEAT` 不计入。

---

## 2. 数据库设计（迁移 `009_add_outsource_process_inspection_fields.ts`）

在 `inspection_orders` 主表上扩展 4 个委外台账字段：

| 物理字段名 | 数据类型 | 可空 | 对应界面列 | 业务说明 / 示例 |
|:---|:---|:---|:---|:---|
| `outsource_no` | `VARCHAR(64)` | NULL | 委外加工单号 | ERP 委外加工单号，建 B-Tree 索引，示例 `WW-20260706-010` |
| `process_type` | `VARCHAR(64)` | NULL | 加工类型（仅表面处理页签展示） | 工艺分类文本：镀锌 / 镀镍 / 发黑 / 磷化 / 达克罗 / 热处理 / 机加工 |
| `return_date` | `VARCHAR(32)` | NULL | 回厂日期 | 委外件回厂登记日期 `YYYY-MM-DD` |
| `vendor_name` | `VARCHAR(255)` | NULL | 加工商 | 加工商名称快照（无 `supplier_code` 时的展示口径） |

索引：`idx_inspection_orders_outsource_no`、`idx_inspection_orders_process_type`。

迁移内同时**幂等重建** `inspection_orders_order_type_check`，把 `order_type` 取值域重新断言为契约
`InspectionTypeEnum` 的 13 个合法值（含 `OQC_HEAT` / `OQC_MACH` 等委外七分类），避免历史环境残留
「只允许 6 类」的旧约束导致委外七分类无法落库。

回填策略（仅针对 `order_type LIKE 'OQC%'`）：
- `outsource_no` 为空时以 `batch_no` 占位；
- `return_date` 为空时以 `created_at` 的日期占位。

### 2.1 迁移 `011_backfill_outsource_vendor_name.ts`（加工商名称回填）

009 只对**新增/重新写入**的委外工单写入 `vendor_name`。历史委外行（如 `INS-20231012-005`、
`INS-20231013-005`）仅有 `supplier_code`，读取侧按兜底链回落到编码本身，界面「加工商」列会
直接显示内部编码（如 `SUP-004`），与「加工商」这一展示列的业务语义不符。

011 迁移把历史委外行的 `vendor_name` 在为空时补齐为 `suppliers.supplier_name`：

| 规则 | 说明 |
|:---|:---|
| 作用范围 | `order_type LIKE 'OQC%'` 且 `vendor_name IS NULL` 且 `supplier_code` 能匹配供应商主数据 |
| 不覆盖 | 任何已有 `vendor_name`（含种子数据刻意写入的演示厂名） |
| 不触碰 | `process_type` / `outsource_no` / `return_date`（无法从主数据推导，由种子数据与 009 分别负责） |
| 不做猜测 | `supplier_code` 为空或匹配不到主数据的行保持原样 |

与种子数据构成「双保险」：`seeds/data.ts` 为演示行显式写入厂名（新建环境直接可用），
011 负责把**已存在的历史库**一次性对齐，两者口径一致。

---

## 3. 契约层 (`packages/contracts`)

`packages/contracts/src/schemas/inspection.ts`：

- `InspectionOrderSchema` 新增 4 个可选属性，与数据库列一一对应：
  `outsourceNo` / `processType` / `returnDate` / `vendorName`。
- `CreateInspectionOrderRequestSchema` 同步新增上述 4 个可选入参。
- `InspectionTypeEnum` 保持 13 值不变（`OQC_SF`、`OQC_HEAT`、`OQC_BLACK`、`OQC_ZINC`、
  `OQC_NICKEL`、`OQC_PHOSPH`、`OQC_DACRO`、`OQC_MACH` 为委外八分类）。

`packages/contracts/src/schemas/inspection-groups.ts` 的 `INSPECTION_GROUPS.OUTSOURCE`
已包含全部委外工艺分类，作为「委外加工」分组筛选的唯一口径来源。

---

## 4. 领域层 (`packages/domain`)

`InspectionOrder` 聚合根新增 4 个私有属性、构造参数、getter，并在 `toDTO()` 中按
「非 undefined 才输出」的方式序列化，保证 `exactOptionalPropertyTypes` 下不产生 `undefined` 键。

---

## 5. 应用层 (`packages/application`)

`CreateInspectionOrderUseCase`：

- `CreateInspectionOrderCommand` 扩展 `outsourceNo` / `processType` / `returnDate` / `vendorName`；
- 构造聚合根时透传，使「新增委外检验单」即可一次落库 4 个台账字段。

---

## 6. 基础设施层 (`packages/infrastructure`)

`inspection-order-repository.ts`：

1. **类型白名单修复**：`INSPECTION_TYPES` 改为直接取自 `InspectionTypeEnum.options`，
   消除「契约扩枚举、仓储漏同步」这一类 500 事故的复发可能。
2. **写入路径**：`save()` 的 `values` 与 `onConflict.doUpdateSet` 均按条件展开写入 4 个新列，
   避免非委外工单被覆盖为 NULL。
3. **读取路径（`mapRow`）**：
   - `outsourceNo`：优先取 `outsource_no`，为空时回落 `batch_no`；
   - `processType`：直接取 `process_type`；
   - `returnDate`：优先取 `return_date`，为空时回落 `created_at` 的日期部分；
   - `vendorName`：优先取 `vendor_name`（011 迁移已把历史委外行按供应商主数据回填），
     其次 `supplier_name`；仅在两者皆空时才回落 `supplier_code`；
   - `inspectorName`：优先取 `inspector_name` 快照，为空时按员工主数据
     `employees.id -> name` 惰性补齐（整仓储实例只查一次主数据）。
4. **筛选条件**：`OrderListQuery` 新增 `outsourceNo`（模糊）与 `processType`（精确）过滤。

---

## 7. 接口层 (`apps/api`)

`apps/api/src/controllers/inspections.controller.ts`：

- `InspectionQuerySchema` 新增 `outsourceNo`、`processType` 查询参数；
- `INSPECTION_TYPE_OPTIONS` 改为 `[...InspectionTypeEnum.options]`，与契约枚举同源；
- `GROUP_TO_TYPES` 补齐 `OQC_HEAT`、`OQC_MACH` 单类型，并新增 `OUTSOURCE` 分组
  （覆盖全部委外工艺分类），供「委外检验」台账聚合查询；
- `POST /api/v1/inspections` 透传 4 个新字段至用例。

对外接口口径（未新增路由，全部复用既有 `/api/v1/inspections`）：

| 用途 | 请求 |
|:---|:---|
| 表面处理检验台账 | `GET /api/v1/inspections?inspectionType=OQC_SF&page=1&pageSize=10` |
| 机加工检验台账 | `GET /api/v1/inspections?inspectionType=OQC_MACH&page=1&pageSize=10` |
| 热处理检验台账 | `GET /api/v1/inspections?inspectionType=OQC_HEAT&page=1&pageSize=10` |
| 按委外单号检索 | `GET /api/v1/inspections?inspectionType=OQC_MACH&outsourceNo=WW-20260706` |
| 按状态检索 | `GET /api/v1/inspections?inspectionType=OQC_MACH&statuses=PENDING,INSPECTING` |

---

## 8. 前端 (`apps/web`)

`apps/web/src/pages/inspections/components/OutsourceList.tsx`：

- 删除写死的 `INITIAL_OUTSOURCE_DATA` 演示行与全部兜底伪造逻辑；
- 表格数据**只**来自 `GET /inspections`，接口失败时展示空态而非假数据；
- 列表映射直接读取 `outsourceNo` / `processType` / `vendorName` / `returnDate` / `inspectorName`；
- 「委外加工单号」筛选改为服务端 `outsourceNo` 模糊查询，「检验状态」改为服务端
  `statuses` 多值查询，仅「加工类型」「加工商」保留页签内本地过滤。

`apps/web/src/components/AppLayout.tsx`：委外检验角标统计规则由 `type === 'OQC_SF'`
放宽为 `type.startsWith('OQC_') && type !== 'OQC_SH'`，委外七分类全部计入。

---

## 9. 验证

1. `pnpm db:migrate` + `pnpm db:seed` 后，`inspection_orders` 中 `OQC_SF` / `OQC_MACH` /
   `OQC_HEAT` 三类演示工单齐备。
2. 新增回归测试 `apps/api/test/integration/outsource-inspection-link.test.ts`：
   - 契约枚举中全部委外工艺分类的台账查询必须返回 200；
   - 每个分类的 `total` 必须等于库中该 `order_type` 的真实行数；
   - 委外单号 / 加工类型 / 加工商 / 回厂日期 / 检验人 必须与库中列（含文档化的兜底口径）一致。
3. `pnpm --filter @letian/api test`、`pnpm --filter @letian/infrastructure test`、
   `pnpm --filter @letian/web build` 全绿。
