import { COYOTE_WAVEFORM, COYOTE_WAVEFORMS, OVC_WAVEFORM, OVC_WAVEFORMS } from 'dglab-kit';

export interface Settings {
  /** 全局强度倍率 0.1 - 1 */
  intensityScale: number;
  coyoteEnabled: boolean;
  ovcEnabled: boolean;
  bmtrEnabled: boolean;
  /** 郊狼主反馈通道，低血量警告自动用另一通道 */
  coyoteChannel: 'A' | 'B';
  /** 受击：波形多选池 + 强度范围（倍率前 1-100） */
  hitWaveforms: string[];
  hitIntensityMin: number;
  hitIntensityMax: number;
  /** 受击时长(ms) */
  hitDurationMs: number;
  /** 负鼠受击波形池 */
  ovcHitWaveforms: string[];
  /** 基地受击（大反馈）：波形池 + 强度范围 */
  baseHitWaveforms: string[];
  baseHitIntensityMin: number;
  baseHitIntensityMax: number;
  baseHitDurationMs: number;
  /** 战败惩罚：波形池 + 强度范围 + 升级节奏 */
  punishWaveforms: string[];
  punishIntensityMin: number;
  punishIntensityMax: number;
  punishStepSec: number;
  punishRamp: number;
  /** 惩罚时间上限（秒），到点自动结束 */
  punishMaxSec: number;
  /** 灵猫捏压触发阈值 */
  bmtrThreshold: number;
  bmtrCooldownMs: number;
  /** 6 色刷出权重（0-10），红=电击 蓝=护盾 绿=净化 黄=时停 紫=倍率 橙=增幅 */
  colorWeights: number[];
}

const STORAGE_KEY = 'dg-game-settings-v2';

export const DEFAULT_SETTINGS: Settings = {
  intensityScale: 0.3,
  coyoteEnabled: true,
  ovcEnabled: true,
  bmtrEnabled: true,
  coyoteChannel: 'A',
  hitWaveforms: [COYOTE_WAVEFORM.SIGNAL, COYOTE_WAVEFORM.PULSE, COYOTE_WAVEFORM.QUICK_RUB],
  hitIntensityMin: 15,
  hitIntensityMax: 35,
  hitDurationMs: 700,
  ovcHitWaveforms: [OVC_WAVEFORM.STEADY_HIT, OVC_WAVEFORM.PINPOINT],
  baseHitWaveforms: [COYOTE_WAVEFORM.EXTRUSTION, COYOTE_WAVEFORM.COMPRESS, COYOTE_WAVEFORM.TIDE],
  baseHitIntensityMin: 30,
  baseHitIntensityMax: 60,
  baseHitDurationMs: 1500,
  punishWaveforms: [
    COYOTE_WAVEFORM.TEASE_1,
    COYOTE_WAVEFORM.TEASE_2,
    COYOTE_WAVEFORM.RAINFALL,
    COYOTE_WAVEFORM.TEMPO_TAP,
    COYOTE_WAVEFORM.PULSATING,
  ],
  punishIntensityMin: 10,
  punishIntensityMax: 40,
  punishStepSec: 3,
  punishRamp: 5,
  punishMaxSec: 120,
  bmtrThreshold: 30,
  bmtrCooldownMs: 1500,
  colorWeights: [10, 3, 3, 5, 5, 6], // 电击最多，防御最少
};

function sanitizeWeights(value: unknown): number[] {
  const fallback = [...DEFAULT_SETTINGS.colorWeights];
  if (!Array.isArray(value)) return fallback;
  return fallback.map((d, i) => clampNum(value[i], 0, 10, d));
}

function inRecord(record: object, key: unknown): key is string {
  return typeof key === 'string' && key in record;
}

