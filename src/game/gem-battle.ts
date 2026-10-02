import type { DeviceManager } from '../devices/device-manager';
import { DglabSocketDeviceType } from 'dglab-kit';
import type { FeedbackEngine } from '../devices/feedback-engine';
import type { RoomClient, RoomMessage } from '../net/room-client';
import { COYOTE_WAVEFORM_OPTIONS, type Settings } from '../settings';
import { drawIcon, ICON_BY_COLOR } from './icons';
import { renderGaugePair } from '../ui/intensity-gauges';
import { icoShield, icoUp } from '../ui/svg-icons';
import { ensureNickname } from '../profile';
import { getCurrentUser } from '../account';
import { showTrophy, hideTrophy } from '../ui/trophy';
import { initRoomChat, destroyRoomChat } from '../ui/room-chat';
import { initVoice, destroyVoice } from '../ui/room-voice';
import { playSfx } from '../audio/sfx';
import type { VersusGameConfig } from '../game-settings';

/**
 * 宝石法术对战 v2：
 * - 6 色宝石，消除即自动触发效果，按本次消除数量决定强度（3 连弱、5 连强）
 *   红=电击对方 蓝=护盾(吸收伤害) 绿=净化(降自身承受) 黄=时停(冻结对方)
 *   紫=倍率(提高得分倍率) 橙=增幅(对方受到的伤害加深)
 * - 计分制胜负：每个消除的宝石 = 10 × 连锁 × 倍率，先到目标分者胜
 * - 承受值不再决定胜负，但到 100 会"过载"：自身棋盘短暂冻结
 * - 战败惩罚：限时、赢家可调波形/强度（钳制对方上限）、认输结束
 */

// 棋盘尺寸由对战配置决定，这里仅提供默认值
let COLS = 8;
let ROWS = 8;
let CELL = 60;
const COLORS = ['#ff4c5e', '#4cc2ff', '#4cff9d', '#f0c866', '#b06cff', '#ff9d4c'] as const;
const COLOR_NAMES = ['电击', '护盾', '净化', '时停', '倍率', '增幅'] as const;

const BALANCE = {
  scorePerGem: 10,
  chainScoreStep: 0.5, // 连锁对分数的渐进步长（伤害不受此影响）
  shockDmgPerGem: 2.2, // 红：每个红宝石对对方造成的伤害
  shieldPerGem: 1, // 蓝：每个蓝宝石提供的护盾点（1:1 吸收伤害）
  shieldMax: 25,
  cleansePerGem: 1.2, // 绿：每个蓝宝石降低的承受
  freezeSecPerGem: 0.4, // 黄：每个蓝宝石冻结秒数
  freezeSecMax: 3,
  multPerGem: 0.03, // 紫：倍率增量
  multMax: 3,
  multDecayPerSec: 0.015,
  ampPctPerGem: 8, // 橙：每个蓝宝石使对方受伤害 +8%
  ampPctMax: 60,
  ampSec: 10,
  sufferMax: 100,
  overloadFreezeSec: 2.5,
  idleHintSec: 5,
  agonyTickSec: 1.4, // 持续触电：每 N 秒按承受值自动脉冲
  sufferDecayPerSec: 3.0, // 承受自然衰减/秒
};

export type BoardSize = '8x8' | '10x9' | '12x10';

export const BOARD_SIZES: { key: BoardSize; label: string; cols: number; rows: number }[] = [
  { key: '8x8', label: '8 × 8（经典）', cols: 8, rows: 8 },
  { key: '10x9', label: '10 × 9（加宽）', cols: 10, rows: 9 },
  { key: '12x10', label: '12 × 10（大屏）', cols: 12, rows: 10 },
];

export interface BattleConfig {
  nickname: string;
  targetScore: number;
  boardSize: BoardSize;
}

export interface BattleDeps {
  feedback: FeedbackEngine;
  room: RoomClient;
  dm: DeviceManager;
  getSettings: () => Settings;
  /** 消消乐个人设置（颜色比例等，按账号隔离） */
  getGameConfig: () => VersusGameConfig;
  config: BattleConfig;
  onExit: () => void;
}

type Phase = 'ready' | 'playing' | 'punish' | 'won' | 'done';

interface FloatText {
  x: number;
  y: number;
  text: string;
  sub: string;
  life: number;
  maxLife: number;
  color: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 惩罚阶段快捷弹幕：胜者挑衅 / 败者求饶，含蓄好玩不越界 */
const WINNER_PHRASES = ['就这点本事？', '服不服？', '再来一局找回场子？', '这才刚开始', '承认吧，你输了', '准备好通电了吗'];
const LOSER_PHRASES = ['错了错了', '轻一点嘛', '饶了我吧', '手滑，绝对是手滑', '给我等着', '下一局一定赢'];
const DANMAKU_COLORS = ['#ffffff', '#f0c866', '#4cc2ff', '#4cff9d', '#ff9d4c'];

function el<T extends HTMLElement = HTMLElement>(id: string, _ctor?: new () => T): T {
  return document.getElementById(id) as T;
}

/** 飘一条弹幕（自己和对方都能触发调用） */
function showDanmaku(text: string): void {
  const layer = el('danmaku-layer');
  const item = document.createElement('div');
  item.className = 'danmaku-item';
  item.textContent = text;
  item.style.top = `${8 + Math.random() * 55}%`;
  item.style.color = DANMAKU_COLORS[Math.floor(Math.random() * DANMAKU_COLORS.length)];
  item.style.fontSize = `${15 + Math.random() * 9}px`;
  item.style.animationDuration = `${6 + Math.random() * 3}s`;
  item.addEventListener('animationend', () => item.remove());
  layer.appendChild(item);
  // 保险：极端情况下 animationend 不触发
  setTimeout(() => item.remove(), 10000);
}

/** 填充惩罚阶段双方的快捷语 chips */
function fillPhraseChips(containerId: string, phrases: string[]): void {
  const box = el(containerId);
  box.innerHTML = phrases.map((p) => `<button type="button" class="chip" data-phrase="${p.replace(/"/g, '')}">${p}</button>`).join('');
}

let active: GemBattle | null = null;

let staticBound = false;
function bindStaticControls(): void {
  if (staticBound) return;
  staticBound = true;

  el('battle-canvas').addEventListener('mousedown', (e) => active?.handleCanvasDown(e));
  el('btn-ready').addEventListener('click', () => active?.markReady());
  el('btn-surrender').addEventListener('click', () => active?.surrender());
  el('btn-stop-punish').addEventListener('click', () => active?.stopPunishmentAsWinner());
  el('btn-rematch-l').addEventListener('click', () => active?.requestRematch());
  el('btn-rematch-v').addEventListener('click', () => active?.requestRematch());
  el('btn-exit-l').addEventListener('click', () => active?.exit());
  el('btn-victory-exit').addEventListener('click', () => active?.exit());
  el('btn-victory-exit2').addEventListener('click', () => active?.exit());

  fillPhraseChips('punish-phrases', LOSER_PHRASES);
  fillPhraseChips('victory-phrases', WINNER_PHRASES);

  // 快捷语：点击即发送并本地飘出
  for (const id of ['punish-phrases', 'victory-phrases']) {
    el(id).addEventListener('click', (e) => {
      const phrase = (e.target as HTMLElement).dataset?.phrase;
      if (!phrase || !active) return;
      active.sendDanmaku(phrase);
    });
  }

  // 胜者波形 chips：事件委托，点选即切换输出（chips 内容每局重置）
  el('punish-wave-chips').addEventListener('click', (e) => {
    const chip = e.target as HTMLElement;
    const key = chip.dataset?.key;
    if (!key || !active) return;
    const box = el('punish-wave-chips');
    box.dataset.current = key;
    box.querySelectorAll('.chip').forEach((c) => c.classList.toggle('active', c === chip));
    active.sendPunishCtl();
  });

  el('punish-intensity').addEventListener('input', () => {
    const range = el('punish-intensity', HTMLInputElement);
    const v = Number(range.value);
    el('punish-intensity-val').textContent = v === 0 ? '自动' : String(v);
    active?.sendPunishCtl();
  });
}

export class GemBattle {
  private deps: BattleDeps;
  private canvas: HTMLCanvasElement;

