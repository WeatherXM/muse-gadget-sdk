// Cloudflare Worker: serves the static flasher and proxies the few
// https://api.muse.ai calls the provisioner needs (the API sends no CORS
// headers). The /api/* contract matches esp32/tools/muse/muse_setup_server.py.
// The page calls these same-origin, so no CORS headers are sent.

export interface WorkerAssetFetcher {
  fetch(request: Request | string): Promise<Response>;
}

export interface WorkerD1PreparedStatement {
  bind(...values: unknown[]): { run(): Promise<unknown> };
}

export interface WorkerD1Database {
  prepare(query: string): WorkerD1PreparedStatement;
}

export interface Env {
  ASSETS: WorkerAssetFetcher;
  DB?: WorkerD1Database;
  MUSE_API_URL?: string;
  MUSE_API_VERSION?: string;
  /** Pre-fills the SDK token field. Served only to loopback hosts (wrangler dev)
   * unless MUSE_EXPOSE_SDK_TOKEN is "1", e.g. behind Cloudflare Access. */
  MUSE_SDK_TOKEN?: string;
  MUSE_EXPOSE_SDK_TOKEN?: string;
}

const DEFAULT_MUSE_API_URL = 'https://api.muse.ai';
const DEFAULT_MUSE_API_VERSION = '1.0.0';
const USER_AGENT = 'muse-esp32-provisioner/1.0';
const MAX_FIELD_LENGTH = 8192;

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}

function apiConfig(env: Env): { apiUrl: string; apiVersion: string } {
  return {
    apiUrl: (env.MUSE_API_URL || DEFAULT_MUSE_API_URL).replace(/\/+$/, ''),
    apiVersion: env.MUSE_API_VERSION || DEFAULT_MUSE_API_VERSION,
  };
}

function field(payload: Record<string, unknown>, name: string): string {
  const value = payload[name];
  return typeof value === 'string' ? value.trim().slice(0, MAX_FIELD_LENGTH) : '';
}

async function readPayload(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const body = await request.json();
    return body && typeof body === 'object' ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Calls the Muse API with a bearer token and passes its status and JSON through. */
async function upstream(
  env: Env,
  method: 'GET' | 'POST',
  path: string,
  bearerToken: string,
  body?: Record<string, unknown>,
): Promise<Response> {
  const { apiUrl, apiVersion } = apiConfig(env);
  const url = `${apiUrl}${path}`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${bearerToken}`,
    'X-API-Version': apiVersion,
    Accept: 'application/json',
    'User-Agent': USER_AGENT,
  };
  if (body) headers['Content-Type'] = 'application/json';

  let res: Response;
  try {
    res = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
  } catch (err) {
    return jsonResponse({ error: `Upstream request to ${url} failed: ${String(err)}` }, 502);
  }

  const raw = await res.text();
  let data: unknown;
  try {
    data = raw ? JSON.parse(raw) : {};
  } catch {
    data = res.ok ? { raw } : { error: raw.slice(0, 500) || res.statusText };
  }
  return jsonResponse(data, res.status);
}

async function handleMint(request: Request, env: Env): Promise<Response> {
  const payload = await readPayload(request);
  if (!payload) return jsonResponse({ error: 'Invalid JSON body' }, 400);

  const webToken = field(payload, 'web_token');
  const deviceId = field(payload, 'device_id');
  const sdkToken = field(payload, 'sdk_token');
  if (!webToken) return jsonResponse({ error: 'Missing web_token' }, 400);
  if (!deviceId) return jsonResponse({ error: 'Missing device_id (expected homelink-xxxxxx)' }, 400);

  const body: Record<string, unknown> = { device_id: deviceId };
  if (sdkToken) body.sdk_token = sdkToken;
  return upstream(env, 'POST', '/device_token/mint', webToken, body);
}

async function handleRefresh(request: Request, env: Env): Promise<Response> {
  const payload = await readPayload(request);
  if (!payload) return jsonResponse({ error: 'Invalid JSON body' }, 400);

  const refreshToken = field(payload, 'refresh_token');
  const deviceId = field(payload, 'device_id');
  const sdkToken = field(payload, 'sdk_token');
  if (!refreshToken || !deviceId) {
    return jsonResponse({ error: 'Missing refresh_token or device_id' }, 400);
  }

  const body: Record<string, unknown> = { device_id: deviceId };
  if (sdkToken) body.sdk_token = sdkToken;
  return upstream(env, 'POST', '/device_token/refresh', refreshToken, body);
}

async function handleFetchVms(request: Request, env: Env): Promise<Response> {
  const payload = await readPayload(request);
  if (!payload) return jsonResponse({ error: 'Invalid JSON body' }, 400);

  const accessToken = field(payload, 'access_token');
  if (!accessToken) return jsonResponse({ error: 'Missing access_token' }, 400);
  return upstream(env, 'GET', '/fetch_vms', accessToken);
}

function handleSecrets(url: URL, env: Env): Response {
  const exposed = LOOPBACK_HOSTS.has(url.hostname) || env.MUSE_EXPOSE_SDK_TOKEN === '1';
  return jsonResponse({ sdk_token: exposed ? env.MUSE_SDK_TOKEN || '' : '' });
}

async function handleTelemetry(request: Request, env: Env): Promise<Response> {
  const payload = await readPayload(request);
  if (!payload) return jsonResponse({ error: 'Invalid JSON' }, 400);

  if (env.DB) {
    try {
      await env.DB.prepare(
        `INSERT INTO flash_events (
          event_type, device_model, target_firmware, target_version,
          previous_firmware, previous_version, mode, duration_ms,
          error_message, country
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
        .bind(
          String(payload.eventType ?? 'unknown').slice(0, 64),
          String(payload.deviceModel ?? 'wg1200').slice(0, 64),
          String(payload.targetFirmware ?? '').slice(0, 64),
          String(payload.targetVersion ?? '').slice(0, 64),
          String(payload.previousFirmware ?? '').slice(0, 64),
          String(payload.previousVersion ?? '').slice(0, 64),
          String(payload.mode ?? '').slice(0, 32),
          typeof payload.durationMs === 'number' ? payload.durationMs : null,
          payload.errorMessage ? String(payload.errorMessage).slice(0, 500) : null,
          (request as Request & { cf?: { country?: string } }).cf?.country ?? null,
        )
        .run();
    } catch {
      // Telemetry storage is best-effort and must never break the client flow
    }
  }

  return jsonResponse({ ok: true });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname.startsWith('/api/')) {
      const route = `${request.method} ${url.pathname}`;
      switch (route) {
        case 'GET /api/health': {
          const { apiUrl, apiVersion } = apiConfig(env);
          return jsonResponse({
            ok: true,
            status: 'ok',
            service: 'muse-flasher-cloudflare-worker',
            upstream: apiUrl,
            api_version: apiVersion,
          });
        }
        case 'GET /api/secrets':
          return handleSecrets(url, env);
        case 'POST /api/mint':
          return handleMint(request, env);
        case 'POST /api/refresh':
          return handleRefresh(request, env);
        case 'POST /api/fetch_vms':
          return handleFetchVms(request, env);
        case 'POST /api/telemetry':
          return handleTelemetry(request, env);
        default:
          return jsonResponse({ error: `Unknown endpoint: ${route}` }, 404);
      }
    }

    if (env.ASSETS) {
      return env.ASSETS.fetch(request);
    }

    return new Response('Not found', { status: 404 });
  },
};
