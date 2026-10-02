import { cleanseBadge, enhanceBadge, fetchHall, fetchMyBadges, mintBadge, transferBadge, type Badge } from '../badge-api';

/**
 * 战利品面板：胜者结算时对败者操作徽章（杂鱼经济的入口）。
 * 三种方式：设立新徽章（胜者命名）/ 转移自己持有的 / 加强其已有徽章。
 * 每日 3 次配额，四种操作共享。锁定中的徽章不可转移，需净化。
 */

let loserUser = '';
let loserNick = '';
let bound = false;

function el<T extends HTMLElement = HTMLElement>(id: string, _ctor?: new () => T): T {
  return document.getElementById(id) as T;
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function medalSvg(level: number, locked: boolean): string {
  const pips = Array.from({ length: Math.max(0, level) }, () => '<i></i>').join('');
  return `
    <span class="badge-medal ${locked ? 'locked' : ''}">
      <svg viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" aria-hidden="true">
        <path d="M14 3h7l3 9-6 5-6-5 2-9zM34 3h-7l-3 9 6 5 6-5-2-9z" fill="rgba(240,200,102,0.12)"/>
        <circle cx="24" cy="29" r="13"/>
        <circle cx="24" cy="29" r="8" stroke-dasharray="3 3"/>
      </svg>
      ${locked ? '<svg class="badge-lock" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><rect x="5" y="10" width="14" height="10" rx="2"/><path d="M8 10V7a4 4 0 018 0v3"/></svg>' : ''}
      ${level > 0 ? `<span class="badge-pips">${pips}</span>` : ''}
    </span>`;
}

export function badgeChip(b: Badge, nicks: Record<string, string>, disabled: boolean): string {
  return `
    <button class="badge-chip ${disabled ? 'disabled' : ''}" data-id="${b.id}" ${disabled ? 'disabled' : ''} title="${b.locked ? '锁定中' : ''}">
      ${medalSvg(b.level, b.locked)}
      <span class="badge-chip-name">${esc(b.name)}</span>
      <span class="badge-chip-sub">Lv${b.level}${b.locked ? ' · 锁定' : ''} · 原主 ${esc(nicks[b.creator] ?? b.creator)}</span>
    </button>`;
}

function bindStatic(): void {
  if (bound) return;
  bound = true;
  el('trophy-mint').addEventListener('click', () => void renderMint());
  el('trophy-transfer').addEventListener('click', () => void renderPick('transfer'));
  el('trophy-enhance').addEventListener('click', () => void renderPick('enhance'));
  el('trophy-body').addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest('button');
    if (!btn) return;
    if (btn.id === 'trophy-confirm-mint') void doMint();
    if (btn.dataset.badgeId) void doOp(btn.dataset.op as 'transfer' | 'enhance', Number(btn.dataset.badgeId));
  });
}

/** 胜者结算时打开：loserUser 为对方用户名（徽章锚定 ID），loserNick 仅用于展示 */
export async function showTrophy(user: string, nick: string): Promise<void> {
  loserUser = user;
  loserNick = nick || user;
  bindStatic();
  el('victory-trophy').hidden = false;
  el('trophy-body').hidden = true;
  el('trophy-msg').textContent = '';
  await refreshQuota();
}

export function hideTrophy(): void {
  el('victory-trophy').hidden = true;
}

async function refreshQuota(): Promise<void> {
  try {
    const mine = await fetchMyBadges();
    el('trophy-quota').textContent = `今日配额剩 ${mine.quota} 次`;
  } catch {
    el('trophy-quota').textContent = '配额查询失败';
  }
}

function openBody(html: string): void {
  const body = el('trophy-body');
  body.innerHTML = html;
  body.hidden = false;
}

function renderMint(): void {
  openBody(`
    <label class="auth-label" for="trophy-name">徽章名称（由你命名，1-12 字）</label>
    <div class="row" style="margin:0; gap:8px">
      <input type="text" id="trophy-name" maxlength="12" placeholder="例如：三秒落败的杂鱼" style="flex:1" />
      <button class="btn-gold" id="trophy-confirm-mint">铸造并颁发</button>
    </div>`);
  el('trophy-name').focus();
}

async function renderPick(op: 'transfer' | 'enhance'): Promise<void> {
  if (!loserUser) return;
  try {
    const [hall, mine] = await Promise.all([fetchHall(), fetchMyBadges()]);
    el('trophy-quota').textContent = `今日配额剩 ${mine.quota} 次`;
    if (op === 'transfer') {
      // 以 mine 为准：自己持有的全部徽章（锁定的不可转）
      const list = mine.badges;
      openBody(
        list.length
          ? `<div class="badge-pick-grid">${list.map((b) => badgeChip(b, hall.nicks, b.locked)).join('')}</div>`
          : '<div class="hint">你还没有持有任何徽章 —— 去输几局攒点家底，或者「设立新徽章」</div>',
      );
      el('trophy-body').querySelectorAll<HTMLButtonElement>('.badge-chip:not(.disabled)').forEach((chip) => {
        chip.dataset.op = 'transfer';
      });
    } else {
      const list = hall.badges.filter((b) => b.owner === loserUser && !b.locked);
      openBody(
        list.length
          ? `<div class="badge-pick-grid">${list.map((b) => badgeChip(b, hall.nicks, false)).join('')}</div>`
          : `<div class="hint">${esc(loserNick)} 没有可加强的徽章（锁定中的需先净化）</div>`,
      );
      el('trophy-body').querySelectorAll<HTMLButtonElement>('.badge-chip').forEach((chip) => {
        chip.dataset.op = 'enhance';
      });
    }
  } catch (err) {
    el('trophy-msg').textContent = err instanceof Error ? err.message : String(err);
  }
}

async function doMint(): Promise<void> {
  const name = (el('trophy-name', HTMLInputElement).value ?? '').trim();
  if (!name) {
    el('trophy-msg').textContent = '先给徽章起个名字';
    return;
  }
  try {
    const r = await mintBadge(loserUser, name);
    el('trophy-msg').textContent = `已颁发「${r.badge.name}」给 ${loserNick}`;
    el('trophy-body').hidden = true;
  } catch (err) {
    el('trophy-msg').textContent = err instanceof Error ? err.message : String(err);
  } finally {
    await refreshQuota();
  }
}

async function doOp(op: 'transfer' | 'enhance', badgeId: number): Promise<void> {
  try {
    if (op === 'transfer') {
      const r = await transferBadge(badgeId, loserUser);
      el('trophy-msg').textContent = `已把「${r.badge.name}」转赠给 ${loserNick}`;
    } else {
      const r = await enhanceBadge(badgeId);
      el('trophy-msg').textContent = `已加强「${r.badge.name}」至 Lv${r.badge.level} 并锁定`;
    }
    el('trophy-body').hidden = true;
  } catch (err) {
    el('trophy-msg').textContent = err instanceof Error ? err.message : String(err);
  } finally {
    await refreshQuota();
  }
}

/** 净化入口（当前 UI 放在展示墙/徽章详情中由持有者视角触发） */
export async function doCleanse(badgeId: number): Promise<string> {
  const r = await cleanseBadge(badgeId);
  return `已净化「${r.badge.name}」，恢复可转移`;
}
