/**
 * DGC 宝石对战 · 房间服务器
 * 纯事件转发器：不触碰 DG-LAB 设备协议，对战双方的浏览器各自控制自己的郊狼。
 *
 * 协议（JSON 文本帧）：
 *   → {t:'hello', nick}         上报昵称（在线统计/匹配展示用）
 *   ← {t:'online', count}       在线人数广播（连接/断开时推送）
 *   → {t:'create'}              创建房间
 *   ← {t:'created', room}       返回 4 位房间码
 *   → {t:'join', room}          加入房间
 *   ← {t:'joined', role:1|2}    分配角色（1=房主）
 *   ← {t:'start'}               双方就位，开局（房主收到后可直接开，转发给对端）
 *   → {t:'match'}               进入随机匹配队列
 *   ← {t:'matched', room, role, peer}  匹配成功，自动建房
 *   → {t:'unmatch'}             离开匹配队列
 *   → {t:'relay', ...}          房间内原样转发给对端
 *   ← {t:'peerLeft'}            对端断开，房间销毁
 *   → {t:'result', game, winner, loser, winScore?, loseScore?}  上报战绩（公示区存档）
 *   → {t:'board'|'records', ...}  查询排行榜 / 公示区记录
 *   ← {t:'error', message}      房间不存在/已满/状态冲突
 */
import { WebSocketServer } from 'ws';
import os from 'node:os';
import { createServer } from 'node:http';
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const PORT = Number(process.env.PORT ?? 8787);
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 去掉易混淆字符
const SESSION_TTL_MS = 7 * 24 * 3600 * 1000; // 令牌 7 天

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SERVER_DIR = path.dirname(fileURLToPath(import.meta.url));
const STATS_FILE = path.join(SERVER_DIR, 'stats.json');
const DB_FILE = path.join(SERVER_DIR, 'dgc.db');

