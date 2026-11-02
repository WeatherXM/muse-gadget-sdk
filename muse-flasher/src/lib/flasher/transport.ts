import * as esptoolPkg from 'esptool-js';
const { ESPLoader, Transport, getStubJsonByChipName } = esptoolPkg;
type EspLoaderInstance = InstanceType<typeof ESPLoader>;
type TransportInstance = InstanceType<typeof Transport>;
const ESPError: typeof Error = (esptoolPkg as any).ESPError ?? Error;
import {
  APP_HEADER_READ_SIZE,
  EXPECTED_CHIP_NAME,
  EXPECTED_FLASH_SIZE_BYTES,
  FACTORY_OFFSET,
  classifyUsbLink,
  FLASH_BAUD_RATE,
  FLASH_BAUD_RATE_CH340,
  OTADATA_OFFSET,
  OTADATA_SIZE,
  OTA_0_OFFSET,
  OTA_1_OFFSET,
  PARTITION_TABLE_OFFSET,
  PARTITION_TABLE_READ_SIZE,
} from './constants';
import { parseAppDescriptor } from './appDescriptor';
import { deriveDeviceIdentity } from './identity';
import { parseOtadata } from './otadata';
import { validateDualBootPartitionTableBinary, validatePartitionTable } from './partitions';
import { sha256Hex } from './hashing';
import { CH340_USB_VENDOR_ID } from './pacedSerial';
import { assertWriteAllowed, type WriteGuardOptions } from './writeGuard';
import type { DeviceInspectionSnapshot } from './state';

let isTransportPatched = false;

/**
 * Monkey-patches esptool-js Transport.prototype.read to enforce RFC 1055 SLIP framing tolerance.
 * Standard esptool-js throws "Invalid head of packet (0x...)" if the very first byte received is not 0xC0 (SLIP_END).
 * On ESP32-S3 boards (especially over WCH CH340 or when entering flasher stub), UART transitions / baud glitches
 * can produce a transient glitch byte like 0xfc or 0x00 before the SLIP frame starts.
 * This patch discards leading line noise bytes before SLIP_END (0xC0), matching esptool.py behavior.
 */
export function patchTransportRead(): void {
  if (isTransportPatched) return;
  isTransportPatched = true;

  (Transport.prototype as any).read = async function (timeout: number) {
    let partialPacket: Uint8Array | null = null;
    let isEscaping = false;
    let readBytes: Uint8Array | null = null;
    let leadingNoiseCount = 0;
    const MAX_LEADING_NOISE = 2048;

    while (true) {
      const timeStamp = Date.now();
      readBytes = new Uint8Array(0);

      while (Date.now() - timeStamp < timeout) {
        if (this.buffer.length > 0) {
          readBytes = this.buffer;
          this.buffer = new Uint8Array(0);
          break;
        } else {
          await new Promise((r) => setTimeout(r, 1));
        }
      }

      if (!readBytes || readBytes.length === 0) {
        const msg =
          partialPacket === null
            ? 'Serial data stream stopped: Possible serial noise or corruption.'
            : 'No serial data received.';
        if (this.tracing) {
          this.trace(msg);
        }
        throw new ESPError(msg);
      }

      if (this.tracing) {
        this.trace(`Read ${readBytes.length} bytes: ${this.hexConvert(readBytes)}`);
      }

      for (let i = 0; i < readBytes.length; i++) {
        const byte = readBytes[i];
        if (partialPacket === null) {
          if (byte === this.SLIP_END) {
            partialPacket = new Uint8Array(0);
            leadingNoiseCount = 0;
          } else {
            leadingNoiseCount++;
            if (leadingNoiseCount > MAX_LEADING_NOISE) {
              const remainingData = this.buffer;
              this.detectPanicHandler(new Uint8Array([...readBytes, ...(remainingData || [])]));
              throw new ESPError(
                `Invalid head of packet (0x${byte.toString(16)}): Possible serial noise or corruption.`,
              );
            }
          }
        } else if (isEscaping) {
          isEscaping = false;
          if (byte === this.SLIP_ESC_END) {
            partialPacket = this.appendArray(partialPacket, new Uint8Array([this.SLIP_END]));
          } else if (byte === this.SLIP_ESC_ESC) {
            partialPacket = this.appendArray(partialPacket, new Uint8Array([this.SLIP_ESC]));
          } else {
            if (this.tracing) {
              this.trace(`Read invalid data: ${this.hexConvert(readBytes)}`);
            }
            const remainingData = this.buffer;
            this.detectPanicHandler(new Uint8Array([...readBytes, ...(remainingData || [])]));
            throw new ESPError(`Invalid SLIP escape (0xdb, 0x${byte.toString(16)})`);
          }
        } else if (byte === this.SLIP_ESC) {
          isEscaping = true;
        } else if (byte === this.SLIP_END) {
          if (this.tracing) {
            this.trace(`Received full packet: ${this.hexConvert(partialPacket)}`);
          }
          if (i + 1 < readBytes.length) {
            const remainingBytes = readBytes.slice(i + 1);
            this.buffer = this.appendArray(remainingBytes, this.buffer);
          }
          return partialPacket;
        } else {
          partialPacket = this.appendArray(partialPacket, new Uint8Array([byte]));
        }
      }
    }
  };
}

