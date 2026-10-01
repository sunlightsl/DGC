import type { Bullet, Enemy, Vec2 } from './entities';
import { makeBullet } from './entities';

const TAU = Math.PI * 2;

/** 环形弹幕：从敌人位置向四周均匀发射 */
export function ring(bullets: Bullet[], from: Vec2, count: number, speed: number, offset = 0): void {
  for (let i = 0; i < count; i++) {
    const angle = offset + (TAU * i) / count;
    bullets.push(makeBullet(from.x, from.y, Math.cos(angle) * speed, Math.sin(angle) * speed, false));
  }
}

/** 扇形弹幕：朝目标方向展开一个扇区 */
export function fan(bullets: Bullet[], from: Vec2, target: Vec2, count: number, speed: number, spread: number): void {
  const base = Math.atan2(target.y - from.y, target.x - from.x);
  for (let i = 0; i < count; i++) {
    const t = count === 1 ? 0.5 : i / (count - 1);
    const angle = base - spread / 2 + spread * t;
    bullets.push(makeBullet(from.x, from.y, Math.cos(angle) * speed, Math.sin(angle) * speed, false));
  }
}

/** 追踪弹：直接朝目标当前位置直射（不追踪，纯瞄准） */
export function aimed(bullets: Bullet[], from: Vec2, target: Vec2, speed: number): void {
  const angle = Math.atan2(target.y - from.y, target.x - from.x);
  bullets.push(makeBullet(from.x, from.y, Math.cos(angle) * speed, Math.sin(angle) * speed, false));
}

/** 螺旋弹：配合敌人 t 时间生成旋转弹幕 */
export function spiral(bullets: Bullet[], from: Vec2, t: number, speed: number, arms = 2): void {
  for (let a = 0; a < arms; a++) {
    const angle = t * 2.2 + (TAU * a) / arms;
    bullets.push(makeBullet(from.x, from.y, Math.cos(angle) * speed, Math.sin(angle) * speed, false));
  }
}

/** 随机落弹：从屏幕上方随机位置落下 */
export function rain(bullets: Bullet[], width: number, count: number, speed: number): void {
  for (let i = 0; i < count; i++) {
    const x = Math.random() * width;
    const vx = (Math.random() - 0.5) * 40;
    bullets.push(makeBullet(x, -10, vx, speed, false, 5));
  }
}

export type PatternName = 'ring' | 'fan' | 'aimed' | 'spiral' | 'rain';

/** 按敌人类型决定开火模式 */
export function enemyFire(bullets: Bullet[], enemy: Enemy, target: Vec2, width: number): void {
  switch (enemy.kind) {
    case 'turret':
      ring(bullets, enemy.pos, 14, 110, enemy.seed);
      break;
    case 'aimer':
      fan(bullets, enemy.pos, target, 5, 150, Math.PI / 5);
      break;
    case 'drifter':
      spiral(bullets, enemy.pos, enemy.t, 120, 3);
      break;
  }
  void width;
}
