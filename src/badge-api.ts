import { getToken, httpBase } from './account';

/**
 * 战败徽章 API 客户端：铸造 / 转移 / 加强 / 净化 / 展示墙 / 我的徽章。
 * 战绩与徽章以用户名（ID）为锚，展示层用昵称映射。
 */

export interface Badge {
  id: number;
  name: string;
  owner: string; // username
  creator: string;
  game: string | null;
  level: number;
  locked: boolean;
  created_at: string;
}

export interface HallData {
  badges: Badge[];
  nicks: Record<string, string>;
}

async function req<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${httpBase()}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(getToken() ? { Authorization: `Bearer ${getToken()}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as { code?: number; message?: string; data?: T };
  if (!res.ok || data.code !== 200) {
    throw new Error(data.message || `请求失败（${res.status}）`);
  }
  return data.data as T;
}

export const fetchHall = () => req<HallData>('/api/hall');

export const fetchMyBadges = () =>
  req<{ badges: Badge[]; quota: number }>('/api/badges/mine');

export const mintBadge = (to: string, name: string, game?: string) =>
  req<{ badge: Badge; quota: number }>('/api/badges/mint', { to, name, game });

export const transferBadge = (badgeId: number, to: string) =>
  req<{ badge: Badge; quota: number }>('/api/badges/transfer', { badgeId, to });

export const enhanceBadge = (badgeId: number) =>
  req<{ badge: Badge; quota: number }>('/api/badges/enhance', { badgeId });

export const cleanseBadge = (badgeId: number) =>
  req<{ badge: Badge; quota: number }>('/api/badges/cleanse', { badgeId });

export interface BadgeEvent {
  op: 'mint' | 'transfer' | 'enhance' | 'cleanse';
  by: string;
  from?: string;
  to?: string;
  name?: string;
  level?: number;
  time: string;
}

/** 徽章流转时间线（展示墙点开后按需取） */
export const fetchBadgeHistory = (id: number) =>
  req<{ history: BadgeEvent[]; nicks: Record<string, string> }>(`/api/badges/history?id=${id}`);
