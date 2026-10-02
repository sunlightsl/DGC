import './style.css';
import { DGLAB_SOCKET_STATE } from 'dglab-kit';
import { DeviceManager } from './devices/device-manager';
import { FeedbackEngine } from './devices/feedback-engine';
import { installSafetyNet, emergencyStop } from './devices/safety';
import { Game } from './game/game';
import { GemBattle } from './game/gem-battle';
import { RouletteGame } from './game/roulette';
import { Input } from './game/input';
import { RoomClient } from './net/room-client';
import { BattleLobby } from './ui/battle-lobby';
import { buildHelpContent } from './ui/help-panel';
import { hideModal, setupModals, showModal } from './ui/modal';
import { hidePages, goBack, initPages, openSelfProfile, portalConnect, renderHallWall, showPages, updatePresence, updateSocialOnline } from './ui/pages';
import { ensureIntro } from './ui/game-intro';
import { initAccountUi, onLoginChange, openAuth, refreshAccountEntry } from './ui/auth-panel';
import { initLobbyChat, setLobbyChatVisible } from './ui/lobby-chat';
import { renderGameSettings } from './ui/game-settings-panel';
import { loadGameSettings, BULLET_DEFAULTS, VERSUS_DEFAULTS, ROULETTE_DEFAULTS } from './game-settings';
import { configureSfx, playSfx } from './audio/sfx';
import { PairingScreen } from './ui/pairing-screen';
import { SettingsPanel } from './ui/settings-panel';
import { displayName, getCurrentUser, getToken, isLoggedIn, logoutLocal, validateSession } from './account';
import { ensureNickname } from './profile';

ensureNickname(); // 首次进入自动生成临时昵称，档案页可改

const dm = new DeviceManager();
let battle: GemBattle | RouletteGame | null = null;

// 设置面板（feedback 测试按钮需要引用，先声明后赋值）
const settingsHost = document.getElementById('settings-body') as HTMLElement;
let panel: SettingsPanel;
const feedback = new FeedbackEngine(dm, () => panel.getSettingsRef());
panel = new SettingsPanel(settingsHost, feedback);

// 各弹窗
const devicesModal = document.getElementById('modal-devices') as HTMLElement;
const settingsModal = document.getElementById('modal-settings') as HTMLElement;
const helpModal = document.getElementById('modal-help') as HTMLElement;

setupModals();
new PairingScreen(document.getElementById('devices-body') as HTMLElement, dm);
buildHelpContent(document.getElementById('help-body') as HTMLElement);
initAccountUi();
void validateSession().then((ok) => {
  // 令牌仍有效则同步昵称与顶栏
  if (ok) refreshAccountEntry();
  ensureNickname();
});

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
// nav-profile 由账户模块接管：未登录→登录弹窗，已登录→资料弹窗
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
// 游戏个人设置（按账号隔离）
const getBulletConfig = () => loadGameSettings('bullet', BULLET_DEFAULTS);
const getVersusConfig = () => loadGameSettings('versus', VERSUS_DEFAULTS);
const getRouletteConfig = () => loadGameSettings('roulette', ROULETTE_DEFAULTS);
const game = new Game(canvas, input, {
  feedback,
  getSettings: () => panel.getSettingsRef(),
  getGameConfig: getBulletConfig,
  getPressure: () => dm.getPressure(),
  submitScore: (score) => {
    const name = displayName() || ensureNickname();
    if (roomClient.connected) roomClient.reportScore('bullet', name, score);
  },
});
game.start();
game.suspend(); // 默认展示分区页面，进入单机游戏时再恢复循环
configureSfx({ enabled: panel.getSettingsRef().sfxEnabled, volume: panel.getSettingsRef().sfxVolume });

