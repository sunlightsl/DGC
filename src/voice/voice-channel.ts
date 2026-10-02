import type { RoomClient, RoomMessage } from '../net/room-client';

/**
 * 局内语音频道（1v1 直连）：
 * - WebRTC P2P，服务器只经房间 relay 转发信令（offer/answer/ICE），零媒体负载
 * - 端到端加密：双方临时 ECDH(P-256) 派生 AES-GCM 密钥（可导出 raw 供 Worker），
 *   经 RTCRtpScriptTransform 对 RTP 帧加解密（Chromium 系支持）
 * - 不支持 Insertable Streams 的浏览器回退为纯 DTLS-SRTP 传输加密，状态栏如实标注
 * - 信令走 perfect negotiation（加入方为 polite）
 */

export type VoiceState = 'idle' | 'wait-key' | 'wait-peer' | 'connecting' | 'connected' | 'ended';
export type VoiceMode = 'e2ee' | 'dtls';

export interface VoiceHandlers {
  onState: (state: VoiceState, mode: VoiceMode) => void;
  onLocalStream: (stream: MediaStream | null) => void;
  /** 密钥/信令错误上屏（不再静默） */
  onError?: (message: string) => void;
}

function b64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function unb64(str: string): ArrayBuffer {
  const s = atob(str);
  const bytes = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i);
  return bytes.buffer;
}

export class VoiceChannel {
  private room: RoomClient;
  private role: 1 | 2;
  private handlers: VoiceHandlers;
  private pc: RTCPeerConnection | null = null;
  private worker: Worker | null = null;
  private localStream: MediaStream | null = null;
  private keyPair: CryptoKeyPair | null = null;
  private rawKey: ArrayBuffer | null = null;
  private aesKey: CryptoKey | null = null;
  private offMsg: (() => void) | null = null;
  private publishTimer: ReturnType<typeof setInterval> | null = null;
  private makingOffer = false;
  private ignoreOffer = false;
  private micTrack: MediaStreamTrack | null = null;
  private remoteAudio: HTMLAudioElement | null = null;
  private destroyed = false;
  private started = false;
  private pendingPeerPub: string | null = null;

  /** 是否支持帧级端到端加密 */
  readonly supportsE2EE = typeof (globalThis as { RTCRtpScriptTransform?: unknown }).RTCRtpScriptTransform !== 'undefined';

  constructor(room: RoomClient, role: 1 | 2, handlers: VoiceHandlers) {
    this.room = room;
    this.role = role;
    this.handlers = handlers;
  }

  get mode(): VoiceMode {
    return this.supportsE2EE ? 'e2ee' : 'dtls';
  }

