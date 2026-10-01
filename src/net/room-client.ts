export type RoomMessage = Record<string, unknown> & { t: string };

type MessageHandler = (msg: RoomMessage) => void;

/**
 * 房间客户端：封装对战房间的 WebSocket 连接。
 * 双方就位后服务器发 start，此后所有 {t:'relay', ...} 帧原样转发给对端。
 */
export class RoomClient {
  private ws: WebSocket | null = null;
  private handlers = new Set<MessageHandler>();
  private closeHandlers = new Set<() => void>();
  private pendingResolvers = new Map<string, (msg: RoomMessage) => void>();

  serverUrl = '';
  roomCode = '';
  role: 1 | 2 | 0 = 0;
  connected = false;

  onMessage(fn: MessageHandler): () => void {
    this.handlers.add(fn);
    return () => this.handlers.delete(fn);
  }

  onClose(fn: () => void): () => void {
    this.closeHandlers.add(fn);
    return () => this.closeHandlers.delete(fn);
  }

  private waitFor(type: string, timeoutMs = 8000): Promise<RoomMessage> {
    return new Promise((resolve, reject) => {
      const timer =
        timeoutMs > 0
          ? setTimeout(() => {
              this.pendingResolvers.delete(type);
              reject(new Error(`等待 ${type} 超时`));
            }, timeoutMs)
          : null;
      this.pendingResolvers.set(type, (msg) => {
        if (timer) clearTimeout(timer);
        resolve(msg);
      });
    });
  }

  async connect(url: string): Promise<void> {
    this.close();
    this.serverUrl = url.trim();
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(this.serverUrl);
      const timer = setTimeout(() => reject(new Error('连接服务器超时')), 8000);
      ws.addEventListener('open', () => {
        clearTimeout(timer);
        this.ws = ws;
        this.connected = true;
        resolve();
      });
      ws.addEventListener('error', () => {
        clearTimeout(timer);
        reject(new Error('无法连接到对战服务器'));
      });
      ws.addEventListener('close', () => {
        this.connected = false;
        for (const fn of this.closeHandlers) fn();
      });
      ws.addEventListener('message', (e) => {
        let msg: RoomMessage;
        try {
          msg = JSON.parse(String(e.data)) as RoomMessage;
        } catch {
          return;
        }
        const waiter = this.pendingResolvers.get(msg.t);
        if (waiter) {
          this.pendingResolvers.delete(msg.t);
          waiter(msg);
        }
        for (const fn of this.handlers) fn(msg);
      });
    });
  }

  async createRoom(): Promise<string> {
    const done = this.waitFor('created');
    this.sendRaw({ t: 'create' });
    const msg = await done;
    this.roomCode = String(msg.room);
    this.role = 1;
    return this.roomCode;
  }

  /** 等待对端加入（服务器发 start）；房主可能等很久，不设超时 */
  waitStart(): Promise<void> {
    return this.waitFor('start', 0).then(() => undefined);
  }

  async joinRoom(code: string): Promise<void> {
    const joined = this.waitFor('joined');
    const started = this.waitFor('start');
    this.sendRaw({ t: 'join', room: code.toUpperCase() });
    await joined;
    this.roomCode = code.toUpperCase();
    this.role = 2;
    await started;
  }

  send(payload: Record<string, unknown>): void {
    this.sendRaw({ ...payload, t: 'relay' });
  }

  /** 上报战绩（直接给服务器，不进房间转发） */
  reportResult(game: string, winner: string, loser: string): void {
    this.sendRaw({ t: 'result', game, winner, loser });
  }

  /** 上报单机最高分 */
  reportScore(game: string, name: string, score: number): void {
    this.sendRaw({ t: 'score', game, name, score });
  }

  /** 查询某游戏排行榜（前 20） */
  requestBoard(game: 'versus' | 'bullet'): Promise<{ name: string; wins: number; losses: number; rate: number; best: number; games: number }[]> {
    const done = this.waitFor('board');
    this.sendRaw({ t: 'board', game });
    return done.then(
      (msg) => (Array.isArray(msg.list) ? msg.list : []) as { name: string; wins: number; losses: number; rate: number; best: number; games: number }[],
    );
  }

  private sendRaw(payload: RoomMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(payload));
    }
  }

  close(): void {
    this.ws?.close();
    this.ws = null;
    this.connected = false;
    this.roomCode = '';
    this.role = 0;
  }
}
