/**
 * 语音加解密 Worker（Insertable Streams）：
 * sender 帧：随机 IV + AES-GCM 密文拼装进 frame.data
 * receiver 帧：拆 IV 解密还原
 * key 由主线程以 raw ArrayBuffer 传入（语音通道独立的 ECDH 密钥对派生，可导出）
 */

let key: CryptoKey | null = null;
let mode: 'encrypt' | 'decrypt' | '' = '';

self.onmessage = async (e: MessageEvent) => {
  const d = e.data as { key?: ArrayBuffer; op?: 'encrypt' | 'decrypt' } | null;
  if (d?.key && d.op) {
    key = await crypto.subtle.importKey('raw', d.key, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
    mode = d.op;
  }
};

(self as unknown as { onrtctransform: (e: unknown) => void }).onrtctransform = (event: unknown) => {
  const { transformer } = event as { transformer: { readable: ReadableStream; writable: WritableStream } };
  const reader = transformer.readable.getReader();
  const writer = transformer.writable.getWriter();
  void (async () => {
    for (;;) {
      const { value: frame, done } = await reader.read();
      if (done) break;
      if (key && mode && frame?.data) {
        try {
          if (mode === 'encrypt') {
            const plain = new Uint8Array(frame.data as ArrayBuffer);
            const iv = crypto.getRandomValues(new Uint8Array(12));
            const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plain));
            const out = new Uint8Array(12 + cipher.byteLength);
            out.set(iv, 0);
            out.set(cipher, 12);
            frame.data = out.buffer;
          } else {
            const data = new Uint8Array(frame.data as ArrayBuffer);
            if (data.byteLength > 12) {
              const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: data.slice(0, 12) }, key, data.slice(12));
              frame.data = plain;
            }
          }
        } catch {
          // 解密失败的帧直接丢弃（GCM 认证失败等）
        }
      }
      await writer.write(frame);
    }
  })();
};

export {};