  /** 按对战配置设置棋盘尺寸；格子基准加大，画布再按窗口自适应缩放 */
  private setBoardSize(size: BoardSize): void {
    const def = BOARD_SIZES.find((b) => b.key === size) ?? BOARD_SIZES[0];
    COLS = def.cols;
    ROWS = def.rows;
    CELL = Math.max(46, Math.floor(560 / Math.max(COLS, ROWS)));
  }

  /** 画布按可用空间等比缩放（坐标换算已用 getBoundingClientRect，缩放不影响操作） */
  private fitCanvas(): void {
    const main = document.getElementById('battle-main');
    const availW = (main?.clientWidth ?? 900) - 224;
    const availH = window.innerHeight - 52 - 185;
    const scale = Math.max(0.6, Math.min(availW / (COLS * CELL), availH / (ROWS * CELL), 1.25));
        this.canvas.style.width = Math.round(COLS * CELL * scale) + 'px';
        this.canvas.style.height = Math.round(ROWS * CELL * scale) + 'px';
  }
  private ctx: CanvasRenderingContext2D;
  private board: (Gem | null)[][] = [];
  private selected: { r: number; c: number } | null = null;
  private animating = false;
  private phase: Phase = 'ready';
  private exited = false;

  // 准备确认
  private selfReady = false;
  private peerReady = false;
  private countdownStarted = false;
  private countdownEndAt = 0;

  // 对局状态
  private score = 0;
  private oppScore = 0;
  private targetScore: number;
  private suffer = 0;
  private shield = 0;
  private mult = 1;
  private frozenUntil = 0;
  private overloadUntil = 0;
  private ampPct = 0;
  private ampUntil = 0;
  private colorTotal = [0, 0, 0, 0, 0, 0];
  private floats: FloatText[] = [];
  private lastActionAt = performance.now();
  private hintPair: [number, number, number, number] | null = null; // r1,c1,r2,c2

  // 身份
  private myName: string;
  private myUser = '';
  private peerName = '对方';
  private peerUser = '';

  // 惩罚状态
  private punishTimer: ReturnType<typeof setInterval> | null = null;
  private punishStartAt = 0;
  private surrenderClicks = 0;
  private punishRounds = 0;
  private punishEndsAt = 0;
  private ctlWaveform = 'random';
  private ctlIntensity = 0;
  private oppDev = { conn: false, a: 0, b: 0, maxA: 100, maxB: 100, wave: '', intensity: 0 };
  private resultReported = false;

  // 再来一局
  private rematchSent = false;
  private peerRematch = false;

  private offMsg: (() => void) | null = null;
  private offClose: (() => void) | null = null;
  private raf = 0;
  private lastTs = 0;
  private destroyed = false;
  private gaugeTimer: ReturnType<typeof setInterval> | null = null;
  private agonyAcc = 0;

  constructor(deps: BattleDeps) {
    this.deps = deps;
    this.myName = deps.config.nickname || ensureNickname();
    this.myUser = getCurrentUser()?.username ?? '';
    this.setBoardSize(deps.config.boardSize);
    this.targetScore = deps.config.targetScore;
    this.canvas = el('battle-canvas', HTMLCanvasElement);
    this.canvas.width = COLS * CELL;
    this.canvas.height = ROWS * CELL;
    this.ctx = this.canvas.getContext('2d')!;
    bindStaticControls();
    this.initBoard();
    this.fitCanvas();
    window.addEventListener('resize', () => this.fitCanvas());
    this.bindNetwork();
    this.updateHud();
    el('target-val').textContent = `目标 ${this.targetScore}`;
    this.gaugeTimer = setInterval(() => this.refreshDevPanel(), 600);
  }

  start(): void {
    active = this;
    this.fitCanvas();
    this.updateReadyUi();
    this.deps.room.send({ kind: 'hello', name: this.myName, user: this.myUser, target: this.targetScore, board: this.deps.config.boardSize });
    this.lastTs = performance.now();
    this.raf = requestAnimationFrame(this.loop);
  }

  destroy(): void {
    this.destroyed = true;
    cancelAnimationFrame(this.raf);
    if (this.punishTimer) clearInterval(this.punishTimer);
    if (this.gaugeTimer) clearInterval(this.gaugeTimer);
    this.offMsg?.();
    this.offClose?.();
    this.deps.feedback.stopPunishment();
    hideTrophy();
    destroyRoomChat();
    destroyVoice();
    el('danmaku-layer').innerHTML = '';
    if (active === this) active = null;
  }

  // ===== 准备确认 =====

  markReady(): void {
    if (this.destroyed || this.exited || this.phase !== 'ready' || this.selfReady) return;
    this.selfReady = true;
    this.deps.room.send({ kind: 'ready' });
    this.updateReadyUi();
    if (this.peerReady) this.startCountdown();
  }

  private updateReadyUi(): void {
    const btn = el('btn-ready', HTMLButtonElement);
    btn.disabled = this.selfReady;
    btn.textContent = this.selfReady ? '已准备' : '准 备';
    const me = this.selfReady ? '✓ 我方已准备' : '○ 我方未准备';
    const peer = this.peerReady ? '✓ 对方已准备' : '等待对方准备…';
    el('ready-status').textContent = `${me}　·　${peer}`;
  }