patchTransportRead();

// ESP32-S3 registers, as esptool.py's targets/esp32s3.py uses them.
// UARTDEV_BUF_NO says which port the ROM loader talks on: 3 is USB-OTG and 4 is
// USB-JTAG/Serial. esptool-js 0.7's usesUsbJtagSerial() compares with 3, so on
// the WG1200's native port it answers false and its USB-JTAG handling is skipped.
export const S3_UARTDEV_BUF_NO = 0x3fcef14c;
export const S3_UARTDEV_BUF_NO_USB_JTAG_SERIAL = 4;
// Set when the loader was entered over USB; if it's still set at reset, the chip
// boots straight back into download mode (arduino-esp32#6762).
export const S3_RTC_CNTL_OPTION1_REG = 0x6000812c;
export const S3_RTC_CNTL_FORCE_DOWNLOAD_BOOT_MASK = 0x1;

async function s3UsesUsbJtagSerial(loader: { readReg(addr: number): Promise<number> }): Promise<boolean> {
  return ((await loader.readReg(S3_UARTDEV_BUF_NO)) & 0xff) === S3_UARTDEV_BUF_NO_USB_JTAG_SERIAL;
}

let isEsploaderPatched = false;

/**
 * Monkey-patches esptool-js ESPLoader.prototype.runStub to resolve a silicon bug in the ESP32-S3 ROM bootloader.
 * When Hardware Secure Boot is enabled on ESP32-S3 (eFuse bit 20 in 0x60007038 is set), the ROM's standard
 * download command `MEM_END` (`memFinish(entry)`) fails to branch to RAM execution, causing the stub handshake
 * ("OHAI") to time out with "Serial data stream stopped: Possible serial noise or corruption."
 *
 * Following Espressif's official Python esptool workaround (loader.py:1353-1384):
 * 1. Leave RAM download mode with entrypoint 0: `memFinish(0)`
 * 2. Hijack the ROM SPI flash legacy read pointer table at 0x3FCEF688 (`rom_spiflash_legacy_funcs.read`)
 * 3. Write `stubFlasher.entry` to 0x3FCEF688
 * 4. Trigger `READ_FLASH_SLOW` command (0x0E), forcing the ROM to execute the stub in RAM
 * 5. Read the stub's "OHAI" response packet
 * 6. Restore the original function pointer at 0x3FCEF688
 */
