/**
 * The Operations page — the WRITE SURFACE for the use case.
 *
 * Template intent: every use case has a "work queue" — rows waiting for a
 * decision + an audit trail of what happened. This page renders that queue
 * from Lakebase (live, writable, transactional) and stays in sync with the
 * agent's actions via the `dataMutated` pub/sub (when the chat stream
 * completes, the queue refetches — so you literally WATCH the agent's
 * writes land here).
 *
 * Responsibility: orchestration only — owns filter/selection state, fetches
 * data, subscribes to `dataMutated`. Sub-components render the pieces:
 *
 *    KpiCards       — lost-sales / markdown / open shortfalls at a glance
 *    StoreMap       — per-store status map, click to filter
 *    ShortfallTable — filterable queue, click a row to open the drawer
 *    PositionDrawer — slide-over with 3 tabs (Shortfall / Store / Activity)
 *
 * The "Ask the assistant about this spike" banner at the top is the
 * contextual bridge back into the floating dock — clicking it opens the
 * assistant with a scripted prompt prefilled.
 */
import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router';
import { Sparkles, ArrowRight } from 'lucide-react';
import { fetchPositions, fetchPositionSummary } from '@/lib/stores';
import { useSession } from '@/lib/api';
import { dataMutated } from '@/lib/events';
import { dockController } from '@/chat/dockController';
import type {
  PositionRow,
  PositionStatus,
  PositionSummary,
} from '@/shared/types';

import { StoreMap } from './StoreMap';
import { KpiCards } from './KpiCards';
import { ShortfallTable } from './ShortfallTable';
import { PositionDrawer } from './PositionDrawer';
import { IngestionFlow } from '@/architecture/IngestionFlow';

