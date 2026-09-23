# 37-出货检验族级（分类通用）质检方案补齐设计（市面 QMS 口径）

需求原文：承接 `docs/16-出货检验OQC数据字段与接口打通设计.md`；用户指令「根据市面上的QMS逻辑口径决定怎么修改」。

> 一句话口径：**出货检验的判标属于「产品族」，不属于「系统」** —— 族内通用特性由**分类通用方案**承载，
> 件专有特性由**物料专属方案**承载并优先命中；系统绝不把一个件的公差推广到全族。

---

## 1. 结论（先给答案）

| 项 | 决定 |
|:---|:---|
| **改什么** | 为成品螺栓族 `CAT-FIN-BOLT` **新增一份分类通用出货检验方案**（`QP-OQC-SH-FAMILY`，`inspection_stage = 'OQC_SH'`，`material_code = ''`，`category_code = 'CAT-FIN-BOLT'`，`ACTIVE`），承载**判标不依赖具体规格**的族内通用检项 |
| **不改什么** | ① 两级匹配代码（已符合市面口径，**零改动**）；② 现有 `QP-OQC-SH`（物料专属，继续承载含 `总长 45.0±0.2` 的件专有检项，命中优先级高于族级）；③ 出货检验台账 12 列字段链路（`docs/16` 已逐层实测打通） |
| **为什么** | 市面 QMS 一致采用「**物料级 → 物料组/分类级**」的检验计划选择；分类级模板正是产品族出货检验的标准载体 |
| **代价** | 族级方案只覆盖通用检项，**不代表「检全了」**；各件的尺寸/力学专有检项仍须由质量工程师按图纸建**物料专属方案**（属主数据工作，系统不代造公差） |

---

## 2. 市面 QMS 口径调研

| 产品 | 检验计划 / 模板的挂载层级 | 选择口径 |
|:---|:---|:---|
| **SAP QM** | 检验计划（Inspection Plan）按「任务清单用途」可挂 **物料** / **物料组** / 工厂级通用 | 选择时**由具体到通用**逐级下沉，物料专用优先 |
| **Odoo Quality** | 质量控制点（Quality Control Point）可挂 **产品 / 产品类别 / 工序 / 路线** | 匹配时**最具体者优先**（产品 > 产品类别） |
| **ERPNext Quality** | 检验模板（Quality Inspection Template）关联 **Item / Item Group** | **Item Group（= 存货分类/产品族）** 用于覆盖整族物料 |

三者一致的两条结论：

1. **分类（物料组 / 产品族）级模板是产品族的合法且标准的载体** —— 新料号还没有专属模板时，由族级模板兜住，不至于「检不了」。
2. **越具体越优先** —— 族级只是兜底，物料专属命中即用。

本项目 `docs/17` §7.3 的「两级兜底匹配」（第一级 `material_code` 精确 → 第二级 `material_code = ''` + `category_code` 相等）
与上面第 1、2 条**完全同构**，属正确实现。缺的不是代码，而是**族级那一层的数据**（见 §3）。

---

## 3. 现状与根因

| 项 | 事实 |
|:---|:---|
| **代码** | `findActivePlan` 两级匹配齐备；只读匹配接口 `GET /plans/match` 与建单自动匹配**共用同一实现**；方案设计页 `CreateInspectionPlanRequestSchema.materialCode` 为可选可空 —— **人工也能建分类通用方案** |
| **数据** | 库内 8 份方案**全部**带 `material_code`，`material_code = ''` 的分类通用方案**一份都没有** → 族级兜底这一层在真实数据上**空转** |
| **症状** | `OQC_SH` 仅 `QP-OQC-SH` 一份，绑定 `MAT-BLT-109-M10`。出货检验台账 4 条原型成品中，`MAT-BLT-88-M10` / `MAT-BLT-88-M12-40` / `MAT-BLT-FLG-M8` 三个**匹配不到任何方案**：`GET /plans/match` 返回 404 `inspection-plan-not-found`，不带 `planVersionId` 建单返回 400 同一错误码（2026-09-23 实测） |
| **根因归属** | **方案主数据覆盖缺口**，不是字段 / 接口断链（台账 12 列字段链路见 `docs/16`，已逐层实测打通） |

> 说明：后端「未命中即明确报错、绝不猜方案」是正确行为（`docs/17` §7.4），无需修改；
> 本轮补的是**让族级方案在数据上真实存在**。

---

## 4. 为什么不是「把 QP-OQC-SH 改成分类通用」

最省事的改法是把现有方案 `material_code` 置空、直接升格为族级方案 —— **必须否决**：

`QP-OQC-SH` 的指标集里含 **`LEN-003 总长 45.0±0.2mm`**，该值是为其绑定物料 `MAT-BLT-109-M10`
（`M10×45`，见 `materials.spec_model`）写的。若把这份方案升格为族级：

