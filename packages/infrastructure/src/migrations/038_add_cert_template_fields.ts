import { Kysely, sql } from 'kysely';

/**
 * 迁移 038：检验单「证书模板与证书专用字段」列（docs/51 §3）
 *
 * 背景：
 *   【检验管理】需要把打印出的质量凭证做成与手工老模板**一模一样**的两套版式
 *   （《质量保证书 CERTIFICATE OF INSPECTION》纵向 /《MANUFACTURING CERTIFICATE》横向），
 *   且由操作员在「填写检验内容前」选定本单用哪套模板 —— 该选择必须随检验单持久化，
 *   否则台账「证书」按钮与回看再次打印时无法还原操作员当初的选择。
 *
 * 本次动作（**只加列，不新建表**）：
 *   1. `cert_template VARCHAR(32)` —— 本单选用的证书模板：'QUALITY' | 'MANUFACTURING'。
 *      NULL = 操作员尚未选择，界面按模块缺省模板渲染（IQC/IPQC/OQC 走质保书、委外走制造证书）。
 *      不加 CHECK 约束：取值来自契约 `CertTemplateEnum`，数据库再固化一份等于制造第二份口径
 *      （同 docs/48 §4.1「不用 trigger / CHECK 做业务判定」）。
 *   2. `cert_fields JSONB` —— 证书专用补充字段袋（制造证书的 交货订单参考/工单编号/交货点/
 *      涂层/颜色/客户PO号，质保书的 印记/抽样计划/抽样日期 等）。这些字段只服务于证书打印，
 *      不参与任何业务判定与筛选，故放 JSONB 一袋而不是逐字段建物理列；
 *      缺省 NULL = 从未填写，证书对应栏留白。
 *
 * 纪律：
 *   - 两列**只作证书打印与展示**，不进任何判定 / 权限 / 传递链路（判据一律实时重算）。
 *   - 不回填历史行：历史单没有「选过模板」这个事实，按 NULL 留白处理（同 docs/46「不编造」红线）。
 *
 * 安全边界：**纯新增列**；不修改、不删除任何既有行。
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE inspection_orders
      ADD COLUMN IF NOT EXISTS cert_template VARCHAR(32),
      ADD COLUMN IF NOT EXISTS cert_fields JSONB;
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE inspection_orders
      DROP COLUMN IF EXISTS cert_fields,
      DROP COLUMN IF EXISTS cert_template;
  `.execute(db);
}
