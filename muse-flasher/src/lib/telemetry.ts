export interface TelemetryPayload {
  eventType: 'flash_success' | 'flash_error' | 'ble_provision_success' | 'ble_provision_error';
  deviceModel: string;
  targetFirmware: string;
  targetVersion: string;
  previousFirmware?: string;
  previousVersion?: string;
  mode?: string;
  durationMs?: number;
  errorMessage?: string;
}

export async function sendTelemetryEvent(payload: TelemetryPayload): Promise<void> {
  try {
    await fetch('/api/telemetry', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch {
    // Telemetry is best-effort
  }
}
