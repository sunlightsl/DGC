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
    case 'boss':
      break; // Boss 攻击在 game.ts 的模式状态机里驱动
  }
  void width;
}

/* ===== Boss 攻击模式（参考雷霆战机） ===== */

/** 模式0：环形弹幕 ×3 波，Offset 旋转制造花瓣感 */
export function bossRadial(bullets: Bullet[], from: Vec2, burst: number, count: number, speed: number): void {
  for (let b = 0; b < burst; b++) {
    ring(bullets, from, count, speed, (b * Math.PI) / count);
  }
}

/** 模式1：三向扇形追踪 ×3 连发 */
export function bossAimedFan(bullets: Bullet[], from: Vec2, target: Vec2, waves: number, speed: number): void {
  for (let w = 0; w < waves; w++) {
    fan(bullets, from, target, 3 + w * 2, speed + w * 20, Math.PI / 4);
  }
}

/** 模式2：双旋臂螺旋（持续型，每 tick 调用） */
export function bossSpiral(bullets: Bullet[], from: Vec2, t: number, speed: number): void {
  spiral(bullets, from, t * 1.6, speed, 4);
}

/** 模式3：交叉激光弹幕 —— 两组对向扇形 */
export function bossCrossFan(bullets: Bullet[], from: Vec2, target: Vec2, speed: number): void {
  const base = Math.atan2(target.y - from.y, target.x - from.x);
  for (let i = -2; i <= 2; i++) {
    const a1 = base + (i * Math.PI) / 14;
    const a2 = base + Math.PI - (i * Math.PI) / 14;
    bullets.push(makeBullet(from.x, from.y, Math.cos(a1) * speed, Math.sin(a1) * speed, false));
    bullets.push(makeBullet(from.x, from.y, Math.cos(a2) * speed, Math.sin(a2) * speed, false));
  }
}

/** 模式4：全屏弹雨 */
export function bossRain(bullets: Bullet[], width: number, count: number, speed: number): void {
  rain(bullets, width, count, speed);
}
