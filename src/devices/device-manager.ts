import {
  DGLAB_SOCKET_STATE,
  DglabSocket,
  DglabSocketDeviceType,
  type DglabSocketCloseEvent,
  type DglabSocketDeviceEventPayload,
  type DglabSocketV4Client,
  type V4DeviceInfo,
} from 'dglab-kit';
import { DEFAULT_RELAY, type TrackedDevice } from './types';

type Listener = () => void;

/**
 * 设备管理器：封装 DglabSocket 生命周期与设备发现。
 * 维护 clientId -> slotId -> TrackedDevice 的缓存，
 * 通过 subscribe() 向 UI 广播变化。
 */
export class DeviceManager {
  private socket: DglabSocketV4Client | null = null;
  private devices = new Map<string, Map<string, TrackedDevice>>();
  private listeners = new Set<Listener>();

  state: DGLAB_SOCKET_STATE = DGLAB_SOCKET_STATE.Idle;
  relayUrl: string = DEFAULT_RELAY;
  targetId = '';
  pairingUrl = '';
  lastError = '';

  get connected(): boolean {
    return this.state === DGLAB_SOCKET_STATE.Paired;
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    for (const fn of this.listeners) fn();
  }

  async connect(relayUrl: string = DEFAULT_RELAY): Promise<void> {
    await this.disconnect();
    this.relayUrl = relayUrl;
    this.lastError = '';
    this.state = DGLAB_SOCKET_STATE.Connecting;
    this.emit();

    const socket = new DglabSocket({
      url: relayUrl,
      connectTimeout: 10000,
      responseTimeout: 10000,
    }) as DglabSocketV4Client;

    this.socket = socket;
    this.bindEvents(socket);

    try {
      const { targetId } = await socket.connect();
      this.targetId = targetId;
      // 注意：实测官方中继不接受 /v4/?tid= （带尾斜杠会握手被拒），
      // 必须拼成 /v4?tid=；base 也支持自部署中继地址
      const base = this.relayUrl.replace(/\/+$/, '');
      this.pairingUrl = `${base}?tid=${targetId}`;
      // 官方 APP 扫码跳转链接
      this.appLink = `https://dungeon-lab.cn/s/?v=1&action=socket&url=${encodeURIComponent(this.pairingUrl)}`;
      this.emit();
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      this.state = DGLAB_SOCKET_STATE.Disconnected;
      this.emit();
      throw err;
    }
  }

  /** 官方 APP 扫码链接（含 targetId），供二维码使用 */
  appLink = '';

  private bindEvents(socket: DglabSocketV4Client): void {
    socket.on('state', (state, previous) => {
      this.state = state;
      if (state !== DGLAB_SOCKET_STATE.Paired && previous === DGLAB_SOCKET_STATE.Paired) {
        // 掉线时清空缓存，避免 UI 展示幽灵设备
        this.devices.clear();
      }
      this.emit();
    });

    socket.on('client-attached', (clientId: string) => {
      void this.refreshDevices(clientId);
      this.emit();
    });

    socket.on('client-disconnected', (clientId: string) => {
      this.devices.delete(clientId);
      this.emit();
    });

    socket.on('device', (event: DglabSocketDeviceEventPayload, clientId: string) => {
      this.applyDeviceEvent(clientId, event);
      this.emit();
    });

    socket.on('error', (error: unknown) => {
      this.lastError = error instanceof Error ? error.message : String(error);
      this.emit();
    });

    socket.on('close', (event: DglabSocketCloseEvent) => {
      if (this.state !== DGLAB_SOCKET_STATE.Idle) {
        this.state = DGLAB_SOCKET_STATE.Disconnected;
      }
      if (event.code !== 1000 && !this.lastError) {
        this.lastError = `连接关闭 (${event.code}) ${event.reason}`.trim();
      }
      this.emit();
    });
  }

  private async refreshDevices(clientId: string): Promise<void> {
    const socket = this.socket;
    if (!socket) return;
    try {
      const { devices } = await socket.requestDevices(clientId);
      const map = this.devices.get(clientId) ?? new Map<string, TrackedDevice>();
      this.devices.set(clientId, map);
      for (const device of devices as V4DeviceInfo[]) {
        map.set(device.slotId, {
          clientId,
          slotId: device.slotId,
          name: device.name,
          type: device.type,
          props: { ...(device.props ?? {}) },
          slotState: { ...(device.slotState ?? {}) },
        });
      }
      this.emit();
    } catch {
      /* 设备列表获取失败不致命，后续 patch 事件会补齐 */
    }
  }

  private applyDeviceEvent(clientId: string, event: DglabSocketDeviceEventPayload): void {
    const removed = 'removed' in event && event.removed === true;
    const info = event as Partial<V4DeviceInfo> & { slotId: string };
    const map = this.devices.get(clientId) ?? new Map<string, TrackedDevice>();
    this.devices.set(clientId, map);

    if (removed) {
      map.delete(info.slotId);
      return;
    }

    const existing = map.get(info.slotId);
    if (existing) {
      Object.assign(existing.props, info.props ?? {});
      Object.assign(existing.slotState, info.slotState ?? {});
      if (info.name) existing.name = info.name;
      if (info.type) existing.type = info.type;
    } else {
      map.set(info.slotId, {
        clientId,
        slotId: info.slotId,
        name: info.name ?? info.slotId,
        type: info.type ?? DglabSocketDeviceType.COYOTE_030,
        props: { ...(info.props ?? {}) },
        slotState: { ...(info.slotState ?? {}) },
      });
    }
  }

  /** 全量设备列表（跨 APP 聚合） */
  listDevices(): TrackedDevice[] {
    const out: TrackedDevice[] = [];
    for (const map of this.devices.values()) {
      out.push(...map.values());
    }
    return out;
  }

  listByType(type: TrackedDevice['type']): TrackedDevice[] {
    return this.listDevices().filter((d) => d.type === type);
  }

  /** 灵猫压力值；无设备返回 null */
  getPressure(): number | null {
    const bmtr = this.listByType(DglabSocketDeviceType.BMTR_1)[0];
    if (!bmtr) return null;
    const v = bmtr.props.pressure;
    return typeof v === 'number' ? v : null;
  }

  async disconnect(): Promise<void> {
    const socket = this.socket;
    this.socket = null;
    this.devices.clear();
    this.targetId = '';
    this.pairingUrl = '';
    this.appLink = '';
    if (socket) {
      try {
        await socket.destroy();
      } catch {
        /* ignore */
      }
    }
    this.state = DGLAB_SOCKET_STATE.Idle;
    this.emit();
  }

  /** 供 FeedbackEngine 使用的原始 socket（可能为 null） */
  get raw(): DglabSocketV4Client | null {
    return this.socket;
  }

  /** 设备通道强度上限（comfortLimit 计算结果），未知时给保守默认 */
  channelMax(device: TrackedDevice, channel: 'A' | 'B'): number {
    const key = channel === 'A' ? 'channelA' : 'channelB';
    const ch = device.slotState[key] as { intensityMax?: number } | undefined;
    if (ch && typeof ch.intensityMax === 'number' && ch.intensityMax > 0) {
      return ch.intensityMax;
    }
    return 100;
  }

  /** 当前实际强度（用于 UI 回显） */
  channelIntensity(device: TrackedDevice, channel: 'A' | 'B'): number | null {
    const key = channel === 'A' ? 'intensityA' : 'intensityB';
    const v = device.props[key];
    return typeof v === 'number' ? v : null;
  }
}
