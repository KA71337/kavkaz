// Full-screen announcement "АРМЕНИЯ ЗАХВАЧЕНА" (server event `conquest`, sent to every player of the room).
// The server emits it only when the country has no province left (type "eliminated") or when a surviving
// country has lost all provinces of its original territory (type "region", e.g. every NK_* province).
import { COUNTRY_BY_ID } from '/shared/countries.js';
import { esc, flagHtml } from './dom.js';
import { playConquestSound } from './sound.js';

const SHOW_MS = 6000;
const queue = [];
let current = null;

export function showConquest(event) {
  if (!COUNTRY_BY_ID[event.country] || !COUNTRY_BY_ID[event.by]) return;
  queue.push(event);
  if (!current) next();
}

function next() {
  const ev = queue.shift();
  if (!ev) {
    current = null;
    return;
  }
  const lost = COUNTRY_BY_ID[ev.country];
  const winner = COUNTRY_BY_ID[ev.by];
  const title = `${lost.name} ${lost.male ? 'захвачен' : 'захвачена'}`.toUpperCase();
  const sub = ev.type === 'eliminated'
    ? `${winner.name} полностью ${winner.male ? 'захватил' : 'захватила'} ${lost.acc}`
    : `${winner.name} ${winner.male ? 'захватил' : 'захватила'} все провинции: ${lost.name}`;

  const root = document.createElement('div');
  root.className = 'conquest';
  root.setAttribute('role', 'alertdialog');
  root.setAttribute('aria-label', title);
  root.innerHTML = `
    <div class="cq-card">
      <div class="cq-flags">
        <div class="cq-flag cq-lost">${flagHtml(ev.country, 'flag-xl')}<span>${esc(lost.name)}</span></div>
        <div class="cq-arrow">➜</div>
        <div class="cq-flag cq-win">${flagHtml(ev.by, 'flag-xl')}<span>${esc(winner.name)}</span></div>
      </div>
      <h2 class="cq-title">${esc(title)}</h2>
      <p class="cq-sub">${esc(sub)}</p>
      <button type="button" class="btn btn-primary cq-close">Закрыть</button>
      <div class="cq-bar"><i style="animation-duration:${SHOW_MS}ms"></i></div>
    </div>`;
  document.getElementById('app').appendChild(root);

  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    root.classList.add('out');
    setTimeout(() => {
      root.remove();
      next();
    }, 350);
  };
  const timer = setTimeout(close, SHOW_MS);
  root.addEventListener('click', (e) => {
    if (e.target === root || e.target.closest('.cq-close')) close();
  });
  current = { close };
  playConquestSound();
}
