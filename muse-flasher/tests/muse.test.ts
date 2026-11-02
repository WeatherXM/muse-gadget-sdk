import { afterEach, describe, expect, it, vi } from 'vitest';
import { museNameForNodeId, nodeIdFromBleName, redactCompanionCommand } from '../src/lib/muse/bleClient';
import {
  DIRECTION_D2M,
  DIRECTION_M2D,
  HomeLinkChunkAssembler,
  b64urlEncode,
  buildTranscriptV5,
  decryptD2M,
  deriveSessionKeys,
  encryptM2D,
  frameHomeLinkPayload,
  openEnvelope,
  runCryptoSelfTest,
  sealEnvelope,
  sha256,
} from '../src/lib/muse/homeLinkCrypto';
import { normalizeMuseHost } from '../src/lib/muse/museCloudClient';
import { validateSdkToken } from '../src/lib/muse/sdkToken';
import worker, { type Env } from '../src/worker/index';

const assets = { fetch: async () => new Response('asset') };

describe('SDK token', () => {
  it('validates 48-character mgst_... SDK tokens', () => {
    expect(validateSdkToken('mgst_' + 'A'.repeat(42) + '0').valid).toBe(true);
    expect(validateSdkToken('').empty).toBe(true);
    expect(validateSdkToken('invalid_prefix').valid).toBe(false);
    expect(validateSdkToken('mgst_short').valid).toBe(false);
    // Tail char 'B' is not in [AEIMQUYcgkosw048]
    expect(validateSdkToken('mgst_' + 'A'.repeat(42) + 'B').valid).toBe(false);
  });
});

