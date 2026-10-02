import { showModal, hideModal } from './modal';
import { BULLET_HTML, VERSUS_HTML, ROULETTE_HTML } from './help-panel';

/**
 * 游戏内说明卡：每个游戏首次进入时弹规则说明，点「我已了解」后才可进入。
 * 记住已读状态；详细文档仍在顶栏「游戏说明」里随时可查。
 */

export type IntroGame = 'bullet' | 'versus' | 'roulette';

const TITLES: Record<IntroGame, string> = {
  bullet: '小电机弹幕 · 玩法说明',
  versus: '电击消消乐 · 玩法说明',
  roulette: '恶魔轮盘 · 玩法说明',
};

const BODIES: Record<IntroGame, string> = {
  bullet: BULLET_HTML,
  versus: VERSUS_HTML,
  roulette: ROULETTE_HTML,
};

const readKey = (game: IntroGame) => `dg-read-${game}`;

function el<T extends HTMLElement = HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

let bound = false;

/** 未读过 → 弹说明卡，点「我已了解」后回调；已读过 → 直接回调 */
export function ensureIntro(game: IntroGame, onDone: () => void): void {
  if (localStorage.getItem(readKey(game))) {
    onDone();
    return;
  }
  if (!bound) {
    bound = true;
    el('intro-ok').addEventListener('click', () => {
      const g = el('modal-intro').dataset.game as IntroGame;
      localStorage.setItem(readKey(g), '1');
      hideModal(el('modal-intro'));
      const cb = pending;
      pending = null;
      cb?.();
    });
  }
  pending = onDone;
  el('modal-intro').dataset.game = game;
  el('intro-title').textContent = TITLES[game];
  el('intro-body').innerHTML = BODIES[game];
  showModal(el('modal-intro'));
}

let pending: (() => void) | null = null;

/** 从说明卡进入前的强制入口（供「进入游戏」按钮统一走这里） */
export function resetIntroRead(game: IntroGame): void {
  localStorage.removeItem(readKey(game));
}
