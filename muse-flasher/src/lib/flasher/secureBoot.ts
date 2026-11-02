import { SECURE_BOOT_V2_SECTOR_SIZE, SECURE_BOOT_V2_SIGNATURE_MAGIC } from './constants';

// ESP-IDF Secure Boot V2 signature block (ets_secure_boot_sig_block_t), 1216 bytes:
//   0     magic 0xE7, version 0x02, 2 bytes padding
//   4     SHA-256 of the image data before the block
//   36    RSA-3072 key: n (384 B, LE), e (u32), rinv (384 B, LE), mdash (u32)
//   812   RSA-PSS signature (384 B, LE)
//   1196  CRC32, then padding
// The eFuse key digest is SHA-256 over bytes 36..812 (the key material).
export const SECURE_BOOT_V2_BLOCK_VERSION = 0x02;
const SIG_BLOCK_DIGEST_OFFSET = 4;
const SIG_BLOCK_KEY_OFFSET = 36;
const RSA_3072_BYTES = 384;
const SIG_BLOCK_E_OFFSET = SIG_BLOCK_KEY_OFFSET + RSA_3072_BYTES; // 420
const SIG_BLOCK_KEY_END = SIG_BLOCK_KEY_OFFSET + RSA_3072_BYTES + 4 + RSA_3072_BYTES + 4; // 812
const SIG_BLOCK_SIGNATURE_OFFSET = SIG_BLOCK_KEY_END;
const PSS_SALT_LENGTH = 32;

export interface SecureBootV2Verification {
  valid: boolean;
  errors: string[];
  /** Offset of the 4 KB signature sector (= number of signed image bytes). */
  signatureOffset: number;
  /** SHA-256 over the block's key material, as burned into the eFuse key digest. */
  signingKeyDigest: string;
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function reversed(bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) {
    out[i] = bytes[bytes.length - 1 - i];
  }
  return out;
}

function stripLeadingZeros(bytes: Uint8Array): Uint8Array {
  let i = 0;
  while (i < bytes.length - 1 && bytes[i] === 0) i++;
  return bytes.subarray(i);
}

function copyBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', copyBuffer(bytes)));
}

/**
 * Verifies the RSA-3072 Secure Boot V2 signature of a signed app image the way the
 * ESP32-S3 bootloader does: image digest, RSA-PSS (SHA-256, 32-byte salt) over the
 * image, and, when `expectedKeyDigest` is given, that the image is signed with that key.
 * espsecure.py appends the block in its own 4 KB sector at the end of the image.
 */
export async function verifySecureBootV2Signature(
  bytes: Uint8Array,
  expectedKeyDigest?: string,
): Promise<SecureBootV2Verification> {
  const errors: string[] = [];
  const result = (signatureOffset = -1, signingKeyDigest = ''): SecureBootV2Verification => ({
    valid: errors.length === 0,
    errors,
    signatureOffset,
    signingKeyDigest,
  });

  if (bytes.length < SECURE_BOOT_V2_SECTOR_SIZE * 2 || bytes.length % SECURE_BOOT_V2_SECTOR_SIZE !== 0) {
    errors.push(
      `Signed image length (${bytes.length}) must be a multiple of ${SECURE_BOOT_V2_SECTOR_SIZE} bytes with a signature sector.`,
    );
    return result();
  }

  const sigOffset = bytes.length - SECURE_BOOT_V2_SECTOR_SIZE;
  const block = bytes.subarray(sigOffset, sigOffset + 1216);
  if (block[0] !== SECURE_BOOT_V2_SIGNATURE_MAGIC || block[1] !== SECURE_BOOT_V2_BLOCK_VERSION) {
    errors.push(
      `No Secure Boot V2 signature block at 0x${sigOffset.toString(16)} (magic 0x${block[0].toString(16)}, version ${block[1]}). Unsigned firmware cannot boot on WG1200.`,
    );
    return result(sigOffset);
  }

  const keyMaterial = block.subarray(SIG_BLOCK_KEY_OFFSET, SIG_BLOCK_KEY_END);
  const signingKeyDigest = toHex(await sha256(keyMaterial));
  if (expectedKeyDigest && signingKeyDigest !== expectedKeyDigest.toLowerCase()) {
    errors.push(
      `Image is signed with key ${signingKeyDigest.slice(0, 16)}…, not the expected WG1200 key ${expectedKeyDigest.slice(0, 16)}…`,
    );
  }

  const signedData = bytes.subarray(0, sigOffset);
  const imageDigest = await sha256(signedData);
  const storedDigest = block.subarray(SIG_BLOCK_DIGEST_OFFSET, SIG_BLOCK_DIGEST_OFFSET + 32);
  if (toHex(imageDigest) !== toHex(storedDigest)) {
    errors.push('Image SHA-256 does not match the digest in its Secure Boot V2 signature block.');
    return result(sigOffset, signingKeyDigest);
  }

  const view = new DataView(block.buffer, block.byteOffset, block.byteLength);
  const exponent = view.getUint32(SIG_BLOCK_E_OFFSET, true);
  const eBytes = new Uint8Array(4);
  new DataView(eBytes.buffer).setUint32(0, exponent, false);
  const modulus = reversed(block.subarray(SIG_BLOCK_KEY_OFFSET, SIG_BLOCK_E_OFFSET));
  const signature = reversed(
    block.subarray(SIG_BLOCK_SIGNATURE_OFFSET, SIG_BLOCK_SIGNATURE_OFFSET + RSA_3072_BYTES),
  );

  try {
    const publicKey = await crypto.subtle.importKey(
      'jwk',
      {
        kty: 'RSA',
        n: toBase64Url(stripLeadingZeros(modulus)),
        e: toBase64Url(stripLeadingZeros(eBytes)),
        alg: 'PS256',
        ext: true,
      },
      { name: 'RSA-PSS', hash: 'SHA-256' },
      false,
      ['verify'],
    );
    const ok = await crypto.subtle.verify(
      { name: 'RSA-PSS', saltLength: PSS_SALT_LENGTH },
      publicKey,
      copyBuffer(signature),
      copyBuffer(signedData),
    );
    if (!ok) {
      errors.push('RSA-3072 Secure Boot V2 signature does not verify against the image.');
    }
  } catch (err) {
    errors.push(
      `Could not verify the RSA-3072 signature: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  return result(sigOffset, signingKeyDigest);
}
