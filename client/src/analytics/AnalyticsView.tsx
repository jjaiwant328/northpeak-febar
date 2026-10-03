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

const ZONES = ['North', 'South', 'Mixed'] as const;
const ZONE_COLORS = ['#E5484D', '#FFB020', '#3C6997']; // matches the map
const STATUS_KEYS = ['stockout', 'at_risk', 'overstock'] as const;
const STATUS_COLORS = ['#E5484D', '#E07A00', '#FFB020'];

/** Long rows {week, climate_zone, units_sold} → wide {week, North, South, Mixed}. */
function pivotVelocity(rows: Record<string, unknown>[]) {
  const byWeek = new Map<string, Record<string, unknown>>();
  for (const r of rows) {
    const week = String(r.week).slice(0, 10);
    const cur = byWeek.get(week) ?? { week };
    cur[String(r.climate_zone)] = Number(r.units_sold);
    byWeek.set(week, cur);
  }
  return [...byWeek.values()].sort((a, b) =>
    String(a.week).localeCompare(String(b.week)),
  );
}

/** Long rows {climate_zone, position_status, position_count} → wide per zone. */
function pivotZoneMix(rows: Record<string, unknown>[]) {
  const byZone = new Map<string, Record<string, unknown>>();
  for (const r of rows) {
    const zone = String(r.climate_zone);
    const cur = byZone.get(zone) ?? { climate_zone: zone };
    cur[String(r.position_status)] = Number(r.position_count);
    byZone.set(zone, cur);
  }
  return ZONES.map((z) => byZone.get(z) ?? { climate_zone: z }).filter(
    (r) => Object.keys(r).length > 1,
  );
}

export function AnalyticsView() {
  const [warehouse, setWarehouse] = useState<Warehouse | null>(null);
  const [trendZone, setTrendZone] = useState<'all' | (typeof ZONES)[number]>('all');

  useEffect(() => {
    fetchWarehouse().then(setWarehouse).catch(console.error);
  }, []);

  const trendYKeys = trendZone === 'all' ? [...ZONES] : [trendZone];
  const trendColors =
    trendZone === 'all'
      ? [...ZONE_COLORS]
      : [ZONE_COLORS[ZONES.indexOf(trendZone)]];

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
            scope="Last 8 weeks · weekly units sold, by climate zone"
            about="Weekly units sold on the 5 cold-weather SKUs, split by climate zone. The North ramps ~3 weeks before the incident while the South stays flat — the divergence that drove the shortfall. Source: silver_sales via SQL warehouse. Click legend entries to toggle series."
            className="lg:col-span-3"
            actions={
              <div className="flex gap-1">
                {(['all', ...ZONES] as const).map((z) => (
                  <button
                    key={z}
                    onClick={() => setTrendZone(z as typeof trendZone)}
                    className={`px-2 py-0.5 rounded-full text-[11px] font-medium border transition-colors ${
                      trendZone === z
                        ? 'border-foreground/50 text-foreground bg-muted'
                        : 'border-border text-muted-foreground hover:text-foreground'
                    }`}
                  >
                    {z === 'all' ? 'All' : z}
                  </button>
                ))}
              </div>
            }
          >
            <ChartData chartKey="cold_weather_velocity_trend" height={260}>
              {(rows) => (
                <LineChart
                  data={pivotVelocity(rows)}
                  xKey="week"
                  yKey={trendYKeys}
                  colors={trendColors}
                  height={260}
                  showLegend
                  smooth
                />
              )}
            </ChartData>
          </ChartCard>

          <ChartCard
            title="Position mix by climate zone"
            scope="Non-healthy positions on the 5 affected SKUs"
            about="Store×SKU positions (excluding healthy) on the 5 affected SKUs, counted by climate zone and status. The North skews stockout, the South skews overstock — the split the recovery moves work against. Source: gold_store_sku_position. Click legend entries to toggle series."
            className="lg:col-span-2"
          >
            <ChartData chartKey="position_mix_by_zone" height={260}>
              {(rows) => (
                <BarChart
                  data={pivotZoneMix(rows)}
                  xKey="climate_zone"
                  yKey={[...STATUS_KEYS]}
                  colors={[...STATUS_COLORS]}
                  height={260}
                  showLegend
                />
              )}
            </ChartData>
          </ChartCard>
        </div>

        <ChartCard
          title="Worst shortfalls"
          scope="Top 4 per SKU, by annualized lost-sales exposure"
          about="The worst open shortfalls — top 4 per SKU by annualized lost-sales exposure (price × recent velocity, zero on-hand). Filter by product or click a column to sort. Source: gold_store_sku_position."
          flush
        >
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
  /** Plain-English explanation, shown on the ⓘ hover tooltip. */
  about?: string;
  /** Optional header-right content (filter buttons etc.). */
  actions?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  flush?: boolean;
};

