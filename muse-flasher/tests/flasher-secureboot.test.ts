import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseAppDescriptor } from '../src/lib/flasher/appDescriptor';
import { FlasherController } from '../src/lib/flasher/flasherController';
import type { FirmwareManifest } from '../src/lib/flasher/manifest';
import { verifySecureBootV2Signature } from '../src/lib/flasher/secureBoot';
import { classifyBootLine } from '../src/lib/flasher/serialLog';
import { verifySignedAppImage } from '../src/lib/flasher/writeGuard';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(__dirname, '..', 'public');
const manifest = JSON.parse(
  fs.readFileSync(path.join(publicDir, 'firmware', 'manifest.json'), 'utf8'),
) as FirmwareManifest;
const entries = Object.values(manifest.firmwares);
const readFirmware = (file: string) => new Uint8Array(fs.readFileSync(path.join(publicDir, file)));

describe('Secure Boot V2 verification', () => {
  it.each(entries.map((e) => [e.id, e] as const))(
    'verifies the RSA-3072 signature of %s and its WG1200 key',
    async (_id, entry) => {
      const bytes = readFirmware(entry.file);
      const res = await verifySecureBootV2Signature(bytes, entry.signingKeyDigest);
      expect(res.errors).toEqual([]);
      expect(res.valid).toBe(true);
      expect(res.signatureOffset).toBe(bytes.length - 4096);
      expect(res.signingKeyDigest).toBe(entry.signingKeyDigest);
    },
  );

  it('signs every bundled image with the same key', () => {
    const keys = new Set(entries.map((e) => e.signingKeyDigest));
    expect(keys.size).toBe(1);
    expect([...keys][0]).toMatch(/^[0-9a-f]{64}$/);
  });

  it('rejects an image with one byte changed', async () => {
    const bytes = readFirmware(manifest.firmwares.muse.file);
    bytes[0x1000] ^= 0x01;
    const res = await verifySecureBootV2Signature(bytes);
    expect(res.valid).toBe(false);
    expect(res.errors.join('\n')).toMatch(/digest/);
  });

  it('rejects a forged signature even when the digest matches', async () => {
    const bytes = readFirmware(manifest.firmwares.muse.file);
    const sigBlock = bytes.length - 4096;
    bytes[sigBlock + 812 + 10] ^= 0xff;
    const res = await verifySecureBootV2Signature(bytes);
    expect(res.valid).toBe(false);
    expect(res.errors.join('\n')).toMatch(/signature does not verify/);
  });

  it('rejects an image signed with a different key than expected', async () => {
    const bytes = readFirmware(manifest.firmwares.muse.file);
    const res = await verifySignedAppImage(bytes, '00'.repeat(32));
    expect(res.valid).toBe(false);
    expect(res.errors.join('\n')).toMatch(/not the expected WG1200 key/);
  });

  it('rejects an unsigned image', async () => {
    const bytes = readFirmware(manifest.firmwares.muse.file);
    bytes.fill(0xff, bytes.length - 4096);
    const res = await verifySignedAppImage(bytes);
    expect(res.valid).toBe(false);
  });
});

describe('firmware manifest', () => {
  it.each(entries.map((e) => [e.id, e] as const))(
    'records md5 and app ELF SHA-256 for %s from the image itself',
    (_id, entry) => {
      const bytes = readFirmware(entry.file);
      expect(entry.size).toBe(bytes.length);
      expect(entry.size % 4).toBe(0); // esptool pads to 4, so the flash MD5 covers exactly the file
      expect(entry.md5).toBe(crypto.createHash('md5').update(bytes).digest('hex'));
      expect(entry.appElfSha256).toBe(parseAppDescriptor(bytes.subarray(0, 512)).appElfSha256);
    },
  );
});

describe('instant switch', () => {
  const muse = manifest.firmwares.muse;
  const withOta1 = (appElfSha256: string, version = muse.version) => {
    const controller = new FlasherController();
    const app = parseAppDescriptor(readFirmware(muse.file).subarray(0, 512));
    (controller as unknown as { state: unknown }).state = {
      ...controller.currentState,
      manifest,
      device: {
        partitionValidation: { hasMuseNvs: true },
        ota0App: { valid: false },
        ota1App: { ...app, appElfSha256, version },
      },
    };
    return controller;
  };

  it('switches when ota_1 holds the bundled Muse build', () => {
    expect(withOta1(muse.appElfSha256!).canInstantSwitchTo('muse')).toBe(true);
  });

  it('re-flashes an older Muse build that reports the same 999.0.0 version', () => {
    expect(withOta1('ab'.repeat(32), '999.0.0').canInstantSwitchTo('muse')).toBe(false);
  });
});

describe('boot log classification', () => {
  it.each([
    ['I (412) boot: Loaded app from partition at offset 0x820000', 'muse'],
    ['I (412) boot: Loaded app from partition at offset 0x420000', 'weatherxm'],
    ['I (380) app_init: Project name:     muse-gadget', 'muse'],
    ['I (1203) link.main: Muse Gadget starting', 'muse'],
    ['@sdk_token ok', 'muse'],
    ['I (380) app_init: Project name:     wg1010_port', 'weatherxm'],
    ['I (10) cpu_start: Pro cpu up.', null],
  ])('%s -> %s', (line, flavor) => {
    expect(classifyBootLine(line)).toBe(flavor);
  });
});
