import { COYOTE_WAVEFORMS, DglabSocketDeviceType, OVC_WAVEFORMS, V4Channel } from 'dglab-kit';
import type { Settings } from '../settings';
import type { DeviceManager } from './device-manager';
import type { TrackedDevice } from './types';
import { emergencyStop } from './safety';

export type FeedbackEvent = 'hit' | 'baseHit' | 'lowHpOn' | 'lowHpOff' | 'death' | 'bomb';

/** 最近一次设备输出（供对战页展示当前波形/强度） */
export interface LastOutput {
  label: string;
  intensity: number;
  at: number;
  source: 'hit' | 'shock' | 'punish' | 'death' | 'lowHp';
}

type CoyoteKey = keyof typeof COYOTE_WAVEFORMS;
type OvcKey = keyof typeof OVC_WAVEFORMS;

/** 系统级绝对强度上限：任何输出（含惩罚、倍率200%）都不可超过 */
export const SYSTEM_INTENSITY_CAP = 50;

const LOW_HP_WARN_RAW = 10;
const DEATH_BURST_RAW = 45;

function pick<T>(pool: T[]): T {
  return pool[Math.floor(Math.random() * pool.length)];
}

function randInt(min: number, max: number): number {
  return Math.floor(min + Math.random() * (max - min + 1));
}

/**
 * 反馈引擎：把游戏事件翻译成设备操作。
 * 波形从设置的多选池随机抽取，强度在 [min,max] 范围随机，
 * 再经过 设置倍率 × 设备实际上限 的双重钳制；
 * 受击类反馈用 immediate 顶掉同通道旧任务，避免队列堆积。
 *
 * 通道约定：事件反馈走设置的主通道；战败惩罚固定走另一通道，互不干扰。
 */
export class FeedbackEngine {
  private lowHpActive = false;
  private stopped = false;
  private punishTimer: ReturnType<typeof setInterval> | null = null;
  private punishRounds = 0;

  /** 最近一次输出，对战页轮询展示 */
  lastOutput: LastOutput | null = null;

  private recordOutput(source: LastOutput['source'], label: string, intensity: number): void {
    this.lastOutput = { label, intensity, at: Date.now(), source };
  }

  constructor(
    private dm: DeviceManager,
    private getSettings: () => Settings,
  ) {}

  /** 每局开始/急停恢复时调用 */
  reset(): void {
    this.lowHpActive = false;
    this.stopped = false;
    this.stopPunishmentTimer();
  }

  /** 紧急停止后锁定，直到 reset()；急停同时终止惩罚 */
  async stopAll(): Promise<void> {
    this.stopped = true;
    this.stopPunishmentTimer();
    await emergencyStop(this.dm);
  }

  get isPunishing(): boolean {
    return this.punishTimer !== null;
  }

  get punishRound(): number {
    return this.punishRounds;
  }

  fire(event: FeedbackEvent): void {
    if (this.stopped) return;
    const s = this.getSettings();
    switch (event) {
      case 'hit':
        this.hit(s);
        break;
      case 'baseHit':
        this.baseHit(s);
        break;
      case 'lowHpOn':
        this.lowHpOn(s);
        break;
      case 'lowHpOff':
        this.lowHpOff();
        break;
      case 'death':
        void this.death(s);
        break;
      case 'bomb':
        this.bomb(s);
        break;
    }
  }

  private coyote(): TrackedDevice | undefined {
    return (
      this.dm.listByType(DglabSocketDeviceType.COYOTE_030)[0] ??
      this.dm.listByType(DglabSocketDeviceType.COYOTE_020)[0]
    );
  }

  private ovc(): TrackedDevice | undefined {
    return this.dm.listByType(DglabSocketDeviceType.OVC_1)[0];
  }

  private mainChannel(s: Settings): V4Channel {
    return s.coyoteChannel === 'B' ? V4Channel.B : V4Channel.A;
  }

