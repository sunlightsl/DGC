import {
  GAME_DEFS,
  loadGameSettings,
  saveGameSettings,
  BULLET_DEFAULTS,
  VERSUS_DEFAULTS,
  ROULETTE_DEFAULTS,
  type GameSettingsDef,
} from '../game-settings';

/**
 * 游戏设置面板（弹窗版）：每个游戏一份字段定义，按用户名隔离存储。
 * 支持 range / number / select / switch / weights 六色权重。
 */

const WEIGHT_COLORS = ['#ff4c5e', '#4cc2ff', '#4cff9d', '#f0c866', '#b06cff', '#ff9d4c'];
const WEIGHT_NAMES = ['电击', '护盾', '净化', '时停', '倍率', '增幅'];

const DEFAULTS_BY_GAME: Record<string, Record<string, unknown>> = {
  bullet: { ...BULLET_DEFAULTS, difficulty: 'normal' },
  versus: { ...VERSUS_DEFAULTS },
  roulette: { ...ROULETTE_DEFAULTS },
};

let currentGame: GameSettingsDef | null = null;
let currentValues: Record<string, unknown> = {};

function el<T extends HTMLElement = HTMLElement>(id: string, _ctor?: new () => T): T {
  return document.getElementById(id) as T;
}

export function renderGameSettings(game: 'bullet' | 'versus' | 'roulette', container: HTMLElement): void {
  currentGame = GAME_DEFS.find((d) => d.game === game) ?? null;
  if (!currentGame) return;
  const defaults = DEFAULTS_BY_GAME[game] ?? {};
  const stored = loadGameSettings(game, defaults as never) as Record<string, unknown>;
  // select 类字段展示用字符串键（如 difficulty），存储时同步派生值
  currentValues = { ...defaults, ...stored };

  container.innerHTML = `
    <div class="sec">${currentGame.title}</div>
    <div class="sec-note">仅对当前账号（${escapeHtml(localStorage.getItem('dg-user') ? (JSON.parse(localStorage.getItem('dg-user')!) as { username?: string }).username ?? 'guest' : 'guest')}）生效，与他人互不影响。</div>
    ${currentGame.fields.map((f) => fieldHtml(f)).join('')}
  `;
  currentGame.fields.forEach((f) => bindField(f, container));
}

function fieldHtml(f: (typeof GAME_DEFS)[number]['fields'][number]): string {
  const v = currentValues[f.key];
  switch (f.kind) {
    case 'range': {
      const num = Number(v);
      return `<div class="row">
        <label>${f.label}</label>
        <input type="range" data-key="${f.key}" min="${f.min}" max="${f.max}" step="${f.step ?? 1}" value="${num}" />
        <span class="val" data-val="${f.key}">${f.format ? f.format(num) : num}</span>
      </div>`;
    }
    case 'number':
      return `<div class="row">
        <label>${f.label}</label>
        <input type="number" data-key="${f.key}" min="${f.min}" max="${f.max}" step="${f.step ?? 1}" value="${Number(v)}" />
      </div>`;
    case 'select':
      return `<div class="row">
        <label>${f.label}</label>
        <select data-key="${f.key}" style="flex:1">
          ${(f.options ?? [])
            .map((o) => `<option value="${o.key}" ${String(o.key) === String(v) ? 'selected' : ''}>${o.label}</option>`)
            .join('')}
        </select>
      </div>`;
    case 'switch':
      return `<div class="row">
        <label>${f.label}</label>
        <span class="switch">
          <input type="checkbox" data-key="${f.key}" ${v ? 'checked' : ''} />
          <span class="track"></span>
        </span>
      </div>`;
    case 'weights': {
      const weights = Array.isArray(v) ? (v as number[]) : [];
      return `<div class="weight-grid" data-key="${f.key}">
        ${WEIGHT_NAMES.map((name, i) => {
          const w = Number(weights[i] ?? 0);
          return `<div class="weight-row">
            <span class="en-ico" style="background:${WEIGHT_COLORS[i]}; width:18px; height:18px"></span>
            <span class="en-name">${name}</span>
            <input type="range" data-idx="${i}" min="0" max="10" step="1" value="${w}" />
            <span class="val" data-wval="${i}">${w}</span>
          </div>`;
        }).join('')}
      </div>`;
    }
  }
}

function bindField(f: (typeof GAME_DEFS)[number]['fields'][number], container: HTMLElement): void {
  if (f.kind === 'weights') {
    const grid = container.querySelector<HTMLElement>(`.weight-grid[data-key="${f.key}"]`)!;
    const pool = [...((currentValues[f.key] as number[]) ?? [])];
    grid.querySelectorAll<HTMLInputElement>('input[type="range"]').forEach((range) => {
      range.addEventListener('input', () => {
        const idx = Number(range.dataset.idx);
        pool[idx] = Number(range.value);
        currentValues[f.key] = pool;
        const val = grid.querySelector<HTMLElement>(`[data-wval="${idx}"]`);
        if (val) val.textContent = range.value;
        persist();
      });
    });
    return;
  }
  const input = container.querySelector<HTMLElement>(`[data-key="${f.key}"]`) as HTMLInputElement;
  if (!input) return;
  input.addEventListener('input', () => {
    switch (f.kind) {
      case 'range': {
        const num = Number(input.value);
        currentValues[f.key] = num;
        const val = container.querySelector<HTMLElement>(`[data-val="${f.key}"]`);
        if (val) val.textContent = f.format ? f.format(num) : String(num);
        break;
      }
      case 'number': {
        let num = Number(input.value);
        if (!Number.isFinite(num)) return;
        if (f.min !== undefined) num = Math.max(f.min, num);
        if (f.max !== undefined) num = Math.min(f.max, num);
        currentValues[f.key] = num;
        break;
      }
      case 'select':
        currentValues[f.key] = f.key === 'targetScore' || f.key === 'maxHp' || f.key === 'turnSec' ? Number(input.value) : input.value;
        break;
      case 'switch':
        currentValues[f.key] = input.checked;
        break;
    }
    // 难度 select 联动派生系数
    if (f.key === 'difficulty') {
      const mul = { easy: { hp: 0.7, speed: 0.85 }, normal: { hp: 1, speed: 1 }, hard: { hp: 1.4, speed: 1.15 } }[
        String(currentValues.difficulty)
      ] ?? { hp: 1, speed: 1 };
      currentValues.enemyHpMul = mul.hp;
      currentValues.enemySpeedMul = mul.speed;
    }
    persist();
  });
}

function persist(): void {
  if (currentGame) saveGameSettings(currentGame.game, currentValues);
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}
