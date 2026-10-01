/** 键盘输入状态追踪 */
export class Input {
  private keys = new Set<string>();
  private pressedThisFrame = new Set<string>();

  constructor(target: Window) {
    target.addEventListener('keydown', (e) => {
      const key = e.key.toLowerCase();
      if (!this.keys.has(key)) this.pressedThisFrame.add(key);
      this.keys.add(key);
      // 防止方向键/空格滚动页面
      if (['arrowup', 'arrowdown', 'arrowleft', 'arrowright', ' '].includes(key)) {
        e.preventDefault();
      }
    });
    target.addEventListener('keyup', (e) => {
      this.keys.delete(e.key.toLowerCase());
    });
    target.addEventListener('blur', () => this.keys.clear());
  }

  down(key: string): boolean {
    return this.keys.has(key.toLowerCase());
  }

  /** 只在按下的那一帧返回 true */
  pressed(key: string): boolean {
    return this.pressedThisFrame.has(key.toLowerCase());
  }

  endFrame(): void {
    this.pressedThisFrame.clear();
  }
}
