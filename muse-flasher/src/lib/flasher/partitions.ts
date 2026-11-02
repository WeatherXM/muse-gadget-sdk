import {
  EXPECTED_PARTITIONS,
  MUSE_NVS_PARTITION_SPEC,
  type PartitionSpec,
} from './constants';

const PARTITION_ENTRY_SIZE = 32;
const PARTITION_MAGIC_0 = 0xaa;
const PARTITION_MAGIC_1 = 0x50;
const PARTITION_MD5_MAGIC_0 = 0xeb;
const PARTITION_MD5_MAGIC_1 = 0xeb;

export interface ParsedPartitionEntry extends PartitionSpec {
  flags: number;
}

export interface PartitionValidationResult {
  valid: boolean;
  entries: ParsedPartitionEntry[];
  hasMuseNvs: boolean;
  errors: string[];
}

function readPartitionLabel(bytes: Uint8Array, offset: number): string {
  let out = '';
  for (let i = 0; i < 16; i++) {
    const ch = bytes[offset + i];
    if (ch === 0) break;
    if (ch >= 0x20 && ch <= 0x7e) {
      out += String.fromCharCode(ch);
    }
  }
  return out;
}

export function parsePartitionTable(bytes: Uint8Array): ParsedPartitionEntry[] {
  const entries: ParsedPartitionEntry[] = [];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  for (let offset = 0; offset + PARTITION_ENTRY_SIZE <= bytes.length; offset += PARTITION_ENTRY_SIZE) {
    const b0 = bytes[offset];
    const b1 = bytes[offset + 1];

    if (b0 === 0xff && b1 === 0xff) {
      break;
    }
    if (b0 === PARTITION_MD5_MAGIC_0 && b1 === PARTITION_MD5_MAGIC_1) {
      continue;
    }
    if (b0 !== PARTITION_MAGIC_0 || b1 !== PARTITION_MAGIC_1) {
      break;
    }

    const type = bytes[offset + 2];
    const subtype = bytes[offset + 3];
    const partOffset = view.getUint32(offset + 4, true);
    const size = view.getUint32(offset + 8, true);
    const name = readPartitionLabel(bytes, offset + 12);
    const flags = view.getUint32(offset + 28, true);

    entries.push({
      name,
      type,
      subtype,
      offset: partOffset,
      size,
      flags,
    });
  }

  return entries;
}

export function hasMuseNvsPartition(entries: readonly ParsedPartitionEntry[]): boolean {
  const found = entries.find((e) => e.name === MUSE_NVS_PARTITION_SPEC.name);
  if (!found) return false;
  return (
    found.type === MUSE_NVS_PARTITION_SPEC.type &&
    found.subtype === MUSE_NVS_PARTITION_SPEC.subtype &&
    found.offset === MUSE_NVS_PARTITION_SPEC.offset &&
    found.size === MUSE_NVS_PARTITION_SPEC.size
  );
}

export function validatePartitionTable(bytes: Uint8Array): PartitionValidationResult {
  const entries = parsePartitionTable(bytes);
  const errors: string[] = [];

  if (entries.length === 0) {
    return {
      valid: false,
      entries,
      hasMuseNvs: false,
      errors: ['No valid ESP-IDF partition entries found at 0xC000.'],
    };
  }

  for (const expected of EXPECTED_PARTITIONS) {
    const actual = entries.find((e) => e.name === expected.name);
    if (!actual) {
      errors.push(`Missing expected WG1200 partition "${expected.name}".`);
      continue;
    }
    if (actual.offset !== expected.offset) {
      errors.push(
        `Partition "${expected.name}" offset mismatch: expected 0x${expected.offset.toString(16)}, found 0x${actual.offset.toString(16)}.`,
      );
    }
    if (actual.size !== expected.size) {
      errors.push(
        `Partition "${expected.name}" size mismatch: expected 0x${expected.size.toString(16)}, found 0x${actual.size.toString(16)}.`,
      );
    }
    if (actual.type !== expected.type || actual.subtype !== expected.subtype) {
      errors.push(
        `Partition "${expected.name}" type/subtype mismatch: expected ${expected.type}/${expected.subtype}, found ${actual.type}/${actual.subtype}.`,
      );
    }
  }

  const hasMuseNvs = hasMuseNvsPartition(entries);

  return {
    valid: errors.length === 0,
    entries,
    hasMuseNvs,
    errors,
  };
}

export function validateDualBootPartitionTableBinary(bytes: Uint8Array): {
  valid: boolean;
  errors: string[];
} {
  if (bytes.length !== 0xc00) {
    return {
      valid: false,
      errors: [`Dual-boot partition table must be exactly 3072 bytes (got ${bytes.length}).`],
    };
  }
  const baseCheck = validatePartitionTable(bytes);
  const errors = [...baseCheck.errors];
  if (!baseCheck.hasMuseNvs) {
    errors.push(
      `Dual-boot partition table is missing "${MUSE_NVS_PARTITION_SPEC.name}" at 0x${MUSE_NVS_PARTITION_SPEC.offset.toString(16)}.`,
    );
  }
  return {
    valid: errors.length === 0,
    errors,
  };
}