export function patchEsploaderRunStub(): void {
  if (isEsploaderPatched) return;
  isEsploaderPatched = true;

  const originalRunStub = (ESPLoader.prototype as any).runStub;

  (ESPLoader.prototype as any).runStub = async function (this: any) {
    if (this.syncStubDetected || this.IS_STUB) {
      this.info('Stub is already running. No upload is necessary.');
      this.IS_STUB = true;
      await this.applyUsbFlashWriteSize();
      return this.chip;
    }
    if (this.secureDownloadMode) {
      this.info('Stub flasher is not supported in Secure Download Mode, it has been disabled.');
      return this.chip;
    }

    const isEsp32S3 = this.chip?.CHIP_NAME === 'ESP32-S3';
    let isSecureBootEnabled = false;

    if (isEsp32S3) {
      try {
        const EFUSE_BASE = 0x60007000;
        const EFUSE_SECURE_BOOT_EN_REG = EFUSE_BASE + 0x038;
        const EFUSE_SECURE_BOOT_EN_MASK = 1 << 20;
        const regVal = await this.readReg(EFUSE_SECURE_BOOT_EN_REG);
        isSecureBootEnabled = (regVal & EFUSE_SECURE_BOOT_EN_MASK) !== 0;
      } catch (e: any) {
        this.debug?.(`Could not read secure boot eFuse: ${e?.message ?? e}`);
      }

      // If USB-JTAG/Serial peripheral is in use, disable RTC and SWD watchdogs
      try {
        if (await s3UsesUsbJtagSerial(this)) {
          const RTCCNTL_BASE_REG = 0x60008000;
          const RTC_CNTL_WDTCONFIG0_REG = RTCCNTL_BASE_REG + 0x0098;
          const RTC_CNTL_WDTWPROTECT_REG = RTCCNTL_BASE_REG + 0x00b0;
          const RTC_CNTL_WDT_WKEY = 0x50d83aa1;
          const RTC_CNTL_SWD_CONF_REG = RTCCNTL_BASE_REG + 0x00b4;
          const RTC_CNTL_SWD_AUTO_FEED_EN = 1 << 31;
          const RTC_CNTL_SWD_WPROTECT_REG = RTCCNTL_BASE_REG + 0x00b8;
          const RTC_CNTL_SWD_WKEY = 0x8f1d312a;

          await this.writeReg(RTC_CNTL_WDTWPROTECT_REG, RTC_CNTL_WDT_WKEY);
          await this.writeReg(RTC_CNTL_WDTCONFIG0_REG, 0);
          await this.writeReg(RTC_CNTL_WDTWPROTECT_REG, 0);

          await this.writeReg(RTC_CNTL_SWD_WPROTECT_REG, RTC_CNTL_SWD_WKEY);
          const swdConf = await this.readReg(RTC_CNTL_SWD_CONF_REG);
          await this.writeReg(RTC_CNTL_SWD_CONF_REG, swdConf | RTC_CNTL_SWD_AUTO_FEED_EN);
          await this.writeReg(RTC_CNTL_SWD_WPROTECT_REG, 0);
        }
      } catch (e: any) {
        this.debug?.(`Could not disable watchdogs: ${e?.message ?? e}`);
      }
    }

    if (!isEsp32S3 || !isSecureBootEnabled) {
      return await originalRunStub.call(this);
    }

    this.info('ESP32-S3 Secure Boot detected: applying ROM stub execution workaround...');

    const chipRevision = this.chip.getChipRevision
      ? await this.chip.getChipRevision(this)
      : undefined;
    const stubFlasher = await getStubJsonByChipName(this.chip.CHIP_NAME, chipRevision);
    if (stubFlasher === undefined) {
      this.info(
        `Stub flasher is not yet supported on ${this.chip.CHIP_NAME}, it has been disabled.`,
      );
      return this.chip;
    }

    this.info('Uploading stub...');
    const stub = [stubFlasher.decodedText, stubFlasher.decodedData];
    for (let i = 0; i < stub.length; i++) {
      if (stub[i]) {
        const offs = i === 0 ? stubFlasher.text_start : stubFlasher.data_start;
        const length = stub[i].length;
        const blocks = Math.floor((length + this.ESP_RAM_BLOCK - 1) / this.ESP_RAM_BLOCK);
        await this.memBegin(length, blocks, this.ESP_RAM_BLOCK, offs);
        for (let seq = 0; seq < blocks; seq++) {
          const fromOffs = seq * this.ESP_RAM_BLOCK;
          const toOffs = fromOffs + this.ESP_RAM_BLOCK;
          await this.memBlock(stub[i].slice(fromOffs, toOffs), seq);
        }
      }
    }

    this.info('Running stub...');
    const ROM_SPIFLASH_LEGACY_FUNCS_READ_PTR = 0x3fcef688;
    const ESP_READ_FLASH_SLOW = 0x0e;

    try {
      await this.memFinish(0);
    } catch (e: any) {
      this.debug?.(`memFinish(0) ignored error (matching esptool.py): ${e?.message ?? e}`);
    }

    const storedReadPointer = await this.readReg(ROM_SPIFLASH_LEGACY_FUNCS_READ_PTR);
    await this.writeReg(ROM_SPIFLASH_LEGACY_FUNCS_READ_PTR, stubFlasher.entry);
    await this.command(ESP_READ_FLASH_SLOW, new Uint8Array(8), 0, false);

    const packetResult = await this.transport.read(this.DEFAULT_TIMEOUT);
    const packetStr = String.fromCharCode(...packetResult);
    if (packetStr !== 'OHAI') {
      throw new ESPError(`Failed to start stub. Unexpected response ${packetStr}`);
    }

    try {
      await this.writeReg(ROM_SPIFLASH_LEGACY_FUNCS_READ_PTR, storedReadPointer);
    } catch (e: any) {
      this.debug?.(`Could not restore ROM spiflash pointer: ${e?.message ?? e}`);
    }

    this.info('Stub running...');
    this.IS_STUB = true;
    await this.applyUsbFlashWriteSize();
    return this.chip;
  };
}