// ===== 账户存储（SQLite，node 内置，零依赖） =====
const db = new DatabaseSync(DB_FILE);
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL COLLATE NOCASE,
    pass_hash TEXT NOT NULL,
    email TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id),
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
`);

// 昵称体系迁移：users 增加 nickname / nickname_changed_at（用户名=不可变 ID，昵称为展示名）
{
  const cols = db.prepare('PRAGMA table_info(users)').all().map((c) => c.name);
  if (!cols.includes('nickname')) {
    db.exec("ALTER TABLE users ADD COLUMN nickname TEXT");
    db.exec('ALTER TABLE users ADD COLUMN nickname_changed_at INTEGER');
    db.exec('UPDATE users SET nickname = username WHERE nickname IS NULL');
    console.log('[db] migrated: users.nickname added');
  }
}

// ===== 战败徽章（杂鱼经济） =====
db.exec(`
  CREATE TABLE IF NOT EXISTS badges (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    owner TEXT NOT NULL,            -- 当前持有者 username
    creator TEXT NOT NULL,          -- 铸造者 username（胜者）
    game TEXT,                      -- 来源对局
    level INTEGER DEFAULT 0,        -- 加强层数（debuff）
    locked INTEGER DEFAULT 0,       -- 1=被加强锁定，不可转移
    history TEXT DEFAULT '[]',      -- JSON 流转时间线 [{op,by,from,to,time}]
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS badge_ops (
    user_id INTEGER NOT NULL,
    day TEXT NOT NULL,
    count INTEGER DEFAULT 0,
    PRIMARY KEY (user_id, day)
  );
`);

const BADGE_NAME_RE = new RegExp("^[^<>&\"'\\u0000-\\u001f]{1,12}$");
const BADGE_DAILY_QUOTA = 3; // 铸造/转移/加强/净化 共享每日配额

function badgeQuotaLeft(userId) {
  const day = new Date().toISOString().slice(0, 10);
  const row = db.prepare('SELECT count FROM badge_ops WHERE user_id = ? AND day = ?').get(userId, day);
  return Math.max(0, BADGE_DAILY_QUOTA - (row?.count ?? 0));
}

function consumeBadgeQuota(userId) {
  const day = new Date().toISOString().slice(0, 10);
  db.prepare(
    'INSERT INTO badge_ops (user_id, day, count) VALUES (?, ?, 1) ON CONFLICT(user_id, day) DO UPDATE SET count = count + 1',
  ).run(userId, day);
}

function badgeById(id) {
  return db.prepare('SELECT * FROM badges WHERE id = ?').get(Number(id));
}

function badgeHistory(badge) {
  try {
    const h = JSON.parse(badge.history);
    return Array.isArray(h) ? h : [];
  } catch {
    return [];
  }
}

function pushBadgeHistory(badge, entry) {
  const h = badgeHistory(badge);
  h.push({ time: new Date().toISOString(), ...entry });
  db.prepare('UPDATE badges SET history = ? WHERE id = ?').run(JSON.stringify(h), badge.id);
}

function userExists(username) {
  return Boolean(db.prepare('SELECT id FROM users WHERE username = ?').get(String(username)));
}

function badgeView(b) {
  return {
    id: b.id,
    name: b.name,
    owner: b.owner,
    creator: b.creator,
    game: b.game,
    level: b.level,
    locked: Boolean(b.locked),
    created_at: b.created_at,
  };
}

function nickMapOf(usernames) {
  const map = {};
  const unique = [...new Set(usernames.filter(Boolean))];
  for (const u of unique) {
    const row = db.prepare('SELECT nickname FROM users WHERE username = ?').get(u);
    map[u] = row?.nickname || u;
  }
  return map;
}

const NICKNAME_COOLDOWN_MS = 3 * 24 * 3600 * 1000; // 昵称 3 天冷却
const NICKNAME_RE = new RegExp("^[^<>&\"'\\u0000-\\u001f]{1,16}$");
setInterval(() => {
  try {
    db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
  } catch { /* 静默 */ }
}, 600_000).unref();

function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, hash] = String(stored).split(':');
  if (!salt || !hash) return false;
  const candidate = scryptSync(password, salt, 64);
  const expected = Buffer.from(hash, 'hex');
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}

function createSession(userId) {
  const token = randomBytes(32).toString('hex');
  db.prepare('INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)').run(
    token,
    userId,
    Date.now(),
    Date.now() + SESSION_TTL_MS,
  );
  return token;
}

function userByToken(token) {
  if (!token) return null;
  const row = db
    .prepare('SELECT u.id, u.username, u.nickname, u.nickname_changed_at, u.email, u.created_at FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ? AND s.expires_at > ?')
    .get(String(token), Date.now());
  return row ?? null;
}

// 登录/注册限流：每 IP+账户 每分钟 5 次失败
const loginAttempts = new Map(); // key → { count, resetAt }
function rateLimited(key) {
  const now = Date.now();
  const rec = loginAttempts.get(key);
  if (!rec || rec.resetAt < now) {
    loginAttempts.set(key, { count: 0, resetAt: now + 60_000 });
    return false;
  }
  return rec.count >= 5;
}
function recordFail(key) {
  const rec = loginAttempts.get(key);
  if (rec) rec.count += 1;
}

const USERNAME_RE = /^[A-Za-z0-9_\-]{3,16}$/; // 用户 ID：仅英文/数字/下划线/横线，避免编码异常

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
  });
  res.end(body);
}

function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) return reject(new Error('body too large'));
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/** 账户 HTTP API：/api/register /api/login /api/me /api/logout */
async function apiHandler(req, res) {
  if (req.method === 'OPTIONS') return json(res, 204, {});
  const url = new URL(req.url, 'http://localhost');
  const ip = req.socket.remoteAddress ?? 'unknown';
  try {
    if (url.pathname === '/api/register' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req) || '{}');
      const username = String(body.username ?? '').trim();
      const password = String(body.password ?? '');
      const email = body.email ? String(body.email).trim() : null;
      if (!USERNAME_RE.test(username)) return json(res, 400, { code: 400, message: '用户名（ID）需 3-16 位英文、数字、下划线或横线' });
      if (password.length < 6) return json(res, 400, { code: 400, message: '密码至少 6 位' });
      if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json(res, 400, { code: 400, message: '邮箱格式不正确' });
      if (rateLimited(`reg:${ip}`)) return json(res, 429, { code: 429, message: '操作太频繁，请稍后再试' });
      const exists = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
      if (exists) return json(res, 409, { code: 409, message: '用户名已被占用' });
      recordFail(`reg:${ip}`);
      const info = db.prepare('INSERT INTO users (username, pass_hash, email, nickname) VALUES (?, ?, ?, ?)').run(username, hashPassword(password), email, username);
      const token = createSession(Number(info.lastInsertRowid));
      const created = db.prepare('SELECT created_at FROM users WHERE id = ?').get(Number(info.lastInsertRowid));
      return json(res, 200, { code: 200, data: { token, user: { id: Number(info.lastInsertRowid), username, nickname: username, created_at: created?.created_at } } });
    }
    if (url.pathname === '/api/login' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req) || '{}');
      const username = String(body.username ?? '').trim();
      const password = String(body.password ?? '');
      const key = `login:${ip}:${username.toLowerCase()}`;
      if (rateLimited(key)) return json(res, 429, { code: 429, message: '尝试次数过多，请 1 分钟后再试' });
      const user = db.prepare('SELECT id, username, pass_hash, email, created_at, nickname, nickname_changed_at FROM users WHERE username = ?').get(username);
      if (!user || !verifyPassword(password, user.pass_hash)) {
        recordFail(key);
        return json(res, 401, { code: 401, message: '用户名或密码错误' });
      }
      loginAttempts.delete(key);
      const token = createSession(user.id);
      return json(res, 200, { code: 200, data: { token, user: { id: user.id, username: user.username, nickname: user.nickname ?? user.username, nickname_changed_at: user.nickname_changed_at, email: user.email, created_at: user.created_at } } });
    }
    if (url.pathname === '/api/me' && req.method === 'GET') {
      const user = userByToken(String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, ''));
      if (!user) return json(res, 401, { code: 401, message: '未登录或令牌已过期' });
      return json(res, 200, { code: 200, data: { user } });
    }
    if (url.pathname === '/api/nickname' && req.method === 'POST') {
      const token = String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
      const user = userByToken(token);
      if (!user) return json(res, 401, { code: 401, message: '未登录或令牌已过期' });
      const body = JSON.parse(await readBody(req) || '{}');
      const nickname = String(body.nickname ?? '').trim();
      if (!NICKNAME_RE.test(nickname)) return json(res, 400, { code: 400, message: '昵称 1-16 字，不能含 <>&"\' 与控制字符' });
      const row = db.prepare('SELECT nickname, nickname_changed_at FROM users WHERE id = ?').get(user.id);
      const changedAt = row?.nickname_changed_at ?? 0;
      const remain = changedAt + NICKNAME_COOLDOWN_MS - Date.now();
      if (remain > 0) {
        const hours = Math.ceil(remain / 3600_000);
        return json(res, 429, { code: 429, message: `昵称修改太频繁，还需等待约 ${hours} 小时` });
      }
      db.prepare('UPDATE users SET nickname = ?, nickname_changed_at = ? WHERE id = ?').run(nickname, Date.now(), user.id);
      const fresh = userByToken(token);
      return json(res, 200, { code: 200, data: { user: fresh } });
    }
    if (url.pathname === '/api/logout' && req.method === 'POST') {
      const token = String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
      if (token) db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
      return json(res, 200, { code: 200 });
    }

    // ===== 战败徽章 =====
    if (url.pathname === '/api/hall' && req.method === 'GET') {
      const rows = db
        .prepare('SELECT * FROM badges ORDER BY locked DESC, level DESC, id DESC LIMIT 100')
        .all();
      const nicks = nickMapOf(rows.flatMap((b) => [b.owner, b.creator]));
      return json(res, 200, { code: 200, data: { badges: rows.map(badgeView), nicks } });
    }
    if (url.pathname === '/api/badges/mine' && req.method === 'GET') {
      const token = String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
      const user = userByToken(token);
      if (!user) return json(res, 401, { code: 401, message: '未登录' });
      const rows = db.prepare('SELECT * FROM badges WHERE owner = ? ORDER BY locked DESC, level DESC, id DESC').all(user.username);
      return json(res, 200, { code: 200, data: { badges: rows.map(badgeView), quota: badgeQuotaLeft(user.id), history: null } });
    }
    if (url.pathname.startsWith('/api/badges/') && req.method === 'POST') {
      const token = String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
      const user = userByToken(token);
      if (!user) return json(res, 401, { code: 401, message: '未登录' });
      const action = url.pathname.slice('/api/badges/'.length);
      const body = JSON.parse(await readBody(req) || '{}');

      const quotaLeft = badgeQuotaLeft(user.id);
      if (quotaLeft <= 0) return json(res, 429, { code: 429, message: '今日徽章配额已用完（3 次/天）' });

      // 设立新徽章：胜者给败者铸造，名称由胜者编写
      if (action === 'mint') {
        const to = String(body.to ?? '').trim();
        const name = String(body.name ?? '').trim();
        const game = String(body.game ?? '').slice(0, 16) || null;
        if (to === user.username) return json(res, 400, { code: 400, message: '不能给自己铸造徽章' });
        if (!userExists(to)) return json(res, 404, { code: 404, message: '对方账户不存在' });
        if (!BADGE_NAME_RE.test(name)) return json(res, 400, { code: 400, message: '徽章名称 1-12 字，不能含 <>&"\' 与控制字符' });
        const info = db
          .prepare('INSERT INTO badges (name, owner, creator, game) VALUES (?, ?, ?, ?)')
          .run(name, to, user.username, game);
        const badge = badgeById(info.lastInsertRowid);
        pushBadgeHistory(badge, { op: 'mint', by: user.username, to, name });
        consumeBadgeQuota(user.id);
        console.log(`[badge] ${user.username} minted「${name}」→ ${to}`);
        return json(res, 200, { code: 200, data: { badge: badgeView(badge), quota: badgeQuotaLeft(user.id) } });
      }

      // 转移：把自己的徽章转给败者（被锁定的不可转）
      if (action === 'transfer') {
        const badge = badgeById(body.badgeId);
        const to = String(body.to ?? '').trim();
        if (!badge) return json(res, 404, { code: 404, message: '徽章不存在' });
        if (badge.owner !== user.username) return json(res, 403, { code: 403, message: '只能转移自己持有的徽章' });
        if (badge.locked) return json(res, 409, { code: 409, message: '该徽章被加强锁定中，需先净化才能转移' });
        if (to === user.username) return json(res, 400, { code: 400, message: '徽章已在你的手中' });
        if (!userExists(to)) return json(res, 404, { code: 404, message: '对方账户不存在' });
        db.prepare('UPDATE badges SET owner = ? WHERE id = ?').run(to, badge.id);
        pushBadgeHistory(badge, { op: 'transfer', by: user.username, from: user.username, to });
        consumeBadgeQuota(user.id);
        console.log(`[badge] ${user.username} transferred #${badge.id} → ${to}`);
        return json(res, 200, { code: 200, data: { badge: badgeView(badgeById(badge.id)), quota: badgeQuotaLeft(user.id) } });
      }

      // 加强：给败者已有的徽章 +1 层并锁定（不可转移直到被净化）
      if (action === 'enhance') {
        const badge = badgeById(body.badgeId);
        if (!badge) return json(res, 404, { code: 404, message: '徽章不存在' });
        if (badge.owner === user.username) return json(res, 400, { code: 400, message: '不能加强自己持有的徽章' });
        if (badge.locked) return json(res, 409, { code: 409, message: '该徽章已被加强锁定，需先净化' });
        db.prepare('UPDATE badges SET level = level + 1, locked = 1 WHERE id = ?').run(badge.id);
        pushBadgeHistory(badge, { op: 'enhance', by: user.username, to: badge.owner, level: badge.level + 1 });
        consumeBadgeQuota(user.id);
        console.log(`[badge] ${user.username} enhanced #${badge.id} → lv${badge.level + 1} (locked)`);
        return json(res, 200, { code: 200, data: { badge: badgeView(badgeById(badge.id)), quota: badgeQuotaLeft(user.id) } });
      }

      // 净化：去除败者徽章的 debuff，恢复可转移
      if (action === 'cleanse') {
        const badge = badgeById(body.badgeId);
        if (!badge) return json(res, 404, { code: 404, message: '徽章不存在' });
        if (badge.owner === user.username) return json(res, 400, { code: 400, message: '不能净化自己持有的徽章' });
        if (!badge.locked) return json(res, 409, { code: 409, message: '该徽章未被锁定' });
        db.prepare('UPDATE badges SET locked = 0 WHERE id = ?').run(badge.id);
        pushBadgeHistory(badge, { op: 'cleanse', by: user.username, to: badge.owner });
        consumeBadgeQuota(user.id);
        console.log(`[badge] ${user.username} cleansed #${badge.id} (unlocked)`);
        return json(res, 200, { code: 200, data: { badge: badgeView(badgeById(badge.id)), quota: badgeQuotaLeft(user.id) } });
      }

      return json(res, 404, { code: 404, message: '未知的徽章操作' });
    }
    if (url.pathname === '/api/badges/history' && req.method === 'GET') {
      const badge = badgeById(Number(url.searchParams.get('id')));
      if (!badge) return json(res, 404, { code: 404, message: '徽章不存在' });
      const nicks = nickMapOf(badgeHistory(badge).flatMap((h) => [h.by, h.from, h.to]));
      return json(res, 200, { code: 200, data: { history: badgeHistory(badge), nicks } });
    }
    return json(res, 404, { code: 404, message: '接口不存在' });
  } catch (err) {
    return json(res, 400, { code: 400, message: err instanceof Error ? err.message : '请求格式错误' });
  }
}