function ChartCard({ title, scope, about, actions, children, className = '', flush = false }: ChartCardProps) {
  const header = (
    <>
      <div className="flex items-center gap-1.5 min-w-0">
        <h3 className="font-semibold text-sm truncate">{title}</h3>
        {about && (
          <span className="relative inline-grid place-items-center size-4 rounded-full border border-border text-[10px] text-muted-foreground cursor-help shrink-0 group">
            i
            <span className="pointer-events-none absolute left-1/2 -translate-x-1/2 top-full mt-2 z-50 hidden group-hover:block w-72 rounded-lg border border-border bg-popover px-3 py-2 text-[11px] font-normal normal-case tracking-normal text-popover-foreground shadow-xl">
              {about}
            </span>
          </span>
        )}
      </div>
      <div className="text-xs text-muted-foreground">{scope}</div>
    </>
  );
  return (
    <div className={`rounded-xl border border-border bg-card overflow-hidden ${className}`}>
      {!flush && (
        <div className="px-6 py-4 border-b border-border flex items-center justify-between gap-3 flex-wrap">
          {header}
          {actions}
        </div>
      )}
      {flush && (
        <div className="px-6 pt-4 pb-2 flex items-center justify-between gap-3 flex-wrap">
          {header}
          {actions}
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

type SortKey = 'store_name' | 'city' | 'product_name' | 'on_hand' | 'avg_daily_velocity' | 'lost_sales_exposure_usd';

const COLUMNS: Array<{ key: SortKey; label: string; numeric?: boolean }> = [
  { key: 'store_name', label: 'Store' },
  { key: 'city', label: 'City' },
  { key: 'product_name', label: 'Product' },
  { key: 'on_hand', label: 'On hand', numeric: true },
  { key: 'avg_daily_velocity', label: '7d velocity', numeric: true },
  { key: 'lost_sales_exposure_usd', label: 'Exposure $', numeric: true },
];

function WorstShortfallsTable({ rows }: { rows: WorstShortfallRow[] }) {
  const [product, setProduct] = useState<string>('all');
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({
    key: 'lost_sales_exposure_usd',
    dir: -1,
  });

  const products = [...new Set(rows.map((r) => r.product_name))].sort();

  const visible = rows
    .filter((r) => product === 'all' || r.product_name === product)
    .sort((a, b) => {
      const av = a[sort.key];
      const bv = b[sort.key];
      const cmp =
        typeof av === 'number' && typeof bv === 'number'
          ? av - bv
          : String(av).localeCompare(String(bv));
      return cmp * sort.dir;
    });

  if (rows.length === 0) {
    return (
      <div className="text-center text-muted-foreground text-sm py-8">
        No data available.
      </div>
    );
  }

  return (
    <div className="overflow-x-auto">
      <div className="flex items-center gap-2 pb-3">
        <label className="text-xs text-muted-foreground" htmlFor="wsf-product">
          Product
        </label>
        <select
          id="wsf-product"
          value={product}
          onChange={(e) => setProduct(e.target.value)}
          className="text-xs rounded-md border border-border bg-background px-2 py-1"
        >
          <option value="all">All ({rows.length})</option>
          {products.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
        <span className="text-xs text-muted-foreground ml-auto">
          Click a column to sort
        </span>
      </div>
      <table className="w-full text-sm">
        <thead className="bg-muted text-xs uppercase tracking-wider text-muted-foreground border-b border-border">
          <tr>
            {COLUMNS.map((c) => (
              <th
                key={c.key}
                onClick={() =>
                  setSort((s) =>
                    s.key === c.key ? { key: c.key, dir: (s.dir * -1) as 1 | -1 } : { key: c.key, dir: c.numeric ? -1 : 1 },
                  )
                }
                className={`px-4 py-2 font-semibold cursor-pointer select-none hover:text-foreground ${c.numeric ? 'text-right' : 'text-left'}`}
                title={`Sort by ${c.label}`}
              >
                {c.label}
                {sort.key === c.key ? (sort.dir === 1 ? ' ↑' : ' ↓') : ''}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {visible.map((row, i) => (
            <tr key={i} className="hover:bg-muted/40 transition-colors">
              <td className="px-4 py-2 font-medium">{row.store_name}</td>
              <td className="px-4 py-2 text-muted-foreground">{row.city}</td>
              <td className="px-4 py-2">{row.product_name}</td>
              <td className="px-4 py-2 text-right font-mono">{row.on_hand}</td>
              <td className="px-4 py-2 text-right font-mono">
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
