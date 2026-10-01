import { V4Channel } from 'dglab-kit';
import type { DeviceManager } from './device-manager';

/**
 * 紧急停止：清空所有 APP 的全部任务，并把每个设备的双通道强度归零。
 * 任何时候用户点了急停，或页面隐藏/关闭、连接断开时都应调用。
 */
export async function emergencyStop(dm: DeviceManager): Promise<void> {
  const socket = dm.raw;
  if (!socket || !dm.connected) return;

  const devices = dm.listDevices();
  for (const device of devices) {
    await socket.clearOperate(device.clientId, { slotId: device.slotId }).catch(() => undefined);
    await socket
      .resetIntensity(device.clientId, device.slotId, V4Channel.A)
      .catch(() => undefined);
    await socket
      .resetIntensity(device.clientId, device.slotId, V4Channel.B)
      .catch(() => undefined);
  }
}

/** 安装全局安全网：页面隐藏/关闭/刷新时自动清理设备任务 */
export function installSafetyNet(dm: DeviceManager): void {
  const cleanup = () => {
    void emergencyStop(dm);
  };
  window.addEventListener('beforeunload', cleanup);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') cleanup();
  });
}