patchEsploaderRunStub();

// esptool-js waits up to 100 s for each READ_FLASH packet, so a gateway that
// stops answering stalls the page for minutes. A 4 KB packet needs about
// 0.4 s even at 115200 baud, so 3 s is plenty. Its stub also follows the data
// with a 16-byte MD5 of it, which esptool.py reads and esptool-js 0.7 leaves in
// the stream; read it too, so it can't be taken for the next command's reply.
const READ_FLASH_PACKET_TIMEOUT_MS = 3000;
const READ_FLASH_DIGEST_TIMEOUT_MS = 2000;
let isReadFlashPatched = false;

export function patchEsploaderReadFlash(): void {
  if (isReadFlashPatched) return;
  isReadFlashPatched = true;

  (ESPLoader.prototype as any).readFlash = async function (
    this: any,
    addr: number,
    size: number,
    onPacketReceived: ((packet: Uint8Array, progress: number, total: number) => void) | null = null,
  ): Promise<Uint8Array> {
    let pkt = this._appendArray(this._intToByteArray(addr), this._intToByteArray(size));
    pkt = this._appendArray(pkt, this._intToByteArray(0x1000));
    // Unacked bytes the stub may send: 64, as esptool.py uses (esptool-js asks
    // for 1024). Both are below one 4 KB block, so it sends one block per ack.
    pkt = this._appendArray(pkt, this._intToByteArray(64));
    const res = await this.checkCommand('read flash', this.ESP_READ_FLASH, pkt);
    if (res != 0) {
      throw new ESPError('Failed to read memory: ' + res);
    }
    let resp = new Uint8Array(0);
    while (resp.length < size) {
      const packet: Uint8Array = await this.transport.read(READ_FLASH_PACKET_TIMEOUT_MS);
      if (packet.length > 0) {
        resp = this._appendArray(resp, packet);
        await this.transport.write(this._intToByteArray(resp.length));
        onPacketReceived?.(packet, resp.length, size);
      }
    }
    if (this.IS_STUB) {
      try {
        await this.transport.read(READ_FLASH_DIGEST_TIMEOUT_MS);
      } catch {
        // No digest: the next command's flushInput copes with stray bytes.
      }
    }
    return resp;
  };
}

patchEsploaderReadFlash();

export interface LoggerCallbacks {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
}

export class EspFlashSession {
  private port: SerialPort;
  private transport: TransportInstance | null = null;
  private loader: EspLoaderInstance | null = null;
  private logger: LoggerCallbacks;

  constructor(port: SerialPort, logger: LoggerCallbacks) {
    this.port = port;
    this.logger = logger;
  }

  get serialPort(): SerialPort {
    return this.port;
  }

  /** The WG1200's CH340 UART bridge, as opposed to the S3's native USB-JTAG port. */
  get isCh340Bridge(): boolean {
    return this.port.getInfo?.().usbVendorId === CH340_USB_VENDOR_ID;
  }

  async connectAndSync(): Promise<void> {
    this.transport = new Transport(this.port, false);
    // Say so at once when the gateway drops off USB (it reset, or the cable
    // moved), instead of leaving the next read to time out.
    (this.transport as any).setDeviceLostCallback?.(() => {
      this.logger.warn('The WG1200 dropped off USB mid-operation (it reset or was unplugged).');
    });
    const terminal = {
      clean: () => {},
      writeLine: (data: string) => {
        const trimmed = data.trim();
        if (trimmed) this.logger.info(`[esptool] ${trimmed}`);
      },
      write: (data: string) => {
        const trimmed = data.trim();
        if (trimmed && trimmed.length > 2) this.logger.info(`[esptool] ${trimmed}`);
      },
    };

    // The CH340 bridge drops bytes without pacing; keep it at the baud rate the
    // static web flasher proved with pacing. Native USB-JTAG ignores the rate.
    const baudrate = this.isCh340Bridge ? FLASH_BAUD_RATE_CH340 : FLASH_BAUD_RATE;
    if (this.isCh340Bridge) {
      this.logger.info(
        `CH340 USB-UART bridge detected: flashing at ${baudrate} baud with paced writes (the "USB JTAG/serial debug unit" port is faster).`,
      );
    }

    this.loader = new ESPLoader({
      transport: this.transport,
      baudrate,
      romBaudrate: 115200,
      terminal,
      debugLogging: false,
    });

    await this.loader.main();
  }

