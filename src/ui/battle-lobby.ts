import type { RoomClient } from '../net/room-client';
import { BOARD_SIZES, type BoardSize } from '../game/gem-battle';
import { ensureNickname, getNickname, setNickname } from '../profile';
import { getToken } from '../account';

const SERVER_KEY = 'dg-battle-server-url';
const TARGET_KEY = 'dg-battle-target';
const BOARD_KEY = 'dg-battle-board';

/**
 * 自建部署的服务器地址：在代码里填好即可（我们不再提供公共服务器；
 * 从 GitHub clone 的用户自行修改本行后构建部署）。
 * 留空则按环境默认：https 部署走同域 /dgws 反代，本地开发走 ws://localhost:8787。
 */
const SERVER_URL = '';

export interface LobbyConfig {
  nickname: string;
  game: 'versus' | 'roulette';
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
  /** 游戏由多人卡片入口决定（setGame 预置），大厅内不再切换 */
  private game: 'versus' | 'roulette' = 'versus';

  constructor(container: HTMLElement, room: RoomClient, onStart: (config: LobbyConfig) => void) {
    this.root = container;
    this.room = room;
    this.onStart = onStart;
    this.build();
  }

  private build(): void {
    const lastNick = getNickname();
    const lastTarget = localStorage.getItem(TARGET_KEY) ?? '5000';
    const lastBoard = (localStorage.getItem(BOARD_KEY) ?? '8x8') as BoardSize;
    this.root.innerHTML = `
      <div class="sec">对战大厅</div>
      <div class="sec-note" id="lobby-note">消除自动触发效果，先达到目标分者胜；败者接受惩罚。</div>
      <div class="row">
        <label>昵称</label>
        <input type="text" id="lobby-nick" class="lobby-lg" placeholder="排行榜显示名" maxlength="12" value="${escapeHtml(lastNick)}" />
      </div>
      <div class="row" id="lobby-target-row">
        <label>目标分</label>
        <select id="lobby-target" class="lobby-lg" style="flex:1">
          ${['2000', '3000', '5000', '8000', '12000']
            .map((v) => `<option value="${v}" ${v === lastTarget ? 'selected' : ''}>${v} 分</option>`)
            .join('')}
        </select>
      </div>
      <div class="row" id="lobby-board-row">
        <label>棋盘</label>
        <select id="lobby-board-size" class="lobby-lg" style="flex:1">
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

      <div class="lobby-divider"></div>

      <div class="lobby-block">
        <button class="btn-gold btn-lg" id="lobby-match" style="width:100%">随机匹配</button>
        <div class="lobby-status" id="lobby-online">连接服务器后显示在线人数</div>
      </div>
    `;

    this.root.querySelector<HTMLButtonElement>('#lobby-create')!.addEventListener('click', () => this.create());
    this.root.querySelector<HTMLButtonElement>('#lobby-join')!.addEventListener('click', () => this.join());
    this.root.querySelector<HTMLButtonElement>('#lobby-match')!.addEventListener('click', () => {
      if (this.matching) this.room.cancelMatch();
      else void this.match();
    });

    // 服务器广播在线人数
    this.room.onMessage((msg) => {
      if (msg.t !== 'online') return;
      this.onlineCount = Number(msg.count) || 0;
      const el = this.root.querySelector<HTMLElement>('#lobby-online');
      if (el && !this.matching) el.textContent = `当前在线 ${this.onlineCount} 人 · 随机匹配一名对手开战`;
    });
  }

  private onlineCount = 0;
  private matching = false;

  private setMatching(on: boolean): void {
    this.matching = on;
    const btn = this.root.querySelector<HTMLButtonElement>('#lobby-match')!;
    btn.textContent = on ? '取消匹配' : '随机匹配';
    const online = this.root.querySelector<HTMLElement>('#lobby-online');
    if (online) online.textContent = on ? '匹配中…（再次点击取消）' : `当前在线 ${this.onlineCount} 人 · 随机匹配一名对手开战`;
  }

