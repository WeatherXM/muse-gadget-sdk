// Web Bluetooth provisioner for Muse Gadget, ported from
// esp32/tools/muse/muse_full_setup.html. Two GATT services:
//   Home Link (esp32/main/ble_server.c): 0xFE-framed JSON, v5 pairing, then
//     AES-GCM `provision_v2` with Wi-Fi and the device token pair.
//   Companion (esp32/components/muse/muse_ble.c): "key=value" commands and a
//     JSON status snapshot.

import {
  HOMELINK_PAIRING_VERSION,
  HomeLinkChunkAssembler,
  b64urlDecode,
  b64urlEncode,
  buildTranscriptV5,
  decryptD2M,
  deriveSessionKeys,
  encryptM2D,
  frameHomeLinkPayload,
  sha256,
  type HomeLinkSession,
} from './homeLinkCrypto';
import { MUSE_SDK_TOKEN_REGEX } from './sdkToken';

export const HOMELINK_SVC_UUID = '7fdd3d1c-38ea-46cf-8b46-314ecf5f240c';
export const HOMELINK_RX_UUID = '4d593029-28a2-4a6e-a1f0-3c2d5e8f9b01'; // Write
export const HOMELINK_TX_UUID = 'd75dc4ca-7b2b-4e9c-8f0a-1d2e3f4a5b6c'; // Read / Notify

export const MUSE_BLE_SVC_UUID = '4d757365-0001-4000-8000-6a6f6c6c7900';
export const MUSE_BLE_CMD_UUID = '4d757365-0002-4000-8000-6a6f6c6c7900'; // Write
export const MUSE_BLE_RSP_UUID = '4d757365-0003-4000-8000-6a6f6c6c7900'; // Read / Notify

export type BleLogLevel = 'info' | 'ok' | 'warn' | 'error' | 'ble';
export type StepState = '' | 'active' | 'done' | 'error';
export type ServiceState = 'idle' | 'connected' | 'unavailable' | 'disconnected';

export interface BleStatus {
  connected: boolean;
  bleName: string;
  homeLink: ServiceState;
  companion: ServiceState;
  nodeId: string;
  fullDeviceId: string;
  fwAuth: string;
  wifiState: string;
  linkState: string;
  hatchState: string;
  lastReply: string;
}

export const PROVISION_STEPS = [
  'ECDH Hello',
  'Key Derive',
  'Device Confirm',
  'Mint Token',
  'Companion Setup',
  'provision_v2',
  'Wi-Fi & Auth OK',
] as const;

export interface BleCallbacks {
  onLog(level: BleLogLevel, message: string): void;
  onStatus(status: BleStatus): void;
  onStep(step: number, state: StepState): void;
  onConfirmBanner(active: boolean): void;
  /** A node id read from the BLE name, device_info or pairing_ready. */
  onNodeId(nodeId: string, source: string): void;
  /** The SDK token the device reported inside the encrypted session. */
  onDeviceSdkToken(token: string): void;
}

export interface CompanionInputs {
  ssid: string;
  password: string;
  /** Normalized bare hostname; empty resets the device to its default VM server. */
  host: string;
  vmId: string;
  token: string;
  /** Clear any standalone Companion token so Muse delegates to Home Link's auto-refreshed credentials. */
  clearToken?: boolean;
}

export interface HomeLinkInputs {
  ssid: string;
  password: string;
  host: string;
  vmId: string;
  accessToken: string;
  refreshToken: string;
  /** Mints a fresh pair when the form has none. */
  mint(): Promise<{ accessToken: string; refreshToken: string }>;
}

type HlMessage = Record<string, unknown> & { type?: string; status?: string };

interface Waiter {
  predicate(msg: HlMessage): boolean;
  resolve(msg: HlMessage): void;
  timer: ReturnType<typeof setTimeout>;
}

