import {
  OTADATA_SECTOR_SIZE,
  OTADATA_SIZE,
  OTA_STATE_ABORTED,
  OTA_STATE_INVALID,
  OTA_STATE_NEW,
  OTA_STATE_PENDING_VERIFY,
  OTA_STATE_UNDEFINED,
  OTA_STATE_VALID,
} from './constants';

export type ActiveBootSlot = 'factory' | 'ota_0' | 'ota_1';

export interface OtadataSectorInfo {
  sectorIndex: 0 | 1;
  seq: number;
  state: number;
  storedCrc: number;
  computedCrc: number;
  crcValid: boolean;
  bootable: boolean;
}

export interface ParsedOtadata {
  sector0: OtadataSectorInfo;
  sector1: OtadataSectorInfo;
  activeSlot: ActiveBootSlot;
  activeSeq: number;
  activeSector: 0 | 1 | null;
}

/**
 * ESP-IDF esp_rom_crc32_le(0xffffffff, buf, len)
 * Notice that ESP-IDF's esp_rom_crc32_le XORs the initial crc with ~0 at entry and ~0 at exit,
 * so passing initial=0xffffffff means the internal state starts at 0x00000000!
 */
export function computeEspOtaCrc32(seq: number): number {
  const buf = new Uint8Array(4);
  new DataView(buf.buffer).setUint32(0, seq >>> 0, true);

  let crc = 0x00000000; // ~0xffffffff
  for (let i = 0; i < 4; i++) {
    crc ^= buf[i];
    for (let bit = 0; bit < 8; bit++) {
      if ((crc & 1) !== 0) {
        crc = (crc >>> 1) ^ 0xedb88320;
      } else {
        crc = crc >>> 1;
      }
    }
  }
  return (~crc) >>> 0;
}

function isBootableOtaState(state: number): boolean {
  return (
    state === OTA_STATE_VALID ||
    state === OTA_STATE_NEW ||
    state === OTA_STATE_PENDING_VERIFY ||
    state === OTA_STATE_UNDEFINED
  ) && ![OTA_STATE_INVALID, OTA_STATE_ABORTED].includes(state);
}

function parseSector(bytes: Uint8Array, sectorIndex: 0 | 1): OtadataSectorInfo {
  const baseOffset = sectorIndex * OTADATA_SECTOR_SIZE;
  const view = new DataView(bytes.buffer, bytes.byteOffset + baseOffset, 32);
  const seq = view.getUint32(0, true);
  const state = view.getUint32(24, true);
  const storedCrc = view.getUint32(28, true);

  const isBlank = seq === 0xffffffff || seq === 0;
  const computedCrc = isBlank ? 0xffffffff : computeEspOtaCrc32(seq);
  const crcValid = !isBlank && storedCrc === computedCrc;
  const bootable = crcValid && isBootableOtaState(state);

  return {
    sectorIndex,
    seq,
    state,
    storedCrc,
    computedCrc,
    crcValid,
    bootable,
  };
}

export function seqToSlot(seq: number): 'ota_0' | 'ota_1' {
  // ESP-IDF: ota_slot = (ota_seq - 1) % num_ota_partitions (2 on WG1200)
  return (seq - 1) % 2 === 0 ? 'ota_0' : 'ota_1';
}

export function parseOtadata(bytes: Uint8Array): ParsedOtadata {
  if (bytes.length < OTADATA_SIZE) {
    throw new Error(`otadata buffer must be at least ${OTADATA_SIZE} bytes (got ${bytes.length})`);
  }

  const sector0 = parseSector(bytes, 0);
  const sector1 = parseSector(bytes, 1);

  let winningSector: OtadataSectorInfo | null = null;
  if (sector0.bootable && sector1.bootable) {
    winningSector = sector0.seq >= sector1.seq ? sector0 : sector1;
  } else if (sector0.bootable) {
    winningSector = sector0;
  } else if (sector1.bootable) {
    winningSector = sector1;
  }

  if (!winningSector) {
    return {
      sector0,
      sector1,
      activeSlot: 'factory',
      activeSeq: 0,
      activeSector: null,
    };
  }

  return {
    sector0,
    sector1,
    activeSlot: seqToSlot(winningSector.seq),
    activeSeq: winningSector.seq,
    activeSector: winningSector.sectorIndex,
  };
}

export function buildOtadataSectorEntry(seq: number, state = OTA_STATE_VALID): Uint8Array {
  const sector = new Uint8Array(OTADATA_SECTOR_SIZE);
  sector.fill(0xff);
  const view = new DataView(sector.buffer);
  view.setUint32(0, seq >>> 0, true);
  view.setUint32(24, state >>> 0, true);
  view.setUint32(28, computeEspOtaCrc32(seq), true);
  return sector;
}

/**
 * Builds an 8 KB otadata image that activates targetSlot ('ota_0' for WeatherXM, 'ota_1' for Muse)
 * by incrementing ota_seq to the next sequence number whose parity matches targetSlot, while
 * preserving the previous active sector for rollback safety.
 */
export function buildOtadataForSlot(
  currentBytes: Uint8Array | null,
  targetSlot: 'ota_0' | 'ota_1',
): { bytes: Uint8Array; nextSeq: number; targetSector: 0 | 1 } {
  const out = new Uint8Array(OTADATA_SIZE);
  out.fill(0xff);

  let currentSeq = 0;
  let currentSector: 0 | 1 | null = null;

  if (currentBytes && currentBytes.length >= OTADATA_SIZE) {
    out.set(currentBytes.subarray(0, OTADATA_SIZE));
    const parsed = parseOtadata(currentBytes);
    currentSeq = parsed.activeSeq;
    currentSector = parsed.activeSector;
  }

  // Find smallest seq > currentSeq where seqToSlot(seq) === targetSlot
  let nextSeq = currentSeq + 1;
  if (nextSeq <= 0 || nextSeq >= 0xfffffff0) {
    nextSeq = 1;
  }
  if (seqToSlot(nextSeq) !== targetSlot) {
    nextSeq += 1;
  }

  const targetSector: 0 | 1 = currentSector === 0 ? 1 : 0;
  const newSectorBytes = buildOtadataSectorEntry(nextSeq, OTA_STATE_VALID);
  out.set(newSectorBytes, targetSector * OTADATA_SECTOR_SIZE);

  return {
    bytes: out,
    nextSeq,
    targetSector,
  };
}

export function buildFactoryResetOtadata(): Uint8Array {
  const out = new Uint8Array(OTADATA_SIZE);
  out.fill(0xff);
  return out;
}
