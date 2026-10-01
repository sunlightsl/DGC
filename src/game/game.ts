import type { FeedbackEngine } from '../devices/feedback-engine';
import type { Settings } from '../settings';
import { circleHit } from './collision';
import type { Bullet, Enemy, EnemyKind, Particle } from './entities';
import { makeBullet, makeExplosion } from './entities';
import { enemyFire } from './patterns';
import type { Input } from './input';

export type GameState = 'title' | 'playing' | 'paused' | 'over';

export interface GameDeps {
  feedback: FeedbackEngine;
  getSettings: () => Settings;
  getPressure: () => number | null;
}

const W = 800;
const H = 600;
const PLAYER_MAX_HP = 100;
const LOW_HP_LINE = 30;
const HIT_DAMAGE = 10;
const IFRAMES = 1.2;
const WAVE_DURATION = 22;
const MAX_BOMBS = 5;

interface Player {
  x: number;
  y: number;
  hp: number;
  iframes: number;
  fireCd: number;
}

export class Game {
  private ctx: CanvasRenderingContext2D;
  private state: GameState = 'title';
  private player: Player = { x: W / 2, y: H - 80, hp: PLAYER_MAX_HP, iframes: 0, fireCd: 0 };
  private bullets: Bullet[] = [];
  private enemies: Enemy[] = [];
  private particles: Particle[] = [];
  private stars: { x: number; y: number; s: number }[] = [];
  private score = 0;
  private wave = 1;
  private bombs = 3;
  private time = 0;
  private waveTimer = WAVE_DURATION;
  private spawnCd = 1;
  private bombReadyAt = 0;
  private lowHp = false;
  private shake = 0;
  private lastTs = 0;

  /** 视口缩放：把 800×600 的游戏坐标映射到全屏画布 */
  private viewScale = 1;
  private viewOx = 0;
  private viewOy = 0;

  private stateListeners = new Set<(state: GameState) => void>();

  constructor(
    private canvas: HTMLCanvasElement,
    private input: Input,
    private deps: GameDeps,
  ) {
    this.ctx = canvas.getContext('2d')!;
    for (let i = 0; i < 90; i++) {
      this.stars.push({ x: Math.random() * W, y: Math.random() * H, s: Math.random() * 1.6 + 0.4 });
    }
    window.addEventListener('resize', () => this.resize());
    this.resize();
  }

  /** 画布铺满 #game-wrap，游戏内容等比缩放居中（两边留边用背景色填充） */
  resize(): void {
    const wrap = this.canvas.parentElement;
    if (!wrap) return;
    const availW = Math.max(320, wrap.clientWidth);
    const availH = Math.max(240, wrap.clientHeight);
    const dpr = window.devicePixelRatio || 1;

    this.canvas.width = Math.round(availW * dpr);
    this.canvas.height = Math.round(availH * dpr);
    this.canvas.style.width = `${availW}px`;
    this.canvas.style.height = `${availH}px`;

    const scale = Math.min(availW / W, availH / H);
    this.viewScale = scale * dpr;
    this.viewOx = (availW * dpr - W * this.viewScale) / 2;
    this.viewOy = (availH * dpr - H * this.viewScale) / 2;
  }

  getState(): GameState {
    return this.state;
  }

  getBombs(): number {
    return this.bombs;
  }

  onStateChange(cb: (state: GameState) => void): void {
    this.stateListeners.add(cb);
  }

  private setState(state: GameState): void {
    this.state = state;
    for (const cb of this.stateListeners) cb(state);
  }

  /** 屏幕按钮：开始 / 重新开始 / 继续 */
  startGame(): void {
    if (this.state === 'title' || this.state === 'over') {
      this.reset();
      this.setState('playing');
    } else if (this.state === 'paused') {
      this.setState('playing');
    }
  }

