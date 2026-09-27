/**
 * "Shortfall" tab of the drawer. Shows position-level fields + the recovery
 * recommendation + ranked recovery options. No write button; instead, a
 * button to ask the assistant to recover this position.
 */
import { dockController } from '@/chat/dockController';
import { MoveBadge } from '@/shared/badges';
import type { PositionDetail } from '@/shared/types';

export function ShortfallTab({
  detail,
  onMutated,
}: {
  detail: PositionDetail;
  onMutated: () => void;
}) {
  const { position, shortfall, recommendation } = detail;

  return (
    <div className="space-y-6 max-w-2xl">
      {/* Position details grid */}
      <dl className="grid grid-cols-2 sm:grid-cols-1 gap-x-4 gap-y-3 sm:gap-y-4 text-sm">
        <DetailRow
          label="On hand"
          value={position.onHandUnits?.toLocaleString() ?? '—'}
        />
        <DetailRow
          label="On order"
          value={position.onOrderUnits?.toLocaleString() ?? '—'}
        />
        <DetailRow
          label="7d velocity"
          value={position.avgDailyVelocity?.toFixed(1) ? `${position.avgDailyVelocity?.toFixed(1)}/day` : '—'}
        />
        <DetailRow
          label="Weeks of supply"
          value={position.weeksOfSupply?.toFixed(1) ?? '—'}
        />
        <DetailRow
          label="Unit price"
          value={position.priceUsd ? `$${position.priceUsd.toFixed(2)}` : '—'}
        />
        <DetailRow
          label="Lost-sales exposure"
          value={
            position.lostSalesExposureUsd
              ? `$${position.lostSalesExposureUsd.toLocaleString(undefined, { maximumFractionDigits: 0 })}`
              : '—'
          }
        />
        <DetailRow
          label="Markdown risk"
          value={
            position.markdownRiskScore !== null
              ? `${(position.markdownRiskScore * 100).toFixed(0)}%`
              : '—'
          }
        />
        <DetailRow
          label="Markdown exposure"
          value={
            position.markdownExposureUsd
              ? `$${position.markdownExposureUsd.toLocaleString(undefined, { maximumFractionDigits: 0 })}`
              : '—'
          }
        />
      </dl>

      {/* Nearest surplus */}
      {shortfall && shortfall.nearestSurplusStoreId && (
        <div className="rounded-xl border border-border bg-card p-4">
          <div className="text-xs font-semibold uppercase tracking-[0.15em] text-muted-foreground mb-3">
            Nearest surplus
          </div>
          <dl className="space-y-2 text-sm">
            <DetailRow
              label="Store"
              value={shortfall.nearestSurplusStoreId}
            />
            <DetailRow
              label="On hand"
              value={shortfall.nearestSurplusOnHand?.toLocaleString() ?? '—'}
            />
            <DetailRow
              label="Distance"
              value={
                shortfall.nearestSurplusDistanceKm
                  ? `${shortfall.nearestSurplusDistanceKm.toFixed(0)} km`
                  : '—'
              }
            />
          </dl>
        </div>
      )}

      {/* Ranked recovery options */}
      {recommendation && recommendation.moveRanking.length > 0 ? (
        <div className="rounded-xl border border-border bg-card p-4 space-y-4">
          <div className="text-xs font-semibold uppercase tracking-[0.15em] text-muted-foreground">
            Recovery options (ranked)
            {recommendation.basis === 'live' && (
              <span className="ml-2 normal-case tracking-normal text-muted-foreground/80 font-normal">
                · live-computed (overstock — not ML-scored)
              </span>
            )}
          </div>
          <div className="space-y-3">
            {recommendation.moveRanking.map((opt, i) => (
              <div
                key={i}
                className={`rounded-lg border p-3 ${
                  i === 0
                    ? 'border-green-400 bg-green-50'
                    : 'border-border bg-background'
                }`}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="flex-1 space-y-2">
                    <div className="flex items-center gap-2">
                      <MoveBadge move={opt.move} />
                      {i === 0 && (
                        <span className="text-[10px] font-semibold uppercase tracking-wider text-green-700 bg-green-100 rounded px-2 py-0.5">
                          Recommended
                        </span>
                      )}
                    </div>
                    <div className="text-sm font-mono">
                      {opt.units} units
                      {opt.sourceStoreId && ` from ${opt.sourceStoreId}`}
                      {opt.destinationStoreId && ` to ${opt.destinationStoreId}`}
                      {opt.substituteProductId && ` · substitute ${opt.substituteProductId}`}
                    </div>
                  </div>
                </div>
                <div className="mt-3 grid grid-cols-3 gap-2 text-xs">
                  <div>
                    <div className="text-muted-foreground font-semibold">Cost</div>
                    <div className="font-mono">${opt.costUsd.toLocaleString(undefined, { maximumFractionDigits: 0 })}</div>
                  </div>
                  <div>
                    <div className="text-muted-foreground font-semibold">Recaptured</div>
                    <div className="font-mono text-green-700">
                      ${opt.predictedRecapturedUsd.toLocaleString(undefined, { maximumFractionDigits: 0 })}
                    </div>
                  </div>
                  <div>
                    <div className="text-muted-foreground font-semibold">Net value</div>
                    <div className="font-mono">
                      ${opt.predictedNetValueUsd.toLocaleString(undefined, { maximumFractionDigits: 0 })}
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : recommendation ? (
        <div className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          No recovery recommendation yet — the ML model scores this in the Build 2 step.
        </div>
      ) : null}

      {/* CTA button */}
      <button
        onClick={() => {
          const msg = `What's the best recovery move for Store ${position.storeId} on SKU ${position.productId}?`;
          dockController.openAndSend(msg);
          onMutated();
        }}
        className="w-full rounded-lg bg-primary text-primary-foreground px-4 py-2 text-sm font-medium hover:opacity-90 transition-opacity"
      >
        Ask the assistant to recover this
      </button>
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
    <div
      className={
        full
          ? 'col-span-2 sm:col-span-1 flex items-baseline gap-3'
          : 'flex items-baseline gap-3'
      }
    >
      <dt className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground flex-shrink-0 w-24">
        {label}
      </dt>
      <dd className="font-mono text-foreground">{value}</dd>
    </div>
  );
}
