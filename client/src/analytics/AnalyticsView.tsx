/**
 * Analytics — warehouse-backed charts.
 *
 * Template intent: surfaces the "lakehouse analytics" half of the story —
 * live SQL-warehouse queries against the Delta lakehouse (not a mock). The
 * header shows the warehouse name + state to make that obvious.
 *
 * How the data flows: each chart fetches `/api/charts/<key>` (see
 * server/routes/charts.ts). That route reads config/queries/<key>.sql —
 * written SCHEMA-RELATIVE (`FROM gold_store_sku_position`, no catalog/schema
 * qualifier) — and runs it with the demo's catalog+schema as the SQL
 * session context, so one env var (DEMO_CATALOG/DEMO_SCHEMA) drives the
 * analytics tables on any workspace. Rows come back via `useChartData` and
 * feed the chart components' `data` prop.
 *
 * NOTE: we deliberately do NOT use AppKit's `useAnalyticsQuery` /
 * `<Chart queryKey=…>` plugin path — its query route can't set the
 * statement catalog/schema, so it would force hardcoded `cat.schema.table`
 * in every SQL file (breaks across workspaces). The custom route is the fix.
 *
 * Repurposing: edit/add a .sql under config/queries/, register its key in
 * charts.ts's QUERY_FILES map, and reference it here via <ChartData chartKey=…>.
 */
import { useEffect, useState } from 'react';
import { BarChart, LineChart } from '@databricks/appkit-ui/react';
import { fetchWarehouse, type Warehouse } from '@/lib/api';
import { BRAND_PALETTE } from '@/lib/brand';
import { RtPitch } from '@/architecture/RtPitch';

/**
 * Fetch chart rows from the server's /api/charts/<key> route. That route
 * reads the query SQL, substitutes the demo catalog/schema, and runs it
 * against the SQL warehouse — so a single env var drives the catalog/schema
 * for analytics just like the rest of the app (see server/routes/charts.ts).
 * We pass the returned rows to the chart components via their `data` prop.
 */
function useChartData<T = Record<string, unknown>>(key: string): {
  data: T[] | null;
  error: string | null;
  isLoading: boolean;
} {
  const [state, setState] = useState<{
    data: T[] | null;
    error: string | null;
    isLoading: boolean;
  }>({ data: null, error: null, isLoading: true });

  useEffect(() => {
    let alive = true;
    setState({ data: null, error: null, isLoading: true });
    fetch(`/api/charts/${key}`)
      .then(async (r) => {
        const body = await r.json();
        if (!r.ok) throw new Error(body?.error ?? `HTTP ${r.status}`);
        return body.data as T[];
      })
      .then((data) => alive && setState({ data, error: null, isLoading: false }))
      .catch(
        (e) =>
          alive &&
          setState({ data: null, error: String(e?.message ?? e), isLoading: false }),
      );
    return () => {
      alive = false;
    };
  }, [key]);

  return state;
}

export function AnalyticsView() {
  const [warehouse, setWarehouse] = useState<Warehouse | null>(null);

  useEffect(() => {
    fetchWarehouse().then(setWarehouse).catch(console.error);
  }, []);

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-6xl mx-auto px-4 sm:px-8 py-6 sm:py-10 space-y-6 sm:space-y-10">
        <div>
          <div className="text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground mb-2">
            Operations analytics
          </div>
          <h1 className="display text-4xl font-semibold tracking-tight text-foreground mb-2">
            Where we're short and where we're over.
          </h1>
          <p className="text-muted-foreground max-w-2xl">
            Live queries against the SQL warehouse — the same numbers the
            assistant reasons about, on a single page. Use the queue to take
            action; use this page to spot patterns.
          </p>
        </div>

        <RtPitch
          warehouse={
            warehouse?.name
              ? { name: warehouse.name, state: warehouse.state ?? null }
              : null
          }
          latencyMs={null}
        />

        {/* Top row: two charts side-by-side. Trend (wider) + zone mix. */}
        <div className="grid grid-cols-1 lg:grid-cols-5 gap-4">
          <ChartCard
            title="Cold weather demand trend"
            scope="Last 12 weeks"
            className="lg:col-span-3"
          >
            <ChartData chartKey="cold_weather_velocity_trend" height={260}>
              {(rows) => (
                <LineChart
                  data={rows}
                  xKey="week"
                  yKey="units_sold"
                  colors={[BRAND_PALETTE[0]]}
                  height={260}
                  smooth
                />
              )}
            </ChartData>
          </ChartCard>

          <ChartCard
            title="Position mix by climate zone"
            scope="All time"
            className="lg:col-span-2"
          >
            <ChartData chartKey="position_mix_by_zone" height={260}>
              {(rows) => (
                <BarChart
                  data={rows}
                  xKey="climate_zone"
                  yKey="position_count"
                  colors={[BRAND_PALETTE[0]]}
                  height={260}
                />
              )}
            </ChartData>
          </ChartCard>
        </div>

        <ChartCard title="Worst shortfalls" scope="By exposure" flush>
          <ChartData<WorstShortfallRow> chartKey="worst_shortfalls" height={300}>
            {(rows) => (
              <WorstShortfallsTable rows={rows} />
            )}
          </ChartData>
        </ChartCard>
      </div>
    </div>
  );
}

