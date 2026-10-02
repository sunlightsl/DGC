import type { RoomClient, RoomMessage } from '../net/room-client';
import { E2EChannel } from '../crypto/e2ee';

/**
 * 局内加密私聊（对局双方，含惩罚阶段）：
 * - ECDH 协商 + AES-GCM，服务器只见密文
 * - 文字 ≤300 字；图片本地压缩（长边 1280 / JPEG 0.85）后以 dataURL 加密发送，不落服务器
 * - 浮动面板，悬于对战区右下
 */

const MAX_IMG_EDGE = 1280;
const MAX_TEXT = 300;

let room: RoomClient;
let channel: E2EChannel | null = null;
let offMsg: (() => void) | null = null;
let publishTimer: ReturnType<typeof setInterval> | null = null;
let myPub = '';
let getNick: (self: boolean) => string = () => '玩家';
let built = false;
let imgSeq = 0;

function el<T extends HTMLElement = HTMLElement>(id: string, _ctor?: new () => T): T {
  return document.getElementById(id) as T;
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

export function initRoomChat(r: RoomClient, nickFor: (self: boolean) => string): void {
  room = r;
  getNick = nickFor;
  buildDom();
  el('room-chat').hidden = false;
  el('rc-log').innerHTML = '';
  setStatus('建立加密通道…');

  channel = new E2EChannel();
  offMsg = room.onMessage((msg) => void handle(msg));

  void channel.init().then((pub) => {
    myPub = pub;
    // 重试发布公钥，直到对方密钥到达（双方 start 时机可能错开）
    publishTimer = setInterval(() => {
      if (!channel || channel.ready) {
        stopPublish();
        return;
      }
      room.send({ kind: 'e2eeKey', pub: myPub });
    }, 1000);
    room.send({ kind: 'e2eeKey', pub: myPub });
  });
}

export function destroyRoomChat(): void {
  stopPublish();
  offMsg?.();
  offMsg = null;
  channel = null;
  myPub = '';
  const box = document.getElementById('room-chat');
  if (box) box.hidden = true;
  dismissInvite();
}

function stopPublish(): void {
  if (publishTimer) {
    clearInterval(publishTimer);
    publishTimer = null;
  }
}

async function handle(msg: RoomMessage): Promise<void> {
  if (!channel) return;
  if (msg.kind === 'e2eeKey') {
    const ready = await channel.onPeerKey(String(msg.pub ?? ''));
    if (ready) setStatus('端到端加密已建立');
    return;
  }
  if (msg.kind === 'e2ee') {
    try {
      const text = await channel.decrypt(String(msg.iv), String(msg.cipher));
      appendLine(getNick(false), esc(text));
    } catch {
      appendLine('系统', '<span class="hint">[无法解密的消息]</span>');
    }
    return;
  }
  if (msg.kind === 'e2eeImg') {
    try {
      const dataUrl = await channel.decrypt(String(msg.iv), String(msg.cipher));
      appendLine(getNick(false), `<img class="rc-img" src="${dataUrl}" alt="图片" data-zoom="${dataUrl}" />`);
    } catch {
      appendLine('系统', '<span class="hint">[无法解密的图片]</span>');
    }
  }
}

function buildDom(): void {
  if (built) return;
  built = true;
  const wrap = document.createElement('div');
  wrap.id = 'room-chat';
  wrap.hidden = true;
  wrap.innerHTML = `
    <button id="rc-toggle" class="rc-toggle" title="加密私聊">
      <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.4 8.4 0 01-8.4 8.4c-1.5 0-2.9-.36-4.1-1L3 20l1.2-5.3A8.4 8.4 0 1121 11.5z"/></svg>
      <span id="rc-dot" class="rc-dot" hidden></span>
    </button>
    <div id="rc-panel" class="rc-panel" hidden>
      <div class="rc-head">
        <span>私聊 · 端到端加密</span>
        <span id="rc-status" class="hint">…</span>
      </div>
      <div id="rc-log"></div>
      <div class="rc-input-row">
        <button id="rc-img" class="rc-icon-btn" title="发送加密图片">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8.5" cy="8.5" r="1.8"/><path d="M21 15.5l-5-5-9 9"/></svg>
        </button>
        <input type="file" id="rc-file" accept="image/*" hidden />
        <input type="text" id="rc-text" maxlength="${MAX_TEXT}" placeholder="悄悄话…（Enter 发送）" />
        <button id="rc-send" class="btn-gold btn-sm">发送</button>
      </div>
    </div>`;
  el('battle-root').appendChild(wrap);

  el('rc-toggle').addEventListener('click', () => {
    const panel = el('rc-panel');
    panel.hidden = !panel.hidden;
    el('rc-dot').hidden = true;
    if (!panel.hidden) el('rc-text', HTMLInputElement).focus();
  });
  el('rc-send').addEventListener('click', () => void sendText());
  el('rc-text').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') void sendText();
  });
  el('rc-img').addEventListener('click', () => el('rc-file', HTMLInputElement).click());
  el('rc-file').addEventListener('change', () => {
    const file = el('rc-file', HTMLInputElement).files?.[0];
    if (file) void sendImage(file);
    el('rc-file', HTMLInputElement).value = '';
  });
  // 图片点击放大（日志内委托）
  el('rc-log').addEventListener('click', (e) => {
    const img = (e.target as HTMLElement).closest<HTMLElement>('.rc-img[data-zoom]');
    if (img) openImageLightbox(img.dataset.zoom!);
  });
}

