import { getNickname, setNickname } from '../profile';

/**
 * 昵称档案弹窗：全局唯一昵称，弹幕/消消乐与排行榜统一读取。
 * 首次进入自动生成临时名，在此修改后所有游戏即时生效。
 */
export class ProfilePanel {
  constructor(container: HTMLElement) {
    container.innerHTML = `
      <div class="sec">昵称档案</div>
      <div class="sec-note">所有游戏与排行榜共用一个昵称（1-12 字）。首次进入会自动生成临时名，可在此修改。</div>
      <div class="row">
        <label>昵称</label>
        <input type="text" id="profile-nick" maxlength="12" value="${escapeHtml(getNickname())}" />
      </div>
      <div class="row" style="justify-content:flex-end">
        <button class="btn-gold" id="profile-save">保 存</button>
      </div>
      <div class="hint" id="profile-msg" style="text-align:center; min-height:18px"></div>
    `;

    const input = container.querySelector<HTMLInputElement>('#profile-nick')!;
    const msg = container.querySelector<HTMLElement>('#profile-msg')!;
    const save = () => {
      const v = input.value.trim();
      if (!v) {
        msg.textContent = '昵称不能为空';
        return;
      }
      setNickname(v);
      input.value = getNickname();
      msg.textContent = '已保存，全部游戏生效';
      setTimeout(() => {
        msg.textContent = '';
      }, 1600);
    };
    container.querySelector<HTMLButtonElement>('#profile-save')!.addEventListener('click', save);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') save();
    });
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}
