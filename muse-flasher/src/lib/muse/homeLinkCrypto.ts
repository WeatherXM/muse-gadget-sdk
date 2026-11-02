// Home Link v5 pairing crypto and BLE framing, ported from
// esp32/tools/muse/muse_full_setup.html. Must match esp32/main/link_pairing.c,
// esp32/main/pairing_transcript.c and esp32/main/ble_server.c byte for byte:
// P-256 ECDH, HKDF-SHA256 (hand-rolled extract/expand, one block), and
// AES-256-GCM with direction-tagged nonces and AAD.

export const HOMELINK_PAIRING_VERSION = 5;
export const CHUNK_MAGIC = 0xfe;
// Safe within macOS's 185+ byte ATT MTU, and the device takes at most 16 chunks.
export const TX_CHUNK_PAYLOAD_MAX = 160;
export const TX_MAX_CHUNKS = 16;

export const DIRECTION_M2D = 0; // mobile -> device
export const DIRECTION_D2M = 1; // device -> mobile

const utf8Encode = (s: string): Uint8Array => new TextEncoder().encode(s);
const utf8Decode = (b: Uint8Array): string => new TextDecoder().decode(b);

// WebCrypto wants an ArrayBuffer-backed view; copy so subarrays of shared
// buffers don't leak extra bytes.
function buf(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

export function b64urlEncode(bytes: Uint8Array | ArrayBuffer): string {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let bin = '';
  for (let i = 0; i < arr.length; i++) bin += String.fromCharCode(arr[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function b64urlDecode(str: string): Uint8Array {
  let s = String(str).trim().replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function concatBytes(...arrays: Uint8Array[]): Uint8Array {
  const total = arrays.reduce((acc, a) => acc + a.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const a of arrays) {
    out.set(a, offset);
    offset += a.length;
  }
  return out;
}

export async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', buf(bytes)));
}

async function hmacSha256(keyBytes: Uint8Array, dataBytes: Uint8Array): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    'raw',
    buf(keyBytes),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, buf(dataBytes)));
}

async function hkdfExpand32(prk: Uint8Array, info: string): Promise<Uint8Array> {
  return hmacSha256(prk, concatBytes(utf8Encode(info), new Uint8Array([0x01])));
}

export interface TranscriptFields {
  version: number | string;
  device_id: string;
  node_id: string;
  mac: string;
  model: string;
  firmware_version: string;
  pairing_auth: string;
  pairing_auth_epoch: number | string;
  pairing_policy: string;
  mobile_pub: string;
  device_pub: string;
  mobile_nonce: string;
  device_nonce: string;
}

export function buildTranscriptV5(fields: TranscriptFields): string {
  return [
    'hatch-link-pairing-v5',
    `version=${fields.version}`,
    'initiator_role=mobile',
    'responder_role=link',
    `device_id=${fields.device_id}`,
    `node_id=${fields.node_id}`,
    `mac=${fields.mac}`,
    `model=${fields.model}`,
    `firmware_version=${fields.firmware_version}`,
    'selected_cipher_suite=p256-hkdf-sha256-aes-gcm-v1',
    `pairing_auth=${fields.pairing_auth}`,
    `pairing_auth_epoch=${fields.pairing_auth_epoch}`,
    `pairing_policy=${fields.pairing_policy}`,
    `confirm_timeout_seconds=${fields.pairing_policy === 'confirm_press' ? 60 : 0}`,
    `mobile_pub=${fields.mobile_pub}`,
    `device_pub=${fields.device_pub}`,
    `mobile_nonce=${fields.mobile_nonce}`,
    // No trailing newline: must match main/pairing_transcript.c byte for byte.
    `device_nonce=${fields.device_nonce}`,
  ].join('\n');
}

export function makeGcmNonce(direction: number, counter: bigint): Uint8Array {
  const iv = new Uint8Array(12);
  iv[0] = direction & 0xff;
  new DataView(iv.buffer).setBigUint64(4, counter, false); // big-endian at bytes 4..11
  return iv;
}

export function makeGcmAad(sessionIdB64: string, direction: number, counter: bigint): Uint8Array {
  const dirLabel = direction === DIRECTION_M2D ? 'm2d' : 'd2m';
  return utf8Encode(`hatch-link ble setup v1|${sessionIdB64}|${dirLabel}|${counter.toString()}`);
}

export interface HomeLinkSession {
  sessionIdB64: string;
  m2dKey: CryptoKey;
  d2mKey: CryptoKey;
  txCounter: bigint; // next m2d counter
  rxCounter: bigint; // next expected d2m counter
}

export interface DeriveSessionParams {
  /** Our ECDH private key (the mobile's, or the device's in tests). */
  privateKey: CryptoKey;
  /** The other side's raw uncompressed P-256 public key. */
  peerPubRaw: Uint8Array;
  mobileNonce: Uint8Array;
  deviceNonce: Uint8Array;
  transcriptHash: Uint8Array;
}

export async function deriveSessionKeys(params: DeriveSessionParams): Promise<HomeLinkSession> {
  const peerKey = await crypto.subtle.importKey(
    'raw',
    buf(params.peerPubRaw),
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    [],
  );
  const ecdhSecret = new Uint8Array(
    await crypto.subtle.deriveBits({ name: 'ECDH', public: peerKey }, params.privateKey, 256),
  );

  const salt = await sha256(concatBytes(params.mobileNonce, params.deviceNonce, params.transcriptHash));
  const prk = await hmacSha256(salt, ecdhSecret);
  const sessionSecret = await hkdfExpand32(prk, 'hatch-link ble setup v1');
  const m2dKeyBytes = await hkdfExpand32(sessionSecret, 'mobile->device');
  const d2mKeyBytes = await hkdfExpand32(sessionSecret, 'device->mobile');

  const sidHash = await sha256(
    concatBytes(utf8Encode('hatch-link session id v1'), params.transcriptHash, ecdhSecret),
  );

  const importAes = (raw: Uint8Array) =>
    crypto.subtle.importKey('raw', buf(raw), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);

  return {
    sessionIdB64: b64urlEncode(sidHash.slice(0, 16)),
    m2dKey: await importAes(m2dKeyBytes),
    d2mKey: await importAes(d2mKeyBytes),
    txCounter: 0n,
    rxCounter: 0n,
  };
}

export interface EncryptedEnvelope {
  action: 'pairing_encrypted';
  session_id: string;
  counter: string;
  ciphertext: string;
  tag: string;
}

export async function sealEnvelope(
  key: CryptoKey,
  sessionIdB64: string,
  direction: number,
  counter: bigint,
  plaintext: string,
): Promise<EncryptedEnvelope> {
  const sealed = new Uint8Array(
    await crypto.subtle.encrypt(
      {
        name: 'AES-GCM',
        iv: buf(makeGcmNonce(direction, counter)),
        additionalData: buf(makeGcmAad(sessionIdB64, direction, counter)),
        tagLength: 128,
      },
      key,
      buf(utf8Encode(plaintext)),
    ),
  );
  return {
    action: 'pairing_encrypted',
    session_id: sessionIdB64,
    counter: counter.toString(),
    ciphertext: b64urlEncode(sealed.slice(0, sealed.length - 16)),
    tag: b64urlEncode(sealed.slice(sealed.length - 16)),
  };
}

export async function openEnvelope(
  key: CryptoKey,
  sessionIdB64: string,
  direction: number,
  env: Pick<EncryptedEnvelope, 'counter' | 'ciphertext' | 'tag'>,
): Promise<string> {
  const counter = BigInt(env.counter);
  const plain = await crypto.subtle.decrypt(
    {
      name: 'AES-GCM',
      iv: buf(makeGcmNonce(direction, counter)),
      additionalData: buf(makeGcmAad(sessionIdB64, direction, counter)),
      tagLength: 128,
    },
    key,
    buf(concatBytes(b64urlDecode(env.ciphertext), b64urlDecode(env.tag))),
  );
  return utf8Decode(new Uint8Array(plain));
}

/** Encrypts a mobile->device message; returns the JSON envelope to send. */
export async function encryptM2D(
  session: HomeLinkSession,
  payload: string | Record<string, unknown>,
): Promise<string> {
  const plaintext = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const counter = session.txCounter;
  const env = await sealEnvelope(session.m2dKey, session.sessionIdB64, DIRECTION_M2D, counter, plaintext);
  session.txCounter += 1n;
  return JSON.stringify(env);
}

/** Decrypts a device->mobile envelope, enforcing session id and counter order. */
export async function decryptD2M(
  session: HomeLinkSession,
  env: Record<string, unknown> | EncryptedEnvelope,
): Promise<string> {
  if (env.session_id !== session.sessionIdB64) {
    throw new Error(`Session ID mismatch: got ${String(env.session_id)}`);
  }
  const counter = BigInt(String(env.counter));
  if (counter !== session.rxCounter) {
    throw new Error(`Unexpected d2m counter: got ${counter}, expected ${session.rxCounter}`);
  }
  const text = await openEnvelope(session.d2mKey, session.sessionIdB64, DIRECTION_D2M, {
    counter: String(env.counter),
    ciphertext: String(env.ciphertext),
    tag: String(env.tag),
  });
  session.rxCounter += 1n;
  return text;
}

/** Splits a JSON message into 0xFE-framed chunks: [magic, index, total, ...payload]. */
export function frameHomeLinkPayload(json: string): Uint8Array<ArrayBuffer>[] {
  const bytes = utf8Encode(json);
  const total = Math.max(1, Math.ceil(bytes.length / TX_CHUNK_PAYLOAD_MAX));
  if (total > TX_MAX_CHUNKS) {
    throw new Error(`Payload too large (${bytes.length} bytes > ${TX_MAX_CHUNKS} chunks)`);
  }
  const frames: Uint8Array<ArrayBuffer>[] = [];
  for (let idx = 0; idx < total; idx++) {
    const slice = bytes.slice(idx * TX_CHUNK_PAYLOAD_MAX, (idx + 1) * TX_CHUNK_PAYLOAD_MAX);
    const frame = new Uint8Array(3 + slice.length);
    frame[0] = CHUNK_MAGIC;
    frame[1] = idx;
    frame[2] = total;
    frame.set(slice, 3);
    frames.push(frame);
  }
  return frames;
}

/** Reassembles Home Link TX notifications; returns the full text once complete. */
export class HomeLinkChunkAssembler {
  private chunks: Uint8Array[] = [];

  push(bytes: Uint8Array): string | null {
    if (bytes.length >= 3 && bytes[0] === CHUNK_MAGIC) {
      const idx = bytes[1];
      const total = bytes[2];
      if (idx === 0) this.chunks = [];
      this.chunks.push(bytes.slice(3));
      if (idx + 1 < total) return null;
      const full = concatBytes(...this.chunks);
      this.chunks = [];
      return utf8Decode(full);
    }
    // Unframed: a plain status string from ble_server_send_status().
    return utf8Decode(bytes);
  }
}

/** Generates both sides of a pairing in-browser and checks an envelope round trip. */
export async function runCryptoSelfTest(): Promise<void> {
  const gen = () =>
    crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, [
      'deriveBits',
    ]) as Promise<CryptoKeyPair>;
  const mobile = await gen();
  const device = await gen();
  const mobilePub = new Uint8Array(await crypto.subtle.exportKey('raw', mobile.publicKey));
  const devicePub = new Uint8Array(await crypto.subtle.exportKey('raw', device.publicKey));
  const mobileNonce = crypto.getRandomValues(new Uint8Array(16));
  const deviceNonce = crypto.getRandomValues(new Uint8Array(16));

  const transcriptHash = await sha256(
    utf8Encode(
      buildTranscriptV5({
        version: HOMELINK_PAIRING_VERSION,
        device_id: 'hatch-link:aa:bb:cc:dd:ee:ff',
        node_id: 'homelink-ddeeff',
        mac: 'aa:bb:cc:dd:ee:ff',
        model: 'hatch_link',
        firmware_version: '1.0.0',
        pairing_auth: 'none',
        pairing_auth_epoch: 0,
        pairing_policy: 'confirm_press',
        mobile_pub: b64urlEncode(mobilePub),
        device_pub: b64urlEncode(devicePub),
        mobile_nonce: b64urlEncode(mobileNonce),
        device_nonce: b64urlEncode(deviceNonce),
      }),
    ),
  );

  const mobileSession = await deriveSessionKeys({
    privateKey: mobile.privateKey,
    peerPubRaw: devicePub,
    mobileNonce,
    deviceNonce,
    transcriptHash,
  });
  const deviceSession = await deriveSessionKeys({
    privateKey: device.privateKey,
    peerPubRaw: mobilePub,
    mobileNonce,
    deviceNonce,
    transcriptHash,
  });
  if (mobileSession.sessionIdB64 !== deviceSession.sessionIdB64) {
    throw new Error('Session IDs differ');
  }

  const env = JSON.parse(await encryptM2D(mobileSession, '{"action":"pairing_client_finished"}'));
  const opened = await openEnvelope(deviceSession.m2dKey, deviceSession.sessionIdB64, DIRECTION_M2D, env);
  if (opened !== '{"action":"pairing_client_finished"}' || mobileSession.txCounter !== 1n) {
    throw new Error('Envelope round trip failed');
  }
}
