/**
 * Three KPI cards at the top of the Operations page: lost-sales exposure /
 * markdown exposure / open shortfalls. When the agent's bulk write fires
 * `dataMutated`, each card is compared to the previous value and
 * only the cards that *moved* pulse a primary ring (see usePulseOnChange).
 */
import { AlertTriangle, TrendingDown, AlertCircle } from 'lucide-react';
import { usePulseOnChange } from '@/lib/usePulseOnChange';
import type { PositionSummary } from '@/shared/types';

export function KpiCards({ summary }: { summary: PositionSummary }) {
  return (
    <div className="grid grid-cols-3 gap-2 sm:gap-4">
      <Card
        label="Lost-sales exposure"
        value={summary.lostSalesExposureUsd}
        icon={<TrendingDown className="size-4" />}
        tone="danger"
        isCurrency
      />
      <Card
        label="Markdown exposure"
        value={summary.markdownExposureUsd}
        icon={<AlertTriangle className="size-4" />}
        tone="warning"
        isCurrency
      />
      <Card
        label="Open shortfalls"
        value={summary.openShortfalls}
        icon={<AlertCircle className="size-4" />}
        tone="neutral"
        isCurrency={false}
      />
    </div>
  );
}

function Card({
  label,
  value,
  icon,
  tone,
  isCurrency,
}: {
  label: string;
  value: number;
  icon: React.ReactNode;
  tone: 'neutral' | 'warning' | 'danger';
  isCurrency: boolean;
}) {
  const pulse = usePulseOnChange(value);
  const toneClass =
    tone === 'danger'
      ? 'text-destructive'
      : tone === 'warning'
        ? 'text-amber-600'
        : 'text-foreground';

  // On phone the value stacks BELOW the label (3 cards in a row at 375px
  // can't fit both inline). On sm+ they sit on one baseline.
  // Phone uses "compact" abbreviation ($674.9K) to keep the line short.
  const formatted = isCurrency
    ? new Intl.NumberFormat(undefined, {
        notation: 'compact',
        maximumFractionDigits: 1,
      }).format(value)
    : value.toLocaleString();

  const fullFormatted = isCurrency
    ? value.toLocaleString(undefined, { maximumFractionDigits: 0 })
    : value.toLocaleString();

  return (
    <div
      className={`rounded-xl border border-border bg-card p-3 sm:p-5 transition-shadow ${
        pulse ? 'animate-pulse-ring' : ''
      }`}
    >
      <div className="flex items-center gap-1.5 sm:gap-2 text-[10px] sm:text-xs font-semibold uppercase tracking-[0.12em] sm:tracking-[0.15em] text-muted-foreground">
        <span className={toneClass}>{icon}</span>
        <span className="truncate">{label}</span>
      </div>
      <div className="mt-1.5 sm:mt-2 flex flex-col sm:flex-row sm:items-baseline gap-0 sm:gap-2">
        <div className="display text-2xl sm:text-3xl font-semibold text-foreground">
          {isCurrency ? '$' : ''}{formatted}
        </div>
        {isCurrency && (
          <div className="text-xs sm:text-sm text-muted-foreground">
            <span className="sm:hidden">≈ ${fullFormatted}</span>
            <span className="hidden sm:inline">· ${fullFormatted}</span>
          </div>
        )}
      </div>
    </div>
  );
}
