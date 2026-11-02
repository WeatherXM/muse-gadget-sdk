import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const firmwareDir = path.join(rootDir, 'public', 'firmware');
const manifestPath = path.join(firmwareDir, 'manifest.json');

function computeFileInfo(relativePath) {
  const fullPath = path.join(rootDir, 'public', relativePath.replace(/^\//, ''));
  const bytes = fs.readFileSync(fullPath);
  const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  const md5 = crypto.createHash('md5').update(bytes).digest('hex');

  let appMagicOk = false;
  let version = '';
  let projectName = '';
  let compileTime = '';
  let compileDate = '';
  let idfVersion = '';
  let appElfSha256 = '';
  let hasSignatureBlock = false;
  let signingKeyDigest = '';

  if (bytes.length >= 288 && bytes[0] === 0xe9) {
    const descMagic = bytes.readUInt32LE(32);
    if (descMagic === 0xabcd5432) {
      appMagicOk = true;
      version = bytes.subarray(48, 80).toString('utf8').replace(/\0.*$/, '');
      projectName = bytes.subarray(80, 112).toString('utf8').replace(/\0.*$/, '');
      compileTime = bytes.subarray(112, 128).toString('utf8').replace(/\0.*$/, '');
      compileDate = bytes.subarray(128, 144).toString('utf8').replace(/\0.*$/, '');
      idfVersion = bytes.subarray(144, 176).toString('utf8').replace(/\0.*$/, '');
      appElfSha256 = bytes.subarray(176, 208).toString('hex');
    }
    // Secure Boot V2 block in the last 4 KB sector; the eFuse key digest is
    // SHA-256 over its key material (bytes 36..812).
    const sigOffset = bytes.length - 4096;
    if (bytes.length > 4096 && bytes[sigOffset] === 0xe7 && bytes[sigOffset + 1] === 0x02) {
      hasSignatureBlock = true;
      signingKeyDigest = crypto
        .createHash('sha256')
        .update(bytes.subarray(sigOffset + 36, sigOffset + 812))
        .digest('hex');
    }
  }

  return {
    size: bytes.length,
    sha256,
    md5,
    appMagicOk,
    version,
    projectName,
    compileTime,
    compileDate,
    idfVersion,
    appElfSha256,
    hasSignatureBlock,
    signingKeyDigest,
  };
}

// Fields every signed app entry shares, read from the image itself.
function imageFields(info) {
  return {
    size: info.size,
    sha256: info.sha256,
    md5: info.md5,
    appElfSha256: info.appElfSha256,
    signingKeyDigest: info.signingKeyDigest,
  };
}

const museInfo = computeFileInfo('/firmware/muse/muse-gadget.bin');
const ptInfo = computeFileInfo('/firmware/muse/partition-table.bin');
const wxm0839Info = computeFileInfo('/firmware/weatherxm/fw_release_0.8.39-g80c3a1c-signed.bin');
const wxm0834Info = computeFileInfo('/firmware/weatherxm/fw_release_0.8.34-g86b609b-signed.bin');
const wxm062Info = computeFileInfo('/firmware/weatherxm/fw_release_0.6.2-g8f4dca2-signed.bin');

const signingKeys = new Set(
  [museInfo, wxm0839Info, wxm0834Info, wxm062Info].map((info) => info.signingKeyDigest),
);
if (signingKeys.size !== 1 || signingKeys.has('')) {
  console.warn(
    `WARNING: bundled WG1200 images are not all signed with one Secure Boot V2 key: ${[...signingKeys].join(', ')}`,
  );
}

const manifest = {
  schemaVersion: 3,
  targetDevice: 'WeatherXM WG1200 (ESP32-S3)',
  flashGeometry: {
    chip: 'ESP32-S3',
    flashSizeBytes: 16777216,
    ota0Address: '0x00420000',
    ota0SizeBytes: 4194304,
    ota1Address: '0x00820000',
    ota1SizeBytes: 4194304,
    otadataAddress: '0x00013000',
    otadataSizeBytes: 8192,
    factoryAddress: '0x00020000',
    factorySizeBytes: 4194304,
    partitionTableAddress: '0x0000C000',
    partitionTableSizeBytes: 3072,
    museNvsAddress: '0x00F21000',
    museNvsSizeBytes: 65536,
  },
  dualBootPartitionTable: {
    file: '/firmware/muse/partition-table.bin',
    size: ptInfo.size,
    sha256: ptInfo.sha256,
  },
  firmwares: {
    muse: {
      id: 'muse',
      name: 'Muse Gadget OS (WG1200 Dual-Boot)',
      shortName: 'Muse Gadget',
      tagline: 'Hatch Link + Companion BLE + Weather Station Touch UI',
      description:
        'Signed ESP32-S3 Muse Gadget firmware for the WeatherXM WG1200. Installs to ota_1 (0x820000) so your original WeatherXM firmware in ota_0 (0x420000) and factory (0x020000) remain untouched for instant 2-second switching.',
      version: museInfo.version || 'unknown',
      projectName: museInfo.projectName || 'muse-gadget',
      idfVersion: museInfo.idfVersion || 'v5.4.1',
      compileDate: museInfo.compileDate || 'Apr 19 2026',
      compileTime: museInfo.compileTime || '17:58:02',
      file: '/firmware/muse/muse-gadget.bin',
      ...imageFields(museInfo),
      targetPartition: 'ota_1',
      targetOffset: 8519680,
      signed: museInfo.hasSignatureBlock,
      requiresDualBootPartitionTable: true,
      notes: [
        'Signed with WG1200 RSA-3072 Secure Boot V2 key',
        'Dedicated muse_nvs partition at 0xF21000 isolates Muse tokens & Wi-Fi from WeatherXM NVS',
        'Supports Home Link (provision_v2 ECDH P-256 + AES-256-GCM) and Companion BLE GATT',
        'Built-in touchscreen UI with 1-tap "Switch to WeatherXM" button',
      ],
    },
    weatherxm: {
      id: 'weatherxm',
      name: 'WeatherXM Official Firmware (Latest)',
      shortName: 'WeatherXM v0.8.39',
      tagline: 'Official WeatherXM M5 WG1200 Gateway Firmware',
      description:
        'Official factory-signed WeatherXM WG1200 station gateway firmware (v0.8.39). Installs to ota_0 (0x420000) and boots directly into WeatherXM while preserving Muse in ota_1.',
      version: wxm0839Info.version || '0.8.39-g80c3a1c',
      projectName: wxm0839Info.projectName || 'm5_gateway_production',
      idfVersion: wxm0839Info.idfVersion || 'v5.1.2-dirty',
      compileDate: wxm0839Info.compileDate || 'Feb 19 2026',
      compileTime: wxm0839Info.compileTime || '13:01:28',
      file: '/firmware/weatherxm/fw_release_0.8.39-g80c3a1c-signed.bin',
      ...imageFields(wxm0839Info),
      targetPartition: 'ota_0',
      targetOffset: 4325376,
      signed: wxm0839Info.hasSignatureBlock,
      requiresDualBootPartitionTable: false,
      notes: [
        'Signed with WG1200 Secure Boot V2 key',
        'Preserves existing device identity, LoRa calibration, and Wi-Fi credentials',
        'Installs to ota_0 (0x420000) without touching Muse in ota_1 (0x820000)',
      ],
    },
    weatherxm_0_8_34: {
      id: 'weatherxm_0_8_34',
      name: 'WeatherXM Official Firmware (v0.8.34)',
      shortName: 'WeatherXM v0.8.34',
      tagline: 'Previous stable WeatherXM M5 WG1200 Gateway release',
      description:
        'Official signed WeatherXM WG1200 gateway firmware v0.8.34. Useful if you need to roll back to an earlier release.',
      version: wxm0834Info.version || '0.8.34-g86b609b',
      projectName: wxm0834Info.projectName || 'm5_gateway_production',
      idfVersion: wxm0834Info.idfVersion || 'v5.1.2-dirty',
      compileDate: wxm0834Info.compileDate || 'Jul 23 2025',
      compileTime: wxm0834Info.compileTime || '11:39:05',
      file: '/firmware/weatherxm/fw_release_0.8.34-g86b609b-signed.bin',
      ...imageFields(wxm0834Info),
      targetPartition: 'ota_0',
      targetOffset: 4325376,
      signed: wxm0834Info.hasSignatureBlock,
      requiresDualBootPartitionTable: false,
      notes: [
        'Signed with WG1200 Secure Boot V2 key',
        'Preserves existing device identity, LoRa calibration, and Wi-Fi credentials',
      ],
    },
    weatherxm_0_6_2: {
      id: 'weatherxm_0_6_2',
      name: 'WeatherXM Official Firmware (v0.6.2)',
      shortName: 'WeatherXM v0.6.2',
      tagline: 'Legacy WeatherXM M5 WG1200 Gateway release',
      description:
        'Legacy official signed WeatherXM WG1200 gateway firmware v0.6.2.',
      version: wxm062Info.version || '0.6.2-g8f4dca2-dirty',
      projectName: wxm062Info.projectName || 'm5_gateway_production',
      idfVersion: wxm062Info.idfVersion || 'v5.1.2-dirty',
      compileDate: wxm062Info.compileDate || 'Sep  5 2024',
      compileTime: wxm062Info.compileTime || '12:59:50',
      file: '/firmware/weatherxm/fw_release_0.6.2-g8f4dca2-signed.bin',
      ...imageFields(wxm062Info),
      targetPartition: 'ota_0',
      targetOffset: 4325376,
      signed: wxm062Info.hasSignatureBlock,
      requiresDualBootPartitionTable: false,
      notes: [
        'Signed with WG1200 Secure Boot V2 key',
        'Preserves existing device identity and calibration',
      ],
    },
  },
};

fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
console.log(`Updated ${manifestPath}`);
