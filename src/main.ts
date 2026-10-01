import './style.css';
import { DGLAB_SOCKET_STATE } from 'dglab-kit';
import { DeviceManager } from './devices/device-manager';
import { FeedbackEngine } from './devices/feedback-engine';
import { installSafetyNet, emergencyStop } from './devices/safety';
import { Game } from './game/game';
import { GemBattle } from './game/gem-battle';
import { Input } from './game/input';
import { RoomClient } from './net/room-client';
import { BattleLobby } from './ui/battle-lobby';
import { buildHelpContent } from './ui/help-panel';
import { hideModal, setupModals, showModal } from './ui/modal';
import { PairingScreen } from './ui/pairing-screen';
import { ProfilePanel } from './ui/profile-panel';
import { SettingsPanel } from './ui/settings-panel';
import { ensureNickname } from './profile';

ensureNickname(); // 首次进入自动生成临时昵称，档案页可改

const dm = new DeviceManager();
let battle: GemBattle | null = null;

// 设置面板（feedback 测试按钮需要引用，先声明后赋值）
const settingsHost = document.getElementById('settings-body') as HTMLElement;
let panel: SettingsPanel;
const feedback = new FeedbackEngine(dm, () => panel.getSettingsRef());
panel = new SettingsPanel(settingsHost, feedback);

// 各弹窗
const devicesModal = document.getElementById('modal-devices') as HTMLElement;
const settingsModal = document.getElementById('modal-settings') as HTMLElement;
const helpModal = document.getElementById('modal-help') as HTMLElement;
const profileModal = document.getElementById('modal-profile') as HTMLElement;

setupModals();
new PairingScreen(document.getElementById('devices-body') as HTMLElement, dm);
buildHelpContent(document.getElementById('help-body') as HTMLElement);
new ProfilePanel(document.getElementById('profile-body') as HTMLElement);

// 顶栏导航
const openDevices = () => {
  showModal(devicesModal);
  // 连接已失效或从未连接时，打开弹窗即刷新一个全新的二维码
  // （V4 中继对控制方有 5 分钟空闲超时，旧二维码可能已失效）
  const s = dm.state;
  if (s !== DGLAB_SOCKET_STATE.Paired && s !== DGLAB_SOCKET_STATE.Connecting && s !== DGLAB_SOCKET_STATE.WaitingForPeer) {
    void dm.connect().catch(() => undefined);
  }
};
document.getElementById('nav-devices')!.addEventListener('click', openDevices);
document.getElementById('nav-settings')!.addEventListener('click', () => showModal(settingsModal));
document.getElementById('nav-help')!.addEventListener('click', () => showModal(helpModal));
document.getElementById('nav-profile')!.addEventListener('click', () => showModal(profileModal));
document.getElementById('btn-conn')!.addEventListener('click', openDevices);

const eStopBtn = document.getElementById('btn-e-stop') as HTMLButtonElement;
eStopBtn.addEventListener('click', async () => {
  await emergencyStop(dm);
  const original = eStopBtn.textContent;
  eStopBtn.textContent = '✓';
  setTimeout(() => {
    eStopBtn.textContent = original;
  }, 1200);
});

// 顶栏连接状态
const connDot = document.querySelector<HTMLElement>('#conn-pill .dot')!;
const connText = document.getElementById('conn-text')!;
const btnConn = document.getElementById('btn-conn') as HTMLButtonElement;

dm.subscribe(() => {
  switch (dm.state) {
    case DGLAB_SOCKET_STATE.Paired:
      connDot.className = 'dot on';
      connText.textContent = 'V4 已连接';
      btnConn.textContent = '设 备';
      break;
    case DGLAB_SOCKET_STATE.Connecting:
    case DGLAB_SOCKET_STATE.WaitingForPeer:
      connDot.className = 'dot warn';
      connText.textContent = '等待扫码…';
      btnConn.textContent = '连 接';
      break;
    case DGLAB_SOCKET_STATE.Disconnected:
      connDot.className = 'dot err';
      connText.textContent = '已断开';
      btnConn.textContent = '重 连';
      break;
    default:
      connDot.className = 'dot';
      connText.textContent = 'V4 未连接';
      btnConn.textContent = '连 接';
  }
});

installSafetyNet(dm);

const canvas = document.getElementById('game') as HTMLCanvasElement;
const input = new Input(window);
const game = new Game(canvas, input, {
  feedback,
  getSettings: () => panel.getSettingsRef(),
  getPressure: () => dm.getPressure(),
  submitScore: (score) => {
    const nick = ensureNickname();
    if (roomClient.connected) roomClient.reportScore('bullet', nick, score);
  },
});
game.start();

// ===== 屏幕控制按钮 =====
const btnStart = document.getElementById('btn-start') as HTMLButtonElement;
const btnPause = document.getElementById('btn-pause') as HTMLButtonElement;
const btnBomb = document.getElementById('btn-bomb') as HTMLButtonElement;
const btnBoard = document.getElementById('btn-board') as HTMLButtonElement;
const boardModal = document.getElementById('modal-board') as HTMLElement;

btnBoard.addEventListener('click', () => {
  showModal(boardModal);
  void renderBoard('bullet');
});

