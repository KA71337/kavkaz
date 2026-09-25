// Battle countdown overlay and animated result dialog.
import { BATTLE_DURATION_MS } from '/shared/rules.js';
import { $, esc, flagHtml, fmt, countryName } from './dom.js';
import { openModal } from './modal.js';

const RING = 2 * Math.PI * 36;

export function renderBattleOverlay(app) {
  const box = $('#battle-overlay');
  const { state } = app.store;
  const me = app.store.myCountry;
  const b = state && me ? state.battles.find((x) => x.attacker === me || x.defender === me) : null;
  if (!b || app.screen !== 'game') {
    box.hidden = true;
    box.dataset.id = '';
    return;
  }
  if (box.dataset.id !== b.id) {
    box.dataset.id = b.id;
    const attacking = b.attacker === me;
    box.innerHTML = `<div class="battle-card">
      <h3 class="battle-dots">${attacking ? 'Идёт сражение' : 'Вас атакуют'}</h3>
      <div class="vs">
        <div class="side-x">${flagHtml(b.attacker, 'flag-lg')}<span>${esc(countryName(b.attacker))}</span><span class="muted">${fmt(b.attackerTroops)}</span></div>
        <div class="swords">⚔</div>
        <div class="side-x">${flagHtml(b.defender, 'flag-lg')}<span>${esc(countryName(b.defender))}</span><span class="muted">${fmt(b.defenderTroops)}</span></div>
      </div>
      <div class="ring-timer"><svg viewBox="0 0 84 84"><circle class="bg" cx="42" cy="42" r="36"/><circle class="fg" cx="42" cy="42" r="36" stroke-dasharray="${RING}" stroke-dashoffset="0"/></svg><b data-bt>10</b></div>
      <div class="muted" style="font-size:13px">Провинция «${esc(app.pname(b.province))}» · шанс победы ${b.chance}%</div>
    </div>`;
  }
  box.hidden = false;
  tickBattleOverlay(app);
}

export function tickBattleOverlay(app) {
  const box = $('#battle-overlay');
  if (box.hidden || !box.dataset.id) return;
  const b = app.store.state?.battles.find((x) => x.id === box.dataset.id);
  if (!b) return;
  const left = Math.max(0, b.endsAt - app.store.now());
  const total = Math.max(1, b.endsAt - b.startedAt || BATTLE_DURATION_MS);
  const fg = box.querySelector('.fg');
  const t = box.querySelector('[data-bt]');
  if (fg) fg.setAttribute('stroke-dashoffset', String(RING * (1 - left / total)));
  if (t) t.textContent = String(Math.ceil(left / 1000));
}

export function showBattleResult(app, r) {
  const me = app.store.myCountry;
  const attacking = r.attacker === me;
  // "win" from the local player's point of view
  const win = attacking ? r.success : !r.success;
  let icon, title, text;
  if (r.cancelled) {
    icon = '🏳';
    title = 'Сражение отменено';
    text = 'Провинция сменила владельца до окончания боя.';
  } else if (attacking) {
    icon = r.success ? '🏆' : '🛡';
    title = r.success ? 'Победа! Территория захвачена' : 'Поражение! Атака отбита';
    text = r.success ? `Провинция «${app.pname(r.province)}» теперь ваша.` : `${countryName(r.defender)} удержала «${app.pname(r.province)}».`;
  } else {
    icon = r.success ? '💔' : '🛡';
    title = r.success ? 'Провинция потеряна' : 'Атака отбита!';
    text = r.success ? `${countryName(r.attacker)} захватила «${app.pname(r.province)}».` : `Вы удержали «${app.pname(r.province)}».`;
  }
  const details = r.cancelled
    ? ''
    : `<div class="formula">Шанс победы: <b>${r.chance}%</b> · бросок сервера: <b>${r.roll}</b> ${r.success ? '≤' : '>'} ${r.chance}<br/>Потери: ${esc(countryName(r.attacker))} −${fmt(r.attackerLoss)}, ${esc(countryName(r.defender))} −${fmt(r.defenderLoss)}</div>`;
  const m = openModal(`
    <div class="r-icon">${icon}</div>
    <h3>${esc(title)}</h3>
    <div class="vs">${flagHtml(r.attacker, 'flag-lg')}<span class="muted">→</span>${flagHtml(r.defender, 'flag-lg')}</div>
    <p class="muted" style="margin:0">${esc(text)}</p>
    ${details}
    <button type="button" class="btn btn-primary btn-block" data-close>Продолжить</button>`, { className: `result ${r.cancelled ? '' : win ? 'win' : 'lose'}` });
  if (win && !r.cancelled) confetti(m.modal);
}

function confetti(root) {
  const colors = ['#ffd36b', '#f0b429', '#ef4444', '#22c55e', '#60a5fa', '#fff'];
  for (let i = 0; i < 36; i++) {
    const s = document.createElement('span');
    s.className = 'confetti';
    s.style.left = `${Math.random() * 100}%`;
    s.style.background = colors[i % colors.length];
    s.style.animationDelay = `${Math.random() * 0.4}s`;
    s.style.animationDuration = `${1.2 + Math.random() * 1}s`;
    root.appendChild(s);
    setTimeout(() => s.remove(), 2600);
  }
}