  /** 屏幕按钮：暂停 / 继续 */
  togglePause(): void {
    if (this.state === 'playing') this.setState('paused');
    else if (this.state === 'paused') this.setState('playing');
  }

  /** ESC：退出当前对局回到标题界面 */
  exitToTitle(): void {
    if (this.state !== 'playing' && this.state !== 'paused' && this.state !== 'over') return;
    if (this.lowHp) {
      this.lowHp = false;
      this.deps.feedback.fire('lowHpOff');
    }
    this.reset();
    this.setState('title');
  }

  /** 屏幕按钮：炸弹 */
  pressBomb(): void {
    if (this.state === 'playing') this.tryBomb();
  }

  start(): void {
    requestAnimationFrame(this.loop);
  }

  private suspended = false;

  /** 对战模式下挂起单机游戏循环，避免键盘误触 */
  suspend(): void {
    this.suspended = true;
  }
  resume(): void {
    this.suspended = false;
  }

  private loop = (ts: number): void => {
    const dt = Math.min(0.033, (ts - this.lastTs) / 1000 || 0);
    this.lastTs = ts;
    if (!this.suspended) {
      this.update(dt);
      this.render();
      this.input.endFrame();
    }
    requestAnimationFrame(this.loop);
  };

  private reset(): void {
    this.player = { x: W / 2, y: H - 80, hp: PLAYER_MAX_HP, iframes: 0, fireCd: 0 };
    this.bullets = [];
    this.enemies = [];
    this.particles = [];
    this.score = 0;
    this.wave = 1;
    this.bombs = 3;
    this.time = 0;
    this.waveTimer = WAVE_DURATION;
    this.spawnCd = 1;
    this.bombReadyAt = 0;
    this.lowHp = false;
    this.shake = 0;
    this.deps.feedback.reset();
  }

  private update(dt: number): void {
    if (this.input.pressed('enter')) this.startGame();
    if (this.input.pressed('p')) this.togglePause();
    // Esc 优先关闭弹窗；有弹窗打开时不触发退出游戏
    if (this.input.pressed('escape') && !document.querySelector('.modal-backdrop:not([hidden])')) {
      this.exitToTitle();
    }
    if (this.state !== 'playing') return;

    this.time += dt;
    this.updatePlayer(dt);
    this.updateWaves(dt);
    this.updateEnemies(dt);
    this.updateBullets(dt);
    this.updateParticles(dt);
    this.handleBomb();
    this.shake = Math.max(0, this.shake - dt * 30);
  }

  private updatePlayer(dt: number): void {
    const p = this.player;
    const speed = 270;
    let dx = 0;
    let dy = 0;
    if (this.input.down('arrowleft') || this.input.down('a')) dx -= 1;
    if (this.input.down('arrowright') || this.input.down('d')) dx += 1;
    if (this.input.down('arrowup') || this.input.down('w')) dy -= 1;
    if (this.input.down('arrowdown') || this.input.down('s')) dy += 1;
    if (dx !== 0 && dy !== 0) {
      dx *= Math.SQRT1_2;
      dy *= Math.SQRT1_2;
    }
    p.x = Math.min(W - 12, Math.max(12, p.x + dx * speed * dt));
    p.y = Math.min(H - 16, Math.max(24, p.y + dy * speed * dt));
    p.iframes = Math.max(0, p.iframes - dt);

    p.fireCd -= dt;
    if (p.fireCd <= 0) {
      p.fireCd = 0.11;
      this.bullets.push(makeBullet(p.x, p.y - 14, 0, -540, true, 3));
      if (this.wave >= 3) {
        this.bullets.push(makeBullet(p.x - 8, p.y - 8, -60, -520, true, 3));
        this.bullets.push(makeBullet(p.x + 8, p.y - 8, 60, -520, true, 3));
      }
    }
  }

