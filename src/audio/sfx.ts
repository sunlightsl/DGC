/**
 * 游戏音效：Web Audio 实时合成，零音频资源文件。
 * 由设备设置-基础区控制开关与音量；首次用户交互后自动激活 AudioContext。
 */

export type SfxName = 'hit' | 'shock' | 'shot' | 'empty' | 'victory' | 'defeat' | 'gem' | 'click' | 'match';

let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let enabled = true;
let volume = 0.5;

export function configureSfx(opts: { enabled?: boolean; volume?: number }): void {
  if (opts.enabled !== undefined) enabled = opts.enabled;
  if (opts.volume !== undefined) volume = Math.min(1, Math.max(0, opts.volume));
  if (master) master.gain.value = enabled ? volume : 0;
}

function ensureCtx(): AudioContext | null {
  if (ctx) {
    if (ctx.state === 'suspended') void ctx.resume();
    return ctx;
  }
  try {
    ctx = new AudioContext();
    master = ctx.createGain();
    master.gain.value = enabled ? volume : 0;
    master.connect(ctx.destination);
  } catch {
    ctx = null;
  }
  return ctx;
}

function tone(c: AudioContext, type: OscillatorType, freq: number, dur: number, gain: number, slideTo?: number): void {
  const osc = c.createOscillator();
  const g = c.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, c.currentTime);
  if (slideTo) osc.frequency.exponentialRampToValueAtTime(Math.max(1, slideTo), c.currentTime + dur);
  g.gain.setValueAtTime(gain, c.currentTime);
  g.gain.exponentialRampToValueAtTime(0.001, c.currentTime + dur);
  osc.connect(g).connect(master!);
  osc.start();
  osc.stop(c.currentTime + dur + 0.02);
}

function noise(c: AudioContext, dur: number, gain: number, filterType: BiquadFilterType, freq: number, slideTo?: number): void {
  const len = Math.max(1, Math.floor(c.sampleRate * dur));
  const buf = c.createBuffer(1, len, c.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
  const src = c.createBufferSource();
  src.buffer = buf;
  const f = c.createBiquadFilter();
  f.type = filterType;
  f.frequency.setValueAtTime(freq, c.currentTime);
  if (slideTo) f.frequency.exponentialRampToValueAtTime(Math.max(1, slideTo), c.currentTime + dur);
  const g = c.createGain();
  g.gain.setValueAtTime(gain, c.currentTime);
  g.gain.exponentialRampToValueAtTime(0.001, c.currentTime + dur);
  src.connect(f).connect(g).connect(master!);
  src.start();
}

export function playSfx(name: SfxName): void {
  if (!enabled) return;
  const c = ensureCtx();
  if (!c || !master) return;
  switch (name) {
    case 'hit':
      tone(c, 'square', 190, 0.09, 0.25, 120);
      noise(c, 0.05, 0.15, 'highpass', 2000);
      break;
    case 'shock':
      noise(c, 0.28, 0.35, 'bandpass', 1600, 300);
      tone(c, 'sawtooth', 90, 0.2, 0.12, 50);
      break;
    case 'shot':
      noise(c, 0.4, 0.6, 'lowpass', 900, 120);
      tone(c, 'sine', 70, 0.3, 0.5, 35);
      break;
    case 'empty':
      tone(c, 'square', 1300, 0.04, 0.18, 900);
      break;
    case 'victory':
      tone(c, 'sine', 523, 0.14, 0.3);
      setTimeout(() => tone(c, 'sine', 659, 0.14, 0.3), 110);
      setTimeout(() => tone(c, 'sine', 784, 0.24, 0.32), 220);
      break;
    case 'defeat':
      tone(c, 'sine', 330, 0.22, 0.3, 260);
      setTimeout(() => tone(c, 'sine', 220, 0.4, 0.3, 150), 180);
      break;
    case 'gem':
      tone(c, 'sine', 880, 0.07, 0.18, 990);
      break;
    case 'click':
      tone(c, 'square', 660, 0.035, 0.12);
      break;
    case 'match':
      tone(c, 'sine', 880, 0.1, 0.25);
      setTimeout(() => tone(c, 'sine', 1174, 0.18, 0.25), 100);
      break;
  }
}
