import type { RoomClient } from '../net/room-client';
import { getToken, getCurrentUser, changeNickname, logout, nicknameCooldownMs } from '../account';
import { fetchBadgeHistory, fetchHall, type Badge } from '../badge-api';
import { badgeChip } from './trophy';
import { refreshAccountEntry } from './auth-panel';

/**
 * 分区页面：单机 / 多人 / 杂鱼区。
 * 顶栏入口切换，多人卡片实时显示 游玩/匹配 人数（presence 推送）。
 */

export type PageKey = 'arcade' | 'versus' | 'hall' | 'social';
export type VersusGame = 'versus' | 'roulette';

export interface PageHooks {
  /** 进入小电机弹幕（说明卡通过与否由 main 决定后再调这里） */
  enterArcade: () => void;
  /** 打开对战大厅（指定游戏） */
  enterVersus: (game: VersusGame) => void;
  /** 打开排行榜弹窗（可指定页签，杂鱼区入口直接用公示区页） */
  openBoard: (tab?: 'bullet' | 'versus' | 'roulette' | 'records') => void;
  /** 切换到杂鱼区页时触发（刷新徽章展示墙） */
  showHall?: () => void;
  /** 社交页：邀战某人（指定游戏） */
  invite: (user: string, game: VersusGame) => void;
  /** 社交页右上角匹配：'any' 不限游戏（默认），或指定游戏 */
  quickMatch: (game: VersusGame | 'any') => void;
  /** 游戏卡片右上角齿轮：打开该游戏的个人设置 */
  openGameSettings: (game: 'bullet' | VersusGame) => void;
}

interface PresenceInfo {
  online: number;
  games: Record<string, { playing: number; matching: number }>;
}

const VERSUS_CARDS: { key: VersusGame; name: string; desc: string; icon: string }[] = [
  {
    key: 'versus',
    name: '电击消消乐',
    desc: '6 色宝石消除自动触发效果，电击 / 护盾 / 时停互坑，先达目标分者胜；败者进入惩罚阶段，胜者实时掌控输出。',
    icon: `<svg viewBox="0 0 24 24" width="34" height="34" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M7 3h10l4 6-9 12L3 9l4-6z"/><path d="M3 9h18M12 21L8.5 9l2-6M12 21L15.5 9l-2-6"/></svg>`,
  },
  {
    key: 'roulette',
    name: '俄罗斯轮盘',
    desc: '6 弹巢俄罗斯轮盘：实弹数量公开、顺序保密。对对方开枪必交回合，对自己开枪空弹赚回合；HP 先归零者受罚。',
    icon: `<svg viewBox="0 0 24 24" width="34" height="34" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="2.2"/><circle cx="12" cy="6.2" r="1.6"/><circle cx="17.8" cy="12" r="1.6"/><circle cx="12" cy="17.8" r="1.6"/><circle cx="6.2" cy="12" r="1.6"/></svg>`,
  },
];

let hooks: PageHooks;
let current: PageKey = 'arcade';
let lastPresence: PresenceInfo | null = null;

function el<T extends HTMLElement = HTMLElement>(id: string, _ctor?: new () => T): T {
  return document.getElementById(id) as T;
}

export function initPages(h: PageHooks): void {
  hooks = h;
  document.addEventListener('click', (e) => {
    const gear = (e.target as HTMLElement).closest<HTMLElement>('[data-gear]');
    if (gear) hooks.openGameSettings(gear.dataset.gear as 'bullet' | VersusGame);
  });
  initPagesInner(h);
}

function initPagesInner(h: PageHooks): void {
  hooks = h;
  buildArcade();
  buildVersus();
  buildHall();
  buildSocial();
  for (const key of ['arcade', 'versus', 'hall'] as PageKey[]) {
    el(`nav-${key}`).addEventListener('click', () => switchPage(key));
  }
  renderPresence();
  switchPage('arcade');
}

