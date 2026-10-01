import { DglabSocketDeviceType } from 'dglab-kit';
import type { DeviceManager } from '../devices/device-manager';

const R = 52;
const CIRC = 2 * Math.PI * R;

/**
 * 实时输出强度仪表：为每台郊狼主机渲染 A/B 双通道环形表盘。
 * 由 PairingScreen 的渲染循环驱动（dm 状态变化时刷新），数值来自
 * 设备 props 的 intensityA/intensityB（APP 按 tick 上报增量）。
 */
export function renderIntensityGauges(container: HTMLElement, dm: DeviceManager): void {
  const coyotes = [
    ...dm.listByType(DglabSocketDeviceType.COYOTE_030),
    ...dm.listByType(DglabSocketDeviceType.COYOTE_020),
  ];

  if (coyotes.length === 0) {
    container.innerHTML = '<div class="hint">尚未连接郊狼主机</div>';
    return;
  }

  const showName = coyotes.length > 1;
  container.innerHTML = coyotes
    .map((d, i) => {
      const a = dm.channelIntensity(d, 'A') ?? 0;
      const b = dm.channelIntensity(d, 'B') ?? 0;
      const maxA = dm.channelMax(d, 'A');
      const maxB = dm.channelMax(d, 'B');
      const name = showName ? `<div class="gauge-device-name">${escapeHtml(d.name)}</div>` : '';
      return `${name}
        <div class="gauge-row">
          ${gaugeHtml(`g${i}a`, a, maxA, '通道 A (左)')}
          ${gaugeHtml(`g${i}b`, b, maxB, '通道 B (右)')}
        </div>`;
    })
    .join('');
}

function gaugeHtml(id: string, value: number, max: number, label: string): string {
  const ratio = Math.min(1, Math.max(0, max > 0 ? value / max : 0));
  const offset = CIRC * (1 - ratio);
  return `
    <div class="gauge">
      <svg viewBox="0 0 120 120" width="132" height="132" role="img" aria-label="${label} 强度 ${value}">
        <circle class="gauge-track" cx="60" cy="60" r="${R}" />
        <circle
          class="gauge-fill"
          cx="60" cy="60" r="${R}"
          stroke-dasharray="${CIRC.toFixed(2)}"
          stroke-dashoffset="${offset.toFixed(2)}"
          transform="rotate(-90 60 60)"
        />
        <text x="60" y="57" class="gauge-value" text-anchor="middle">${value}</text>
        <text x="60" y="75" class="gauge-max" text-anchor="middle">MAX ${max}</text>
      </svg>
      <div class="gauge-label">${label}</div>
    </div>`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/**
 * 按原始数值渲染一对 A/B 环形仪表（对战顶部面板用：
 * 自己传本机 dm 读数，对方传网络同步来的数值）。
 */
export function renderGaugePair(
  container: HTMLElement,
  a: number,
  b: number,
  maxA: number,
  maxB: number,
): void {
  container.innerHTML = `<div class="gauge-row">
    ${gaugeHtml('pa', a, maxA, '通道 A (左)')}
    ${gaugeHtml('pb', b, maxB, '通道 B (右)')}
  </div>`;
}
