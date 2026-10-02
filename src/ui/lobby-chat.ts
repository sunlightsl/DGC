import type { RoomClient, RoomMessage } from '../net/room-client';

/**
 * 大厅浮动聊天（全局）：挂在 body 层级，任何页面都能收发；
 * 气泡式消息（他人左侧带头像、自己右侧金色气泡）；进入对局时隐藏，退出恢复。
 * 收到邀战时弹横幅（全局）。
 */

export interface LobbyChatHooks {
  /** 邀战被接受后由 main 启动游戏 */
  onMatched: (game: 'versus' | 'roulette', peerNick: string) => void;
}

interface ChatEntry {
  from: string;
  nick: string;
  text: string;
  time: string;
}

let room: RoomClient;
let hooks: LobbyChatHooks;
let myUser = '';
let sendLockedUntil = 0;
let offMsg: (() => void) | null = null;
let built = false;

function el<T extends HTMLElement = HTMLElement>(id: string, _ctor?: new () => T): T {
  return document.getElementById(id) as T;
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function fmtTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function initLobbyChat(r: RoomClient, h: LobbyChatHooks, me: string): void {
  room = r;
  hooks = h;
  myUser = me;
  buildDom();
  offMsg?.();
  offMsg = room.onMessage((msg) => handle(msg));
  bindInput();
}

export function destroyLobbyChat(): void {
  offMsg?.();
  offMsg = null;
}

/** 进入对局时隐藏（局内有独立私聊），退出对局恢复 */
export function setLobbyChatVisible(visible: boolean): void {
  const box = document.getElementById('lobby-chat-fab');
  if (box) box.hidden = !visible;
}

function buildDom(): void {
  if (built) return;
  built = true;
  const fab = document.createElement('div');
  fab.id = 'lobby-chat-fab';
  fab.className = 'lobby-chat-fab';
  fab.innerHTML = `
    <div class="lc-panel rc-panel" id="lc-panel" hidden>
      <div class="rc-head"><span>大厅 · 大家一起聊</span><span class="hint" id="lc-state">wss 加密传输</span></div>
      <div id="chat-log"></div>
      <div class="chat-input-row">
        <input type="text" id="chat-input" maxlength="200" placeholder="说点什么…（Enter 发送）" />
        <button class="btn-gold" id="chat-send">发送</button>
      </div>
    </div>
    <button id="lc-toggle" class="rc-toggle" title="大厅聊天">
      <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.4 8.4 0 01-8.4 8.4c-1.5 0-2.9-.36-4.1-1L3 20l1.2-5.3A8.4 8.4 0 1121 11.5z"/></svg>
      <span id="lc-dot" class="rc-dot" hidden></span>
    </button>`;
  document.body.appendChild(fab);
}

function bindInput(): void {
  const input = el('chat-input', HTMLInputElement);
  el('chat-send').addEventListener('click', () => sendChat());
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') sendChat();
  });
  el('lc-toggle').addEventListener('click', () => {
    const panel = el('lc-panel');
    panel.hidden = !panel.hidden;
    el('lc-dot').hidden = true;
    if (!panel.hidden) {
      scrollBottom();
      input.focus();
    }
  });
}

function handle(msg: RoomMessage): void {
  switch (msg.t) {
    case 'chatHistory': {
      const log = el('chat-log');
      log.innerHTML = '';
      for (const e of (msg.list as ChatEntry[]) ?? []) appendChat(e);
      scrollBottom();
      break;
    }
    case 'chat':
      appendChat(msg as unknown as ChatEntry);
      scrollBottom();
      break;
    case 'invited':
      showInvitePrompt(msg as unknown as { inviteId: string; from: string; nick: string; game: string });
      break;
  }
}

function appendChat(e: ChatEntry): void {
  const log = el('chat-log');
  const self = e.from === myUser;
  const line = document.createElement('div');
  line.className = `chat-line ${self ? 'self' : 'other'}`;
  if (self) {
    line.innerHTML = `
      <div class="chat-stack right">
        <div class="chat-bubble gold">${esc(e.text)}</div>
        <span class="chat-time">${fmtTime(e.time)}</span>
      </div>`;
  } else {
    line.innerHTML = `
      <span class="chat-avatar">${esc((e.nick || '?').slice(0, 1).toUpperCase())}</span>
      <div class="chat-stack">
        <span class="chat-nick">${esc(e.nick)}</span>
        <div class="chat-bubble">${esc(e.text)}</div>
        <span class="chat-time">${fmtTime(e.time)}</span>
      </div>`;
  }
  log.appendChild(line);
  while (log.children.length > 80) log.firstElementChild?.remove();
  scrollBottom();
  if (el('lc-panel').hidden) el('lc-dot').hidden = false;
}

function sendChat(): void {
  const input = el('chat-input', HTMLInputElement);
  const text = input.value.trim();
  if (!text) return;
  if (!room.connected) {
    showToast('未连接服务器');
    return;
  }
  if (Date.now() < sendLockedUntil) return;
  sendLockedUntil = Date.now() + 1500;
  room.sendChat(text);
  input.value = '';
  input.focus();
}

/** 收到邀战：顶部横幅提示，30 秒自动消失 */
function showInvitePrompt(inv: { inviteId: string; from: string; nick: string; game: string }): void {
  dismissInvitePrompt();
  const gameName = inv.game === 'roulette' ? '恶魔轮盘' : '电击消消乐';
  const banner = document.createElement('div');
  banner.className = 'invite-banner';
  banner.id = 'invite-banner';
  banner.innerHTML = `
    <span><b>${esc(inv.nick)}</b> 邀请你进行 <b>${gameName}</b></span>
    <span class="invite-actions">
      <button class="btn-gold" id="invite-accept">接 受</button>
      <button class="btn" id="invite-decline">拒 绝</button>
    </span>`;
  document.body.appendChild(banner);
  const done = (accept: boolean) => {
    room.replyInvite(inv.inviteId, accept);
    dismissInvitePrompt();
    if (accept) {
      void room
        .waitMatched()
        .then((m) => hooks.onMatched(m.game as 'versus' | 'roulette', m.peer))
        .catch((err) => showToast(err instanceof Error ? err.message : String(err)));
    }
  };
  banner.querySelector('#invite-accept')!.addEventListener('click', () => done(true));
  banner.querySelector('#invite-decline')!.addEventListener('click', () => done(false));
  setTimeout(() => {
    if (document.getElementById('invite-banner')) dismissInvitePrompt();
  }, 30_000);
}

function dismissInvitePrompt(): void {
  document.getElementById('invite-banner')?.remove();
}

function showToast(text: string): void {
  let toast = document.getElementById('lobby-toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'lobby-toast';
    toast.className = 'lobby-toast';
    document.body.appendChild(toast);
  }
  toast.textContent = text;
  toast.hidden = false;
  clearTimeout(Number(toast.dataset.timer ?? 0));
  const timer = setTimeout(() => {
    toast.hidden = true;
  }, 2600);
  toast.dataset.timer = String(timer);
}

function scrollBottom(): void {
  const log = el('chat-log');
  log.scrollTop = log.scrollHeight;
}