  /** 惩罚与所有反馈统一走用户配置的主通道 */
  private punishChannel(s: Settings): V4Channel {
    return this.mainChannel(s);
  }

  private channelName(ch: V4Channel): 'A' | 'B' {
    return ch === V4Channel.B ? 'B' : 'A';
  }

  /**
   * 唯一强度出口：实际输出 = min(原始值 × 全局倍率, 系统绝对上限, APP 舒适上限)
   * 公式刻意简化，保证用户怎么调都越不过安全边界。
   */
  private clamped(device: TrackedDevice, channel: 'A' | 'B', raw: number, s: Settings): number {
    const scaled = Math.round(raw * s.intensityScale);
    return Math.max(0, Math.min(scaled, SYSTEM_INTENSITY_CAP, this.dm.channelMax(device, channel)));
  }

  /** 发一波：临时强度 + 波形，immediate 顶掉同通道旧任务 */
  private pulseOnce(
    device: TrackedDevice,
    channel: V4Channel,
    intensityRaw: number,
    durationMs: number,
    frames: string[],
    s: Settings,
  ): void {
    const socket = this.dm.raw;
    if (!socket || !this.dm.connected) return;
    const chName = this.channelName(channel);
    const intensity = this.clamped(device, chName, intensityRaw, s);
    void socket
      .setTempIntensity(device.clientId, device.slotId, channel, intensity, durationMs, { immediate: true })
      .catch(() => undefined);
    void socket
      .sendPulse(device.clientId, device.slotId, channel, durationMs, frames, { immediate: true })
      .catch(() => undefined);
  }

  /** 普通受击：hitWaveforms 池随机 + [hitIntensityMin,Max] 随机 */
  private hit(s: Settings): void {
    if (!this.dm.connected) return;
    const coyote = this.coyote();
    if (coyote && s.coyoteEnabled) {
      const key = pick(s.hitWaveforms) as CoyoteKey;
      const frames = COYOTE_WAVEFORMS[key].raw;
      this.pulseOnce(coyote, this.mainChannel(s), randInt(s.hitIntensityMin, s.hitIntensityMax), s.hitDurationMs, frames, s);
    }
    const ovc = this.ovc();
    if (ovc && s.ovcEnabled && s.ovcHitWaveforms.length > 0) {
      const socket = this.dm.raw!;
      const key = pick(s.ovcHitWaveforms) as OvcKey;
      void socket
        .sendPulse(ovc.clientId, ovc.slotId, V4Channel.A, s.hitDurationMs, OVC_WAVEFORMS[key].raw, { immediate: true })
        .catch(() => undefined);
    }
  }

  /** 基地受击（大反馈）：baseHitWaveforms 池 + 更高强度范围 */
  private baseHit(s: Settings): void {
    if (!this.dm.connected) return;
    const coyote = this.coyote();
    if (!coyote || !s.coyoteEnabled) return;
    const key = pick(s.baseHitWaveforms) as CoyoteKey;
    this.pulseOnce(
      coyote,
      this.mainChannel(s),
      randInt(s.baseHitIntensityMin, s.baseHitIntensityMax),
      s.baseHitDurationMs,
      COYOTE_WAVEFORMS[key].raw,
      s,
    );
    const ovc = this.ovc();
    if (ovc && s.ovcEnabled) {
      const socket = this.dm.raw!;
      void socket
        .sendPulse(ovc.clientId, ovc.slotId, V4Channel.A, s.baseHitDurationMs, OVC_WAVEFORMS.AFTERSHOCK.raw, { immediate: true })
        .catch(() => undefined);
    }
  }