type ChartCardProps = {
  title: string;
  scope: string;
  children: React.ReactNode;
  className?: string;
  flush?: boolean;
};

function ChartCard({ title, scope, children, className = '', flush = false }: ChartCardProps) {
  return (
    <div className={`rounded-xl border border-border bg-card overflow-hidden ${className}`}>
      {!flush && (
        <div className="px-6 py-4 border-b border-border">
          <h3 className="font-semibold text-sm">{title}</h3>
          <div className="text-xs text-muted-foreground mt-1">{scope}</div>
        </div>
      )}
      {flush && (
        <div className="px-6 pt-4 pb-2">
          <h3 className="font-semibold text-sm">{title}</h3>
          <div className="text-xs text-muted-foreground">{scope}</div>
        </div>
      )}
      <div className="px-6 py-4">{children}</div>
    </div>
  );
}

function ChartData<T = Record<string, unknown>>({
  chartKey,
  height,
  children,
}: {
  chartKey: string;
  height: number;
  children: (rows: T[]) => React.ReactNode;
}) {
  const { data, error, isLoading } = useChartData<T>(chartKey);

  if (isLoading) {
    return (
      <div
        style={{ height: `${height}px` }}
        className="flex items-center justify-center text-muted-foreground text-sm"
      >
        Loading…
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-lg border border-destructive/40 bg-destructive/5 px-4 py-3 text-sm text-destructive">
        {error}
      </div>
    );
  }

  return children(data ?? []);
}

type WorstShortfallRow = {
  store_name: string;
  city: string;
  product_name: string;
  on_hand: number;
  avg_daily_velocity: number;
  lost_sales_exposure_usd: number;
};

function WorstShortfallsTable({ rows }: { rows: WorstShortfallRow[] }) {
  if (rows.length === 0) {
    return (
      <div className="text-center text-muted-foreground text-sm py-8">
        No data available.
      </div>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="bg-muted text-xs uppercase tracking-wider text-muted-foreground border-b border-border">
          <tr>
            <th className="text-left px-4 py-2 font-semibold">Store</th>
            <th className="text-left px-4 py-2 font-semibold">City</th>
            <th className="text-left px-4 py-2 font-semibold">Product</th>
            <th className="text-left px-4 py-2 font-semibold">On hand</th>
            <th className="text-left px-4 py-2 font-semibold">7d velocity</th>
            <th className="text-right px-4 py-2 font-semibold">Exposure $</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {rows.map((row, i) => (
            <tr key={i} className="hover:bg-muted/40 transition-colors">
              <td className="px-4 py-2 font-medium">{row.store_name}</td>
              <td className="px-4 py-2 text-muted-foreground">{row.city}</td>
              <td className="px-4 py-2">{row.product_name}</td>
              <td className="px-4 py-2 font-mono">{row.on_hand}</td>
              <td className="px-4 py-2 font-mono">
                {row.avg_daily_velocity.toFixed(1)}/day
              </td>
              <td className="px-4 py-2 text-right font-mono">
                ${row.lost_sales_exposure_usd.toLocaleString(undefined, {
                  maximumFractionDigits: 0,
                })}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
