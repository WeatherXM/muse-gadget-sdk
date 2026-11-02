// Calls the Worker's /api/* proxy for https://api.muse.ai, which has no CORS
// headers. The contract matches esp32/tools/muse/muse_setup_server.py, so the
// page works the same against `wrangler dev`, the hosted Worker, or the local
// Python server.

export interface ProxyHealth {
  ok: boolean;
  upstream?: string;
  api_version?: string;
}

export interface MintedDeviceTokens {
  accessToken: string;
  refreshToken: string;
}

export interface MuseVm {
  vm_id?: string;
  name?: string;
  status?: string;
  [key: string]: unknown;
}

const ACCOUNT_API_HOSTS = new Set(['muse.ai', 'api.muse.ai', 'www.muse.ai']);

/**
 * The device's hatch.host is a bare hostname the firmware resolves directly
 * (default hatch.metaaivm.com). Strips any scheme or path, and drops the
 * account API hosts, which older setup pages wrote here.
 */
export function normalizeMuseHost(value: string): { host: string; ignoredAccountApi: boolean } {
  const host = String(value || '')
    .trim()
    .replace(/^[a-z]+:\/\//i, '')
    .replace(/[/?#].*$/, '')
    .toLowerCase();
  if (ACCOUNT_API_HOSTS.has(host)) {
    return { host: '', ignoredAccountApi: true };
  }
  return { host, ignoredAccountApi: false };
}

async function readJson(res: Response): Promise<Record<string, unknown>> {
  try {
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function errorDetail(data: Record<string, unknown>): string {
  const detail = data.error ?? data.detail ?? data.message;
  return typeof detail === 'string' ? detail : JSON.stringify(data);
}

export async function checkProxyHealth(): Promise<ProxyHealth | null> {
  try {
    const res = await fetch('/api/health', { cache: 'no-store' });
    if (!res.ok) return null;
    return (await res.json()) as ProxyHealth;
  } catch {
    return null;
  }
}

/** The SDK token default, served only by a local Worker or setup server. */
export async function fetchSdkTokenDefault(): Promise<string> {
  try {
    const res = await fetch('/api/secrets', { cache: 'no-store' });
    if (!res.ok) return '';
    const data = await readJson(res);
    return typeof data.sdk_token === 'string' ? data.sdk_token.trim() : '';
  } catch {
    return '';
  }
}

/** Mints a 365-day device access/refresh token pair for a homelink-xxxxxx node. */
export async function mintDeviceTokens(params: {
  webToken: string;
  deviceId: string;
  sdkToken?: string;
}): Promise<MintedDeviceTokens> {
  const res = await fetch('/api/mint', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      web_token: params.webToken,
      device_id: params.deviceId,
      sdk_token: params.sdkToken ?? '',
    }),
  });
  const data = await readJson(res);
  const accessToken = typeof data.access_token === 'string' ? data.access_token : '';
  const refreshToken = typeof data.refresh_token === 'string' ? data.refresh_token : '';
  if (!res.ok || !accessToken || !refreshToken) {
    throw new Error(`Mint failed (HTTP ${res.status}): ${errorDetail(data)}`);
  }
  return { accessToken, refreshToken };
}

/** Lists the account's Muse VMs with a device access_token (or web token). */
export async function fetchVms(accessToken: string): Promise<MuseVm[]> {
  const res = await fetch('/api/fetch_vms', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ access_token: accessToken }),
  });
  const data = await readJson(res);
  if (!res.ok) {
    throw new Error(`fetch_vms failed (HTTP ${res.status}): ${errorDetail(data)}`);
  }
  return Array.isArray(data.vm_list) ? (data.vm_list as MuseVm[]) : [];
}
