import { SERIAL_MONITOR_BAUD } from '../flasher/constants';

// Shared with web-flasher/index.html and muse_full_setup.html, so a token saved
// by any of the three tools on the same origin is picked up by the others.
export const MUSE_SDK_TOKEN_STORAGE_KEY = 'muse-sdk-token';
const LEGACY_SDK_TOKEN_STORAGE_KEY = 'muse_sdk_token';
// The same check as esp32/cmake/validate_config.cmake: "mgst_", then base64url
// of 32 bytes, whose last character carries only four bits.
export const MUSE_SDK_TOKEN_REGEX = /^mgst_[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;

export interface SdkTokenValidation {
  valid: boolean;
  empty: boolean;
  reason: string;
}

export function validateSdkToken(raw: string): SdkTokenValidation {
  const trimmed = raw.trim();
  if (!trimmed) {
    return {
      valid: false,
      empty: true,
      reason: 'Optional during flash (can be injected later via USB Serial).',
    };
  }
  if (!trimmed.startsWith('mgst_')) {
    return {
      valid: false,
      empty: false,
      reason: 'Token must start with "mgst_".',
    };
  }
  if (trimmed.length !== 48) {
    return {
      valid: false,
      empty: false,
      reason: `Token must be 48 characters ("mgst_" + 43 base64url chars); got ${trimmed.length}.`,
    };
  }
  if (!MUSE_SDK_TOKEN_REGEX.test(trimmed)) {
    return {
      valid: false,
      empty: false,
      reason: 'Invalid 256-bit base64url checksum tail character.',
    };
  }
  return {
    valid: true,
    empty: false,
    reason: 'Valid 48-char Muse Gadget SDK token (mgst_...).',
  };
}

export function getStoredSdkToken(): string {
  if (typeof window === 'undefined') return '';
  try {
    const current = localStorage.getItem(MUSE_SDK_TOKEN_STORAGE_KEY);
    if (current) return current;
    const legacy = localStorage.getItem(LEGACY_SDK_TOKEN_STORAGE_KEY) || '';
    if (legacy) {
      localStorage.setItem(MUSE_SDK_TOKEN_STORAGE_KEY, legacy);
      localStorage.removeItem(LEGACY_SDK_TOKEN_STORAGE_KEY);
    }
    return legacy;
  } catch {
    return '';
  }
}

export function setStoredSdkToken(token: string): void {
  if (typeof window === 'undefined') return;
  try {
    const trimmed = token.trim();
    if (trimmed) {
      localStorage.setItem(MUSE_SDK_TOKEN_STORAGE_KEY, trimmed);
    } else {
      localStorage.removeItem(MUSE_SDK_TOKEN_STORAGE_KEY);
    }
    localStorage.removeItem(LEGACY_SDK_TOKEN_STORAGE_KEY);
  } catch {
    // ignore storage errors
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export interface SerialCommandOptions {
  /** Passed to navigator.serial.requestPort(), e.g. WG1200 USB filters. */
  requestOptions?: SerialPortRequestOptions;
  onLog?: (msg: string) => void;
  timeoutMs?: number;
  /** How long to wait for an answer before sending the command again. */
  retryMs?: number;
}

/** How a console command line reads in the log: tokens redacted, long values shortened. */
function describeCommandLine(line: string): string {
  return line
    .replace(/(>sdk_token=mgst_[A-Za-z0-9_-]{7}).*/, '$1...')
    .replace(/^(>card\.prompt\+?=)(.*)$/, (_, cmd: string, v: string) => `${cmd}(${v.length} chars)`);
}

/**
 * Sends console command lines over Web Serial until a line matches
 * `answerPattern` (as web-flasher/sdk-token.js does): opening the port can
 * restart the gadget, so a single write is easily lost while it boots. Several
 * lines go out in order each round. Returns the first match, or null on
 * timeout. Commands are logged with any token redacted.
 */
export async function sendSerialConsoleCommand(
  commandLines: string | string[],
  answerPattern: RegExp,
  options: SerialCommandOptions = {},
): Promise<{ match: RegExpMatchArray | null; lines: string[] }> {
  const { requestOptions, onLog, timeoutMs = 20000, retryMs = 2500 } = options;
  if (!('serial' in navigator)) {
    throw new Error('Web Serial API is not supported in this browser.');
  }

  const port = await navigator.serial.requestPort(requestOptions);
  try {
    await port.open({ baudRate: SERIAL_MONITOR_BAUD });
  } catch (err) {
    throw new Error(
      `Couldn't open the port (${err instanceof Error ? err.message : String(err)}). Disconnect the flasher session first.`,
    );
  }
  // Leave EN and BOOT alone on bridges that drive them.
  await port.setSignals({ dataTerminalReady: false, requestToSend: false }).catch(() => {});

  const lines: string[] = [];
  let match: RegExpMatchArray | null = null;
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
        onLog?.(`[UART] ${line}`);
        match ??= line.match(answerPattern);
      }
    }
  })().catch(() => {});

  const commands = Array.isArray(commandLines) ? commandLines : [commandLines];
  try {
    const deadline = Date.now() + timeoutMs;
    await sleep(800); // a gadget restarted by the port opening boots first
    while (!match && Date.now() < deadline) {
      for (const [i, line] of commands.entries()) {
        onLog?.(`Sending ${describeCommandLine(line)} over USB Serial...`);
        const writer = port.writable!.getWriter();
        try {
          await writer.write(new TextEncoder().encode(`\n${line}\n`));
        } finally {
          writer.releaseLock();
        }
        // Let the console finish one (an NVS write) before the next.
        if (i + 1 < commands.length) await sleep(150);
      }
      const wait = Date.now() + retryMs;
      while (!match && Date.now() < wait) await sleep(100);
    }
  } finally {
    await reader.cancel().catch(() => {});
    await reading;
    reader.releaseLock();
    await port.close().catch(() => {});
  }

  return { match, lines };
}

