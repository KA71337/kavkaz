import { esc } from './dom.js';

const root = () => document.getElementById('toasts');
const ICONS = { info: 'ℹ️', error: '⛔', warn: '⚠️', ok: '✅', war: '⚔️' };

export function toast(text, type = 'info', ms = 3200) {
  const el = document.createElement('div');
  el.className = `toast ${type === 'war' ? 'error' : type}`;
  el.innerHTML = `<span>${ICONS[type] || ICONS.info}</span><span>${esc(text)}</span>`;
  const box = root();
  box.appendChild(el);
  while (box.children.length > 4) box.firstElementChild.remove();
  const close = () => {
    el.classList.add('out');
    setTimeout(() => el.remove(), 300);
  };
  el.addEventListener('click', close);
  setTimeout(close, ms);
}