  private updateWaves(dt: number): void {
    this.waveTimer -= dt;
    if (this.waveTimer <= 0) {
      this.waveTimer = WAVE_DURATION;
      this.wave += 1;
      this.bombs = Math.min(MAX_BOMBS, this.bombs + 1);
      this.player.hp = Math.min(PLAYER_MAX_HP, this.player.hp + 5);
    }

    this.spawnCd -= dt;
    if (this.spawnCd <= 0) {
      this.spawnCd = Math.max(0.8, 2.4 - this.wave * 0.18);
      this.spawnEnemy();
    }
  }

  private spawnEnemy(): void {
    const roll = Math.random();
    let kind: EnemyKind = 'drifter';
    if (this.wave >= 2 && roll < 0.3) kind = 'turret';
    else if (this.wave >= 3 && roll < 0.6) kind = 'aimer';

    const base: Record<EnemyKind, { hp: number; r: number }> = {
      drifter: { hp: 3, r: 16 },
      turret: { hp: 6, r: 20 },
      aimer: { hp: 4, r: 16 },
    };
    let { hp, r } = base[kind];
    const elite = this.wave >= 4 && Math.random() < 0.15;
    if (elite) {
      hp = Math.round(hp * 2.5);
      r = Math.round(r * 1.3);
    }

    const fireCd: Record<EnemyKind, number> = { drifter: 0.5, turret: 2.4, aimer: 2.0 };
    this.enemies.push({
      pos: { x: 50 + Math.random() * (W - 100), y: -30 },
      vel: { x: 0, y: 45 + Math.random() * 30 + this.wave * 3 },
      hp,
      maxHp: hp,
      r: elite ? r + 4 : r,
      kind,
      t: 0,
      fireTimer: fireCd[kind] * (0.6 + Math.random() * 0.6),
      seed: Math.random() * Math.PI * 2,
      dead: false,
    });
  }

  private updateEnemies(dt: number): void {
    for (const e of this.enemies) {
      e.t += dt;
      e.fireTimer -= dt;
      switch (e.kind) {
        case 'drifter':
          e.pos.x += Math.sin(e.t * 2 + e.seed) * 40 * dt;
          e.pos.y += e.vel.y * dt;
          break;
        case 'turret':
          if (e.pos.y < 130) e.pos.y += e.vel.y * dt;
          e.pos.x += Math.sin(e.t + e.seed) * 24 * dt;
          break;
        case 'aimer':
          if (e.pos.y < 190) {
            e.pos.y += e.vel.y * dt;
          } else {
            const dir = Math.sign(this.player.x - e.pos.x);
            e.pos.x += dir * 55 * dt;
          }
          break;
      }
      e.pos.x = Math.min(W - 20, Math.max(20, e.pos.x));
      if (e.fireTimer <= 0 && e.pos.y > 0) {
        const fireCd: Record<EnemyKind, number> = { drifter: 0.5, turret: 2.4, aimer: 2.0 };
        e.fireTimer = fireCd[e.kind] * (0.85 + Math.random() * 0.3);
        enemyFire(this.bullets, e, { x: this.player.x, y: this.player.y }, W);
      }
      if (e.pos.y > H + 50) e.dead = true;
    }

    // 自机弹命中敌机
    for (const b of this.bullets) {
      if (!b.friendly || b.dead) continue;
      for (const e of this.enemies) {
        if (e.dead) continue;
        if (circleHit(b.pos.x, b.pos.y, b.r, e.pos.x, e.pos.y, e.r)) {
          b.dead = true;
          e.hp -= 1;
          if (e.hp <= 0) {
            e.dead = true;
            this.score += e.maxHp >= 10 ? 300 : e.kind === 'turret' ? 250 : e.kind === 'aimer' ? 150 : 100;
            makeExplosion(this.particles, e.pos.x, e.pos.y, '#ffb84c', 16);
          }
          break;
        }
      }
    }

    // 敌弹命中自机
    const p = this.player;
    if (p.iframes <= 0) {
      for (const b of this.bullets) {
        if (b.friendly || b.dead) continue;
        if (circleHit(b.pos.x, b.pos.y, b.r, p.x, p.y, 5)) {
          b.dead = true;
          this.damagePlayer();
          break;
        }
      }
    }

    // 撞机身也算受击
    if (p.iframes <= 0) {
      for (const e of this.enemies) {
        if (e.dead) continue;
        if (circleHit(e.pos.x, e.pos.y, e.r, p.x, p.y, 5)) {
          this.damagePlayer();
          break;
        }
      }
    }

    this.enemies = this.enemies.filter((e) => !e.dead);
  }