function buildArcade(): void {
  el('page-arcade').innerHTML = `
    <div class="page-head">
      <h2>单机游戏</h2>
      <button class="btn-ghost btn-sm" id="page-btn-board-a">排行榜</button>
    </div>
    <div class="game-grid">
      <div class="game-card">
        <button class="card-gear" data-gear="bullet" title="游戏设置"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3.2"/><path d="M19.4 15a1.7 1.7 0 00.34 1.87l.06.06a2 2 0 11-2.83 2.83l-.06-.06a1.7 1.7 0 00-1.87-.34 1.7 1.7 0 00-1.04 1.56V21a2 2 0 11-4 0v-.09a1.7 1.7 0 00-1.04-1.56 1.7 1.7 0 00-1.87.34l-.06.06a2 2 0 11-2.83-2.83l.06-.06A1.7 1.7 0 004.6 15a1.7 1.7 0 00-1.56-1.04H3a2 2 0 110-4h.09A1.7 1.7 0 004.6 8.9a1.7 1.7 0 00-.34-1.87l-.06-.06a2 2 0 112.83-2.83l.06.06a1.7 1.7 0 001.87.34h.09A1.7 1.7 0 0010 2.09V2a2 2 0 114 0v.09c0 .68.4 1.3 1.04 1.56a1.7 1.7 0 001.87-.34l.06-.06a2 2 0 112.83 2.83l-.06.06a1.7 1.7 0 00-.34 1.87v.09c.26.63.88 1.04 1.56 1.04H21a2 2 0 110 4h-.09A1.7 1.7 0 0019.4 15z"/></svg></button>
        <div class="game-card-ico" style="color:#4cc2ff">
          <svg viewBox="0 0 24 24" width="34" height="34" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M12 2l9 5v10l-9 5-9-5V7l9-5z"/><path d="M12 12l9-5M12 12v10M12 12L3 7"/></svg>
        </div>
        <h3>小电机弹幕</h3>
        <p>经典弹幕射击：受击实时联动郊狼 / 负鼠 / 灵猫三设备。击杀 Boss 掉落核心果实，吟唱拾取强化弹幕，每第 3 次 Boss 波双 Boss 登场。</p>
        <div class="game-card-meta">单机 · 设备联动 · Boss 强化体系</div>
        <button class="btn-gold btn-lg" id="card-bullet">进入游戏</button>
      </div>
    </div>`;
  el('card-bullet').addEventListener('click', () => hooks.enterArcade());
  el('page-btn-board-a').addEventListener('click', () => hooks.openBoard());
}

