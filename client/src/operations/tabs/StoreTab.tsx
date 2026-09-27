/**
 * "Store" tab of the drawer. Store profile + the store's other affected
 * positions.
 */
import { useEffect, useState } from 'react';
import { fetchStorePositions } from '@/lib/stores';
import { StatusBadge } from '@/shared/badges';
import type { PositionDetail, PositionRow } from '@/shared/types';

export function StoreTab({ detail }: { detail: PositionDetail }) {
  const [otherPositions, setOtherPositions] = useState<PositionRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!detail.position.storeId) return;
    fetchStorePositions(detail.position.storeId, 20)
      .then((positions) => {
        // Filter out the current position
        setOtherPositions(
          positions.filter((p) => p.productId !== detail.position.productId),
        );
      })
      .catch((e) => setError((e as Error).message));
  }, [detail.position.storeId, detail.position.productId]);

  const { position } = detail;

  return (
    <div className="space-y-6 max-w-2xl">
      {/* Store profile */}
      <dl className="grid grid-cols-2 sm:grid-cols-1 gap-x-4 gap-y-3 sm:gap-y-4 text-sm">
        <DetailRow label="Store ID" value={position.storeId} />
        <DetailRow label="Store name" value={position.storeName ?? '—'} />
        <DetailRow label="Region" value={position.region ?? '—'} />
        <DetailRow label="Climate zone" value={position.climateZone ?? '—'} />
        <DetailRow label="City" value={position.city ?? '—'} />
      </dl>

      {/* Other affected positions at this store */}
      {otherPositions !== null && otherPositions.length > 0 && (
        <div className="rounded-xl border border-border bg-card p-4">
          <div className="text-xs font-semibold uppercase tracking-[0.15em] text-muted-foreground mb-3">
            Other affected positions at this store
          </div>
          <div className="space-y-2">
            {otherPositions.map((p) => (
              <div
                key={p.id}
                className="flex items-center justify-between gap-2 text-sm p-2 rounded hover:bg-muted/40 transition-colors"
              >
                <div className="min-w-0 flex-1">
                  <div className="font-medium truncate">{p.productName ?? p.productId}</div>
                  <div className="text-xs text-muted-foreground truncate">
                    {p.category ?? ''} · {p.productId}
                  </div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <div className="text-right">
                    <div className="font-mono text-xs">
                      {p.onHandUnits?.toLocaleString() ?? '—'}
                    </div>
                    <div className="text-xs text-muted-foreground">on hand</div>
                  </div>
                  <StatusBadge status={p.positionStatus} />
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {error && (
        <div className="rounded-lg border border-destructive/40 bg-destructive/5 px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      )}
    </div>
  );
}

function DetailRow({
  label,
  value,
  full,
}: {
  label: string;
  value: React.ReactNode;
  full?: boolean;
}) {
  return (
    <div className={full ? 'col-span-2 sm:col-span-1' : ''}>
      <dt className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
        {label}
      </dt>
      <dd className="font-mono text-foreground mt-1">{value}</dd>
    </div>
  );
}
