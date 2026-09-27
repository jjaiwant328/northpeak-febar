/**
 * The filterable shortfall/position table. Status filter chips + search +
 * the row list itself. Click a row → opens the detail drawer. Rows whose
 * status changed between dataMutated refetches pulse a soft primary
 * highlight (1.5s) so the user's eye lands on what the agent just flipped.
 */
import { Search } from 'lucide-react';
import { usePulseOnChange } from '@/lib/usePulseOnChange';
import type { PositionRow, PositionStatus } from '@/shared/types';
import { StatusBadge, MoveBadge } from '@/shared/badges';

const STATUS_TABS: { value: PositionStatus | 'all' | 'recovery'; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'stockout', label: 'Stockout' },
  { value: 'at_risk', label: 'At risk' },
  { value: 'overstock', label: 'Overstock' },
  { value: 'recovery', label: 'Recovery in progress' },
];

function SortHeader({
  label,
  active,
  onClick,
  align = 'left',
  hint,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
  align?: 'left' | 'right';
  hint?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={hint}
      className={`inline-flex items-center gap-1 ${
        align === 'right' ? 'flex-row-reverse' : ''
      } ${
        active
          ? 'text-foreground'
          : 'text-muted-foreground hover:text-foreground'
      } transition-colors cursor-pointer`}
    >
      {label}
      <span className="text-[10px]" aria-hidden>
        {active ? '↓' : '↕'}
      </span>
    </button>
  );
}

function SkeletonRows() {
  return (
    <>
      {Array.from({ length: 8 }).map((_, i) => (
        <tr
          key={i}
          className="border-t border-border"
          style={{ animation: `skelPulse 1.2s ease-in-out ${i * 60}ms infinite` }}
        >
          <td className="px-4 py-3">
            <div className="h-3 w-40 rounded bg-muted" />
            <div className="mt-1.5 h-2 w-24 rounded bg-muted/70" />
          </td>
          <td className="px-4 py-3">
            <div className="h-3 w-36 rounded bg-muted" />
          </td>
          <td className="px-4 py-3">
            <div className="h-3 w-12 rounded bg-muted" />
          </td>
          <td className="px-4 py-3">
            <div className="h-3 w-16 rounded bg-muted" />
          </td>
          <td className="px-4 py-3">
            <div className="h-1.5 w-12 rounded-full bg-muted" />
          </td>
          <td className="px-4 py-3 text-right">
            <div className="h-3 w-14 rounded bg-muted ml-auto" />
          </td>
          <td className="px-4 py-3">
            <div className="h-4 w-20 rounded-md bg-muted" />
          </td>
          <td className="px-4 py-3">
            <div className="h-4 w-16 rounded-full bg-muted" />
          </td>
        </tr>
      ))}
      <style>{`
        @keyframes skelPulse {
          0%, 100% { opacity: 0.55; }
          50% { opacity: 1; }
        }
      `}</style>
    </>
  );
}

type SortKey = 'exposure' | 'velocity';

type Props = {
  rows: PositionRow[];
  loading: boolean;
  error: string | null;
  statusFilter: PositionStatus | 'all' | 'recovery';
  onStatusFilter: (s: PositionStatus | 'all' | 'recovery') => void;
  search: string;
  onSearch: (s: string) => void;
  zone?: string;
  onZoneFilter?: (z: string | null) => void;
  sort: SortKey;
  onSortChange: (s: SortKey) => void;
  onSelect: (id: string) => void;
};