function buildVersus(): void {
  el('page-versus').innerHTML = `
    <div class="page-head">
      <h2>多人对战</h2>
      <button class="btn-ghost btn-sm" id="pv-online-btn">在线 -</button>
      <button class="btn-ghost btn-sm" id="page-btn-records-v">战 报</button>
      <button class="btn-ghost btn-sm" id="page-btn-board-v">排行榜</button>
      <div class="online-wrap">
        <button class="btn-gold btn-sm" id="pv-match-btn">
          <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px; margin-right:4px"><path d="M13 2 4.5 13.5H11L10 22l8.5-11.5H12L13 2z"/></svg>
          随机匹配
        </button>
        <div class="online-pop" id="pv-match-pop" hidden>
          <div class="online-pop-head">匹配一局 · 默认不限</div>
          <div class="social-match-opts">
            <button data-match-game="any">不限游戏（随机）</button>
            <button data-match-game="versus">电击消消乐</button>
            <button data-match-game="roulette">俄罗斯轮盘</button>
          </div>
        </div>
      </div>
    </div>
      <div class="game-grid">
      ${VERSUS_CARDS.map(
        (g) => `
        <div class="game-card">
          <button class="card-gear" data-gear="${g.key}" title="游戏设置"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3.2"/><path d="M19.4 15a1.7 1.7 0 00.34 1.87l.06.06a2 2 0 11-2.83 2.83l-.06-.06a1.7 1.7 0 00-1.87-.34 1.7 1.7 0 00-1.04 1.56V21a2 2 0 11-4 0v-.09a1.7 1.7 0 00-1.04-1.56 1.7 1.7 0 00-1.87.34l-.06.06a2 2 0 11-2.83-2.83l.06-.06A1.7 1.7 0 004.6 15a1.7 1.7 0 00-1.56-1.04H3a2 2 0 110-4h.09A1.7 1.7 0 004.6 8.9a1.7 1.7 0 00-.34-1.87l-.06-.06a2 2 0 112.83-2.83l.06.06a1.7 1.7 0 001.87.34h.09A1.7 1.7 0 0010 2.09V2a2 2 0 114 0v.09c0 .68.4 1.3 1.04 1.56a1.7 1.7 0 001.87-.34l.06-.06a2 2 0 112.83 2.83l-.06.06a1.7 1.7 0 00-.34 1.87v.09c.26.63.88 1.04 1.56 1.04H21a2 2 0 110 4h-.09A1.7 1.7 0 0019.4 15z"/></svg></button>
          <div class="game-card-ico" style="color:var(--gold)">${g.icon}</div>
          <h3>${g.name}</h3>
          <p>${g.desc}</p>
          <div class="presence" id="pv-${g.key}">游玩 - · 匹配 -</div>
          <button class="btn-gold btn-lg" id="card-${g.key}">进入游戏</button>
        </div>`,
      ).join('')}
    </div>
  `;
  for (const g of VERSUS_CARDS) {
    el(`card-${g.key}`).addEventListener('click', () => hooks.enterVersus(g.key));
  }
  el('page-btn-board-v').addEventListener('click', () => hooks.openBoard());
  el('page-btn-records-v').addEventListener('click', () => hooks.openBoard('records'));
  // 在线入口 → QQ 式社交页
  el('pv-online-btn').addEventListener('click', () => switchPage('social'));
  // 随机匹配（选游戏 → 打开大厅并自动匹配）
  el('pv-match-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    el('pv-match-pop').hidden = !el('pv-match-pop').hidden;
  });
  el('pv-match-pop').addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-match-game]');
    if (!btn) return;
    el('pv-match-pop').hidden = true;
    hooks.quickMatch(btn.dataset.matchGame as VersusGame | 'any');
  });
  document.addEventListener('click', (e) => {
    const pop = el('pv-match-pop');
    if (!pop.hidden && !(e.target as HTMLElement).closest('.online-wrap')) {
      pop.hidden = true;
    }
  });
}

function buildHall(): void {
  el('page-hall').innerHTML = `
    <div class="page-head">
      <h2>杂鱼展示区</h2>
      <span class="hint">战败徽章流转墙 · 耻辱实时公开</span>
      <button class="btn-ghost btn-sm" id="page-btn-board-h">对战记录</button>
    </div>
    <div id="hall-wall"><div class="hint" style="padding:30px; text-align:center">加载中…</div></div>`;
  el('page-btn-board-h').addEventListener('click', () => hooks.openBoard('records'));
  el('page-hall').addEventListener('click', (e) => {
    const card = (e.target as HTMLElement).closest('.hall-card');
    if (!card) return;
    void toggleTimeline(Number((card as HTMLElement).dataset.id));
  });
}

const timelineCache = new Map<number, { html: string; open: boolean }>();

/** 杂鱼区展示墙渲染（main 在切换页签和徽章操作后调用） */
export async function renderHallWall(): Promise<void> {
  const wall = el('hall-wall');
  if (!wall) return;
  try {
    const { badges, nicks } = await fetchHall();
    if (!badges.length) {
      wall.innerHTML = `<div class="hall-empty">
        <p>墙上还空空如也。</p>
        <p class="hint">去多人对战赢一场，给败者铸造第一枚徽章 —— 名称由你定。</p>
      </div>`;
      return;
    }
    wall.innerHTML = `<div class="hall-grid">${badges
      .map((b) => {
        const owner = nicks[b.owner] ?? b.owner;
        const creator = nicks[b.creator] ?? b.creator;
        const time = String(b.created_at ?? '').slice(5, 16).replace('T', ' ');
        return `
        <div class="hall-card ${b.locked ? 'locked' : ''}" data-id="${b.id}">
          <div class="hall-card-main">
            ${hallMedal(b.level, b.locked)}
            <div class="hall-card-info">
              <div class="hall-card-name">${escapeHtml(b.name)}</div>
              <div class="hall-card-sub">
                <span class="lv">Lv${b.level}</span>
                ${b.locked ? '<span class="lock-tag">锁定中</span>' : '<span class="free-tag">可转移</span>'}
              </div>
              <div class="hall-card-meta">持有者 ${escapeHtml(owner)} · 铸造 ${escapeHtml(creator)} · ${time}</div>
            </div>
          </div>
          <div class="hall-timeline" hidden></div>
        </div>`;
      })
      .join('')}</div>`;
    timelineCache.clear();
  } catch {
    wall.innerHTML = '<div class="hint" style="padding:30px; text-align:center">服务器未连接，展示墙不可用</div>';
  }
}

