# 过程检验 (IPQC) 数据字段与接口打通技术方案

## 1. 背景与业务目标

依据《乐天质量管理系统 (QMS) 业务需求说明书》(01-PRD.md) 与原型规划 (prototypes/README.md)，过程检验 (IPQC) 覆盖紧固件核心加工生命周期，分为三大关键工序检验子类及全局监控看板：
1. **过程检验总览看板 (IPQC-01)**：集中展示下料、滚丝、成品全检三大工序的在检负荷、合格率、待办任务与 MES 车间工位实时对接状态。
2. **下料检验 (IPQC-CT / IPQC-02)**：工序为自动冷镦/断料，核心监控断料长度、操作员、机台设备编号。
3. **滚丝检验 (IPQC-RL / IPQC-03)**：工序为手工/数控滚牙搓丝，核心监控螺纹/牙纹规格（如 6g、M12×1.25）、操作员、滚丝机台设备。
4. **成品检验 (IPQC-FN / IPQC-04)**：入库前终检，关卡必检（`is_mandatory_gate = true`，触发物理入库阻断），核心监控终检组、全尺寸与性能判定。

此前前端 `IpqcViews.tsx` 使用纯静态模拟数据渲染，未与底层 PostgreSQL 数据库表 `inspection_orders`、Kysely 数据仓储层以及后端 Fastify API 形成真实的数据链路闭环。本方案规范底层数据结构、契约定义、后端接口与前端交互规范。

---

## 2. 数据库扩展设计 (`inspection_orders`)

在现有 `inspection_orders` 质量检验工单主表基础上，通过 `007_add_ipqc_process_inspection_fields.ts` 迁移扩展以下 10 个工序追溯字段：

| 物理字段名 | 数据类型 | 可空 | 默认值 | 对应工序 / 业务说明 | 前端对应字段 |
|:---|:---|:---|:---|:---|:---|
| `work_order_no` | `VARCHAR(64)` | NULL | NULL | MES 生产工单号 (如 `MO-20260706-01`)，建 B-Tree 索引 | `workOrderNo` |
| `blanking_length` | `NUMERIC(10,3)` | NULL | NULL | 下料长度 / 断料长度 (mm，下料检验专有) | `blankingLength` |
| `operator_name` | `VARCHAR(64)` | NULL | NULL | 工序机台操作员姓名 (如 `陈操作`) | `operatorName` |
| `operator_id` | `VARCHAR(64)` | NULL | NULL | 工序操作员工号 (如 `OP-0102`) | `operatorId` |
| `equipment_code` | `VARCHAR(64)` | NULL | NULL | 生产机台设备编号 (如 `EQ-CT-01`)，建 B-Tree 索引 | `equipmentCode` |
| `equipment_name` | `VARCHAR(128)` | NULL | NULL | 生产设备名称 (如 `1#全自动高速冷镦机`) | `equipmentName` |
| `thread_spec` | `VARCHAR(64)` | NULL | NULL | 牙纹规格 / 螺纹精度 (如 `M16×2-6g`，滚丝检验专有) | `threadSpec` |
| `inspection_team` | `VARCHAR(64)` | NULL | NULL | 终检班组 (如 `终检一组`，成品检专有) | `inspectionTeam` |
| `process_step` | `VARCHAR(64)` | NULL | NULL | 工序名称阶段 (如 `自动断料` / `手工滚牙` / `检测入库`) | `processStep` |
| `completed_at` | `TIMESTAMPTZ` | NULL | NULL | 检验完成时间 (合格/不合格判定完成时间) | `completedAt` |

---

## 3. 后端契约层改造规范 (`@letian/contracts`)

### 3.1 `InspectionOrderSchema` 契约扩展
在 `packages/contracts/src/schemas/inspection.ts` 中增加上述 10 个属性（全类型定义与 OpenAPI 文档说明）：
- `workOrderNo`: `z.string().optional()`
- `blankingLength`: `z.number().optional()`
- `operatorName`: `z.string().optional()`
- `operatorId`: `z.string().optional()`
- `equipmentCode`: `z.string().optional()`
- `equipmentName`: `z.string().optional()`
- `threadSpec`: `z.string().optional()`
- `inspectionTeam`: `z.string().optional()`
- `processStep`: `z.string().optional()`
- `completedAt`: `z.string().datetime().optional()`

### 3.2 请求参数扩展
- `CreateInspectionOrderRequestSchema`: 允许传入工单号、断料长度、操作员、设备、螺纹规格、终检组等。
- `UpdateInspectionOrderRequestSchema`: 允许更新以上字段。
- `InspectionOrderListQuerySchema`: 允许按 `workOrderNo`、`operatorName`、`equipmentCode`、`threadSpec` 过滤。

