import type { RoomClient } from '../net/room-client';
import { BOARD_SIZES, type BoardSize } from '../game/gem-battle';

const SERVER_KEY = 'dg-battle-server-url';
const NICK_KEY = 'dg-battle-nickname';
const TARGET_KEY = 'dg-battle-target';
const BOARD_KEY = 'dg-battle-board';

export interface LobbyConfig {
  nickname: string;
  targetScore: number;
  boardSize: import('../game/gem-battle').BoardSize;
}

/**
 * 对战大厅弹窗：连服务器 → 填昵称/目标分 → 创建房间/加入 → 双方就位自动开局。
 * onStart 回调里由 main.ts 启动 GemBattle。
 */
export class BattleLobby {
  private root: HTMLElement;
  private room: RoomClient;
  private onStart: (config: LobbyConfig) => void;
  private busy = false;

  constructor(container: HTMLElement, room: RoomClient, onStart: (config: LobbyConfig) => void) {
    this.root = container;
    this.room = room;
    this.onStart = onStart;
    this.build();
  }

  private build(): void {
    const lastServer = localStorage.getItem(SERVER_KEY) ?? '';
    const lastNick = localStorage.getItem(NICK_KEY) ?? '';
    const lastTarget = localStorage.getItem(TARGET_KEY) ?? '5000';
    const lastBoard = (localStorage.getItem(BOARD_KEY) ?? '8x8') as BoardSize;
    this.root.innerHTML = `
      <div class="sec">对战大厅</div>
      <div class="sec-note">消除自动触发效果，先达到目标分者胜；败者接受惩罚。</div>
      <div class="row">
        <label>昵称</label>
        <input type="text" id="lobby-nick" placeholder="排行榜显示名" maxlength="12" value="${escapeHtml(lastNick)}" />
      </div>
      <div class="row">
        <label>服务器</label>
        <input type="text" id="lobby-server" placeholder="ws://localhost:8787" value="${escapeHtml(lastServer)}" />
      </div>
      <div class="row">
        <label>目标分</label>
        <select id="lobby-target" style="flex:1">
          ${['2000', '3000', '5000', '8000', '12000']
            .map((v) => `<option value="${v}" ${v === lastTarget ? 'selected' : ''}>${v} 分</option>`)
            .join('')}
        </select>
      </div>
      <div class="row">
        <label>棋盘</label>
        <select id="lobby-board-size" style="flex:1">
          ${BOARD_SIZES.map(
            (b) => `<option value="${b.key}" ${b.key === lastBoard ? 'selected' : ''}>${b.label}</option>`,
          ).join('')}
        </select>
      </div>
      <div class="row" style="justify-content:center; gap:12px">
        <button class="btn-gold" id="lobby-create">创建房间</button>
        <span style="color:var(--dim)">或</span>
        <input type="text" id="lobby-code-input" placeholder="房间码" maxlength="4"
          style="width:90px; text-transform:uppercase; letter-spacing:4px; text-align:center" />
        <button class="btn" id="lobby-join">加 入</button>
      </div>
      <div class="lobby-code" id="lobby-code" hidden></div>
      <div class="lobby-status" id="lobby-status">先连接服务器</div>
      <div class="row" style="justify-content:center">
        <button class="btn" id="lobby-board">查看排行榜</button>
      </div>
      <div id="lobby-board-list"></div>
    `;

    this.root.querySelector<HTMLButtonElement>('#lobby-create')!.addEventListener('click', () => this.create());
    this.root.querySelector<HTMLButtonElement>('#lobby-join')!.addEventListener('click', () => this.join());
    this.root.querySelector<HTMLButtonElement>('#lobby-board')!.addEventListener('click', () => this.showBoard());
  }

  private status(text: string): void {
    const el = this.root.querySelector<HTMLElement>('#lobby-status');
    if (el) el.textContent = text;
  }

  private getConfig(): LobbyConfig {
    const nick = this.root.querySelector<HTMLInputElement>('#lobby-nick')!.value.trim() || '无名';
    const target = Number(this.root.querySelector<HTMLSelectElement>('#lobby-target')!.value) || 5000;
    const boardSize = (this.root.querySelector<HTMLSelectElement>('#lobby-board-size')!.value || '8x8') as BoardSize;
    localStorage.setItem(NICK_KEY, nick);
    localStorage.setItem(TARGET_KEY, String(target));
    localStorage.setItem(BOARD_KEY, boardSize);
    return { nickname: nick, targetScore: target, boardSize };
  }

  private async ensureConnected(): Promise<boolean> {
    if (this.room.connected) return true;
    const input = this.root.querySelector<HTMLInputElement>('#lobby-server')!;
    const url = input.value.trim();
    if (!url) {
      this.status('请填写服务器地址（本地测试用 ws://localhost:8787）');
      return false;
    }
    this.status('连接服务器中…');
    try {
      await this.room.connect(url);
      localStorage.setItem(SERVER_KEY, url);
      this.status('已连接，创建房间或输入房间码');
      return true;
    } catch {
      this.status('无法连接对战服务器 —— 本地测试请先运行 npm run server（或用 npm run dev 一并启动）');
      return false;
    }
  }

  private async create(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      if (!(await this.ensureConnected())) return;
      this.status('创建房间…');
      const code = await this.room.createRoom();
      const codeEl = this.root.querySelector<HTMLElement>('#lobby-code')!;
      codeEl.hidden = false;
      codeEl.textContent = code;
      this.status('房间已创建，等待对方加入…');
      await this.room.waitStart();
      this.status('对方已加入，开局！');
      this.onStart(this.getConfig());
    } catch (err) {
      this.status(err instanceof Error ? err.message : String(err));
    } finally {
      this.busy = false;
    }
  }

  private async join(): Promise<void> {
    if (this.busy) return;
    const code = this.root.querySelector<HTMLInputElement>('#lobby-code-input')!.value.trim().toUpperCase();
    if (code.length !== 4) {
      this.status('请输入 4 位房间码');
      return;
    }
    this.busy = true;
    try {
      if (!(await this.ensureConnected())) return;
      this.status('加入房间…');
      await this.room.joinRoom(code);
      this.status('加入成功，开局！');
      this.onStart(this.getConfig());
    } catch (err) {
      this.status(err instanceof Error ? err.message : String(err));
    } finally {
      this.busy = false;
    }
  }

  private async showBoard(): Promise<void> {
    if (!(await this.ensureConnected())) return;
    const listEl = this.root.querySelector<HTMLElement>('#lobby-board-list')!;
    listEl.innerHTML = '<div class="hint" style="text-align:center">加载中…</div>';
    try {
      const board = await this.room.requestBoard();
      if (board.length === 0) {
        listEl.innerHTML = '<div class="hint" style="text-align:center">暂无战绩，快来打第一局！</div>';
        return;
      }
      listEl.innerHTML =
        `<div class="board-table">` +
        board
          .map(
            (r, i) => `<div class="board-row">
              <span class="board-rank">${i + 1}</span>
              <span class="board-name">${escapeHtml(r.name)}</span>
              <span class="board-num">${r.wins}胜 ${r.losses}负</span>
              <span class="board-num" style="color:var(--gold)">胜率 ${r.rate}%</span>
            </div>`,
          )
          .join('') +
        `</div>`;
    } catch {
      listEl.innerHTML = '<div class="hint" style="text-align:center">排行榜加载失败</div>';
    }
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}