function hallMedal(level: number, locked: boolean): string {
  const pips = Array.from({ length: Math.max(0, level) }, () => '<i></i>').join('');
  return `
    <span class="badge-medal big ${locked ? 'locked' : ''}">
      <svg viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" aria-hidden="true">
        <path d="M14 3h7l3 9-6 5-6-5 2-9zM34 3h-7l-3 9 6 5 6-5-2-9z" fill="rgba(240,200,102,0.12)"/>
        <circle cx="24" cy="29" r="13"/>
        <circle cx="24" cy="29" r="8" stroke-dasharray="3 3"/>
      </svg>
      ${locked ? '<svg class="badge-lock" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><rect x="5" y="10" width="14" height="10" rx="2"/><path d="M8 10V7a4 4 0 018 0v3"/></svg>' : ''}
      ${level > 0 ? `<span class="badge-pips">${pips}</span>` : ''}
    </span>`;
}

const OP_NAMES: Record<string, string> = { mint: '铸造', transfer: '转赠', enhance: '加强', cleanse: '净化' };

async function toggleTimeline(id: number): Promise<void> {
  const card = el('page-hall').querySelector<HTMLElement>(`.hall-card[data-id="${id}"]`);
  const box = card?.querySelector<HTMLElement>('.hall-timeline');
  if (!card || !box) return;
  const cached = timelineCache.get(id);
  if (!cached) {
    box.innerHTML = '<div class="hint">加载时间线…</div>';
    box.hidden = false;
    try {
      const { history, nicks } = await fetchBadgeHistory(id);
      const html = history
        .map((h) => {
          const who = nicks[h.by] ?? h.by;
          const detail =
            h.op === 'mint' ? `为 ${nicks[h.to ?? ''] ?? h.to} 铸造「${h.name ?? ''}」`
            : h.op === 'transfer' ? `转赠给 ${nicks[h.to ?? ''] ?? h.to}`
            : h.op === 'enhance' ? `加强至 Lv${h.level} 并锁定`
            : '净化解锁';
          return `<div class="tl-line"><span class="tl-op">${OP_NAMES[h.op] ?? h.op}</span>${escapeHtml(who)} ${escapeHtml(detail)}<span class="tl-time">${String(h.time).slice(5, 16).replace('T', ' ')}</span></div>`;
        })
        .join('');
      timelineCache.set(id, { html, open: true });
      box.innerHTML = html || '<div class="hint">暂无记录</div>';
    } catch {
      box.innerHTML = '<div class="hint">时间线加载失败</div>';
    }
    return;
  }
  cached.open = !cached.open;
  box.hidden = !cached.open;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

export function switchPage(key: PageKey): void {
  if (key !== current) {
    pageHistory.push(current);
    trimHistory();
  }
  current = key;
  for (const k of ['arcade', 'versus', 'hall', 'social'] as PageKey[]) {
    el(`page-${k}`).hidden = k !== key;
    document.getElementById(`nav-${k}`)?.classList.toggle('active', k === key);
  }
  updateBackButton();
  if (key === 'hall') hooks.showHall?.();
}

// ===== 页面历史与固定返回按钮 =====
const pageHistory: PageKey[] = [];

function trimHistory(): void {
  if (pageHistory.length > 20) pageHistory.splice(0, pageHistory.length - 20);
}

function updateBackButton(): void {
  const btn = document.getElementById('page-back');
  if (btn) btn.hidden = pageHistory.length === 0;
}

/** 返回上一页（无历史时回单机首页） */
export function goBack(): void {
  const prev = pageHistory.pop() ?? 'arcade';
  current = prev;
  for (const k of ['arcade', 'versus', 'hall', 'social'] as PageKey[]) {
    el(`page-${k}`).hidden = k !== prev;
    document.getElementById(`nav-${k}`)?.classList.toggle('active', k === prev);
  }
  updateBackButton();
  if (prev === 'hall') hooks.showHall?.();
  if (prev === 'social') {
    renderSocialList();
    void renderSocialDetail();
    renderSocialInvite();
  }
}

export function showPages(): void {
  el('pages').hidden = false;
  switchPage(current);
  renderPresence();
}

export function hidePages(): void {
  el('pages').hidden = true;
}

/** 服务器 presence 推送入口（main 订阅 roomClient 后转来） */
export function updatePresence(msg: unknown): void {
  const m = msg as PresenceInfo & { t?: string };
  if (m?.t !== 'presence') return;
  lastPresence = m;
  renderPresence();
}

function renderPresence(): void {
  const btnEl = el('pv-online-btn');
  const games = lastPresence?.games ?? {};
  const online = lastPresence?.online ?? 0;
  if (btnEl) {
    btnEl.textContent = lastPresence ? `在线 ${online} ▾` : '离线 ▾';
    btnEl.classList.toggle('live', Boolean(lastPresence));
  }
  for (const g of VERSUS_CARDS) {
    const pv = el(`pv-${g.key}`);
    if (!pv) continue;
    const info = games[g.key];
    pv.textContent = info ? `游玩 ${info.playing} · 匹配 ${info.matching}` : '游玩 - · 匹配 -';
    pv.classList.toggle('live', !!info && (info.playing > 0 || info.matching > 0));
  }
}

/** 门户级静默连接：进入多人区/页面刷新时保持在线，失败静默 */
export async function portalConnect(room: RoomClient): Promise<void> {
  if (room.connected) return;
  const saved = localStorage.getItem('dg-battle-server-url');
  const url = saved || (location.protocol === 'https:' ? `wss://${location.host}/dgws` : 'ws://localhost:8787');
  try {
    await room.connect(url, getToken());
  } catch {
    /* 无服务器时人数显示为 -，不影响其他功能 */
  }
}

/* ===== 社交页（QQ 式：左在线名单 / 右用户资料卡） ===== */

interface SocialUser {
  user: string;
  nick: string;
}

let socialOnline: SocialUser[] = [];
let socialSelected = '';
let hallCache: { badges: Badge[]; nicks: Record<string, string>; at: number } | null = null;

function buildSocial(): void {
  el('page-social').innerHTML = `
    <div class="page-head">
      <h2>在线社交</h2>
      <span class="hint" id="social-hint">连接服务器后显示在线名单</span>
      <div class="online-wrap">
        <button class="btn-gold btn-sm" id="social-match-btn">
          <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px; margin-right:4px"><path d="M13 2 4.5 13.5H11L10 22l8.5-11.5H12L13 2z"/></svg>
          随机匹配
        </button>
        <div class="online-pop" id="social-match-pop" hidden>
          <div class="online-pop-head">匹配一局 · 默认不限</div>
          <div class="social-match-opts">
            <button data-match-game="any">不限游戏（随机）</button>
            <button data-match-game="versus">电击消消乐</button>
            <button data-match-game="roulette">俄罗斯轮盘</button>
          </div>
        </div>
      </div>
    </div>
    <div class="social-layout">
      <div class="social-list" id="social-list"><div class="hint" style="padding:14px">连接服务器后显示在线名单</div></div>
      <div class="social-detail" id="social-detail"><div class="hint" style="padding:30px; text-align:center">从左侧选择一位在线用户</div></div>
      <div class="social-invite" id="social-invite"></div>
    </div>`;

  el('social-match-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    el('social-match-pop').hidden = !el('social-match-pop').hidden;
  });
  document.addEventListener('click', (e) => {
    const pop = el('social-match-pop');
    if (!pop.hidden && !(e.target as HTMLElement).closest('.online-wrap')) pop.hidden = true;
  });
  el('social-match-pop').addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-match-game]');
    if (!btn) return;
    el('social-match-pop').hidden = true;
    hooks.quickMatch(btn.dataset.matchGame as VersusGame | 'any');
  });
  el('social-list').addEventListener('click', (e) => {
    const row = (e.target as HTMLElement).closest<HTMLElement>('.social-row');
    if (!row) return;
    selectSocialUser(row.dataset.user!);
  });
  // 自己板块：昵称编辑 / 退出登录
  el('social-detail').addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    if (target.id === 'btn-nick-save') void saveNickFromSocial();
    if (target.id === 'btn-logout-social') {
      void logout().then(() => {
        refreshAccountEntry();
        socialSelected = '';
        hallCache = null;
        renderSocialList();
        renderSocialDetail();
        renderSocialInvite();
      });
    }
  });
  el('social-detail').addEventListener('keydown', (e) => {
    if ((e.target as HTMLElement).id === 'nick-input-social' && e.key === 'Enter') void saveNickFromSocial();
  });
  // 邀约面板
  el('social-invite').addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-invite-game]');
    if (!btn || !socialSelected) return;
    hooks.invite(socialSelected, btn.dataset.inviteGame as VersusGame);
  });
}

