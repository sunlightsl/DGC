import type { FeedbackEngine, FeedbackEvent } from '../devices/feedback-engine';
import {
  COYOTE_WAVEFORM_OPTIONS,
  OVC_WAVEFORM_OPTIONS,
  loadSettings,
  saveSettings,
  type Settings,
} from '../settings';

interface RowDef {
  kind: 'range' | 'switch' | 'select' | 'number' | 'chips' | 'dual' | 'weights';
  key: keyof Settings;
  label: string;
  min?: number;
  max?: number;
  step?: number;
  options?: { key: string; label: string }[];
  optionRecord?: 'coyote' | 'ovc';
  format?: (v: number) => string;
}

const WEIGHT_COLORS = ['#ff4c5e', '#4cc2ff', '#4cff9d', '#f0c866', '#b06cff', '#ff9d4c'];
const WEIGHT_NAMES = ['电击', '护盾', '净化', '时停', '倍率', '增幅'];

interface Section {
  title: string;
  note?: string;
  rows: RowDef[];
}

const SECTIONS: Section[] = [
  {
    title: '反馈强度',
    note: '所有输出 = 原始值 × 全局倍率，再被「系统强度上限」与 APP 内设备安全上限钳制。上限可调低自保，100 为不可逾越的安全红线。',
    rows: [
      { kind: 'range', key: 'systemCap', label: '系统强度上限', min: 1, max: 100, step: 1 },
      { kind: 'range', key: 'intensityScale', label: '全局倍率', min: 0.1, max: 2, step: 0.05, format: (v) => `${Math.round(v * 100)}%` },
      { kind: 'number', key: 'hitDurationMs', label: '受击时长(ms)', min: 100, max: 5000, step: 100 },
    ],
  },
  {
    title: '郊狼（受击反馈）',
    note: '被电击/受击时随机从池里抽一个波形、在强度范围内随机取值。',
    rows: [
      { kind: 'switch', key: 'coyoteEnabled', label: '启用反馈' },
      { kind: 'select', key: 'coyoteChannel', label: '主反馈通道', options: [
        { key: 'A', label: 'A 通道' },
        { key: 'B', label: 'B 通道' },
      ] },
      { kind: 'chips', key: 'hitWaveforms', label: '受击波形池', optionRecord: 'coyote' },
      { kind: 'dual', key: 'hitIntensityMin', label: '受击强度', min: 1, max: 100 },
    ],
  },
  {
    title: '负鼠（振动反馈）',
    note: '受击时振动，炸弹触发奖励振动。',
    rows: [
      { kind: 'switch', key: 'ovcEnabled', label: '启用反馈' },
      { kind: 'chips', key: 'ovcHitWaveforms', label: '受击波形池', optionRecord: 'ovc' },
    ],
  },
  {
    title: '电击/基地受击（大反馈）',
    note: '对战中被对方电击、或基地受击时的重反馈。',
    rows: [
      { kind: 'chips', key: 'baseHitWaveforms', label: '电击波形池', optionRecord: 'coyote' },
      { kind: 'dual', key: 'baseHitIntensityMin', label: '电击强度', min: 1, max: 100 },
      { kind: 'number', key: 'baseHitDurationMs', label: '电击时长(ms)', min: 100, max: 8000, step: 100 },
    ],
  },
  {
    title: '战败惩罚',
    note: '战败后持续输出：每轮随机池波形 + 范围内随机强度，强度上限随轮数升级，点击「认输」才停止。',
    rows: [
      { kind: 'chips', key: 'punishWaveforms', label: '惩罚波形池', optionRecord: 'coyote' },
      { kind: 'dual', key: 'punishIntensityMin', label: '惩罚强度', min: 1, max: 100 },
      { kind: 'number', key: 'punishStepSec', label: '升级间隔(秒)', min: 1, max: 30 },
      { kind: 'number', key: 'punishMaxSec', label: '惩罚上限(秒)', min: 30, max: 600, step: 10 },
    ],
  },
  {
    title: '颜色比例（对战）',
    note: '各颜色宝石的刷出权重（0-10）。防御色（蓝/绿）权重低，痛苦才够持续。',
    rows: [{ kind: 'weights', key: 'colorWeights', label: '' }],
  },
  {
    title: '灵猫（边控传感器）',
    note: '游戏中捏压灵猫触发炸弹，清空全屏敌弹。',
    rows: [
      { kind: 'switch', key: 'bmtrEnabled', label: '炸弹输入' },
      { kind: 'number', key: 'bmtrThreshold', label: '触发阈值', min: 1, max: 100 },
      { kind: 'number', key: 'bmtrCooldownMs', label: '冷却(ms)', min: 300, max: 10000, step: 100 },
    ],
  },
];

