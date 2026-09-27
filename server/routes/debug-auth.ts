import type { Application, Request } from 'express';
import { authHeaders } from '../lib/auth.js';

/**
 * Diagnostic route for the intermittent "403 Invalid Token" model-call flake.
 * GET /api/debug/auth → which credential this request carries (forwarded
 * user OBO token vs app-SP fallback), its decoded JWT claims, and a live
 * probe of the Responses-API gateway with it. Never returns a raw token —
 * claims only, so nothing sensitive leaves the app. Open it in the browser
 * while an episode is active to see which side is broken.
 */
function decodeClaims(bearer: string): Record<string, unknown> {
  const part = bearer.split('.')[1] ?? '';
  try {
    return JSON.parse(
      Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'),
    );
  } catch {
    return { decode_error: 'not a decodable JWT' };
  }
}

async function probeGateway(bearer: string, host: string) {
  try {
    const resp = await fetch(`${host}/serving-endpoints/responses`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${bearer}`,
        'Content-Type': 'application/json',
      },
      signal: AbortSignal.timeout(20_000),
      body: JSON.stringify({
        model: 'databricks-gpt-5-4',
        input: [{ role: 'user', content: [{ type: 'input_text', text: 'hi' }] }],
        stream: false,
        max_output_tokens: 16,
      }),
    });
    return { status: resp.status, body: (await resp.text()).slice(0, 300) };
  } catch (e) {
    return { error: (e as Error).message };
  }
}

export function registerDebugAuthRoutes(app: Application): void {
  app.get('/api/debug/auth', async (req: Request, res) => {
    const forwarded = req.headers['x-forwarded-access-token'] as string | undefined;
    const headers = await authHeaders(req);
    const bearer = headers.get('Authorization')?.replace(/^Bearer /, '') ?? '';
    const host = (process.env.DATABRICKS_HOST ?? '').replace(/\/$/, '');

    const source = forwarded ? 'forwarded-user-token' : 'app-sp-fallback';
    const out: Record<string, unknown> = {
      source,
      hasForwardedToken: Boolean(forwarded),
      hasForwardedEmail: Boolean(req.headers['x-forwarded-email']),
      bearerClaims: bearer ? decodeClaims(bearer) : null,
      bearerLength: bearer.length,
    };

    if (bearer && host) {
      out.gatewayProbe = await probeGateway(bearer, host);
    }
    res.json(out);
  });
}