document.getElementById('board-tab-bullet')!.addEventListener('click', () => void renderBoard('bullet'));
document.getElementById('board-tab-versus')!.addEventListener('click', () => void renderBoard('versus'));

async function renderBoard(game: 'bullet' | 'versus' = 'bullet'): Promise<void> {
  // Tab 高亮
  document.getElementById('board-tab-bullet')?.classList.toggle('active', game === 'bullet');
  document.getElementById('board-tab-versus')?.classList.toggle('active', game === 'versus');

  const listEl = document.getElementById('board-list')!;
  const hintEl = document.getElementById('board-hint')!;
  listEl.innerHTML = '<div class="hint" style="text-align:center;padding:14px">加载中…</div>';
  hintEl.textContent = '';

  const rows = await fetchBoard(game);
  hintEl.textContent = rows.length > 0 ? `显示前 ${rows.length} 名 · 全服记录` : '';
  const head =
    game === 'bullet'
      ? `<div class="board-row board-head"><span class="board-rank">#</span><span class="board-name">昵称</span><span class="board-num">最高分</span><span class="board-num">场次</span></div>`
      : `<div class="board-row board-head"><span class="board-rank">#</span><span class="board-name">昵称</span><span class="board-num">胜 / 负</span><span class="board-num">胜率</span></div>`;
  listEl.innerHTML =
    head +
    (rows.length
      ? rows
          .map((r, i) =>
            game === 'bullet'
              ? `<div class="board-row">
                  <span class="board-rank">${i + 1}</span>
                  <span class="board-name">${escapeHtml(r.name)}</span>
                  <span class="board-num" style="color:var(--gold)">${r.best}</span>
                  <span class="board-num">${r.games}</span>
                </div>`
              : `<div class="board-row">
                  <span class="board-rank">${i + 1}</span>
                  <span class="board-name">${escapeHtml(r.name)}</span>
                  <span class="board-num">${r.wins} / ${r.losses}</span>
                  <span class="board-num" style="color:var(--gold)">${r.rate}%</span>
                </div>`,
          )
          .join('')
      : '<div class="hint" style="text-align:center;padding:14px">暂无记录，来打第一局</div>');
}

async function fetchBoard(game: 'bullet' | 'versus'): Promise<{ name: string; wins: number; losses: number; rate: number; best: number; games: number }[]> {
  try {
    if (!roomClient.connected) {
      const last = localStorage.getItem('dg-battle-server-url');
      if (last) await roomClient.connect(last);
    }
    return await roomClient.requestBoard(game);
  } catch {
    return [];
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

btnStart.addEventListener('click', () => game.startGame());
btnPause.addEventListener('click', () => game.togglePause());
btnBomb.addEventListener('click', () => game.pressBomb());

function syncControls(): void {
  if (battle !== null) {
    btnStart.hidden = true;
    btnPause.hidden = true;
    btnBomb.hidden = true;
    btnBoard.hidden = true;
    return;
  }
  const state = game.getState();
  btnStart.hidden = !(state === 'title' || state === 'over');
  btnBoard.hidden = !(state === 'title' || state === 'over');
  btnPause.hidden = !(state === 'playing' || state === 'paused');
  btnPause.textContent = state === 'paused' ? '继续' : '暂停';
  btnBomb.hidden = state !== 'playing';
  btnBomb.textContent = `炸弹 ×${game.getBombs()}`;
}

game.onStateChange(syncControls);

// 炸弹数量每秒刷新一次（HUD 同步）
setInterval(syncControls, 1000);
syncControls();

// ===== 宝石对战模式 =====
const btnVersus = document.getElementById('btn-versus') as HTMLButtonElement;
const battleModal = document.getElementById('modal-battle') as HTMLElement;
const battleRoot = document.getElementById('battle-root') as HTMLElement;
const roomClient = new RoomClient();

function syncVersusButton(): void {
  btnVersus.hidden = battle !== null || game.getState() !== 'title';
}
game.onStateChange(syncVersusButton);
syncVersusButton();

btnVersus.addEventListener('click', () => {
  battleLobby.refresh();
  showModal(battleModal);
});

const battleLobby = new BattleLobby(document.getElementById('battle-lobby-body') as HTMLElement, roomClient, (config) => {
  hideModal(battleModal);
  battleRoot.hidden = false;
  canvas.style.visibility = 'hidden'; // 防止单机标题画面文字从棋盘边缘透出
  game.suspend();
  syncVersusButton();
  battle = new GemBattle({
    feedback,
    room: roomClient,
    dm,
    getSettings: () => panel.getSettingsRef(),
    config,
    onExit: () => {
      battle?.destroy();
      battle = null;
      battleRoot.hidden = true;
      canvas.style.visibility = 'visible';
      roomClient.close();
      game.resume();
      game.exitToTitle();
      syncVersusButton();
      syncControls();
    },
  });
  battle.start();
  syncControls();
  syncVersusButton();
});

// 页面加载即自动连接中继，二维码随时就绪
void dm.connect().catch(() => undefined);
// 异常断开（如 5 分钟空闲超时被服务器踢掉）后 3 秒自动重连；
// 用户在设备面板手动断开时状态为 Idle，不会触发重连
setInterval(() => {
  if (dm.state === DGLAB_SOCKET_STATE.Disconnected) {
    void dm.connect().catch(() => undefined);
  }
}, 3000);
