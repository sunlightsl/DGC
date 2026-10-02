/**
 * 端到端加密通道：ECDH(P-256) 协商会话密钥 + AES-GCM 加密。
 * 服务器只转发公钥与密文，永远见不到明文。
 * 明文一律以字符串处理（图片走 dataURL 文本），加解密接口统一。
 */

const subtle = crypto.subtle;

function bufToB64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

function b64ToBuf(b64: string): ArrayBuffer {
  const s = atob(b64);
  const bytes = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i);
  return bytes.buffer;
}

export class E2EChannel {
  private keyPair: CryptoKeyPair | null = null;
  private aesKey: CryptoKey | null = null;
  private peerKeyB64 = '';

  /** 生成临时密钥对，返回可广播的公钥（base64 SPKI） */
  async init(): Promise<string> {
    this.keyPair = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveKey']);
    const spki = await subtle.exportKey('spki', this.keyPair.publicKey);
    return bufToB64(spki);
  }

  /** 收到对方公钥 → 派生 AES-GCM 会话密钥 */
  async onPeerKey(peerB64: string): Promise<boolean> {
    if (this.aesKey || !this.keyPair) return this.aesKey !== null;
    this.peerKeyB64 = peerB64;
    const peerKey = await subtle.importKey(
      'spki',
      b64ToBuf(peerB64),
      { name: 'ECDH', namedCurve: 'P-256' },
      false,
      [],
    );
    this.aesKey = await subtle.deriveKey(
      { name: 'ECDH', public: peerKey },
      this.keyPair.privateKey,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt'],
    );
    return true;
  }

  get ready(): boolean {
    return this.aesKey !== null;
  }

  /** 加密文本/图片 dataURL → {iv, cipher} 均为 base64 */
  async encrypt(plaintext: string): Promise<{ iv: string; cipher: string }> {
    if (!this.aesKey) throw new Error('加密通道未就绪');
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const cipher = await subtle.encrypt(
      { name: 'AES-GCM', iv },
      this.aesKey,
      new TextEncoder().encode(plaintext),
    );
    return { iv: bufToB64(iv.buffer), cipher: bufToB64(cipher) };
  }

  async decrypt(iv: string, cipher: string): Promise<string> {
    if (!this.aesKey) throw new Error('加密通道未就绪');
    const plain = await subtle.decrypt(
      { name: 'AES-GCM', iv: new Uint8Array(b64ToBuf(iv)) },
      this.aesKey,
      b64ToBuf(cipher),
    );
    return new TextDecoder().decode(plain);
  }
}
