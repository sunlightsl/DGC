import type { FeedbackEngine } from '../devices/feedback-engine';
import type { RoomClient, RoomMessage } from '../net/room-client';
import type { Settings } from '../settings';
import { COYOTE_WAVEFORM_OPTIONS } from '../settings';
import { ensureNickname } from '../profile';
import { getCurrentUser } from '../account';
import { showTrophy, hideTrophy } from '../ui/trophy';
import { initRoomChat, destroyRoomChat } from '../ui/room-chat';
import { initVoice, destroyVoice } from '../ui/room-voice';
import { playSfx } from '../audio/sfx';
import type { RouletteGameConfig } from '../game-settings';

/**
 * 恶魔轮盘（2 人回合制联机）：
 * - 6 弹巢左轮，每轮随机 1~3 发实弹（数量公开，顺序保密）
 * - 轮到自己选择「对对方开枪」或「对自己开枪」
 *   · 对对方：实弹对方 HP-1；无论中弹与否回合移交对方
 *   · 对自己：实弹自己 HP-1 且回合移交；空弹奖励「保留回合」
 * - HP 各 5 点，中弹一方自己的郊狼被电击（各自控制各自设备）
 * - HP 归零者战败，进入与消消乐相同的惩罚流程
 * - 房主（role1）为权威端，状态机只在房主推进
 */

export interface RouletteDeps {
  feedback: FeedbackEngine;
  room: RoomClient;
  getSettings: () => Settings;
  /** 轮盘个人设置（HP/实弹上限/思考时限） */
  getGameConfig: () => RouletteGameConfig;
  config: { nickname: string };
  onExit: () => void;
}

const CHAMBER_SIZE = 6;
const RESOLVE_DELAY_MS = 1100;

const WINNER_PHRASES = ['就这点本事？', '服不服？', '再来一局找回场子？', '这才刚开始', '承认吧，你输了', '准备好通电了吗'];
const LOSER_PHRASES = ['错了错了', '轻一点嘛', '饶了我吧', '手滑，绝对是手滑', '给我等着', '下一局一定赢'];
const DANMAKU_COLORS = ['#ffffff', '#f0c866', '#4cc2ff', '#4cff9d', '#ff9d4c'];

interface RzState {
  hp: [number, number];
  /** 弹巢，队首为下一发；true=实弹（仅房主持有，永不外发） */
  chamber: boolean[];
  round: number;
  turn: 1 | 2;
  last: { shooter: 1 | 2; aim: 'self' | 'opp'; live: boolean } | null;
  over: boolean;
}

/** 广播给双方的公开状态：只含实弹数量与剩余弹位，不含顺序 */
interface RzPublic {
  hp: [number, number];
  round: number;
  turn: 1 | 2;
  last: RzState['last'];
  over: boolean;
  live: number;
  left: number;
}

function el<T extends HTMLElement = HTMLElement>(id: string, _ctor?: new () => T): T {
  return document.getElementById(id) as T;
}

let active: RouletteGame | null = null;
let staticBound = false;

function bindStatic(): void {
  if (staticBound) return;
  staticBound = true;
  el('btn-surrender').addEventListener('click', () => active?.surrender());
  el('btn-stop-punish').addEventListener('click', () => active?.stopPunishmentAsWinner());
  el('btn-exit-l').addEventListener('click', () => active?.exit());
  el('btn-victory-exit').addEventListener('click', () => active?.exit());
  el('btn-victory-exit2').addEventListener('click', () => active?.exit());

  // 弹幕快捷语（与消消乐互不干扰：双方各自用自己的 active 判空）
  for (const [id, phrases] of [
    ['punish-phrases', LOSER_PHRASES],
    ['victory-phrases', WINNER_PHRASES],
  ] as const) {
    const box = el(id);
    box.innerHTML = phrases.map((p) => `<button type="button" class="chip" data-phrase="${p}">${p}</button>`).join('');
    box.addEventListener('click', (e) => {
      const phrase = (e.target as HTMLElement).dataset?.phrase;
      if (phrase) active?.sendDanmaku(phrase);
    });
  }

  // 胜者波形 chips
  const waveBox = el('punish-wave-chips');
  waveBox.addEventListener('click', (e) => {
    const key = (e.target as HTMLElement).dataset?.key;
    if (!key || !active) return;
    waveBox.dataset.current = key;
    waveBox.querySelectorAll('.chip').forEach((c) => c.classList.toggle('active', c === e.target));
    active.sendPunishCtl();
  });
  el('punish-intensity').addEventListener('input', () => {
    const v = Number(el('punish-intensity', HTMLInputElement).value);
    el('punish-intensity-val').textContent = v === 0 ? '自动' : String(v);
    active?.sendPunishCtl();
  });
}