const TEST_BUTTONS: { event: FeedbackEvent; label: string }[] = [
  { event: 'hit', label: '受击' },
  { event: 'baseHit', label: '电击' },
  { event: 'lowHpOn', label: '低血量警告 开' },
  { event: 'lowHpOff', label: '低血量警告 关' },
  { event: 'bomb', label: '炸弹' },
  { event: 'death', label: '死亡' },
];

const DUAL_PAIRS: Record<string, { minKey: keyof Settings; maxKey: keyof Settings }> = {
  hitIntensityMin: { minKey: 'hitIntensityMin', maxKey: 'hitIntensityMax' },
  baseHitIntensityMin: { minKey: 'baseHitIntensityMin', maxKey: 'baseHitIntensityMax' },
  punishIntensityMin: { minKey: 'punishIntensityMin', maxKey: 'punishIntensityMax' },
};

/**
 * 设置面板（弹窗版）：分区金条标题 + 拨杆开关 + 波形池 chip 多选。
 * 设置实时写入 localStorage，FeedbackEngine 通过 getSettings() 读取最新值。
 */
export class SettingsPanel {
  private root: HTMLElement;
  private settings: Settings;
  private getSettings: () => Settings;

  constructor(container: HTMLElement, feedback: FeedbackEngine) {
    this.root = container;
    this.settings = loadSettings();
    this.getSettings = () => this.settings;
    this.build(feedback);
  }

  /** 供 FeedbackEngine 读取实时设置 */
  readonly getSettingsRef = (): Settings => this.getSettings();

  private optionsFor(row: RowDef): { key: string; label: string }[] {
    return row.options ?? (row.optionRecord === 'ovc' ? OVC_WAVEFORM_OPTIONS : COYOTE_WAVEFORM_OPTIONS);
  }

  private build(feedback: FeedbackEngine): void {
    this.root.innerHTML =
      SECTIONS.map((sec, si) => {
        const rows = sec.rows.map((row, ri) => this.rowHtml(row, `${si}-${ri}`)).join('');
        const note = sec.note ? `<div class="sec-note">${sec.note}</div>` : '';
        return `<div class="sec">${sec.title}</div>${note}${rows}`;
      }).join('') +
      `
      <div class="sec">手动测试</div>
      <div class="sec-note">建议先低倍率逐项测试，确认合适后再对战。</div>
      <div class="test-grid">
        ${TEST_BUTTONS.map((b) => `<button class="btn" data-event="${b.event}">${b.label}</button>`).join('')}
        <button class="btn" id="btn-test-punish">测试惩罚 10 秒</button>
      </div>
      `;

    SECTIONS.forEach((sec, si) => {
      sec.rows.forEach((row, ri) => this.bindRow(row, `${si}-${ri}`));
    });

    this.root.querySelectorAll<HTMLButtonElement>('[data-event]').forEach((btn) => {
      btn.addEventListener('click', () => {
        feedback.reset();
        feedback.fire(btn.dataset.event as FeedbackEvent);
      });
    });

    this.root.querySelector<HTMLButtonElement>('#btn-test-punish')!.addEventListener('click', (e) => {
      const btn = e.currentTarget as HTMLButtonElement;
      feedback.reset();
      feedback.startPunishment();
      btn.disabled = true;
      btn.textContent = '惩罚中…';
      setTimeout(() => {
        feedback.stopPunishment();
        btn.disabled = false;
        btn.textContent = '测试惩罚 10 秒';
      }, 10000);
    });
  }

  private rowHtml(row: RowDef, id: string): string {
    const v = this.settings[row.key];
    switch (row.kind) {
      case 'range': {
        const num = Number(v);
        const shown = row.format ? row.format(num) : String(num);
        return `<div class="row">
          <label>${row.label}</label>
          <input type="range" id="set-${id}" min="${row.min}" max="${row.max}" step="${row.step ?? 1}" value="${num}" />
          <span class="val" id="set-val-${id}">${shown}</span>
        </div>`;
      }
      case 'switch':
        return `<div class="row">
          <label>${row.label}</label>
          <span class="switch">
            <input type="checkbox" id="set-${id}" ${v ? 'checked' : ''} />
            <span class="track"></span>
          </span>
        </div>`;
      case 'select':
        return `<div class="row">
          <label>${row.label}</label>
          <select id="set-${id}">
            ${(row.options ?? [])
              .map((o) => `<option value="${o.key}" ${o.key === v ? 'selected' : ''}>${o.label}</option>`)
              .join('')}
          </select>
        </div>`;
      case 'number':
        return `<div class="row">
          <label>${row.label}</label>
          <input type="number" id="set-${id}" min="${row.min}" max="${row.max}" step="${row.step ?? 1}" value="${Number(v)}" />
        </div>`;
      case 'chips': {
        const pool = Array.isArray(v) ? (v as string[]) : [];
        return `<div class="row chip-block">
          <label>${row.label}</label>
          <div class="chip-row" id="set-${id}">
            ${this.optionsFor(row)
              .map((o) => `<button type="button" class="chip ${pool.includes(o.key) ? 'active' : ''}" data-key="${o.key}">${o.label}</button>`)
              .join('')}
          </div>
        </div>`;
      }
      case 'dual': {
        const pair = DUAL_PAIRS[row.key];
        if (!pair) return '';
        const minV = Number(this.settings[pair.minKey]);
        const maxV = Number(this.settings[pair.maxKey]);
        return `<div class="row">
          <label>${row.label}</label>
          <input type="number" id="set-${id}-min" min="${row.min}" max="${row.max}" value="${minV}" title="最小值" />
          <span class="dual-sep">~</span>
          <input type="number" id="set-${id}-max" min="${row.min}" max="${row.max}" value="${maxV}" title="最大值" />
        </div>`;
      }
      case 'weights': {
        const weights = Array.isArray(this.settings.colorWeights) ? this.settings.colorWeights : [];
        return `<div class="weight-grid" id="set-${id}">
          ${WEIGHT_NAMES.map((name, i) => {
            const v = Number(weights[i] ?? 0);
            return `<div class="weight-row">
              <span class="en-ico" style="background:${WEIGHT_COLORS[i]}; width:18px; height:18px"></span>
              <span class="en-name">${name}</span>
              <input type="range" data-idx="${i}" min="0" max="10" step="1" value="${v}" />
              <span class="val" id="set-w-${id}-${i}">${v}</span>
            </div>`;
          }).join('')}
        </div>`;
      }
    }
  }