  private ensureLoader(): EspLoaderInstance {
    if (!this.loader) {
      throw new Error('ESPLoader session is not connected.');
    }
    return this.loader;
  }

  async inspectDevice(): Promise<DeviceInspectionSnapshot> {
    const loader = this.ensureLoader();
    const chipName: string = (loader as any).chip?.CHIP_NAME ?? 'Unknown';

    if (!chipName.toUpperCase().includes(EXPECTED_CHIP_NAME)) {
      throw new Error(
        `Unsupported chip "${chipName}". This flasher is exclusively for the WeatherXM WG1200 (${EXPECTED_CHIP_NAME}).`,
      );
    }

    let flashSizeBytes = 0;
    try {
      const rawSize: unknown =
        typeof (loader as any).detectFlashSize === 'function'
          ? await (loader as any).detectFlashSize()
          : await (loader as any).getFlashSize();
      if (typeof rawSize === 'string') {
        const mbMatch = rawSize.match(/^(\d+)\s*MB$/i);
        const kbMatch = rawSize.match(/^(\d+)\s*KB$/i);
        if (mbMatch) {
          flashSizeBytes = parseInt(mbMatch[1], 10) * 1024 * 1024;
        } else if (kbMatch) {
          flashSizeBytes = parseInt(kbMatch[1], 10) * 1024;
        }
      } else if (typeof rawSize === 'number') {
        flashSizeBytes = rawSize <= 65536 ? rawSize * 1024 : rawSize;
      }
    } catch (e: any) {
      this.logger.warn(`Flash size detection warning: ${e?.message ?? e}`);
    }

    if (flashSizeBytes < EXPECTED_FLASH_SIZE_BYTES) {
      throw new Error(
        `Unexpected flash size (${flashSizeBytes} bytes). Expected 16 MB (${EXPECTED_FLASH_SIZE_BYTES} bytes) on WG1200.`,
      );
    }

    const macStr: string = await (loader as any).chip.readMac(loader);
    const macBytes = macStr
      .split(':')
      .map((part: string) => parseInt(part, 16))
      .filter((n: number) => !Number.isNaN(n));
    const identity = deriveDeviceIdentity(macBytes);

    this.logger.info(`Reading partition table at 0x${PARTITION_TABLE_OFFSET.toString(16)}...`);
    const ptBytes = await this.readFlashRange(PARTITION_TABLE_OFFSET, PARTITION_TABLE_READ_SIZE);
    const partitionValidation = validatePartitionTable(ptBytes);
    if (!partitionValidation.valid) {
      throw new Error(
        `WG1200 partition layout verification failed:\n${partitionValidation.errors.join('\n')}`,
      );
    }

    this.logger.info(
      partitionValidation.hasMuseNvs
        ? 'Dual-boot partition table detected (muse_nvs @ 0xF21000 present).'
        : 'Stock WG1200 partition table detected (muse_nvs @ 0xF21000 will be added automatically when installing Muse).',
    );

    this.logger.info(`Reading otadata at 0x${OTADATA_OFFSET.toString(16)}...`);
    const otadataRaw = await this.readFlashRange(OTADATA_OFFSET, OTADATA_SIZE);
    const otadata = parseOtadata(otadataRaw);

    this.logger.info('Inspecting app descriptors in factory, ota_0, and ota_1...');
    const factoryHeader = await this.readFlashRange(FACTORY_OFFSET, APP_HEADER_READ_SIZE);
    const ota0Header = await this.readFlashRange(OTA_0_OFFSET, APP_HEADER_READ_SIZE);
    const ota1Header = await this.readFlashRange(OTA_1_OFFSET, APP_HEADER_READ_SIZE);

    const factoryApp = parseAppDescriptor(factoryHeader);
    const ota0App = parseAppDescriptor(ota0Header);
    const ota1App = parseAppDescriptor(ota1Header);

    let activeSlot = otadata.activeSlot;
    let activeApp =
      activeSlot === 'ota_1'
        ? ota1App
        : activeSlot === 'ota_0'
          ? ota0App
          : factoryApp;

    if (!activeApp.valid && factoryApp.valid) {
      activeSlot = 'factory';
      activeApp = factoryApp;
    }

    return {
      chipName,
      flashSizeBytes,
      usbLink: classifyUsbLink(this.port.getInfo?.()),
      identity,
      partitionValidation,
      otadata,
      otadataRaw,
      factoryApp,
      ota0App,
      ota1App,
      activeSlot,
      activeApp,
      activeFlavor: activeApp.flavor,
    };
  }

