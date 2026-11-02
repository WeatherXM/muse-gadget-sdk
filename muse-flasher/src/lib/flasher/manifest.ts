export type FirmwareTargetId =
  | 'muse'
  | 'weatherxm'
  | 'weatherxm_0_8_34'
  | 'weatherxm_0_6_2';

export interface ManifestFirmwareEntry {
  id: FirmwareTargetId;
  name: string;
  shortName: string;
  tagline: string;
  description: string;
  version: string;
  projectName: string;
  idfVersion: string;
  compileDate: string;
  compileTime: string;
  file: string;
  size: number;
  sha256: string;
  /** MD5 of the whole file, compared with the stub's on-chip flash MD5 of the slot. */
  md5?: string;
  /** esp_app_desc_t.app_elf_sha256: identifies the build even when versions repeat (Muse is always 999.0.0). */
  appElfSha256?: string;
  /** SHA-256 of the Secure Boot V2 key material in the image's signature block. */
  signingKeyDigest?: string;
  targetPartition: 'ota_0' | 'ota_1';
  targetOffset: number;
  signed: boolean;
  requiresDualBootPartitionTable: boolean;
  notes: string[];
}

export interface DualBootPartitionTableEntry {
  file: string;
  size: number;
  sha256: string;
}

export interface FirmwareManifest {
  schemaVersion: number;
  targetDevice: string;
  flashGeometry: {
    chip: string;
    flashSizeBytes: number;
    ota0Address: string;
    ota0SizeBytes: number;
    ota1Address: string;
    ota1SizeBytes: number;
    otadataAddress: string;
    otadataSizeBytes: number;
    factoryAddress: string;
    factorySizeBytes: number;
    partitionTableAddress: string;
    partitionTableSizeBytes: number;
    museNvsAddress: string;
    museNvsSizeBytes: number;
  };
  dualBootPartitionTable: DualBootPartitionTableEntry;
  firmwares: Record<FirmwareTargetId, ManifestFirmwareEntry>;
}

export async function fetchFirmwareManifest(): Promise<FirmwareManifest> {
  const res = await fetch('/firmware/manifest.json', { cache: 'no-cache' });
  if (!res.ok) {
    throw new Error(`Failed to load firmware manifest (HTTP ${res.status})`);
  }
  return (await res.json()) as FirmwareManifest;
}