function setStatus(text: string): void {
  const s = document.getElementById('rc-status');
  if (s) s.textContent = text;
}

function appendLine(nick: string, innerHtml: string): void {
  const log = el('rc-log');
  const line = document.createElement('div');
  line.className = 'rc-line';
  line.innerHTML = `<span class="rc-nick">${esc(nick)}</span><span class="rc-body">${innerHtml}</span>`;
  log.appendChild(line);
  while (log.children.length > 60) log.firstElementChild?.remove();
  log.scrollTop = log.scrollHeight;
  if (el('rc-panel').hidden) el('rc-dot').hidden = false;
}

/** 点击图片放大查看（lightbox，点击任意处关闭） */
function openImageLightbox(src: string): void {
  let box = document.getElementById('rc-lightbox');
  if (!box) {
    box = document.createElement('div');
    box.id = 'rc-lightbox';
    box.style.cssText =
      'position:fixed;inset:0;z-index:260;background:rgba(5,7,12,0.88);display:flex;align-items:center;justify-content:center;cursor:zoom-out';
    box.addEventListener('click', () => {
      box!.style.display = 'none';
    });
    document.body.appendChild(box);
  }
  box.innerHTML = `<img src="${src}" alt="图片" style="max-width:92vw;max-height:92vh;border-radius:10px;border:1px solid var(--border,#2a2f3a);box-shadow:0 12px 50px rgba(0,0,0,.6)" />`;
  (box as HTMLElement).style.display = 'flex';
}

async function sendText(): Promise<void> {
  const input = el('rc-text', HTMLInputElement);
  const text = input.value.trim();
  if (!text || !channel) return;
  if (!channel.ready) {
    setStatus('等待对方建立加密…');
    return;
  }
  try {
    const { iv, cipher } = await channel.encrypt(text);
    room.send({ kind: 'e2ee', iv, cipher });
    appendLine(getNick(true), esc(text));
    input.value = '';
  } catch {
    setStatus('加密失败');
  }
}

/** 图片：本地压缩 → dataURL → 加密发送（服务器只存转发密文，不落库） */
async function sendImage(file: File): Promise<void> {
  if (!channel) return;
  if (!channel.ready) {
    setStatus('等待对方建立加密…');
    return;
  }
  try {
    setStatus('压缩并加密图片…');
    const dataUrl = await compressImage(file);
    const { iv, cipher } = await channel.encrypt(dataUrl);
    room.send({ kind: 'e2eeImg', iv, cipher, seq: ++imgSeq });
    appendLine(getNick(true), `<img class="rc-img self" src="${dataUrl}" alt="图片" data-zoom="${dataUrl}" />`);
    setStatus('端到端加密已建立');
  } catch {
    setStatus('图片处理失败');
  }
}

function compressImage(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      try {
        const scale = Math.min(1, MAX_IMG_EDGE / Math.max(img.width, img.height));
        const w = Math.max(1, Math.round(img.width * scale));
        const h = Math.max(1, Math.round(img.height * scale));
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        canvas.getContext('2d')!.drawImage(img, 0, 0, w, h);
        URL.revokeObjectURL(url);
        resolve(canvas.toDataURL('image/jpeg', 0.85));
      } catch (err) {
        URL.revokeObjectURL(url);
        reject(err);
      }
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('图片解码失败'));
    };
    img.src = url;
  });
}

function dismissInvite(): void {
  document.getElementById('invite-banner')?.remove();
}
