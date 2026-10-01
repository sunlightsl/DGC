export interface Vec2 {
  x: number;
  y: number;
}

export interface Bullet {
  pos: Vec2;
  vel: Vec2;
  r: number;
  /** 自机弹或敌弹 */
  friendly: boolean;
  dead: boolean;
}

export type EnemyKind = 'drifter' | 'turret' | 'aimer';

export interface Enemy {
  pos: Vec2;
  vel: Vec2;
  hp: number;
  maxHp: number;
  r: number;
  kind: EnemyKind;
  /** 存活时间，用于弹幕计时和漂浮轨迹 */
  t: number;
  fireTimer: number;
  seed: number;
  dead: boolean;
}

export interface Particle {
  pos: Vec2;
  vel: Vec2;
  life: number;
  maxLife: number;
  color: string;
  size: number;
}

export function makeBullet(x: number, y: number, vx: number, vy: number, friendly: boolean, r = 4): Bullet {
  return { pos: { x, y }, vel: { x: vx, y: vy }, r, friendly, dead: false };
}

export function makeExplosion(particles: Particle[], x: number, y: number, color: string, count = 14): void {
  for (let i = 0; i < count; i++) {
    const angle = Math.random() * Math.PI * 2;
    const speed = 40 + Math.random() * 160;
    particles.push({
      pos: { x, y },
      vel: { x: Math.cos(angle) * speed, y: Math.sin(angle) * speed },
      life: 0,
      maxLife: 0.4 + Math.random() * 0.4,
      color,
      size: 1.5 + Math.random() * 2.5,
    });
  }
}
