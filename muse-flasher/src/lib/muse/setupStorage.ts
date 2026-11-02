// Remembers the provisioner form in this browser, with the same keys as
// esp32/tools/muse/muse_full_setup.html. The Wi-Fi password is kept only while
// "Remember Wi-Fi password" is ticked.

export const SETUP_FIELDS = [
  'wifiSsid',
  'nodeId',
  'vmId',
  'hatchHost',
  'webToken',
  'deviceAccessToken',
  'deviceRefreshToken',
] as const;

export type SetupField = (typeof SETUP_FIELDS)[number];

const key = (field: string) => `muse_setup_${field}`;
const SAVE_WIFI_PASS_KEY = 'muse_setup_saveWifiPass';
const WIFI_PASS_KEY = 'muse_setup_wifiPass';
const MINTED_FOR_KEY = 'muse_setup_mintedForNodeId';

function get(k: string): string | null {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
}

function set(k: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(k);
    else localStorage.setItem(k, value);
  } catch {
    // Private windows and blocked storage: the form still works, unsaved.
  }
}

export function loadSetupField(field: SetupField): string | null {
  const saved = get(key(field));
  if (saved === null) return null;
  // Keep the placeholder for empty optional fields.
  if ((field === 'vmId' || field === 'hatchHost') && !saved.trim()) return null;
  // Older setup pages saved the account API URL as the VM server.
  if (field === 'hatchHost' && /^(https?:\/\/)?(www\.|api\.)?muse\.ai\/?$/i.test(saved.trim())) return null;
  return saved;
}

export function saveSetupField(field: SetupField, value: string): void {
  set(key(field), value);
}

export function loadSavedWifiPassword(): { remember: boolean; password: string } {
  const remember = get(SAVE_WIFI_PASS_KEY) === '1';
  return { remember, password: remember ? get(WIFI_PASS_KEY) || '' : '' };
}

export function saveWifiPassword(remember: boolean, password: string): void {
  set(SAVE_WIFI_PASS_KEY, remember ? '1' : null);
  set(WIFI_PASS_KEY, remember ? password : null);
}

export function getMintedForNodeId(): string {
  return get(MINTED_FOR_KEY) || '';
}

export function setMintedForNodeId(nodeId: string | null): void {
  set(MINTED_FOR_KEY, nodeId);
}

/** Forgets every saved provisioner value, including the Wi-Fi password. */
export function forgetSetup(): void {
  for (const field of SETUP_FIELDS) set(key(field), null);
  saveWifiPassword(false, '');
  setMintedForNodeId(null);
}
