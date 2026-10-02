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

  async connect(url: string, token = ''): Promise<void> {
    this.close();
    this.serverUrl = url.trim();
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(this.serverUrl);
      const timer = setTimeout(() => reject(new Error('连接服务器超时')), 8000);
      ws.addEventListener('open', () => {
        clearTimeout(timer);
        if (!token) {
          this.ws = ws;
          this.connected = true;
          resolve();
          return;
        }
        // 有令牌：先走 auth 握手，通过后才算连接成功
        const authTimer = setTimeout(() => reject(new Error('鉴权超时')), 5000);
        const onAuthMsg = (e: MessageEvent) => {
          let msg: RoomMessage;
          try {
            msg = JSON.parse(String(e.data)) as RoomMessage;
          } catch {
            return;
          }
          if (msg.t === 'authOk') {
            clearTimeout(authTimer);
            this.ws = ws;
            this.connected = true;
            resolve();
          } else if (msg.t === 'authFail') {
            clearTimeout(authTimer);
            ws.close();
            reject(new Error('登录状态已失效，请重新登录'));
          }
        };
        ws.addEventListener('message', onAuthMsg, { once: false });
        ws.send(JSON.stringify({ t: 'auth', token }));
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

  async createRoom(game = 'versus'): Promise<string> {
    const done = this.waitFor('created');
    this.sendRaw({ t: 'create', game });
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

  /** 上报昵称：服务器用于在线统计与匹配展示 */
  hello(nick: string): void {
    this.sendRaw({ t: 'hello', nick });
  }

  private matchReject: ((msg: string) => void) | null = null;

  /** 随机匹配：进入指定游戏队列（'any' 不限）并等待 matched → start；cancelMatch() 可取消 */
  matchmake(game: string): Promise<'versus' | 'roulette'> {
    return new Promise<'versus' | 'roulette'>((resolve, reject) => {
      const matched = this.waitFor('matched', 0);
      // 匹配可能要等很久，start 也不能用默认 8 秒超时
      const started = this.waitFor('start', 0);
      const bail = (msg: string) => {
        this.sendRaw({ t: 'unmatch' }); // 失败/取消都确保离开服务器队列
        this.pendingResolvers.delete('matched');
        this.pendingResolvers.delete('start');
        this.matchReject = null;
        reject(new Error(msg));
      };
      this.matchReject = bail;
      this.sendRaw({ t: 'match', game });
      matched.then(
        (msg) => {
          this.matchReject = null;
          this.roomCode = String(msg.room);
          this.role = Number(msg.role) === 1 ? 1 : 2;
          const resolvedGame = (String(msg.game) === 'roulette' ? 'roulette' : 'versus') as 'versus' | 'roulette';
          started.then(
            () => resolve(resolvedGame),
            () => bail('匹配失败，请重试'),
          );
        },
        () => bail('匹配失败，请重试'),
      );
    });
  }

  /** 离开匹配队列（使进行中的 matchmake() 以异常结束） */
  cancelMatch(): void {
    this.matchReject?.('已取消匹配');
    this.matchReject = null;
  }

  /** 等待邀战被接受后服务器下发的 matched → start（双方共用） */
  waitMatched(): Promise<{ room: string; role: 1 | 2; peer: string; game: string }> {
    return new Promise((resolve, reject) => {
      const matched = this.waitFor('matched', 0);
      const started = this.waitFor('start', 30_000);
      matched.then(
        (msg) => {
          const role: 1 | 2 = Number(msg.role) === 1 ? 1 : 2;
          this.roomCode = String(msg.room);
          this.role = role;
          started.then(
            () => resolve({ room: this.roomCode, role, peer: String(msg.peer ?? ''), game: String(msg.game ?? 'versus') }),
            () => reject(new Error('开局超时')),
          );
        },
        (err) => reject(err),
      );
    });
  }

  send(payload: Record<string, unknown>): void {
    this.sendRaw({ ...payload, t: 'relay' });
  }

  /** 上报战绩（直接给服务器，不进房间转发）；比分用于公示区 */
  reportResult(game: string, winner: string, loser: string, winScore?: number, loseScore?: number): void {
    this.sendRaw({ t: 'result', game, winner, loser, winScore, loseScore });
  }

  /** 上报单机最高分 */
  reportScore(game: string, name: string, score: number): void {
    this.sendRaw({ t: 'score', game, name, score });
  }

  /** 查询某游戏排行榜（前 20） */
  requestBoard(game: 'versus' | 'bullet' | 'roulette'): Promise<{ name: string; wins: number; losses: number; rate: number; best: number; games: number }[]> {
    const done = this.waitFor('board');
    this.sendRaw({ t: 'board', game });
    return done.then(
      (msg) => (Array.isArray(msg.list) ? msg.list : []) as { name: string; wins: number; losses: number; rate: number; best: number; games: number }[],
    );
  }

  /** 查询公示区记录（最近的公开对局） */
  requestRecords(game?: string, limit = 50): Promise<{ game: string; winner: string; loser: string; winScore: number; loseScore: number; time: string }[]> {
    const done = this.waitFor('records');
    this.sendRaw({ t: 'records', game, limit });
    return done.then(
      (msg) => (Array.isArray(msg.list) ? msg.list : []) as { game: string; winner: string; loser: string; winScore: number; loseScore: number; time: string }[],
    );
  }

  // ===== 大厅 =====

  sendChat(text: string): void {
    this.sendRaw({ t: 'chat', text });
  }

  requestOnline(): void {
    this.sendRaw({ t: 'who' });
  }

  sendInvite(to: string, game: string): void {
    this.sendRaw({ t: 'invite', to, game });
  }

  replyInvite(inviteId: string, accept: boolean): void {
    this.sendRaw({ t: 'inviteReply', inviteId, accept });
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