---

## 4. 后端 API 接口与仓储层规范

### 4.1 数据仓储层 (`KyselyInspectionOrderRepository`)
1. **实体映射 (`mapRow`)**：
   将数据库新增的 10 列正确解析映射到 `InspectionOrder` 领域实体属性（数值类型强制转型为 number，日期类型格式化为 ISO8601 字符串）。
2. **多维模糊检索 (`listOrders`)**：
   在 `keyword` 检索条件中，扩展加入 `work_order_no`、`operator_name`、`equipment_code`、`equipment_name` 的 ILIKE 模糊匹配，确保前台输入工单号或机台号能即时定位单据。
3. **写路径 (`save`)**：
   在 insert 与 onConflict doUpdateSet 中同步持久化新增字段。

### 4.2 API 路由控制器 (`GET /api/v1/inspections`)
1. 支持 `type=IPQC` 获取所有过程检验工单，支持 `type=IPQC_CT`、`type=IPQC_RL`、`type=IPQC_FN` 精准查询特定子工序工单。
2. 返回结构统一包含：`items` (当前页工单列表)、`total` (匹配总数)、`page`、`pageSize`、`statusCounts` (状态分布汇总)。

---

## 5. 前端视图改造规范 (`apps/web/src/pages/inspections/components/IpqcViews.tsx`)

1. **总览看板 (Overview)**：
   - 并行或统一请求后端 API，获取 `IPQC_CT`、`IPQC_RL`、`IPQC_FN` 的真实待检数、检验中数、已合格数、不合格数以及汇总统计。
   - 移除写死的 Mock 数据，完全基于 API 返回的真实状态计数与单据列表动态聚合。
2. **下料检验 (Blanking)**：
   - 过滤 `type=IPQC_CT`，展示真实断料长度 (`blankingLength`)、操作员 (`operatorName`)、设备 (`equipmentName` / `equipmentCode`)、报检时间与检验状态。
3. **滚丝检验 (Rolling)**：
   - 过滤 `type=IPQC_RL`，展示螺纹规格 (`threadSpec`)、操作员 (`operatorName`)、设备 (`equipmentName` / `equipmentCode`)、报检时间与检验状态。
4. **成品检验 (Finished)**：
   - 过滤 `type=IPQC_FN`，展示关卡标记 (`isMandatoryGate` ★)、终检组 (`inspectionTeam`)、检验状态、检验员与报检时间。
5. **交互功能完整打通**：
   - **快速过滤与关键字搜索**：绑定状态 Tab 与 Search Input 实时拉取后端数据。
   - **查看明细模态框**：基于选中的实际检验单渲染检验项、标称值、公差带、实测值、检验判定与追溯信息。
   - **去检验状态流转**：支持直接对草稿/待检工单发起检验，录入结论并调用 `PATCH /api/v1/inspections/:id/status` 更新单据状态。
   - **质检证书生成**：基于真实单据数据生成带有检验项实测数据与判定结果的规范质检证书。


---

## 6. MES 测试库直连与生产质检数据同步接口实操落地

### 6.1 数据源配置与安全隔离
- **数据库地址**：`120.26.99.40:3306`，库名严格限定为 `mes_letian_test`（MySQL 8.0.27）。
- **安全防线**：在 `mes-pool.ts` 中植入硬编码拦截，禁止越权操作其他数据库；账户以只读方式抽取生产任务、检验单与工序。

### 6.2 核心打通接口清单
1. **`POST /api/v1/integration/mes/sync`**：一键触发车间工序（`t_procedure` -> `workshops`）、质检单（`t_check_report` -> `inspectionOrders`）与炉批号追溯（`t_production_task` -> `batchTraceNodes`）的全量/增量同步。
2. **`GET /api/v1/integration/mes/status`**：实时检测 MES 数据库网络 RTT 延迟、连接池健康状态与表行数统计。
3. **`GET /api/v1/integration/mes/tasks`**：穿透查询 MES 生产任务工单主表（包含炉号 `heat_number`、钢厂 `steel_mill`、下料长度 `cutting_length` 与计划数量）。
4. **`GET /api/v1/integration/mes/check-reports`**：实时抽取 MES 车间工序质检报告（`t_check_report`），涵盖检测入库、冷镦、搓丝、力学检验等实绩判定。
5. **`GET /api/v1/integration/mes/procedures`**：抽取全部 107 项车间工艺与检验工序字典。
6. **质量放行双源校验 (`checkReleaseGate`)**：当 QMS 本地未同步时，自动穿透 MES 直查工单与最新质检结论，确保卡口放行 100% 可信。