import { Kysely, sql } from 'kysely';

/**
 * 迁移 040：更新企业档案抬头与检验报告盖章名称为江阴乐天。
 *
 * 仅更新系统默认的旧主体值，保留业务人员已经维护的其他企业档案内容。
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    UPDATE company_profile
       SET legal_name = '江阴乐天紧固件制造有限公司',
           legal_name_en = 'JIANGYIN LETIAN FASTENERS MANUFACTURING CO., LTD.',
           quality_stamp = '江阴乐天质检'
     WHERE legal_name = '宁波乐天紧固件制造有限公司'
        OR legal_name_en = 'NINGBO LETIAN FASTENERS MANUFACTURING CO., LTD.'
        OR quality_stamp = '宁波乐天质检'
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    UPDATE company_profile
       SET legal_name = '宁波乐天紧固件制造有限公司',
           legal_name_en = 'NINGBO LETIAN FASTENERS MANUFACTURING CO., LTD.',
           quality_stamp = '宁波乐天质检'
     WHERE legal_name = '江阴乐天紧固件制造有限公司'
        OR legal_name_en = 'JIANGYIN LETIAN FASTENERS MANUFACTURING CO., LTD.'
        OR quality_stamp = '江阴乐天质检'
  `.execute(db);
}
