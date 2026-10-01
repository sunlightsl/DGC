import type { DglabSocketDeviceType } from 'dglab-kit';

export const DEFAULT_RELAY = 'wss://trex.dungeon-lab.cn/v4';

export interface TrackedDevice {
  clientId: string;
  slotId: string;
  name: string;
  type: DglabSocketDeviceType;
  props: Record<string, unknown>;
  slotState: Record<string, unknown>;
}

export const DEVICE_TYPE_LABEL: Record<string, string> = {
  COYOTE_020: '郊狼 2.0',
  COYOTE_030: '郊狼 3.0',
  OVC_1: '负鼠',
  BMTR_1: '灵猫',
};
