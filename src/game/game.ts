import type { FeedbackEngine } from '../devices/feedback-engine';
import type { Settings } from '../settings';
import type { BulletGameConfig } from '../game-settings';
import { playSfx } from '../audio/sfx';
import { circleHit } from './collision';
import type { Bullet, Enemy, EnemyKind, Particle, Pickup } from './entities';
import { makeBullet, makeExplosion } from './entities';
import { bossAimedFan, bossCrossFan, bossRadial, bossRain, bossSpiral, enemyFire } from './patterns';
import type { Input } from './input';

export type GameState = 'title' | 'playing' | 'paused' | 'over';

export interface GameDeps {
  feedback: FeedbackEngine;
  getSettings: () => Settings;
  getGameConfig: () => BulletGameConfig;
  getPressure: () => number | null;
  /** 游戏结束提交最高分（上报服务器排行） */
  submitScore?: (score: number) => void;
}

const W = 800;
const H = 600;
const PLAYER_MAX_HP = 100;
const LOW_HP_LINE = 30;
const HIT_DAMAGE = 10;
const IFRAMES = 1.2;
const WAVE_DURATION = 22;
const MAX_BOMBS = 5;

/** 核心果实拾取：进入半径开始吟唱，站满 PICKUP_TIME 秒才完成 */
const PICKUP_RADIUS = 70;
const PICKUP_TIME = 2.5;
const PICKUP_SHOCK_INTERVAL = 0.7;

