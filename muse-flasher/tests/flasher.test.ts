import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseAppDescriptor } from '../src/lib/flasher/appDescriptor';
import {
  FACTORY_OFFSET,
  OTADATA_OFFSET,
  OTADATA_SIZE,
  OTA_0_OFFSET,
  OTA_1_OFFSET,
  PARTITION_TABLE_OFFSET,
  PARTITION_TABLE_READ_SIZE,
} from '../src/lib/flasher/constants';
import {
  buildFactoryResetOtadata,
  buildOtadataForSlot,
  computeEspOtaCrc32,
  parseOtadata,
} from '../src/lib/flasher/otadata';
import {
  validateDualBootPartitionTableBinary,
  validatePartitionTable,
} from '../src/lib/flasher/partitions';
import {
  assertWriteAllowed,
  verifySignedAppBinary,
} from '../src/lib/flasher/writeGuard';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(__dirname, '..', 'public');

describe('WG1200 Dual-Boot Flasher Core', () => {
  it('parses real signed Muse Gadget OS binary header and verifies Secure Boot V2 signature', () => {
    const musePath = path.join(publicDir, 'firmware', 'muse', 'muse-gadget.bin');
    const museBytes = new Uint8Array(fs.readFileSync(musePath));

    const desc = parseAppDescriptor(museBytes.subarray(0, 512));
    expect(desc.valid).toBe(true);
    expect(desc.flavor).toBe('muse');
    expect(desc.projectName).toBe('muse-gadget');
    expect(desc.version).toBe('999.0.0');

    const sigCheck = verifySignedAppBinary(museBytes);
    expect(sigCheck.valid).toBe(true);
    expect(sigCheck.errors).toEqual([]);
  });

  it('parses real signed WeatherXM v0.8.39 binary header and verifies Secure Boot V2 signature', () => {
    const wxmPath = path.join(
      publicDir,
      'firmware',
      'weatherxm',
      'fw_release_0.8.39-g80c3a1c-signed.bin',
    );
    const wxmBytes = new Uint8Array(fs.readFileSync(wxmPath));

    const desc = parseAppDescriptor(wxmBytes.subarray(0, 512));
    expect(desc.valid).toBe(true);
    expect(desc.flavor).toBe('weatherxm');
    expect(desc.version).toContain('0.8.39');

    const sigCheck = verifySignedAppBinary(wxmBytes);
    expect(sigCheck.valid).toBe(true);
  });

  it('validates the dual-boot partition-table.bin (9 stock WG1200 partitions + muse_nvs @ 0xF21000)', () => {
    const ptPath = path.join(publicDir, 'firmware', 'muse', 'partition-table.bin');
    const ptBytes = new Uint8Array(fs.readFileSync(ptPath));

    const res = validatePartitionTable(ptBytes);
    expect(res.valid).toBe(true);
    expect(res.hasMuseNvs).toBe(true);

    const dualCheck = validateDualBootPartitionTableBinary(ptBytes);
    expect(dualCheck.valid).toBe(true);
  });

  it('validates real otadata_ota1.bin and switches cleanly between ota_1 (Muse) and ota_0 (WeatherXM)', () => {
    const ota1BinPath = path.join(publicDir, 'firmware', 'muse', 'otadata_ota1.bin');
    const ota1Bytes = new Uint8Array(fs.readFileSync(ota1BinPath));

    // Verify CRC matches ESP-IDF esp_rom_crc32_le(0xffffffff, seq=2) -> 0x55f63774
    expect(computeEspOtaCrc32(2)).toBe(0x55f63774);

    const parsedInitial = parseOtadata(ota1Bytes);
    expect(parsedInitial.activeSlot).toBe('ota_1');
    expect(parsedInitial.activeSeq).toBe(2);

    // Switch from ota_1 (Muse) -> ota_0 (WeatherXM)
    const switchToWxm = buildOtadataForSlot(ota1Bytes, 'ota_0');
    expect(switchToWxm.nextSeq).toBe(3); // (3 - 1) % 2 === 0 -> ota_0
    const parsedWxm = parseOtadata(switchToWxm.bytes);
    expect(parsedWxm.activeSlot).toBe('ota_0');
    expect(parsedWxm.activeSeq).toBe(3);

    // Switch back from ota_0 (WeatherXM) -> ota_1 (Muse)
    const switchToMuse = buildOtadataForSlot(switchToWxm.bytes, 'ota_1');
    expect(switchToMuse.nextSeq).toBe(4); // (4 - 1) % 2 === 1 -> ota_1
    const parsedMuse = parseOtadata(switchToMuse.bytes);
    expect(parsedMuse.activeSlot).toBe('ota_1');
    expect(parsedMuse.activeSeq).toBe(4);

    // Factory reset otadata -> falls back to factory
    const blank = buildFactoryResetOtadata();
    expect(parseOtadata(blank).activeSlot).toBe('factory');
  });

  it('enforces hardware write guards on protected WG1200 partitions', () => {
    // Allowed: otadata (0x13000, 8 KB), ota_0 (0x420000), ota_1 (0x820000)
    expect(() => assertWriteAllowed(OTADATA_OFFSET, OTADATA_SIZE)).not.toThrow();
    expect(() => assertWriteAllowed(OTA_0_OFFSET, 2 * 1024 * 1024)).not.toThrow();
    expect(() => assertWriteAllowed(OTA_1_OFFSET, 2 * 1024 * 1024)).not.toThrow();

    // Allowed ONLY with explicit verified dual-boot partition table flag: 0xC000
    expect(() =>
      assertWriteAllowed(PARTITION_TABLE_OFFSET, PARTITION_TABLE_READ_SIZE),
    ).toThrow(/SAFETY GUARD BLOCKED WRITE/);
    expect(() =>
      assertWriteAllowed(PARTITION_TABLE_OFFSET, PARTITION_TABLE_READ_SIZE, {
        allowVerifiedDualBootPartitionTable: true,
      }),
    ).not.toThrow();

    // Blocked: Bootloader (0x0), NVS (0xF000), Factory (0x20000), NVS Key (0xC20000)
    expect(() => assertWriteAllowed(0x0, 4096)).toThrow(/SAFETY GUARD BLOCKED WRITE/);
    expect(() => assertWriteAllowed(0x0000f000, 4096)).toThrow(/SAFETY GUARD BLOCKED WRITE/);
    expect(() => assertWriteAllowed(FACTORY_OFFSET, 4096)).toThrow(/SAFETY GUARD BLOCKED WRITE/);
    expect(() => assertWriteAllowed(0x00c20000, 4096)).toThrow(/SAFETY GUARD BLOCKED WRITE/);
  });
});