function showDanmaku(text: string): void {
  const layer = el('danmaku-layer');
  const item = document.createElement('div');
  item.className = 'danmaku-item';
  item.textContent = text;
  item.style.top = `${8 + Math.random() * 55}%`;
  item.style.color = DANMAKU_COLORS[Math.floor(Math.random() * DANMAKU_COLORS.length)];
  item.style.fontSize = `${15 + Math.random() * 9}px`;
  item.style.animationDuration = `${6 + Math.random() * 3}s`;
  item.addEventListener('animationend', () => item.remove());
  setTimeout(() => item.remove(), 10000);
  layer.appendChild(item);
}

function hearts(hp: number, maxHp: number): string {
  const heart = (fill: string) =>
    `<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z" fill="${fill}"/></svg>`;
  let out = '';
  for (let i = 0; i < maxHp; i++) out += heart(i < hp ? '#ff4c5e' : '#333a4a');
  return out;
}

export class RouletteGame {
  private deps: RouletteDeps;
  private root: HTMLElement;
  private myName: string;
  private myUser = '';
  private peerName = '对方';
  private peerUser = '';
  private myRole: 1 | 2 = 1;
  private state: RzState | null = null;
  private publicState: RzPublic | null = null;
  private destroyed = false;
  private offMsg: (() => void) | null = null;
  private offClose: (() => void) | null = null;

  // 惩罚阶段
  private phase: 'playing' | 'punish' | 'won' | 'done' = 'playing';
  private ctlWaveform = 'random';
  private ctlIntensity = 0;
  private punishTimer: ReturnType<typeof setInterval> | null = null;
  private punishRounds = 0;
  private punishStartAt = 0;
  private punishEndsAt = 0;
  private surrenderClicks = 0;
  private resultReported = false;

  constructor(deps: RouletteDeps) {
    this.deps = deps;
    this.myName = deps.config.nickname || ensureNickname();
    this.myUser = getCurrentUser()?.username ?? '';
    this.myRole = deps.room.role === 2 ? 2 : 1;
    this.root = document.createElement('div');
    this.root.id = 'rz-root';
    bindStatic();
  }

  start(): void {
    active = this;
    const battleRoot = el('battle-root');
    el('battle-col').hidden = true;
    el('ready-overlay').hidden = true; // 轮盘无需准备阶段，人齐即开
    battleRoot.appendChild(this.root);
    this.buildDom();
    this.render();

    this.offMsg = this.deps.room.onMessage((msg) => {
      // 服务器销毁房间时双方收到 peerLeft 消息帧（连接并未断开），必须处理
      if (msg.t === 'peerLeft') {
        this.onPeerGone();
        return;
      }
      this.handle(msg);
    });
    this.offClose = this.deps.room.onClose(() => this.onPeerGone());
    initRoomChat(this.deps.room, (self) => (self ? this.myName : this.peerName));
    initVoice(this.deps.room, this.myRole);
    this.deps.room.send({ kind: 'hello', name: this.myName, user: this.myUser });
    // 房主初始化并广播状态；加入方等状态
    if (this.myRole === 1) {
      this.state = this.freshState(1);
      this.broadcastState();
    }
    el('danmaku-layer').innerHTML = '';
  }

