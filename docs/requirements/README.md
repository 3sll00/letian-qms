# 乐天质量管理系统 (Letian QMS) - 原始需求与基线资料

本目录归档项目初始调研、客户确认、数据字典及多模态提取文本，是整个系统 PRD、架构设计与编码实现的权威依据源。

---

## 目录文件清单与说明

| 文件名 | 类型 | 说明与核心价值 |
| :--- | :--- | :--- |
| `乐天技术开发方案表.docx` | 原始需求方案 | 乐天技术开发方案申报与初始调研文档，界定业务边界、硬件环境与技术目标。 |
| `乐天QMS_开发确认文档.docx` | 核心确认文档 | 双方确认的最终功能开发确认书，明确了 **21 项核心功能清单** 与交付验收标准。 |
| `doc_dump.txt` | 文本提取副本 | 从上述 docx 需求文档中完整提取的纯文本转储，便于 AI 检索与全文语义索引。 |
| `doc_tables_detail.txt` | 表格明细提取 | 提取出的方案表格、数据结构字段、工序流程定义明细。 |
| `ocr_result.txt` | 原型 OCR 文本 | 对 21 张 WPS 高保真原型图进行 OCR 光学字符识别所提取的界面文字、指标项与表单字段。 |
| `caimao_tables_list.txt` | 外部系统字典 | 现场管家婆 ERP (财贸版/工贸版 SQL Server) 数据库物理表清单与字段对账参照表。 |
| `extracted_images/` | 方案插图归档 | 包含从 docx 中抽取的 28 张插图原件 (`image-0.png` ~ `image-27.png`)。 |

---

## 与系统文档的映射关系

- **PRD 基线**：`letian-qms/docs/letian-qms-prd.md` 中的 21 项业务规格严格对应《乐天QMS_开发确认文档.docx》。
- **UI 原型**：`docs/prototypes/` 中的 21 张设计稿对应《乐天QMS_开发确认文档.docx》中约定的每个功能模块交互原型。
- **集成规范**：`docs/07_EXTERNAL_INTEGRATIONS_ERP_MES.md` 与 `docs/reports/08_LETIAN_TEST_ERP_DATABASE_VERIFICATION_REPORT.md` 基于 `caimao_tables_list.txt` 的数据结构实现只读直连与数据抽取。
