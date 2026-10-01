/** 全局昵称档案：所有游戏与排行榜共用一个昵称 */

const KEY = 'dg-nickname';

export function getNickname(): string {
  return (localStorage.getItem(KEY) ?? '').trim();
}

export function setNickname(name: string): void {
  localStorage.setItem(KEY, name.trim().slice(0, 12));
}

/** 未设置时给一个临时名（首次进入自动生成，可在档案页改）；兼容旧的大厅昵称 */
export function ensureNickname(): string {
  let nick = getNickname();
  if (!nick) {
    const legacy = (localStorage.getItem('dg-battle-nickname') ?? '').trim();
    nick = legacy || '玩家' + Math.floor(1000 + Math.random() * 9000);
    setNickname(nick);
  }
  return nick;
}