describe('Home Link v5 (matches muse_full_setup.html and ble_server.c)', () => {
  it('builds the transcript with no trailing newline', () => {
    const t = buildTranscriptV5({
      version: 5,
      device_id: 'hatch-link:aa:bb:cc:dd:ee:ff',
      node_id: 'homelink-ddeeff',
      mac: 'aa:bb:cc:dd:ee:ff',
      model: 'hatch_link',
      firmware_version: '1.0.0',
      pairing_auth: 'none',
      pairing_auth_epoch: 0,
      pairing_policy: 'confirm_press',
      mobile_pub: 'MP',
      device_pub: 'DP',
      mobile_nonce: 'MN',
      device_nonce: 'DN',
    });
    expect(t.startsWith('hatch-link-pairing-v5\nversion=5\ninitiator_role=mobile\nresponder_role=link\n')).toBe(true);
    expect(t).toContain('\nselected_cipher_suite=p256-hkdf-sha256-aes-gcm-v1\n');
    expect(t).toContain('\nconfirm_timeout_seconds=60\n');
    expect(t.endsWith('\nmobile_nonce=MN\ndevice_nonce=DN')).toBe(true);
    expect(t.split('\n')).toHaveLength(18);
  });

  it('derives matching sessions on both sides and enforces counters', async () => {
    const gen = () =>
      crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']) as Promise<CryptoKeyPair>;
    const mobile = await gen();
    const device = await gen();
    const mobilePub = new Uint8Array(await crypto.subtle.exportKey('raw', mobile.publicKey));
    const devicePub = new Uint8Array(await crypto.subtle.exportKey('raw', device.publicKey));
    const mobileNonce = crypto.getRandomValues(new Uint8Array(16));
    const deviceNonce = crypto.getRandomValues(new Uint8Array(16));
    const transcriptHash = await sha256(new TextEncoder().encode('transcript'));

    const m = await deriveSessionKeys({ privateKey: mobile.privateKey, peerPubRaw: devicePub, mobileNonce, deviceNonce, transcriptHash });
    const d = await deriveSessionKeys({ privateKey: device.privateKey, peerPubRaw: mobilePub, mobileNonce, deviceNonce, transcriptHash });
    expect(m.sessionIdB64).toBe(d.sessionIdB64);
    expect(m.sessionIdB64).toHaveLength(22); // 16 bytes, unpadded base64url

    // mobile -> device
    const env = JSON.parse(await encryptM2D(m, { action: 'provision_v2', ssid: 'Home' }));
    expect(env).toMatchObject({ action: 'pairing_encrypted', session_id: m.sessionIdB64, counter: '0' });
    expect(JSON.parse(await openEnvelope(d.m2dKey, d.sessionIdB64, DIRECTION_M2D, env))).toEqual({
      action: 'provision_v2',
      ssid: 'Home',
    });
    expect(m.txCounter).toBe(1n);

    // device -> mobile, in order only
    const reply0 = await sealEnvelope(d.d2mKey, d.sessionIdB64, DIRECTION_D2M, 0n, '{"type":"status","status":"auth_ok"}');
    const reply1 = await sealEnvelope(d.d2mKey, d.sessionIdB64, DIRECTION_D2M, 1n, '{"n":1}');
    await expect(decryptD2M(m, reply1)).rejects.toThrow(/counter/);
    expect(await decryptD2M(m, reply0)).toBe('{"type":"status","status":"auth_ok"}');
    expect(await decryptD2M(m, reply1)).toBe('{"n":1}');

    // A direction mix-up fails authentication.
    const wrongDir = await sealEnvelope(d.d2mKey, d.sessionIdB64, DIRECTION_M2D, 2n, 'x');
    await expect(decryptD2M(m, wrongDir)).rejects.toThrow();
  });

  it('passes its own browser self-test', async () => {
    await expect(runCryptoSelfTest()).resolves.toBeUndefined();
  });

  it('frames payloads as 0xFE chunks of at most 160 bytes and reassembles them', () => {
    const json = JSON.stringify({ action: 'pairing_encrypted', ciphertext: 'x'.repeat(1500) });
    const frames = frameHomeLinkPayload(json);
    expect(frames.length).toBe(Math.ceil(new TextEncoder().encode(json).length / 160));
    for (const [i, f] of frames.entries()) {
      expect([f[0], f[1], f[2]]).toEqual([0xfe, i, frames.length]);
      expect(f.length).toBeLessThanOrEqual(163);
    }
    const asm = new HomeLinkChunkAssembler();
    const results = frames.map((f) => asm.push(f));
    expect(results.slice(0, -1).every((r) => r === null)).toBe(true);
    expect(results.at(-1)).toBe(json);
    expect(asm.push(new TextEncoder().encode('error_pairing_unavailable'))).toBe('error_pairing_unavailable');
    expect(() => frameHomeLinkPayload('x'.repeat(161 * 16))).toThrow(/too large/);
  });

  it('round-trips base64url without padding', () => {
    expect(b64urlEncode(new Uint8Array([0xfb, 0xff, 0xfe]))).toBe('-__-');
  });
});

describe('BLE helpers', () => {
  it('derives homelink-xxxxxx from the advertised name', () => {
    expect(nodeIdFromBleName('MuseGadget-A1B2C3')).toBe('homelink-a1b2c3');
    expect(nodeIdFromBleName('HomeLink-00FF10')).toBe('homelink-00ff10');
    expect(nodeIdFromBleName('MuseGadget-Disp-A1B2C3')).toBeNull();
  });

  it('names the advertised gateway when macOS lists a cached name', () => {
    expect(museNameForNodeId('homelink-e3efc0')).toBe('MuseGadget-E3EFC0');
    expect(museNameForNodeId('MeshCore-DeskOS')).toBeNull();
  });

  it('redacts secrets in logged Companion commands', () => {
    expect(redactCompanionCommand('wifi.pass=hunter2')).toBe('wifi.pass=***');
    expect(redactCompanionCommand('hatch.token=abc')).toBe('hatch.token=***');
    expect(redactCompanionCommand('hatch.token+=abc')).toBe('hatch.token+=***');
    expect(redactCompanionCommand('wifi.ssid=Home')).toBe('wifi.ssid=Home');
  });

  it('normalizes the Muse VM server and drops the account API host', () => {
    expect(normalizeMuseHost('https://hatch.metaaivm.com/ws?x=1')).toEqual({ host: 'hatch.metaaivm.com', ignoredAccountApi: false });
    expect(normalizeMuseHost('  ')).toEqual({ host: '', ignoredAccountApi: false });
    expect(normalizeMuseHost('https://api.muse.ai/')).toEqual({ host: '', ignoredAccountApi: true });
  });
});

