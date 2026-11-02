// Wires the Step 2/3 provisioner UI (MuseBleProvisioner.astro) to the BLE
// client, the Worker's /api proxy and the USB serial console, mirroring
// esp32/tools/muse/muse_full_setup.html.

import {
  MuseBleProvisionerClient,
  PROVISION_STEPS,
  type BleLogLevel,
  type BleStatus,
  type ServiceState,
} from './muse/bleClient';
import {
  CARD_PROMPT_MAX,
  DEFAULT_CARD_PROMPT,
  cardPromptCommands,
  checkCardPrompt,
  normalizeCardPrompt,
  readCardPromptOverUsb,
  writeCardPromptOverUsb,
} from './muse/cardPrompt';
import { runCryptoSelfTest } from './muse/homeLinkCrypto';
import {
  checkProxyHealth,
  fetchSdkTokenDefault,
  fetchVms,
  mintDeviceTokens,
  normalizeMuseHost,
} from './muse/museCloudClient';
import {
  MUSE_SDK_TOKEN_REGEX,
  injectSdkTokenOverUsbSerial,
  sendSwitchToWeatherXmOverUsbSerial,
} from './muse/sdkToken';
import {
  SETUP_FIELDS,
  forgetSetup,
  getMintedForNodeId,
  loadSavedWifiPassword,
  loadSetupField,
  saveSetupField,
  saveWifiPassword,
  setMintedForNodeId,
  type SetupField,
} from './muse/setupStorage';

export interface ProvisionerHost {
  log(level: BleLogLevel, message: string): void;
  getSdkToken(): string;
  setSdkToken(token: string): void;
  /** Port picker options for USB serial commands (WG1200 filters or none). */
  serialRequestOptions(): SerialPortRequestOptions | undefined;
}

export interface ProvisionerApi {
  /** Node id derived from the USB MAC, used when BLE hasn't named one. */
  setNodeIdFromUsb(nodeId: string): void;
}

function el<T extends HTMLElement = HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}

type BadgeKind = 'ok' | 'warn' | 'err' | '';

const BADGE_BASE = 'rounded-pill border px-2.5 py-1 font-mono text-[11px]';
const BADGE_KIND: Record<BadgeKind, string> = {
  ok: 'border-state-success-border bg-state-success-bg text-state-success',
  warn: 'border-state-warning-border bg-state-warning-bg text-state-warning',
  err: 'border-state-danger-border bg-state-danger-bg text-state-danger',
  '': 'border-line bg-canvas-subtle text-ink-muted',
};

function setBadge(node: HTMLElement | null, text: string, kind: BadgeKind = ''): void {
  if (!node) return;
  node.textContent = text;
  node.className = `${BADGE_BASE} ${BADGE_KIND[kind]}`;
}

const SERVICE_TEXT: Record<ServiceState, (uuid: string) => string> = {
  idle: () => 'Not connected',
  connected: (uuid) => `Connected (${uuid}…)`,
  unavailable: () => 'Unavailable on device',
  disconnected: () => 'Disconnected',
};

/** Clipboard API first; falls back to execCommand for non-secure contexts. */
export async function copyTextReliable(text: string): Promise<boolean> {
  if (navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // fall through
    }
  }
  const tmp = document.createElement('textarea');
  tmp.value = text;
  tmp.style.position = 'fixed';
  tmp.style.opacity = '0';
  document.body.appendChild(tmp);
  tmp.select();
  let copied = false;
  try {
    copied = document.execCommand('copy');
  } catch {
    // ignore
  }
  tmp.remove();
  return copied;
}

/** Briefly shows "Copied!" on a button after a successful copy. */
export function flashCopied(btn: HTMLElement, label = 'Copied!'): void {
  const orig = btn.textContent;
  btn.textContent = label;
  btn.classList.add('!text-state-success', '!border-state-success-border');
  setTimeout(() => {
    btn.textContent = orig;
    btn.classList.remove('!text-state-success', '!border-state-success-border');
  }, 2000);
}

