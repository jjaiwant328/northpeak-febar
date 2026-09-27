/**
 * REST helpers for the store operations domain (positions, shortfalls,
 * recovery actions, activity feed).
 *
 * REPURPOSING THE TEMPLATE: when you swap data models, rename this file
 * to match your domain (e.g. `lib/turbines.ts`, `lib/claims.ts`) and
 * update the imports that reference it. The TYPES live in
 * `shared/types.ts` — change those there, not here. This file should
 * only contain `fetch` calls.
 */
import { okOrThrow } from './api';
import type {
  StoreBucket,
  PositionStatus,
  PositionRow,
  PositionDetail,
  PositionSummary,
  ActivityEvent,
} from '@/shared/types';

export async function fetchPositions(
  filters: {
    statusGroup?: 'open' | 'all';
    status?: PositionStatus;
    zone?: string;
    category?: string;
    store?: string;
    sku?: string;
    sort?: 'exposure' | 'velocity';
  } = {},
): Promise<PositionRow[]> {
  const qs = new URLSearchParams();
  if (filters.statusGroup) qs.set('statusGroup', filters.statusGroup);
  if (filters.status) qs.set('status', filters.status);
  if (filters.zone) qs.set('zone', filters.zone);
  if (filters.category) qs.set('category', filters.category);
  if (filters.store) qs.set('store', filters.store);
  if (filters.sku) qs.set('sku', filters.sku);
  if (filters.sort) qs.set('sort', filters.sort);
  const res = await okOrThrow(await fetch(`/api/positions?${qs}`), '/api/positions');
  return res.json();
}

export async function fetchPositionSummary(): Promise<PositionSummary> {
  const res = await okOrThrow(
    await fetch('/api/positions/summary'),
    '/api/positions/summary',
  );
  return res.json();
}

export async function fetchStoreBreakdown(
  filters: {
    statusGroup?: 'open' | 'all';
    status?: PositionStatus;
    zone?: string;
  } = {},
): Promise<StoreBucket[]> {
  const qs = new URLSearchParams();
  if (filters.statusGroup) qs.set('statusGroup', filters.statusGroup);
  if (filters.status) qs.set('status', filters.status);
  if (filters.zone) qs.set('zone', filters.zone);
  const res = await okOrThrow(
    await fetch(`/api/positions/by-store?${qs}`),
    '/api/positions/by-store',
  );
  return res.json();
}

export async function fetchPosition(id: string): Promise<PositionDetail> {
  const res = await okOrThrow(
    await fetch(`/api/positions/${encodeURIComponent(id)}`),
    `/api/positions/${id}`,
  );
  return res.json();
}

export async function fetchStorePositions(
  storeId: string,
  limit = 10,
): Promise<PositionRow[]> {
  const res = await okOrThrow(
    await fetch(`/api/stores/${encodeURIComponent(storeId)}/positions?limit=${limit}`),
    `/api/stores/${storeId}/positions`,
  );
  return res.json();
}

export async function fetchActivity(limit = 20): Promise<ActivityEvent[]> {
  const res = await okOrThrow(
    await fetch(`/api/activity/recent?limit=${limit}`),
    '/api/activity/recent',
  );
  return res.json();
}