const INITIAL_STATUS: BleStatus = {
  connected: false,
  bleName: '',
  homeLink: 'idle',
  companion: 'idle',
  nodeId: '',
  fullDeviceId: '',
  fwAuth: '',
  wifiState: '',
  linkState: '',
  hatchState: '',
  lastReply: '',
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const utf8Encode = (s: string) => new TextEncoder().encode(s);
const dvText = (v: DataView) =>
  new TextDecoder().decode(new Uint8Array(v.buffer, v.byteOffset, v.byteLength));
const isError = (m: HlMessage) => m.type === 'plain_status' && String(m.status).startsWith('error_');

// Statuses from a Muse VM session left over from an earlier setup
// (esp32/main/app.c on_ws_control_status). They aren't about this pairing.
const BACKGROUND_VM_STATUSES = new Set([
  'ws_auth_failed',
  'ws_refresh_needed',
  'ws_disconnected',
  'ws_unpaired',
  'auth_failed',
]);

/** "MuseGadget-A1B2C3" -> "homelink-a1b2c3" (the node id the device mints with). */
export function nodeIdFromBleName(name: string): string | null {
  const match = name.match(/^(?:MuseGadget|HomeLink|Muse)-([0-9A-Fa-f]{6})$/);
  return match ? `homelink-${match[1].toLowerCase()}` : null;
}

/** "homelink-a1b2c3" -> "MuseGadget-A1B2C3" (the name the firmware advertises). */
export function museNameForNodeId(nodeId: string): string | null {
  const match = nodeId.match(/^homelink-([0-9a-f]{6})$/i);
  return match ? `MuseGadget-${match[1].toUpperCase()}` : null;
}

/** Hides Wi-Fi passwords and tokens in logged Companion commands. */
export function redactCompanionCommand(cmd: string): string {
  return cmd
    .replace(/^((?:wifi\.pass|hatch\.token\+?)=).*$/, '$1***')
    .replace(/^(card\.prompt\+?=)(.*)$/, (_, key: string, v: string) => `${key}(${v.length} chars)`);
}

export class MuseBleProvisionerClient {
  private device: BluetoothDevice | null = null;
  private hlRx: BluetoothRemoteGATTCharacteristic | null = null;
  private hlTx: BluetoothRemoteGATTCharacteristic | null = null;
  private museCmd: BluetoothRemoteGATTCharacteristic | null = null;
  private museRsp: BluetoothRemoteGATTCharacteristic | null = null;

  private assembler = new HomeLinkChunkAssembler();
  private waiters: Waiter[] = [];
  private lastDeviceInfo: HlMessage | null = null;
  private session: HomeLinkSession | null = null;
  private companionReadInFlight = false;
  private status: BleStatus = { ...INITIAL_STATUS };
  /** Set while step 3 waits for the on-device press. */
  private awaitingConfirm = false;
  private warnedBackgroundStatus = false;

  constructor(private cb: BleCallbacks) {}

  get hasHomeLink(): boolean {
    return Boolean(this.hlRx);
  }

  get hasCompanion(): boolean {
    return Boolean(this.museCmd);
  }

  private setStatus(patch: Partial<BleStatus>): void {
    this.status = { ...this.status, ...patch };
    this.cb.onStatus(this.status);
  }

  // ---------------------------------------------------------------------------
  // Connect / disconnect
  // ---------------------------------------------------------------------------

  async connect({ acceptAll = false } = {}): Promise<void> {
    if (!navigator.bluetooth) {
      throw new Error('Web Bluetooth is not available. Use Chrome or Edge on desktop.');
    }
    const optionalServices = [HOMELINK_SVC_UUID, MUSE_BLE_SVC_UUID];
    const options: RequestDeviceOptions = acceptAll
      ? { acceptAllDevices: true, optionalServices }
      : {
          filters: [
            { namePrefix: 'MuseGadget-' },
            { namePrefix: 'HomeLink-' },
            { namePrefix: 'Muse-' },
            { services: [HOMELINK_SVC_UUID] },
            { services: [MUSE_BLE_SVC_UUID] },
          ],
          optionalServices,
        };

    this.cb.onLog('info', 'Requesting Muse Bluetooth device...');
    const device = await navigator.bluetooth.requestDevice(options);
    this.device = device;
    device.addEventListener('gattserverdisconnected', () => this.onDisconnected());

    const name = device.name || 'Unknown ESP32';
    this.setStatus({ bleName: name });
    this.cb.onLog('ok', `Selected BLE device: ${name}`);
    const derived = nodeIdFromBleName(name);
    if (derived) {
      this.setNodeId(derived, 'BLE name');
    }

    const server = await device.gatt!.connect();
    this.setStatus({ connected: true });

    try {
      const svc = await server.getPrimaryService(HOMELINK_SVC_UUID);
      this.hlRx = await svc.getCharacteristic(HOMELINK_RX_UUID);
      this.hlTx = await svc.getCharacteristic(HOMELINK_TX_UUID);
      await this.hlTx.startNotifications();
      this.hlTx.addEventListener('characteristicvaluechanged', (ev) => {
        const value = (ev.target as BluetoothRemoteGATTCharacteristic).value;
        if (!value) return;
        const text = this.assembler.push(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
        if (text !== null) void this.handleHomeLinkText(text);
      });
      this.setStatus({ homeLink: 'connected' });
      this.cb.onLog('ok', 'Connected to Home Link GATT service (7fdd3d1c...)');
    } catch (err) {
      this.hlRx = null;
      this.hlTx = null;
      this.setStatus({ homeLink: 'unavailable' });
      this.cb.onLog('warn', `Home Link GATT service not found: ${(err as Error).message}`);
    }

    try {
      const svc = await server.getPrimaryService(MUSE_BLE_SVC_UUID);
      this.museCmd = await svc.getCharacteristic(MUSE_BLE_CMD_UUID);
      this.museRsp = await svc.getCharacteristic(MUSE_BLE_RSP_UUID);
      await this.museRsp.startNotifications();
      this.museRsp.addEventListener('characteristicvaluechanged', (ev) => {
        // readValue() also fires this event, so status reads land here too.
        // Only the device's notifications (the "cmd: result" line) are logged;
        // re-reading from here would loop and starve the GATT queue.
        if (this.companionReadInFlight) return;
        const value = (ev.target as BluetoothRemoteGATTCharacteristic).value;
        if (!value) return;
        const msg = dvText(value);
        this.setStatus({ lastReply: msg });
        this.cb.onLog(msg.includes('error') ? 'error' : 'ok', `[Companion RSP] ${msg}`);
      });
      this.setStatus({ companion: 'connected' });
      this.cb.onLog('ok', 'Connected to Muse Companion GATT service (4d757365...)');
    } catch (err) {
      this.museCmd = null;
      this.museRsp = null;
      this.setStatus({ companion: 'unavailable' });
      this.cb.onLog('warn', `Muse Companion GATT service not found: ${(err as Error).message}`);
    }

    await this.refresh();
  }

  disconnect(): void {
    if (this.device?.gatt?.connected) {
      this.device.gatt.disconnect();
    }
  }

  private onDisconnected(): void {
    this.cb.onLog('warn', 'BLE device disconnected (expected after provision_v2 auth_ok reboot).');
    this.hlRx = null;
    this.hlTx = null;
    this.museCmd = null;
    this.museRsp = null;
    this.session = null;
    this.cb.onConfirmBanner(false);
    this.setStatus({
      connected: false,
      homeLink: 'disconnected',
      companion: 'disconnected',
    });
  }

  async refresh(): Promise<void> {
    if (this.hlRx) {
      this.cb.onLog('info', 'Requesting Home Link get_device_info...');
      await this.sendHomeLinkJson({ action: 'get_device_info' });
    }
    if (this.museRsp) {
      await this.readCompanionStatus();
    }
  }

  private setNodeId(nodeId: string, source: string): void {
    // macOS caches a device's name per Bluetooth address, so a gateway that ran
    // other firmware before (e.g. MeshCore) can still be listed under that name.
    const advertised = museNameForNodeId(nodeId);
    const shown = this.device?.name ?? '';
    if (advertised && shown && shown !== advertised && !this.status.bleName.includes(advertised)) {
      this.cb.onLog(
        'info',
        `Chrome lists this gateway as "${shown}", a name macOS cached from earlier firmware. It is ${advertised} (${nodeId}).`,
      );
      this.setStatus({ bleName: `${advertised} (listed as "${shown}")` });
    }
    this.setStatus({ nodeId });
    this.cb.onNodeId(nodeId, source);
  }

  // ---------------------------------------------------------------------------
  // Home Link transport
  // ---------------------------------------------------------------------------

  private notifyWaiters(msg: HlMessage): void {
    const st = String(msg.status ?? '');
    if (BACKGROUND_VM_STATUSES.has(st)) {
      if (this.awaitingConfirm && !this.warnedBackgroundStatus) {
        this.warnedBackgroundStatus = true;
        this.cb.onLog(
          'warn',
          `The gateway's old Muse VM session reported ${st} (credentials from an earlier setup). This pairing replaces them, but on older firmware it can hide the Confirm prompt on screen: press the top button briefly to confirm.`,
        );
      } else if (!this.awaitingConfirm) {
        this.cb.onLog('info', `Gateway's existing Muse VM session: ${st} (not part of this pairing).`);
      }
    }
    for (const w of this.waiters.slice()) {
      if (w.predicate(msg)) {
        this.waiters = this.waiters.filter((item) => item !== w);
        clearTimeout(w.timer);
        w.resolve(msg);
      }
    }
  }

  private waitFor(predicate: (m: HlMessage) => boolean, timeoutMs: number, label: string): Promise<HlMessage> {
    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
        predicate,
        resolve,
        timer: setTimeout(() => {
          this.waiters = this.waiters.filter((item) => item !== waiter);
          reject(new Error(`Timed out waiting for ${label} (${timeoutMs} ms)`));
        }, timeoutMs),
      };
      this.waiters.push(waiter);
    });
  }

  private async handleHomeLinkText(text: string): Promise<void> {
    let parsed: HlMessage;
    try {
      parsed = JSON.parse(text) as HlMessage;
    } catch {
      // Plain status string sent by ble_server_send_status().
      this.cb.onLog(text.startsWith('error') ? 'error' : 'ble', `[HomeLink TX] Status: ${text}`);
      this.setStatus({ lastReply: text });
      this.notifyWaiters({ type: 'plain_status', status: text });
      return;
    }

    if (parsed.type === 'device_info') {
      this.lastDeviceInfo = parsed;
      this.cb.onLog(
        'ble',
        `[HomeLink TX] device_info: node_id=${parsed.node_id}, device_id=${parsed.device_id}, auth=${parsed.pairing_auth}, fw=${parsed.version}`,
      );
      this.setStatus({
        fullDeviceId: String(parsed.device_id ?? ''),
        fwAuth: `v${parsed.version ?? '?'} / auth=${parsed.pairing_auth ?? 'none'} (epoch ${parsed.pairing_auth_epoch ?? 0})`,
      });
      if (typeof parsed.node_id === 'string' && parsed.node_id) {
        this.setNodeId(parsed.node_id, 'device_info');
      }
      this.notifyWaiters(parsed);
      return;
    }

    if (parsed.type === 'pairing_ready') {
      this.cb.onLog('ble', `[HomeLink TX] pairing_ready: session_id=${parsed.session_id}, node_id=${parsed.node_id}`);
      if (typeof parsed.node_id === 'string' && parsed.node_id) {
        this.setNodeId(parsed.node_id, 'pairing_ready');
      }
      this.notifyWaiters(parsed);
      return;
    }

    if (parsed.type === 'pairing_encrypted' && this.session) {
      try {
        const decrypted = await decryptD2M(this.session, parsed);
        this.cb.onLog('ok', `[HomeLink TX decrypted #${(this.session.rxCounter - 1n).toString()}] ${decrypted}`);
        const inner = JSON.parse(decrypted) as HlMessage;
        if (inner.status) {
          this.setStatus({ lastReply: `encrypted: ${inner.status}` });
        }
        if (typeof inner.sdk_token === 'string' && MUSE_SDK_TOKEN_REGEX.test(inner.sdk_token)) {
          this.cb.onLog('ok', `[HomeLink] Device reported SDK token ${inner.sdk_token.slice(0, 12)}...`);
          this.cb.onDeviceSdkToken(inner.sdk_token);
        }
        this.notifyWaiters(inner);
      } catch (err) {
        this.cb.onLog('error', `[HomeLink decrypt error] ${(err as Error).message}`);
      }
      return;
    }

    this.cb.onLog('ble', `[HomeLink TX] ${text}`);
    this.notifyWaiters(parsed);
  }

  private async sendHomeLinkJson(payload: string | Record<string, unknown>): Promise<void> {
    if (!this.hlRx) throw new Error('Home Link RX characteristic not connected');
    const frames = frameHomeLinkPayload(typeof payload === 'string' ? payload : JSON.stringify(payload));
    for (let i = 0; i < frames.length; i++) {
      await this.hlRx.writeValueWithResponse(frames[i]);
      if (i + 1 < frames.length) await sleep(20);
    }
  }

  // ---------------------------------------------------------------------------
  // Companion (muse_ble)
  // ---------------------------------------------------------------------------

  private applyCompanionStatus(st: Record<string, any>): void {
    const patch: Partial<BleStatus> = {};
    if (st.wifi) {
      const w = st.wifi;
      patch.wifiState = `${w.state || '?'}${w.ssid ? ` (${w.ssid})` : ''}${w.ip ? ` [${w.ip}]` : ''}`;
    }
    if (st.link) {
      patch.linkState = `linked=${st.link.linked} (${st.link.state || '?'})`;
    }
    if (st.hatch) {
      const h = st.hatch;
      patch.hatchState = `${h.state || '?'} (vm=${h.vm ? `${String(h.vm).slice(0, 8)}…` : 'none'}, token=${h.token_set ? 'yes' : 'no'})`;
    }
    if (st.last) patch.lastReply = String(st.last);
    this.setStatus(patch);
  }

  async readCompanionStatus(): Promise<Record<string, unknown> | null> {
    if (!this.museRsp || this.companionReadInFlight) return null;
    this.companionReadInFlight = true;
    try {
      const parsed = JSON.parse(dvText(await this.museRsp.readValue()));
      this.applyCompanionStatus(parsed);
      return parsed;
    } catch (err) {
      this.cb.onLog('warn', `[Companion read error] ${(err as Error).message}`);
      return null;
    } finally {
      this.companionReadInFlight = false;
    }
  }

  async sendCompanionCmd(cmd: string): Promise<void> {
    if (!this.museCmd) throw new Error('Companion (muse_ble) service is not connected');
    this.cb.onLog('ble', `[Companion CMD] ${redactCompanionCommand(cmd)}`);
    await this.museCmd.writeValueWithResponse(utf8Encode(cmd));
    await sleep(60);
  }

  private async sendCompanionToken(token: string): Promise<void> {
    const CHUNK = 400;
    for (let off = 0; off < token.length; off += CHUNK) {
      const prefix = off === 0 ? 'hatch.token=' : 'hatch.token+=';
      await this.sendCompanionCmd(prefix + token.slice(off, off + CHUNK));
    }
  }

  async runCompanionProvision(inputs: CompanionInputs, { includeWifi = false } = {}): Promise<void> {
    if (!this.museCmd) {
      this.cb.onLog('warn', 'Companion service (muse_ble) not available; skipping Companion commands.');
      return;
    }
    if (includeWifi && inputs.ssid) {
      await this.sendCompanionCmd(`wifi.ssid=${inputs.ssid}`);
      await this.sendCompanionCmd(`wifi.pass=${inputs.password}`);
      await this.sendCompanionCmd('wifi.connect');
    }
    // An empty value resets the device to its default VM server.
    await this.sendCompanionCmd(`hatch.host=${inputs.host}`);
    if (inputs.vmId) {
      await this.sendCompanionCmd(`hatch.vm=${inputs.vmId}`);
    }
    if (inputs.clearToken) {
      await this.sendCompanionCmd('hatch.token=');
    } else if (inputs.token) {
      await this.sendCompanionToken(inputs.token);
    }
    await this.readCompanionStatus();
    this.cb.onLog('ok', 'Companion (muse_ble) settings written to NVS.');
  }

  /** Stores the swipe-down card prompt (empty: the built-in default) over Companion. */
  async writeCardPrompt(commands: string[]): Promise<void> {
    for (const cmd of commands) {
      await this.sendCompanionCmd(cmd);
    }
  }

  async hatchTest(): Promise<void> {
    await this.sendCompanionCmd('hatch.test');
  }

  async unpair(): Promise<void> {
    await this.sendHomeLinkJson({ action: 'unpair' });
    this.cb.onLog('warn', 'Sent unpair command to Home Link.');
  }

  // ---------------------------------------------------------------------------
  // Home Link v5 pairing + provision_v2
  // ---------------------------------------------------------------------------

  async runHomeLinkProvision(inputs: HomeLinkInputs, { configureCompanionToo = true } = {}): Promise<void> {
    if (!this.hlRx) {
      throw new Error('Connect to the Home Link BLE service first.');
    }
    if (!inputs.ssid || !inputs.password) {
      throw new Error('Both Wi-Fi SSID and Wi-Fi password are required for provision_v2.');
    }

    for (let i = 1; i <= PROVISION_STEPS.length; i++) this.cb.onStep(i, '');
    this.cb.onConfirmBanner(false);
    let step = 1;
    const fail = (err: Error): never => {
      this.cb.onStep(step, 'error');
      throw err;
    };

    try {
      // Step 1: pairing_client_hello with an ephemeral P-256 key.
      this.cb.onStep(1, 'active');
      this.cb.onLog('info', 'Step 1/7: Generating ephemeral P-256 keypair and sending pairing_client_hello...');
      const keyPair = (await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, [
        'deriveBits',
      ])) as CryptoKeyPair;
      const mobilePubB64 = b64urlEncode(await crypto.subtle.exportKey('raw', keyPair.publicKey));
      const mobileNonce = crypto.getRandomValues(new Uint8Array(16));
      const mobileNonceB64 = b64urlEncode(mobileNonce);

      const readyPromise = this.waitFor(
        (m) => m.type === 'pairing_ready' || isError(m),
        12000,
        'pairing_ready',
      );
      await this.sendHomeLinkJson({
        action: 'pairing_client_hello',
        version: HOMELINK_PAIRING_VERSION,
        pairing_auth: this.lastDeviceInfo?.pairing_auth ?? 'none',
        pairing_policy: this.lastDeviceInfo?.pairing_policy ?? 'confirm_press',
        mobile_pub: mobilePubB64,
        mobile_nonce: mobileNonceB64,
      });
      const ready = await readyPromise;
      if (ready.type === 'plain_status') {
        if (ready.status === 'error_pairing_unavailable') {
          fail(
            new Error(
              'Device rejected pairing_client_hello: error_pairing_unavailable. It is already set up and refuses new ' +
                'pairings; use Unpair / Reset Home Link (or hold the top button 5 s, then release) to provision it again.',
            ),
          );
        }
        fail(new Error(`Device rejected pairing_client_hello: ${ready.status}`));
      }
      this.cb.onStep(1, 'done');

      // Step 2: verify the transcript, derive keys, send pairing_client_finished.
      step = 2;
      this.cb.onStep(2, 'active');
      this.cb.onLog('info', 'Step 2/7: Verifying pairing transcript v5 and deriving AES-256-GCM keys...');
      const transcript = buildTranscriptV5({
        version: ready.version as number,
        device_id: String(ready.device_id),
        node_id: String(ready.node_id),
        mac: String(ready.mac),
        model: String(ready.model),
        firmware_version: String(ready.firmware_version),
        pairing_auth: String(ready.pairing_auth),
        pairing_auth_epoch: ready.pairing_auth_epoch as number,
        pairing_policy: String(ready.pairing_policy),
        mobile_pub: mobilePubB64,
        device_pub: String(ready.device_pub),
        mobile_nonce: mobileNonceB64,
        device_nonce: String(ready.device_nonce),
      });
      const transcriptHash = await sha256(new TextEncoder().encode(transcript));
      const transcriptHashB64 = b64urlEncode(transcriptHash);
      if (transcriptHashB64 !== ready.transcript_hash) {
        fail(new Error(`Transcript hash mismatch: computed ${transcriptHashB64}, device sent ${ready.transcript_hash}`));
      }
      this.cb.onLog('ok', `Transcript hash verified: ${transcriptHashB64}`);

      this.session = await deriveSessionKeys({
        privateKey: keyPair.privateKey,
        peerPubRaw: b64urlDecode(String(ready.device_pub)),
        mobileNonce,
        deviceNonce: b64urlDecode(String(ready.device_nonce)),
        transcriptHash,
      });
      if (this.session.sessionIdB64 !== ready.session_id) {
        fail(new Error(`Session ID mismatch: computed ${this.session.sessionIdB64}, device sent ${ready.session_id}`));
      }
      this.cb.onLog('ok', `Session ID verified: ${this.session.sessionIdB64}`);

      const confirmPromise = this.waitFor(
        (m) => (m.type === 'status' && (m.status === 'confirm_required' || m.status === 'pairing_confirmed')) || isError(m),
        12000,
        'confirm_required / pairing_confirmed',
      );
      // Must be exactly this string (link_pairing.c compares it).
      await this.sendHomeLinkJson(await encryptM2D(this.session, '{"action":"pairing_client_finished"}'));
      this.cb.onStep(2, 'done');

      // Step 3: physical / touch confirmation on the device.
      step = 3;
      this.cb.onStep(3, 'active');
      const first = await confirmPromise;
      if (first.type === 'plain_status') {
        fail(new Error(`Device error after pairing_client_finished: ${first.status}`));
      }
      if (first.status === 'confirm_required') {
        this.cb.onConfirmBanner(true);
        this.cb.onLog('warn', 'Step 3/7: Waiting for confirmation on the WG1200 screen or a short top-button press (up to 60 s)...');
        this.awaitingConfirm = true;
        this.warnedBackgroundStatus = false;
        const confirmed = await this.waitFor(
          (m) => (m.type === 'status' && m.status === 'pairing_confirmed') || isError(m),
          65000,
          'pairing_confirmed',
        ).finally(() => {
          this.awaitingConfirm = false;
          this.cb.onConfirmBanner(false);
        });
        if (confirmed.type === 'plain_status') {
          fail(new Error(`Confirmation failed or timed out: ${confirmed.status}`));
        }
      }
      this.cb.onStep(3, 'done');
      this.cb.onLog('ok', 'Step 3/7: Pairing confirmed on the device.');

      // Step 4: the 365-day device token pair.
      step = 4;
      this.cb.onStep(4, 'active');
      let { accessToken, refreshToken } = inputs;
      if (!accessToken || !refreshToken) {
        this.cb.onLog('info', 'Step 4/7: Minting a 365-day device token pair...');
        ({ accessToken, refreshToken } = await inputs.mint());
      } else {
        this.cb.onLog('ok', 'Step 4/7: Using the existing 365-day device access_token and refresh_token.');
      }
      this.cb.onStep(4, 'done');

      // Step 5: Companion before provision_v2, which restarts the device ~2 s after auth_ok.
      // Clear any standalone Companion hatch.token so muse_chat_session always uses Home Link's
      // auto-refreshing 365-day token pair instead of a static snapshot that goes stale.
      step = 5;
      this.cb.onStep(5, 'active');
      if (configureCompanionToo && this.museCmd) {
        this.cb.onLog(
          'info',
          'Step 5/7: Writing VM ID & host to Companion (clearing standalone token so Home Link manages auth)...',
        );
        await this.runCompanionProvision({
          ssid: inputs.ssid,
          password: inputs.password,
          host: inputs.host,
          vmId: inputs.vmId,
          token: '',
          clearToken: true,
        });
      } else {
        this.cb.onLog('info', 'Step 5/7: Skipping Companion (muse_ble).');
      }
      this.cb.onStep(5, 'done');

      // Step 6: encrypted provision_v2.
      step = 6;
      this.cb.onStep(6, 'active');
      this.cb.onLog('info', 'Step 6/7: Encrypting and sending provision_v2 over Home Link...');
      await this.sendHomeLinkJson(
        await encryptM2D(this.session, {
          action: 'provision_v2',
          ssid: inputs.ssid,
          password: inputs.password,
          access_token: accessToken,
          refresh_token: refreshToken,
          token_type: 'device',
        }),
      );
      this.cb.onStep(6, 'done');

      // Step 7: wifi_connecting -> wifi_connected -> auth_ok.
      step = 7;
      this.cb.onStep(7, 'active');
      this.cb.onLog('info', 'Step 7/7: Waiting for Wi-Fi and VM authentication (auth_ok)...');
      const deadline = Date.now() + 45000;
      while (Date.now() < deadline) {
        const msg = await this.waitFor((m) => m.type === 'status' || m.type === 'plain_status', 35000, 'provisioning status');
        const st = String(msg.status ?? '');
        if (st === 'wifi_connecting') {
          this.cb.onLog('info', 'Device: wifi_connecting (joining 2.4 GHz Wi-Fi)...');
        } else if (st === 'wifi_connected') {
          this.cb.onLog('ok', 'Device: wifi_connected');
        } else if (st === 'auth_ok') {
          this.cb.onStep(7, 'done');
          this.cb.onLog('ok', "Device reported auth_ok: Home Link + Companion are provisioned.");
          this.cb.onLog('ok', 'It restarts in ~2 s and registers with your Muse VM (link.register).');
          return;
        } else if (st.startsWith('error_')) {
          fail(new Error(`Device reported a provisioning error: ${st}`));
        }
      }
      fail(new Error('Timed out waiting for auth_ok'));
    } catch (err) {
      this.cb.onConfirmBanner(false);
      this.cb.onStep(step, 'error');
      throw err;
    }
  }
}
