// The WG1200 swipe-down card prompt template, kept on the gateway (muse_nvs)
// and set without reflashing over USB (">card.prompt=…") or the Companion BLE
// service ("card.prompt=…"). Mirrors esp32/components/muse/wg1200_card_prompt.h.

import { sendSerialConsoleCommand, type SerialCommandOptions } from './sdkToken';

export const CARD_PROMPT_MAX = 1023;
// A BLE write carries ~512 bytes; hatch.token uses the same chunk size.
export const CARD_PROMPT_CHUNK = 400;
export const CARD_PROMPT_PLACEHOLDERS = ['{weather}', '{location}', '{style}'] as const;

// Must match WG1200_CARD_PROMPT_DEFAULT (tests/muse.test.ts checks).
export const DEFAULT_CARD_PROMPT =
  'Weather: {weather} Station location: {location}. Draw my swipe-down forecast card. ' +
  "My saved card preferences (forecast providers or models, time range, location, " +
  "style, layout or anything else I've told you) override these defaults; use a " +
  "default only where I haven't said otherwise. Defaults: treat these readings as " +
  "ground truth, fetch today's hourly forecast for this location from multiple " +
  'models/providers, score each against the current conditions, and draw a 480x480 ' +
  'HOURLY forecast card for today from the best-fitting models, with exact values and ' +
  'the model sources noted on the card, in the "{style}" style. Always send the card ' +
  'via display.draw_file to this station.';

/** One line, as the console and the BLE command take it. */
export function normalizeCardPrompt(text: string): string {
  return text.replace(/\s*\r?\n\s*/g, ' ').trim();
}

export interface CardPromptCheck {
  ok: boolean;
  error?: string;
  /** Placeholders the template leaves out (allowed, but likely a mistake). */
  missing: string[];
}

export function checkCardPrompt(text: string): CardPromptCheck {
  const missing = CARD_PROMPT_PLACEHOLDERS.filter((p) => !text.includes(p));
  const bytes = new TextEncoder().encode(text).length;
  if (bytes > CARD_PROMPT_MAX) {
    return { ok: false, error: `Too long: ${bytes} of ${CARD_PROMPT_MAX} bytes.`, missing };
  }
  return { ok: true, missing };
}

/**
 * The commands that store `text`: card.prompt= with the first chunk, then
 * card.prompt+= for the rest. An empty text restores the built-in default.
 */
export function cardPromptCommands(text: string): string[] {
  // Chunks are measured in UTF-8 bytes (the gateway's limit) and never split
  // a character, so Greek or accented text stays intact.
  const encoder = new TextEncoder();
  const chunks: string[] = [];
  let chunk = '';
  let bytes = 0;
  for (const ch of text) {
    const size = encoder.encode(ch).length;
    if (bytes + size > CARD_PROMPT_CHUNK) {
      chunks.push(chunk);
      chunk = '';
      bytes = 0;
    }
    chunk += ch;
    bytes += size;
  }
  chunks.push(chunk);
  return chunks.map((c, i) => `${i === 0 ? 'card.prompt=' : 'card.prompt+='}${c}`);
}

export interface StoredCardPrompt {
  custom: boolean;
  len: number;
  text: string;
}

const ANSWER = /@card\.prompt (\{.*\})/;

function parseAnswer(match: RegExpMatchArray | null): StoredCardPrompt {
  if (!match) {
    throw new Error(
      "The gateway didn't answer card.prompt?. Check it runs Muse 0.1.0 or later and you picked its console port.",
    );
  }
  return JSON.parse(match[1]) as StoredCardPrompt;
}

/** Reads the template the gateway uses now over the USB console. */
export async function readCardPromptOverUsb(options: SerialCommandOptions = {}): Promise<StoredCardPrompt> {
  const { match } = await sendSerialConsoleCommand('>card.prompt?', ANSWER, { timeoutMs: 10000, ...options });
  return parseAnswer(match);
}

/** Stores `text` (empty: the built-in default) over USB, then reads it back to confirm. */
export async function writeCardPromptOverUsb(
  text: string,
  options: SerialCommandOptions = {},
): Promise<StoredCardPrompt> {
  const lines = [...cardPromptCommands(text).map((c) => `>${c}`), '>card.prompt?'];
  const { match } = await sendSerialConsoleCommand(lines, ANSWER, { timeoutMs: 15000, ...options });
  const stored = parseAnswer(match);
  const expected = text ? new TextEncoder().encode(text).length : DEFAULT_CARD_PROMPT.length;
  if (stored.custom !== Boolean(text) || stored.len !== expected) {
    throw new Error(`The gateway stored ${stored.len} chars, expected ${expected}. Try again.`);
  }
  return stored;
}