  private freshState(round: number): RzState {
    const live = Math.min(this.deps.getGameConfig().maxLive, 1 + Math.floor(round / 2));
    const chamber = Array.from({ length: CHAMBER_SIZE }, (_, i) => i < live);
    // Fisher–Yates 洗牌
    for (let i = chamber.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [chamber[i], chamber[j]] = [chamber[j], chamber[i]];
    }
    const maxHp = this.deps.getGameConfig().maxHp;
    return { hp: [maxHp, maxHp], chamber, round, turn: 1, last: null, over: false };
  }

  private buildDom(): void {
    this.root.innerHTML = `
      <div class="rz-head">
        <div class="rz-player">
          <div class="rz-name">我方 · ${escapeHtml(this.myName)}</div>
          <div class="rz-hp" id="rz-hp-me"></div>
        </div>
        <div class="rz-round" id="rz-round"></div>
        <div class="rz-player rz-right">
          <div class="rz-name">对方 · <span id="rz-peer-name">对方</span></div>
          <div class="rz-hp" id="rz-hp-peer"></div>
        </div>
      </div>
      <div class="rz-table">
        <div class="rz-revolver" id="rz-revolver"></div>
        <div class="rz-status" id="rz-status">等待对方连接…</div>
        <div class="rz-actions" id="rz-actions">
          <button class="btn-gold btn-lg" id="rz-aim-self">对自己开枪</button>
          <button class="btn-red btn-lg" id="rz-aim-opp">对对方开枪</button>
        </div>
        <div class="rz-log" id="rz-log"></div>
      </div>`;
    this.root.querySelector('#rz-aim-self')!.addEventListener('click', () => this.aim('self'));
    this.root.querySelector('#rz-aim-opp')!.addEventListener('click', () => this.aim('opp'));
  }

  private handle(msg: RoomMessage): void {
    switch (msg.kind) {
      case 'hello':
        this.peerName = String(msg.name ?? '对方').slice(0, 12) || '对方';
        this.peerUser = String(msg.user ?? '').slice(0, 16);
        const pn = this.root.querySelector('#rz-peer-name');
        if (pn) pn.textContent = this.peerName;
        break;
      case 'rzAim':
        // 只有房主消费（加入方的开枪意图）
        if (this.myRole === 1 && this.state && this.state.turn === 2 && !this.state.over) {
          this.setStatus('扣动扳机…');
          this.deps.room.send({ kind: 'rzResolving' });
          const aim = msg.aim === 'opp' ? 'opp' : 'self';
          setTimeout(() => this.resolveAim(aim), RESOLVE_DELAY_MS);
        }
        break;
      case 'rzState':
        this.applyState(msg.state as RzPublic);
        break;
      case 'rzResolving':
        this.setStatus('扣动扳机…');
        break;
      case 'punishCtl':
        this.ctlWaveform = String(msg.waveform ?? 'random');
        this.ctlIntensity = Math.max(0, Number(msg.intensity) || 0);
        break;
      case 'danmaku':
        showDanmaku(String(msg.text ?? '').slice(0, 30));
        break;
      case 'punishStop':
        if (this.phase === 'punish') this.endPunishment('对方停止了惩罚');
        break;
      case 'surrender':
        if (this.phase === 'won') this.showVictoryEnd('对方已认输，惩罚结束');
        break;
    }
  }

  private aim(aim: 'self' | 'opp'): void {
    // 双方都依据公开状态判断回合（this.state 只有房主持有）
    const s = this.publicState;
    if (!s || s.over || this.phase !== 'playing' || s.turn !== this.myRole) return;
    this.setStatus('扣动扳机…');
    this.lockActions(true);
    if (this.myRole === 1) {
      // 房主是权威端：自己开枪直接本地揭晓，并通知对方「扣扳机中」
      this.deps.room.send({ kind: 'rzResolving' });
      setTimeout(() => this.resolveAim(aim), RESOLVE_DELAY_MS);
    } else {
      this.deps.room.send({ kind: 'rzAim', aim });
    }
  }

