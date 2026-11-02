import JSZip from 'jszip';
import {
  APP_HEADER_READ_SIZE,
  FACTORY_OFFSET,
  OTADATA_OFFSET,
  OTADATA_SIZE,
  OTA_0_OFFSET,
  OTA_1_OFFSET,
  PARTITION_TABLE_OFFSET,
  PARTITION_TABLE_READ_SIZE,
  WG1200_USB_FILTERS,
  classifyUsbLink,
  describeUsbLink,
} from './constants';
import { parseAppDescriptor, type FirmwareFlavor } from './appDescriptor';
import { sha256Hex } from './hashing';
import {
  fetchFirmwareManifest,
  type FirmwareTargetId,
  type ManifestFirmwareEntry,
} from './manifest';
import { buildFactoryResetOtadata, buildOtadataForSlot, parseOtadata } from './otadata';
import { installPacedSerial, pacingForPort } from './pacedSerial';
import { monitorPostBootAndInjectToken } from './serialLog';
import {
  INITIAL_FLASHER_STATE,
  type FlasherState,
} from './state';
import { EspFlashSession, type LoggerCallbacks } from './transport';
import { verifySignedAppImage } from './writeGuard';
import { sendTelemetryEvent } from '../telemetry';
import { getStoredSdkToken } from '../muse/sdkToken';

export type StateSubscriber = (state: FlasherState) => void;
export type LogSubscriber = (level: 'info' | 'warn' | 'error', message: string) => void;

export interface ConnectDeviceOptions {
  /** List every serial port instead of only the WG1200's USB-JTAG and CH340 devices. */
  showAllPorts?: boolean;
}

export class FlasherController {
  private state: FlasherState = { ...INITIAL_FLASHER_STATE };
  private stateSubscribers = new Set<StateSubscriber>();
  private logSubscribers = new Set<LogSubscriber>();
  private session: EspFlashSession | null = null;

  constructor() {
    // Pacing is switched on per session, only once a CH340 port is picked.
    installPacedSerial();
  }

  subscribeState(cb: StateSubscriber): () => void {
    this.stateSubscribers.add(cb);
    cb(this.state);
    return () => this.stateSubscribers.delete(cb);
  }

  subscribeLogs(cb: LogSubscriber): () => void {
    this.logSubscribers.add(cb);
    return () => this.logSubscribers.delete(cb);
  }

  get currentState(): FlasherState {
    return this.state;
  }

  private setState(patch: Partial<FlasherState>): void {
    this.state = { ...this.state, ...patch };
    for (const sub of this.stateSubscribers) {
      sub(this.state);
    }
  }

  public log(level: 'info' | 'warn' | 'error', message: string): void {
    const timestamp = new Date().toISOString().slice(11, 23);
    const formatted = `[${timestamp}] ${message}`;
    for (const sub of this.logSubscribers) {
      sub(level, formatted);
    }
  }

  private get logger(): LoggerCallbacks {
    return {
      info: (msg) => this.log('info', msg),
      warn: (msg) => this.log('warn', msg),
      error: (msg) => this.log('error', msg),
    };
  }

