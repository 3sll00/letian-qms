import { Kysely, sql } from 'kysely';
import { formatEquipmentCode } from '@letian/domain';
import type { Equipment } from '@letian/contracts';
import type { Database, EquipmentRow } from '../database/schema.js';

/** 设备台账列表查询（系统管理-设备管理页筛选条） */
export interface EquipmentListQuery {
  page: number;
  pageSize: number;
  keyword?: string;
  status?: string;
  workshop?: string;
}

export interface EquipmentListResult {
  total: number;
  items: Equipment[];
  list: Equipment[];
}

/** 新增设备入参：全部业务字段可选（需求口径：不强制填写），编码由仓储发号 */
export interface CreateEquipmentInput {
  name?: string;
  model?: string;
  factorySerialNo?: string;
  equipmentType?: string;
  workshop?: string;
  status?: string;
  purchaseDate?: string;
  warrantyPeriod?: string;
}

/** 设备编码流水池的固定键（qms_equipment_code_sequences.code_key，预留多前缀扩展） */
const EQUIPMENT_CODE_KEY = 'EQ';

/** ilike 通配符转义（% _ \），与 material-permission-repository 的 escapeLike 同口径 */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/**
 * 设备管理台账仓储（Kysely + PostgreSQL，迁移 049）。
 *
 * 系统管理类简单实体的轻量路径：不经 domain 端口与 application 用例，由
 * controller 直连（与存货分类 KyselyMasterDataRepository.saveInventoryCategory
 * 同口径）。编码发号与插入在同一事务内完成：流水池行锁保证并发下不重号，
 * 事务回滚则号码一并回退（不留空洞）。
 */
export class KyselyEquipmentRepository {
  constructor(private readonly db: Kysely<Database>) {}

  /** 分页列表：按编码升序 = 发号顺序 */
  public async list(query: EquipmentListQuery): Promise<EquipmentListResult> {
    let listQuery = this.db.selectFrom('qmsEquipments').selectAll();
    let countQuery = this.db.selectFrom('qmsEquipments').select((eb) => eb.fn.countAll().as('total'));

    if (query.keyword !== undefined && query.keyword !== '') {
      const pattern = `%${escapeLike(query.keyword)}%`;
      listQuery = listQuery.where((eb) =>
        eb.or([
          eb('equipmentCode', 'ilike', pattern),
          eb('name', 'ilike', pattern),
          eb('model', 'ilike', pattern),
          eb('factorySerialNo', 'ilike', pattern),
          eb('equipmentType', 'ilike', pattern),
        ])
      );
      countQuery = countQuery.where((eb) =>
        eb.or([
          eb('equipmentCode', 'ilike', pattern),
          eb('name', 'ilike', pattern),
          eb('model', 'ilike', pattern),
          eb('factorySerialNo', 'ilike', pattern),
          eb('equipmentType', 'ilike', pattern),
        ])
      );
    }
    if (query.status !== undefined && query.status !== '') {
      listQuery = listQuery.where('status', '=', query.status);
      countQuery = countQuery.where('status', '=', query.status);
    }
    if (query.workshop !== undefined && query.workshop !== '') {
      listQuery = listQuery.where('workshop', '=', query.workshop);
      countQuery = countQuery.where('workshop', '=', query.workshop);
    }

    const rows = await listQuery
      .orderBy('equipmentCode', 'asc')
      .limit(query.pageSize)
      .offset((query.page - 1) * query.pageSize)
      .execute();

    const countRow = await countQuery.executeTakeFirst();
    const items = rows.map((row) => this.mapRow(row));
    return {
      total: countRow ? Number(countRow.total) : 0,
      items,
      list: items,
    };
  }

  /**
   * 新增设备：事务内先在流水池原子取号，再以 6 位编码为主键插入。
   * INSERT ... ON CONFLICT DO UPDATE ... RETURNING 借行锁串行化发号，
   * 与检验单号/方案编码（迁移 012/017）同一套并发口径。
   */
  public async create(input: CreateEquipmentInput): Promise<Equipment> {
    return this.db.transaction().execute(async (trx) => {
      const seqResult = await sql<{ last_seq?: number | string; lastSeq?: number | string }>`
        INSERT INTO qms_equipment_code_sequences (code_key, last_seq, updated_at)
        VALUES (${EQUIPMENT_CODE_KEY}, 1, now())
        ON CONFLICT (code_key)
        DO UPDATE SET last_seq = qms_equipment_code_sequences.last_seq + 1, updated_at = now()
        RETURNING last_seq
      `.execute(trx);
      // CamelCasePlugin 会把原生 SQL 结果列名反向转成 camelCase，两种键都读（与检验单号取号同款防御）
      const rawSeq = seqResult.rows[0]?.last_seq ?? seqResult.rows[0]?.lastSeq;
      const seq = typeof rawSeq === 'string' ? Number.parseInt(rawSeq, 10) : rawSeq;
      if (seq === undefined || !Number.isInteger(seq)) {
        throw new Error('设备编码发号失败：流水池未返回有效序号');
      }

      const row = await trx
        .insertInto('qmsEquipments')
        .values({
          equipmentCode: formatEquipmentCode(seq),
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.model !== undefined ? { model: input.model } : {}),
          ...(input.factorySerialNo !== undefined ? { factorySerialNo: input.factorySerialNo } : {}),
          ...(input.equipmentType !== undefined ? { equipmentType: input.equipmentType } : {}),
          ...(input.workshop !== undefined ? { workshop: input.workshop } : {}),
          ...(input.status !== undefined ? { status: input.status } : {}),
          ...(input.purchaseDate !== undefined ? { purchaseDate: input.purchaseDate } : {}),
          ...(input.warrantyPeriod !== undefined ? { warrantyPeriod: input.warrantyPeriod } : {}),
          updatedAt: new Date(),
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      return this.mapRow(row);
    });
  }

  private mapRow(row: EquipmentRow): Equipment {
    return {
      equipmentCode: row.equipmentCode,
      ...(row.name !== null ? { name: row.name } : {}),
      ...(row.model !== null ? { model: row.model } : {}),
      ...(row.factorySerialNo !== null ? { factorySerialNo: row.factorySerialNo } : {}),
      ...(row.equipmentType !== null ? { equipmentType: row.equipmentType } : {}),
      ...(row.workshop !== null ? { workshop: row.workshop } : {}),
      ...(row.status !== null ? { status: row.status } : {}),
      ...(row.purchaseDate !== null ? { purchaseDate: row.purchaseDate } : {}),
      ...(row.warrantyPeriod !== null ? { warrantyPeriod: row.warrantyPeriod } : {}),
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }
}
