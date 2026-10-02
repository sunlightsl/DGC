import { setNickname } from './profile';

/**
 * 账户客户端：注册 / 登录 / 令牌管理。
 * HTTP API 与 WebSocket 同端口，由 ws URL 推导 http 基址。
 */

export interface AccountUser {
  id: number;
  username: string;
  nickname?: string;
  nickname_changed_at?: number | null;
  email?: string | null;
  created_at?: string;
}

const TOKEN_KEY = 'dg-token';
const USER_KEY = 'dg-user';

let current: AccountUser | null = null;

try {
  const raw = localStorage.getItem(USER_KEY);
  if (raw) current = JSON.parse(raw);
} catch {
  current = null;
}

export function getToken(): string {
  return localStorage.getItem(TOKEN_KEY) ?? '';
}

export function getCurrentUser(): AccountUser | null {
  return current;
}

export function isLoggedIn(): boolean {
  return Boolean(current && getToken());
}

/** 对外显示名：昵称优先；游客退回昵称档案 */
export function displayName(): string {
  return current?.nickname || current?.username || '';
}

/** 距离下次可改昵称的剩余毫秒（0 = 可改） */
export function nicknameCooldownMs(): number {
  const changedAt = current?.nickname_changed_at;
  if (!changedAt) return 0;
  return Math.max(0, changedAt + 3 * 24 * 3600 * 1000 - Date.now());
}

/** 修改昵称（服务器 3 天冷却），成功后更新本地态 */
export async function changeNickname(nickname: string): Promise<void> {
  const res = await fetch(`${httpBase()}/api/nickname`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getToken()}` },
    body: JSON.stringify({ nickname }),
  });
  const data = (await res.json().catch(() => ({}))) as { code?: number; message?: string; data?: { user?: AccountUser } };
  if (!res.ok || data.code !== 200) {
    throw new Error(data.message || `修改失败（${res.status}）`);
  }
  if (data.data?.user) {
    current = data.data.user;
    localStorage.setItem(USER_KEY, JSON.stringify(data.data.user));
    setNickname(data.data.user.nickname || data.data.user.username);
  }
}

/** ws://host:port → http://host:port（wss → https） */
export function httpBase(): string {
  const saved = localStorage.getItem('dg-battle-server-url');
  const wsUrl = saved || (location.protocol === 'https:' ? `wss://${location.host}/dgws` : 'ws://localhost:8787');
  return wsUrl.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:');
}

async function api(path: string, body?: unknown): Promise<{ token?: string; user?: AccountUser }> {
  const res = await fetch(`${httpBase()}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(getToken() ? { Authorization: `Bearer ${getToken()}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as { code?: number; message?: string; data?: { token?: string; user?: AccountUser } };
  if (!res.ok || data.code !== 200) {
    throw new Error(data.message || `请求失败（${res.status}）`);
  }
  return data.data ?? {};
}

function applySession(token: string, user: AccountUser): void {
  localStorage.setItem(TOKEN_KEY, token);
  localStorage.setItem(USER_KEY, JSON.stringify(user));
  current = user;
  // 账户昵称即游戏内显示名（无昵称时退回用户名）
  setNickname(user.nickname || user.username);
}

export async function login(username: string, password: string): Promise<void> {
  const data = await api('/api/login', { username, password });
  applySession(data.token!, data.user!);
}

export async function register(username: string, password: string, email?: string): Promise<void> {
  const data = await api('/api/register', { username, password, email: email || undefined });
  applySession(data.token!, data.user!);
}

/** 启动时校验令牌（7 天过期），失效则清理本地态 */
export async function validateSession(): Promise<boolean> {
  if (!getToken()) return false;
  try {
    const data = await api('/api/me');
    if (data.user) {
      current = data.user;
      localStorage.setItem(USER_KEY, JSON.stringify(data.user));
      setNickname(data.user.nickname || data.user.username);
      return true;
    }
  } catch {
    /* 掉线也算未登录，由 isLoggedIn 兜底 */
  }
  return isLoggedIn();
}

export function logoutLocal(): void {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
  current = null;
}

export async function logout(): Promise<void> {
  try {
    await api('/api/logout', {});
  } catch {
    /* 服务器不可达也允许本地退出 */
  }
  logoutLocal();
}
