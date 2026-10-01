/** 弹窗开关工具：backdrop 点击、✕ 按钮、Esc 均可关闭 */
export function setupModals(): void {
  document.querySelectorAll<HTMLElement>('.modal-backdrop').forEach((backdrop) => {
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) hideModal(backdrop);
    });
    backdrop.querySelectorAll<HTMLElement>('[data-close]').forEach((btn) => {
      btn.addEventListener('click', () => hideModal(backdrop));
    });
  });

  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      document.querySelectorAll<HTMLElement>('.modal-backdrop').forEach((m) => {
        if (!m.hidden) hideModal(m);
      });
    }
  });
}

export function showModal(el: HTMLElement): void {
  el.hidden = false;
}

export function hideModal(el: HTMLElement): void {
  el.hidden = true;
}

export function isModalOpen(el: HTMLElement): boolean {
  return !el.hidden;
}
