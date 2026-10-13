import dotenv from 'dotenv';
dotenv.config();
import { sql } from 'kysely';
import { db } from '../database/connection.js';

const PLACEHOLDER = '按产品标准';
const TEXTUAL_DATA_TYPES = "('TEXT','QUALITATIVE')";

function hitPredicate(alias: string): string {
  return `(
    ${alias}->>'dataType' IN ${TEXTUAL_DATA_TYPES}
    AND btrim(COALESCE(${alias}->>'standardText', '')) = '${PLACEHOLDER}'
    AND COALESCE(
          CASE WHEN jsonb_typeof(${alias}->'acceptableValues') = 'array'
               THEN jsonb_array_length(${alias}->'acceptableValues')
               ELSE 0 END, 0) = 0
  )`;
}

async function main(): Promise<void> {
  const result = await sql<Record<string, unknown>>`
    SELECT '${sql.raw('inspection_plans')}'::text AS table_name,
           count(*)::int AS affected_rows,
           COALESCE(sum(t.hit), 0)::int AS affected_items
    FROM (
      SELECT (
        SELECT count(*)::int
        FROM jsonb_array_elements(p.items) AS e
        WHERE ${sql.raw(hitPredicate('e'))}
      ) AS hit
      FROM ${sql.raw('inspection_plans')} AS p
      WHERE p.items IS NOT NULL
    ) AS t
    WHERE t.hit > 0
  `.execute(db);
  console.log('raw result.rows:', JSON.stringify(result.rows));
  console.log('types:', result.rows.map((r) => Object.keys(r)));
}

main()
  .then(() => process.exit(0))
  .catch((e: unknown) => {
    console.error('ERR', e);
    process.exit(1);
  });