// ===== 屏幕控制按钮（单机运行区） =====
const gameWrap = document.getElementById('game-wrap') as HTMLElement;
const btnStart = document.getElementById('btn-start') as HTMLButtonElement;
const btnBack = document.getElementById('btn-back') as HTMLButtonElement;
const btnPause = document.getElementById('btn-pause') as HTMLButtonElement;
const btnBomb = document.getElementById('btn-bomb') as HTMLButtonElement;
const boardModal = document.getElementById('modal-board') as HTMLElement;

document.getElementById('board-tab-bullet')!.addEventListener('click', () => void renderBoard('bullet'));
document.getElementById('board-tab-versus')!.addEventListener('click', () => void renderBoard('versus'));
document.getElementById('board-tab-roulette')!.addEventListener('click', () => void renderBoard('roulette'));
document.getElementById('board-tab-records')!.addEventListener('click', () => void renderBoard('records'));

async function renderBoard(game: 'bullet' | 'versus' | 'roulette' | 'records' = 'bullet'): Promise<void> {
  // Tab 高亮
  document.getElementById('board-tab-bullet')?.classList.toggle('active', game === 'bullet');
  document.getElementById('board-tab-versus')?.classList.toggle('active', game === 'versus');
  document.getElementById('board-tab-roulette')?.classList.toggle('active', game === 'roulette');
  document.getElementById('board-tab-records')?.classList.toggle('active', game === 'records');

  const listEl = document.getElementById('board-list')!;
  const hintEl = document.getElementById('board-hint')!;
  listEl.innerHTML = '<div class="hint" style="text-align:center;padding:14px">加载中…</div>';
  hintEl.textContent = '';

  if (game === 'records') {
    const rows = await fetchRecords();
    hintEl.textContent = rows.length > 0 ? `最近 ${rows.length} 场公开对局 · 全服记录` : '还没有对战记录';
    listEl.innerHTML =
      `<div class="board-row board-head"><span class="board-rank">时间</span><span class="board-name">胜方</span><span class="board-num">比分</span><span class="board-name">败方</span></div>` +
      (rows.length
        ? rows
            .map(
              (r) => `<div class="board-row">
                  <span class="board-rank" style="font-variant-numeric:tabular-nums">${formatRecordTime(r.time)}</span>
                  <span class="board-name" style="color:var(--gold)">${escapeHtml(r.winner)}</span>
                  <span class="board-num">${r.winScore} : ${r.loseScore}</span>
                  <span class="board-name">${escapeHtml(r.loser)}</span>
                </div>`,
            )
            .join('')
        : '<div class="hint" style="text-align:center;padding:14px">暂无记录，来打第一局</div>');
    return;
  }

  const rows = await fetchBoard(game);
  hintEl.textContent = rows.length > 0 ? `显示前 ${rows.length} 名 · 全服记录` : '';
  const head =
    game === 'bullet'
      ? `<div class="board-row board-head"><span class="board-rank">#</span><span class="board-name">昵称</span><span class="board-num">最高分</span><span class="board-num">场次</span></div>`
      : `<div class="board-row board-head"><span class="board-rank">#</span><span class="board-name">昵称</span><span class="board-num">胜 / 负</span><span class="board-num">胜率</span></div>`;  listEl.innerHTML =
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

/** 公示区记录：自动连接服务器后查询 */
async function fetchRecords(): Promise<{ winner: string; loser: string; winScore: number; loseScore: number; time: string }[]> {
  try {
    if (!roomClient.connected) {
      const last = localStorage.getItem('dg-battle-server-url');
      if (last) await roomClient.connect(last, getToken());
    }
    return await roomClient.requestRecords();
  } catch {
    return [];
  }
}

function formatRecordTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '--';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

async function fetchBoard(game: 'bullet' | 'versus' | 'roulette'): Promise<{ name: string; wins: number; losses: number; rate: number; best: number; games: number }[]> {
  try {
    if (!roomClient.connected) {
      const last = localStorage.getItem('dg-battle-server-url');
      if (last) await roomClient.connect(last, getToken());
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
btnBack.addEventListener('click', () => {
  game.exitToTitle();
  gameWrap.hidden = true;
  game.suspend();
  setLobbyChatVisible(true);
  showPages();
  syncControls();
});

function syncControls(): void {
  const inArcade = battle === null && !gameWrap.hidden;
  const state = game.getState();
  btnStart.hidden = !(inArcade && (state === 'title' || state === 'over'));
  btnBack.hidden = !(inArcade && (state === 'title' || state === 'over'));
  btnPause.hidden = !(inArcade && (state === 'playing' || state === 'paused'));
  btnPause.textContent = state === 'paused' ? '继续' : '暂停';
  btnBomb.hidden = !(inArcade && state === 'playing');
  btnBomb.textContent = `炸弹 ×${game.getBombs()}`;
}

game.onStateChange(syncControls);

// 炸弹数量每秒刷新一次（HUD 同步）
setInterval(syncControls, 1000);
syncControls();

// ===== 多人对战模式 =====
const battleModal = document.getElementById('modal-battle') as HTMLElement;
const battleRoot = document.getElementById('battle-root') as HTMLElement;
const roomClient = new RoomClient();

interface BattleStartConfig {
  nickname: string;
  game: 'versus' | 'roulette';
  targetScore: number;
  boardSize: '8x8' | '10x9' | '12x10';
}

/** 统一的开局入口：大厅配置 / 邀战接受都走这里 */
function startBattle(config: BattleStartConfig): void {
  try {
    startBattleInner(config);
  } catch (err) {
    // 临时诊断：开局异常直接上屏，避免静默空白
    showFatal(`开局失败：${err instanceof Error ? err.message : String(err)}`);
    throw err;
  }
}

function showFatal(text: string): void {
  let box = document.getElementById('fatal-box');
  if (!box) {
    box = document.createElement('div');
    box.id = 'fatal-box';
    box.style.cssText =
      'position:fixed;top:70px;left:50%;transform:translateX(-50%);z-index:300;background:#3a1620;border:1px solid #ff4c5e;color:#ffd7dc;padding:10px 20px;border-radius:8px;font-size:14px;max-width:80vw';
    document.body.appendChild(box);
  }
  box.textContent = text;
}

function startBattleInner(config: BattleStartConfig): void {
  hideModal(battleModal);
  hidePages();
  setLobbyChatVisible(false); // 对局期间用局内私聊，全局大厅聊天隐藏
  gameWrap.hidden = false; // battle-root 嵌在 game-wrap 内，父容器必须一并显示
  battleRoot.hidden = false;
  canvas.style.visibility = 'hidden'; // 防止单机标题画面文字从棋盘边缘透出
  game.suspend();
  const shared = {
    feedback,
    room: roomClient,
    getSettings: () => panel.getSettingsRef(),
    onExit: () => {
      battle?.destroy();
      battle = null;
      battleRoot.hidden = true;
      canvas.style.visibility = 'visible';
      roomClient.close();
      game.exitToTitle();
      gameWrap.hidden = true;
      showPages();
      setLobbyChatVisible(true);
      void portalConnect(roomClient);
      syncControls();
    },
  };
  battle =
    config.game === 'roulette'
      ? new RouletteGame({ ...shared, getGameConfig: getRouletteConfig, config: { nickname: config.nickname } })
      : new GemBattle({ ...shared, getGameConfig: getVersusConfig, dm, config });
  battle.start();
  syncControls();
}


const battleLobby = new BattleLobby(document.getElementById('battle-lobby-body') as HTMLElement, roomClient, (config) => {
  startBattle({
    nickname: config.nickname,
    game: config.game,
    targetScore: config.targetScore,
    boardSize: config.boardSize,
  });
});

// ===== 分区页面（单机 / 多人 / 杂鱼区） =====
const enterArcadeGated = (): void => {
  if (!isLoggedIn()) return void openAuth(enterArcadeGated);
  ensureIntro('bullet', () => {
    hidePages();
    gameWrap.hidden = false;
    game.resize(); // 页面加载时 game-wrap 处于隐藏态，缩放按兜底值算过，显示后必须重算
    setLobbyChatVisible(false); // 单机运行时隐藏全局聊天，避免遮挡炸弹按钮
    game.resume();
    syncControls();
    game.startGame();
  });
};
const enterVersusGated = (g: 'versus' | 'roulette'): void => {
  if (!isLoggedIn()) return void openAuth(() => enterVersusGated(g));
  ensureIntro(g, () => {
    battleLobby.setGame(g);
    battleLobby.refresh();
    showModal(battleModal);
  });
};
initPages({
  enterArcade: enterArcadeGated,
  enterVersus: enterVersusGated,
  openBoard: (tab = 'bullet') => {
    showModal(boardModal);
    void renderBoard(tab as 'bullet' | 'versus' | 'roulette' | 'records');
  },
  showHall: () => void renderHallWall(),
  invite: (user, game) => {
    if (!roomClient.connected) {
      void portalConnect(roomClient).then(() => roomClient.sendInvite(user, game));
    } else {
      roomClient.sendInvite(user, game);
    }
    let toast = document.getElementById('lobby-toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'lobby-toast';
      toast.className = 'lobby-toast';
      document.body.appendChild(toast);
    }
    toast.textContent = '邀战已发送，等待对方接受…';
    toast.hidden = false;
    void roomClient
      .waitMatched()
      .then((m) =>
        startBattle({ nickname: ensureNickname(), game: m.game as 'versus' | 'roulette', targetScore: 5000, boardSize: '12x10' }),
      )
      .catch(() => undefined);
  },
  quickMatch: (game) => {
    battleLobby.quickMatch(game);
  },
  openGameSettings: (game) => {
    renderGameSettings(game, document.getElementById('game-settings-body') as HTMLElement);
    showModal(document.getElementById('modal-game-settings') as HTMLElement);
    playSfx('click');
  },
});

// 登录状态变化：用新令牌重建门户连接
onLoginChange(() => {
  roomClient.close();
  void portalConnect(roomClient);
});

// 在线状态：presence 推送驱动多人卡片人数显示；online 名单转给社交页
roomClient.onMessage((msg) => {
  updatePresence(msg);
  if (msg.t === 'online' && Array.isArray(msg.list)) {
    updateSocialOnline(msg.list as { user: string; nick: string }[]);
  }
});
document.getElementById('nav-versus')!.addEventListener('click', () => void safePortalConnect());

/** 门户连接：authFail（令牌失效）时清理本地僵尸登录态 */
async function safePortalConnect(): Promise<void> {
  try {
    await portalConnect(roomClient);
  } catch (err) {
    if (err instanceof Error && err.message.includes('重新登录')) {
      logoutLocal();
      refreshAccountEntry();
    }
  }
}
void safePortalConnect();

// 大厅：公共聊天 + 收到邀战的横幅（依赖 body 级动态 DOM，随时可初始化）
initLobbyChat(
  roomClient,
  {
    onMatched: (game, _peer) => {
      // 邀战成立：与大厅配置一致的目标分/棋盘默认值
      startBattle({
        nickname: ensureNickname(),
        game,
        targetScore: 5000,
        boardSize: '12x10',
      });
    },
  },
  getCurrentUser()?.username ?? '',
);

// 顶栏账户按钮 → 社交页自己板块（编辑昵称/徽章/退出都在那里）
document.addEventListener('dg-open-self', () => openSelfProfile());

// 固定返回按钮：回到上一个页面
document.getElementById('page-back')!.addEventListener('click', () => goBack());

// 页面加载即自动连接中继，二维码随时就绪
void dm.connect().catch(() => undefined);
// 异常断开（如 5 分钟空闲超时被服务器踢掉）后 3 秒自动重连；
// 用户在设备面板手动断开时状态为 Idle，不会触发重连
setInterval(() => {
  if (dm.state === DGLAB_SOCKET_STATE.Disconnected) {
    void dm.connect().catch(() => undefined);
  }
}, 3000);
