/**
 * 全项目统一 SVG 图标库（设计规范：禁用 emoji，一律使用线性 SVG 图标）
 * 用法：innerHTML 插入或模板字符串拼接；size 默认 1em 随字体缩放
 */

const wrap = (path: string, size = '1em'): string =>
  `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`;

export const icoBolt = (s?: string): string =>
  wrap('<path d="M13 2 4.5 13.5H11L10 22l8.5-11.5H12L13 2z" fill="currentColor" stroke="none"/>', s);

export const icoGem = (s?: string): string =>
  wrap('<path d="M6 3h12l3 5-9 13L3 8l3-5z"/><path d="M3 8h18M9.5 8 12 21 14.5 8M6 3l3.5 5M18 3l-3.5 5"/>', s);

export const icoShield = (s?: string): string =>
  wrap('<path d="M12 2 4 5v6.1c0 5 3.4 9.7 8 10.9 4.6-1.2 8-5.9 8-10.9V5l-8-3z"/>', s);

export const icoUp = (s?: string): string =>
  wrap('<path d="M12 19V5M5 12l7-7 7 7"/>', s);

export const icoClock = (s?: string): string =>
  wrap('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.5 2"/>', s);

export const icoWarn = (s?: string): string =>
  wrap('<path d="M12 3 2 21h20L12 3z"/><path d="M12 10v5M12 18.5v.5"/>', s);

export const icoStop = (s?: string): string =>
  wrap('<rect x="5" y="5" width="14" height="14" rx="2" fill="currentColor" stroke="none"/>', s);

export const icoHourglass = (s?: string): string =>
  wrap('<path d="M6 2h12M6 22h12M7 2v4l5 6 5-6V2M7 22v-4l5-6 5 6v4"/>', s);

export const icoTrophy = (s?: string): string =>
  wrap('<path d="M8 21h8M12 17v4M7 4h10v5a5 5 0 0 1-10 0V4z"/><path d="M7 6H4a2 2 0 0 0 2 4h1M17 6h3a2 2 0 0 1-2 4h-1"/>', s);

export const icoPlay = (s?: string): string =>
  wrap('<path d="M7 4.5v15l12-7.5-12-7.5z" fill="currentColor" stroke="none"/>', s);

export const icoPause = (s?: string): string =>
  wrap('<rect x="6" y="4" width="4" height="16" rx="1" fill="currentColor" stroke="none"/><rect x="14" y="4" width="4" height="16" rx="1" fill="currentColor" stroke="none"/>', s);

export const icoCross = (s?: string): string =>
  wrap('<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>', s);

export const icoHeart = (s?: string): string =>
  wrap('<path d="M12 20.5 4.7 13a4.9 4.9 0 0 1 0-7 4.7 4.7 0 0 1 6.8 0l.5.6.5-.6a4.7 4.7 0 0 1 6.8 0 4.9 4.9 0 0 1 0 7L12 20.5z"/>', s);

export const icoWave = (s?: string): string =>
  wrap('<path d="M2 12c2.5 0 2.5-6 5-6s2.5 6 5 6 2.5-6 5-6 2.5 6 5 6"/>', s);

export const icoBomb = (s?: string): string =>
  wrap('<circle cx="11" cy="15" r="7"/><path d="M15 9l2-2M17 7a2 2 0 0 1 2-2M17 7a2 2 0 0 0 2 2"/>', s);

export const icoSword = (s?: string): string =>
  wrap('<path d="M4 20 16 8M14 4l6 6-2 2-6-6 2-2zM6 14l4 4"/>', s);