export function initProvisioner(host: ProvisionerHost): ProvisionerApi {
  const { log } = host;

  const fields: Record<SetupField, HTMLInputElement | HTMLTextAreaElement | null> = {
    wifiSsid: el<HTMLInputElement>('prov-wifi-ssid'),
    nodeId: el<HTMLInputElement>('prov-node-id'),
    vmId: el<HTMLInputElement>('prov-vm-id'),
    hatchHost: el<HTMLInputElement>('prov-hatch-host'),
    webToken: el<HTMLTextAreaElement>('prov-web-token'),
    deviceAccessToken: el<HTMLInputElement>('prov-device-access-token'),
    deviceRefreshToken: el<HTMLInputElement>('prov-device-refresh-token'),
  };
  const wifiPass = el<HTMLInputElement>('prov-wifi-pass');
  const rememberPass = el<HTMLInputElement>('prov-wifi-remember');
  const value = (field: SetupField) => (fields[field]?.value ?? '').trim();

  // ---------------------------------------------------------------------------
  // Remembered form
  // ---------------------------------------------------------------------------
  const saveForm = () => {
    for (const field of SETUP_FIELDS) {
      const node = fields[field];
      if (node) saveSetupField(field, node.value);
    }
    saveWifiPassword(Boolean(rememberPass?.checked), wifiPass?.value ?? '');
  };

  for (const field of SETUP_FIELDS) {
    const node = fields[field];
    const saved = loadSetupField(field);
    if (node && saved !== null) node.value = saved;
    node?.addEventListener('input', saveForm);
  }
  const savedPass = loadSavedWifiPassword();
  if (rememberPass) rememberPass.checked = savedPass.remember;
  if (wifiPass && savedPass.remember) wifiPass.value = savedPass.password;
  wifiPass?.addEventListener('input', saveForm);
  rememberPass?.addEventListener('change', saveForm);

  el('prov-wifi-pass-toggle')?.addEventListener('click', (ev) => {
    if (!wifiPass) return;
    const btn = ev.currentTarget as HTMLButtonElement;
    const show = wifiPass.type === 'password';
    wifiPass.type = show ? 'text' : 'password';
    btn.textContent = show ? 'Hide' : 'Show';
    btn.setAttribute('aria-pressed', String(show));
  });

  el('prov-forget-btn')?.addEventListener('click', () => {
    if (!confirm('Forget the saved Wi-Fi, VM and token fields in this browser? Your SDK token is kept.')) return;
    forgetSetup();
    for (const field of SETUP_FIELDS) {
      const node = fields[field];
      if (node) node.value = '';
    }
    if (wifiPass) wifiPass.value = '';
    if (rememberPass) rememberPass.checked = false;
    log('warn', 'Forgot the saved provisioner fields in this browser.');
  });

  // A node id from BLE or USB. Tokens minted for another device are cleared so
  // a fresh pair gets minted for this one.
  const setDetectedNodeId = (nodeId: string, source: string) => {
    const nodeInput = fields.nodeId;
    if (!nodeInput || !nodeId) return;
    const prev = nodeInput.value.trim();
    const mintedFor = getMintedForNodeId();
    nodeInput.value = nodeId;
    const access = fields.deviceAccessToken;
    const refresh = fields.deviceRefreshToken;
    if ((prev && prev !== nodeId) || (mintedFor && mintedFor !== nodeId)) {
      if (access?.value || refresh?.value) {
        if (access) access.value = '';
        if (refresh) refresh.value = '';
        setMintedForNodeId(null);
        log(
          'warn',
          `New device node ID ${nodeId} (via ${source}, was ${prev || mintedFor}): cleared the previous device's tokens so a fresh 365-day pair is minted for it.`,
        );
      }
    }
    saveForm();
  };

  // ---------------------------------------------------------------------------
  // DevTools snippet
  // ---------------------------------------------------------------------------
  el('prov-copy-snippet-btn')?.addEventListener('click', async (ev) => {
    const btn = ev.currentTarget as HTMLButtonElement;
    const snippet = el('prov-devtools-snippet');
    if (!snippet) return;
    if (await copyTextReliable(snippet.textContent ?? '')) {
      flashCopied(btn);
      log('ok', 'Copied the DevTools snippet. Paste it into the Console of your logged-in muse.ai tab.');
    } else {
      const range = document.createRange();
      range.selectNodeContents(snippet);
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
      log('warn', 'Selected the snippet: press Ctrl+C (Cmd+C on macOS) to copy it.');
    }
  });

  // ---------------------------------------------------------------------------
  // Muse API via the Worker proxy
  // ---------------------------------------------------------------------------
  const museHost = () => {
    const { host, ignoredAccountApi } = normalizeMuseHost(fields.hatchHost?.value ?? '');
    if (ignoredAccountApi) {
      log('warn', `Ignoring Muse VM server "${value('hatchHost')}": that's the account API. Using the firmware default.`);
    }
    return host;
  };

  const mint = async () => {
    const webToken = value('webToken');
    const deviceId = value('nodeId');
    const sdkToken = host.getSdkToken().trim();
    if (!webToken) {
      throw new Error('Missing web access token: copy it from your logged-in muse.ai tab with the DevTools snippet.');
    }
    if (!deviceId.startsWith('homelink-')) {
      throw new Error("Node ID must look like 'homelink-xxxxxx' (connect over BLE or USB, or type it).");
    }
    if (sdkToken && !MUSE_SDK_TOKEN_REGEX.test(sdkToken)) {
      log('warn', "SDK token doesn't match the 48-char mgst_ format; sending it anyway...");
    }
    log('info', `Minting a 365-day device token pair for ${deviceId}...`);
    const tokens = await mintDeviceTokens({ webToken, deviceId, sdkToken });
    if (fields.deviceAccessToken) fields.deviceAccessToken.value = tokens.accessToken;
    if (fields.deviceRefreshToken) fields.deviceRefreshToken.value = tokens.refreshToken;
    setMintedForNodeId(deviceId);
    saveForm();
    log(
      'ok',
      `Minted 365-day device tokens: access_token ${tokens.accessToken.slice(0, 14)}... (${tokens.accessToken.length} chars), refresh_token ${tokens.refreshToken.slice(0, 14)}...`,
    );
    return tokens;
  };

  el<HTMLFormElement>('prov-form')?.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    await guarded('prov-mint-btn', mint, 'Mint');
  });

  el('prov-verify-btn')?.addEventListener('click', () =>
    guarded('prov-verify-btn', async () => {
      const token = value('deviceAccessToken') || value('webToken');
      if (!token) throw new Error('Mint a device access_token (or paste a web token) first.');
      log('info', 'Querying https://api.muse.ai/fetch_vms via the proxy...');
      const vms = await fetchVms(token);
      log('ok', `fetch_vms returned ${vms.length} VM(s): ${JSON.stringify(vms)}`);
      const firstVm = vms[0]?.vm_id;
      if (typeof firstVm === 'string' && firstVm && fields.vmId && !fields.vmId.value.trim()) {
        fields.vmId.value = firstVm;
        saveForm();
        log('ok', `Filled Muse VM ID with ${firstVm}.`);
      }
    }, 'Verify'),
  );

  // ---------------------------------------------------------------------------
  // USB serial console
  // ---------------------------------------------------------------------------
  const usbStatus = el('prov-usb-status');
  const showUsbStatus = (text: string, kind: 'ok' | 'error' | '' = '') => {
    if (!usbStatus) return;
    usbStatus.textContent = text;
    usbStatus.className = `mt-2 font-mono text-[11px] empty:hidden ${
      kind === 'ok' ? 'text-state-success' : kind === 'error' ? 'text-state-danger' : 'text-ink-muted'
    }`;
  };

  el('prov-sdk-usb-btn')?.addEventListener('click', () =>
    guarded('prov-sdk-usb-btn', async () => {
      const token = host.getSdkToken().trim();
      if (!MUSE_SDK_TOKEN_REGEX.test(token)) {
        throw new Error('Enter a valid 48-char mgst_ SDK token first (gadgets.muse.ai → Account → SDK tokens).');
      }
      showUsbStatus('Sending your SDK token over USB Serial…');
      try {
        await injectSdkTokenOverUsbSerial(token, {
          requestOptions: host.serialRequestOptions(),
          onLog: (msg) => log('info', msg),
        });
      } catch (err) {
        showUsbStatus((err as Error).message, 'error');
        throw err;
      }
      showUsbStatus('SDK token stored (@sdk_token ok). The gadget restarts with it.', 'ok');
      log('ok', 'SDK token stored in muse_nvs (@sdk_token ok); the gadget is restarting.');
    }, 'USB SDK token'),
  );

  el('serial-boot-wxm-btn')?.addEventListener('click', () =>
    guarded('serial-boot-wxm-btn', async () => {
      showUsbStatus('Sending >boot.weatherxm over USB Serial…');
      try {
        const info = await sendSwitchToWeatherXmOverUsbSerial({
          requestOptions: host.serialRequestOptions(),
          onLog: (msg) => log('info', msg),
        });
        const slot = info.wxm_label
          ? `${info.wxm_label} (${info.wxm_project || 'WeatherXM'} ${info.wxm_version || ''})`.trim()
          : 'WeatherXM';
        showUsbStatus(`Rebooting into stock WeatherXM firmware: ${slot}.`, 'ok');
        log('ok', `WG1200 is rebooting into stock WeatherXM (${slot}).`);
      } catch (err) {
        showUsbStatus((err as Error).message, 'error');
        throw err;
      }
    }, 'Return to WeatherXM'),
  );

  // ---------------------------------------------------------------------------
  // BLE
  // ---------------------------------------------------------------------------
  const banner = el('ble-confirm-banner');
  let busy = false;

  const updateButtons = (st: BleStatus) => {
    const hl = st.homeLink === 'connected';
    const comp = st.companion === 'connected';
    const set = (id: string, enabled: boolean) => {
      const btn = el<HTMLButtonElement>(id);
      if (btn) btn.disabled = !enabled || busy;
    };
    set('ble-disconnect-btn', st.connected);
    set('ble-refresh-btn', st.connected);
    set('prov-full-btn', hl);
    set('prov-homelink-btn', hl);
    set('prov-unpair-btn', hl);
    set('prov-companion-btn', comp);
    set('prov-hatch-test-btn', comp);
    const actionText = el('ble-action-status-text');
    if (actionText) {
      actionText.textContent = st.connected
        ? `${st.bleName} · Home Link ${hl ? 'OK' : '—'} · Companion ${comp ? 'OK' : '—'}`
        : 'Connect over BLE to enable provisioning';
    }
  };

  const renderStatus = (st: BleStatus) => {
    const text = (id: string, v: string) => {
      const node = el(id);
      if (node) node.textContent = v || '—';
    };
    text('st-ble-name', st.bleName);
    text('st-homelink-svc', SERVICE_TEXT[st.homeLink]('7fdd3d1c'));
    text('st-node-id', st.nodeId);
    text('st-full-device-id', st.fullDeviceId);
    text('st-fw-auth', st.fwAuth);
    text('st-companion-svc', SERVICE_TEXT[st.companion]('4d757365'));
    text('st-wifi', st.wifiState);
    text('st-link', st.linkState);
    text('st-hatch', st.hatchState);
    text('st-last-reply', st.lastReply);
    setBadge(el('prov-ble-badge'), st.connected ? `BLE: ${st.bleName}` : 'BLE: disconnected', st.connected ? 'ok' : '');
    updateButtons(st);
  };

  let lastStatus: BleStatus | null = null;
  const ble = new MuseBleProvisionerClient({
    onLog: (level, msg) => log(level, `[BLE] ${msg}`),
    onStatus: (st) => {
      lastStatus = st;
      renderStatus(st);
    },
    onStep: (step, state) => {
      el(`prov-step-${step}`)?.setAttribute('data-state', state);
    },
    onConfirmBanner: (active) => banner?.classList.toggle('hidden', !active),
    onNodeId: setDetectedNodeId,
    onDeviceSdkToken: (token) => host.setSdkToken(token),
  });

  // Runs one action at a time, with the triggering button disabled meanwhile.
  async function guarded(btnId: string, fn: () => Promise<unknown>, label: string): Promise<void> {
    if (busy) {
      log('warn', 'Another provisioning action is still running.');
      return;
    }
    busy = true;
    const btn = el<HTMLButtonElement>(btnId);
    if (btn) btn.disabled = true;
    if (lastStatus) updateButtons(lastStatus);
    try {
      await fn();
    } catch (err) {
      log('error', `${label} failed: ${(err as Error).message}`);
    } finally {
      busy = false;
      if (btn) btn.disabled = false;
      if (lastStatus) updateButtons(lastStatus);
    }
  }

  el('ble-connect-btn')?.addEventListener('click', () =>
    guarded('ble-connect-btn', () => ble.connect({ acceptAll: Boolean(el<HTMLInputElement>('ble-accept-all')?.checked) }), 'BLE connect'),
  );
  el('ble-disconnect-btn')?.addEventListener('click', () => ble.disconnect());
  el('ble-refresh-btn')?.addEventListener('click', () => guarded('ble-refresh-btn', () => ble.refresh(), 'Refresh'));

  // Focuses the first missing Wi-Fi field, as provision_v2 needs both.
  const requireWifi = () => {
    const ssid = value('wifiSsid');
    const password = wifiPass?.value ?? '';
    if (!ssid || !password) {
      (ssid ? wifiPass : fields.wifiSsid)?.focus();
      throw new Error('Both Wi-Fi SSID and Wi-Fi password are required for provision_v2.');
    }
    return { ssid, password };
  };

  const runHomeLink = (configureCompanionToo: boolean) => async () => {
    const { ssid, password } = requireWifi();
    await ble.runHomeLinkProvision(
      {
        ssid,
        password,
        host: museHost(),
        vmId: value('vmId'),
        accessToken: value('deviceAccessToken'),
        refreshToken: value('deviceRefreshToken'),
        mint,
      },
      { configureCompanionToo },
    );
  };

  el('prov-full-btn')?.addEventListener('click', () => guarded('prov-full-btn', runHomeLink(true), 'Full provisioning'));
  el('prov-homelink-btn')?.addEventListener('click', () =>
    guarded('prov-homelink-btn', runHomeLink(false), 'Home Link provisioning'),
  );
  el('prov-companion-btn')?.addEventListener('click', () =>
    guarded(
      'prov-companion-btn',
      () =>
        ble.runCompanionProvision(
          {
            ssid: value('wifiSsid'),
            password: wifiPass?.value ?? '',
            host: museHost(),
            vmId: value('vmId'),
            token: value('deviceAccessToken') || value('webToken'),
          },
          { includeWifi: true },
        ),
      'Companion setup',
    ),
  );
  el('prov-hatch-test-btn')?.addEventListener('click', () => guarded('prov-hatch-test-btn', () => ble.hatchTest(), 'hatch.test'));
  el('prov-unpair-btn')?.addEventListener('click', () => {
    if (!confirm('Send unpair / reset to the Home Link on this device?')) return;
    void guarded('prov-unpair-btn', () => ble.unpair(), 'Unpair');
  });

  // ---------------------------------------------------------------------------
  // Start-up checks
  // ---------------------------------------------------------------------------
  void runCryptoSelfTest()
    .then(() => setBadge(el('prov-crypto-badge'), 'Crypto v5: PASS', 'ok'))
    .catch((err: Error) => {
      setBadge(el('prov-crypto-badge'), 'Crypto v5: FAIL', 'err');
      log('error', `Home Link crypto self-test failed: ${err.message}`);
    });

  void checkProxyHealth().then((health) => {
    if (health?.ok) {
      setBadge(el('prov-proxy-badge'), `Proxy: online (${health.upstream?.replace(/^https?:\/\//, '') || 'api.muse.ai'})`, 'ok');
    } else {
      setBadge(el('prov-proxy-badge'), 'Proxy: offline', 'err');
      log('warn', 'The /api proxy is not reachable, so minting and VM lookup are off. Run `npm run preview` (wrangler dev) or deploy the Worker.');
    }
  });

  void fetchSdkTokenDefault().then((token) => {
    if (MUSE_SDK_TOKEN_REGEX.test(token) && !host.getSdkToken().trim()) {
      host.setSdkToken(token);
      log('ok', `Loaded SDK token ${token.slice(0, 12)}... from the local Worker (MUSE_SDK_TOKEN).`);
    }
  });

  for (let i = 1; i <= PROVISION_STEPS.length; i++) el(`prov-step-${i}`)?.setAttribute('data-state', '');

  // ---------------------------------------------------------------------------
  // Swipe-down card prompt (stored on the gateway, set over USB or BLE)
  // ---------------------------------------------------------------------------
  const CARD_PROMPT_KEY = 'muse_setup_cardPrompt';
  const promptText = el<HTMLTextAreaElement>('card-prompt-text');
  const promptStatus = el('card-prompt-status');
  const showPromptStatus = (text: string, kind: 'ok' | 'error' | '' = '') => {
    if (!promptStatus) return;
    promptStatus.textContent = text;
    promptStatus.className = `mt-2 font-mono text-[11px] empty:hidden ${
      kind === 'ok' ? 'text-state-success' : kind === 'error' ? 'text-state-danger' : 'text-ink-muted'
    }`;
  };
  const renderPromptCheck = () => {
    const text = normalizeCardPrompt(promptText?.value ?? '');
    const check = checkCardPrompt(text);
    const count = el('card-prompt-count');
    if (count) {
      count.textContent = `${new TextEncoder().encode(text).length} / ${CARD_PROMPT_MAX}`;
      count.classList.toggle('text-state-danger', !check.ok);
    }
    const note = el('card-prompt-check');
    if (note) {
      note.textContent = check.error ?? (check.missing.length ? `Leaves out ${check.missing.join(', ')}.` : '');
      note.className = `mt-1 font-mono text-[11px] empty:hidden ${check.ok ? 'text-state-warning' : 'text-state-danger'}`;
    }
    try {
      localStorage.setItem(CARD_PROMPT_KEY, promptText?.value ?? '');
    } catch {
      // unsaved in private windows
    }
  };
  let savedPrompt: string | null = null;
  try {
    savedPrompt = localStorage.getItem(CARD_PROMPT_KEY);
  } catch {
    // ignore
  }
  if (promptText) promptText.value = savedPrompt || DEFAULT_CARD_PROMPT;
  renderPromptCheck();
  promptText?.addEventListener('input', renderPromptCheck);

  const promptVia = () =>
    (document.querySelector<HTMLInputElement>('input[name="card-prompt-via"]:checked')?.value ?? 'usb') as 'usb' | 'ble';

  // Sends `text` (empty: the built-in default) over the chosen link.
  const storePrompt = async (text: string) => {
    if (promptVia() === 'ble') {
      if (!ble.hasCompanion) {
        throw new Error('Connect over Bluetooth first (step 2), or send via USB.');
      }
      await ble.writeCardPrompt(cardPromptCommands(text));
      showPromptStatus(
        text ? `Sent ${text.length} chars over Bluetooth; the gateway answers in the log.` : 'Sent the reset over Bluetooth.',
        'ok',
      );
    } else {
      showPromptStatus('Sending over USB Serial…');
      const stored = await writeCardPromptOverUsb(text, {
        requestOptions: host.serialRequestOptions(),
        onLog: (msg) => log('info', msg),
      });
      showPromptStatus(
        stored.custom ? `Saved on the gateway (${stored.len} chars). The next swipe uses it.` : 'The gateway uses the built-in prompt again.',
        'ok',
      );
    }
    log('ok', text ? `Swipe-down card prompt saved (${text.length} chars).` : 'Swipe-down card prompt reset to built-in.');
  };

  el('card-prompt-save-btn')?.addEventListener('click', () =>
    guarded('card-prompt-save-btn', async () => {
      const text = normalizeCardPrompt(promptText?.value ?? '');
      const check = checkCardPrompt(text);
      if (!check.ok) {
        showPromptStatus(check.error ?? 'Invalid prompt.', 'error');
        throw new Error(check.error);
      }
      // The built-in text is stored as "no custom prompt", so firmware updates
      // to the default still apply.
      await storePrompt(text === DEFAULT_CARD_PROMPT ? '' : text).catch((err: Error) => {
        showPromptStatus(err.message, 'error');
        throw err;
      });
    }, 'Save card prompt'),
  );

  el('card-prompt-reset-btn')?.addEventListener('click', () =>
    guarded('card-prompt-reset-btn', async () => {
      await storePrompt('').catch((err: Error) => {
        showPromptStatus(err.message, 'error');
        throw err;
      });
      if (promptText) promptText.value = DEFAULT_CARD_PROMPT;
      renderPromptCheck();
    }, 'Reset card prompt'),
  );

  el('card-prompt-read-btn')?.addEventListener('click', () =>
    guarded('card-prompt-read-btn', async () => {
      showPromptStatus('Reading over USB Serial…');
      const stored = await readCardPromptOverUsb({
        requestOptions: host.serialRequestOptions(),
        onLog: (msg) => log('info', msg),
      }).catch((err: Error) => {
        showPromptStatus(err.message, 'error');
        throw err;
      });
      if (promptText) promptText.value = stored.text;
      renderPromptCheck();
      showPromptStatus(`Loaded the gateway's ${stored.custom ? 'custom' : 'built-in'} prompt (${stored.len} chars).`, 'ok');
    }, 'Read card prompt'),
  );

  el('card-prompt-default-btn')?.addEventListener('click', () => {
    if (promptText) promptText.value = DEFAULT_CARD_PROMPT;
    renderPromptCheck();
    showPromptStatus('Built-in text restored in the editor; save to send it.');
  });

  return {
    setNodeIdFromUsb(nodeId: string) {
      if (value('nodeId') !== nodeId) setDetectedNodeId(nodeId, 'USB MAC');
    },
  };
}
