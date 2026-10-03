/**
 * "Stores by shortfall position" — bubble map.
 *
 * Real world map (OSM raster tiles via react-leaflet) with
 * one CircleMarker per store. Radius = sqrt-scaled recent velocity.
 * Color by position status (stockout/at_risk/overstock/healthy). When the
 * agent's bulk write fires `dataMutated`, every store bucket is refetched
 * and the bubbles whose status changed get a brief stroke-thickening "pulse".
 *
 * Implementation notes (Leaflet has sharp edges):
 *   - radius is a top-level prop → react-leaflet calls setRadius() on diff.
 *   - pathOptions go through setStyle() — color, fillColor, weight all work.
 *   - className on pathOptions only applies at layer-create time (Leaflet's
 *     setStyle does NOT touch className), so we DON'T use CSS keyframes
 *     for the pulse — we vary `weight` (stroke width) for 1s instead.
 *   - FitBounds only re-fits when the set of store IDs changes,
 *     not on count-only updates — otherwise the map wobbles every refetch.
 *   - Leaflet CSS is imported in client/src/index.css (not here) so tile
 *     sizing is correct on first paint, including HMR.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Globe2, RefreshCw } from 'lucide-react';
import {
  CircleMarker,
  MapContainer,
  TileLayer,
  Tooltip,
  useMap,
} from 'react-leaflet';
import { fetchStoreBreakdown } from '@/lib/stores';
import { dataMutated } from '@/lib/events';
import type { StoreBucket, PositionStatus } from '@/shared/types';

type Props = {
  statusGroup?: 'open' | 'all';
  zone?: string;
  onSelectStore?: (storeId: string) => void;
};

// Color map: each position status gets a distinct hex
const STATUS_COLORS: Record<PositionStatus, string> = {
  stockout: '#E5484D',
  at_risk: '#E07A00',
  overstock: '#FFB020',
  healthy: '#3C6997',
};

const RADIUS_MIN = 3;
const RADIUS_MAX = 14;
const RADIUS_SCALE = 1.5;
const PULSE_MS = 1100;
const PULSE_WEIGHT = 4;
const REST_WEIGHT = 1.5;

function radiusFor(velocity: number): number {
  return Math.max(
    RADIUS_MIN,
    Math.min(RADIUS_MAX, Math.sqrt(Math.max(1, velocity)) * RADIUS_SCALE),
  );
}

// Re-fit only when the SET of store keys changes.
// Count/velocity-only changes must NOT pan the map.
function FitBoundsOnSetChange({ stores }: { stores: StoreBucket[] }) {
  const map = useMap();
  const lastKey = useRef<string>('');

  useEffect(() => {
    if (stores.length === 0) return;
    const key = stores
      .map((s) => `${s.storeId}`)
      .sort()
      .join('|');
    if (key === lastKey.current) return;
    lastKey.current = key;

    const lats = stores.map((s) => s.lat);
    const lngs = stores.map((s) => s.lng);
    const minLat = Math.min(...lats);
    const maxLat = Math.max(...lats);
    const minLng = Math.min(...lngs);
    const maxLng = Math.max(...lngs);
    if (Math.abs(maxLat - minLat) < 0.5 && Math.abs(maxLng - minLng) < 0.5) {
      map.setView([stores[0].lat, stores[0].lng], 6, { animate: true });
      return;
    }
    map.fitBounds(
      [
        [minLat, minLng],
        [maxLat, maxLng],
      ],
      { padding: [40, 40], animate: true },
    );
  }, [stores, map]);
  return null;
}

export function StoreMap({ statusGroup, zone, onSelectStore }: Props) {
  const [stores, setStores] = useState<StoreBucket[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    function reload() {
      fetchStoreBreakdown({
        statusGroup,
        zone: zone || undefined,
      })
        .then((data) => {
          if (cancelled) return;
          setStores(data);
          setError(null);
        })
        .catch((e) => {
          if (cancelled) return;
          setError((e as Error).message);
        });
    }
    reload();
    const unsub = dataMutated.subscribe(reload);
    return () => {
      cancelled = true;
      unsub();
    };
  }, [statusGroup, zone]);

  if (error) {
    return (
      <div className="rounded-xl border border-destructive/40 bg-destructive/5 px-4 py-3 text-sm text-destructive">
        Couldn't load the map: {error}
      </div>
    );
  }

  if (stores === null) {
    return (
      <div className="rounded-xl border border-border bg-card h-[280px] sm:h-[340px] flex items-center justify-center text-sm text-muted-foreground gap-2">
        <RefreshCw className="size-3.5 animate-spin" />
        Loading map…
      </div>
    );
  }

  const totalPositions = stores.reduce((a, s) => a + s.positions, 0);

  return (
    <div className="rounded-xl border border-border bg-card overflow-hidden">
      <div className="px-4 py-3 border-b border-border flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <Globe2 className="size-4 text-muted-foreground shrink-0" />
          <h3 className="text-sm font-semibold truncate">
            Stores by position
          </h3>
        </div>
        <div className="text-xs text-muted-foreground shrink-0">
          {stores.length} {stores.length === 1 ? 'store' : 'stores'} ·{' '}
          {totalPositions} positions
        </div>
      </div>
      <div className="h-[380px] sm:h-[480px] relative">
        {stores.length === 0 ? (
          <div className="h-full flex items-center justify-center text-sm text-muted-foreground">
            No affected stores in the current scope.
          </div>
        ) : (
          <MapContainer
            center={[30, 10]}
            zoom={2}
            minZoom={2}
            scrollWheelZoom={false}
            worldCopyJump
            className="h-full w-full"
            style={{ background: 'var(--muted)' }}
          >
            {/* OSM raster tiles. The previous CARTO basemaps URL is
                quota-limited per client IP and serves an "API KEY required"
                error tile once that quota trips — OSM needs no key. */}
            <TileLayer
              attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
              url="https://tile.openstreetmap.org/{z}/{x}/{y}.png"
              maxZoom={19}
            />
            <FitBoundsOnSetChange stores={stores} />
            {stores.map((s) => (
              <StoreBubble
                key={s.storeId}
                store={s}
                onSelect={onSelectStore}
              />
            ))}
          </MapContainer>
        )}
      </div>
    </div>
  );
}

