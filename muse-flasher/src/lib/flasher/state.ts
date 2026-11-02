import type { ParsedAppDescriptor, FirmwareFlavor } from './appDescriptor';
import type { UsbLink } from './constants';
import type { DeviceIdentity } from './identity';
import type { FirmwareManifest, FirmwareTargetId } from './manifest';
import type { ActiveBootSlot, ParsedOtadata } from './otadata';
import type { PartitionValidationResult } from './partitions';

export type ConnectionStage =
  | 'disconnected'
  | 'connecting'
  | 'inspecting'
  | 'ready'
  | 'flashing'
  | 'verifying'
  | 'rebooting'
  | 'complete'
  | 'error';

export interface DeviceInspectionSnapshot {
  chipName: string;
  flashSizeBytes: number;
  /** Which of the WG1200's two USB ports this session uses. */
  usbLink: UsbLink;
  identity: DeviceIdentity;
  partitionValidation: PartitionValidationResult;
  otadata: ParsedOtadata;
  otadataRaw: Uint8Array;
  factoryApp: ParsedAppDescriptor;
  ota0App: ParsedAppDescriptor;
  ota1App: ParsedAppDescriptor;
  activeSlot: ActiveBootSlot;
  activeApp: ParsedAppDescriptor;
  activeFlavor: FirmwareFlavor;
}

export interface FlashProgressInfo {
  stageLabel: string;
  subLabel: string;
  percent: number;
  bytesWritten: number;
  bytesTotal: number;
}

export interface FlasherState {
  stage: ConnectionStage;
  manifest: FirmwareManifest | null;
  device: DeviceInspectionSnapshot | null;
  progress: FlashProgressInfo | null;
  lastCompletedTarget: FirmwareTargetId | null;
  lastCompletedFlavor: FirmwareFlavor | null;
  lastOperationMode: 'instant-switch' | 'full-flash' | 'factory-reset' | null;
  lastSdkTokenInjected: boolean;
  /** False when the post-flash console never showed a boot line or token answer. */
  lastBootConfirmed: boolean;
  /** Why the automatic `>sdk_token=` injection failed, if it was attempted. */
  lastSdkTokenError: string | null;
  /** The chip reset into its serial download mode instead of booting an app. */
  lastBootDownloadMode: boolean;
  errorMessage: string | null;
}

export const INITIAL_FLASHER_STATE: FlasherState = {
  stage: 'disconnected',
  manifest: null,
  device: null,
  progress: null,
  lastCompletedTarget: null,
  lastCompletedFlavor: null,
  lastOperationMode: null,
  lastSdkTokenInjected: false,
  lastBootConfirmed: false,
  lastSdkTokenError: null,
  lastBootDownloadMode: false,
  errorMessage: null,
};
