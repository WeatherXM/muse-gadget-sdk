import {
  ESP_APP_DESC_MAGIC,
  ESP_APP_DESC_OFFSET,
  ESP_IMAGE_HEADER_MAGIC,
} from './constants';

export type FirmwareFlavor = 'weatherxm' | 'muse' | 'meshtastic' | 'unknown';

export interface ParsedAppDescriptor {
  valid: boolean;
  imageMagic: number;
  appDescMagic: number;
  secureVersion: number;
  version: string;
  projectName: string;
  compileTime: string;
  compileDate: string;
  idfVersion: string;
  appElfSha256: string;
  flavor: FirmwareFlavor;
}

function readNullTerminatedAscii(bytes: Uint8Array, start: number, maxLength: number): string {
  const end = Math.min(bytes.length, start + maxLength);
  let out = '';
  for (let i = start; i < end; i++) {
    const b = bytes[i];
    if (b === 0) break;
    if (b >= 0x20 && b <= 0x7e) {
      out += String.fromCharCode(b);
    }
  }
  return out.trim();
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export function classifyFirmwareFlavor(projectName: string, version: string): FirmwareFlavor {
  const proj = projectName.toLowerCase();
  const ver = version.toLowerCase();

  if (proj.includes('muse') || ver.includes('muse') || proj === 'muse-gadget') {
    return 'muse';
  }
  if (
    proj.includes('wg1010') ||
    proj.includes('wg1200') ||
    proj.includes('weatherxm') ||
    proj.includes('m5_gateway') ||
    proj.includes('wxm')
  ) {
    return 'weatherxm';
  }
  if (proj.includes('meshtastic') || ver.includes('meshtastic')) {
    return 'meshtastic';
  }
  return 'unknown';
}

export function parseAppDescriptor(bytes: Uint8Array): ParsedAppDescriptor {
  if (bytes.length < ESP_APP_DESC_OFFSET + 256) {
    return {
      valid: false,
      imageMagic: bytes.length > 0 ? bytes[0] : 0,
      appDescMagic: 0,
      secureVersion: 0,
      version: '',
      projectName: '',
      compileTime: '',
      compileDate: '',
      idfVersion: '',
      appElfSha256: '',
      flavor: 'unknown',
    };
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const imageMagic = bytes[0];
  const appDescMagic = view.getUint32(ESP_APP_DESC_OFFSET, true);
  const secureVersion = view.getUint32(ESP_APP_DESC_OFFSET + 4, true);

  if (imageMagic !== ESP_IMAGE_HEADER_MAGIC || appDescMagic !== ESP_APP_DESC_MAGIC) {
    return {
      valid: false,
      imageMagic,
      appDescMagic,
      secureVersion,
      version: '',
      projectName: '',
      compileTime: '',
      compileDate: '',
      idfVersion: '',
      appElfSha256: '',
      flavor: 'unknown',
    };
  }

  const version = readNullTerminatedAscii(bytes, ESP_APP_DESC_OFFSET + 16, 32);
  const projectName = readNullTerminatedAscii(bytes, ESP_APP_DESC_OFFSET + 48, 32);
  const compileTime = readNullTerminatedAscii(bytes, ESP_APP_DESC_OFFSET + 80, 16);
  const compileDate = readNullTerminatedAscii(bytes, ESP_APP_DESC_OFFSET + 96, 16);
  const idfVersion = readNullTerminatedAscii(bytes, ESP_APP_DESC_OFFSET + 112, 32);
  const elfShaSlice = bytes.subarray(ESP_APP_DESC_OFFSET + 144, ESP_APP_DESC_OFFSET + 176);
  const appElfSha256 = bytesToHex(elfShaSlice);

  const flavor = classifyFirmwareFlavor(projectName, version);

  return {
    valid: true,
    imageMagic,
    appDescMagic,
    secureVersion,
    version,
    projectName,
    compileTime,
    compileDate,
    idfVersion,
    appElfSha256,
    flavor,
  };
}

export function formatFlavorLabel(flavor: FirmwareFlavor): string {
  switch (flavor) {
    case 'muse':
      return 'Muse Gadget OS';
    case 'weatherxm':
      return 'WeatherXM Official';
    case 'meshtastic':
      return 'Meshtastic';
    default:
      return 'Unknown / Empty';
  }
}
