/**
 * DGC 宝石对战 · 房间服务器
 * 纯事件转发器：不触碰 DG-LAB 设备协议，对战双方的浏览器各自控制自己的郊狼。
 *
 * 协议（JSON 文本帧）：
 *   → {t:'create'}              创建房间
 *   ← {t:'created', room}       返回 4 位房间码
 *   → {t:'join', room}          加入房间
 *   ← {t:'joined', role:1|2}    分配角色（1=房主）
 *   ← {t:'start'}               双方就位，开局（房主收到后可直接开，转发给对端）
 *   → {t:'relay', ...}          房间内原样转发给对端
 *   ← {t:'peerLeft'}            对端断开，房间销毁
 *   ← {t:'error', message}      房间不存在/已满
 */
import { WebSocketServer } from 'ws';
import os from 'node:os';

const PORT = Number(process.env.PORT ?? 8787);
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 去掉易混淆字符

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const STATS_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'stats.json');

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

/** 战绩按游戏分类：stats[game][name]。versus 计胜负，bullet 计最高分 */
function bucket(game) {
  const key = game === 'bullet' ? 'bullet' : 'versus';
  return (stats[key] ??= {});
}

function recordResult(game, winner, loser) {
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

function leaderboard(game, limit = 20) {
  const b = bucket(game);
  if (game === 'bullet') {
    return Object.entries(b)
      .map(([name, s]) => ({ name, best: s.best ?? 0, games: s.games ?? 0 }))
      .sort((a, b2) => b2.best - a.best || b2.games - a.games)
      .slice(0, limit);
  }
  return Object.entries(b)
    .map(([name, s]) => ({
      name,
      wins: s.wins,
      losses: s.losses,
      rate: s.wins + s.losses > 0 ? Math.round((s.wins / (s.wins + s.losses)) * 100) : 0,
    }))
    .sort((a, b2) => b2.wins - a.wins || a.losses - b2.losses)
    .slice(0, limit);
}

const rooms = new Map(); // code → { clients: Map(role → ws) }

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
}

// '::' 双栈监听：同时接受 IPv4 与 IPv6，避免浏览器把 localhost 解析成 ::1 时连不上
const wss = new WebSocketServer({ port: PORT, host: '::' }, () => {
  console.log(`[room-server] listening on [::]:${PORT} (IPv4+IPv6)`);
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === 'IPv4' && !a.internal) console.log(`[room-server]   LAN ${name}: ws://${a.address}:${PORT}`);
    }
  }
  console.log('[room-server] 公网部署请用 wss://（HTTPS 页面不允许连 ws://）');
});

wss.on('connection', (ws) => {
  ws._room = null;
  ws._role = 0;

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return;
    }

    if (msg.t === 'create' && !ws._room) {
      const code = makeCode();
      rooms.set(code, { clients: new Map([[1, ws]]) });
      ws._room = code;
      ws._role = 1;
      send(ws, { t: 'created', room: code });
      console.log(`[room] ${code} created`);
      return;
    }

    // 战绩上报与排行榜查询（与房间无关）
    if (msg.t === 'result') {
      recordResult(String(msg.game ?? 'versus'), String(msg.winner ?? ''), String(msg.loser ?? ''));
      return;
    }
    if (msg.t === 'score') {
      recordScore(String(msg.game ?? 'bullet'), String(msg.name ?? ''), Number(msg.score) || 0);
      return;
    }
    if (msg.t === 'board') {
      send(ws, { t: 'board', game: String(msg.game ?? 'versus'), list: leaderboard(String(msg.game ?? 'versus')) });
      return;
    }

    if (msg.t === 'join' && !ws._room) {
      const room = rooms.get(String(msg.room ?? '').toUpperCase());
      if (!room) return send(ws, { t: 'error', message: '房间不存在' });
      if (room.clients.size >= 2) return send(ws, { t: 'error', message: '房间已满' });
      room.clients.set(2, ws);
      ws._room = String(msg.room).toUpperCase();
      ws._role = 2;
      send(ws, { t: 'joined', role: 2 });
      send(room.clients.get(1), { t: 'start' });
      send(ws, { t: 'start' });
      console.log(`[room] ${ws._room} full, started`);
      return;
    }

    if (msg.t === 'relay' && ws._room) {
      const room = rooms.get(ws._room);
      const peer = room?.clients.get(ws._role === 1 ? 2 : 1);
      if (peer) send(peer, msg);
      return;
    }
  });

  ws.on('close', () => {
    if (ws._room) destroyRoom(ws._room);
  });

  ws.on('error', () => {
    if (ws._room) destroyRoom(ws._room);
  });
});
