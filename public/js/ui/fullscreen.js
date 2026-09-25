// "⛶ Полный экран" for phones/tablets: Fullscreen API + landscape lock (Screen Orientation API).
// Every step is optional: if an API is missing or rejected the game keeps working, and a hint
// asks the player to rotate the phone manually.
import { $ } from './dom.js';

const ROTATE_TEXT = 'Поверните телефон горизонтально для лучшего игрового режима';

const fsElement = () => document.fullscreenElement || document.webkitFullscreenElement || null;
const isPortrait = () => (window.matchMedia ? matchMedia('(orientation: portrait)').matches : innerHeight > innerWidth);

function requestFs(el) {
  const fn = el.requestFullscreen || el.webkitRequestFullscreen;
  if (!fn) return Promise.reject(new Error('Fullscreen API unavailable'));
  try {
    // navigationUI: 'hide' asks mobile browsers to hide their own bars
    return Promise.resolve(fn.call(el, { navigationUI: 'hide' }));
  } catch (err) {
    return Promise.reject(err);
  }
}

function exitFs() {
  const fn = document.exitFullscreen || document.webkitExitFullscreen;
  return fn ? Promise.resolve(fn.call(document)).catch(() => {}) : Promise.resolve();
}

async function lockLandscape() {
  const o = screen.orientation;
  if (!o || typeof o.lock !== 'function') return false;
  try {
    await o.lock('landscape');
    return true;
  } catch {
    return false; // desktop browsers, iOS, or not in fullscreen
  }
}

let hintWanted = false;
function updateRotateHint() {
  const hint = $('#rotate-hint');
  if (!hint) return;
  hint.hidden = !(hintWanted && isPortrait());
}

function showRotateHint() {
  hintWanted = true;
  updateRotateHint();
  clearTimeout(showRotateHint.t);
  showRotateHint.t = setTimeout(() => {
    hintWanted = false;
    updateRotateHint();
  }, 6000);
}

function syncButton() {
  const on = !!fsElement();
  document.body.classList.toggle('is-fullscreen', on);
  const btn = $('#fs-btn');
  if (!btn) return;
  btn.setAttribute('aria-pressed', String(on));
  btn.querySelector('span').textContent = on ? 'Выйти' : 'Полный экран';
  btn.title = on ? 'Выйти из полноэкранного режима' : 'Полный экран';
}

export function bindFullscreen() {
  const btn = $('#fs-btn');
  const hint = $('#rotate-hint');
  hint.querySelector('span').textContent = ROTATE_TEXT;
  hint.addEventListener('click', () => {
    hintWanted = false;
    updateRotateHint();
  });

  btn.addEventListener('click', async () => {
    if (fsElement()) {
      try { screen.orientation?.unlock?.(); } catch { /* not locked */ }
      await exitFs();
      return;
    }
    let fsOk = true;
    try {
      await requestFs(document.documentElement);
    } catch {
      fsOk = false; // e.g. iPhone Safari: no element fullscreen
    }
    const locked = fsOk && (await lockLandscape());
    if (!locked && isPortrait()) showRotateHint();
    syncButton();
  });

  const onFsChange = () => {
    if (!fsElement()) {
      // back to the normal mobile mode
      try { screen.orientation?.unlock?.(); } catch { /* ignore */ }
    }
    syncButton();
  };
  document.addEventListener('fullscreenchange', onFsChange);
  document.addEventListener('webkitfullscreenchange', onFsChange);
  const onOrient = () => updateRotateHint();
  screen.orientation?.addEventListener?.('change', onOrient);
  window.addEventListener('orientationchange', onOrient);
  window.matchMedia?.('(orientation: portrait)').addEventListener?.('change', onOrient);
  syncButton();
}