  /** 对战中被电击：强度由对方花费决定（倍率前原始值），波形从电击池随机 */
  shock(intensityRaw: number): void {
    if (this.stopped) return;
    const s = this.getSettings();
    if (!this.dm.connected) return;
    const key = pick(s.baseHitWaveforms) as CoyoteKey;
    const coyote0 = this.coyote();
    const shown0 = coyote0 ? this.clamped(coyote0, this.channelName(this.mainChannel(s)), intensityRaw, s) : 0;
    this.recordOutput('shock', COYOTE_WAVEFORMS[key].label.cn, shown0);
    const coyote = this.coyote();
    if (coyote && s.coyoteEnabled) {
      this.pulseOnce(coyote, this.mainChannel(s), intensityRaw, s.baseHitDurationMs, COYOTE_WAVEFORMS[key].raw, s);
    }
    const ovc = this.ovc();
    if (ovc && s.ovcEnabled) {
      const socket = this.dm.raw!;
      void socket
        .sendPulse(ovc.clientId, ovc.slotId, V4Channel.A, s.baseHitDurationMs, OVC_WAVEFORMS.AFTERSHOCK.raw, { immediate: true })
        .catch(() => undefined);
    }
  }

  private lowHpOn(s: Settings): void {
    if (!this.dm.connected || this.lowHpActive) return;
    this.lowHpActive = true;
    const coyote = this.coyote();
    if (coyote && s.coyoteEnabled) {
      // 警告走主通道，避免和受击互相顶掉；与惩罚通道不同则与惩罚共存
      const warn = this.mainChannel(s);
      const intensity = this.clamped(coyote, this.channelName(warn), LOW_HP_WARN_RAW, s);
      const socket = this.dm.raw!;
      void socket
        .setTempIntensity(coyote.clientId, coyote.slotId, warn, intensity, 60000, { immediate: true })
        .catch(() => undefined);
      void socket
        .sendPulse(coyote.clientId, coyote.slotId, warn, 60000, COYOTE_WAVEFORMS.BREATHING.raw, { immediate: true })
        .catch(() => undefined);
    }
    const ovc = this.ovc();
    if (ovc && s.ovcEnabled) {
      const socket = this.dm.raw!;
      void socket
        .sendPulse(ovc.clientId, ovc.slotId, V4Channel.A, 60000, OVC_WAVEFORMS.UNDERTOW.raw, { immediate: true })
        .catch(() => undefined);
    }
  }

  private lowHpOff(): void {
    if (!this.dm.connected || !this.lowHpActive) return;
    this.lowHpActive = false;
    const s = this.getSettings();
    const socket = this.dm.raw!;
    const coyote = this.coyote();
    if (coyote) {
      void socket.clearOperate(coyote.clientId, { slotId: coyote.slotId, channel: this.mainChannel(s) }).catch(() => undefined);
    }
    const ovc = this.ovc();
    if (ovc) {
      void socket.clearOperate(ovc.clientId, { slotId: ovc.slotId, channel: V4Channel.A }).catch(() => undefined);
    }
  }

  private async death(s: Settings): Promise<void> {
    if (!this.dm.connected) return;
    await emergencyStop(this.dm);
    this.lowHpActive = false;
    await new Promise((resolve) => setTimeout(resolve, 500));

    const coyote = this.coyote();
    if (coyote && s.coyoteEnabled) {
      const socket = this.dm.raw!;
      const main = this.mainChannel(s);
      const intensity = this.clamped(coyote, this.channelName(main), DEATH_BURST_RAW, s);
      void socket.setTempIntensity(coyote.clientId, coyote.slotId, main, intensity, 2500, { immediate: true }).catch(() => undefined);
      void socket.sendPulse(coyote.clientId, coyote.slotId, main, 2500, COYOTE_WAVEFORMS.EXTRUSTION.raw, { immediate: true }).catch(() => undefined);
      setTimeout(() => {
        void socket.clearOperate(coyote.clientId, { slotId: coyote.slotId, channel: main }).catch(() => undefined);
      }, 3000);
    }
    const ovc = this.ovc();
    if (ovc && s.ovcEnabled) {
      const socket = this.dm.raw!;
      void socket.sendPulse(ovc.clientId, ovc.slotId, V4Channel.A, 2500, OVC_WAVEFORMS.AFTERSHOCK.raw, { immediate: true }).catch(() => undefined);
      setTimeout(() => {
        void socket.clearOperate(ovc.clientId, { slotId: ovc.slotId, channel: V4Channel.A }).catch(() => undefined);
      }, 3000);
    }
  }