function loadStats() {
  try {
    if (existsSync(STATS_FILE)) return JSON.parse(readFileSync(STATS_FILE, 'utf8'));
  } catch {
    /* 损坏则重建 */
  }
  return {};
}

function saveStats(stats) {
  try {
    writeFileSync(STATS_FILE, JSON.stringify(stats, null, 2));
  } catch {
    /* 只读环境静默失败 */
  }
}

const stats = loadStats();

/** 战绩按游戏分桶：stats[game][name]。versus/roulette 计胜负，bullet 计最高分 */
function bucket(game) {
  const key = String(game ?? 'versus');
  return (stats[key] ??= {});
}

function recordResult(game, winner, loser, winScore, loseScore) {
  const b = bucket(game);
  for (const [name, isWin] of [
    [winner, true],
    [loser, false],
  ]) {
    if (!name) continue;
    const s = (b[name] ??= { wins: 0, losses: 0, best: 0 });
    if (isWin) s.wins++;
    else s.losses++;
  }
  // 公示区：保留最近 300 条，昵称本就在排行榜公开
  const records = (stats.records ??= []);
  records.unshift({
    game,
    winner,
    loser,
    winScore: Number(winScore) || 0,
    loseScore: Number(loseScore) || 0,
    time: new Date().toISOString(),
  });
  if (records.length > 300) records.length = 300;
  saveStats(stats);
  console.log(`[stats:${game}] ${winner} beat ${loser}`);
}