  private damagePlayer(): void {
    const p = this.player;
    p.hp -= HIT_DAMAGE;
    p.iframes = IFRAMES;
    this.shake = 8;
    makeExplosion(this.particles, p.x, p.y, '#ff4c5e', 18);
    this.deps.feedback.fire('hit');

    if (p.hp <= 0) {
      p.hp = 0;
      this.setState('over');
      if (this.lowHp) {
        this.lowHp = false;
        this.deps.feedback.fire('lowHpOff');
      }
      this.deps.feedback.fire('death');
      return;
    }
    this.checkLowHp();
  }

  private checkLowHp(): void {
    const low = this.player.hp <= LOW_HP_LINE;
    if (low && !this.lowHp) {
      this.lowHp = true;
      this.deps.feedback.fire('lowHpOn');
    } else if (!low && this.lowHp) {
      this.lowHp = false;
      this.deps.feedback.fire('lowHpOff');
    }
  }

  private handleBomb(): void {
    const s = this.deps.getSettings();
    let triggered = this.input.pressed('b') || this.input.pressed(' ');
    if (!triggered && s.bmtrEnabled) {
      const pressure = this.deps.getPressure();
      triggered = pressure !== null && pressure >= s.bmtrThreshold;
    }
    if (triggered) this.tryBomb();
  }

  /** 实际执行炸弹（键盘/屏幕按钮共用入口） */
  private tryBomb(): void {
    const s = this.deps.getSettings();
    if (this.bombs <= 0 || this.time < this.bombReadyAt) return;

    this.bombs -= 1;
    this.bombReadyAt = this.time + s.bmtrCooldownMs / 1000;
    this.player.iframes = Math.max(this.player.iframes, 1.5);

    for (const b of this.bullets) {
      if (!b.friendly && !b.dead) {
        b.dead = true;
        makeExplosion(this.particles, b.pos.x, b.pos.y, '#4cc2ff', 4);
      }
    }
    for (const e of this.enemies) {
      e.hp -= 3;
      if (e.hp <= 0) {
        e.dead = true;
        this.score += 50;
        makeExplosion(this.particles, e.pos.x, e.pos.y, '#ffb84c', 12);
      }
    }
    this.shake = 12;
    this.deps.feedback.fire('bomb');
  }

  private updateBullets(dt: number): void {
    for (const b of this.bullets) {
      b.pos.x += b.vel.x * dt;
      b.pos.y += b.vel.y * dt;
      if (b.pos.x < -40 || b.pos.x > W + 40 || b.pos.y < -40 || b.pos.y > H + 40) {
        b.dead = true;
      }
    }
    this.bullets = this.bullets.filter((b) => !b.dead);
  }

  private updateParticles(dt: number): void {
    for (const pt of this.particles) {
      pt.life += dt;
      pt.pos.x += pt.vel.x * dt;
      pt.pos.y += pt.vel.y * dt;
      pt.vel.x *= 1 - 2.4 * dt;
      pt.vel.y *= 1 - 2.4 * dt;
    }
    this.particles = this.particles.filter((pt) => pt.life < pt.maxLife);
  }

