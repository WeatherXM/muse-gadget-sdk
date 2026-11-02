import {
  ESP_APP_DESC_MAGIC,
  ESP_APP_DESC_OFFSET,
  ESP_IMAGE_HEADER_MAGIC,
  OTADATA_OFFSET,
  OTADATA_SIZE,
  OTA_0_OFFSET,
  OTA_0_SIZE,
  OTA_1_OFFSET,
  OTA_1_SIZE,
  PARTITION_TABLE_OFFSET,
  PARTITION_TABLE_READ_SIZE,
  PROTECTED_REGIONS,
  SECURE_BOOT_V2_SECTOR_SIZE,
  SECURE_BOOT_V2_SIGNATURE_MAGIC,
} from './constants';
import { verifySecureBootV2Signature } from './secureBoot';

export interface WriteGuardOptions {
  allowVerifiedDualBootPartitionTable?: boolean;
}

export function assertWriteAllowed(
  offset: number,
  byteLength: number,
  options?: WriteGuardOptions,
): void {
  if (!Number.isInteger(offset) || offset < 0) {
    throw new Error(`Write blocked: invalid flash offset ${offset}.`);
  }
  if (!Number.isInteger(byteLength) || byteLength <= 0) {
    throw new Error(`Write blocked: invalid write length ${byteLength}.`);
  }

  const end = offset + byteLength;

  // Check if this is an explicitly authorized dual-boot partition table upgrade at 0xC000
  const isPartitionTableWrite =
    offset === PARTITION_TABLE_OFFSET &&
    byteLength === PARTITION_TABLE_READ_SIZE &&
    options?.allowVerifiedDualBootPartitionTable === true;

  if (isPartitionTableWrite) {
    return;
  }

  // Check against protected regions
  for (const region of PROTECTED_REGIONS) {
    const overlaps = offset < region.end && end > region.start;
    if (overlaps) {
      throw new Error(
        `SAFETY GUARD BLOCKED WRITE: range [0x${offset.toString(16)}..0x${end.toString(16)}] overlaps protected region "${region.name}" ([0x${region.start.toString(16)}..0x${region.end.toString(16)}]). ${region.reason}`,
      );
    }
  }

  // Allowed write regions:
  // 1. Exact otadata write (0x13000, 8 KB)
  const isOtadataWrite = offset === OTADATA_OFFSET && byteLength === OTADATA_SIZE;
  // 2. App image write inside ota_0 [0x420000 .. 0x820000]
  const isOta0Write = offset === OTA_0_OFFSET && end <= OTA_0_OFFSET + OTA_0_SIZE;
  // 3. App image write inside ota_1 [0x820000 .. 0xC20000]
  const isOta1Write = offset === OTA_1_OFFSET && end <= OTA_1_OFFSET + OTA_1_SIZE;

  if (!isOtadataWrite && !isOta0Write && !isOta1Write) {
    throw new Error(
      `SAFETY GUARD BLOCKED WRITE: range [0x${offset.toString(16)}..0x${end.toString(16)}] is outside permitted slots (otadata 0x13000, ota_0 0x420000, ota_1 0x820000).`,
    );
  }
}

export interface ImageVerificationResult {
  valid: boolean;
  errors: string[];
}

export function verifySignedAppBinary(bytes: Uint8Array): ImageVerificationResult {
  const errors: string[] = [];

  if (bytes.length < 64 * 1024) {
    errors.push(`Firmware image is unexpectedly small (${bytes.length} bytes).`);
    return { valid: false, errors };
  }

  if (bytes.length > OTA_0_SIZE) {
    errors.push(`Firmware image (${bytes.length} bytes) exceeds 4 MB OTA slot capacity.`);
  }

  if (bytes[0] !== ESP_IMAGE_HEADER_MAGIC) {
    errors.push(
      `Invalid ESP image header magic: expected 0x${ESP_IMAGE_HEADER_MAGIC.toString(16)}, got 0x${bytes[0].toString(16)}.`,
    );
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const appDescMagic = view.getUint32(ESP_APP_DESC_OFFSET, true);
  if (appDescMagic !== ESP_APP_DESC_MAGIC) {
    errors.push(
      `Invalid ESP app descriptor magic at offset 32: expected 0x${ESP_APP_DESC_MAGIC.toString(16)}, got 0x${appDescMagic.toString(16)}.`,
    );
  }

  if (bytes.length % SECURE_BOOT_V2_SECTOR_SIZE !== 0) {
    errors.push(
      `Signed Secure Boot V2 image length (${bytes.length}) must be aligned to 4096-byte sector boundary.`,
    );
  } else {
    const sigOffset = bytes.length - SECURE_BOOT_V2_SECTOR_SIZE;
    const sigMagic = bytes[sigOffset];
    if (sigMagic !== SECURE_BOOT_V2_SIGNATURE_MAGIC) {
      errors.push(
        `Missing RSA-3072 Secure Boot V2 signature block at offset 0x${sigOffset.toString(16)} (expected magic 0xe7, got 0x${sigMagic.toString(16)}). Unsigned firmware cannot boot on WG1200.`,
      );
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Structural checks plus the full RSA-3072 Secure Boot V2 verification. Pass the
 * manifest's `signingKeyDigest` so an image signed with another key is refused
 * before it is written (the WG1200 bootloader would reject it).
 */
export async function verifySignedAppImage(
  bytes: Uint8Array,
  expectedKeyDigest?: string,
): Promise<ImageVerificationResult & { signingKeyDigest: string }> {
  const structural = verifySignedAppBinary(bytes);
  if (!structural.valid) {
    return { ...structural, signingKeyDigest: '' };
  }
  const sig = await verifySecureBootV2Signature(bytes, expectedKeyDigest);
  return {
    valid: sig.valid,
    errors: sig.errors,
    signingKeyDigest: sig.signingKeyDigest,
  };
}