/** Boss 掉落果实的升级链：按顺序获得，拿满 6 个后循环并逐代增强 */
const UPGRADE_DEFS = [
  { key: 'triple', name: '三线射击' },
  { key: 'rapid', name: '急速射击' },
  { key: 'penta', name: '五线射击' },
  { key: 'heavy', name: '重弹核心' },
  { key: 'shield', name: '能量护盾' },
  { key: 'surge', name: '过载引擎' },
] as const;
type UpgradeKey = (typeof UPGRADE_DEFS)[number]['key'];

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
  private pickups: Pickup[] = [];
  /** 已获得强化等级（= 吃掉的果实数） */
  private upgradeLevel = 0;
  /** 一次性护盾：抵挡一次受击 */
  private shieldCharges = 0;
  /** 已召唤过 Boss 的波次，保证每波最多一次（双 Boss 也只刷一轮） */
  private bossSpawnedForWave = 0;
  private leaks = 0;
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
    const cfg = this.deps.getGameConfig();
    this.player = { x: W / 2, y: H - 80, hp: PLAYER_MAX_HP, iframes: 0, fireCd: 0 };
    this.bullets = [];
    this.enemies = [];
    this.particles = [];
    this.score = 0;
    this.wave = 1;
    this.bombs = Math.min(MAX_BOMBS, Math.max(1, cfg.initialBombs));
    this.time = 0;
    this.waveTimer = WAVE_DURATION;
    this.spawnCd = 1;
    this.bombReadyAt = 0;
    this.lowHp = false;
    this.shake = 0;
    this.pickups = [];
    this.upgradeLevel = 0;
    this.shieldCharges = 0;
    this.bossSpawnedForWave = 0;
    this.leaks = 0;
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
    this.updatePickups(dt);
    this.updateParticles(dt);
    this.handleBomb();
    this.shake = Math.max(0, this.shake - dt * 30);
  }

  private updatePlayer(dt: number): void {
    const p = this.player;
    // 吟唱拾取时移速减半（拾取的代价之一）
    const speed = this.moveSpeed() * (this.inPickupRange() ? 0.5 : 1);
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
      p.fireCd = this.fireInterval();
      const dmg = this.bulletDmg();
      const spreadDeg = this.volleyAngles();
      for (const deg of spreadDeg) {
        const rad = (deg * Math.PI) / 180;
        this.bullets.push(
          makeBullet(p.x + Math.sin(rad) * 10, p.y - 14 + (Math.cos(rad) - 1) * 6, Math.sin(rad) * 540, -Math.cos(rad) * 540, true, 3, dmg),
        );
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

    // 每 5 波召唤 Boss（每波最多一次）；Boss 存活期间暂停普通刷怪
    const anyBoss = this.enemies.some((e) => e.kind === 'boss' && !e.dead);
    if (this.wave % 5 === 0 && this.bossSpawnedForWave !== this.wave) {
      this.bossSpawnedForWave = this.wave;
      this.spawnBosses();
    }
    if (!anyBoss) {
      this.spawnCd -= dt;
      if (this.spawnCd <= 0) {
        this.spawnCd = Math.max(0.8, 2.4 - this.wave * 0.18);
        this.spawnEnemy();
      }
    }
  }

  /** 每第 3 次 Boss 波（15/30/45…）一次出场两只，单体血量 ×1.6，各掉一颗果实 */
  private spawnBosses(): void {
    const tier = Math.floor(this.wave / 5);
    const doubleBoss = tier % 3 === 0;
    const hp = Math.round((60 + tier * 40) * (doubleBoss ? 1.6 : 1));
    const xs = doubleBoss ? [W / 2 - 170, W / 2 + 170] : [W / 2];
    for (const x of xs) {
      const boss: Enemy = {
        pos: { x, y: -60 },
        vel: { x: 0, y: 40 },
        hp,
        maxHp: hp,
        r: 34,
        kind: 'boss',
        t: 0,
        fireTimer: 1.2,
        seed: Math.random() * Math.PI * 2,
        attackMode: 0,
        modeTimer: 0,
        dead: false,
      };
      this.enemies.push(boss);
    }
  }

  /** Boss 模式机：0环形 1追踪扇 2螺旋 3交叉弹 4弹雨，低血量进入狂暴加速 */
  private updateBoss(b: Enemy, dt: number): void {
    const enrage = b.hp < b.maxHp * 0.35;
    const speedUp = enrage ? 0.6 : 1;

    // 入场：下到 y=110 后转为横向巡游
    if (b.pos.y < 110) {
      b.pos.y += b.vel.y * dt;
      return;
    }
    b.pos.x += Math.sin(b.t * 0.7 + b.seed) * (enrage ? 90 : 55) * dt;
    b.pos.x = Math.min(W - 50, Math.max(50, b.pos.x));

    b.modeTimer = (b.modeTimer ?? 0) - dt;
    if (b.modeTimer <= 0) {
      b.attackMode = ((b.attackMode ?? 0) + 1) % 5;
      b.modeTimer = [2.2, 1.8, 3.0, 1.6, 2.0][b.attackMode] * speedUp;
      b.fireTimer = 0.1;
      // 模式切换瞬间的一波爆发提示
      if (b.attackMode === 0) bossRadial(this.bullets, b.pos, 2, enrage ? 22 : 16, 130);
    }

    b.fireTimer -= dt;
    if (b.fireTimer <= 0) {
      const target = { x: this.player.x, y: this.player.y };
      switch (b.attackMode) {
        case 0:
          b.fireTimer = 0.9 * speedUp;
          bossRadial(this.bullets, b.pos, 1, enrage ? 22 : 16, 140);
          break;
        case 1:
          b.fireTimer = 1.4 * speedUp;
          bossAimedFan(this.bullets, b.pos, target, 3, 175);
          break;
        case 2:
          b.fireTimer = 0.09;
          bossSpiral(this.bullets, b.pos, b.t, enrage ? 150 : 115);
          break;
        case 3:
          b.fireTimer = 0.7 * speedUp;
          bossCrossFan(this.bullets, b.pos, target, 165);
          break;
        case 4:
          b.fireTimer = 0.5 * speedUp;
          bossRain(this.bullets, W, enrage ? 10 : 6, 150);
          break;
      }
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
      boss: { hp: 1, r: 34 },
    };
    let { hp, r } = base[kind];
    const cfg = this.deps.getGameConfig();
    const elite = this.wave >= 4 && Math.random() < 0.15;
    if (elite) {
      hp = Math.round(hp * 2.5);
      r = Math.round(r * 1.3);
    }
    hp = Math.max(1, Math.round(hp * cfg.enemyHpMul));

    const fireCd: Record<EnemyKind, number> = { drifter: 0.5, turret: 2.4, aimer: 2.0, boss: 1 };
    this.enemies.push({
      pos: { x: 50 + Math.random() * (W - 100), y: -30 },
      vel: { x: 0, y: (45 + Math.random() * 30 + this.wave * 3) * cfg.enemySpeedMul },
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
      if (e.kind === 'boss') {
        this.updateBoss(e, dt);
      } else if (e.fireTimer <= 0 && e.pos.y > 0) {
        const fireCd: Record<EnemyKind, number> = { drifter: 0.5, turret: 2.4, aimer: 2.0, boss: 1 };
        e.fireTimer = fireCd[e.kind] * (0.85 + Math.random() * 0.3);
        enemyFire(this.bullets, e, { x: this.player.x, y: this.player.y }, W);
      }
      if (e.pos.y > H + 50) {
        e.dead = true;
        // 漏怪惩罚：不扣血，设备给一下反馈（可在游戏设置关闭）
        if (e.kind !== 'boss') {
          this.leaks += 1;
          if (this.deps.getGameConfig().leakShock) {
            this.deps.feedback.fire('hit');
          }
          makeExplosion(this.particles, e.pos.x, H - 10, '#ff4c5e', 10);
        }
      }
    }

    // Boss 被消灭：每只清弹幕 + 大奖赏 + 原地掉一颗核心果实
    const deadBosses = this.enemies.filter((e) => e.kind === 'boss' && e.dead);
    if (deadBosses.length > 0) {
      for (const b of deadBosses) {
        this.score += 1000;
        this.bombs = Math.min(MAX_BOMBS, this.bombs + 2);
        this.pickups.push({ pos: { x: b.pos.x, y: Math.min(b.pos.y, H - 90) }, progress: 0, shockCd: 0, t: 0, done: false });
        makeExplosion(this.particles, b.pos.x, b.pos.y, '#f0c866', 40);
      }
      for (const bl of this.bullets) {
        if (!bl.friendly) {
          bl.dead = true;
          makeExplosion(this.particles, bl.pos.x, bl.pos.y, '#4cc2ff', 3);
        }
      }
      this.deps.feedback.fire('bomb');
    }

    // 自机弹命中敌机
    for (const b of this.bullets) {
      if (!b.friendly || b.dead) continue;
      for (const e of this.enemies) {
        if (e.dead) continue;
        if (circleHit(b.pos.x, b.pos.y, b.r, e.pos.x, e.pos.y, e.r)) {
          b.dead = true;
          e.hp -= b.dmg;
          if (e.hp <= 0) {
            e.dead = true;
            this.score += e.kind === 'boss' ? 0 : e.maxHp >= 10 ? 300 : e.kind === 'turret' ? 250 : e.kind === 'aimer' ? 150 : 100;
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
    // 一次性护盾：抵挡本次受击并破碎
    if (this.shieldCharges > 0) {
      this.shieldCharges -= 1;
      p.iframes = IFRAMES;
      this.shake = 5;
      makeExplosion(this.particles, p.x, p.y, '#4cc2ff', 22);
      playSfx('hit');
      return;
    }
    p.hp -= HIT_DAMAGE;
    p.iframes = IFRAMES;
    this.shake = 8;
    makeExplosion(this.particles, p.x, p.y, '#ff4c5e', 18);
    this.deps.feedback.fire('hit');
    playSfx('hit');

    if (p.hp <= 0) {
      p.hp = 0;
      this.setState('over');
      playSfx('defeat');
      if (this.lowHp) {
        this.lowHp = false;
        this.deps.feedback.fire('lowHpOff');
      }
      this.deps.feedback.fire('death');
      this.saveBest();
      return;
    }
    this.checkLowHp();
  }

  private saveBest(): void {
    const best = Number(localStorage.getItem('dg-best-score') ?? 0);
    if (this.score > best) {
      localStorage.setItem('dg-best-score', String(this.score));
      this.deps.submitScore?.(this.score);
    }
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
    playSfx('shot');
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

  // ===== 核心果实拾取与强化体系 =====

  private hasUpgrade(key: UpgradeKey): boolean {
    return this.upgradeLevel > UPGRADE_DEFS.findIndex((d) => d.key === key);
  }

  /** 完整循环次数：每拿满 6 个果实一代，逐代增强射速与伤害 */
  private upgradeGeneration(): number {
    return Math.floor(this.upgradeLevel / UPGRADE_DEFS.length);
  }

  private volleyAngles(): number[] {
    if (this.hasUpgrade('penta')) return [-70, -35, 0, 35, 70];
    if (this.hasUpgrade('triple')) return [-40, 0, 40];
    return [0];
  }

  private fireInterval(): number {
    return Math.max(0.05, 0.11 * (this.hasUpgrade('rapid') ? 0.7 : 1) * Math.pow(0.92, this.upgradeGeneration()));
  }

  private bulletDmg(): number {
    return Math.round((this.hasUpgrade('heavy') ? 2 : 1) * (1 + 0.25 * this.upgradeGeneration()));
  }

  private moveSpeed(): number {
    return 270 * (this.hasUpgrade('surge') ? 1.2 : 1);
  }

  private nextUpgradeName(): string {
    return UPGRADE_DEFS[this.upgradeLevel % UPGRADE_DEFS.length].name;
  }

  private inPickupRange(): boolean {
    for (const pk of this.pickups) {
      const dx = pk.pos.x - this.player.x;
      const dy = pk.pos.y - this.player.y;
      if (dx * dx + dy * dy <= PICKUP_RADIUS * PICKUP_RADIUS) return true;
    }
    return false;
  }

  /**
   * 吟唱式拾取：站进拾取半径才开始累积进度，
   * 期间每 PICKUP_SHOCK_INTERVAL 秒给一次持续电击（拾取的代价），
   * 离开范围进度衰减；进度满才完成升级并消失。
   */
  private updatePickups(dt: number): void {
    for (const pk of this.pickups) {
      pk.t += dt;
      if (this.inPickupRangeOf(pk)) {
        pk.progress += dt / PICKUP_TIME;
        pk.shockCd -= dt;
        if (pk.shockCd <= 0) {
          pk.shockCd = PICKUP_SHOCK_INTERVAL;
          this.deps.feedback.shock(15 + Math.min(20, (this.upgradeLevel + 1) * 3));
        }
      } else {
        pk.progress = Math.max(0, pk.progress - dt / 4);
        pk.shockCd = 0;
      }
      if (pk.progress >= 1) {
        pk.done = true;
        this.applyUpgrade();
        makeExplosion(this.particles, pk.pos.x, pk.pos.y, '#4cff9d', 24);
      }
    }
    this.pickups = this.pickups.filter((pk) => !pk.done);
  }

  private inPickupRangeOf(pk: Pickup): boolean {
    const dx = pk.pos.x - this.player.x;
    const dy = pk.pos.y - this.player.y;
    return dx * dx + dy * dy <= PICKUP_RADIUS * PICKUP_RADIUS;
  }

  private applyUpgrade(): void {
    const def = UPGRADE_DEFS[this.upgradeLevel % UPGRADE_DEFS.length];
    this.upgradeLevel += 1;
    if (def.key === 'shield') this.shieldCharges = Math.min(1, this.shieldCharges + 1);
    if (def.key === 'surge') this.player.hp = Math.min(PLAYER_MAX_HP, this.player.hp + 30);
    this.score += 200;
    playSfx('victory');
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

    for (const pk of this.pickups) {
      this.renderPickup(pk);
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
    if (e.kind === 'boss') {
      this.renderBoss(e);
      return;
    }
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

  /** Boss 专用渲染：重型机体 + 旋转核心 + 顶部大血条（多只时逐条错开） */
  private renderBoss(b: Enemy): void {
    const ctx = this.ctx;
    ctx.save();
    ctx.translate(b.pos.x, b.pos.y);
    // 外装甲
    ctx.strokeStyle = b.hp < b.maxHp * 0.35 ? '#ff4c5e' : '#f0c866';
    ctx.lineWidth = 3;
    ctx.beginPath();
    for (let i = 0; i < 6; i++) {
      const a = (Math.PI / 3) * i + b.t * 0.3;
      const x = Math.cos(a) * b.r;
      const y = Math.sin(a) * b.r;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.stroke();
    // 旋转核心
    ctx.strokeStyle = '#ff8a4c';
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (let i = 0; i < 3; i++) {
      const a = -b.t * 1.2 + (Math.PI * 2 * i) / 3;
      const x = Math.cos(a) * b.r * 0.45;
      const y = Math.sin(a) * b.r * 0.45;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.stroke();
    ctx.restore();

    // 顶部大血条（多只 Boss 逐条向下错开）
    const bosses = this.enemies.filter((e) => e.kind === 'boss');
    const idx = Math.max(0, bosses.indexOf(b));
    const by = 34 + idx * 18;
    const bw = W * 0.6;
    const bx = (W - bw) / 2;
    ctx.fillStyle = '#262d3d';
    ctx.fillRect(bx, by, bw, 10);
    const ratio = Math.max(0, b.hp / b.maxHp);
    ctx.fillStyle = ratio <= 0.35 ? '#ff4c5e' : ratio <= 0.7 ? '#f0c866' : '#4cff9d';
    ctx.fillRect(bx, by, bw * ratio, 10);
    ctx.strokeStyle = '#0e1118';
    ctx.strokeRect(bx, by, bw, 10);
    ctx.fillStyle = '#d7dce6';
    ctx.font = 'bold 11px Consolas, monospace';
    ctx.textAlign = 'center';
    ctx.fillText(bosses.length > 1 ? `TWIN BOSS ${idx + 1}` : 'BOSS', W / 2, by - 4);
    ctx.textAlign = 'left';
  }

  /** 核心果实：发光六边形 + 旋转内核 + 吟唱进度环 + 下一强化名 */
  private renderPickup(pk: Pickup): void {
    const ctx = this.ctx;
    const bob = Math.sin(pk.t * 2.4) * 4;
    const x = pk.pos.x;
    const y = pk.pos.y + bob;

    // 靠近时显示拾取范围
    const p = this.player;
    const dx = pk.pos.x - p.x;
    const dy = pk.pos.y - p.y;
    if (dx * dx + dy * dy <= PICKUP_RADIUS * PICKUP_RADIUS * 4) {
      ctx.save();
      ctx.globalAlpha = 0.16;
      ctx.strokeStyle = '#f0c866';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(pk.pos.x, pk.pos.y, PICKUP_RADIUS, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }

    // 果实本体
    ctx.save();
    ctx.translate(x, y);
    ctx.strokeStyle = '#f0c866';
    ctx.lineWidth = 2;
    ctx.shadowColor = '#f0c866';
    ctx.shadowBlur = 14;
    ctx.beginPath();
    for (let i = 0; i < 6; i++) {
      const a = pk.t * 0.8 + (Math.PI / 3) * i;
      const px = Math.cos(a) * 13;
      const py = Math.sin(a) * 13;
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.closePath();
    ctx.stroke();
    ctx.shadowBlur = 0;
    ctx.fillStyle = '#ffd97e';
    ctx.beginPath();
    ctx.arc(0, 0, 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    // 吟唱进度环
    if (pk.progress > 0) {
      ctx.save();
      ctx.strokeStyle = '#4cff9d';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(x, y, 20, -Math.PI / 2, -Math.PI / 2 + pk.progress * Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }

    // 下一强化提示
    ctx.save();
    ctx.fillStyle = '#8a93a6';
    ctx.font = '10px "Segoe UI", "Microsoft YaHei", sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(`▲ ${this.nextUpgradeName()}`, x, y - 30);
    ctx.restore();
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

    // 能量护盾环
    if (this.shieldCharges > 0) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, 14, 0, Math.PI * 2);
      ctx.strokeStyle = '#4cc2ff';
      ctx.lineWidth = 1.5;
      ctx.globalAlpha = 0.7 + Math.sin(this.time * 5) * 0.3;
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
  }

  private renderHud(): void {
    if (this.state === 'title') return; // 标题界面保持干净，不显示游戏 HUD
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

    // 漏怪数
    if (this.leaks > 0) {
      ctx.fillStyle = '#ff4c5e';
      ctx.font = '12px Consolas, monospace';
      ctx.fillText(`LEAK ${this.leaks}`, 12, 58);
      ctx.font = 'bold 14px Consolas, monospace';
    }

    // 炸弹数
    ctx.fillStyle = '#4cc2ff';
    for (let i = 0; i < this.bombs; i++) {
      ctx.beginPath();
      ctx.arc(18 + i * 18, 38, 6, 0, Math.PI * 2);
      ctx.fill();
    }

    // 强化等级与下一级（拾取 Boss 掉落的核心果实升级）
    if (this.upgradeLevel > 0) {
      ctx.fillStyle = '#f0c866';
      ctx.font = 'bold 12px "Segoe UI", "Microsoft YaHei", sans-serif';
      ctx.fillText(`强化 Lv.${this.upgradeLevel}${this.shieldCharges > 0 ? ' · 护盾就绪' : ''}`, 12, 84);
      ctx.fillStyle = '#8a93a6';
      ctx.font = '11px "Segoe UI", "Microsoft YaHei", sans-serif';
      ctx.fillText(`下一强化：${this.nextUpgradeName()}`, 12, 100);
    }
    ctx.restore();
  }

  private renderOverlay(): void {
    const ctx = this.ctx;
    ctx.save();
    ctx.textAlign = 'center';

    if (this.state === 'title') {
      ctx.fillStyle = 'rgba(5,7,12,0.55)';
      ctx.fillRect(0, 0, W, H);
      ctx.fillStyle = '#4cc2ff';
      ctx.font = 'bold 42px "Segoe UI", "Microsoft YaHei", sans-serif';
      ctx.fillText('DGC', W / 2, H / 2 - 120);
      ctx.fillStyle = '#8a93a6';
      ctx.font = '13px "Segoe UI", "Microsoft YaHei", sans-serif';
      ctx.fillText('郊狼 · 负鼠 · 灵猫 体感联动', W / 2, H / 2 - 88);
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
