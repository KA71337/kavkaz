let current = null;
const GHOST_CLICK_MS = 350;

/** Opens a modal dialog. Only one modal is shown at a time. */
export function openModal(html, { className = '', dismissable = true, onClose } = {}) {
  closeModal();
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  backdrop.innerHTML = `<div class="modal ${className}" role="dialog" aria-modal="true">${html}</div>`;
  const modal = backdrop.firstElementChild;
  const close = () => {
    if (current?.backdrop !== backdrop) return;
    backdrop.remove();
    document.removeEventListener('keydown', onKey);
    current = null;
    onClose?.();
  };
  const onKey = (e) => {
    if (e.key === 'Escape' && dismissable) close();
  };
  // Touch browsers emit a synthetic `click` right after the tap that opened this dialog
  // (e.g. a tap on a map province). It would land on the backdrop or a button under the
  // finger and instantly close/confirm the dialog, so swallow clicks for a short moment.
  const openedAt = performance.now();
  backdrop.addEventListener(
    'click',
    (e) => {
      if (performance.now() - openedAt < GHOST_CLICK_MS) {
        e.stopImmediatePropagation();
        e.preventDefault();
      }
    },
    true,
  );
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop && dismissable) close();
    if (e.target.closest('[data-close]')) close();
  });
  document.addEventListener('keydown', onKey);
  document.getElementById('modal-root').appendChild(backdrop);
  current = { backdrop, modal, close };
  return current;
}

export function closeModal() {
  current?.close();
}

export function isModalOpen() {
  return !!current;
}
