import { FlasherController } from './flasher/flasherController';
import { formatFlavorLabel } from './flasher/appDescriptor';
import { WG1200_USB_FILTERS } from './flasher/constants';
import type { FirmwareTargetId } from './flasher/manifest';
import type { FlasherState } from './flasher/state';
import type { BleLogLevel } from './muse/bleClient';
import { getStoredSdkToken, setStoredSdkToken, validateSdkToken } from './muse/sdkToken';
import { copyTextReliable, flashCopied, initProvisioner, type ProvisionerApi } from './provisionerApp';

function el<T extends HTMLElement = HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}

const MAX_LOG_LINES = 500;
const LOG_PREFIX: Record<BleLogLevel, string> = {
  info: 'INFO  ',
  ok: 'OK    ',
  warn: 'WARN  ',
  error: 'ERROR ',
  ble: 'BLE   ',
};
const LOG_CLASS: Record<BleLogLevel, string> = {
  info: '',
  ok: 'log-ok',
  warn: 'log-warn',
  error: 'log-error',
  ble: 'log-ble',
};

const timestamp = () => new Date().toISOString().slice(11, 23);

export function initWg1200Studio(): void {
  const controller = new FlasherController();
  let provisioner: ProvisionerApi | null = null;
  let lastUsbMac = '';
  let logLines: string[] = [];

  const appendLog = (level: BleLogLevel, formattedLine: string) => {
    const line = `${LOG_PREFIX[level]}${formattedLine}`;
    logLines.push(line);
    const pre = el<HTMLPreElement>('technical-log-output');
    if (pre) {
      const row = document.createElement('div');
      row.className = LOG_CLASS[level];
      row.textContent = line;
      pre.appendChild(row);
      while (pre.childElementCount > MAX_LOG_LINES) pre.firstElementChild?.remove();
      pre.scrollTop = pre.scrollHeight;
    }
    if (logLines.length > MAX_LOG_LINES) {
      logLines = logLines.slice(logLines.length - MAX_LOG_LINES);
    }
    const countBadge = el('log-line-count');
    if (countBadge) {
      countBadge.textContent = `${logLines.length} lines`;
    }
  };

  controller.subscribeLogs(appendLog);

  // Workspace tab switching
  const switchWorkspaceTab = (tab: 'flasher' | 'provisioner') => {
    const flasherSection = el('workspace-flasher');
    const provisionerSection = el('workspace-provisioner');
    const btnFlasher = el<HTMLButtonElement>('tab-btn-flasher');
    const btnProvisioner = el<HTMLButtonElement>('tab-btn-provisioner');

    const isFlasher = tab === 'flasher';
    flasherSection?.classList.toggle('hidden', !isFlasher);
    el('workspace-flasher-safety')?.classList.toggle('hidden', !isFlasher);
    provisionerSection?.classList.toggle('hidden', isFlasher);

    if (btnFlasher && btnProvisioner) {
      btnFlasher.setAttribute('aria-selected', String(isFlasher));
      btnProvisioner.setAttribute('aria-selected', String(!isFlasher));

      const activeClasses = ['bg-surface-raised', 'text-ink', 'shadow-sm', 'border-line-strong'];
      const inactiveClasses = ['text-ink-secondary', 'border-transparent'];

      if (isFlasher) {
        btnFlasher.classList.add(...activeClasses);
        btnFlasher.classList.remove(...inactiveClasses);
        btnProvisioner.classList.remove(...activeClasses);
        btnProvisioner.classList.add(...inactiveClasses);
      } else {
        btnProvisioner.classList.add(...activeClasses);
        btnProvisioner.classList.remove(...inactiveClasses);
        btnFlasher.classList.remove(...activeClasses);
        btnFlasher.classList.add(...inactiveClasses);
      }
    }
  };

  document.querySelectorAll<HTMLButtonElement>('[data-workspace-tab]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const target = btn.dataset.workspaceTab === 'provisioner' ? 'provisioner' : 'flasher';
      switchWorkspaceTab(target);
    });
  });

  el('jump-to-ble-setup-btn')?.addEventListener('click', () => switchWorkspaceTab('provisioner'));
  el('post-flash-open-ble-btn')?.addEventListener('click', () => switchWorkspaceTab('provisioner'));

  if (window.location.hash === '#setup' || window.location.hash === '#ble') {
    switchWorkspaceTab('provisioner');
  }

  // Browser support check
  const hasWebSerial = 'serial' in navigator;
  const hasWebBluetooth = 'bluetooth' in navigator;
  if (!hasWebSerial || !hasWebBluetooth) {
    const notice = el('browser-notice-banner');
    const desc = el('browser-notice-desc');
    notice?.classList.remove('hidden');
    if (desc) {
      desc.textContent = `Detected support — Web Serial: ${hasWebSerial ? 'Available' : 'Missing'}, Web Bluetooth: ${hasWebBluetooth ? 'Available' : 'Missing'}. Use Chrome, Edge, or Brave on desktop for full USB + BLE functionality.`;
    }
  }

  // Sync SDK Token inputs between Flasher tab and Post-Flash Setup tab
  const preSdkInput = el<HTMLInputElement>('pre-flash-sdk-token');
  const preSdkHint = el('pre-flash-sdk-token-hint');
  const postSdkInput = el<HTMLInputElement>('prov-sdk-token');
  const postSdkCheck = el('prov-sdk-token-check');
  const showAllPortsInput = el<HTMLInputElement>('usb-show-all-ports');

  const syncSdkTokenInputs = (rawVal: string, source: 'pre' | 'post' | 'init') => {
    if (source !== 'pre' && preSdkInput) preSdkInput.value = rawVal;
    if (source !== 'post' && postSdkInput) postSdkInput.value = rawVal;

    const check = validateSdkToken(rawVal);
    if (check.valid || check.empty) {
      setStoredSdkToken(rawVal);
    }

    const hintText = check.empty
      ? 'Optional during flash (can also be injected anytime in Step 2A via USB Serial).'
      : check.reason;
    const tone = check.valid ? 'text-muse' : check.empty ? 'text-ink-muted' : 'text-state-danger';

    if (preSdkHint) {
      preSdkHint.textContent = hintText;
      preSdkHint.className = `mt-1.5 text-[11px] ${tone}`;
    }
    if (postSdkCheck) {
      postSdkCheck.textContent = check.empty ? '' : check.reason;
      postSdkCheck.className = `mt-1 block text-[11px] ${tone}`;
    }
  };

  const initialSdkToken = getStoredSdkToken();
  syncSdkTokenInputs(initialSdkToken, 'init');

  preSdkInput?.addEventListener('input', () => syncSdkTokenInputs(preSdkInput.value, 'pre'));
  postSdkInput?.addEventListener('input', () => syncSdkTokenInputs(postSdkInput.value, 'post'));

  // WeatherXM version dropdown
  const wxmSelect = el<HTMLSelectElement>('wxm-version-select');
  const getSelectedWxmTargetId = (): FirmwareTargetId => {
    const val = wxmSelect?.value;
    if (val === 'weatherxm_0_8_34' || val === 'weatherxm_0_6_2') return val;
    return 'weatherxm';
  };

  // Update UI whenever FlasherState or WeatherXM dropdown changes
  const renderFlasherState = (state: FlasherState) => {
    const connectBtn = el<HTMLButtonElement>('connect-usb-btn');
    const connectLabel = el('connect-usb-btn-label');
    const disconnectBtn = el<HTMLButtonElement>('disconnect-usb-btn');
    const connBadge = el('usb-connection-badge');
    const devPanel = el('device-status-panel');
    const progressPanel = el('flash-progress-panel');
    const postFlashPanel = el('post-flash-panel');

    const isBusy =
      state.stage === 'connecting' ||
      state.stage === 'inspecting' ||
      state.stage === 'flashing' ||
      state.stage === 'verifying' ||
      state.stage === 'rebooting';

    if (connectBtn) connectBtn.disabled = isBusy;
    if (connectLabel) {
      connectLabel.textContent =
        state.stage === 'connecting'
          ? 'Connecting USB...'
          : state.stage === 'inspecting'
            ? 'Inspecting Flash Slots...'
            : state.device
              ? 'Re-Sync USB Device'
              : 'Connect WG1200 via USB Serial';
    }
    disconnectBtn?.classList.toggle('hidden', !state.device || isBusy);

    if (connBadge) {
      connBadge.textContent = `Status: ${state.stage.toUpperCase()}${
        state.errorMessage ? ` — ${state.errorMessage}` : ''
      }`;
      connBadge.className = `font-mono text-xs ${
        state.stage === 'error'
          ? 'text-state-danger'
          : state.device
            ? 'text-state-success'
            : 'text-ink-muted'
      }`;
    }

    // Device telemetry panel
    if (state.device) {
      devPanel?.classList.remove('hidden');
      const d = state.device;

      const flavorPill = el('dev-active-flavor-pill');
      if (flavorPill) {
        flavorPill.textContent = `Active: ${formatFlavorLabel(d.activeFlavor)} (${d.activeSlot})`;
      }

      const ptPill = el('dev-pt-status-pill');
      if (ptPill) {
        ptPill.textContent = d.partitionValidation.hasMuseNvs
          ? 'Partition Table: Dual-Boot Ready (muse_nvs @ 0xF21000)'
          : 'Partition Table: Stock WG1200 (9 partitions)';
      }

      const chipFlash = el('dev-chip-flash');
      if (chipFlash) {
        const link =
          d.usbLink === 'usb-jtag' ? 'native USB' : d.usbLink === 'ch340' ? 'CH340 (slow)' : 'USB serial';
        chipFlash.textContent = `${d.chipName} · ${(d.flashSizeBytes / 1024 / 1024).toFixed(0)} MB · ${link}`;
        chipFlash.classList.toggle('text-state-warning', d.usbLink === 'ch340');
        chipFlash.title =
          d.usbLink === 'ch340'
            ? 'Connected through the CH340 bridge: flashing takes minutes. Reconnect on "USB JTAG/serial debug unit" for ~20 s flashing.'
            : '';
      }

      const macEui = el('dev-mac-eui');
      if (macEui) {
        macEui.textContent = `${d.identity.macColonHex}`;
      }

      const museBle = el('dev-muse-ble-name');
      if (museBle) museBle.textContent = d.identity.museBleName;

      const wxmBle = el('dev-wxm-ble-name');
      if (wxmBle) wxmBle.textContent = d.identity.wxmBleName;

      // The firmware names itself homelink-xxxxxx from the STA MAC's last 3
      // octets (esp32/main/identity.c): pre-fill it once per USB device.
      if (provisioner && d.identity.macColonHex !== lastUsbMac) {
        lastUsbMac = d.identity.macColonHex;
        provisioner.setNodeIdFromUsb(`homelink-${d.identity.shortHexLower}`);
      }

      // Slot cards
      const factoryAppEl = el('slot-app-factory');
      if (factoryAppEl) {
        factoryAppEl.textContent = d.factoryApp.valid
          ? `${d.factoryApp.projectName} (${d.factoryApp.version})`
          : 'Empty / Unreadable';
      }
      const ota0AppEl = el('slot-app-ota0');
      const ota0MetaEl = el('slot-meta-ota0');
      const ota0BadgeEl = el('slot-badge-ota0');
      if (ota0AppEl) {
        ota0AppEl.textContent = d.ota0App.valid
          ? `${formatFlavorLabel(d.ota0App.flavor)} (${d.ota0App.version})`
          : 'Empty Slot';
      }
      if (ota0MetaEl) {
        ota0MetaEl.textContent = d.ota0App.valid
          ? `Project: ${d.ota0App.projectName} · Built ${d.ota0App.compileDate}`
          : 'Ready for WeatherXM image';
      }
      if (ota0BadgeEl) {
        const isOta0Active = d.activeSlot === 'ota_0';
        ota0BadgeEl.textContent = isOta0Active ? 'ACTIVE BOOT' : 'Standby';
        ota0BadgeEl.className = `rounded-pill border px-2 py-0.5 font-mono text-[10px] ${
          isOta0Active
            ? 'border-wxm-border bg-wxm-subtle text-wxm font-semibold'
            : 'border-line text-ink-muted'
        }`;
      }

      const ota1AppEl = el('slot-app-ota1');
      const ota1MetaEl = el('slot-meta-ota1');
      const ota1BadgeEl = el('slot-badge-ota1');
      if (ota1AppEl) {
        ota1AppEl.textContent = d.ota1App.valid
          ? `${formatFlavorLabel(d.ota1App.flavor)} (${d.ota1App.version})`
          : 'Empty Slot';
      }
      if (ota1MetaEl) {
        ota1MetaEl.textContent = d.ota1App.valid
          ? `Project: ${d.ota1App.projectName} · Built ${d.ota1App.compileDate}`
          : 'Ready for Muse Gadget OS';
      }
      if (ota1BadgeEl) {
        const isOta1Active = d.activeSlot === 'ota_1';
        ota1BadgeEl.textContent = isOta1Active ? 'ACTIVE BOOT' : 'Standby';
        ota1BadgeEl.className = `rounded-pill border px-2 py-0.5 font-mono text-[10px] ${
          isOta1Active
            ? 'border-muse-border bg-muse-subtle text-muse font-semibold'
            : 'border-line text-ink-muted'
        }`;
      }
    } else {
      devPanel?.classList.add('hidden');
    }

    // Firmware cards buttons & instant-switch indicators
    const installMuseBtn = el<HTMLButtonElement>('install-muse-btn');
    const installMuseLabel = el('install-muse-btn-label');
    const forceMuseBtn = el<HTMLButtonElement>('force-reflash-muse-btn');
    const museHint = el('muse-install-mode-hint');

    const installWxmBtn = el<HTMLButtonElement>('install-wxm-btn');
    const installWxmLabel = el('install-wxm-btn-label');
    const forceWxmBtn = el<HTMLButtonElement>('force-reflash-wxm-btn');
    const wxmHint = el('wxm-install-mode-hint');

    const canAct = Boolean(state.device && state.manifest && !isBusy && state.stage !== 'complete');

    if (state.manifest) {
      const museEntry = state.manifest.firmwares.muse;
      const wxmTargetId = getSelectedWxmTargetId();
      const wxmEntry = state.manifest.firmwares[wxmTargetId];

      const museBadge = el('muse-card-status-badge');
      if (museBadge) museBadge.textContent = `v${museEntry.version}`;
      const museSha = el('muse-sha-short');
      if (museSha) museSha.textContent = `${museEntry.sha256.slice(0, 12)}…`;

      const wxmBadge = el('wxm-card-status-badge');
      if (wxmBadge) wxmBadge.textContent = `${wxmEntry.version}`;
      const wxmSha = el('wxm-sha-short');
      if (wxmSha) wxmSha.textContent = `${wxmEntry.sha256.slice(0, 12)}…`;

      const museInstant = controller.canInstantSwitchTo('muse');
      const wxmInstant = controller.canInstantSwitchTo(wxmTargetId);

      if (installMuseBtn) installMuseBtn.disabled = !canAct;
      if (installMuseLabel) {
        installMuseLabel.textContent = museInstant
          ? 'Instant Switch to Muse (~2s)'
          : 'Install & Boot Muse OS (~30s)';
      }
      if (forceMuseBtn) {
        forceMuseBtn.disabled = !canAct;
        forceMuseBtn.classList.toggle('hidden', !museInstant);
      }
      if (museHint) {
        museHint.textContent = museInstant
          ? 'Already in ota_1 — switches via otadata in ~2s!'
          : 'Writes signed image to ota_1 (0x820000)';
      }

      if (installWxmBtn) installWxmBtn.disabled = !canAct;
      if (installWxmLabel) {
        installWxmLabel.textContent = wxmInstant
          ? `Instant Switch to ${wxmEntry.shortName} (~2s)`
          : `Install & Boot ${wxmEntry.shortName} (~30s)`;
      }
      if (forceWxmBtn) {
        forceWxmBtn.disabled = !canAct;
        forceWxmBtn.classList.toggle('hidden', !wxmInstant);
      }
      if (wxmHint) {
        wxmHint.textContent = wxmInstant
          ? 'Already in ota_0 — switches via otadata in ~2s!'
          : 'Writes signed image to ota_0 (0x420000)';
      }
    }

    // Advanced tools buttons
    const exportBtn = el<HTMLButtonElement>('export-backup-zip-btn');
    const resetFactoryBtn = el<HTMLButtonElement>('reset-factory-slot-btn');
    if (exportBtn) exportBtn.disabled = !canAct;
    if (resetFactoryBtn) resetFactoryBtn.disabled = !canAct;

    // Progress panel
    if (state.progress && (isBusy || state.stage === 'complete')) {
      progressPanel?.classList.remove('hidden');
      const stageEl = el('flash-progress-stage');
      const subEl = el('flash-progress-sub');
      const pctEl = el('flash-progress-pct');
      const barEl = el('flash-progress-bar');
      if (stageEl) stageEl.textContent = state.progress.stageLabel;
      if (subEl) subEl.textContent = state.progress.subLabel;
      if (pctEl) pctEl.textContent = `${state.progress.percent}%`;
      if (barEl) barEl.style.width = `${state.progress.percent}%`;
    } else {
      progressPanel?.classList.add('hidden');
    }

    // Post-flash completion instructions
    if (state.stage === 'complete') {
      postFlashPanel?.classList.remove('hidden');
      const modeBadge = el('post-flash-mode-badge');
      const titleEl = el('post-flash-title');
      const descEl = el('post-flash-desc');
      const openBleBtn = el('post-flash-open-ble-btn');

      if (modeBadge) {
        modeBadge.textContent =
          state.lastOperationMode === 'instant-switch'
            ? '2-Second Instant Slot Switch'
            : state.lastOperationMode === 'factory-reset'
              ? 'Factory Slot Activated'
              : 'Full OTA Slot Flash + Verify';
      }

      if (state.lastBootDownloadMode) {
        if (titleEl) titleEl.textContent = 'Unplug & Replug the WG1200';
        if (descEl) {
          descEl.textContent =
            'The boot slot was switched, but the WG1200 restarted into its download mode (black screen) instead of booting it. Unplug the USB-C cable and plug it back in: the selected firmware boots from there.';
        }
        openBleBtn?.classList.add('hidden');
      } else if (state.lastCompletedFlavor === 'muse') {
        if (titleEl) titleEl.textContent = 'Muse Gadget OS Active on WG1200 (ota_1)';
        if (descEl) {
          descEl.textContent = state.lastSdkTokenInjected
            ? 'Muse booted and saved your mgst_... SDK token to muse_nvs (@sdk_token ok). Continue to Step 2 to pair Home Link & Companion over BLE.'
            : state.lastSdkTokenError
              ? `Muse is installed, but the SDK token wasn't stored (${state.lastSdkTokenError}). Use "Write via USB Serial" in Step 2.`
              : !state.lastBootConfirmed
                ? "Muse is installed in ota_1, but the boot log couldn't be read back over USB. Check the WG1200 screen, then continue to Step 2 to send your SDK token and pair over BLE."
                : 'Muse Gadget OS is running on your WG1200. Continue to Step 2 to send your SDK token and pair Home Link & Companion over BLE.';
        }
        openBleBtn?.classList.remove('hidden');
      } else {
        if (titleEl) titleEl.textContent = 'WeatherXM Official Firmware Active on WG1200 (ota_0)';
        if (descEl) {
          descEl.textContent =
            'Your WG1200 has booted into official WeatherXM station gateway firmware. Muse remains preserved in ota_1 for instant switching.';
        }
        openBleBtn?.classList.add('hidden');
      }
    } else {
      postFlashPanel?.classList.add('hidden');
    }
  };

  controller.subscribeState(renderFlasherState);
  wxmSelect?.addEventListener('change', () => renderFlasherState(controller.currentState));

  // Connect / Disconnect buttons
  const connectUsb = () =>
    void controller.connectDevice({ showAllPorts: Boolean(showAllPortsInput?.checked) });
  el('connect-usb-btn')?.addEventListener('click', connectUsb);
  el('post-flash-reconnect-usb-btn')?.addEventListener('click', connectUsb);
  el('disconnect-usb-btn')?.addEventListener('click', () => {
    void controller.disconnectDevice();
  });

  // Confirmation modal (<dialog>) for flashing/switching
  const confirmDialog = el<HTMLDialogElement>('confirm-flash-dialog');
  const confirmProceedBtn = el<HTMLButtonElement>('confirm-dialog-proceed-btn');
  let pendingOperation: { targetId: FirmwareTargetId; forceFullFlash: boolean } | null = null;

  const openConfirmModal = (targetId: FirmwareTargetId, forceFullFlash: boolean) => {
    const { manifest } = controller.currentState;
    if (!manifest) return;
    const entry = manifest.firmwares[targetId];
    const isInstant = !forceFullFlash && controller.canInstantSwitchTo(targetId);

    pendingOperation = { targetId, forceFullFlash };

    const titleEl = el('confirm-dialog-title');
    const descEl = el('confirm-dialog-desc');
    const nameEl = el('confirm-target-name');
    const slotEl = el('confirm-target-slot');
    const modeEl = el('confirm-target-mode');

    if (titleEl) {
      titleEl.textContent = isInstant
        ? `Instant Switch to ${entry.shortName}`
        : `Install & Boot ${entry.shortName}`;
    }
    if (descEl) {
      descEl.textContent = isInstant
        ? `${entry.shortName} (${entry.version}) is already verified in ${entry.targetPartition}. Only otadata (0x013000) will be updated (~2 seconds).`
        : `Writes ${entry.shortName} (${entry.version}) into ${entry.targetPartition} (0x${entry.targetOffset.toString(16)}) and updates otadata to boot it. Your other OTA slot and factory image remain untouched.`;
    }
    if (nameEl) nameEl.textContent = `${entry.shortName} (${entry.version})`;
    if (slotEl) {
      slotEl.textContent = `${entry.targetPartition} (0x${entry.targetOffset.toString(16)})`;
    }
    if (modeEl) {
      modeEl.textContent = isInstant ? 'Instant Slot Switch (~2s)' : 'Full Signed OTA Write (~30s)';
    }

    confirmDialog?.showModal();
  };

  confirmProceedBtn?.addEventListener('click', () => {
    confirmDialog?.close();
    if (!pendingOperation) return;
    const { targetId, forceFullFlash } = pendingOperation;
    pendingOperation = null;
    const sdkToken = preSdkInput?.value.trim() || getStoredSdkToken();
    void controller.installOrSwitchTarget(targetId, { forceFullFlash, sdkToken });
  });

  el('install-muse-btn')?.addEventListener('click', () => openConfirmModal('muse', false));
  el('force-reflash-muse-btn')?.addEventListener('click', () => openConfirmModal('muse', true));
  el('install-wxm-btn')?.addEventListener('click', () =>
    openConfirmModal(getSelectedWxmTargetId(), false),
  );
  el('force-reflash-wxm-btn')?.addEventListener('click', () =>
    openConfirmModal(getSelectedWxmTargetId(), true),
  );

  // Advanced Tools <dialog>
  const advDialog = el<HTMLDialogElement>('advanced-tools-dialog');
  el('open-advanced-tools-btn')?.addEventListener('click', () => {
    advDialog?.showModal();
  });

  el('export-backup-zip-btn')?.addEventListener('click', async () => {
    try {
      const blob = await controller.exportBackupZip();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      const macSuffix =
        controller.currentState.device?.identity.shortHexLower || 'wg1200';
      a.href = url;
      a.download = `wg1200-backup-${macSuffix}.zip`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
    } catch (err) {
      controller.log('error', err instanceof Error ? err.message : String(err));
    }
  });

  el('reset-factory-slot-btn')?.addEventListener('click', () => {
    advDialog?.close();
    void controller.resetToFactorySlot();
  });

  // Log copy & clear buttons
  el('copy-logs-btn')?.addEventListener('click', async (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    const btn = ev.currentTarget as HTMLButtonElement;
    if (await copyTextReliable(logLines.join('\n'))) flashCopied(btn);
  });
  el('clear-logs-btn')?.addEventListener('click', (ev) => {
    ev.stopPropagation();
    logLines = [];
    const pre = el<HTMLPreElement>('technical-log-output');
    const countBadge = el('log-line-count');
    if (pre) pre.textContent = '';
    if (countBadge) countBadge.textContent = '0 lines';
  });

  // =========================================================================
  // Step 2/3 Workspace: USB Serial SDK Token & BLE Provisioner
  // =========================================================================
  provisioner = initProvisioner({
    log: (level, msg) => appendLog(level, `[${timestamp()}] ${msg}`),
    getSdkToken: () => postSdkInput?.value || preSdkInput?.value || getStoredSdkToken(),
    setSdkToken: (token) => syncSdkTokenInputs(token, 'init'),
    serialRequestOptions: () =>
      showAllPortsInput?.checked ? undefined : { filters: [...WG1200_USB_FILTERS] },
  });
  renderFlasherState(controller.currentState);

  void controller.init();
}