describe('Cloudflare Worker /api (matches muse_setup_server.py)', () => {
  afterEach(() => vi.unstubAllGlobals());

  const env = (extra: Partial<Env> = {}): Env => ({ ASSETS: assets, MUSE_API_URL: 'https://api.muse.ai', ...extra });
  const call = (url: string, init?: RequestInit, e: Env = env()) => worker.fetch(new Request(url, init), e);
  const post = (path: string, body: unknown, host = 'https://flash.example.com') =>
    call(`${host}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

  it('reports health without CORS headers', async () => {
    const res = await call('https://flash.example.com/api/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, upstream: 'https://api.muse.ai', api_version: '1.0.0' });
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });

  it('serves the SDK token only to loopback hosts or when explicitly exposed', async () => {
    const e = env({ MUSE_SDK_TOKEN: 'mgst_secret' });
    const remote = await call('https://flash.example.com/api/secrets', undefined, e);
    expect(await remote.json()).toEqual({ sdk_token: '' });
    const local = await call('http://localhost:8787/api/secrets', undefined, e);
    expect(await local.json()).toEqual({ sdk_token: 'mgst_secret' });
    const exposed = await call('https://flash.example.com/api/secrets', undefined, { ...e, MUSE_EXPOSE_SDK_TOKEN: '1' });
    expect(await exposed.json()).toEqual({ sdk_token: 'mgst_secret' });
  });

  it('mints via POST /device_token/mint with the web token as bearer', async () => {
    const upstream = vi.fn(async () =>
      new Response(JSON.stringify({ access_token: 'acc', refresh_token: 'ref' }), { status: 200 }),
    );
    vi.stubGlobal('fetch', upstream);
    const res = await post('/api/mint', { web_token: 's0:web', device_id: 'homelink-a1b2c3', sdk_token: 'mgst_x' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ access_token: 'acc', refresh_token: 'ref' });

    const [url, init] = upstream.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.muse.ai/device_token/mint');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer s0:web');
    expect((init.headers as Record<string, string>)['X-API-Version']).toBe('1.0.0');
    expect(JSON.parse(String(init.body))).toEqual({ device_id: 'homelink-a1b2c3', sdk_token: 'mgst_x' });
  });

  it('passes upstream errors through with their status', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ detail: 'bad token' }), { status: 401 })));
    const res = await post('/api/mint', { web_token: 'x', device_id: 'homelink-a1b2c3' });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ detail: 'bad token' });
  });

  it('rejects mint requests without a web token or device id', async () => {
    expect((await post('/api/mint', { device_id: 'homelink-a1b2c3' })).status).toBe(400);
    expect((await post('/api/mint', { web_token: 'x' })).status).toBe(400);
  });

  it('lists VMs via GET /fetch_vms', async () => {
    const upstream = vi.fn(async () => new Response(JSON.stringify({ vm_list: [{ vm_id: 'vm-1' }] })));
    vi.stubGlobal('fetch', upstream);
    const res = await post('/api/fetch_vms', { access_token: 'acc' });
    expect(await res.json()).toEqual({ vm_list: [{ vm_id: 'vm-1' }] });
    const [url, init] = upstream.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.muse.ai/fetch_vms');
    expect(init.method).toBe('GET');
  });

  it('returns 404 for unknown endpoints', async () => {
    expect((await call('https://flash.example.com/api/nope')).status).toBe(404);
  });
});
