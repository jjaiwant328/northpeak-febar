import type { Application } from 'express';
import {
  getPosition,
  getRecommendation,
  getShortfall,
  listActionsForPosition,
  listPositions,
  positionSummary,
  storeBreakdown,
  type PositionStatus,
} from '../db/queries/index.js';
import type { AppDb } from '../db/index.js';

/**
 * Store-ops read routes — the shortfall queue, KPI summary, store map, and
 * position detail (shortfall context + ranked recovery options + the action
 * timeline). Drives the Operations page (the Visualize layer).
 *
 * NOTE: there is NO write route here. The Act layer writes through the
 * agent's `execute_recovery_action` tool (the trainee's Build-3 task) →
 * app.ops_actions. See APP_WORKSHOP.md.
 */

const VALID_POSITION_STATUS = [
  'stockout',
  'at_risk',
  'overstock',
  'healthy',
] as const;

function strParam(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function intParam(v: unknown, fallback: number, max: number): number {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(Math.floor(n), max);
}

function parsePositionStatus(v: unknown): PositionStatus | undefined {
  const s = strParam(v);
  return s && (VALID_POSITION_STATUS as readonly string[]).includes(s)
    ? (s as PositionStatus)
    : undefined;
}

function parseStatusGroup(v: unknown): 'open' | 'all' | undefined {
  const s = strParam(v);
  return s === 'open' || s === 'all' ? s : undefined;
}

type Deps = { db: AppDb };

export function registerStoreRoutes(app: Application, deps: Deps): void {
  const { db } = deps;

  // --- GET /api/positions (the shortfall queue) --------------------------
  app.get('/api/positions', async (req, res) => {
    const sort = strParam(req.query.sort);
    const rows = await listPositions(db, {
      statusGroup: parseStatusGroup(req.query.statusGroup),
      positionStatus: parsePositionStatus(req.query.status),
      climateZone: strParam(req.query.zone),
      category: strParam(req.query.category),
      store: strParam(req.query.store),
      sku: strParam(req.query.sku),
      sort: sort === 'velocity' || sort === 'exposure' ? sort : undefined,
    });
    res.json(rows);
  });

  // --- GET /api/positions/summary (KPI rollup) ---------------------------
  app.get('/api/positions/summary', async (_req, res) => {
    res.json(await positionSummary(db));
  });

  // --- GET /api/positions/by-store (store map buckets) -------------------
  app.get('/api/positions/by-store', async (req, res) => {
    const rows = await storeBreakdown(db, {
      statusGroup: parseStatusGroup(req.query.statusGroup),
      positionStatus: parsePositionStatus(req.query.status),
      climateZone: strParam(req.query.zone),
    });
    res.json(rows);
  });

  // --- GET /api/positions/:id (detail — shortfall + recommendation + actions)
  // id is the synthetic `${storeId}:${productId}`.
  app.get('/api/positions/:id', async (req, res) => {
    const position = await getPosition(db, req.params.id);
    if (!position) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    const [shortfall, recommendation, actions] = await Promise.all([
      getShortfall(db, position.storeId, position.productId),
      getRecommendation(db, position.storeId, position.productId),
      listActionsForPosition(db, position.storeId, position.productId),
    ]);
    res.json({ position, shortfall, recommendation, actions });
  });

  // --- GET /api/stores/:storeId/positions (all positions for one store) --
  app.get('/api/stores/:storeId/positions', async (req, res) => {
    const rows = await listPositions(db, {
      statusGroup: 'all',
      store: req.params.storeId,
      limit: intParam(req.query.limit, 50, 200),
    });
    res.json(rows);
  });
}