/** Resolves when the gadget stored the token; throws with its reason otherwise. */
export async function injectSdkTokenOverUsbSerial(
  token: string,
  options: SerialCommandOptions = {},
): Promise<void> {
  const check = validateSdkToken(token);
  if (!check.valid) {
    throw new Error(`Invalid SDK token: ${check.reason}`);
  }
  const { match } = await sendSerialConsoleCommand(
    `>sdk_token=${token.trim()}`,
    /@sdk_token (ok|error \S+)/,
    { timeoutMs: 25000, retryMs: 3000, ...options },
  );
  const answer = match?.[1];
  if (answer === 'ok') return;
  if (answer === 'error invalid') throw new Error('The gadget says that isn\'t an SDK token.');
  if (answer) throw new Error(`The gadget couldn't store the token (${answer}).`);
  throw new Error(
    'The gadget didn\'t answer. Check it runs Muse and you picked its console port. ' +
      'If it still doesn\'t answer, unplug it, plug it back in and try again.',
  );
}

export interface BootWeatherXmResult {
  wxm_label?: string;
  wxm_project?: string;
  wxm_version?: string;
  [key: string]: unknown;
}

/** Asks a running Muse to boot stock WeatherXM; resolves with the slot it picked. */
export async function sendSwitchToWeatherXmOverUsbSerial(
  options: SerialCommandOptions = {},
): Promise<BootWeatherXmResult> {
  const { match } = await sendSerialConsoleCommand('>boot.weatherxm', /@boot\.weatherxm\s+(\{.*\})/, {
    timeoutMs: 15000,
    ...options,
  });
  if (match) {
    try {
      const answer = JSON.parse(match[1]) as { ok?: boolean; payload?: BootWeatherXmResult };
      if (answer.ok !== false) return answer.payload ?? {};
    } catch {
      return {};
    }
  }
  throw new Error(
    'The WG1200 didn\'t answer >boot.weatherxm. You can also hold the top button for 10 seconds, ' +
      'tap Settings → WeatherXM on the touchscreen, or run ./esp32/tools/wg1200_dualboot.sh boot-weatherxm',
  );
}
