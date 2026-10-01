import QRCode from 'qrcode';
import { DGLAB_SOCKET_STATE } from 'dglab-kit';
import type { DeviceManager } from '../devices/device-manager';
import { DEFAULT_RELAY, DEVICE_TYPE_LABEL, type TrackedDevice } from '../devices/types';
import { renderIntensityGauges } from './intensity-gauges';

const STATE_TEXT: Record<string, string> = {
  idle: '未连接',
  connecting: '连接中…',
  waiting_for_peer: '等待 APP 扫码…',
  paired: '已配对',
  disconnected: '已断开',
};

function stateDotClass(state: DGLAB_SOCKET_STATE): string {
  switch (state) {
    case DGLAB_SOCKET_STATE.Paired:
      return 'on';
    case DGLAB_SOCKET_STATE.Connecting:
    case DGLAB_SOCKET_STATE.WaitingForPeer:
      return 'warn';
    case DGLAB_SOCKET_STATE.Disconnected:
      return 'err';
    default:
      return '';
  }
}

/**
 * 设备面板：二维码 / 服务器地址 两个标签页 + 设备列表。
 * 渲染在弹窗 #devices-body 内。
 */
export class PairingScreen {
  private root: HTMLElement;
  private dm: DeviceManager;
  private qrCanvas: HTMLCanvasElement | null = null;
  private renderedQrFor = '';
  private rafPending = false;

  constructor(container: HTMLElement, dm: DeviceManager) {
    this.root = container;
    this.dm = dm;
    this.build();
    dm.subscribe(() => this.scheduleRender());
  }

  private build(): void {
    this.root.innerHTML = `
      <div class="tabs">
        <button class="tab active" data-tab="qr">二维码连接</button>
        <button class="tab" data-tab="addr">服务器地址连接</button>
      </div>

      <div id="tab-qr">
        <div id="qr-box">
          <div class="qr-hint">使用 DG-LAB 4 APP 扫描二维码</div>
          <canvas id="qr-canvas" width="220" height="220" hidden></canvas>
          <div class="qr-sub" id="qr-status">点击下方「生成二维码」开始配对</div>
          <div class="url-line" id="pair-url"></div>
        </div>
        <div class="row">
          <button class="btn" id="btn-qr-connect">生成二维码</button>
          <button class="btn" id="btn-qr-disconnect" disabled>断开连接</button>
        </div>
      </div>

      <div id="tab-addr" hidden>
        <div class="row">
          <label>中继地址</label>
          <input type="text" id="relay-url" value="${DEFAULT_RELAY}" />
        </div>
        <div class="row">
          <button class="btn" id="btn-addr-connect">连接</button>
          <button class="btn" id="btn-addr-disconnect" disabled>断开</button>
        </div>
      </div>

      <div class="sec">实时输出强度</div>
      <div id="intensity-gauges"></div>

      <div class="sec">已连接设备</div>
      <div id="device-list"></div>
      <div class="err-text" id="conn-error"></div>
    `;

    const qrConnect = this.root.querySelector<HTMLButtonElement>('#btn-qr-connect')!;
    const addrConnect = this.root.querySelector<HTMLButtonElement>('#btn-addr-connect')!;
    const qrDisconnect = this.root.querySelector<HTMLButtonElement>('#btn-qr-disconnect')!;
    const addrDisconnect = this.root.querySelector<HTMLButtonElement>('#btn-addr-disconnect')!;

    const doConnect = async (url: string) => {
      qrConnect.disabled = true;
      addrConnect.disabled = true;
      try {
        await this.dm.connect(url);
      } finally {
        qrConnect.disabled = false;
        addrConnect.disabled = false;
      }
    };

    qrConnect.addEventListener('click', () => doConnect(DEFAULT_RELAY));
    addrConnect.addEventListener('click', () => {
      const url = this.root.querySelector<HTMLInputElement>('#relay-url')!.value.trim() || DEFAULT_RELAY;
      void doConnect(url);
    });
    const doDisconnect = () => void this.dm.disconnect();
    qrDisconnect.addEventListener('click', doDisconnect);
    addrDisconnect.addEventListener('click', doDisconnect);

    // 标签页切换
    this.root.querySelectorAll<HTMLButtonElement>('.tab').forEach((tab) => {
      tab.addEventListener('click', () => {
        this.root.querySelectorAll<HTMLButtonElement>('.tab').forEach((t) => t.classList.remove('active'));
        tab.classList.add('active');
        const target = tab.dataset.tab;
        this.root.querySelector<HTMLElement>('#tab-qr')!.hidden = target !== 'qr';
        this.root.querySelector<HTMLElement>('#tab-addr')!.hidden = target !== 'addr';
      });
    });

    this.qrCanvas = this.root.querySelector<HTMLCanvasElement>('#qr-canvas');
    this.render();
  }