/** 单机最高分：只保留历史最高，同时累计场次 */
function recordScore(game, name, score) {
  if (!name) return;
  const b = bucket(game);
  const s = (b[name] ??= { wins: 0, losses: 0, best: 0 });
  s.games = (s.games ?? 0) + 1;
  if (score > (s.best ?? 0)) s.best = score;
  saveStats(stats);
  console.log(`[stats:${game}] ${name} score ${score}`);
}

/** 排行榜展示名：账户用户显示昵称，游客时代数据显示原名 */
function displayNameOf(name) {
  const row = db.prepare('SELECT nickname FROM users WHERE username = ?').get(name);
  return row?.nickname || name;
}

function leaderboard(game, limit = 20) {
  const b = bucket(game);
  if (game === 'bullet') {
    return Object.entries(b)
      .map(([name, s]) => ({ name: displayNameOf(name), best: s.best ?? 0, games: s.games ?? 0 }))
      .sort((a, b2) => b2.best - a.best || b2.games - a.games)
      .slice(0, limit);
  }
  return Object.entries(b)
    .map(([name, s]) => ({
      name: displayNameOf(name),
      wins: s.wins,
      losses: s.losses,
      rate: s.wins + s.losses > 0 ? Math.round((s.wins / (s.wins + s.losses)) * 100) : 0,
    }))
    .sort((a, b2) => b2.wins - a.wins || a.losses - b2.losses)
    .slice(0, limit);
}