  /** 房主：延迟揭晓，制造悬念 */
  resolveAim(aim: 'self' | 'opp'): void {
    const s = this.state;
    if (!s || s.over) return;
    const shooter = s.turn;
    const live = s.chamber.shift() ?? false;
    if (aim === 'opp') {
      const victim: 1 | 2 = shooter === 1 ? 2 : 1;
      if (live) s.hp[victim - 1] = Math.max(0, s.hp[victim - 1] - 1);
      s.turn = victim;
    } else {
      if (live) {
        s.hp[shooter - 1] = Math.max(0, s.hp[shooter - 1] - 1);
        s.turn = shooter === 1 ? 2 : 1;
      }
      // 空弹对自己：保留回合
    }
    s.last = { shooter, aim, live };
    if (s.chamber.length === 0 && !s.over) {
      const next = this.freshState(s.round + 1);
      next.hp = [...s.hp];
      next.turn = s.turn;
      next.last = s.last;
      next.round = s.round + 1;
      this.state = next;
    }
    if (s.hp[0] <= 0 || s.hp[1] <= 0) s.over = true;
    this.broadcastState();
  }

  private broadcastState(): void {
    if (!this.state) return;
    const pub: RzPublic = {
      hp: [...this.state.hp],
      round: this.state.round,
      turn: this.state.turn,
      last: this.state.last,
      over: this.state.over,
      live: this.state.chamber.filter(Boolean).length,
      left: this.state.chamber.length,
    };
    this.deps.room.send({ kind: 'rzState', state: pub });
    this.applyState(pub);
  }

  private applyState(p: RzPublic): void {
    if (!p) return;
    this.publicState = p;
    // 开枪音效：实弹/空弹双方同步播放
    if (p.last) {
      playSfx(p.last.live ? 'shot' : 'empty');
    }
    // 中弹的是「我」→ 电我自己（各自控制各自设备）
    if (p.last?.live) {
      const victim: 1 | 2 = p.last.aim === 'self' ? p.last.shooter : p.last.shooter === 1 ? 2 : 1;
      if (victim === this.myRole && this.phase === 'playing') {
        this.deps.feedback.fire('baseHit');
      }
    }
    this.render();
    // 终局双方各自进入结算（延迟揭晓最后一枪）
    if (p.over && this.phase === 'playing') {
      this.lockActions(true);
      setTimeout(() => this.finishGame(), 1600);
    }
  }

  private render(): void {
    const s = this.publicState;
    if (!s) return;
    const meIdx = this.myRole - 1;
    const peerIdx = 1 - meIdx;
    const meHp = el(`rz-hp-me`);
    const peerHp = el(`rz-hp-peer`);
    if (meHp) meHp.innerHTML = hearts(s.hp[meIdx], this.deps.getGameConfig().maxHp);
    if (peerHp) peerHp.innerHTML = hearts(s.hp[peerIdx], this.deps.getGameConfig().maxHp);

    const rev = this.root.querySelector('#rz-revolver');
    if (rev) {
      // 弹位不标实弹：顺序是秘密，只有数量公开
      rev.innerHTML = `
        <div class="rz-chambers">${Array.from({ length: s.left }, (_, i) => `<span class="rz-chamber ${i === 0 ? 'next' : ''}"></span>`).join('')}</div>
        <div class="rz-live-badge">实弹 ${s.live} / ${s.left}</div>`;
    }

    const roundEl = this.root.querySelector('#rz-round');
    if (roundEl) roundEl.textContent = `第 ${s.round} 轮`;

    if (!s.over) {
      if (s.turn === this.myRole) {
        this.setStatus('轮到你：选择开枪目标（对自己空弹可保留回合）');
        this.lockActions(false);
      } else {
        this.setStatus(`${this.peerName} 思考中…`);
        this.lockActions(true);
      }
    }

    const log = this.root.querySelector('#rz-log');
    if (log && s.last) {
      const { shooter, aim, live } = s.last;
      const who = shooter === this.myRole ? '我方' : this.peerName;
      const text =
        aim === 'opp'
          ? `${who} 对${shooter === this.myRole ? this.peerName : '我方'}开枪 —— ${live ? '实弹！HP-1' : '咔哒，空弹'}`
          : `${who} 对自己开枪 —— ${live ? '实弹！HP-1' : '空弹，保留回合'}`;
      const line = document.createElement('div');
      line.className = 'rz-log-line';
      line.textContent = text;
      line.style.color = live ? '#ff4c5e' : '#8a93a6';
      log.prepend(line);
      while (log.children.length > 6) log.lastElementChild?.remove();
      s.last = null; // 只记一次
    }
  }

