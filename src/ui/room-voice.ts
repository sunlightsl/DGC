import type { RoomClient } from '../net/room-client';
import { VoiceChannel, type VoiceState } from '../voice/voice-channel';

/**
 * 局内语音按钮 + 迷你面板（对局右下角，聊天按钮上方）。
 * 点击加入语音 → 麦克风权限 → 加密密钥交换 → P2P 通话；
 * 加入后可静音/挂断。房间解散自动清理。
 */

let room: RoomClient;
let role: 1 | 2 = 1;
let channel: VoiceChannel | null = null;
let built = false;

const STATE_TEXT: Record<VoiceState, string> = {
  idle: '',
  'wait-key': '交换语音密钥…',
  'wait-peer': '等待对方…',
  connecting: '建立 P2P 连接…',
  connected: '通话中',
  ended: '已结束',
};

function el<T extends HTMLElement = HTMLElement>(id: string, _ctor?: new () => T): T {
  return document.getElementById(id) as T;
}

export function initVoice(r: RoomClient, myRole: 1 | 2): void {
  room = r;
  role = myRole;
  buildDom();
  el('room-voice').hidden = false;
  resetUi();
}

export function destroyVoice(): void {
  channel?.destroy();
  channel = null;
  const box = document.getElementById('room-voice');
  if (box) box.hidden = true;
}

function buildDom(): void {
  if (built) return;
  built = true;
  const wrap = document.createElement('div');
  wrap.id = 'room-voice';
  wrap.hidden = true;
  wrap.innerHTML = `
    <button id="rv-toggle" class="rc-toggle rv-toggle" title="语音通话">
      <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0014 0M12 18v3"/></svg>
    </button>
    <div id="rv-panel" class="rv-panel" hidden>
      <div class="rc-head"><span>语音频道</span><span id="rv-state" class="hint"></span></div>
      <div class="rv-actions">
        <button class="btn btn-sm" id="rv-mute" hidden>静音</button>
        <button class="btn-red btn-sm" id="rv-leave" hidden>挂断</button>
        <button class="btn-gold btn-sm" id="rv-join">加入语音</button>
      </div>
    </div>`;
  // 插到聊天按钮上方
  const chat = document.getElementById('room-chat');
  chat?.parentElement?.insertBefore(wrap, chat);
  if (!chat) el('battle-root').appendChild(wrap);

  el('rv-toggle').addEventListener('click', () => {
    const panel = el('rv-panel');
    panel.hidden = !panel.hidden;
  });
  el('rv-join').addEventListener('click', () => void join());
  el('rv-mute').addEventListener('click', () => {
    const muted = channel?.toggleMute() ?? true;
    el('rv-mute').textContent = muted ? '取消静音' : '静音';
  });
  el('rv-leave').addEventListener('click', () => leave());
}

function resetUi(): void {
  el('rv-panel').hidden = true;
  el('rv-join').hidden = false;
  el('rv-mute').hidden = true;
  el('rv-leave').hidden = true;
  el('rv-state').textContent = '';
  el('rv-toggle').classList.remove('on');
}

async function join(): Promise<void> {
  if (channel) return;
  channel = new VoiceChannel(room, role, {
    onState: (state) => {
      const stateEl = el('rv-state');
      let text = state === 'connected' ? '通话中' : STATE_TEXT[state];
      if (channel && channel.mode === 'dtls' && (state === 'connected' || state === 'connecting')) {
        text += '（仅传输加密）';
      }
      stateEl.textContent = text;
      if (state === 'wait-key') {
        // 3 秒后还没进入 connecting，提示等待对方
        setTimeout(() => {
          if (channel && !channel.ready && stateEl.textContent === STATE_TEXT['wait-key']) {
            stateEl.textContent = '等待对方加入语音…';
          }
        }, 3000);
      }
      const on = state === 'connected' || state === 'connecting' || state === 'wait-key';
      el('rv-toggle').classList.toggle('on', state === 'connected');
      el('rv-join').hidden = on;
      el('rv-mute').hidden = !on || state !== 'connected';
      el('rv-leave').hidden = !on;
      if (state === 'ended') leave();
    },
    onLocalStream: (stream) => {
      if (!stream) return;
      void stream;
    },
    onError: (message) => {
      el('rv-state').textContent = message;
    },
  });
  try {
    await channel.start();
  } catch (err) {
    channel = null;
    el('rv-state').textContent = err instanceof Error ? err.message : String(err);
  }
}

function leave(): void {
  channel?.destroy();
  channel = null;
  resetUi();
}