- `MAT-BLT-FLG-M8`（`M8×25`）会被要求满足「总长 45.0±0.2mm」→ **整批必判不合格**；
- 即 **把一个件的尺寸公差强加给全族**，属 QMS 判标红线（也是 `docs/17`「绝不猜、绝不用错方案」的直接推论）。

---

## 5. 决定：族级方案承载什么

### 5.1 指标归属规则（本次唯一新增口径）

> 检验项按「**判标是否依赖具体规格**」二分：
> - **判标不依赖具体规格** → **族级（分类通用）方案**承载；
> - **判标依赖具体规格**（尺寸、装箱重量等） → **物料专属方案**承载。

### 5.2 对 `QP-OQC-SH` v1.2 四指标逐项归属

| 指标 | 判标依赖 | 归属 | 依据 |
|:---|:---|:---|:---|
| `THR-003` 通规通过率 `100%` | 不依赖（任何螺纹件同判标） | **族级** | 螺纹通止规 100% 通过 |
| `MAR-001` 标识印记高度 `0.5±0.1mm` | 不依赖（标识规范件级统一） | **族级** | 印记高度属标识规范项 |
| `PKG-001` 包装重量 `25.0±0.5kg` | 依赖（随装箱规格 / 单件重量变） | 物料级 | 装箱规格属件级 |
| `LEN-003` 总长 `45.0±0.2mm` | 依赖（`M10×45` 专有） | 物料级 | 尺寸公差属件级 |

族级方案的两项指标**逐值照抄** `QP-OQC-SH` v1.2 的对应项（`itemCode` / `name` / `standardText` /
`nominalValue` / 上下公差 / `sampleSize` / `unit` / `measurementTool` / `isMandatory` **一字不改**），
仅重排 `seq`（1、2）—— 本次**不引入任何新的判标数值**。

---

## 6. 迁移 `031` 设计

| 项 | 内容 |
|:---|:---|
| 序号 / 文件 | `031_add_oqc_family_inspection_plan.ts` |
| 目标表 | `inspection_plans`（一行 = 一个 `(plan_code, version)` 版本行，`save()` 已支持 `material_code = ''` 与 `category_code`） |
| 新增行 | `id = 27000000-0000-4000-8000-000000000002`、`plan_code = 'QP-OQC-SH-FAMILY'`、`plan_name = '成品螺栓族出货检验与客户放行通用规范'`、`material_code = ''`、`category_code = 'CAT-FIN-BOLT'`、`version = 'v1.0'`、`version_status = 'ACTIVE'`、`inspection_stage = 'OQC_SH'`、`items = [THR-003, MAR-001]`、`sampling_config = {samplingScheme:'GB_T_2828', aqlLevel:'II', strictness:'NORMAL'}`、`created_by = 刘芳 (11000000-0000-4000-8000-000000000003)`、`confidentiality_level = 1` |
| 幂等 | `INSERT ... ON CONFLICT (plan_code, version) DO NOTHING`（唯一约束 `uq_plan_code_version`） |
| 安全边界 | **纯新增一行**；不修改、不删除任何既有方案与工单；**不改物理列**（无 `ALTER TABLE`） |
| 回滚 `down()` | `DELETE FROM inspection_plans WHERE plan_code = 'QP-OQC-SH-FAMILY'` —— 只删本迁移新增的行 |

---

## 7. 契约 / 接口口径（无代码改动）

本轮**零接口与契约改动**，理由如下：

| 层 | 现状 | 结论 |
|:---|:---|:---|
| 契约 `MatchInspectionPlanQuerySchema` / `MatchedInspectionPlanSchema` | 已有 `MATERIAL` / `MATERIAL_CATEGORY` 两种 `matchSource` | 族级命中直接落 `MATERIAL_CATEGORY`，无需扩契约 |
| 仓储 `findActivePlan` | 第二级已按 `material_code = ''` + `category_code` 实现 | 数据补上即生效 |
| 建单用例 / 控制器 | 自动匹配分支已走同一方法，审计记 `planMatchSource = AUTO_MATERIAL_CATEGORY` | 无需改动 |
| 前端 `useMatchedPlan` / `planMatch.ts` | 已渲染「存货分类通用方案（兜底命中）」标签与未命中引导条 | 无需改动 |
| 台账 12 列字段链路 | 见 `docs/16`，已接通 | 无需改动 |

---

## 8. 种子与 Mock 对齐

