import { describe, expect, it } from 'vitest';
import {
  WG1200_USB_FILTERS,
  classifyUsbLink,
  describeUsbLink,
} from '../src/lib/flasher/constants';
import { WG1200_CH340_PACING, pacingForPort } from '../src/lib/flasher/pacedSerial';

describe('WG1200 USB ports', () => {
  it('lists only the native USB-JTAG port by default', () => {
    expect(WG1200_USB_FILTERS).toEqual([{ usbVendorId: 0x303a, usbProductId: 0x1001 }]);
  });

  it('never paces the native USB-JTAG port', () => {
    expect(pacingForPort({ usbVendorId: 0x303a, usbProductId: 0x1001 })).toBeNull();
    expect(pacingForPort(undefined)).toBeNull();
    expect(pacingForPort({})).toBeNull();
  });

  it('paces only the CH340 bridge', () => {
    expect(pacingForPort({ usbVendorId: 0x1a86, usbProductId: 0x7523 })).toBe(WG1200_CH340_PACING);
  });

  it('names the link for the log and device panel', () => {
    expect(classifyUsbLink({ usbVendorId: 0x303a })).toBe('usb-jtag');
    expect(classifyUsbLink({ usbVendorId: 0x1a86 })).toBe('ch340');
    expect(classifyUsbLink({ usbVendorId: 0x10c4 })).toBe('other');
    expect(describeUsbLink({ usbVendorId: 0x303a, usbProductId: 0x1001 })).toBe('native USB-JTAG (303a:1001)');
    expect(describeUsbLink({ usbVendorId: 0x1a86, usbProductId: 0x7523 })).toContain('CH340');
  });
});

describe('ESP32-S3 native USB handling', () => {
  it('uses esptool.py\'s USB-JTAG port number and force-download register', async () => {
    const t = await import('../src/lib/flasher/transport');
    // esptool.py targets/esp32s3.py: UARTDEV_BUF_NO_USB_JTAG_SERIAL = 4 (3 is USB-OTG).
    expect(t.S3_UARTDEV_BUF_NO).toBe(0x3fcef14c);
    expect(t.S3_UARTDEV_BUF_NO_USB_JTAG_SERIAL).toBe(4);
    expect(t.S3_RTC_CNTL_OPTION1_REG).toBe(0x6000812c);
    expect(t.S3_RTC_CNTL_FORCE_DOWNLOAD_BOOT_MASK).toBe(1);
  });

  it('recognizes the ROM download-mode banner after a reset', async () => {
    const { isDownloadModeLine } = await import('../src/lib/flasher/serialLog');
    expect(isDownloadModeLine('rst:0x15 (USB_UART_CHIP_RESET),boot:0x0 (DOWNLOAD(USB/UART0))')).toBe(true);
    expect(isDownloadModeLine('waiting for download')).toBe(true);
    expect(isDownloadModeLine('rst:0x15 (USB_UART_CHIP_RESET),boot:0x8 (SPI_FAST_FLASH_BOOT)')).toBe(false);
    expect(isDownloadModeLine('I (944) link.app:   SDK token:  mgst_AbCdEfG')).toBe(false);
  });
});

describe('READ_FLASH over the esptool-js stub', () => {
  it('returns the data, acks each packet and consumes the trailing MD5 digest', async () => {
    const esptool = await import('esptool-js');
    await import('../src/lib/flasher/transport');
    const data = Uint8Array.from({ length: 8 }, (_, i) => i + 1);
    const queue: Uint8Array[] = [data.subarray(0, 4), data.subarray(4), new Uint8Array(16)];
    const timeouts: number[] = [];
    const writes: Uint8Array[] = [];
    const fake = {
      IS_STUB: true,
      ESP_READ_FLASH: 0xd2,
      _appendArray: (a: Uint8Array, b: Uint8Array) => Uint8Array.from([...a, ...b]),
      _intToByteArray: (n: number) => Uint8Array.from([n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff]),
      checkCommand: async () => 0,
      transport: {
        read: async (timeout: number) => {
          timeouts.push(timeout);
          const next = queue.shift();
          if (!next) throw new Error('No serial data received.');
          return next;
        },
        write: async (b: Uint8Array) => {
          writes.push(b);
        },
      },
    };
    const out: Uint8Array = await (esptool.ESPLoader.prototype as any).readFlash.call(fake, 0x13000, 8);
    expect(Array.from(out)).toEqual(Array.from(data));
    expect(writes.map((w) => w[0])).toEqual([4, 8]); // acks carry the running total
    expect(queue).toHaveLength(0); // the digest was read, not left for the next command
    expect(timeouts.slice(0, 2)).toEqual([10000, 10000]); // not esptool-js's 100 s
  });
});
