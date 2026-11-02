import { SERIAL_MONITOR_BAUD } from './constants';
import type { FirmwareFlavor } from './appDescriptor';

export interface PostBootMonitorResult {
  /** The flavor seen in the boot log, or expectedFlavor when nothing was seen. */
  detectedFlavor: FirmwareFlavor;
  /** True only when a boot banner, flavor line or token answer was actually read. */
  bootConfirmed: boolean;
  sdkTokenAcked: boolean;
  /** The gadget's `@sdk_token error …` answer, or why the token couldn't be sent. */
  sdkTokenError: string | null;
  /** The ROM printed its download-mode banner: the chip didn't boot an app. */
  downloadMode: boolean;
  lines: string[];
}

export interface PostBootMonitorOptions {
  port: SerialPort;
  expectedFlavor: FirmwareFlavor;
  sdkTokenToInject?: string;
  timeoutMs?: number;
  /** How long to look for the port again after a reset re-enumerates USB. */
  reopenTimeoutMs?: number;
  onLine?: (line: string) => void;
}

const SDK_TOKEN_RETRY_MS = 2500;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Boot-log line -> firmware flavor, or null when the line says nothing about it. */
export function classifyBootLine(line: string): FirmwareFlavor | null {
  const lower = line.toLowerCase();
  // ESP-IDF bootloader: "boot: Loaded app from partition at offset 0x820000".
  const loaded = lower.match(/loaded app from partition at offset 0x([0-9a-f]+)/);
  if (loaded) {
    const offset = parseInt(loaded[1], 16);
    if (offset === 0x820000) return 'muse';
    if (offset === 0x420000 || offset === 0x20000) return 'weatherxm';
  }
  if (
    lower.includes('muse-gadget') ||
    lower.includes('muse gadget') ||
    lower.includes('link.main') ||
    lower.includes('link.identity') ||
    lower.includes('muse_ble') ||
    lower.includes('muse_homelink') ||
    lower.includes('gadget_config') ||
    line.includes('@sdk_token')
  ) {
    return 'muse';
  }
  if (lower.includes('wg1010') || lower.includes('weatherxm') || lower.includes('m5_gateway')) {
    return 'weatherxm';
  }
  return null;
}

/** The ROM's banner when it reset into the serial loader instead of booting an app. */
export function isDownloadModeLine(line: string): boolean {
  return /boot:0x[0-9a-f]+ \(download|waiting for download/i.test(line);
}

function sameUsbDevice(a: SerialPortInfo, b: SerialPortInfo): boolean {
  return (
    a.usbVendorId !== undefined &&
    a.usbVendorId === b.usbVendorId &&
    a.usbProductId === b.usbProductId
  );
}

/**
 * Opens the console after a hard reset. The ESP32-S3's USB-JTAG port drops off
 * the bus when the chip resets and comes back as a new SerialPort, so when the
 * original port won't open, this looks for the same USB device in getPorts()
 * (Chrome keeps the permission because the S3 reports its MAC as serial number).
 */
async function openConsolePort(
  original: SerialPort,
  timeoutMs: number,
): Promise<SerialPort | null> {
  const info = original.getInfo?.() ?? {};
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const candidates: SerialPort[] = [original];
    try {
      for (const p of await navigator.serial.getPorts()) {
        if (p !== original && sameUsbDevice(p.getInfo?.() ?? {}, info)) candidates.push(p);
      }
    } catch {
      // getPorts() unavailable; keep trying the original port
    }
    for (const port of candidates) {
      try {
        if (!port.readable) {
          await port.open({ baudRate: SERIAL_MONITOR_BAUD });
        }
        // Leave EN and BOOT alone: on the CH340 bridge DTR/RTS drive them.
        await port.setSignals({ dataTerminalReady: false, requestToSend: false }).catch(() => {});
        return port;
      } catch {
        // not back yet
      }
    }
    await sleep(250);
  }
  return null;
}

/**
 * Opens the console at 115200 baud after a hard reset, reads the boot log to see
 * whether Muse or WeatherXM came up, and, for Muse with sdkTokenToInject, sends
 * `>sdk_token=…` every 2.5 s until the gadget answers `@sdk_token ok` or
 * `@sdk_token error …` (as web-flasher/sdk-token.js does).
 */