/** 顶栏账户按钮 / 昵称入口：打开社交页并定位到自己 */
export function openSelfProfile(): void {
  socialSelected = getCurrentUser()?.username ?? '';
  switchPage('social');
  renderSocialList();
  void renderSocialDetail(true);
  renderSocialInvite();
}

async function saveNickFromSocial(): Promise<void> {
  const input = el('nick-input-social', HTMLInputElement);
  const msg = el('nick-msg-social');
  const nickname = input.value.trim();
  if (!nickname) {
    msg.textContent = '昵称不能为空';
    return;
  }
  try {
    await changeNickname(nickname);
    msg.style.color = 'var(--ok)';
    msg.textContent = '已保存';
    refreshAccountEntry();
    setTimeout(() => void renderSocialDetail(true), 800);
  } catch (err) {
    msg.style.color = '';
    msg.textContent = err instanceof Error ? err.message : String(err);
  }
}

/** 服务器 online 推送驱动（main 转来） */
export function updateSocialOnline(list: SocialUser[]): void {
  socialOnline = list;
  const me = getCurrentUser()?.username ?? '';
  if (!socialSelected) socialSelected = me;
  const hint = el('social-hint');
  if (hint) hint.textContent = `全站在线 ${list.length} 人`;
  renderSocialList();
  // 选中者掉线则回到自己
  if (socialSelected && !list.some((u) => u.user === socialSelected)) {
    selectSocialUser(me);
  } else {
    renderSocialDetail();
    renderSocialInvite();
  }
}