  /** 发起通话：申请麦克风 → 交换语音密钥 → P2P 建连 */
  async start(): Promise<void> {
    if (this.started || this.destroyed) return;
    this.started = true;
    try {
      this.localStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
      });
    } catch {
      this.handlers.onState('ended', this.mode);
      this.started = false;
      throw new Error('无法访问麦克风（请检查浏览器权限）');
    }
    this.micTrack = this.localStream.getAudioTracks()[0] ?? null;
    this.handlers.onLocalStream(this.localStream);
    this.handlers.onState('wait-key', this.mode);

    this.offMsg = this.room.onMessage((msg) => void this.handle(msg));
    this.keyPair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveKey']);
    const pub = b64(await crypto.subtle.exportKey('spki', this.keyPair.publicKey));
    // 若对方密钥早就到了（自己当时在申请麦克风），现在补派生
    if (this.pendingPeerPub) {
      const pending = this.pendingPeerPub;
      this.pendingPeerPub = null;
      void this.derive(pending);
    }
    const publish = () => this.room.send({ kind: 'voiceKey', pub });
    publish();
    this.publishTimer = setInterval(publish, 1200);
  }

  private async handle(msg: RoomMessage): Promise<void> {
    if (this.destroyed) return;
    if (msg.kind === 'voiceKey') {
      if (this.aesKey) return;
      // 自己密钥还没生成好（对方先到）：缓存，生成后补派生
      if (!this.keyPair) {
        this.pendingPeerPub = String(msg.pub ?? '');
        return;
      }
      await this.derive(String(msg.pub ?? ''));
      return;
    }
    if (msg.kind !== 'vsig') return;
    const data = msg.data as { desc?: RTCSessionDescriptionInit; candidate?: RTCIceCandidateInit } | null;
    if (!this.pc || !data) return;
    try {
      if (data.desc) {
        const polite = this.role === 2;
        const offerCollision = data.desc.type === 'offer' && (this.makingOffer || this.pc.signalingState !== 'stable');
        this.ignoreOffer = !polite && offerCollision;
        if (this.ignoreOffer) return;
        await this.pc.setRemoteDescription(data.desc);
        if (data.desc.type === 'offer') {
          await this.pc.setLocalDescription();
          this.sendSig({ desc: this.pc.localDescription! });
        }
      } else if (data.candidate) {
        try {
          await this.pc.addIceCandidate(data.candidate);
        } catch (err) {
          if (!this.ignoreOffer) throw err;
        }
      }
    } catch (err) {
      this.handlers.onError?.(`信令错误：${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** ECDH 派生语音密钥（可导出 raw 供 Worker），随后建立 P2P */
  private async derive(peerB64: string): Promise<boolean> {
    try {
      const peerKey = await crypto.subtle.importKey('spki', unb64(peerB64), { name: 'ECDH', namedCurve: 'P-256' }, false, []);
      this.aesKey = await crypto.subtle.deriveKey(
        { name: 'ECDH', public: peerKey },
        this.keyPair!.privateKey,
        { name: 'AES-GCM', length: 256 },
        true,
        ['encrypt', 'decrypt'],
      );
      this.rawKey = await crypto.subtle.exportKey('raw', this.aesKey);
      if (this.publishTimer) {
        clearInterval(this.publishTimer);
        this.publishTimer = null;
      }
      this.setupPeerConnection();
      return true;
    } catch (err) {
      this.handlers.onError?.(`语音密钥派生失败：${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  private setupPeerConnection(): void {
    if (this.destroyed || this.pc) return;
    this.handlers.onState('connecting', this.mode);
    try {
      this.pc = new RTCPeerConnection({ iceServers: [] }); // 纯 P2P/LAN；公网对称 NAT 需另配 TURN
      if (this.supportsE2EE) {
        this.worker = new Worker(new URL('../voice/voice-worker.ts', import.meta.url), { type: 'module' });
      }
      this.attachLocalTrack();
      this.wireSignaling();
    } catch (err) {
      this.handlers.onError?.(`P2P 初始化失败：${err instanceof Error ? err.message : String(err)}`);
      this.handlers.onState('ended', this.mode);
    }
  }

  private attachLocalTrack(): void {
    if (!this.pc || !this.micTrack || !this.localStream) return;
    const sender = this.pc.addTrack(this.micTrack, this.localStream);
    if (this.worker && this.rawKey) {
      sender.transform = new RTCRtpScriptTransform(this.worker, { key: this.rawKey.slice(0), op: 'encrypt' });
    }
  }

  private wireSignaling(): void {
    if (!this.pc) return;
    this.pc.onicecandidate = (e) => {
      if (e.candidate) this.sendSig({ candidate: e.candidate.toJSON() });
    };
    this.pc.onnegotiationneeded = async () => {
      try {
        this.makingOffer = true;
        await this.pc!.setLocalDescription();
        this.sendSig({ desc: this.pc!.localDescription! });
      } catch (err) {
        this.handlers.onError?.(`协商失败：${err instanceof Error ? err.message : String(err)}`);
      } finally {
        this.makingOffer = false;
      }
    };
    this.pc.ontrack = (e) => {
      try {
        const receiver = e.receiver;
        if (this.worker && this.rawKey) {
          receiver.transform = new RTCRtpScriptTransform(this.worker, { key: this.rawKey.slice(0), op: 'decrypt' });
        }
        const stream = e.streams[0] ?? new MediaStream([e.track]);
        this.remoteAudio = new Audio();
        this.remoteAudio.srcObject = stream;
        this.remoteAudio.autoplay = true;
        this.handlers.onState('connected', this.mode);
      } catch (err) {
        this.handlers.onError?.(`接听失败：${err instanceof Error ? err.message : String(err)}`);
      }
    };
    this.pc.onconnectionstatechange = () => {
      const st = this.pc?.connectionState;
      if (st === 'connected') this.handlers.onState('connected', this.mode);
      if (st === 'failed' || st === 'disconnected' || st === 'closed') this.handlers.onState('ended', this.mode);
    };
    this.pc.oniceconnectionstatechange = () => {
      const st = this.pc?.iceConnectionState;
      if (st === 'failed') {
        this.handlers.onError?.('P2P 连接失败：双方网络可能无法直连（对称 NAT 需 TURN 服务器）');
        this.handlers.onState('ended', this.mode);
      }
    };
  }

  private sendSig(data: { desc?: RTCSessionDescriptionInit; candidate?: RTCIceCandidateInit }): void {
    this.room.send({ kind: 'vsig', data });
  }

  /** 静音切换，返回当前是否静音 */
  toggleMute(): boolean {
    if (!this.micTrack) return true;
    this.micTrack.enabled = !this.micTrack.enabled;
    return !this.micTrack.enabled;
  }

  get ready(): boolean {
    return this.aesKey !== null;
  }

  get muted(): boolean {
    return this.micTrack ? !this.micTrack.enabled : true;
  }

  destroy(): void {
    this.destroyed = true;
    if (this.publishTimer) clearInterval(this.publishTimer);
    this.offMsg?.();
    this.micTrack?.stop();
    this.localStream?.getTracks().forEach((t) => t.stop());
    this.remoteAudio?.pause();
    this.remoteAudio = null;
    this.pc?.close();
    this.worker?.terminate();
    this.pc = null;
    this.worker = null;
    this.handlers.onLocalStream(null);
    this.handlers.onState('ended', this.mode);
  }
}