export async function monitorPostBootAndInjectToken(
  options: PostBootMonitorOptions,
): Promise<PostBootMonitorResult> {
  const {
    port: originalPort,
    expectedFlavor,
    sdkTokenToInject,
    timeoutMs = sdkTokenToInject ? 20000 : 8000,
    reopenTimeoutMs = 5000,
    onLine,
  } = options;

  const lines: string[] = [];
  // Written by the read loop below; `as` keeps TS from narrowing them to null.
  let detectedFlavor = null as FirmwareFlavor | null;
  let tokenAnswer = null as string | null;
  let downloadMode = false as boolean;
  const wantsToken = expectedFlavor === 'muse' && Boolean(sdkTokenToInject);

  // Give a USB-JTAG reset time to drop the old device before opening.
  await sleep(300);
  const port = await openConsolePort(originalPort, reopenTimeoutMs);
  if (!port) {
    onLine?.('[USB Serial] Could not reopen the console port after reset.');
    return {
      detectedFlavor: expectedFlavor,
      bootConfirmed: false,
      sdkTokenAcked: false,
      sdkTokenError: wantsToken ? 'console port did not come back after reset' : null,
      downloadMode: false,
      lines,
    };
  }

  const reader = port.readable!.getReader();
  const reading = (async () => {
    const decoder = new TextDecoder();
    let text = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      text += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = text.indexOf('\n')) >= 0) {
        const line = text.slice(0, nl).replace(/\r$/, '').trim();
        text = text.slice(nl + 1);
        if (!line) continue;
        lines.push(line);
        onLine?.(`[UART] ${line}`);
        const flavor = classifyBootLine(line);
        if (flavor) detectedFlavor = flavor;
        if (isDownloadModeLine(line)) downloadMode = true;
        const ack = line.match(/@sdk_token (ok|error \S+)/);
        if (ack) tokenAnswer = ack[1];
      }
    }
  })().catch(() => {
    // the port went away (USB-JTAG re-enumerated again) or was cancelled
  });

  const encoder = new TextEncoder();
  let nextSendAt = Date.now() + 1000; // let the app's console come up first
  const deadline = Date.now() + timeoutMs;

  try {
    while (Date.now() < deadline) {
      if (tokenAnswer || downloadMode) break;
      if (detectedFlavor === 'weatherxm' && expectedFlavor === 'muse') break;
      if (!wantsToken && detectedFlavor) break;

      if (wantsToken && Date.now() >= nextSendAt && detectedFlavor !== 'weatherxm') {
        nextSendAt = Date.now() + SDK_TOKEN_RETRY_MS;
        if (port.writable) {
          onLine?.(`[USB Serial] Sending >sdk_token=${sdkTokenToInject!.slice(0, 12)}…`);
          const writer = port.writable.getWriter();
          try {
            await writer.write(encoder.encode(`\n>sdk_token=${sdkTokenToInject}\n`));
          } catch (err) {
            onLine?.(
              `[USB Serial] SDK token write failed: ${err instanceof Error ? err.message : String(err)}`,
            );
          } finally {
            writer.releaseLock();
          }
        }
      }
      await sleep(100);
    }
  } finally {
    await reader.cancel().catch(() => {});
    await reading;
    try {
      reader.releaseLock();
    } catch {
      // ignore
    }
    await port.close().catch(() => {});
  }

  const answer = tokenAnswer;
  let sdkTokenError: string | null = null;
  if (wantsToken && answer !== 'ok') {
    if (answer) {
      sdkTokenError = answer === 'error invalid' ? 'the gadget says that is not an SDK token' : answer;
    } else if (downloadMode) {
      sdkTokenError = 'the WG1200 restarted into download mode instead of booting';
    } else if (detectedFlavor === 'weatherxm') {
      sdkTokenError = 'WeatherXM booted instead of Muse';
    } else {
      sdkTokenError = 'no @sdk_token answer from the gadget';
    }
  }

  return {
    detectedFlavor: detectedFlavor ?? expectedFlavor,
    bootConfirmed: !downloadMode && (detectedFlavor !== null || answer !== null),
    sdkTokenAcked: answer === 'ok',
    sdkTokenError,
    downloadMode,
    lines,
  };
}