function renderSocialList(): void {
  const box = el('social-list');
  const me = getCurrentUser()?.username ?? '';
  if (!socialOnline.length) {
    box.innerHTML = '<div class="hint" style="padding:14px">暂无在线用户</div>';
    return;
  }
  box.innerHTML = socialOnline
    .map((u) => {
      const self = u.user === me;
      return `
      <div class="social-row ${u.user === socialSelected ? 'active' : ''}" data-user="${escapeHtml(u.user)}">
        <span class="social-avatar">${escapeHtml((u.nick || u.user).slice(0, 1).toUpperCase())}</span>
        <span class="social-row-main">
          <span class="social-row-nick">${escapeHtml(u.nick)}${self ? '（我）' : ''}</span>
          <span class="social-row-id">${escapeHtml(u.user)}</span>
        </span>
      </div>`;
    })
    .join('');
}

function selectSocialUser(user: string): void {
  socialSelected = user;
  renderSocialList();
  void renderSocialDetail(true);
  renderSocialInvite();
}

/** 右侧邀约面板：随选中者切换 */
function renderSocialInvite(): void {
  const box = el('social-invite');
  const me = getCurrentUser()?.username ?? '';
  const user = socialSelected || me;
  if (!user) {
    box.innerHTML = '<div class="hint" style="padding:20px">登录后使用</div>';
    return;
  }
  if (user === me) {
    box.innerHTML = `
      <div class="sec">游戏邀约</div>
      <div class="hint" style="padding:14px 4px">这是你自己 —— 从左侧选择其他在线玩家发起邀约。</div>`;
    return;
  }
  const info = socialOnline.find((u) => u.user === user);
  const nick = info?.nick ?? user;
  box.innerHTML = `
    <div class="sec">游戏邀约</div>
    <div class="social-invite-name">与 <b style="color:var(--gold)">${escapeHtml(nick)}</b> 来一局</div>
    <div class="social-invite-btns">
      <button class="btn-gold btn-lg" data-invite-game="versus" style="width:100%">邀战 · 电击消消乐</button>
      <button class="btn btn-lg" data-invite-game="roulette" style="width:100%">邀战 · 俄罗斯轮盘</button>
    </div>
    <div class="hint" style="margin-top:10px">对方接受后自动建房开局；对方会收到横幅提示。</div>`;
}

