/**
 * 五种颜色对应的技能图标（24×24 坐标系）：
 * 红=电击(闪电) 蓝=护盾(盾牌) 绿=净化(爱心) 黄=时停(时钟) 紫=倍率(乘号)
 * drawIcon 供棋盘 Canvas 使用；SVG 内联版本见 index.html（路径保持一致）。
 */
export type SpellIcon = 'bolt' | 'shield' | 'heart' | 'clock' | 'cross' | 'up';

export const ICON_BY_COLOR: SpellIcon[] = ['bolt', 'shield', 'heart', 'clock', 'cross', 'up'];

const FILLED_PATHS: Record<string, string> = {
  bolt: 'M11 21h-1l1-7H6.5c-.58 0-.57-.32-.38-.66l.07-.12C8.48 10.94 10.42 7.54 13 3h1l-1 7h4.5c.49 0 .56.33.47.51l-.07.15C14.96 17.55 13 21 13 21z',
  shield: 'M12 2L4 5v6.09c0 5.05 3.41 9.76 8 10.91 4.59-1.15 8-5.86 8-10.91V5l-8-3z',
  heart:
    'M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z',
};

/** 在画布上以 (cx,cy) 为中心、size 为边长绘制白色图标 */
export function drawIcon(
  ctx: CanvasRenderingContext2D,
  name: SpellIcon,
  cx: number,
  cy: number,
  size: number,
  color = '#ffffff',
): void {
  const k = size / 24;
  ctx.save();
  ctx.translate(cx, cy);
  ctx.scale(k, k);
  ctx.translate(-12, -12);

  if (name === 'clock') {
    ctx.strokeStyle = color;
    ctx.lineWidth = 2.4;
    ctx.beginPath();
    ctx.arc(12, 12, 8.5, 0, Math.PI * 2);
    ctx.stroke();
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(12, 7.5);
    ctx.lineTo(12, 12);
    ctx.lineTo(15.5, 14);
    ctx.stroke();
  } else if (name === 'up') {
    // 增幅：向上箭头 + 双横线
    ctx.strokeStyle = color;
    ctx.lineWidth = 2.6;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(12, 17);
    ctx.lineTo(12, 8);
    ctx.moveTo(7.5, 12);
    ctx.lineTo(12, 7);
    ctx.lineTo(16.5, 12);
    ctx.moveTo(6.5, 19.5);
    ctx.lineTo(17.5, 19.5);
    ctx.stroke();
  } else if (name === 'cross') {
    ctx.strokeStyle = color;
    ctx.lineWidth = 3;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(6.5, 6.5);
    ctx.lineTo(17.5, 17.5);
    ctx.moveTo(17.5, 6.5);
    ctx.lineTo(6.5, 17.5);
    ctx.stroke();
  } else {
    ctx.fillStyle = color;
    ctx.fill(new Path2D(FILLED_PATHS[name]));
  }

  ctx.restore();
}