/** 公示区：最近的对局记录，可按游戏过滤 */
function recentRecords(game, limit = 50) {
  const all = Array.isArray(stats.records) ? stats.records : [];
  const filtered = game ? all.filter((r) => r.game === game) : all;
  return filtered.slice(0, limit);
}

/** 全站实时状态：在线数、各游戏游玩/匹配人数（前端卡片展示） */
function presenceSnapshot() {
  const games = {};
  for (const g of GAME_TYPES) games[g] = { playing: 0, matching: 0 };
  for (const room of rooms.values()) {
    if (games[room.game]) games[room.game].playing += room.clients.size;
  }
  for (const q of matchQueue) {
    if (games[q.game]) games[q.game].matching += 1;
  }
  return { t: 'presence', online: wss.clients.size, games };
}

function broadcastPresence() {
  const payload = presenceSnapshot();
  for (const client of wss.clients) send(client, payload);
}

const rooms = new Map(); // code → { clients: Map(role → ws), game, fromMatch? }
const matchQueue = []; // { ws, nick, game } 随机匹配等待队列
const GAME_TYPES = new Set(['versus', 'roulette']); // 联机游戏白名单

// ===== 大厅（公共聊天 + 在线名单 + 邀战） =====
const chatHistory = []; // 最近 50 条，给晚加入的回放
const pendingInvites = new Map(); // inviteId → { from: ws, to: ws, game, at }