  /** 随机匹配：进队列 → 服务器凑齐两人自动建房 → 与加入房间一样开局 */
  private async match(): Promise<void> {
    if (this.busy) return;
    if (!(await this.ensureConnected())) return;
    this.busy = true;
    this.setMatching(true);
    try {
      const matchedGame = await this.room.matchmake(this.matchGame);
      this.setMatching(false);
      this.status('匹配成功，开局！');
      this.onStart(this.getConfig(matchedGame));
    } catch (err) {
      this.setMatching(false);
      this.status(err instanceof Error ? err.message : String(err));
    } finally {
      this.busy = false;
    }
  }

  /** 弹窗每次打开时调用：档案页可能刚改过昵称，同步到大厅输入框 */
  refresh(): void {
    const input = this.root.querySelector<HTMLInputElement>('#lobby-nick');
    if (input) input.value = getNickname();
    if (this.room.connected) this.room.hello(getNickname());
  }

  /** 从多人卡片进入时预选好游戏（大厅内不再切换） */
  setGame(game: 'versus' | 'roulette'): void {
    this.game = game;
    const note = this.root.querySelector<HTMLElement>('#lobby-note');
    if (note) {
      note.textContent =
        game === 'roulette'
          ? '俄罗斯轮盘：实弹数量公开、顺序保密；对自己开枪空弹赚回合，HP 先归零者受罚。'
          : '消除自动触发效果，先达到目标分者胜；败者接受惩罚。';
    }
    this.syncGameRows();
  }

  /** 随机匹配使用的游戏：'any' 不限（默认），匹配成功后以服务器结果为准 */
  private matchGame: 'any' | 'versus' | 'roulette' = 'any';

  /** 社交页/多人页匹配入口：打开大厅展示进度并自动开始匹配 */
  quickMatch(game: 'any' | 'versus' | 'roulette'): void {
    this.matchGame = game;
    this.refresh();
    void this.match();
  }

  private status(text: string): void {
    const el = this.root.querySelector<HTMLElement>('#lobby-status');
    if (el) el.textContent = text;
  }

  private getConfig(gameOverride?: 'versus' | 'roulette'): LobbyConfig {
    const nick = this.root.querySelector<HTMLInputElement>('#lobby-nick')!.value.trim() || ensureNickname();
    const target = Number(this.root.querySelector<HTMLSelectElement>('#lobby-target')!.value) || 5000;
    const boardSize = (this.root.querySelector<HTMLSelectElement>('#lobby-board-size')!.value || '8x8') as BoardSize;
    setNickname(nick);
    localStorage.setItem(TARGET_KEY, String(target));
    localStorage.setItem(BOARD_KEY, boardSize);
    return { nickname: nick, game: gameOverride ?? this.game, targetScore: target, boardSize };
  }

  private currentGame(): 'versus' | 'roulette' {
    return this.game;
  }

  /** 轮盘没有目标分/棋盘概念，按所选游戏显隐对应行 */
  private syncGameRows(): void {
    const roulette = this.game === 'roulette';
    const targetRow = this.root.querySelector<HTMLElement>('#lobby-target-row');
    const boardRow = this.root.querySelector<HTMLElement>('#lobby-board-row');
    if (targetRow) targetRow.hidden = roulette;
    if (boardRow) boardRow.hidden = roulette;
  }

  private async ensureConnected(): Promise<boolean> {
    if (this.room.connected) return true;
    // 服务器地址优先级：代码常量 SERVER_URL > 已记忆的连接 > 环境默认
    const url = SERVER_URL || localStorage.getItem(SERVER_KEY) || defaultServerUrl('');
    if (!url) {
      this.status('未配置服务器地址（自部署请在 battle-lobby.ts 顶部填写 SERVER_URL）');
      return false;
    }
    this.status('连接服务器中…');
    try {
      await this.room.connect(url, getToken());
      localStorage.setItem(SERVER_KEY, url);
      this.room.hello(getNickname());
      this.status('已连接，创建房间、输入房间码或随机匹配');
      return true;
    } catch {
      this.status('无法连接对战服务器 —— 本地测试请先运行 npm run server（或用 npm run dev 一并启动）');
      return false;
    }
  }

  /** 社交页「随机匹配」入口（已合并进 quickMatch） */
  autoMatch(): void {
    void this.match();
  }

  private async create(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      if (!(await this.ensureConnected())) return;
      this.status('创建房间…');
      const code = await this.room.createRoom(this.currentGame());
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
