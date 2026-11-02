export interface DeviceIdentity {
  macBytes: number[];
  macColonHex: string;
  eui64Hex: string;
  shortHexUpper: string;
  shortHexLower: string;
  wxmBleName: string;
  museBleName: string;
  homeLinkBleName: string;
  defaultDeviceId: string;
}

export function deriveDeviceIdentity(macBytes: number[]): DeviceIdentity {
  const normalized = macBytes.slice(0, 6).map((b) => b & 0xff);
  while (normalized.length < 6) normalized.push(0);

  const hexParts = normalized.map((b) => b.toString(16).padStart(2, '0').toUpperCase());
  const macColonHex = hexParts.join(':');

  // IEEE EUI-64 (insert FF:FE in the middle, flip universal/local bit if needed or keep raw WXM format)
  const eui64Hex = [
    hexParts[0],
    hexParts[1],
    hexParts[2],
    'FF',
    'FE',
    hexParts[3],
    hexParts[4],
    hexParts[5],
  ].join(':');

  const shortHexUpper = `${hexParts[3]}${hexParts[4]}${hexParts[5]}`;
  const shortHexLower = shortHexUpper.toLowerCase();

  return {
    macBytes: normalized,
    macColonHex,
    eui64Hex,
    shortHexUpper,
    shortHexLower,
    wxmBleName: `WXM-${shortHexUpper}`,
    museBleName: `MuseGadget-${shortHexUpper}`,
    homeLinkBleName: `HomeLink-${shortHexUpper}`,
    defaultDeviceId: `wg1200-${shortHexLower}`,
  };
}