  private setStatus(text: string): void {
    const st = this.root.querySelector('#rz-status');
    if (st) st.textContent = text;
  }

  private lockActions(lock: boolean): void {
    const box = this.root.querySelector('#rz-actions');
    if (box) box.classList.toggle('locked', lock);
  }

  private finishGame(): void {
    const s = this.publicState;
    if (!s || this.destroyed || this.phase !== 'playing') return;
    const loserRole: 1 | 2 = s.hp[0] <= 0 ? 1 : 2;
    const iWon = loserRole !== this.myRole;
    if (iWon) this.reportResult(s);
    playSfx(iWon ? 'victory' : 'defeat');
    if (iWon) {
      this.phase = 'won';
      this.showVictory(s.hp[this.myRole - 1]);
    } else {
      this.phase = 'punish';
      this.startPunishment();
    }
  }

  // ===== 惩罚（与消消乐同一套交互） =====

  private startPunishment(): void {
    this.deps.feedback.fire('death');
    el('result-punish').hidden = false;
    this.punishStartAt = performance.now();
    this.surrenderClicks = 0;
    this.punishEndsAt = performance.now() + this.deps.getSettings().punishMaxSec * 1000;
    this.runPunishRound();
    this.punishTimer = setInterval(() => this.runPunishRound(), this.deps.getSettings().punishStepSec * 1000);
    const leftTimer = setInterval(() => {
      if (this.phase !== 'punish' || el('result-punish').hidden) {
        clearInterval(leftTimer);
        return;
      }
      el('punish-left').textContent = String(Math.max(0, Math.ceil((this.punishEndsAt - performance.now()) / 1000)));
    }, 500);
  }

  private runPunishRound(): void {
    if (performance.now() >= this.punishEndsAt) {
      this.endPunishment('惩罚时间到，自动结束');
      return;
    }
    const s = this.deps.getSettings();
    this.punishRounds += 1;
    const key = this.ctlWaveform === 'random' ? String(s.punishWaveforms[Math.floor(Math.random() * s.punishWaveforms.length)]) : this.ctlWaveform;
    let raw: number;
    if (this.ctlIntensity > 0) {
      raw = this.ctlIntensity;
    } else {
      raw = s.punishIntensityMin + Math.floor(Math.random() * (Math.max(s.punishIntensityMin, s.punishIntensityMax) - s.punishIntensityMin + 1));
    }
    raw = Math.min(raw, s.punishIntensityMax);
    this.deps.feedback.punishPulse(key, raw);
    el('punish-round').textContent = String(this.punishRounds);
    el('punish-power').textContent = String(raw);
    this.deps.room.send({ kind: 'punishRound', n: this.punishRounds, power: raw });
  }

  private endPunishment(infoText: string): void {
    if (this.punishTimer) {
      clearInterval(this.punishTimer);
      this.punishTimer = null;
    }
    this.deps.feedback.stopPunishment();
    this.phase = 'done';
    el('result-punish').hidden = true;
    el('punish-end-info').textContent = infoText;
    el('btn-rematch-l').hidden = true; // 轮盘暂不支持再来一局
    el('result-punish-end').hidden = false;
    this.deps.room.send({ kind: 'punishEnd' });
  }