function clampNum(value: unknown, min: number, max: number, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** 过滤非法键；空数组回退默认池 */
function sanitizePool(value: unknown, record: object, fallback: string[]): string[] {
  if (!Array.isArray(value)) return [...fallback];
  const pool = value.filter((k) => inRecord(record, k));
  return pool.length > 0 ? (pool as string[]) : [...fallback];
}

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY) ?? localStorage.getItem('dg-game-settings-v1');
    const parsed = raw ? (JSON.parse(raw) as Partial<Settings> & Record<string, unknown>) : {};
    const merged: Settings = { ...DEFAULT_SETTINGS, ...parsed };

    // v1 单值波形迁移为数组
    if (!Array.isArray(parsed.hitWaveforms) && typeof parsed.coyoteHitWaveform === 'string') {
      merged.hitWaveforms = [parsed.coyoteHitWaveform];
    }
    if (!Array.isArray(parsed.ovcHitWaveforms) && typeof parsed.ovcHitWaveform === 'string') {
      merged.ovcHitWaveforms = [parsed.ovcHitWaveform];
    }
    // v1 固定强度迁移为范围
    if (parsed.hitIntensity !== undefined && parsed.hitIntensityMin === undefined) {
      const v = clampNum(parsed.hitIntensity, 1, 100, DEFAULT_SETTINGS.hitIntensityMax);
      merged.hitIntensityMin = Math.max(1, v - 10);
      merged.hitIntensityMax = v;
    }

    merged.hitWaveforms = sanitizePool(merged.hitWaveforms, COYOTE_WAVEFORMS, DEFAULT_SETTINGS.hitWaveforms);
    merged.ovcHitWaveforms = sanitizePool(merged.ovcHitWaveforms, OVC_WAVEFORMS, DEFAULT_SETTINGS.ovcHitWaveforms);
    merged.baseHitWaveforms = sanitizePool(merged.baseHitWaveforms, COYOTE_WAVEFORMS, DEFAULT_SETTINGS.baseHitWaveforms);
    merged.punishWaveforms = sanitizePool(merged.punishWaveforms, COYOTE_WAVEFORMS, DEFAULT_SETTINGS.punishWaveforms);

    merged.intensityScale = clampNum(merged.intensityScale, 0.1, 2, DEFAULT_SETTINGS.intensityScale);
    merged.hitIntensityMin = clampNum(merged.hitIntensityMin, 1, 100, DEFAULT_SETTINGS.hitIntensityMin);
    merged.hitIntensityMax = clampNum(merged.hitIntensityMax, 1, 100, DEFAULT_SETTINGS.hitIntensityMax);
    if (merged.hitIntensityMin > merged.hitIntensityMax) {
      [merged.hitIntensityMin, merged.hitIntensityMax] = [merged.hitIntensityMax, merged.hitIntensityMin];
    }
    merged.baseHitIntensityMin = clampNum(merged.baseHitIntensityMin, 1, 100, DEFAULT_SETTINGS.baseHitIntensityMin);
    merged.baseHitIntensityMax = clampNum(merged.baseHitIntensityMax, 1, 100, DEFAULT_SETTINGS.baseHitIntensityMax);
    if (merged.baseHitIntensityMin > merged.baseHitIntensityMax) {
      [merged.baseHitIntensityMin, merged.baseHitIntensityMax] = [merged.baseHitIntensityMax, merged.baseHitIntensityMin];
    }
    merged.punishIntensityMin = clampNum(merged.punishIntensityMin, 1, 100, DEFAULT_SETTINGS.punishIntensityMin);
    merged.punishIntensityMax = clampNum(merged.punishIntensityMax, 1, 100, DEFAULT_SETTINGS.punishIntensityMax);
    if (merged.punishIntensityMin > merged.punishIntensityMax) {
      [merged.punishIntensityMin, merged.punishIntensityMax] = [merged.punishIntensityMax, merged.punishIntensityMin];
    }
    merged.hitDurationMs = clampNum(merged.hitDurationMs, 100, 5000, DEFAULT_SETTINGS.hitDurationMs);
    merged.baseHitDurationMs = clampNum(merged.baseHitDurationMs, 100, 8000, DEFAULT_SETTINGS.baseHitDurationMs);
    merged.punishStepSec = clampNum(merged.punishStepSec, 1, 30, DEFAULT_SETTINGS.punishStepSec);
    merged.punishRamp = clampNum(merged.punishRamp, 0, 20, DEFAULT_SETTINGS.punishRamp);
    merged.punishMaxSec = clampNum(merged.punishMaxSec, 30, 600, DEFAULT_SETTINGS.punishMaxSec);
    merged.colorWeights = sanitizeWeights(merged.colorWeights);
    merged.bmtrThreshold = clampNum(merged.bmtrThreshold, 1, 100, DEFAULT_SETTINGS.bmtrThreshold);
    merged.bmtrCooldownMs = clampNum(merged.bmtrCooldownMs, 300, 10000, DEFAULT_SETTINGS.bmtrCooldownMs);
    return merged;
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(settings: Settings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
    localStorage.removeItem('dg-game-settings-v1');
  } catch {
    /* ignore */
  }
}

export const COYOTE_WAVEFORM_OPTIONS = (Object.keys(COYOTE_WAVEFORMS) as (keyof typeof COYOTE_WAVEFORMS)[]).map(
  (key) => ({ key, label: COYOTE_WAVEFORMS[key].label.cn }),
);

export const OVC_WAVEFORM_OPTIONS = (Object.keys(OVC_WAVEFORMS) as (keyof typeof OVC_WAVEFORMS)[]).map(
  (key) => ({ key, label: OVC_WAVEFORMS[key].label.cn }),
);