  /**
   * Resets the chip back into its ROM loader and starts the stub again. A
   * stub that answered a READ_FLASH but never sent the data stops answering
   * everything after it (seen over the native USB-JTAG port), so retrying on
   * the same session can't help; a fresh one can.
   */
  private async resync(): Promise<void> {
    this.logger.warn('The gateway stopped answering; resetting it into its bootloader to recover...');
    await this.disconnectQuietly();
    await new Promise((r) => setTimeout(r, 300));
    await this.connectAndSync();
  }

  private async readChunkWithRetry(offset: number, size: number): Promise<Uint8Array> {
    try {
      return await this.ensureLoader().readFlash(offset, size);
    } catch (err) {
      this.logger.warn(
        `Reading 0x${offset.toString(16)} (${size} bytes) stalled: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    await this.resync();
    try {
      return await this.ensureLoader().readFlash(offset, size);
    } catch (err) {
      throw new Error(
        `Reading flash at 0x${offset.toString(16)} failed twice, also after resetting the gateway ` +
          `(${err instanceof Error ? err.message : String(err)}). Unplug the WG1200, plug it back in and connect again.`,
      );
    }
  }

  async readFlashRange(
    offset: number,
    length: number,
    onProgress?: (bytesRead: number, totalBytes: number) => void,
  ): Promise<Uint8Array> {
    if (length <= 4096) {
      const data = await this.readChunkWithRetry(offset, length);
      onProgress?.(length, length);
      return data;
    }

    // For large reads (e.g. 16 MB backup), use 64 KB chunks; for medium reads (e.g. 8 KB otadata), use 4 KB chunks
    const chunkSize = length >= 65536 ? 65536 : 4096;
    const fullBuffer = new Uint8Array(length);
    let bytesRead = 0;

    while (bytesRead < length) {
      const currentChunkSize = Math.min(chunkSize, length - bytesRead);
      const chunkData = await this.readChunkWithRetry(offset + bytesRead, currentChunkSize);
      fullBuffer.set(chunkData, bytesRead);
      bytesRead += currentChunkSize;
      onProgress?.(bytesRead, length);
      if (bytesRead < length && chunkSize <= 4096) {
        await new Promise((r) => setTimeout(r, 25));
      }
    }

    return fullBuffer;
  }

  async writeGuardedRegion(
    offset: number,
    bytes: Uint8Array,
    onProgress?: (written: number, total: number) => void,
    guardOptions?: WriteGuardOptions,
  ): Promise<void> {
    assertWriteAllowed(offset, bytes.byteLength, guardOptions);
    const loader = this.ensureLoader();

    // 'keep' everywhere: a signed image must reach flash byte for byte, or
    // Secure Boot rejects it (esptool only rewrites headers at 0x0 anyway).
    await (loader as any).writeFlash({
      fileArray: [{ data: bytes, address: offset }],
      flashSize: 'keep',
      flashMode: 'keep',
      flashFreq: 'keep',
      eraseAll: false,
      compress: true,
      reportProgress: (_fileIndex: number, written: number, total: number) => {
        onProgress?.(written, total);
      },
    });
  }

  /** MD5 of a flash range, computed on-chip by the stub (seconds for a 4 MB slot). */
  async flashMd5(offset: number, size: number): Promise<string> {
    const loader = this.ensureLoader();
    const md5: string = await (loader as any).flashMd5sum(offset, size);
    return md5.toLowerCase();
  }

  async ensureDualBootPartitionTable(
    ptUrl: string,
    expectedSha256: string,
    currentlyHasMuseNvs: boolean,
  ): Promise<boolean> {
    if (currentlyHasMuseNvs) {
      this.logger.info('Dual-boot partition table (muse_nvs @ 0xF21000) is already installed.');
      return false;
    }

    this.logger.info('Downloading verified dual-boot partition table (partition-table.bin)...');
    const res = await fetch(ptUrl, { cache: 'no-cache' });
    if (!res.ok) {
      throw new Error(`Failed to download ${ptUrl} (HTTP ${res.status})`);
    }
    const ptBytes = new Uint8Array(await res.arrayBuffer());
    const actualSha = await sha256Hex(ptBytes);
    if (actualSha.toLowerCase() !== expectedSha256.toLowerCase()) {
      throw new Error(
        `Partition table SHA-256 mismatch: expected ${expectedSha256}, got ${actualSha}`,
      );
    }

    const check = validateDualBootPartitionTableBinary(ptBytes);
    if (!check.valid) {
      throw new Error(
        `Dual-boot partition table failed safety validation: ${check.errors.join('; ')}`,
      );
    }

    this.logger.info(
      'Upgrading partition table at 0xC000 to add muse_nvs (0xF21000, 64 KB) while preserving all 9 WeatherXM partitions...',
    );
    await this.writeGuardedRegion(PARTITION_TABLE_OFFSET, ptBytes, undefined, {
      allowVerifiedDualBootPartitionTable: true,
    });

    const readback = await this.readFlashRange(PARTITION_TABLE_OFFSET, PARTITION_TABLE_READ_SIZE);
    const readbackSha = await sha256Hex(readback);
    if (readbackSha.toLowerCase() !== expectedSha256.toLowerCase()) {
      throw new Error('Partition table readback SHA-256 verification failed after write!');
    }

    this.logger.info('Dual-boot partition table verified at 0xC000.');
    return true;
  }

  async hardReset(): Promise<void> {
    const transportObj = this.transport as any;
    const device = transportObj?.device ?? this.port;

    if (!transportObj && !device) {
      return;
    }

    // As esptool.py's ESP32-S3 hard_reset(): clear "force download boot" first, or
    // a chip that entered the loader over native USB reboots into download mode
    // (a black, unresponsive screen) instead of the slot otadata selects.
    if (this.loader && (this.loader as any).chip?.CHIP_NAME === 'ESP32-S3') {
      try {
        await this.loader.writeReg(S3_RTC_CNTL_OPTION1_REG, 0, S3_RTC_CNTL_FORCE_DOWNLOAD_BOOT_MASK);
      } catch (e) {
        this.logger.warn(`Could not clear force-download boot: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    try {
      if (transportObj && transportObj._DTR_state !== undefined) {
        transportObj._DTR_state = false;
      }

      if (typeof transportObj?.setSignals === 'function') {
        await transportObj.setSignals(false, false);
      } else if (typeof device?.setSignals === 'function') {
        await device.setSignals({ dataTerminalReady: false, requestToSend: false });
      }
      await new Promise((r) => setTimeout(r, 50));

      if (typeof transportObj?.setSignals === 'function') {
        await transportObj.setSignals(false, true);
      } else if (typeof device?.setSignals === 'function') {
        await device.setSignals({ dataTerminalReady: false, requestToSend: true });
      } else if (this.transport) {
        await this.transport.setRTS(true);
      }
      await new Promise((r) => setTimeout(r, 120));

      if (typeof transportObj?.setSignals === 'function') {
        await transportObj.setSignals(false, false);
      } else if (typeof device?.setSignals === 'function') {
        await device.setSignals({ dataTerminalReady: false, requestToSend: false });
      } else if (this.transport) {
        await this.transport.setRTS(false);
      }
      await new Promise((r) => setTimeout(r, 150));
    } catch (e) {
      this.logger.warn(`Hard reset signal warning: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  async hardResetAndClose(): Promise<void> {
    await this.hardReset();
    if (this.transport) {
      try {
        await this.transport.disconnect();
      } catch {
        // ignore
      }
    }
    this.loader = null;
    this.transport = null;
  }

  async disconnectQuietly(): Promise<void> {
    if (this.transport) {
      try {
        await this.transport.disconnect();
      } catch {
        // ignore
      }
    }
    this.loader = null;
    this.transport = null;
  }
}
