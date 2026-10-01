import type { RoomClient } from '../net/room-client';
import { BOARD_SIZES, type BoardSize } from '../game/gem-battle';
import { ensureNickname, getNickname, setNickname } from '../profile';

const SERVER_KEY = 'dg-battle-server-url';
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
    const lastServer = defaultServerUrl(localStorage.getItem(SERVER_KEY) ?? '');
    const lastNick = getNickname();
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

      <div class="lobby-divider"></div>

      <div class="lobby-block">
        <button class="btn-gold btn-lg" id="lobby-create" style="width:100%">创建房间</button>
        <div class="lobby-code" id="lobby-code" hidden></div>
        <div class="lobby-status" id="lobby-status">先连接服务器</div>
      </div>

      <div class="lobby-divider"></div>

      <div class="lobby-block">
        <div class="row" style="margin:0">
          <input type="text" id="lobby-code-input" placeholder="输入 4 位房间码加入" maxlength="4"
            style="flex:1; text-transform:uppercase; letter-spacing:6px; text-align:center" />
          <button class="btn btn-lg" id="lobby-join">加入房间</button>
        </div>
      </div>
    `;

    this.root.querySelector<HTMLButtonElement>('#lobby-create')!.addEventListener('click', () => this.create());
    this.root.querySelector<HTMLButtonElement>('#lobby-join')!.addEventListener('click', () => this.join());
  }

  /** 弹窗每次打开时调用：档案页可能刚改过昵称，同步到大厅输入框 */
  refresh(): void {
    const input = this.root.querySelector<HTMLInputElement>('#lobby-nick');
    if (input) input.value = getNickname();
  }

  private status(text: string): void {
    const el = this.root.querySelector<HTMLElement>('#lobby-status');
    if (el) el.textContent = text;
  }

  private getConfig(): LobbyConfig {
    const nick = this.root.querySelector<HTMLInputElement>('#lobby-nick')!.value.trim() || ensureNickname();
    const target = Number(this.root.querySelector<HTMLSelectElement>('#lobby-target')!.value) || 5000;
    const boardSize = (this.root.querySelector<HTMLSelectElement>('#lobby-board-size')!.value || '8x8') as BoardSize;
    setNickname(nick);
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

}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/** 已记忆的地址优先；HTTPS 部署时默认与页面同域的 /ws 反代，零配置直接玩；本地开发留空手动填 */
function defaultServerUrl(saved: string): string {
  if (saved) return saved;
  if (location.protocol === 'https:') return `wss://${location.host}/dgws`;
  return '';
}