  private scheduleRender(): void {
    if (this.rafPending) return;
    this.rafPending = true;
    requestAnimationFrame(() => {
      this.rafPending = false;
      this.render();
    });
  }

  private render(): void {
    const socket = this.dm.raw;
    const busy = this.dm.state === DGLAB_SOCKET_STATE.Connecting;
    const hasSocket = socket !== null;
    const paired = this.dm.connected;

    const qrConnect = this.root.querySelector<HTMLButtonElement>('#btn-qr-connect')!;
    const addrConnect = this.root.querySelector<HTMLButtonElement>('#btn-addr-connect')!;
    const qrDisconnect = this.root.querySelector<HTMLButtonElement>('#btn-qr-disconnect')!;
    const addrDisconnect = this.root.querySelector<HTMLButtonElement>('#btn-addr-disconnect')!;

    qrConnect.disabled = busy || paired;
    addrConnect.disabled = busy || paired;
    qrConnect.textContent = paired ? '已连接' : hasSocket ? '重新生成' : '生成二维码';
    addrConnect.textContent = paired ? '已连接' : '连 接';
    qrDisconnect.disabled = !hasSocket;
    addrDisconnect.disabled = !hasSocket;

    // 二维码
    const qrCanvas = this.qrCanvas;
    const qrStatus = this.root.querySelector<HTMLElement>('#qr-status')!;
    const urlLine = this.root.querySelector<HTMLElement>('#pair-url')!;
    if (qrCanvas) {
      const showQr = hasSocket && this.dm.appLink !== '';
      qrCanvas.hidden = !showQr;
      if (showQr && this.dm.appLink && this.renderedQrFor !== this.dm.appLink) {
        this.renderedQrFor = this.dm.appLink;
        QRCode.toCanvas(qrCanvas, this.dm.appLink, { width: 220, margin: 1 }).catch(() => {
          this.renderedQrFor = '';
        });
      }
    }
    if (!hasSocket) this.renderedQrFor = '';

    if (paired) {
      qrStatus.textContent = '配对成功，开始游戏吧';
    } else if (hasSocket) {
      qrStatus.textContent = STATE_TEXT[this.dm.state] ?? '等待扫码…';
    } else {
      qrStatus.textContent = '点击下方「生成二维码」开始配对';
    }
    urlLine.textContent = paired || hasSocket ? this.dm.appLink : '';

    // 实时强度仪表
    renderIntensityGauges(this.root.querySelector<HTMLElement>('#intensity-gauges')!, this.dm);

    // 设备列表
    const list = this.root.querySelector<HTMLElement>('#device-list')!;
    const devices = this.dm.listDevices();
    if (devices.length === 0) {
      list.innerHTML = `<div class="hint">${paired ? '等待 APP 上报设备…（确保 APP 内已蓝牙连接设备）' : '尚未连接设备'}</div>`;
    } else {
      list.innerHTML = devices
        .map((d) => {
          const cls =
            d.type === 'COYOTE_030' || d.type === 'COYOTE_020' ? 'coyote' : d.type === 'OVC_1' ? 'ovc' : 'bmtr';
          return `<div class="device-card">
            <span class="badge ${cls}">${DEVICE_TYPE_LABEL[d.type] ?? d.type}</span>
            <span class="name">${escapeHtml(d.name)}</span>
            <div class="meta">${this.deviceMeta(d)}</div>
          </div>`;
        })
        .join('');
    }

    const errEl = this.root.querySelector<HTMLElement>('#conn-error')!;
    errEl.textContent = this.dm.lastError;
  }

  private deviceMeta(d: TrackedDevice): string {
    const parts: string[] = [];
    const power = d.props.power;
    if (typeof power === 'number') parts.push(`电量 ${power}%`);

    if (d.type === 'COYOTE_020' || d.type === 'COYOTE_030') {
      const a = this.dm.channelIntensity(d, 'A');
      const b = this.dm.channelIntensity(d, 'B');
      parts.push(`强度 A:${a ?? '-'} B:${b ?? '-'}`);
      if (d.type === 'COYOTE_030' && d.props.channelAStatus === 1) parts.push('A 通道未形成回路');
      if (d.type === 'COYOTE_030' && d.props.channelAStatus === 3) parts.push('A 通道输出异常');
    } else if (d.type === 'OVC_1') {
      const a = this.dm.channelIntensity(d, 'A');
      const b = this.dm.channelIntensity(d, 'B');
      parts.push(`强度 A:${a ?? '-'} B:${b ?? '-'}`);
    } else if (d.type === 'BMTR_1') {
      const p = d.props.pressure;
      parts.push(`压力 ${typeof p === 'number' ? p : '-'}`);
    }

    parts.push(d.slotState.hasDevice === false ? '蓝牙未连接' : '在线');
    return parts.join(' · ');
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}