  surrender(): void {
    if (this.phase !== 'punish') return;
    const left = 10000 - (performance.now() - this.punishStartAt);
    if (left > 0) {
      this.surrenderClicks++;
      const toast = el('battle-toast');
      toast.textContent = this.surrenderClicks >= 3 ? '轻点轻点～惩罚至少 10 秒，这是规矩' : `才 ${Math.ceil((performance.now() - this.punishStartAt) / 1000)} 秒，再坚持 ${Math.ceil(left / 1000)} 秒`;
      toast.hidden = false;
      setTimeout(() => {
        toast.hidden = true;
      }, 2000);
      return;
    }
    this.deps.feedback.stopPunishment();
    if (this.punishTimer) {
      clearInterval(this.punishTimer);
      this.punishTimer = null;
    }
    this.phase = 'done';
    el('result-punish').hidden = true;
    el('punish-end-info').textContent = '已认输，惩罚结束';
    el('btn-rematch-l').hidden = true;
    el('result-punish-end').hidden = false;
    this.deps.room.send({ kind: 'surrender' });
  }

  private showVictory(myHp: number): void {
    el('result-victory').hidden = false;
    el('victory-info').textContent = `${this.peerName} 战败，惩罚进行中…`;

    const box = el('punish-wave-chips');
    box.dataset.current = 'random';
    box.innerHTML =
      `<button type="button" class="chip active" data-key="random">随机（对方惩罚池）</button>` +
      COYOTE_WAVEFORM_OPTIONS.map((o) => `<button type="button" class="chip" data-key="${o.key}">${o.label}</button>`).join('');
    const range = el('punish-intensity', HTMLInputElement);
    range.max = String(Math.max(1, this.deps.getSettings().punishIntensityMax));
    range.value = '0';
    el('punish-intensity-val').textContent = '自动';

    el('victory-controls').hidden = false;
    el('victory-actions-punish').hidden = false;
    el('victory-actions-end').hidden = true;
    void showTrophy(this.peerUser || this.peerName, this.peerName);
  }

  private showVictoryEnd(text: string): void {
    this.phase = 'done';
    el('victory-info').textContent = text;
    el('victory-controls').hidden = true;
    el('victory-actions-punish').hidden = true;
    el('btn-rematch-v').hidden = true;
    el('victory-actions-end').hidden = false;
    hideTrophy();
  }

  stopPunishmentAsWinner(): void {
    if (this.phase !== 'won' || el('result-victory').hidden) return;
    this.deps.room.send({ kind: 'punishStop' });
    this.showVictoryEnd('你已停止惩罚，对方解脱了');
  }

  sendPunishCtl(): void {
    if (this.phase !== 'won') return;
    this.deps.room.send({
      kind: 'punishCtl',
      waveform: el('punish-wave-chips').dataset.current || 'random',
      intensity: Number(el('punish-intensity', HTMLInputElement).value) || 0,
    });
  }

  sendDanmaku(text: string): void {
    if (this.phase !== 'punish' && this.phase !== 'won') return;
    showDanmaku(text);
    this.deps.room.send({ kind: 'danmaku', text });
  }

  // ===== 生命周期 =====

  private reportResult(s: RzPublic): void {
    if (this.resultReported) return;
    this.resultReported = true;
    this.deps.room.reportResult('roulette', this.myName, this.peerName, s.hp[this.myRole - 1], s.hp[this.myRole === 1 ? 1 : 0]);
  }

  private onPeerGone(): void {
    if (this.destroyed || this.phase === 'done') return;
    const toast = el('battle-toast');
    toast.textContent = '对方已断开，返回标题';
    toast.hidden = false;
    setTimeout(() => this.exit(), 1800);
  }

  exit(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.destroy();
    this.deps.onExit();
  }

  destroy(): void {
    this.destroyed = true;
    if (this.punishTimer) clearInterval(this.punishTimer);
    this.deps.feedback.stopPunishment();
    this.offMsg?.();
    this.offClose?.();
    this.root.remove();
    el('battle-col').hidden = false;
    hideTrophy();
    destroyRoomChat();
    destroyVoice();
    for (const id of ['result-punish', 'result-punish-end', 'result-victory']) el(id).hidden = true;
    el('btn-rematch-l').hidden = false;
    el('btn-rematch-v').hidden = false;
    el('danmaku-layer').innerHTML = '';
    if (active === this) active = null;
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}