  private render(): void {
    const ctx = this.ctx;
    // 先重置变换，用背景色填满整个画布（含黑边区域）
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#05070c';
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    // 再应用游戏视口缩放
    ctx.setTransform(this.viewScale, 0, 0, this.viewScale, this.viewOx, this.viewOy);
    ctx.save();
    ctx.fillStyle = '#05070c';
    ctx.fillRect(0, 0, W, H);

    if (this.shake > 0) {
      ctx.translate((Math.random() - 0.5) * this.shake, (Math.random() - 0.5) * this.shake);
    }

    // 背景星点
    ctx.fillStyle = '#1a2130';
    for (const st of this.stars) {
      ctx.fillRect(st.x, st.y, st.s, st.s);
    }

    for (const pt of this.particles) {
      const a = 1 - pt.life / pt.maxLife;
      ctx.globalAlpha = a;
      ctx.fillStyle = pt.color;
      ctx.fillRect(pt.pos.x - pt.size / 2, pt.pos.y - pt.size / 2, pt.size, pt.size);
    }
    ctx.globalAlpha = 1;

    for (const e of this.enemies) {
      this.renderEnemy(e);
    }

    for (const b of this.bullets) {
      ctx.beginPath();
      ctx.arc(b.pos.x, b.pos.y, b.r, 0, Math.PI * 2);
      ctx.fillStyle = b.friendly ? '#4cc2ff' : '#ff4cd2';
      ctx.shadowColor = b.friendly ? '#4cc2ff' : '#ff4cd2';
      ctx.shadowBlur = 8;
      ctx.fill();
      ctx.shadowBlur = 0;
    }

    if (this.state === 'playing' || this.state === 'paused') {
      this.renderPlayer();
    }

    ctx.restore();
    this.renderHud();
    this.renderOverlay();
  }

  private renderEnemy(e: Enemy): void {
    const ctx = this.ctx;
    ctx.save();
    ctx.translate(e.pos.x, e.pos.y);
    ctx.strokeStyle = e.kind === 'turret' ? '#ffc44c' : e.kind === 'aimer' ? '#ff8a4c' : '#b06cff';
    ctx.lineWidth = 2;
    ctx.beginPath();
    if (e.kind === 'turret') {
      ctx.rect(-e.r * 0.7, -e.r * 0.7, e.r * 1.4, e.r * 1.4);
    } else if (e.kind === 'aimer') {
      ctx.moveTo(0, e.r * 0.8);
      ctx.lineTo(-e.r * 0.8, -e.r * 0.6);
      ctx.lineTo(e.r * 0.8, -e.r * 0.6);
      ctx.closePath();
    } else {
      ctx.moveTo(0, -e.r * 0.8);
      ctx.lineTo(e.r * 0.8, 0);
      ctx.lineTo(0, e.r * 0.8);
      ctx.lineTo(-e.r * 0.8, 0);
      ctx.closePath();
    }
    ctx.stroke();
    ctx.restore();

    if (e.hp < e.maxHp) {
      const w = e.r * 1.6;
      ctx.fillStyle = '#333a4a';
      ctx.fillRect(e.pos.x - w / 2, e.pos.y - e.r - 8, w, 3);
      ctx.fillStyle = '#4cff9d';
      ctx.fillRect(e.pos.x - w / 2, e.pos.y - e.r - 8, (w * e.hp) / e.maxHp, 3);
    }
  }

  private renderPlayer(): void {
    const ctx = this.ctx;
    const p = this.player;
    if (p.iframes > 0 && Math.floor(p.iframes * 12) % 2 === 0) return; // 受击闪烁

    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.strokeStyle = '#4cc2ff';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(0, -12);
    ctx.lineTo(9, 10);
    ctx.lineTo(0, 5);
    ctx.lineTo(-9, 10);
    ctx.closePath();
    ctx.stroke();
    ctx.restore();

    // 判定点点
    ctx.beginPath();
    ctx.arc(p.x, p.y, 2.5, 0, Math.PI * 2);
    ctx.fillStyle = '#ffffff';
    ctx.fill();
  }