export function ShortfallTable({
  rows,
  loading,
  error,
  statusFilter,
  onStatusFilter,
  search,
  onSearch,
  sort,
  onSortChange,
  onSelect,
}: Props) {
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <div
          role="tablist"
          aria-label="Status filter"
          className="relative inline-flex rounded-full border border-border bg-card p-0.5 text-sm"
        >
          {STATUS_TABS.map((s) => {
            const active = statusFilter === s.value;
            return (
              <button
                key={s.value}
                onClick={() => onStatusFilter(s.value as PositionStatus | 'all' | 'recovery')}
                aria-pressed={active}
                className={`relative z-10 rounded-full px-3 py-1 transition-colors duration-200 ${
                  active
                    ? 'text-background'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                {active && (
                  <span
                    className="absolute inset-0 rounded-full bg-foreground transition-all"
                    style={{ viewTransitionName: 'status-tab-active' }}
                    aria-hidden
                  />
                )}
                <span className="relative">{s.label}</span>
              </button>
            );
          })}
        </div>
        <div className="flex items-center gap-2 rounded-full border border-border bg-card px-3 py-1.5 text-sm flex-1 sm:flex-initial min-w-[180px]">
          <Search className="size-3.5 text-muted-foreground shrink-0" />
          <input
            value={search}
            onChange={(e) => onSearch(e.target.value)}
            placeholder="Search store, product, SKU…"
            className="bg-transparent outline-none w-full sm:w-60 placeholder:text-muted-foreground"
          />
        </div>
      </div>

      {error && (
        <div className="rounded-lg border border-destructive/40 bg-destructive/5 px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      )}

      <div className="relative rounded-xl border border-border bg-card overflow-hidden">
        {loading && (
          <div
            className="absolute inset-x-0 top-0 h-0.5 z-10 overflow-hidden"
            aria-hidden
          >
            <div
              className="h-full w-1/3 rounded-full"
              style={{
                background: 'var(--primary)',
                animation: 'loadingBar 1.1s ease-in-out infinite',
              }}
            />
          </div>
        )}

        {/* ───── PHONE: card list ───── */}
        <ul
          className={`sm:hidden divide-y divide-border transition-opacity duration-150 ${
            loading && rows.length > 0 ? 'opacity-70' : 'opacity-100'
          }`}
        >
          {loading && rows.length === 0 && (
            <li className="px-4 py-6 text-center text-muted-foreground text-sm">
              Loading…
            </li>
          )}
          {!loading && rows.length === 0 && (
            <li className="px-4 py-8 text-center text-muted-foreground text-sm">
              No positions match the current filters.
            </li>
          )}
          {rows.map((r) => (
            <MobileCard key={r.id} row={r} onSelect={onSelect} />
          ))}
        </ul>

        {/* ───── TABLET + DESKTOP: full table ───── */}
        <div
          className={`hidden sm:block transition-opacity duration-150 overflow-x-auto ${
            loading && rows.length > 0 ? 'opacity-70' : 'opacity-100'
          }`}
        >
          <table className="w-full min-w-[1020px] text-sm">
            <thead className="bg-muted text-xs uppercase tracking-wider text-muted-foreground">
              <tr>
                <th className="text-left px-4 py-2 font-semibold">Store</th>
                <th className="text-left px-4 py-2 font-semibold">Product</th>
                <th className="text-left px-4 py-2 font-semibold">On hand</th>
                <th className="text-left px-4 py-2 font-semibold">
                  <SortHeader
                    label="Velocity (7d)"
                    active={sort === 'velocity'}
                    onClick={() =>
                      onSortChange(sort === 'velocity' ? 'exposure' : 'velocity')
                    }
                  />
                </th>
                <th className="text-left px-4 py-2 font-semibold">Weeks of supply</th>
                <th className="text-right px-4 py-2 font-semibold">
                  <SortHeader
                    label="Exposure $"
                    align="right"
                    active={sort === 'exposure'}
                    onClick={() =>
                      onSortChange(sort === 'exposure' ? 'velocity' : 'exposure')
                    }
                  />
                </th>
                <th className="text-left px-4 py-2 font-semibold">Recommended</th>
                <th className="text-left px-4 py-2 font-semibold">Status</th>
              </tr>
            </thead>
            <tbody>
              {loading && rows.length === 0 && <SkeletonRows />}
              {!loading && rows.length === 0 && (
                <tr>
                  <td
                    colSpan={8}
                    className="px-4 py-8 text-center text-muted-foreground"
                  >
                    No positions match the current filters.
                  </td>
                </tr>
              )}
              {rows.map((r) => (
                <Row key={r.id} row={r} onSelect={onSelect} />
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function Row({
  row: r,
  onSelect,
}: {
  row: PositionRow;
  onSelect: (id: string) => void;
}) {
  const statusKey = r.liveMoveType
    ? `${r.positionStatus}:${r.liveMoveType}`
    : r.positionStatus;
  const pulse = usePulseOnChange(statusKey);

  return (
    <tr
      onClick={() => onSelect(r.id)}
      className={`cursor-pointer border-t border-border hover:bg-muted/50 transition-colors ${
        pulse ? 'animate-pulse-row' : ''
      }`}
    >
      <td className="px-4 py-2">
        <div className="font-medium">{r.storeName ?? `Store ${r.storeId}`}</div>
        <div className="text-xs text-muted-foreground">{r.city ?? ''}</div>
      </td>
      <td className="px-4 py-2">
        <div className="font-medium">{r.productName ?? '—'}</div>
        <div className="text-xs text-muted-foreground">
          {r.category ? `${r.category} · ` : ''}{r.productId}
        </div>
      </td>
      <td className="px-4 py-2 font-mono">
        {r.onHandUnits?.toLocaleString() ?? '—'}
      </td>
      <td className="px-4 py-2 font-mono">
        {r.avgDailyVelocity?.toFixed(1) ?? '—'}
      </td>
      <td className="px-4 py-2">
        {r.weeksOfSupply?.toFixed(1) ?? '—'}
      </td>
      <td className="px-4 py-2 text-right font-mono">
        ${r.lostSalesExposureUsd?.toLocaleString(undefined, { maximumFractionDigits: 0 }) ?? '—'}
      </td>
      <td className="px-4 py-2">
        {r.recommendedMove ? (
          <MoveBadge move={r.recommendedMove} />
        ) : (
          <span className="text-xs text-muted-foreground">—</span>
        )}
      </td>
      <td className="px-4 py-2">
        {r.liveMoveType ? (
          <div className="flex items-center gap-2">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-amber-700 bg-amber-50 rounded-full px-2 py-0.5">
              Recovery in progress
            </span>
            <MoveBadge move={r.liveMoveType} />
          </div>
        ) : (
          <StatusBadge status={r.positionStatus} />
        )}
      </td>
    </tr>
  );
}

function MobileCard({
  row: r,
  onSelect,
}: {
  row: PositionRow;
  onSelect: (id: string) => void;
}) {
  const statusKey = r.liveMoveType
    ? `${r.positionStatus}:${r.liveMoveType}`
    : r.positionStatus;
  const pulse = usePulseOnChange(statusKey);

  return (
    <li
      onClick={() => onSelect(r.id)}
      className={`px-4 py-3 cursor-pointer hover:bg-muted/50 transition-colors ${
        pulse ? 'animate-pulse-row' : ''
      }`}
    >
      {/* Row 1 — store (left) + status badge (right) */}
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="font-medium text-sm truncate">
            {r.storeName ?? `Store ${r.storeId}`}
          </div>
          <div className="text-xs text-muted-foreground">
            {r.city ?? ''} · {r.region ?? ''}
          </div>
        </div>
        <div className="flex flex-col items-end gap-1 shrink-0">
          {r.liveMoveType ? (
            <>
              <span className="text-[10px] font-semibold uppercase tracking-wider text-amber-700 bg-amber-50 rounded-full px-2 py-0.5 whitespace-nowrap">
                Recovery
              </span>
              <MoveBadge move={r.liveMoveType} />
            </>
          ) : (
            <StatusBadge status={r.positionStatus} />
          )}
        </div>
      </div>

      {/* Row 2 — product */}
      <div className="mt-2 text-sm">
        <span className="text-foreground">{r.productName ?? '—'}</span>
        <span className="text-xs text-muted-foreground">
          {r.category ? ` · ${r.category}` : ''} · {r.productId}
        </span>
      </div>

      {/* Row 3 — on-hand + velocity + exposure */}
      <div className="mt-1.5 flex items-center justify-between gap-3 text-xs text-muted-foreground">
        <div className="flex items-center gap-2">
          <span>
            <span className="font-semibold">On hand:</span>{' '}
            {r.onHandUnits?.toLocaleString() ?? '—'}
          </span>
          <span>
            <span className="font-semibold">·</span>
          </span>
          <span>
            <span className="font-semibold">7d:</span> {r.avgDailyVelocity?.toFixed(1) ?? '—'}/d
          </span>
        </div>
        <div className="font-mono text-foreground shrink-0 text-right">
          ${r.lostSalesExposureUsd?.toLocaleString(undefined, { maximumFractionDigits: 0 }) ?? '—'}
        </div>
      </div>

      {/* Row 4 — recommended move */}
      {r.recommendedMove && (
        <div className="mt-2 text-xs">
          <span className="text-muted-foreground">Recommended: </span>
          <MoveBadge move={r.recommendedMove} />
        </div>
      )}
    </li>
  );
}
