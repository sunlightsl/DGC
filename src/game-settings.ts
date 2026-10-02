import { DEFAULT_COLOR_WEIGHTS } from './settings';
import { getCurrentUser } from './account';

/**
 * 每游戏的个人设置：从游戏卡片右上角齿轮进入，按用户名隔离存储
 * （key = dg-game-<game>-<用户名>，同机不同账号互不影响）。
 * 字段定义驱动：新游戏只需加一份 DEFS。
 */

export interface GameSettingField {
  kind: 'range' | 'number' | 'select' | 'switch' | 'weights';
  key: string;
  label: string;
  min?: number;
  max?: number;
  step?: number;
  options?: { key: string; label: string }[];
  format?: (v: number) => string;
}

export interface GameSettingsDef {
  game: 'bullet' | 'versus' | 'roulette';
  title: string;
  fields: GameSettingField[];
}

// ===== 各游戏默认配置 =====

export interface BulletGameConfig {
  /** 难度系数：敌机血量/速度倍率 */
  enemyHpMul: number;
  enemySpeedMul: number;
  initialBombs: number;
  /** 漏怪时是否电击反馈 */
  leakShock: boolean;
}

export interface VersusGameConfig {
  targetScore: number;
  boardSize: '8x8' | '10x9' | '12x10';
  /** 6 色刷出权重（0-10） */
  colorWeights: number[];
}

export interface RouletteGameConfig {
  maxHp: number;
  maxLive: number;
  /** 每回合思考时限（秒，0=不限） */
  turnSec: number;
}

export const BULLET_DEFAULTS: BulletGameConfig = {
  enemyHpMul: 1,
  enemySpeedMul: 1,
  initialBombs: 3,
  leakShock: true,
};

export const VERSUS_DEFAULTS: VersusGameConfig = {
  targetScore: 5000,
  boardSize: '12x10',
  colorWeights: [...DEFAULT_COLOR_WEIGHTS],
};

export const ROULETTE_DEFAULTS: RouletteGameConfig = {
  maxHp: 5,
  maxLive: 3,
  turnSec: 0,
};

export const GAME_DEFS: GameSettingsDef[] = [
  {
    game: 'bullet',
    title: '小电机弹幕 · 游戏设置',
    fields: [
      {
        kind: 'select',
        key: 'difficulty',
        label: '难度',
        options: [
          { key: 'easy', label: '轻松（敌机 -30%）' },
          { key: 'normal', label: '标准' },
          { key: 'hard', label: '困难（敌机 +40%）' },
        ],
      },
      { kind: 'range', key: 'initialBombs', label: '初始炸弹', min: 1, max: 3, step: 1 },
      { kind: 'switch', key: 'leakShock', label: '漏怪电击' },
    ],
  },
  {
    game: 'versus',
    title: '电击消消乐 · 游戏设置',
    fields: [
      {
        kind: 'select',
        key: 'targetScore',
        label: '默认目标分',
        options: ['2000', '3000', '5000', '8000', '12000'].map((v) => ({ key: v, label: `${v} 分` })),
      },
      {
        kind: 'select',
        key: 'boardSize',
        label: '默认棋盘',
        options: [
          { key: '8x8', label: '8 × 8（经典）' },
          { key: '10x9', label: '10 × 9（加宽）' },
          { key: '12x10', label: '12 × 10（大屏）' },
        ],
      },
      { kind: 'weights', key: 'colorWeights', label: '颜色比例' },
    ],
  },
  {
    game: 'roulette',
    title: '俄罗斯轮盘 · 游戏设置',
    fields: [
      {
        kind: 'select',
        key: 'maxHp',
        label: 'HP 点数',
        options: [
          { key: '3', label: '3（快节奏）' },
          { key: '5', label: '5（标准）' },
          { key: '7', label: '7（持久战）' },
        ],
      },
      { kind: 'range', key: 'maxLive', label: '实弹上限', min: 1, max: 4, step: 1 },
      {
        kind: 'select',
        key: 'turnSec',
        label: '思考时限',
        options: [
          { key: '0', label: '不限时' },
          { key: '10', label: '10 秒' },
          { key: '15', label: '15 秒' },
          { key: '20', label: '20 秒' },
        ],
      },
    ],
  },
];

// ===== 存储与读取 =====

const DIFF_MUL: Record<string, { hp: number; speed: number }> = {
  easy: { hp: 0.7, speed: 0.85 },
  normal: { hp: 1, speed: 1 },
  hard: { hp: 1.4, speed: 1.15 },
};

function storageKey(game: string): string {
  const user = getCurrentUser()?.username ?? 'guest';
  return `dg-game-${game}-${user}`;
}

function clampNum(v: unknown, min: number, max: number, fallback: number): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

export function loadGameSettings<T extends object>(game: 'bullet' | 'versus' | 'roulette', defaults: T): T {
  const key = storageKey(game);
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return { ...defaults };
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const out = { ...defaults } as Record<string, unknown>;
    for (const k of Object.keys(defaults)) {
      if (parsed[k] !== undefined) out[k] = parsed[k];
    }
    return sanitizeConfig(game, out) as T;
  } catch {
    return { ...defaults };
  }
}

function sanitizeConfig(game: string, cfg: Record<string, unknown>): Record<string, unknown> {
  if (game === 'bullet') {
    cfg.initialBombs = clampNum(cfg.initialBombs, 1, 3, BULLET_DEFAULTS.initialBombs);
    cfg.leakShock = cfg.leakShock !== false;
    const mul = DIFF_MUL[String(cfg.difficulty ?? 'normal')] ?? DIFF_MUL.normal;
    cfg.enemyHpMul = mul.hp;
    cfg.enemySpeedMul = mul.speed;
  }
  if (game === 'versus') {
    cfg.targetScore = clampNum(cfg.targetScore, 1000, 20000, VERSUS_DEFAULTS.targetScore);
    if (!['8x8', '10x9', '12x10'].includes(String(cfg.boardSize))) cfg.boardSize = VERSUS_DEFAULTS.boardSize;
    const w = Array.isArray(cfg.colorWeights) ? cfg.colorWeights : [];
    cfg.colorWeights = DEFAULT_COLOR_WEIGHTS.map((d, i) => clampNum(w[i], 0, 10, d));
  }
  if (game === 'roulette') {
    cfg.maxHp = clampNum(cfg.maxHp, 3, 7, ROULETTE_DEFAULTS.maxHp);
    cfg.maxLive = clampNum(cfg.maxLive, 1, 4, ROULETTE_DEFAULTS.maxLive);
    cfg.turnSec = clampNum(cfg.turnSec, 0, 60, ROULETTE_DEFAULTS.turnSec);
  }
  return cfg;
}

export function saveGameSettings(game: string, cfg: Record<string, unknown>): void {
  try {
    localStorage.setItem(storageKey(game), JSON.stringify(cfg));
  } catch {
    /* ignore */
  }
}

/** 供设置面板读取当前值（含派生键） */
export function readGameSettings<T extends object>(game: 'bullet' | 'versus' | 'roulette', defaults: T): T {
  return loadGameSettings(game, defaults);
}