  async init(): Promise<void> {
    try {
      const manifest = await fetchFirmwareManifest();
      this.setState({ manifest });
      this.log(
        'info',
        `Loaded WG1200 dual-boot manifest: Muse v${manifest.firmwares.muse.version} (ota_1) + WeatherXM v${manifest.firmwares.weatherxm.version} (ota_0).`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log('error', `Failed to load firmware manifest: ${msg}`);
    }
  }

  async connectDevice(options?: ConnectDeviceOptions): Promise<void> {
    if (!('serial' in navigator)) {
      this.setState({
        stage: 'error',
        errorMessage:
          'Web Serial API is not available in this browser. Please open this page in Chrome, Edge, or Brave on desktop.',
      });
      return;
    }

    // Re-sync: release the previous port first, or opening it again fails.
    if (this.session) {
      await this.session.disconnectQuietly();
      this.session = null;
    }

    try {
      this.setState({ stage: 'connecting', errorMessage: null, progress: null, device: null });
      const port = await navigator.serial.requestPort(
        options?.showAllPorts ? undefined : { filters: [...WG1200_USB_FILTERS] },
      );
      const info = port.getInfo?.();
      const pacing = pacingForPort(info);
      installPacedSerial()?.set(pacing);
      this.log(
        classifyUsbLink(info) === 'ch340' ? 'warn' : 'info',
        `USB port: ${describeUsbLink(info)}${pacing ? `, writes paced in ${pacing.chunk}-byte chunks` : ', unpaced'}.`,
      );
      if (classifyUsbLink(info) === 'ch340') {
        this.log(
          'warn',
          'Flashing over the CH340 takes several minutes. For ~20 s flashing, reconnect and pick "USB JTAG/serial debug unit" instead.',
        );
      }
      this.session = new EspFlashSession(port, this.logger);

      this.log('info', 'Opening USB Serial port and syncing with ESP32-S3 ROM/Stub bootloader...');
      await this.session.connectAndSync();

      this.setState({ stage: 'inspecting' });
      const device = await this.session.inspectDevice();

      this.log(
        'info',
        `Connected to ${device.chipName} (${device.identity.macColonHex}) | Active slot: ${device.activeSlot} (${device.activeApp.projectName || 'empty'} ${device.activeApp.version || ''})`,
      );
      this.log(
        'info',
        `Slot inventory -> factory: ${device.factoryApp.version || 'n/a'} | ota_0 (WXM): ${device.ota0App.version || 'empty'} | ota_1 (Muse): ${device.ota1App.version || 'empty'}`,
      );

      this.setState({
        stage: 'ready',
        device,
        errorMessage: null,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log('error', `Connection failed: ${msg}`);
      if (this.session) {
        await this.session.disconnectQuietly();
        this.session = null;
      }
      this.setState({
        stage: 'error',
        errorMessage: msg,
      });
    }
  }

  async disconnectDevice(): Promise<void> {
    if (this.session) {
      await this.session.disconnectQuietly();
      this.session = null;
    }
    this.setState({
      stage: 'disconnected',
      device: null,
      progress: null,
      errorMessage: null,
    });
    this.log('info', 'Disconnected from USB Serial device.');
  }

  /**
   * Determines whether the selected firmware target is already installed in its dedicated OTA slot
   * so we can switch slots in a few seconds just by updating `otadata`. The build is matched by its
   * app ELF SHA-256 (Muse builds all report version 999.0.0); installOrSwitchTarget() then checks
   * the whole slot's MD5 on-chip before switching.
   */
  canInstantSwitchTo(targetId: FirmwareTargetId): boolean {
    const { device, manifest } = this.state;
    if (!device || !manifest) return false;
    const entry = manifest.firmwares[targetId];
    if (!entry) return false;

    const isMuse = entry.targetPartition === 'ota_1';
    const slotApp = isMuse ? device.ota1App : device.ota0App;
    if (!slotApp.valid || slotApp.flavor !== (isMuse ? 'muse' : 'weatherxm')) return false;
    // Muse in ota_1 also needs muse_nvs in the partition table.
    if (isMuse && !device.partitionValidation.hasMuseNvs) return false;

    if (entry.appElfSha256 && slotApp.appElfSha256) {
      return slotApp.appElfSha256.toLowerCase() === entry.appElfSha256.toLowerCase();
    }
    return slotApp.version === entry.version;
  }

  /**
   * Installs or instant-switches to the selected target ('muse' in ota_1 or 'weatherxm*' in ota_0).
   */
  async installOrSwitchTarget(
    targetId: FirmwareTargetId,
    options?: { forceFullFlash?: boolean; sdkToken?: string },
  ): Promise<void> {
    const { device, manifest } = this.state;
    const entry: ManifestFirmwareEntry | undefined = manifest?.firmwares[targetId];
    if (!this.session || !device || !manifest || !entry) {
      const msg = !entry && manifest
        ? `Unknown firmware target "${targetId}".`
        : 'Device is not connected or manifest is not loaded.';
      this.log('error', msg);
      this.setState({ stage: 'error', errorMessage: msg });
      return;
    }

    const startTime = Date.now();
    const prevFlavor = device.activeFlavor;
    const prevVersion = device.activeApp.version;
    const targetSlot = entry.targetPartition; // 'ota_1' for Muse, 'ota_0' for WeatherXM
    const targetFlavor: FirmwareFlavor = targetId === 'muse' ? 'muse' : 'weatherxm';
    let instantSwitchPossible = !options?.forceFullFlash && this.canInstantSwitchTo(targetId);
    const sdkToken = (options?.sdkToken ?? getStoredSdkToken()).trim();

    try {
      // Step 1: If target requires dual-boot partition table (Muse), ensure 0xC000 has muse_nvs
      if (entry.requiresDualBootPartitionTable && !device.partitionValidation.hasMuseNvs) {
        this.setState({
          stage: 'flashing',
          progress: {
            stageLabel: 'Upgrading Partition Table (0xC000)',
            subLabel: 'Adding muse_nvs (0xF21000) while preserving all 9 WeatherXM partitions',
            percent: 5,
            bytesWritten: 0,
            bytesTotal: manifest.dualBootPartitionTable.size,
          },
        });
        await this.session.ensureDualBootPartitionTable(
          manifest.dualBootPartitionTable.file,
          manifest.dualBootPartitionTable.sha256,
          device.partitionValidation.hasMuseNvs,
        );
      }

      // Step 2a: An instant switch trusts what is already in the slot, so check all of it
      // on-chip first; a slot whose header survived an interrupted write must not be booted.
      if (instantSwitchPossible && entry.md5) {
        this.setState({
          stage: 'verifying',
          progress: {
            stageLabel: `Checking ${targetSlot} Contents`,
            subLabel: `On-chip MD5 of ${(entry.size / 1024).toFixed(0)} KB at 0x${entry.targetOffset.toString(16)}`,
            percent: 20,
            bytesWritten: 0,
            bytesTotal: entry.size,
          },
        });
        const slotMd5 = await this.session.flashMd5(entry.targetOffset, entry.size);
        if (slotMd5 !== entry.md5.toLowerCase()) {
          this.log(
            'warn',
            `${targetSlot} has ${entry.shortName}'s header but its contents differ (MD5 ${slotMd5} != ${entry.md5}). Re-flashing the slot instead of switching.`,
          );
          instantSwitchPossible = false;
        } else {
          this.log('info', `${targetSlot} MD5 matches ${entry.file} (${slotMd5}).`);
        }
      }

      // Step 2b: Either Instant Slot Switch (a few seconds) or Full OTA Slot Write (~30s)
      if (instantSwitchPossible) {
        this.log(
          'info',
          `${entry.name} (${entry.version}) is already installed in ${targetSlot}. Switching boot slot via otadata...`,
        );
        this.setState({
          stage: 'flashing',
          progress: {
            stageLabel: `Instant Slot Switch -> ${targetSlot}`,
            subLabel: `Activating ${entry.shortName} in ${targetSlot} without re-flashing app binary`,
            percent: 45,
            bytesWritten: 0,
            bytesTotal: OTADATA_SIZE,
          },
        });
      } else {
        this.setState({
          stage: 'flashing',
          progress: {
            stageLabel: `Downloading ${entry.shortName}`,
            subLabel: `Verifying SHA-256 (${entry.sha256.slice(0, 12)}...)`,
            percent: 8,
            bytesWritten: 0,
            bytesTotal: entry.size,
          },
        });

        this.log('info', `Downloading ${entry.file} (${(entry.size / 1024 / 1024).toFixed(2)} MB)...`);
        const res = await fetch(entry.file, { cache: 'no-cache' });
        if (!res.ok) {
          throw new Error(`Failed to download firmware ${entry.file} (HTTP ${res.status})`);
        }
        const fwBytes = new Uint8Array(await res.arrayBuffer());

        const actualSha = await sha256Hex(fwBytes);
        if (actualSha.toLowerCase() !== entry.sha256.toLowerCase()) {
          throw new Error(
            `Firmware SHA-256 mismatch for ${entry.file}: expected ${entry.sha256}, got ${actualSha}`,
          );
        }

        const sigCheck = await verifySignedAppImage(fwBytes, entry.signingKeyDigest);
        if (!sigCheck.valid) {
          throw new Error(`Firmware binary safety check failed:\n${sigCheck.errors.join('\n')}`);
        }

        this.log(
          'info',
          `SHA-256 and RSA-3072 Secure Boot V2 signature verified (key ${sigCheck.signingKeyDigest.slice(0, 12)}…${entry.signingKeyDigest ? ', WG1200 key' : ''}). Writing ${fwBytes.byteLength} bytes to ${targetSlot} (0x${entry.targetOffset.toString(16)})...`,
        );

        await this.session.writeGuardedRegion(
          entry.targetOffset,
          fwBytes,
          (written, total) => {
            const pct = Math.min(82, 12 + Math.round((written / Math.max(1, total)) * 70));
            this.setState({
              stage: 'flashing',
              progress: {
                stageLabel: `Flashing ${entry.shortName} to ${targetSlot} (0x${entry.targetOffset.toString(16)})`,
                subLabel: `${(written / 1024).toFixed(0)} KB / ${(total / 1024).toFixed(0)} KB`,
                percent: pct,
                bytesWritten: written,
                bytesTotal: total,
              },
            });
          },
        );

        // Verify installed header in targetSlot
        this.setState({
          stage: 'verifying',
          progress: {
            stageLabel: `Verifying ${targetSlot} App Descriptor`,
            subLabel: `Reading back 512-byte header at 0x${entry.targetOffset.toString(16)}`,
            percent: 86,
            bytesWritten: entry.size,
            bytesTotal: entry.size,
          },
        });
        const verifyHeader = await this.session.readFlashRange(
          entry.targetOffset,
          APP_HEADER_READ_SIZE,
        );
        const verifyDesc = parseAppDescriptor(verifyHeader);
        if (!verifyDesc.valid) {
          throw new Error(
            `Readback verification failed at ${targetSlot} (0x${entry.targetOffset.toString(16)}): invalid app descriptor.`,
          );
        }
        this.log(
          'info',
          `Verified ${targetSlot}: project="${verifyDesc.projectName}", version="${verifyDesc.version}".`,
        );

        if (entry.md5) {
          this.setState({
            stage: 'verifying',
            progress: {
              stageLabel: `Verifying ${targetSlot} Contents`,
              subLabel: `On-chip MD5 of all ${(entry.size / 1024).toFixed(0)} KB written`,
              percent: 89,
              bytesWritten: entry.size,
              bytesTotal: entry.size,
            },
          });
          const writtenMd5 = await this.session.flashMd5(entry.targetOffset, entry.size);
          if (writtenMd5 !== entry.md5.toLowerCase()) {
            throw new Error(
              `Readback verification failed at ${targetSlot}: flash MD5 ${writtenMd5} != ${entry.md5}. The boot slot was NOT switched.`,
            );
          }
          this.log('info', `Verified all of ${targetSlot} against ${entry.file} (MD5 ${writtenMd5}).`);
        }
      }

      // Step 3: Build and write updated otadata (0x13000) to select targetSlot ('ota_0' or 'ota_1')
      const currentOtadata = await this.session.readFlashRange(OTADATA_OFFSET, OTADATA_SIZE);
      const { bytes: nextOtadata, nextSeq, targetSector } = buildOtadataForSlot(
        currentOtadata,
        targetSlot,
      );

      this.log(
        'info',
        `Updating otadata sector ${targetSector} with ota_seq=${nextSeq} -> boots ${targetSlot} (${entry.shortName})...`,
      );
      this.setState({
        stage: 'verifying',
        progress: {
          stageLabel: `Switching Boot Slot to ${targetSlot}`,
          subLabel: `Writing ota_seq=${nextSeq} to otadata (0x013000)`,
          percent: 92,
          bytesWritten: OTADATA_SIZE,
          bytesTotal: OTADATA_SIZE,
        },
      });

      await this.session.writeGuardedRegion(OTADATA_OFFSET, nextOtadata);

      const verifyOtadata = await this.session.readFlashRange(OTADATA_OFFSET, OTADATA_SIZE);
      const parsedVerifyOta = parseOtadata(verifyOtadata);
      if (parsedVerifyOta.activeSlot !== targetSlot) {
        throw new Error(
          `otadata verification failed: expected activeSlot=${targetSlot}, got ${parsedVerifyOta.activeSlot}`,
        );
      }

      // Step 4: Hard-reset device and monitor serial boot + auto-inject SDK token if Muse
      this.setState({
        stage: 'rebooting',
        progress: {
          stageLabel: `Rebooting into ${entry.shortName}`,
          subLabel:
            targetFlavor === 'muse' && sdkToken
              ? 'Monitoring UART boot & injecting Muse SDK token (>sdk_token=...)'
              : 'Monitoring UART boot output at 115200 baud',
          percent: 96,
          bytesWritten: 1,
          bytesTotal: 1,
        },
      });

      const serialPort = this.session.serialPort;
      await this.session.hardResetAndClose();
      this.session = null;

      const bootResult = await monitorPostBootAndInjectToken({
        port: serialPort,
        expectedFlavor: targetFlavor,
        sdkTokenToInject: targetFlavor === 'muse' && sdkToken ? sdkToken : undefined,
        onLine: (line) => this.log('info', line),
      });

      if (bootResult.downloadMode) {
        this.log(
          'error',
          `The WG1200 restarted into download mode instead of booting ${targetSlot}. Unplug it and plug it back in: ${entry.shortName} is already selected and will boot.`,
        );
      }
      if (bootResult.sdkTokenAcked) {
        this.log('info', 'Muse SDK token (>sdk_token=...) confirmed saved to muse_nvs (@sdk_token ok)!');
      } else if (bootResult.sdkTokenError) {
        this.log(
          'warn',
          `SDK token was not stored (${bootResult.sdkTokenError}). Send it from the provisioner tab once Muse is running.`,
        );
      }
      if (!bootResult.bootConfirmed) {
        this.log(
          'warn',
          'Could not read the boot log after reset, so the boot was not confirmed. Check the WG1200 screen.',
        );
      } else if (bootResult.detectedFlavor !== targetFlavor) {
        this.log(
          'warn',
          `Expected ${targetFlavor} to boot, but the console shows ${bootResult.detectedFlavor}. The bootloader may have rejected ${targetSlot}.`,
        );
      }

      const mode = instantSwitchPossible ? 'instant-switch' : 'full-flash';
      const durationMs = Date.now() - startTime;

      void sendTelemetryEvent({
        eventType: 'flash_success',
        deviceModel: 'wg1200',
        targetFirmware: targetId,
        targetVersion: entry.version,
        previousFirmware: prevFlavor,
        previousVersion: prevVersion,
        mode,
        durationMs,
      });

      // Update snapshot in state so the UI immediately reflects the new active slot
      const updatedDevice = {
        ...device,
        activeSlot: targetSlot,
        activeFlavor: targetFlavor,
        activeApp: {
          ...device.activeApp,
          valid: true,
          version: entry.version,
          projectName: entry.projectName,
          flavor: targetFlavor,
        },
        ota0App:
          targetSlot === 'ota_0'
            ? {
                ...device.ota0App,
                valid: true,
                version: entry.version,
                projectName: entry.projectName,
                appElfSha256: entry.appElfSha256 ?? device.ota0App.appElfSha256,
                flavor: 'weatherxm' as const,
              }
            : device.ota0App,
        ota1App:
          targetSlot === 'ota_1'
            ? {
                ...device.ota1App,
                valid: true,
                version: entry.version,
                projectName: entry.projectName,
                appElfSha256: entry.appElfSha256 ?? device.ota1App.appElfSha256,
                flavor: 'muse' as const,
              }
            : device.ota1App,
        partitionValidation: {
          ...device.partitionValidation,
          hasMuseNvs:
            device.partitionValidation.hasMuseNvs || entry.requiresDualBootPartitionTable,
        },
      };

      this.setState({
        stage: 'complete',
        device: updatedDevice,
        lastCompletedTarget: targetId,
        lastCompletedFlavor: targetFlavor,
        lastOperationMode: mode,
        lastSdkTokenInjected: bootResult.sdkTokenAcked,
        lastBootConfirmed: bootResult.bootConfirmed,
        lastSdkTokenError: bootResult.sdkTokenError,
        lastBootDownloadMode: bootResult.downloadMode,
        progress: {
          stageLabel: `${entry.shortName} Active`,
          subLabel:
            mode === 'instant-switch'
              ? `Switched active boot slot to ${targetSlot} in ${(durationMs / 1000).toFixed(1)}s`
              : `Flashed & verified ${entry.shortName} in ${(durationMs / 1000).toFixed(1)}s`,
          percent: 100,
          bytesWritten: entry.size,
          bytesTotal: entry.size,
        },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log('error', `Operation failed: ${msg}`);
      void sendTelemetryEvent({
        eventType: 'flash_error',
        deviceModel: 'wg1200',
        targetFirmware: targetId,
        targetVersion: entry.version,
        previousFirmware: prevFlavor,
        previousVersion: prevVersion,
        mode: instantSwitchPossible ? 'instant-switch' : 'full-flash',
        durationMs: Date.now() - startTime,
        errorMessage: msg,
      });
      this.setState({
        stage: 'error',
        errorMessage: msg,
      });
    }
  }

  /**
   * Resets `otadata` (`0x13000`) to `0xFF` so the ESP32-S3 bootloader falls back to `factory` (`0x20000`).
   */
  async resetToFactorySlot(): Promise<void> {
    const { device } = this.state;
    if (!this.session || !device) {
      throw new Error('Connect to the WG1200 first.');
    }

    try {
      this.setState({
        stage: 'flashing',
        progress: {
          stageLabel: 'Activating Factory Recovery Slot (0x020000)',
          subLabel: 'Clearing otadata (0x013000) to boot immutable factory WeatherXM image',
          percent: 50,
          bytesWritten: 0,
          bytesTotal: OTADATA_SIZE,
        },
      });

      const blankOta = buildFactoryResetOtadata();
      await this.session.writeGuardedRegion(OTADATA_OFFSET, blankOta);

      const serialPort = this.session.serialPort;
      await this.session.hardResetAndClose();
      this.session = null;

      const bootResult = await monitorPostBootAndInjectToken({
        port: serialPort,
        expectedFlavor: 'weatherxm',
        onLine: (line) => this.log('info', line),
      });
      if (bootResult.downloadMode) {
        this.log(
          'error',
          'The WG1200 restarted into download mode instead of booting factory. Unplug it and plug it back in: factory is already selected and will boot.',
        );
      } else if (!bootResult.bootConfirmed) {
        this.log('warn', 'Could not read the boot log after reset, so the boot was not confirmed.');
      }

      this.setState({
        stage: 'complete',
        lastCompletedTarget: 'weatherxm',
        lastCompletedFlavor: 'weatherxm',
        lastOperationMode: 'factory-reset',
        lastSdkTokenInjected: false,
        lastBootConfirmed: bootResult.bootConfirmed,
        lastSdkTokenError: null,
        lastBootDownloadMode: bootResult.downloadMode,
        progress: {
          stageLabel: 'Factory WeatherXM Slot Active',
          subLabel: 'Booted into factory recovery slot (0x020000)',
          percent: 100,
          bytesWritten: OTADATA_SIZE,
          bytesTotal: OTADATA_SIZE,
        },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log('error', `Factory slot reset failed: ${msg}`);
      this.setState({ stage: 'error', errorMessage: msg });
    }
  }

  /**
   * Exports a diagnostic ZIP containing partition-table.bin, otadata.bin, app descriptors, and device metadata.
   */
  async exportBackupZip(): Promise<Blob> {
    const { device } = this.state;
    if (!this.session || !device) {
      throw new Error('Connect to the WG1200 before exporting a backup.');
    }

    this.log('info', 'Reading partition table, otadata, and slot headers for backup archive...');
    // One command at a time: esptool commands over one transport can't overlap.
    const ptBytes = await this.session.readFlashRange(PARTITION_TABLE_OFFSET, PARTITION_TABLE_READ_SIZE);
    const otadataBytes = await this.session.readFlashRange(OTADATA_OFFSET, OTADATA_SIZE);
    const factoryHdr = await this.session.readFlashRange(FACTORY_OFFSET, APP_HEADER_READ_SIZE);
    const ota0Hdr = await this.session.readFlashRange(OTA_0_OFFSET, APP_HEADER_READ_SIZE);
    const ota1Hdr = await this.session.readFlashRange(OTA_1_OFFSET, APP_HEADER_READ_SIZE);

    const zip = new JSZip();
    zip.file('partition-table-0xC000.bin', ptBytes);
    zip.file('otadata-0x13000.bin', otadataBytes);
    zip.file('factory-header-0x20000.bin', factoryHdr);
    zip.file('ota0-header-0x420000.bin', ota0Hdr);
    zip.file('ota1-header-0x820000.bin', ota1Hdr);
    zip.file(
      'device-summary.json',
      JSON.stringify(
        {
          exportedAt: new Date().toISOString(),
          chipName: device.chipName,
          flashSizeBytes: device.flashSizeBytes,
          identity: device.identity,
          activeSlot: device.activeSlot,
          hasMuseNvs: device.partitionValidation.hasMuseNvs,
          factoryApp: device.factoryApp,
          ota0App: device.ota0App,
          ota1App: device.ota1App,
          otadata: device.otadata,
        },
        null,
        2,
      ),
    );

    this.log('info', 'Backup archive generated.');
    return zip.generateAsync({ type: 'blob' });
  }
}