function StoreBubble({
  store,
  onSelect,
}: {
  store: StoreBucket;
  onSelect?: (storeId: string) => void;
}) {
  // Track whether `store.status` changed between renders to decide if we
  // should pulse.
  const prevStatus = useRef<PositionStatus | null>(null);
  const [pulsing, setPulsing] = useState(false);

  useEffect(() => {
    if (prevStatus.current === null) {
      prevStatus.current = store.status;
      return;
    }
    if (prevStatus.current === store.status) return;
    prevStatus.current = store.status;
    setPulsing(true);
    const t = setTimeout(() => setPulsing(false), PULSE_MS);
    return () => clearTimeout(t);
  }, [store.status]);

  // pathOptions identity must change for react-leaflet to call setStyle().
  // useMemo on (pulsing) — fresh object only when pulse state flips.
  const pathOptions = useMemo(
    () => {
      const color = STATUS_COLORS[store.status];
      return {
        color,
        fillColor: color,
        fillOpacity: pulsing ? 0.75 : 0.55,
        weight: pulsing ? PULSE_WEIGHT : REST_WEIGHT,
      };
    },
    [pulsing, store.status],
  );

  return (
    <CircleMarker
      center={[store.lat, store.lng]}
      radius={radiusFor(store.recentVelocity)}
      pathOptions={pathOptions}
      eventHandlers={
        onSelect
          ? {
              click: () => onSelect(store.storeId),
            }
          : {}
      }
    >
      <Tooltip direction="top" offset={[0, -4]} opacity={1}>
        <div className="text-xs">
          <div className="font-semibold">
            {store.storeName ?? `Store ${store.storeId}`}
            <span className="text-muted-foreground"> · {store.city}</span>
          </div>
          <div>{store.status}</div>
          <div>{store.positions} positions</div>
          <div>
            $
            {store.lostSalesExposureUsd.toLocaleString(undefined, {
              maximumFractionDigits: 0,
            })}{' '}
            lost-sales
          </div>
          {store.markdownExposureUsd > 0 && (
            <div>
              $
              {store.markdownExposureUsd.toLocaleString(undefined, {
                maximumFractionDigits: 0,
              })}{' '}
              markdown
            </div>
          )}
        </div>
      </Tooltip>
    </CircleMarker>
  );
}