function authedClients() {
  return [...wss.clients].filter((c) => c.readyState === c.OPEN && c._user);
}

function broadcastToAuthed(payload) {
  for (const c of authedClients()) send(c, payload);
}

function onlineList() {
  return authedClients().map((c) => ({ user: c._user.username, nick: c._nick || c._user.username }));
}

function pushOnlineList() {
  broadcastToAuthed({ t: 'online', list: onlineList() });
}

function pushChatHistory(ws) {
  send(ws, { t: 'chatHistory', list: chatHistory.slice(-50) });
}

// 邀战 45 秒过期
setInterval(() => {
  const now = Date.now();
  for (const [id, inv] of pendingInvites) {
    if (now - inv.at > 45_000) {
      pendingInvites.delete(id);
      send(inv.from, { t: 'inviteAnswer', inviteId: id, accept: false, reason: '对方未响应，邀战超时' });
    }
  }
}, 10_000).unref();

function makeCode() {
  let code = '';
  for (let i = 0; i < 4; i++) code += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  return rooms.has(code) ? makeCode() : code;
}

function send(ws, payload) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(payload));
}

function destroyRoom(code) {
  const room = rooms.get(code);
  if (!room) return;
  for (const ws of room.clients.values()) {
    send(ws, { t: 'peerLeft' });
    ws._room = null;
    ws._role = 0;
  }
  rooms.delete(code);
  console.log(`[room] ${code} destroyed`);
  broadcastPresence();
}

function sanitizeNick(nick) {
  return String(nick ?? '')
    .replace(/[\u0000-\u001f<>&"']/g, '')
    .trim()
    .slice(0, 12);
}

/** 在线人数广播给所有连接（含正在浏览排行榜的连接） */
function broadcastOnline() {
  broadcastPresence();
}

/** 从队列摘除某连接（断线/取消时） */
function dequeue(ws) {
  const i = matchQueue.findIndex((q) => q.ws === ws);
  if (i >= 0) matchQueue.splice(i, 1);
}

/** 队首同游戏的两人凑齐就自动建房开局；跳过已断开的连接。
 *  game 兼容规则：any 与 anything 可配，结果取具体游戏；双 any 默认 versus */
function tryMatch() {
  const compatible = (a, b) => a === 'any' || b === 'any' || a === b;
  const pick = (i, j) => {
    // 先出队的是队尾（索引大），后出队的队首（索引小）——先排队者当房主
    const second = matchQueue.splice(Math.max(i, j), 1)[0];
    const first = matchQueue.splice(Math.min(i, j), 1)[0];
    return [first, second];
  };
  for (let i = 0; i < matchQueue.length; i++) {
    for (let j = i + 1; j < matchQueue.length; j++) {
      if (!compatible(matchQueue[i].game, matchQueue[j].game)) continue;
      const [a, b] = pick(i, j);
      if (a.ws.readyState !== a.ws.OPEN || a.ws._room) {
        if (b.ws.readyState === b.ws.OPEN && !b.ws._room) matchQueue.unshift(b);
        continue;
      }
      if (b.ws.readyState !== b.ws.OPEN || b.ws._room) {
        matchQueue.unshift(a);
        continue;
      }
      const game = a.game !== 'any' ? a.game : b.game !== 'any' ? b.game : 'versus';
      const code = makeCode();
      rooms.set(code, { clients: new Map([[1, a.ws], [2, b.ws]]), game, fromMatch: true });
      a.ws._room = code;
      a.ws._role = 1;
      b.ws._room = code;
      b.ws._role = 2;
      send(a.ws, { t: 'matched', room: code, role: 1, peer: b.nick, game });
      send(b.ws, { t: 'matched', room: code, role: 2, peer: a.nick, game });
      send(a.ws, { t: 'start' });
      send(b.ws, { t: 'start' });
      console.log(`[match:${game}] ${a.nick} vs ${b.nick} → room ${code}`);
      return;
    }
  }
}

// '::' 双栈监听：HTTP API 与 WebSocket 同端口，同时接受 IPv4 与 IPv6
const httpServer = createServer(apiHandler);
const wss = new WebSocketServer({ server: httpServer });
httpServer.listen(PORT, '::', () => {
  console.log(`[room-server] listening on [::]:${PORT} (HTTP API + WebSocket)`);
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === 'IPv4' && !a.internal) console.log(`[room-server]   LAN ${name}: http://${a.address}:${PORT}`);
    }
  }
  console.log('[room-server] 公网部署请用 wss://（HTTPS 页面不允许连 ws://）');
});

