/**
 * Genie over the Databricks MANAGED MCP endpoint — the app's ask_data path,
 * MCP-native.
 *
 * The workspace exposes every Genie space as a managed MCP server at
 *   POST /api/2.0/mcp/genie/<space_id>
 * speaking Streamable-HTTP MCP (JSON-RPC 2.0). This client does the minimal
 * handshake: initialize (capture the Mcp-Session-Id) → notifications/
 * initialized → tools/list (discover the query tool + its question arg name)
 * → tools/call. Responses may arrive as plain JSON or text/event-stream —
 * both are parsed.
 *
 * callGenieViaMcp returns null on ANY failure so the caller can fall back to
 * the Genie REST path transparently (see genie.ts — GENIE_MCP=0 disables).
 */
import { authHeaders } from '../../lib/auth.js';
import type { DataCallResult, DataToolContext } from './types.js';

const PROTOCOL_VERSION = '2025-03-26';

/**
 * Detect a PENDING Genie MCP response: the query tool's text payload is JSON
 * carrying conversation_id + message_id + a non-terminal status. Returns the
 * ids to poll with, or null when the payload is a final answer (or not JSON
 * at all). Terminal statuses: COMPLETED / SUCCEEDED / FAILED / CANCELLED —
 * FAILED/CANCELLED aren't retried either; the text then speaks for itself.
 */
function parseGenieHandle(
  text: string,
): { conversationId: string; messageId: string } | null {
  try {
    const obj = JSON.parse(text) as Record<string, unknown>;
    const cid = obj['conversation_id'];
    const mid = obj['message_id'];
    const status = String(obj['status'] ?? '').toUpperCase();
    if (typeof cid !== 'string' || typeof mid !== 'string') return null;
    if (!status || ['COMPLETED', 'SUCCEEDED', 'FAILED', 'CANCELLED'].includes(status))
      return null;
    return { conversationId: cid, messageId: mid };
  } catch {
    return null;
  }
}

type JsonRpcResult = {
  payload: {
    result?: {
      tools?: Array<{
        name: string;
        description?: string;
        inputSchema?: { properties?: Record<string, unknown> };
      }>;
      content?: Array<{ type?: string; text?: string }>;
      isError?: boolean;
    };
    error?: { code?: number; message?: string };
  };
  sessionId: string | undefined;
};

export async function callGenieViaMcp(
  ctx: DataToolContext,
  spaceId: string,
  question: string,
): Promise<DataCallResult | null> {
  const url = `${ctx.databricksHost}/api/2.0/mcp/genie/${spaceId}`;
  const baseHeaders = await authHeaders(ctx.req);
  baseHeaders.set('Content-Type', 'application/json');
  baseHeaders.set('Accept', 'application/json, text/event-stream');

  async function rpc(
    method: string,
    params: unknown,
    sessionId: string | undefined,
    id: number,
    timeoutMs = 60_000,
  ): Promise<JsonRpcResult> {
    const h = new Headers(baseHeaders);
    if (sessionId) h.set('Mcp-Session-Id', sessionId);
    const resp = await fetch(url, {
      method: 'POST',
      headers: h,
      signal: AbortSignal.timeout(timeoutMs),
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
    });
    if (!resp.ok) {
      throw new Error(`MCP ${method} → HTTP ${resp.status}`);
    }
    const sid = resp.headers.get('mcp-session-id') ?? sessionId;
    const ct = resp.headers.get('content-type') ?? '';
    let payload: JsonRpcResult['payload'];
    if (ct.includes('text/event-stream')) {
      const text = await resp.text();
      const dataLines = text
        .split('\n')
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).trim())
        .filter(Boolean);
      if (!dataLines.length) throw new Error(`MCP ${method} → empty SSE body`);
      payload = JSON.parse(dataLines[dataLines.length - 1]);
    } else {
      payload = (await resp.json()) as JsonRpcResult['payload'];
    }
    if (payload?.error) {
      throw new Error(`MCP ${method} → ${payload.error.message ?? 'rpc error'}`);
    }
    return { payload, sessionId: sid };
  }

  try {
    const init = await rpc(
      'initialize',
      {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'northpeak-store-ops', version: '1.0.0' },
      },
      undefined,
      1,
    );
    // Best-effort initialized notification (id 0 unused for notifications;
    // the endpoint tolerates a POST without result).
    await rpc('notifications/initialized', {}, init.sessionId, 2, 10_000).catch(() => ({
      payload: {},
      sessionId: init.sessionId,
    }));

    const list = await rpc('tools/list', {}, init.sessionId, 3);
    const tools = list.payload.result?.tools ?? [];
    if (!tools.length) throw new Error('MCP: Genie endpoint returned no tools');
    const queryTool =
      tools.find((t) => /query|ask/i.test(t.name)) ?? tools[0];
    // The question argument name comes from the tool's input schema — don't
    // hardcode it ("question" today, but the endpoint owns the contract).
    const argName = Object.keys(queryTool.inputSchema?.properties ?? {})[0];
    if (!argName) throw new Error(`MCP: tool ${queryTool.name} has no input args`);

    const call = await rpc(
      'tools/call',
      { name: queryTool.name, arguments: { [argName]: question } },
      init.sessionId,
      4,
      180_000, // Genie investigations take 20–40s; give the tool call room.
    );
    let content = call.payload.result?.content ?? [];

    // Async protocol: the query tool may return an IN-PROGRESS handle —
    // {"conversation_id": …, "message_id": …, "status": "…"} — and expects
    // the endpoint's poll_response tool to finish the job. Without this the
    // raw handle leaked into the chat as "the response requires a poll
    // step". Poll until COMPLETED (budget ~150s), then use the poll result.
    const pollTool = tools.find((t) => /poll/i.test(t.name));
    const text0 = content
      .filter((c) => c.type === 'text' && typeof c.text === 'string')
      .map((c) => c.text as string)
      .join('\n\n')
      .trim();
    const ids = parseGenieHandle(text0);
    if (ids && pollTool) {
      const deadline = Date.now() + 150_000;
      let done = false;
      while (!done && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 2000));
        const poll = await rpc(
          'tools/call',
          {
            name: pollTool.name,
            arguments: {
              conversation_id: ids.conversationId,
              message_id: ids.messageId,
            },
          },
          init.sessionId,
          5,
          60_000,
        );
        content = poll.payload.result?.content ?? [];
        const pollText = content
          .filter((c) => c.type === 'text' && typeof c.text === 'string')
          .map((c) => c.text as string)
          .join('\n\n')
          .trim();
        done = !parseGenieHandle(pollText); // no pending handle = final answer
      }
      if (!done) throw new Error('MCP: Genie poll timed out after 150s');
    }

    const answer = content
      .filter((c) => c.type === 'text' && typeof c.text === 'string')
      .map((c) => c.text as string)
      .join('\n\n')
      .trim();
    if (!answer) throw new Error('MCP: empty answer from Genie tool');
    return { answer, trace_id: null };
  } catch (e) {
    console.warn(
      '[genie-mcp] MCP path failed, caller will fall back to REST:',
      (e as Error).message,
    );
    return null;
  }
}