  private renderHud(): void {
    const ctx = this.ctx;
    ctx.save();
    ctx.font = 'bold 14px Consolas, monospace';

    // HP 条
    const hpW = 180;
    ctx.fillStyle = '#333a4a';
    ctx.fillRect(12, 12, hpW, 12);
    const ratio = this.player.hp / PLAYER_MAX_HP;
    ctx.fillStyle = ratio <= 0.3 ? '#ff4c5e' : '#4cff9d';
    ctx.fillRect(12, 12, hpW * ratio, 12);
    ctx.strokeStyle = '#262d3d';
    ctx.strokeRect(12, 12, hpW, 12);
    ctx.fillStyle = '#d7dce6';
    ctx.fillText(`HP ${this.player.hp}`, 12 + hpW + 10, 23);

    // 分数 / 波次（右对齐）
    ctx.textAlign = 'right';
    ctx.fillText(`SCORE ${this.score}`, W - 12, 23);
    ctx.fillText(`WAVE ${this.wave}`, W - 12, 42);
    ctx.textAlign = 'left';

    // 炸弹数
    ctx.fillStyle = '#4cc2ff';
    for (let i = 0; i < this.bombs; i++) {
      ctx.beginPath();
      ctx.arc(18 + i * 18, 38, 6, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  private renderOverlay(): void {
    const ctx = this.ctx;
    ctx.save();
    ctx.textAlign = 'center';

    if (this.state === 'title') {
      ctx.fillStyle = 'rgba(5,7,12,0.72)';
      ctx.fillRect(0, 0, W, H);
      ctx.fillStyle = '#4cc2ff';
      ctx.font = 'bold 34px "Segoe UI", "Microsoft YaHei", sans-serif';
      ctx.fillText('DGC', W / 2, H / 2 - 60);
      ctx.fillStyle = '#d7dce6';
      ctx.font = '15px "Segoe UI", "Microsoft YaHei", sans-serif';
      ctx.fillText('WASD / 方向键移动　自动射击', W / 2, H / 2 - 16);
      ctx.fillText('空格或 B：炸弹　（连接灵猫后捏压也可触发）', W / 2, H / 2 + 8);
      ctx.fillText('P：暂停　Esc：退出游戏', W / 2, H / 2 + 32);
      ctx.fillStyle = '#8a93a6';
      ctx.fillText('点击卡片或按 Enter 开始', W / 2, H / 2 + 56);
    } else if (this.state === 'paused') {
      ctx.fillStyle = 'rgba(5,7,12,0.6)';
      ctx.fillRect(0, 0, W, H);
      ctx.fillStyle = '#d7dce6';
      ctx.font = 'bold 26px "Segoe UI", "Microsoft YaHei", sans-serif';
      ctx.fillText('已暂停', W / 2, H / 2);
      ctx.font = '14px "Segoe UI", "Microsoft YaHei", sans-serif';
      ctx.fillText('按 P 继续', W / 2, H / 2 + 28);
    } else if (this.state === 'over') {
      ctx.fillStyle = 'rgba(5,7,12,0.72)';
      ctx.fillRect(0, 0, W, H);
      ctx.fillStyle = '#ff4c5e';
      ctx.font = 'bold 30px "Segoe UI", "Microsoft YaHei", sans-serif';
      ctx.fillText('游戏结束', W / 2, H / 2 - 30);
      ctx.fillStyle = '#d7dce6';
      ctx.font = '16px Consolas, monospace';
      ctx.fillText(`SCORE ${this.score}　WAVE ${this.wave}`, W / 2, H / 2 + 8);
      ctx.fillStyle = '#8a93a6';
      ctx.font = '14px "Segoe UI", "Microsoft YaHei", sans-serif';
      ctx.fillText('点击「重新开始」按钮或按 Enter', W / 2, H / 2 + 44);
    }

    ctx.restore();
  }
}