  private bindRow(row: RowDef, id: string): void {
    if (row.kind === 'weights') {
      const grid = this.root.querySelector<HTMLElement>(`#set-${id}`)!;
      const store = this.settings as unknown as Record<string, unknown>;
      grid.querySelectorAll<HTMLInputElement>('input[type="range"]').forEach((range) => {
        range.addEventListener('input', () => {
          const idx = Number(range.dataset.idx);
          const pool = [...((store.colorWeights as number[]) ?? [])];
          pool[idx] = Number(range.value);
          store.colorWeights = pool;
          const val = this.root.querySelector<HTMLElement>(`#set-w-${id}-${idx}`);
          if (val) val.textContent = range.value;
          saveSettings(this.settings);
        });
      });
      return;
    }

    if (row.kind === 'chips') {      const box = this.root.querySelector<HTMLElement>(`#set-${id}`)!;
      const store = this.settings as unknown as Record<string, unknown>;
      box.querySelectorAll<HTMLButtonElement>('.chip').forEach((chip) => {
        chip.addEventListener('click', () => {
          const pool = [...((store[row.key] as string[]) ?? [])];
          const k = chip.dataset.key!;
          const idx = pool.indexOf(k);
          if (idx >= 0) {
            if (pool.length > 1) pool.splice(idx, 1); // 至少保留一个
          } else {
            pool.push(k);
          }
          store[row.key] = pool;
          chip.classList.toggle('active', pool.includes(k));
          saveSettings(this.settings);
        });
      });
      return;
    }

    if (row.kind === 'dual') {
      const pair = DUAL_PAIRS[row.key];
      if (!pair) return;
      const store = this.settings as unknown as Record<string, unknown>;
      const bind = (suffix: string, key: keyof Settings) => {
        const el = this.root.querySelector<HTMLInputElement>(`#set-${id}-${suffix}`)!;
        el.addEventListener('input', () => {
          let n = Number(el.value);
          if (!Number.isFinite(n)) return;
          n = Math.min(row.max ?? 100, Math.max(row.min ?? 1, n));
          store[key] = n;
          saveSettings(this.settings);
        });
      };
      bind('min', pair.minKey);
      bind('max', pair.maxKey);
      return;
    }

    const el = this.root.querySelector<HTMLInputElement | HTMLSelectElement>(`#set-${id}`)!;
    el.addEventListener('input', () => {
      switch (row.kind) {
        case 'range': {
          const num = Number((el as HTMLInputElement).value);
          (this.settings as unknown as Record<string, unknown>)[row.key] = num;
          const valEl = this.root.querySelector<HTMLElement>(`#set-val-${id}`);
          if (valEl) valEl.textContent = row.format ? row.format(num) : String(num);
          break;
        }
        case 'switch':
          (this.settings as unknown as Record<string, unknown>)[row.key] = (el as HTMLInputElement).checked;
          break;
        case 'number': {
          let num = Number((el as HTMLInputElement).value);
          if (Number.isFinite(num)) {
            if (row.min !== undefined) num = Math.max(row.min, num);
            if (row.max !== undefined) num = Math.min(row.max, num);
            (this.settings as unknown as Record<string, unknown>)[row.key] = num;
          }
          break;
        }
        case 'select':
          (this.settings as unknown as Record<string, unknown>)[row.key] = el.value;
          break;
      }
      saveSettings(this.settings);
    });
  }
}
