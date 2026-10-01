/**
 * 开发模式启动器：同时拉起 Vite dev server 和对战房间服务器。
 * 任一进程退出时另一个一并关闭。
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const procs = [
  spawn(process.execPath, [path.join(root, 'node_modules', 'vite', 'bin', 'vite.js')], {
    stdio: 'inherit',
    cwd: root,
  }),
  spawn(process.execPath, [path.join(root, 'server', 'room-server.mjs')], {
    stdio: 'inherit',
    cwd: root,
    env: { ...process.env, PORT: process.env.PORT ?? '8787' },
  }),
];

let shuttingDown = false;
function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const p of procs) {
    if (!p.killed) p.kill('SIGTERM');
  }
  setTimeout(() => process.exit(code), 300);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

for (const p of procs) {
  p.on('exit', (code) => {
    if (!shuttingDown) shutdown(code ?? 0);
  });
  p.on('error', () => shutdown(1));
}
