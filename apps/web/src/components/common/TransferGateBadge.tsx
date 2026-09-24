import React from 'react';
import { ledgerTransferBadge, type TransferStateFields } from '../../lib/transferGateFormat';

/**
 * 「合格后传递」台账徽标（docs/48 §4.6 / §8 P0 第 6 项）。
 *
 * 三条纪律：
 * 1. **只做呈现**：文案与色板全部来自服务端判定码（`ledgerTransferBadge`），
 *    本组件不推导「能不能传」—— 界面任何二次判定都会与服务端 422 分叉。
 * 2. **不把「未知」画成「通过」**：服务端未回填判定时显示 —，
 *    与「被阻断」「放行」三态可区分（否则离线 / Mock 环境会被读成一切正常）。
 * 3. 徽标只是提示：真正的拦截永远是服务端 422（docs/48 §8 硬约束 6）。
 */
export const TransferGateBadge: React.FC<{
  state: TransferStateFields | null | undefined;
  className?: string;
}> = ({ state, className }) => {
  const badge = ledgerTransferBadge(state);
  if (badge === null) {
    return (
      <span className={`text-slate-300 ${className ?? ''}`} title="服务端未下发传递判定（例如 withTransfer=false）">
        —
      </span>
    );
  }
  return (
    <span
      title={badge.tip}
      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-medium whitespace-nowrap ${badge.badge} ${className ?? ''}`}
    >
      <span className={`inline-block w-1.5 h-1.5 rounded-full ${badge.dot}`} />
      {badge.label}
    </span>
  );
};