export function OperationsView() {
  const [searchParams, setSearchParams] = useSearchParams();
  const storeFromUrl = searchParams.get('store') ?? '';
  const skuFromUrl = searchParams.get('sku') ?? '';

  const [filter, setFilter] = useState<PositionStatus | 'all' | 'recovery'>(
    (searchParams.get('status') as PositionStatus | 'recovery' | null) ?? 'all',
  );
  const [storeFilter, setStoreFilter] = useState(storeFromUrl);
  const [skuFilter, setSkuFilter] = useState(skuFromUrl);
  const [zoneFilter, setZoneFilter] = useState<string | null>(
    searchParams.get('zone') ?? null,
  );
  const [sort, setSort] = useState<'exposure' | 'velocity'>(
    (searchParams.get('sort') as 'exposure' | 'velocity') ?? 'exposure',
  );
  const [search, setSearch] = useState('');

  // Sync all queue filters → URL so deep links + back/forward work.
  useEffect(() => {
    const next = new URLSearchParams(searchParams);
    const setOrDelete = (key: string, value: string | null) => {
      if (value) next.set(key, value);
      else next.delete(key);
    };
    setOrDelete('store', storeFilter || null);
    setOrDelete('sku', skuFilter || null);
    setOrDelete('zone', zoneFilter);
    setOrDelete('status', filter === 'all' ? null : filter);
    setOrDelete('sort', sort === 'exposure' ? null : sort);
    if (next.toString() !== searchParams.toString()) {
      setSearchParams(next, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storeFilter, skuFilter, zoneFilter, filter, sort]);

  // Update state when URL changes (e.g. user clicks a link from Analytics).
  useEffect(() => {
    const urlStore = searchParams.get('store') ?? '';
    if (urlStore !== storeFilter) setStoreFilter(urlStore);
    const urlSku = searchParams.get('sku') ?? '';
    if (urlSku !== skuFilter) setSkuFilter(urlSku);
    const urlZone = searchParams.get('zone');
    if (urlZone !== zoneFilter) setZoneFilter(urlZone);
    const urlStatus = (searchParams.get('status') as PositionStatus | 'recovery' | null) ?? 'all';
    if (urlStatus !== filter) setFilter(urlStatus);
    const urlSort = (searchParams.get('sort') as 'exposure' | 'velocity') ?? 'exposure';
    if (urlSort !== sort) setSort(urlSort);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  const [rows, setRows] = useState<PositionRow[]>([]);
  const [summary, setSummary] = useState<PositionSummary | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const { config } = useSession();

  async function reload() {
    setLoading(true);
    try {
      // Convert 'recovery' filter to the actual API statusGroup
      let statusParam: PositionStatus | undefined;
      let statusGroup: 'open' | 'all' = 'all';
      if (filter === 'recovery') {
        // Recovery means we want all positions, then we filter client-side
        statusGroup = 'all';
      } else if (filter === 'all') {
        statusGroup = 'all';
      } else {
        statusParam = filter;
        statusGroup = 'all';
      }

      const [list, sum] = await Promise.all([
        fetchPositions({
          statusGroup,
          status: statusParam,
          zone: zoneFilter ?? undefined,
          store: storeFilter || undefined,
          sku: skuFilter || undefined,
          sort,
        }),
        fetchPositionSummary(),
      ]);
      setRows(list);
      setSummary(sum);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter, storeFilter, skuFilter, zoneFilter, sort]);

  useEffect(() => {
    return dataMutated.subscribe(() => {
      void reload();
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter, storeFilter, skuFilter, zoneFilter, sort]);

  // Apply client-side filtering for "recovery in progress" (where liveMoveType is not null)
  const filteredRows = useMemo(() => {
    let result = rows;

    // Status filter
    if (filter === 'recovery') {
      result = result.filter((r) => r.liveMoveType !== null);
    }

    // Search filter
    const q = search.trim().toLowerCase();
    if (q) {
      result = result.filter(
        (r) =>
          (r.storeName ?? '').toLowerCase().includes(q) ||
          (r.city ?? '').toLowerCase().includes(q) ||
          (r.productName ?? '').toLowerCase().includes(q) ||
          (r.productId ?? '').toLowerCase().includes(q),
      );
    }

    return result;
  }, [rows, filter, search]);

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-7xl mx-auto px-4 sm:px-8 py-6 sm:py-10 space-y-6 sm:space-y-8">
        {/* Title + situation + CTA stack on the LEFT; the IngestionFlow
            sits on the RIGHT spanning the full left stack — denser open
            for the Operations page. Stacks under the title on smaller
            screens. */}
        <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)] gap-4 lg:items-end">
          <div className="flex flex-col gap-3">
            <div>
              <div className="text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground mb-2">
                Store ops — shortfall queue
              </div>
              <h1 className="display text-4xl font-semibold tracking-tight text-foreground mb-2">
                Work the shortfall backlog.
              </h1>
            </div>
            <p className="text-muted-foreground max-w-2xl">
              Every red store is a top product a customer came in for and left without.
              Every amber store is margin about to be discounted away.
            </p>
            {config?.assistantScript?.[0] && (
              <button
                onClick={() =>
                  dockController.openAndSend(config.assistantScript[0].prompt)
                }
                className="w-full text-left rounded-xl border border-border bg-card hover:border-foreground/30 hover:shadow-sm px-5 py-4 transition-all flex items-center gap-4 group"
              >
                <div
                  className="size-10 rounded-full flex items-center justify-center shrink-0"
                  style={{
                    background: 'var(--primary)',
                    color: 'var(--primary-foreground)',
                  }}
                >
                  <Sparkles className="size-5" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-[11px] font-semibold uppercase tracking-[0.15em] text-muted-foreground">
                    Ask the assistant
                  </div>
                  <div className="text-sm font-medium text-foreground mt-0.5">
                    About this shortfall spike
                  </div>
                </div>
                <ArrowRight className="size-4 text-muted-foreground group-hover:text-foreground transition-colors shrink-0" />
              </button>
            )}
          </div>
          <IngestionFlow />
        </div>

        {summary && <KpiCards summary={summary} />}

        <StoreMap statusGroup="all" zone={zoneFilter ?? undefined} onSelectStore={setStoreFilter} />

        <ShortfallTable
          rows={filteredRows}
          loading={loading}
          error={error}
          statusFilter={filter}
          onStatusFilter={setFilter}
          search={search}
          onSearch={setSearch}
          zone={zoneFilter ?? undefined}
          onZoneFilter={setZoneFilter}
          sort={sort}
          onSortChange={setSort}
          onSelect={setSelectedId}
        />
      </div>

      <PositionDrawer
        id={selectedId}
        open={selectedId !== null}
        onOpenChange={(open) => {
          if (!open) setSelectedId(null);
        }}
        onMutated={() => {
          setSelectedId(null);
          void reload();
        }}
      />
    </div>
  );
}
