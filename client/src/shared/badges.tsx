/**
 * Small pill-style badges reused across the Operations page + home activity
 * feed. If you add a new status or move type, update both the type union in
 * shared/types.ts and the colour map here.
 */
import type { PositionStatus, MoveType } from './types';

export function StatusBadge({ status }: { status: PositionStatus }) {
  const styles: Record<PositionStatus, string> = {
    stockout: 'bg-[var(--pos-stockout-subtle)] text-[var(--pos-stockout-subtle-foreground)]',
    at_risk: 'bg-[var(--pos-at-risk-subtle)] text-[var(--pos-at-risk-subtle-foreground)]',
    overstock: 'bg-[var(--pos-overstock-subtle)] text-[var(--pos-overstock-subtle-foreground)]',
    healthy: 'bg-[var(--pos-healthy-subtle)] text-[var(--pos-healthy-subtle-foreground)]',
  };

  const labels: Record<PositionStatus, string> = {
    stockout: 'Stockout',
    at_risk: 'At risk',
    overstock: 'Overstock',
    healthy: 'Healthy',
  };

  return (
    <span
      className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium ${styles[status]}`}
    >
      {labels[status]}
    </span>
  );
}

export function MoveBadge({ move }: { move: MoveType }) {
  const styles: Record<MoveType, string> = {
    transfer: 'bg-blue-600 text-white',
    expedite: 'border border-amber-500 text-amber-700 bg-amber-50',
    substitute: 'bg-slate-200 text-slate-700',
    markdown_hold: 'bg-slate-100 text-slate-600',
  };

  const labels: Record<MoveType, string> = {
    transfer: 'Transfer',
    expedite: 'Expedite',
    substitute: 'Substitute',
    markdown_hold: 'Markdown hold',
  };

  return (
    <span
      className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${styles[move]}`}
    >
      {labels[move]}
    </span>
  );
}