  private bomb(s: Settings): void {
    if (!this.dm.connected) return;
    const ovc = this.ovc();
    if (ovc && s.ovcEnabled) {
      const socket = this.dm.raw!;
      void socket
        .sendPulse(ovc.clientId, ovc.slotId, V4Channel.B, 1500, OVC_WAVEFORMS.POP_CANDY.raw, { immediate: true })
        .catch(() => undefined);
    }
  }

  // ===== 战败惩罚 =====

  private stopPunishmentTimer(): void {
    if (this.punishTimer !== null) {
      clearInterval(this.punishTimer);
      this.punishTimer = null;
    }
  }

  /**
   * 战败惩罚：每 punishStepSec 秒发一波（punishWaveforms 随机池 +
   * [min,max] 随机强度），每轮强度上限 +punishRamp（封顶 100）。
   * 固定走副通道，与事件反馈互不干扰。返回轮数回调用于 UI 显示。
   */
  startPunishment(onRound?: (round: number, intensity: number) => void): void {
    if (this.stopped || this.punishTimer !== null) return;
    this.punishRounds = 0;
    const tick = () => {
      const s = this.getSettings();
      this.punishRounds += 1;
      const ramp = Math.min(100, s.punishIntensityMax + (this.punishRounds - 1) * s.punishRamp);
      const raw = randInt(s.punishIntensityMin, Math.max(s.punishIntensityMin, ramp));
      const coyote = this.coyote();
      if (coyote && s.coyoteEnabled && this.dm.connected) {
        const key = pick(s.punishWaveforms) as CoyoteKey;
        const ch = this.punishChannel(s);
        const duration = Math.max(800, s.punishStepSec * 1000 - 200);
        this.pulseOnce(coyote, ch, raw, duration, COYOTE_WAVEFORMS[key].raw, s);
      }
      onRound?.(this.punishRounds, raw);
    };
    tick();
    this.punishTimer = setInterval(tick, this.getSettings().punishStepSec * 1000);
  }

  stopPunishment(): void {
    this.stopPunishmentTimer();
    this.punishRounds = 0;
    const s = this.getSettings();
    const socket = this.dm.raw;
    if (!socket || !this.dm.connected) return;
    const coyote = this.coyote();
    if (coyote) {
      void socket.clearOperate(coyote.clientId, { slotId: coyote.slotId, channel: this.punishChannel(s) }).catch(() => undefined);
      void socket.resetIntensity(coyote.clientId, coyote.slotId, this.punishChannel(s)).catch(() => undefined);
    }
  }

  /** 单次惩罚脉冲：波形与强度由调用方决定（对战时赢家可控制，强度在本地二次钳制） */
  punishPulse(waveformKey: string, intensityRaw: number): void {
    if (this.stopped) return;
    const s = this.getSettings();
    const coyote = this.coyote();
    if (!coyote || !s.coyoteEnabled || !this.dm.connected) return;
    const key = waveformKey in COYOTE_WAVEFORMS ? waveformKey : (pick(s.punishWaveforms) as CoyoteKey);
    this.recordOutput('punish', COYOTE_WAVEFORMS[key as CoyoteKey].label.cn, Math.round(intensityRaw * s.intensityScale));
    const frames = COYOTE_WAVEFORMS[key as CoyoteKey].raw;
    const duration = Math.max(800, s.punishStepSec * 1000 - 200);
    this.pulseOnce(coyote, this.punishChannel(s), intensityRaw, duration, frames, s);
  }
}