async function renderSocialDetail(force = false): Promise<void> {
  const box = el('social-detail');
  const me = getCurrentUser()?.username ?? '';
  const user = socialSelected || me;
  if (!user) {
    box.innerHTML = '<div class="hint" style="padding:30px; text-align:center">登录后查看</div>';
    return;
  }
  const info = socialOnline.find((u) => u.user === user);
  const meUser = getCurrentUser();
  const nick = info?.nick ?? (user === me ? (meUser?.nickname ?? user) : user);

  if (!hallCache || Date.now() - hallCache.at > 10_000 || force) {
    box.innerHTML = '<div class="hint" style="padding:30px; text-align:center">加载中…</div>';
    try {
      const data = await fetchHall();
      hallCache = { ...data, at: Date.now() };
    } catch {
      box.innerHTML = '<div class="hint" style="padding:30px; text-align:center">徽章加载失败（服务器未连接？）</div>';
      return;
    }
  }

  const badges = hallCache.badges.filter((b) => b.owner === user);
  const self = user === me;
  const cooldown = self ? nicknameCooldownMs() : 0;
  box.innerHTML = `
    <div class="social-profile">
      <div class="social-profile-head">
        <span class="social-avatar big">${escapeHtml((nick || user).slice(0, 1).toUpperCase())}</span>
        <div>
          <div class="social-profile-nick">${escapeHtml(nick)}${self ? '<span class="hint" style="font-size:12px">（我）</span>' : ''}</div>
          <div class="social-profile-id">ID ${escapeHtml(user)} · ${info ? '在线' : '离线'}${self && meUser?.created_at ? ` · 注册于 ${escapeHtml(meUser.created_at)}` : ''}</div>
        </div>
      </div>
      ${
        self
          ? `<div class="sec" style="margin-top:16px">昵称</div>
             <div class="sec-note">昵称为游戏内展示名，每 3 天可修改一次${cooldown > 0 ? `，距下次可修改还有 ${Math.ceil(cooldown / 3600_000)} 小时` : '，现在可以修改'}。</div>
             <div class="row">
               <input type="text" id="nick-input-social" maxlength="16" value="${escapeHtml(meUser?.nickname ?? user)}" ${cooldown > 0 ? 'disabled' : ''} style="flex:1" />
               <button class="btn-gold" id="btn-nick-save" ${cooldown > 0 ? 'disabled' : ''}>保存昵称</button>
             </div>
             <div class="auth-msg" id="nick-msg-social"></div>`
          : ''
      }
      <div class="sec" style="margin-top:14px">徽章墙 · ${badges.length} 枚</div>
      ${
        badges.length
          ? `<div class="badge-pick-grid">${badges.map((b) => badgeChip(b, hallCache!.nicks, b.locked)).join('')}</div>`
          : '<div class="hint">还没有徽章 —— 百战不殆，或一败涂地之后就会有了。</div>'
      }
      ${
        self
          ? `<div style="display:flex; justify-content:flex-end; margin-top:14px">
               <button class="btn-red" id="btn-logout-social">退出登录</button>
             </div>`
          : ''
      }
    </div>`;
}