  private startCountdown(): void {
    if (this.countdownStarted) return;
    this.countdownStarted = true;
    this.countdownEndAt = performance.now() + 2400;
    el('ready-status').textContent = '双方已就绪，3 秒后开始…';
    setTimeout(() => this.tickCountdown(), 2500);
  }

  private tickCountdown(): void {
    if (this.phase !== 'ready' || !this.countdownStarted) return;
    const left = this.countdownEndAt - performance.now();
    if (left <= 0) {
      el('ready-overlay').hidden = true;
      this.phase = 'playing';
      this.updateHud();
    } else {
      el('ready-status').textContent = `双方已就绪，${Math.ceil(left / 800)} 秒后开始…`;
    }
  }

  // ===== 棋盘 =====

  private initBoard(): void {
    this.board = [];
    for (let r = 0; r < ROWS; r++) {
      const row: (Gem | null)[] = [];
      for (let c = 0; c < COLS; c++) row.push(this.newGem(r, c));
      this.board.push(row);
    }
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        let guard = 0;
        while (this.wouldMatch(r, c) && guard++ < 20) {
          this.board[r][c] = this.newGem(r, c);
        }
      }
    }
    this.ensurePlayable();
  }

  private newGem(r: number, c: number): Gem {
    return {
      color: this.rollColor(),
      special: 0,
      px: c * CELL,
      py: r * CELL,
      clearing: false,
    };
  }

  /** 按 colorWeights 加权随机一个颜色（防御色权重低 → 刷得少） */
  private rollColor(): number {
    const w = this.deps.getGameConfig().colorWeights;
    let total = 0;
    for (let i = 0; i < COLORS.length; i++) total += Math.max(0, w[i] ?? 1);
    if (total <= 0) return Math.floor(Math.random() * COLORS.length);
    let roll = Math.random() * total;
    for (let i = 0; i < COLORS.length; i++) {
      roll -= Math.max(0, w[i] ?? 1);
      if (roll <= 0) return i;
    }
    return COLORS.length - 1;
  }

  private wouldMatch(r: number, c: number): boolean {
    const g = this.board[r]?.[c];
    if (!g) return false;
    const l1 = this.board[r]?.[c - 1];
    const l2 = this.board[r]?.[c - 2];
    const u1 = this.board[r - 1]?.[c];
    const u2 = this.board[r - 2]?.[c];
    return (
      (l1?.color === g.color && l2?.color === g.color && l1.special !== 3 && l2.special !== 3) ||
      (u1?.color === g.color && u2?.color === g.color && u1.special !== 3 && u2.special !== 3)
    );
  }

  /** 找不到可消除的交换时重洗棋盘 */
  private ensurePlayable(): void {
    if (this.findPossibleMove()) return;
    let guard = 0;
    do {
      for (let r = 0; r < ROWS; r++) {
        for (let c = 0; c < COLS; c++) this.board[r][c] = this.newGem(r, c);
      }
      guard++;
    } while ((!this.findPossibleMove() || this.findMatches().cells.size > 0) && guard < 30);
  }

  /** 暴力搜索一个可消除的相邻交换 */
  private findPossibleMove(): [number, number, number, number] | null {
    const dirs: [number, number][] = [
      [0, 1],
      [1, 0],
    ];
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        for (const [dr, dc] of dirs) {
          const r2 = r + dr;
          const c2 = c + dc;
          if (r2 >= ROWS || c2 >= COLS) continue;
          const tmp = this.board[r][c];
          this.board[r][c] = this.board[r2][c2];
          this.board[r2][c2] = tmp;
          const ok = this.findMatches().cells.size > 0;
          const tmp2 = this.board[r][c];
          this.board[r][c] = this.board[r2][c2];
          this.board[r2][c2] = tmp2;
          if (ok) return [r, c, r2, c2];
        }
      }
    }
    return null;
  }

  // ===== 输入 =====

  handleCanvasDown(e: MouseEvent): void {
    if (this.destroyed) return;
    if (this.animating || this.phase !== 'playing' || this.isFrozen()) return;
    const { r, c } = this.cellFromEvent(e);
    if (r < 0 || c < 0 || r >= ROWS || c >= COLS) return;
    this.lastActionAt = performance.now();
    this.hintPair = null;
    if (this.selected && this.selected.r === r && this.selected.c === c) {
      this.selected = null;
      return;
    }
    if (this.selected && Math.abs(this.selected.r - r) + Math.abs(this.selected.c - c) === 1) {
      const a = this.selected;
      this.selected = null;
      void this.trySwap(a, { r, c });
    } else {
      this.selected = { r, c };
    }
  }

  private cellFromEvent(e: MouseEvent): { r: number; c: number } {
    const rect = this.canvas.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * COLS * CELL;
    const y = ((e.clientY - rect.top) / rect.height) * ROWS * CELL;
    return { r: Math.floor(y / CELL), c: Math.floor(x / CELL) };
  }

  private isFrozen(): boolean {
    return performance.now() < this.frozenUntil || performance.now() < this.overloadUntil;
  }

  // ===== 交换与消除 =====

  private async trySwap(a: { r: number; c: number }, b: { r: number; c: number }): Promise<void> {
    const ga = this.board[a.r][a.c];
    const gb = this.board[b.r][b.c];
    if (!ga || !gb) return;
    this.animating = true;

    if (ga.special === 3 || gb.special === 3) {
      const other = ga.special === 3 ? gb : ga;
      this.swapCells(a, b);
      await sleep(160);
      await this.clearAllOfColor(other.color);
      await this.resolveBoard();
      this.animating = false;
      return;
    }

    this.swapCells(a, b);
    await sleep(160);

    const groups = this.findMatches();
    if (groups.cells.size === 0) {
      this.swapCells(a, b);
      await sleep(160);
      this.animating = false;
      return;
    }

    await this.resolveBoard(a, b);
    this.animating = false;
  }

  private swapCells(a: { r: number; c: number }, b: { r: number; c: number }): void {
    const tmp = this.board[a.r][a.c];
    this.board[a.r][a.c] = this.board[b.r][b.c];
    this.board[b.r][b.c] = tmp;
  }

  private findMatches(): { cells: Set<string>; runs: { cells: [number, number][]; color: number; dir: 'h' | 'v' }[] } {
    const cells = new Set<string>();
    const runs: { cells: [number, number][]; color: number; dir: 'h' | 'v' }[] = [];

    for (let r = 0; r < ROWS; r++) {
      let c = 0;
      while (c < COLS) {
        const g = this.board[r][c];
        if (!g || g.special === 3) {
          c++;
          continue;
        }
        let len = 1;
        while (c + len < COLS) {
          const n = this.board[r][c + len];
          if (!n || n.special === 3 || n.color !== g.color) break;
          len++;
        }
        if (len >= 3) {
          const runCells: [number, number][] = [];
          for (let i = 0; i < len; i++) {
            cells.add(`${r},${c + i}`);
            runCells.push([r, c + i]);
          }
          runs.push({ cells: runCells, color: g.color, dir: 'h' });
        }
        c += len;
      }
    }

    for (let c = 0; c < COLS; c++) {
      let r = 0;
      while (r < ROWS) {
        const g = this.board[r][c];
        if (!g || g.special === 3) {
          r++;
          continue;
        }
        let len = 1;
        while (r + len < ROWS) {
          const n = this.board[r + len][c];
          if (!n || n.special === 3 || n.color !== g.color) break;
          len++;
        }
        if (len >= 3) {
          const runCells: [number, number][] = [];
          for (let i = 0; i < len; i++) {
            cells.add(`${r + i},${c}`);
            runCells.push([r + i, c]);
          }
          runs.push({ cells: runCells, color: g.color, dir: 'v' });
        }
        r += len;
      }
    }

    return { cells, runs };
  }

  private async resolveBoard(swapA?: { r: number; c: number }, swapB?: { r: number; c: number }): Promise<void> {
    let chain = 0;
    let groups = this.findMatches();

    while (groups.cells.size > 0 && chain < 12) {
      chain++;
      this.spawnSpecials(groups.runs, swapA, swapB);

      // 条纹块连带清整行/列
      const extra = new Set<string>();
      for (const key of groups.cells) {
        const [r, c] = key.split(',').map(Number);
        const g = this.board[r][c];
        if (g && g.special === 1) {
          for (let cc = 0; cc < COLS; cc++) extra.add(`${r},${cc}`);
        } else if (g && g.special === 2) {
          for (let rr = 0; rr < ROWS; rr++) extra.add(`${rr},${c}`);
        }
      }
      for (const key of extra) groups.cells.add(key);

      // 统计（含连锁加成）
      const counts = [0, 0, 0, 0, 0, 0];
      let cx = 0;
      let cy = 0;
      for (const key of groups.cells) {
        const [r, c] = key.split(',').map(Number);
        const g = this.board[r][c];
        if (!g || g.clearing) continue;
        g.clearing = true;
        counts[g.color] += 1;
        cx += c;
        cy += r;
        this.colorTotal[g.color] += 1;
      }
      const n = groups.cells.size;
      cx /= n;
      cy /= n;

      // 计分 + 自动触发效果
      const chainFactor = 1 + (chain - 1) * BALANCE.chainScoreStep;
      const gain = Math.round(n * BALANCE.scorePerGem * chainFactor * this.mult);
      this.score += gain;
      playSfx('gem');
      this.spawnFloat(cx * CELL + CELL / 2, cy * CELL, `+${gain}`, chain > 1 ? `连锁×${chain}` : '', '#f0c866');
      this.applyColorEffects(counts, chain);

      await sleep(240);
      for (const key of groups.cells) {
        const [r, c] = key.split(',').map(Number);
        this.board[r][c] = null;
      }
      this.dropAndRefill();
      await sleep(240);
      groups = this.findMatches();
    }

    this.ensurePlayable();
    this.updateHud();
    this.broadcastScore();
    this.checkWin();
  }

  /** 消除自动触发：按本次各颜色消除数量决定强度 */
  private applyColorEffects(counts: number[], chain: number): void {
    if (this.phase !== 'playing' && this.phase !== 'won') return;

    const red = counts[0];
    if (red > 0) {
      const dmg = Math.round(red * BALANCE.shockDmgPerGem * chain);
      this.deps.room.send({ kind: 'shock', power: dmg });
    }
    if (counts[1] > 0) {
      this.shield = Math.min(BALANCE.shieldMax, this.shield + counts[1]);
      this.spawnFloat(CELL * 4, CELL * 7.6, `护盾+${counts[1]}`, '', '#4cc2ff');
    }
    if (counts[2] > 0) {
      const relief = Math.round(counts[2] * BALANCE.cleansePerGem);
      this.suffer = Math.max(0, this.suffer - relief);
      this.spawnFloat(CELL * 4, CELL * 7.6, `净化-${relief}`, '', '#4cff9d');
    }
    if (counts[3] > 0) {
      const sec = Math.min(BALANCE.freezeSecMax, counts[3] * BALANCE.freezeSecPerGem * chain);
      this.deps.room.send({ kind: 'freeze', sec: Math.round(sec * 10) / 10 });
    }
    if (counts[4] > 0) {
      this.mult = Math.min(BALANCE.multMax, this.mult + counts[4] * BALANCE.multPerGem);
    }
    if (counts[5] > 0) {
      const pct = Math.min(BALANCE.ampPctMax, counts[5] * BALANCE.ampPctPerGem);
      this.deps.room.send({ kind: 'amp', pct, sec: BALANCE.ampSec });
    }
  }

  private async clearAllOfColor(color: number): Promise<void> {
    let count = 0;
    let cx = 0;
    let cy = 0;
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        const g = this.board[r][c];
        if (g && g.color === color && !g.clearing) {
          g.clearing = true;
          count++;
          cx += c;
          cy += r;
          this.colorTotal[color] += 1;
        }
      }
    }
    if (count > 0) {
      const gain = Math.round(count * BALANCE.scorePerGem * 0.5 * this.mult);
      this.score += gain;
      this.spawnFloat((cx / count) * CELL + CELL / 2, (cy / count) * CELL, `+${gain}`, '彩虹爆发', '#ffd97e');
      const counts = [0, 0, 0, 0, 0, 0];
      counts[color] = count;
      this.applyColorEffects(counts, 1);
    }
    await sleep(240);
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        if (this.board[r][c]?.clearing) this.board[r][c] = null;
      }
    }
    this.dropAndRefill();
  }

  private spawnSpecials(
    runs: { cells: [number, number][]; color: number; dir: 'h' | 'v' }[],
    swapA?: { r: number; c: number },
    swapB?: { r: number; c: number },
  ): void {
    const prefer = [swapB, swapA];
    for (const run of runs) {
      let spot: [number, number] | null = null;
      for (const p of prefer) {
        if (p && run.cells.some(([r, c]) => r === p.r && c === p.c)) {
          spot = [p.r, p.c];
          break;
        }
      }
      if (!spot) spot = run.cells[Math.floor(run.cells.length / 2)];
      const g = this.board[spot[0]][spot[1]];
      if (!g) continue;
      if (run.cells.length >= 5) {
        g.special = 3;
      } else if (run.cells.length === 4 && g.special === 0) {
        g.special = run.dir === 'h' ? 1 : 2;
      }
    }
  }

  private dropAndRefill(): void {
    for (let c = 0; c < COLS; c++) {
      let write = ROWS - 1;
      for (let r = ROWS - 1; r >= 0; r--) {
        const g = this.board[r][c];
        if (g) {
          this.board[write][c] = g;
          if (write !== r) this.board[r][c] = null;
          write--;
        }
      }
      for (let r = write; r >= 0; r--) {
        this.board[r][c] = this.newGem(-(write - r) - 1, c);
      }
    }
  }

  private spawnFloat(x: number, y: number, text: string, sub: string, color: string): void {
    this.floats.push({ x, y, text, sub, life: 0, maxLife: 1.1, color });
  }

  // ===== 网络 =====

  private bindNetwork(): void {
    initRoomChat(this.deps.room, (self) => (self ? this.myName : this.peerName));
    initVoice(this.deps.room, this.deps.room.role === 2 ? 2 : 1);
    this.offMsg = this.deps.room.onMessage((msg: RoomMessage) => {
      if (msg.t === 'peerLeft') {
        this.handlePeerLeft();
        return;
      }
      if (msg.t !== 'relay') return;
      this.handleCast(msg);
    });
    this.offClose = this.deps.room.onClose(() => {
      if (this.destroyed || this.exited) return;
      this.showToast('对方已断开连接');
      setTimeout(() => this.exit(), 1500);
    });
  }

  private handleCast(msg: RoomMessage): void {
    const kind = msg.kind as string;
    switch (kind) {
      case 'hello':
        this.peerName = String(msg.name ?? '对方');
        this.peerUser = String(msg.user ?? '').slice(0, 16);
        if (this.deps.room.role === 2) {
          this.targetScore = Number(msg.target) || this.targetScore;
          el('target-val').textContent = `目标 ${this.targetScore}`;
          // 棋盘尺寸以房主为准
          const peerBoard = BOARD_SIZES.find((bb) => bb.key === msg.board);
          if (peerBoard && peerBoard.key !== this.deps.config.boardSize) {
            this.setBoardSize(peerBoard.key);
            this.canvas.width = COLS * CELL;
            this.canvas.height = ROWS * CELL;
            this.initBoard();
          }
        }
        break;
      case 'config':
        if (this.deps.room.role === 2) {
          this.targetScore = Number(msg.target) || this.targetScore;
          el('target-val').textContent = `目标 ${this.targetScore}`;
        }
        break;
      case 'ready':
        if (this.phase === 'ready') {
          this.peerReady = true;
          this.updateReadyUi();
          if (this.selfReady) this.startCountdown();
        }
        break;
      case 'shock': {
        const power = Number(msg.power) || 0;
        let dmg = power;
        if (this.shield > 0) {
          const absorbed = Math.min(this.shield, dmg);
          this.shield -= absorbed;
          dmg -= absorbed;
          if (absorbed > 0) this.spawnFloat(CELL * 4, CELL * 7.2, `护盾抵挡 ${absorbed}`, '', '#4cc2ff');
        }
        if (dmg > 0 && performance.now() < this.ampUntil) {
          dmg = Math.round((dmg * (100 + this.ampPct)) / 100);
        }
        if (dmg > 0) {
          this.suffer = Math.min(BALANCE.sufferMax, this.suffer + dmg);
          this.deps.feedback.shock(dmg); // 伤害值直接作为强度基准，不再二次换算
          if (this.suffer >= BALANCE.sufferMax) this.overload();
        }
        break;
      }
      case 'freeze':
        this.frozenUntil = performance.now() + Number(msg.sec || 1) * 1000;
        break;
      case 'amp':
        this.ampPct = Number(msg.pct) || 0;
        this.ampUntil = performance.now() + (Number(msg.sec) || BALANCE.ampSec) * 1000;
        this.spawnFloat(CELL * 4, CELL * 2, `受到伤害 +${this.ampPct}%`, '', '#ff9d4c');
        break;
      case 'overload':
        this.spawnFloat(CELL * 4, CELL * 1.5, '对方过载！', '', '#ff4c5e');
        break;
      case 'score':
        this.oppScore = Number(msg.v) || 0;
        break;
      case 'devstat':
        this.oppDev = {
          conn: Boolean(msg.conn),
          a: Number(msg.a) || 0,
          b: Number(msg.b) || 0,
          maxA: Number(msg.maxA) || 100,
          maxB: Number(msg.maxB) || 100,
          wave: String(msg.wave ?? ''),
          intensity: Number(msg.intensity) || 0,
        };
        break;
      case 'punishStop':
        if (this.phase === 'punish') {
          this.endPunishment('对方停止了惩罚');
        }
        break;
      case 'punishCtl':
        this.ctlWaveform = String(msg.waveform ?? 'random');
        this.ctlIntensity = Math.max(0, Number(msg.intensity) || 0);
        break;
      case 'danmaku':
        showDanmaku(String(msg.text ?? '').slice(0, 30));
        break;
      case 'over':
        // 分数制：over 由先到目标分的一方发出，接收方是败者 → 回传强度上限并进入惩罚
        this.deps.room.send({ kind: 'limits', punishMax: this.deps.getSettings().punishIntensityMax });
        void this.loseToScore();
        break;
      case 'limits':
        if (this.phase === 'won') this.showVictory(Number(msg.punishMax) || 100);
        break;
      case 'punishRound': {
        if (this.phase === 'won') {
          el('victory-info').textContent = `惩罚进行中 · 第 ${Number(msg.n) || 0} 轮 · 强度 ${Number(msg.power) || 0}`;
        }
        break;
      }
      case 'punishEnd':
        if (this.phase === 'won' && el('victory-actions-end').hidden) this.showVictoryEnd('惩罚已结束');
        break;
      case 'surrender':
        if (this.phase === 'won') this.showVictoryEnd('对方已认输，你赢了！');
        break;
      case 'rematch':
        this.peerRematch = true;
        this.updateRematchButtons();
        if (this.rematchSent) this.doRematch();
        break;
    }
    this.updateHud();
  }

  private broadcastScore(): void {
    this.deps.room.send({ kind: 'score', v: this.score });
  }

  private checkWin(): void {
    if (this.phase !== 'playing') return;
    if (this.score >= this.targetScore) {
      this.phase = 'won';
      this.reportResult(true); // 我赢了
      this.deps.room.send({ kind: 'over' });
      // 等败者回传其强度上限再弹出控制面板；3 秒未回传则用自己的上限兜底
      setTimeout(() => {
        if (!this.destroyed && !this.exited && el('result-victory').hidden) {
          this.showVictory(this.deps.getSettings().punishIntensityMax);
        }
      }, 3000);
    }
  }

  /** 承受过载：自身短暂冻结，承受回落 */
  private overload(): void {
    this.overloadUntil = performance.now() + BALANCE.overloadFreezeSec * 1000;
    this.suffer = Math.round(BALANCE.sufferMax * 0.5);
    this.deps.feedback.fire('death');
    this.deps.room.send({ kind: 'overload' });
    this.spawnFloat(CELL * 4, CELL * 4, '承受过载！', `冻结 ${BALANCE.overloadFreezeSec}s`, '#ff4c5e');
  }

  /** 上报战绩（只有胜者上报一次，比分进公示区） */
  private reportResult(iWon: boolean): void {
    if (this.resultReported) return;
    this.resultReported = true;
    const winScore = iWon ? this.score : this.oppScore;
    const loseScore = iWon ? this.oppScore : this.score;
    this.deps.room.reportResult('versus', iWon ? this.myName : this.peerName, iWon ? this.peerName : this.myName, winScore, loseScore);
  }

  // ===== 胜负与惩罚 =====

  private async loseToScore(): Promise<void> {
    if (this.phase !== 'playing') return;
    this.phase = 'punish';
    this.deps.feedback.fire('death');
    playSfx('defeat');
    // 只由胜者上报战绩，避免双端重复计数
    el('result-punish').hidden = false;
    this.punishStartAt = performance.now();
    this.surrenderClicks = 0;
    this.punishEndsAt = performance.now() + this.deps.getSettings().punishMaxSec * 1000;
    this.runPunishRound();
    this.punishTimer = setInterval(() => this.runPunishRound(), this.deps.getSettings().punishStepSec * 1000);
  }

  private runPunishRound(): void {
    if (performance.now() >= this.punishEndsAt) {
      this.endPunishment('惩罚时间到，自动结束');
      return;
    }
    const s = this.deps.getSettings();
    this.punishRounds += 1;

    const key = this.ctlWaveform === 'random' ? String(pick(s.punishWaveforms)) : this.ctlWaveform;
    // 强度永远在败者自己设置的 [min, max] 内随机；系统上限在反馈引擎里统一钳
    let raw: number;
    if (this.ctlIntensity > 0) {
      raw = this.ctlIntensity;
    } else {
      raw = randInt(s.punishIntensityMin, Math.max(s.punishIntensityMin, s.punishIntensityMax));
    }
    raw = Math.min(raw, s.punishIntensityMax); // 绝不越过自己设置的上限

    this.deps.feedback.punishPulse(key, raw);
    el('punish-round').textContent = String(this.punishRounds);
    el('punish-power').textContent = String(raw);
    this.deps.room.send({ kind: 'punishRound', n: this.punishRounds, power: raw });
  }

  private endPunishment(infoText: string): void {
    if (this.punishTimer) {
      clearInterval(this.punishTimer);
      this.punishTimer = null;
    }
    this.deps.feedback.stopPunishment();
    el('result-punish').hidden = true;
    el('punish-end-info').textContent = infoText;
    el('result-punish-end').hidden = false;
    this.deps.room.send({ kind: 'punishEnd' });
  }

  surrender(): void {
    if (this.phase !== 'punish') return;
    const left = 10000 - (performance.now() - this.punishStartAt);
    if (left > 0) {
      this.surrenderClicks++;
      if (this.surrenderClicks >= 3) {
        this.showToast('轻点轻点～惩罚至少 10 秒，这是规矩');
      } else {
        this.showToast(`才 ${Math.ceil((performance.now() - this.punishStartAt) / 1000)} 秒，再坚持 ${Math.ceil(left / 1000)} 秒`);
      }
      return;
    }
    this.deps.feedback.stopPunishment();
    if (this.punishTimer) {
      clearInterval(this.punishTimer);
      this.punishTimer = null;
    }
    el('result-punish').hidden = true;
    el('punish-end-info').textContent = '已认输，惩罚结束';
    el('result-punish-end').hidden = false;
    this.deps.room.send({ kind: 'surrender' });
  }

  private showVictory(punishMax: number): void {
    el('result-victory').hidden = false;
    el('victory-info').textContent = `${this.peerName} 战败，惩罚进行中…`;
    playSfx('victory');

    // 波形 chips：首位「随机」，点击即生效
    const box = el('punish-wave-chips');
    box.dataset.current = 'random';
    box.innerHTML =
      `<button type="button" class="chip active" data-key="random">随机（对方惩罚池）</button>` +
      COYOTE_WAVEFORM_OPTIONS.map((o) => `<button type="button" class="chip" data-key="${o.key}">${o.label}</button>`).join('');
    const range = el('punish-intensity', HTMLInputElement);
    range.max = String(Math.max(1, punishMax));
    range.value = '0';
    el('punish-intensity-val').textContent = '自动';

    el('victory-controls').hidden = false;
    el('victory-actions-punish').hidden = false;
    el('victory-actions-end').hidden = true;
    void showTrophy(this.peerUser || this.peerName, this.peerName);
  }

  private showVictoryEnd(text: string): void {
    el('victory-info').textContent = text;
    el('victory-controls').hidden = true;
    el('victory-actions-punish').hidden = true;
    el('victory-actions-end').hidden = false;
    this.updateRematchButtons();
    hideTrophy();
  }

  /** 胜者主动停止对方惩罚 */
  stopPunishmentAsWinner(): void {
    if (this.phase !== 'won' || el('result-victory').hidden) return;
    this.deps.room.send({ kind: 'punishStop' });
    this.showVictoryEnd('你已停止惩罚，对方解脱了');
  }

  sendPunishCtl(): void {
    if (this.phase !== 'won') return;
    this.deps.room.send({
      kind: 'punishCtl',
      waveform: el('punish-wave-chips').dataset.current || 'random',
      intensity: Number(el('punish-intensity', HTMLInputElement).value) || 0,
    });
  }

  /** 惩罚阶段发送弹幕快捷语（本地立刻飘出，同时发给对方） */
  sendDanmaku(text: string): void {
    if (this.phase !== 'punish' && this.phase !== 'won') return;
    showDanmaku(text);
    this.deps.room.send({ kind: 'danmaku', text });
  }

  // ===== 再来一局 =====

  requestRematch(): void {
    if (this.destroyed || this.exited || this.rematchSent) return;
    this.rematchSent = true;
    this.deps.room.send({ kind: 'rematch' });
    this.updateRematchButtons();
    if (this.peerRematch) this.doRematch();
  }

  private updateRematchButtons(): void {
    const text = this.rematchSent ? (this.peerRematch ? '开局中…' : '等待对方…') : '再来一局';
    el('btn-rematch-l', HTMLButtonElement).textContent = text;
    el('btn-rematch-v', HTMLButtonElement).textContent = text;
    el('btn-rematch-l', HTMLButtonElement).disabled = this.rematchSent;
    el('btn-rematch-v', HTMLButtonElement).disabled = this.rematchSent;
  }

  private doRematch(): void {
    el('result-punish').hidden = true;
    el('result-punish-end').hidden = true;
    el('result-victory').hidden = true;

    if (this.punishTimer) {
      clearInterval(this.punishTimer);
      this.punishTimer = null;
    }
    this.deps.feedback.stopPunishment();
    this.deps.feedback.reset();

    this.phase = 'playing';
    this.selfReady = true;
    this.peerReady = true;
    this.countdownStarted = true;
    el('ready-overlay').hidden = true;

    this.score = 0;
    this.oppScore = 0;
    this.suffer = 0;
    this.shield = 0;
    this.mult = 1;
    this.frozenUntil = 0;
    this.overloadUntil = 0;
    this.ampPct = 0;
    this.ampUntil = 0;
    this.colorTotal = [0, 0, 0, 0, 0, 0];
    this.floats = [];
    this.punishRounds = 0;
    this.ctlWaveform = 'random';
    this.ctlIntensity = 0;
    this.rematchSent = false;
    this.peerRematch = false;
    this.resultReported = false;
    this.selected = null;
    this.animating = false;
    el('btn-rematch-l', HTMLButtonElement).disabled = false;
    el('btn-rematch-v', HTMLButtonElement).disabled = false;
    el('btn-rematch-l', HTMLButtonElement).textContent = '再来一局';
    el('btn-rematch-v', HTMLButtonElement).textContent = '再来一局';

    this.initBoard();
    this.updateHud();
    this.broadcastScore();
    this.deps.room.send({ kind: 'score', v: 0 });
  }

  private showToast(text: string): void {
    const toast = el('battle-toast');
    toast.textContent = text;
    toast.hidden = false;
    setTimeout(() => {
      toast.hidden = true;
    }, 2000);
  }

  exit(): void {
    if (this.exited) return;
    this.exited = true;
    this.phase = 'done';
    if (this.punishTimer) {
      clearInterval(this.punishTimer);
      this.punishTimer = null;
    }
    el('result-punish').hidden = true;
    el('result-punish-end').hidden = true;
    el('result-victory').hidden = true;
    this.deps.feedback.stopPunishment();
    this.deps.onExit();
  }

  // ===== 设备状态面板 =====

  /** 双方环形仪表 + 状态行；周期把本机 A/B 强度上报给对方 */
  private refreshDevPanel(): void {
    if (this.destroyed) return;
    const dm = this.deps.dm;
    const coyote =
      dm.listByType(DglabSocketDeviceType.COYOTE_030)[0] ?? dm.listByType(DglabSocketDeviceType.COYOTE_020)[0];
    const connected = dm.connected && !!coyote;
    const a = coyote ? (dm.channelIntensity(coyote, 'A') ?? 0) : 0;
    const b = coyote ? (dm.channelIntensity(coyote, 'B') ?? 0) : 0;
    const maxA = coyote ? dm.channelMax(coyote, 'A') : 100;
    const maxB = coyote ? dm.channelMax(coyote, 'B') : 100;

    renderGaugePair(el('my-gauges'), connected ? a : 0, connected ? b : 0, maxA, maxB);
    renderGaugePair(el('opp-gauges'), this.oppDev.conn ? this.oppDev.a : 0, this.oppDev.conn ? this.oppDev.b : 0, this.oppDev.maxA, this.oppDev.maxB);

    const power = coyote?.props.power;
    const last = this.deps.feedback.lastOutput;
    const fresh = last && Date.now() - last.at < 4000;
    el('my-dev-line').textContent = connected
      ? `本机郊狼：在线 · 电量 ${typeof power === 'number' ? power + '%' : '-'} · ${fresh ? `输出 ${last.label} @ ${last.intensity}` : '空闲'}`
      : '本机郊狼：未连接';

    el('pb-self-name').textContent = `我方 · ${this.myName}`;
    el('pb-opp-name').textContent = `对方 · ${this.peerName}`;

    const od = this.oppDev;
    el('opp-dev-line').textContent = od.conn
      ? `对方郊狼：在线${od.wave ? ` · 输出 ${od.wave} @ ${od.intensity}` : ' · 空闲'}`
      : `对方郊狼：未连接`;

    this.deps.room.send({ kind: 'devstat', conn: connected, a, b, maxA, maxB, wave: fresh ? last!.label : '', intensity: fresh ? last!.intensity : 0 });
  }

  /** 对方断线：全屏提示 → 自动退回标题 */
  private handlePeerLeft(): void {
    if (this.destroyed || this.exited || this.phase === 'done') return;
    this.showToast('对方已断开连接，即将退出');
    this.deps.feedback.stopPunishment();
    setTimeout(() => this.exit(), 2000);
  }

  // ===== HUD =====

  private updateHud(): void {
    for (let i = 0; i < 6; i++) {
      const fill = el(`en-fill-${i}`);
      const val = el(`en-val-${i}`);
      const total = this.colorTotal[i];
      if (fill) fill.style.width = `${Math.min(100, total * 4)}%`;
      if (val) val.textContent = String(total);
    }
    el('my-score-fill').style.width = `${Math.min(100, (this.score / this.targetScore) * 100)}%`;
    el('my-score-val').textContent = String(this.score);
    el('opp-score-fill').style.width = `${Math.min(100, (this.oppScore / this.targetScore) * 100)}%`;
    el('opp-score-val').textContent = String(this.oppScore);
    el('my-suffer-fill').style.width = `${this.suffer}%`;
    el('my-suffer-val').textContent = String(Math.round(this.suffer));
  }

  // ===== 主循环 =====

  private loop = (ts: number): void => {
    if (this.destroyed) return;
    try {
      this.tickFrame(ts);
    } catch (err) {
      // 单帧异常不能杀死渲染循环，否则画面全冻结（事件仍响应，表现为"能玩但不动"）
      console.error('[battle] frame error', err);
    } finally {
      if (!this.destroyed) this.raf = requestAnimationFrame(this.loop);
    }
  };

  private tickFrame(ts: number): void {
    const dt = Math.min(0.05, (ts - this.lastTs) / 1000 || 0);
    this.lastTs = ts;

    if (this.mult > 1) {
      this.mult = Math.max(1, this.mult - BALANCE.multDecayPerSec * dt);
    }

    // 承受自然衰减 + 持续触电：承受值周期性转成真实设备输出
    if (this.phase === 'playing' || this.phase === 'punish') {
      this.suffer = Math.max(0, this.suffer - BALANCE.sufferDecayPerSec * dt);
      this.agonyAcc += dt;
      if (this.agonyAcc >= BALANCE.agonyTickSec) {
        this.agonyAcc = 0;
        if (this.suffer >= 10) {
          this.deps.feedback.shock(Math.round(this.suffer)); // 承受值即强度基准
          el('my-suffer-fill').style.width = this.suffer + '%';
          el('my-suffer-val').textContent = String(Math.round(this.suffer));
        }
      }
    }

    this.tickCountdown();

    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        const g = this.board[r][c];
        if (!g) continue;
        g.px += (c * CELL - g.px) * Math.min(1, dt * 14);
        g.py += (r * CELL - g.py) * Math.min(1, dt * 14);
      }
    }

    for (const f of this.floats) {
      f.life += dt;
      f.y -= 42 * dt;
    }
    this.floats = this.floats.filter((f) => f.life < f.maxLife);

    // 闲置提示
    if (this.phase === 'playing' && !this.animating && !this.isFrozen() && !this.hintPair) {
      if (performance.now() - this.lastActionAt > BALANCE.idleHintSec * 1000) {
        this.hintPair = this.findPossibleMove();
      }
    }

    this.render(ts);

    el('mult-val').textContent = `倍率 ×${this.mult.toFixed(1)}`;

    const parts: string[] = [];
    if (this.shield > 0) parts.push(`<span class=\"buff-ico\">${icoShield()}</span>护盾 ${this.shield}`);
    const ampLeft = Math.ceil((this.ampUntil - performance.now()) / 1000);
    if (ampLeft > 0) parts.push(`<span class=\"buff-ico\">${icoUp()}</span>受伤 +${this.ampPct}% · ${ampLeft}s`);
    el('buff-line').innerHTML = parts.join('　');

    const frozen = performance.now() < this.frozenUntil;
    el('freeze-overlay').hidden = !frozen;
    if (frozen) {
      el('freeze-sec').textContent = `${Math.ceil((this.frozenUntil - performance.now()) / 1000)} 秒`;
    }

    const overloaded = performance.now() < this.overloadUntil;
    el('overload-overlay').hidden = !overloaded;
    if (overloaded) {
      el('overload-sec').textContent = `${Math.ceil((this.overloadUntil - performance.now()) / 1000)} 秒`;
    }

    if (this.phase === 'punish' && this.punishEndsAt > 0) {
      el('punish-left').textContent = String(Math.max(0, Math.ceil((this.punishEndsAt - performance.now()) / 1000)));
      // 认输按钮 10 秒倒计时显示
      const lockLeft = Math.ceil((10000 - (performance.now() - this.punishStartAt)) / 1000);
      const btn = el('btn-surrender', HTMLButtonElement);
      if (lockLeft > 0) {
        btn.disabled = true;
        btn.textContent = `认输（${lockLeft} 秒后可点）`;
      } else {
        btn.disabled = false;
        btn.textContent = '认 输';
      }
    }
  }

  private render(ts: number): void {
    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        ctx.fillStyle = (r + c) % 2 === 0 ? '#0e1220' : '#101527';
        ctx.fillRect(c * CELL, r * CELL, CELL, CELL);
      }
    }

    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        const g = this.board[r][c];
        if (g) this.drawGem(g, ts);
      }
    }

    // 闲置提示：脉冲高亮一对可交换的宝石
    if (this.hintPair && this.phase === 'playing') {
      const [r1, c1, r2, c2] = this.hintPair;
      const pulse = 0.4 + Math.sin(ts / 200) * 0.3;
      ctx.strokeStyle = `rgba(76, 255, 157, ${pulse})`;
      ctx.lineWidth = 3;
      ctx.strokeRect(c1 * CELL + 2, r1 * CELL + 2, CELL - 4, CELL - 4);
      ctx.strokeRect(c2 * CELL + 2, r2 * CELL + 2, CELL - 4, CELL - 4);
    }

    if (this.selected) {
      const pulse = 0.5 + Math.sin(ts / 150) * 0.3;
      ctx.strokeStyle = `rgba(240, 200, 102, ${pulse})`;
      ctx.lineWidth = 3;
      ctx.strokeRect(this.selected.c * CELL + 2, this.selected.r * CELL + 2, CELL - 4, CELL - 4);
    }

    // 飘分
    for (const f of this.floats) {
      const a = 1 - f.life / f.maxLife;
      ctx.globalAlpha = a;
      ctx.font = 'bold 20px Consolas, monospace';
      ctx.textAlign = 'center';
      ctx.fillStyle = f.color;
      ctx.fillText(f.text, f.x, f.y);
      if (f.sub) {
        ctx.font = '12px "Segoe UI", "Microsoft YaHei", sans-serif';
        ctx.fillText(f.sub, f.x, f.y + 17);
      }
      ctx.globalAlpha = 1;
    }
    ctx.textAlign = 'left';

    if (this.isFrozen()) {
      ctx.fillStyle = 'rgba(76, 194, 255, 0.12)';
      ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    }
  }

  private drawGem(g: Gem, ts: number): void {
    const ctx = this.ctx;
    const cx = g.px + CELL / 2;
    const cy = g.py + CELL / 2;
    const baseR = g.special === 3 ? CELL * 0.42 : CELL * 0.36;
    const r = g.clearing ? baseR * 0.6 : baseR;

    if (g.special === 3) {
      for (let i = 0; i < COLORS.length; i++) {
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        const a0 = (ts / 600 + (i * Math.PI * 2) / COLORS.length) % (Math.PI * 2);
        ctx.arc(cx, cy, r, a0, a0 + (Math.PI * 2) / COLORS.length - 0.08);
        ctx.closePath();
        ctx.fillStyle = COLORS[i];
        ctx.fill();
      }
    } else {
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fillStyle = COLORS[g.color];
      ctx.fill();

      if (g.special === 1 || g.special === 2) {
        ctx.strokeStyle = 'rgba(255,255,255,0.55)';
        ctx.lineWidth = 3;
        for (let i = -1; i <= 1; i++) {
          ctx.beginPath();
          if (g.special === 1) {
            ctx.moveTo(cx - r, cy + (i * r) / 1.6);
            ctx.lineTo(cx + r, cy + (i * r) / 1.6);
          } else {
            ctx.moveTo(cx + (i * r) / 1.6, cy - r);
            ctx.lineTo(cx + (i * r) / 1.6, cy + r);
          }
          ctx.stroke();
        }
      }

      drawIcon(ctx, ICON_BY_COLOR[g.color], cx, cy, r * 1.15);
    }

    ctx.strokeStyle = 'rgba(255,255,255,0.25)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.stroke();
  }
}

interface Gem {
  color: number;
  special: 0 | 1 | 2 | 3;
  px: number;
  py: number;
  clearing: boolean;
}

function pick<T>(pool: T[]): T {
  return pool[Math.floor(Math.random() * pool.length)];
}

function randInt(min: number, max: number): number {
  return Math.floor(min + Math.random() * (max - min + 1));
}
