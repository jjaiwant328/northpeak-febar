/**
 * MLflow REST helpers.
 *
 *   - `ensureMlflowExperiment(host, path)` — get-or-create the experiment
 *     the agent traces will be written to. Called once at boot.
 *
 *   - `postMlflowAssessment({host, req, traceId, ...})` — attach a
 *     HUMAN-source assessment to a trace (the thumbs-up/down feedback
 *     path). Best-effort; callers log + continue on failure.
 */
import type { Request } from 'express';
import { getExecutionContext } from '@databricks/appkit';
import { authHeaders } from './auth.js';

/**
 * Resolve the tracing token WITHOUT appkit's execution context — used by the
 * early mlflow.init that must run BEFORE createApp (see server.ts): appkit /
 * the Apps runtime registers the global OTel tracer provider during plugin
 * setup, and once a global provider exists mlflow-tracing's NodeSDK can't
 * install its SpanProcessor — every withSpan then returns a no-op span and
 * messages persist trace_id "no-op-span-trace-id". SP OAuth first (Apps
 * inject DATABRICKS_CLIENT_ID/SECRET), PAT fallback (local dev).
 */
export async function resolveTracingToken(host: string): Promise<string | null> {
  const base = host.replace(/\/$/, '');
  const clientId = process.env.DATABRICKS_CLIENT_ID;
  const clientSecret = process.env.DATABRICKS_CLIENT_SECRET;
  if (clientId && clientSecret) {
    const resp = await fetch(`${base}/oidc/v1/token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
      },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        scope: 'all-apis',
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!resp.ok) return null;
    const json = (await resp.json()) as { access_token?: string };
    return json.access_token ?? null;
  }
  return process.env.DATABRICKS_TOKEN ?? null;
}

/**
 * Same get-or-create as ensureMlflowExperiment but authenticates with an
 * explicit Bearer token (no appkit context required pre-boot).
 */
export async function ensureMlflowExperimentWithToken(
  host: string,
  experimentPath: string,
  token: string,
): Promise<string> {
  const base = host.replace(/\/$/, '');
  const h = new Headers({
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  });
  const timeout = () => AbortSignal.timeout(30 * 1000);

  const getUrl = `${base}/api/2.0/mlflow/experiments/get-by-name?experiment_name=${encodeURIComponent(experimentPath)}`;
  const getResp = await fetch(getUrl, { headers: h, signal: timeout() });
  if (getResp.ok) {
    const body = (await getResp.json()) as { experiment?: { experiment_id?: string } };
    if (body.experiment?.experiment_id) return body.experiment.experiment_id;
  }
  const createResp = await fetch(`${base}/api/2.0/mlflow/experiments/create`, {
    method: 'POST',
    headers: h,
    signal: timeout(),
    body: JSON.stringify({ name: experimentPath }),
  });
  if (!createResp.ok) {
    const errText = await createResp.text();
    if (/Parent directory does not exist/i.test(errText)) {
      const parent = experimentPath.slice(0, experimentPath.lastIndexOf('/'));
      await fetch(`${base}/api/2.0/workspace/mkdirs`, {
        method: 'POST',
        headers: h,
        signal: timeout(),
        body: JSON.stringify({ path: parent }),
      });
      const retry = await fetch(`${base}/api/2.0/mlflow/experiments/create`, {
        method: 'POST',
        headers: h,
        signal: timeout(),
        body: JSON.stringify({ name: experimentPath }),
      });
      if (retry.ok) {
        const body = (await retry.json()) as { experiment_id?: string };
        if (body.experiment_id) return body.experiment_id;
      }
    }
    throw new Error(`mlflow create failed: ${createResp.status} ${errText}`);
  }
  const body = (await createResp.json()) as { experiment_id?: string };
  if (!body.experiment_id) throw new Error('mlflow create returned no experiment_id');
  return body.experiment_id;
}
export async function ensureMlflowExperiment(
  host: string,
  experimentPath: string,
): Promise<string> {
  const h = new Headers();
  const { client } = getExecutionContext();
  await client.config.authenticate(h);
  h.set('Content-Type', 'application/json');

  const base = host.replace(/\/$/, '');

  // 30s cap per MLflow REST call so a hung workspace API can't block boot.
  const timeout = () => AbortSignal.timeout(30 * 1000);

  // 1) Try get-by-name
  const getUrl = `${base}/api/2.0/mlflow/experiments/get-by-name?experiment_name=${encodeURIComponent(experimentPath)}`;
  const getResp = await fetch(getUrl, { method: 'GET', headers: h, signal: timeout() });
  if (getResp.ok) {
    const body = (await getResp.json()) as {
      experiment?: { experiment_id?: string };
    };
    const id = body.experiment?.experiment_id;
    if (id) return id;
  } else if (getResp.status !== 404 && getResp.status !== 400) {
    // 400 is what Databricks returns for missing experiments in some workspaces
    const errText = await getResp.text();
    throw new Error(`mlflow get-by-name failed: ${getResp.status} ${errText}`);
  }

  // 2) Create
  const doCreate = () =>
    fetch(`${base}/api/2.0/mlflow/experiments/create`, {
      method: 'POST',
      headers: h,
      signal: timeout(),
      body: JSON.stringify({ name: experimentPath }),
    });
  let createResp = await doCreate();
  if (!createResp.ok) {
    let errText = await createResp.text();
    // Race: another boot created it already. Retry the get.
    if (/RESOURCE_ALREADY_EXISTS/i.test(errText)) {
      const retry = await fetch(getUrl, { method: 'GET', headers: h, signal: timeout() });
      if (retry.ok) {
        const body = (await retry.json()) as {
          experiment?: { experiment_id?: string };
        };
        const id = body.experiment?.experiment_id;
        if (id) return id;
      }
    }
    // Nested path (e.g. /Shared/<team>/...): experiments/create does
    // NOT create intermediate directories, so a first-ever deploy 404s with
    // "Parent directory does not exist". Create the parent dir (idempotent) and
    // retry the experiment create once.
    if (/Parent directory does not exist/i.test(errText)) {
      const parent = experimentPath.slice(0, experimentPath.lastIndexOf('/'));
      if (parent) {
        await fetch(`${base}/api/2.0/workspace/mkdirs`, {
          method: 'POST',
          headers: h,
          signal: timeout(),
          body: JSON.stringify({ path: parent }),
        });
        createResp = await doCreate();
      }
    }
    if (!createResp.ok) {
      errText = await createResp.text();
      throw new Error(`mlflow create failed: ${createResp.status} ${errText}`);
    }
  }
  const createBody = (await createResp.json()) as { experiment_id?: string };
  if (!createBody.experiment_id) {
    throw new Error('mlflow create returned no experiment_id');
  }
  return createBody.experiment_id;
}

/**
 * Best-effort POST of a user-feedback assessment to an MLflow trace.
 * Returns the created `assessment_id`, or `null` on any failure (caller
 * should log + keep going — the local audit row is still written).
 */
export async function postMlflowAssessment(args: {
  req: Request;
  host: string;
  traceId: string;
  userEmail: string;
  value: 'up' | 'down';
  rationale?: string;
}): Promise<string | null> {
  const { req, host, traceId, userEmail, value, rationale } = args;
  try {
    const base = host.replace(/\/$/, '');
    const headers = await authHeaders(req);
    headers.set('Content-Type', 'application/json');
    const url = `${base}/api/2.0/mlflow/traces/${traceId}/assessments`;
    const resp = await fetch(url, {
      method: 'POST',
      headers,
      signal: AbortSignal.timeout(30 * 1000),
      body: JSON.stringify({
        assessment: {
          trace_id: traceId,
          assessment_name: 'user_feedback',
          source: { source_type: 'HUMAN', source_id: userEmail },
          feedback: { value: value === 'up' },
          ...(rationale ? { rationale } : {}),
        },
      }),
    });
    if (!resp.ok) {
      console.warn(
        '[mlflow] assessment post failed',
        resp.status,
        await resp.text().catch(() => ''),
      );
      return null;
    }
    const json = (await resp.json()) as {
      assessment?: { assessment_id?: string };
    };
    return json.assessment?.assessment_id ?? null;
  } catch (e) {
    console.warn('[mlflow] assessment post threw', (e as Error).message);
    return null;
  }
}
