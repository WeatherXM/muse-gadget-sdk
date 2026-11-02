export const EXPECTED_CHIP_NAME = 'ESP32-S3';
export const EXPECTED_FLASH_SIZE_BYTES = 16 * 1024 * 1024; // 16 MB

export const FLASH_BAUD_RATE = 460800;
// The CH340 bridge (1a86:7523) needs paced writes; 115200 matches web-flasher/boards.json.
export const FLASH_BAUD_RATE_CH340 = 115200;
export const SERIAL_MONITOR_BAUD = 115200;
// Web Serial's default 255-byte buffer is a fraction of one 4 KB flash-read
// frame; let Chrome take whole frames off the port while the page is busy.
export const SERIAL_BUFFER_SIZE = 64 * 1024;

// WG1200 USB devices behind its internal hub: the ESP32-S3's own USB-JTAG/serial
// port and the CH340 UART0 bridge. Both reach the ROM loader and the console,
// but the native port flashes in ~20 s while the paced CH340 takes minutes, so
// the port picker lists only the native one unless "Show all serial ports" is on.
export const WG1200_USB_JTAG = { usbVendorId: 0x303a, usbProductId: 0x1001 } as const;
export const WG1200_CH340 = { usbVendorId: 0x1a86, usbProductId: 0x7523 } as const;
export const WG1200_USB_FILTERS: ReadonlyArray<{ usbVendorId: number; usbProductId: number }> = [WG1200_USB_JTAG];

export type UsbLink = 'usb-jtag' | 'ch340' | 'other';

export function classifyUsbLink(info: { usbVendorId?: number } | undefined): UsbLink {
  if (info?.usbVendorId === WG1200_USB_JTAG.usbVendorId) return 'usb-jtag';
  if (info?.usbVendorId === WG1200_CH340.usbVendorId) return 'ch340';
  return 'other';
}

export function describeUsbLink(info: { usbVendorId?: number; usbProductId?: number } | undefined): string {
  const hex = (n?: number) => (n ?? 0).toString(16).padStart(4, '0');
  const ids = `${hex(info?.usbVendorId)}:${hex(info?.usbProductId)}`;
  switch (classifyUsbLink(info)) {
    case 'usb-jtag':
      return `native USB-JTAG (${ids})`;
    case 'ch340':
      return `CH340 USB-UART (${ids}), slow paced writes`;
    default:
      return `USB serial (${ids})`;
  }
}

export const PARTITION_TABLE_OFFSET = 0x0000c000;
export const PARTITION_TABLE_READ_SIZE = 0x00000c00; // 3 KB (96 entries max)

export const ESP_SECURE_CERT_OFFSET = 0x0000d000;
export const ESP_SECURE_CERT_SIZE = 0x00002000;

export const NVS_OFFSET = 0x0000f000;
export const NVS_SIZE = 0x00004000;

export const OTADATA_OFFSET = 0x00013000;
export const OTADATA_SIZE = 0x00002000; // 8 KB (two 4 KB sectors)
export const OTADATA_SECTOR_SIZE = 0x00001000; // 4 KB

export const PHY_INIT_OFFSET = 0x00015000;
export const PHY_INIT_SIZE = 0x00001000;

export const FACTORY_OFFSET = 0x00020000;
export const FACTORY_SIZE = 0x00400000; // 4 MB

export const OTA_0_OFFSET = 0x00420000;
export const OTA_0_SIZE = 0x00400000; // 4 MB

export const OTA_1_OFFSET = 0x00820000;
export const OTA_1_SIZE = 0x00400000; // 4 MB

export const MUSE_NVS_OFFSET = 0x00f21000;
export const MUSE_NVS_SIZE = 0x00010000; // 64 KB

export const APP_HEADER_READ_SIZE = 512;

export const ESP_IMAGE_HEADER_MAGIC = 0xe9;
export const ESP_APP_DESC_MAGIC = 0xabcd5432;
export const ESP_APP_DESC_OFFSET = 32; // 24-byte image header + 8-byte segment header
export const SECURE_BOOT_V2_SIGNATURE_MAGIC = 0xe7;
export const SECURE_BOOT_V2_SECTOR_SIZE = 4096;

export const OTA_STATE_VALID = 0x00000002;
export const OTA_STATE_NEW = 0x00000000;
export const OTA_STATE_PENDING_VERIFY = 0x00000001;
export const OTA_STATE_INVALID = 0x00000003;
export const OTA_STATE_ABORTED = 0x00000004;
export const OTA_STATE_UNDEFINED = 0xffffffff;

export interface PartitionSpec {
  name: string;
  type: number;
  subtype: number;
  offset: number;
  size: number;
}

export const EXPECTED_PARTITIONS: readonly PartitionSpec[] = [
  { name: 'esp_secure_cert', type: 0x3f, subtype: 0x06, offset: 0x0000d000, size: 0x00002000 },
  { name: 'nvs',             type: 0x01, subtype: 0x02, offset: 0x0000f000, size: 0x00004000 },
  { name: 'otadata',         type: 0x01, subtype: 0x00, offset: 0x00013000, size: 0x00002000 },
  { name: 'phy_init',        type: 0x01, subtype: 0x01, offset: 0x00015000, size: 0x00001000 },
  { name: 'factory',         type: 0x00, subtype: 0x00, offset: 0x00020000, size: 0x00400000 },
  { name: 'ota_0',           type: 0x00, subtype: 0x10, offset: 0x00420000, size: 0x00400000 },
  { name: 'ota_1',           type: 0x00, subtype: 0x11, offset: 0x00820000, size: 0x00400000 },
  { name: 'nvs_key',         type: 0x01, subtype: 0x04, offset: 0x00c20000, size: 0x00001000 },
  { name: 'spiffs',          type: 0x01, subtype: 0x82, offset: 0x00c21000, size: 0x00300000 },
] as const;

export const MUSE_NVS_PARTITION_SPEC: PartitionSpec = {
  name: 'muse_nvs',
  type: 0x01,
  subtype: 0x02,
  offset: MUSE_NVS_OFFSET,
  size: MUSE_NVS_SIZE,
};

export interface ProtectedRegion {
  name: string;
  start: number;
  end: number; // exclusive
  reason: string;
}

export const PROTECTED_REGIONS: readonly ProtectedRegion[] = [
  {
    name: 'Bootloader',
    start: 0x00000000,
    end: 0x0000c000,
    reason: 'Contains RSA-3072 Secure Boot V2 second-stage bootloader.',
  },
  {
    name: 'Partition Table',
    start: 0x0000c000,
    end: 0x0000d000,
    reason: 'Flash partition map at 0xC000 (only upgradable with verified WG1200+muse_nvs dual-boot table).',
  },
  {
    name: 'ESP Secure Cert & WeatherXM NVS',
    start: 0x0000d000,
    end: 0x00013000,
    reason: 'Stores hardware certificate (0xD000) and WeatherXM station NVS (0xF000).',
  },
  {
    name: 'PHY Init',
    start: 0x00015000,
    end: 0x00020000,
    reason: 'Stores RF PHY calibration data (0x15000).',
  },
  {
    name: 'Factory Recovery Slot',
    start: 0x00020000,
    end: 0x00420000,
    reason: 'Immutable factory WeatherXM recovery firmware.',
  },
  {
    name: 'NVS Encryption Keys & SPIFFS',
    start: 0x00c20000,
    end: 0x00f21000,
    reason: 'Stores NVS encryption keys (0xC20000) and WeatherXM SPIFFS filesystem (0xC21000).',
  },
] as const;