| 文件 | 改动 | 原因 |
|:---|:---|:---|
| `packages/infrastructure/src/seeds/data.ts` | `SeedPlan` 增可选 `categoryCode`；`seedPlans` 新增上述族级方案条目（`materialCode: ''`） | 让全新播种与迁移后的库**同态** |
| `packages/infrastructure/src/seeds/runner.ts` | 方案分类归属由 `materialCategoryOf(plan.materialCode)` 改为 `plan.categoryCode ?? materialCategoryOf(plan.materialCode)` | 否则 `materialCategoryOf('')` 抛 `SEED_MATERIAL_NOT_FOUND`，**全量播种直接失败** |
| `apps/web/src/mocks/data.ts` | 离线 Mock 补同口径族级方案（`materialCode: ''`，`categoryCode: 'CAT-FIN-BOLT'`） | 离线演示与真实后端同口径，避免 Mock 下仍出现同一空转 |

---

## 9. 验证记录（2026-09-23 实测）

| 校验项 | 命令 / 方式 | 结果 |
|:---|:---|:---|
| 迁移往返 | `pnpm db:migrate` → `pnpm db:migrate:down` → `pnpm db:migrate` | **PASS**：`031_add_oqc_family_inspection_plan` 三次均为 executed / reverted successfully；`down` 后 `plan_code = 'QP-OQC-SH-FAMILY'` 行数 **0**，`up` 后 **1**；`inspection_plans` 由 8 行 → **9 行** |
| 族级命中（原 404 的三条） | `GET /api/v1/plans/match?materialCode=<成品>&inspectionType=OQC_SH` | **PASS**：`MAT-BLT-88-M10` / `MAT-BLT-88-M12-40` / `MAT-BLT-FLG-M8` 均 `200`，`planCode = QP-OQC-SH-FAMILY`、`versionNo = v1.0`、`matchSource = MATERIAL_CATEGORY`、`items = 2` |
| 物料优先（不回归） | 同接口 `materialCode=MAT-BLT-109-M10` | **PASS**：仍命中物料专属 `QP-OQC-SH` `v1.2`，`matchSource = MATERIAL`、`items = 4`（含 `LEN-003 总长 45.0±0.2`） |
| 不过度匹配（族级不越界） | 同接口 `materialCode=MAT-CON-M12`（`CAT-FIN-MACH`） | **PASS**：仍 `404 inspection-plan-not-found`（族级方案只覆盖 `CAT-FIN-BOLT`） |
| 建单自动匹配（写路径） | `POST /api/v1/inspections`（**不带** `planVersionId`，`MAT-BLT-88-M10`） | **PASS**：建单成功，快照 `planSnapshot.planCode = QP-OQC-SH-FAMILY` / `versionNo = v1.0`，`items = THR-003, MAR-001`；探针单已删除、流水号已还原 |
| 类型检查 | `pnpm -r --no-bail run typecheck` | **7/7 workspace 通过**（`apps/web` 仅剩 1 处与本轮**无关**的报错：`OutsourceInspectionForm.tsx` 缺 JSX 闭合标签，属并行会话在改文件，本轮未触碰） |
| 接口 / E2E | `pnpm --filter @letian/api run test` | **全绿**，含「方案自动匹配（建单自动匹配 / 匹配接口 / 无方案 400 与 404）」「质检方案分类兜底 / 生效周期 / 物料优先于分类」 |
| 前端测试 | `pnpm --filter @letian/web run test` | **全绿**（含 `validate:mocks` 对新增族级方案与 `MAT-BLT-88-M10` 物料的契约校验） |
| 真机走查（CDP） | `pnpm verify:oqc` | **本轮未能复跑**：vite dev server 对 `OutsourceInspectionForm.tsx` 返回 **500**（JSX 语法错误，并行会话在改文件），检查页整页不渲染，脚本在导航步即失败；**API 侧同轮返回 `total = 7` 正常**，与本轮改动无关（该文件本轮未触碰）。待该文件恢复后可原样复跑 |

> 清理记录：本轮验证产生的探针单 `OQC-SH-20260923-0005`（`batch_no = LOT-OQCFAMILYPROBE-20260923`）已删除，`OQC-SH/20260923` 流水号已还原为验证前值 4，`OQC_SH` 行数回到 7。

---
## 10. 遗留与交接

1. **各成品的件专有检项**（如 `MAT-BLT-88-M10` 的 30mm 总长公差、`MAT-BLT-88-M12-40` 的 40mm、
   `MAT-BLT-FLG-M8` 的法兰面要求）须由质量工程师按图纸在【质检方案设计】页建**物料专属方案** ——
   属主数据工作，系统不代造公差（延续 `docs/34-遗留项收口设计` 的「证书去编造」口径）。
2. 族级方案只保证「**检得了**」，不代表「检全了」；界面「存货分类通用方案（兜底命中）」标签已如实标注命中来源。
3. 若后续希望族级 + 物料级**同时**生效（族级通用项 + 物料专有项合并成一份清单），属匹配语义变更
   （当前为「命中一份方案」），需另立设计 —— 本轮不实施。