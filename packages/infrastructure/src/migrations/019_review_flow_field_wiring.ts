import { Kysely, sql } from 'kysely';

/**
 * 迁移 019：评审流程定义字段打通（`docs/21-MRB不合格品处置数据字段与接口打通设计.md` §10）
 *
 * **E1 流程说明无处可落**：`review_flows` 无 `description` 列，而「评审流程设置」页一直渲染
 * `flow.description`（且 `POST /review-flows` 的请求体 schema 就是契约 `ReviewFlowSchema`，
 * 提交的说明会被 Zod 静默剥离）→ 本迁移补列。
 *
 * **E2 节点「是否必签 / 特采审批权 / 角色显示名」在库里不存在**：页面的「节点配置清单」四列
 * （顺序 / 授权签署角色 / 是否必签 / 特采审批权）用的键名与库内 `nodes` JSONB 完全对不上。
 * 其中"顺序"与既有 `nodeLevel` 是同一概念，**不新增 `nodeSeq`**（避免同一语义两个键互相漂移），
 * 改为前端读 `nodeLevel`；另外三个键按下列口径回填：
 *   - `roleName`   ：`coalesce(roleName, roleCode)` —— 历史 `roleCode` 里写的就是中文角色显示名；
 *   - `isRequired` ：默认 `true` —— 现网 4 条流程都是 3 级会签链，没有任何跳签语义；
 *   - `allowConcession`：**终审节点（该流程 `nodeLevel` 最大者）为 `true`，其余 `false`** ——
 *     PRD §3.6 规定特采「必须由技术部门与客户代表联合双签」，让步接收裁决权归属终审层级。
 *
 * 口径依据见 `docs/21` §10.3。节点字段全部落在既有 `nodes` JSONB 内，不拆节点明细表：
 * 流程定义是整体替换式配置（`save()` 按 `(flow_code, version)` upsert 整份 `nodes`）。
 *
 * 幂等约定：`ADD COLUMN IF NOT EXISTS`；`nodes` 回填用 `||` 合并保留未知键，
 * 且只更新「尚有节点缺键」的行，重复执行为空操作。
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  // 1. 流程说明列
  await sql`
    ALTER TABLE review_flows ADD COLUMN IF NOT EXISTS description VARCHAR(255)
  `.execute(db);

  // 2. 节点 JSONB 回填：roleName / isRequired / allowConcession
  await sql`
    UPDATE review_flows rf
       SET nodes = sub.new_nodes,
           updated_at = now()
      FROM (
        SELECT f.id,
               jsonb_agg(
                 e || jsonb_build_object(
                   'roleName', COALESCE(e -> 'roleName', e -> 'roleCode'),
                   'isRequired', COALESCE(e -> 'isRequired', 'true'::jsonb),
                   'allowConcession',
                     COALESCE(e -> 'allowConcession', to_jsonb((e ->> 'nodeLevel')::int = ml.max_level)),
                   'requireCustomerSign',
                     COALESCE(e -> 'requireCustomerSign', 'false'::jsonb)
                 )
                 ORDER BY (e ->> 'nodeLevel')::int
               ) AS new_nodes
          FROM review_flows f
          CROSS JOIN LATERAL (
            SELECT max((x ->> 'nodeLevel')::int) AS max_level
              FROM jsonb_array_elements(f.nodes) AS x
          ) AS ml
          CROSS JOIN LATERAL jsonb_array_elements(f.nodes) AS e
         WHERE jsonb_array_length(f.nodes) > 0
         GROUP BY f.id
      ) AS sub
     WHERE rf.id = sub.id
       AND EXISTS (
         SELECT 1
           FROM jsonb_array_elements(rf.nodes) AS e
          WHERE NOT (e ? 'roleName')
             OR NOT (e ? 'isRequired')
             OR NOT (e ? 'allowConcession')
       )
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE review_flows DROP COLUMN IF EXISTS description`.execute(db);
  // `nodes` 内的新增键不回滚：它们是对旧读侧无副作用的追加字段，
  // 回滚会把已保存的"必签 / 特采审批权"配置一并抹掉，代价高于收益。
}