// presence 兜底心跳：广播偶发遗漏时也能自愈
setInterval(broadcastPresence, 5000);

wss.on('connection', (ws) => {
  ws._room = null;
  ws._role = 0;
  ws._nick = '';
  ws._user = null; // 鉴权后为用户对象 {id, username}
  broadcastOnline();

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return;
    }

    // 令牌鉴权：连接后首帧
    if (msg.t === 'auth') {
      const user = userByToken(msg.token);
      if (!user) return send(ws, { t: 'authFail', message: '登录状态无效，请重新登录' });
      ws._user = user;
      ws._nick = user.nickname || user.username;
      send(ws, { t: 'authOk', user: { id: user.id, username: user.username, nickname: ws._nick } });
      pushChatHistory(ws);
      pushOnlineList();
      broadcastPresence();
      return;
    }

    // 战绩查询/公示区允许匿名；游戏行为必须登录
    const PUBLIC = new Set(['board', 'records']);
    if (!ws._user && !PUBLIC.has(String(msg.t))) {
      return send(ws, { t: 'error', message: '请先登录账号' });
    }

    // ===== 大厅 =====
    if (msg.t === 'chat') {
      const now = Date.now();
      if (ws._lastChatAt && now - ws._lastChatAt < 1500) {
        return send(ws, { t: 'error', message: '说话慢一点～' });
      }
      const text = String(msg.text ?? '').replace(new RegExp("[\\u0000-\\u001f<>]", 'g'), '').trim().slice(0, 200);
      if (!text) return;
      ws._lastChatAt = now;
      const entry = { from: ws._user.username, nick: ws._nick, text, time: new Date().toISOString() };
      chatHistory.push(entry);
      if (chatHistory.length > 50) chatHistory.shift();
      broadcastToAuthed({ t: 'chat', ...entry });
      return;
    }
    if (msg.t === 'who') {
      send(ws, { t: 'online', list: onlineList() });
      return;
    }
    if (msg.t === 'invite') {
      const to = String(msg.to ?? '').trim();
      const game = GAME_TYPES.has(msg.game) ? msg.game : 'versus';
      if (to === ws._user.username) return send(ws, { t: 'error', message: '不能邀请自己' });
      const target = authedClients().find((c) => c._user.username === to);
      if (!target) return send(ws, { t: 'error', message: '对方不在线' });
      const inviteId = randomBytes(4).toString('hex');
      pendingInvites.set(inviteId, { from: ws, to: target, game, at: Date.now() });
      send(target, { t: 'invited', inviteId, from: ws._user.username, nick: ws._nick, game });
      send(ws, { t: 'inviteSent', inviteId, to });
      return;
    }
    if (msg.t === 'inviteReply') {
      const inviteId = String(msg.inviteId ?? '');
      const inv = pendingInvites.get(inviteId);
      if (!inv || inv.to !== ws) return;
      pendingInvites.delete(inviteId);
      if (!msg.accept) {
        send(inv.from, { t: 'inviteAnswer', inviteId, accept: false, reason: '对方婉拒了邀战' });
        return;
      }
      // 接受：自动建房（邀请方=房主），与随机匹配的后续流程一致
      const code = makeCode();
      rooms.set(code, { clients: new Map([[1, inv.from], [2, ws]]), game: inv.game, fromMatch: false });
      inv.from._room = code;
      inv.from._role = 1;
      ws._room = code;
      ws._role = 2;
      send(inv.from, { t: 'matched', room: code, role: 1, peer: ws._nick, game: inv.game });
      send(ws, { t: 'matched', room: code, role: 2, peer: inv.from._nick, game: inv.game });
      send(inv.from, { t: 'start' });
      send(ws, { t: 'start' });
      console.log(`[invite] ${inv.from._user.username} vs ${ws._user.username} → room ${code} (${inv.game})`);
      broadcastPresence();
      return;
    }

    if (msg.t === 'hello') {
      ws._nick = ws._user ? ws._user.nickname || ws._user.username : sanitizeNick(msg.nick) || '玩家';
      return;
    }

    // 随机匹配队列
    if (msg.t === 'match') {
      if (ws._room) return send(ws, { t: 'error', message: '已在房间中' });
      if (matchQueue.some((q) => q.ws === ws)) return;
      const game = GAME_TYPES.has(msg.game) ? msg.game : 'any'; // any=不限游戏（默认）
      matchQueue.push({ ws, nick: ws._nick || '玩家', game });
      console.log(`[match:${game}] ${ws._nick || '玩家'} queued (${matchQueue.length})`);
      tryMatch();
      broadcastPresence();
      return;
    }
    if (msg.t === 'unmatch') {
      dequeue(ws);
      broadcastPresence();
      // 匹配建房后其中一方客户端放弃（极端时序）：解散房间，双方回到大厅
      if (ws._room) {
        const room = rooms.get(ws._room);
        if (room?.fromMatch) destroyRoom(ws._room);
      }
      return;
    }

    if (msg.t === 'create' && !ws._room) {
      const code = makeCode();
      const game = GAME_TYPES.has(msg.game) ? msg.game : 'versus';
      rooms.set(code, { clients: new Map([[1, ws]]), game });
      ws._room = code;
      ws._role = 1;
      send(ws, { t: 'created', room: code, game });
      console.log(`[room] ${code} created (${game})`);
      broadcastPresence();
      return;
    }

    // 战绩上报与排行榜查询（与房间无关）；上报者以自己的账户名计（防冒名）
    if (msg.t === 'result') {
      recordResult(
        String(msg.game ?? 'versus'),
        ws._user.username,
        String(msg.loser ?? ''),
        msg.winScore,
        msg.loseScore,
      );
      return;
    }
    if (msg.t === 'score') {
      recordScore(String(msg.game ?? 'bullet'), ws._user.username, Number(msg.score) || 0);
      return;
    }
    if (msg.t === 'board') {
      send(ws, { t: 'board', game: String(msg.game ?? 'versus'), list: leaderboard(String(msg.game ?? 'versus')) });
      return;
    }
    if (msg.t === 'records') {
      send(ws, {
        t: 'records',
        list: recentRecords(msg.game ? String(msg.game) : null, Number(msg.limit) || 50),
      });
      return;
    }

    if (msg.t === 'join' && !ws._room) {
      const room = rooms.get(String(msg.room ?? '').toUpperCase());
      if (!room) return send(ws, { t: 'error', message: '房间不存在' });
      if (room.clients.size >= 2) return send(ws, { t: 'error', message: '房间已满' });
      room.clients.set(2, ws);
      ws._room = String(msg.room).toUpperCase();
      ws._role = 2;
      send(ws, { t: 'joined', role: 2, game: room.game });
      send(room.clients.get(1), { t: 'start' });
      send(ws, { t: 'start' });
      console.log(`[room] ${ws._room} full, started`);
      broadcastPresence();
      return;
    }

    if (msg.t === 'relay' && ws._room) {
      const room = rooms.get(ws._room);
      const peer = room?.clients.get(ws._role === 1 ? 2 : 1);
      if (peer) {
        // 给对方补上来源用户名，供徽章操作等场景使用（密级低，可明文）
        msg.fromUser = ws._user.username;
        send(peer, msg);
      }
      return;
    }
  });

  ws.on('close', () => {
    dequeue(ws);
    if (ws._user) {
      pushOnlineList();
    }
    broadcastOnline();
    if (ws._room) destroyRoom(ws._room);
  });

  ws.on('error', () => {
    dequeue(ws);
    if (ws._room) destroyRoom(ws._room);
  });
});
