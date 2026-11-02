// Paced Web Serial writes, ported from web-flasher/paced-serial.js.
//
// The WG1200's CH340 UART bridge (1a86:7523) has no flow control and drops
// bytes when a whole esptool packet arrives faster than the UART drains it, so
// the stub upload or the first flash block fails. While pacing is set, every
// matching SerialPort's writable stream sends small chunks with a pause after
// each. esptool-js's Transport takes a writer from port.writable for each
// write, so it picks this up without changes. The ESP32-S3's own USB-JTAG port
// (303a:1001) is native USB and is never paced.

export interface PacingSettings {
  /** Bytes per write. */
  chunk: number;
  /** How many times as long as a chunk takes on the wire to wait after it. */
  factor: number;
  /** Only ports from this USB vendor are paced. */
  usbVendorId?: number;
}

export interface PacedSerialControl {
  set(settings: PacingSettings | null): void;
}

export const CH340_USB_VENDOR_ID = 0x1a86;
export const WG1200_CH340_PACING: PacingSettings = {
  chunk: 32,
  factor: 2,
  usbVendorId: CH340_USB_VENDOR_ID,
};

/** Pacing for a port: only the CH340 bridge is paced, never native USB. */
export function pacingForPort(info: SerialPortInfo | undefined): PacingSettings | null {
  return info?.usbVendorId === CH340_USB_VENDOR_ID ? WG1200_CH340_PACING : null;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let installed: PacedSerialControl | null = null;

/**
 * Patches SerialPort.prototype once; returns null where Web Serial is missing
 * (SSR, tests, non-Chromium browsers).
 */
export function installPacedSerial(): PacedSerialControl | null {
  if (installed) return installed;
  const SerialPortClass = (globalThis as { SerialPort?: { prototype: SerialPort } }).SerialPort;
  if (!SerialPortClass) return null;

  const proto = SerialPortClass.prototype;
  const writable = Object.getOwnPropertyDescriptor(proto, 'writable');
  if (!writable?.get) return null;
  const open = proto.open;
  const baudRates = new WeakMap<SerialPort, number>(); // port -> baud rate it was opened at
  const paced = new WeakMap<WritableStream<Uint8Array>, WritableStream<Uint8Array>>();
  let pacing: PacingSettings | null = null;

  proto.open = function (this: SerialPort, options: SerialOptions) {
    baudRates.set(this, options.baudRate);
    return open.call(this, options);
  };

  Object.defineProperty(proto, 'writable', {
    configurable: true,
    get(this: SerialPort) {
      const real = writable.get!.call(this) as WritableStream<Uint8Array> | null;
      if (!pacing || !real) return real;
      if (pacing.usbVendorId !== undefined && this.getInfo?.().usbVendorId !== pacing.usbVendorId) {
        return real;
      }
      let stream = paced.get(real);
      if (!stream) {
        const port = this;
        // Lock the port's stream only while writing, so port.close() can run
        // between writes.
        const withWriter = async (fn: (writer: WritableStreamDefaultWriter<Uint8Array>) => Promise<void>) => {
          const writer = real.getWriter();
          try {
            await fn(writer);
          } finally {
            writer.releaseLock();
          }
        };
        stream = new WritableStream<Uint8Array>({
          write: (data) =>
            withWriter(async (writer) => {
              const { chunk: size, factor } = pacing ?? { chunk: 64, factor: 1 };
              const bytes = new Uint8Array(data);
              for (let i = 0; i < bytes.length; i += size) {
                const chunk = bytes.slice(i, i + size);
                await writer.write(chunk);
                // 10 bits a byte on the wire, rounded up: Web Serial can't wait
                // for the UART to drain the way pyserial's flush() does.
                await sleep(
                  Math.ceil((chunk.length * 10 * 1000 * factor) / (baudRates.get(port) || 115200)),
                );
              }
            }),
          close: () => withWriter((writer) => writer.close()),
          abort: (reason) => real.abort(reason),
        });
        paced.set(real, stream);
      }
      return stream;
    },
  });

  installed = {
    set(settings) {
      pacing = settings ? { ...settings } : null;
    },
  };
  return installed;
}
