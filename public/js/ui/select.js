// Country selection screen (list + detail card; the map itself is handled by MapView).
import { COUNTRIES } from '/shared/countries.js';
import { $, esc, flagHtml, fmt, setHtml } from './dom.js';

function status(c, meId) {
  if (c.eliminated) return { cls: 'dead', text: 'Уничтожена', busy: true };
  if (c.player && c.player !== meId) return { cls: 'busy', text: `Занята: ${c.playerName}`, busy: true };
  if (c.player === meId) return { cls: '', text: 'Ваша', busy: false };
  return { cls: '', text: 'Свободна', busy: false };
}

export function renderSelect(app) {
  const { state } = app.store;
  if (!state) return;
  const meId = app.store.me.playerId;
  const sel = app.ctx.selectedCountry;

  setHtml($('#select-list'), COUNTRIES.map((meta) => {
    const c = state.countries[meta.id];
    const st = status(c, meId);
    return `<button type="button" class="country-item ${sel === meta.id ? 'is-sel' : ''} ${st.busy ? 'is-busy' : ''}" data-country="${meta.id}">
      ${flagHtml(meta.id)}
      <span><div class="ci-name">${esc(meta.name)}</div><div class="ci-meta">${c.provinces} пров. · ${fmt(c.troops)} войск</div></span>
      <span class="badge ${st.cls}">${esc(st.text)}</span>
    </button>`;
  }).join(''));

  const card = $('#select-card');
  if (!sel) {
    card.hidden = true;
    return;
  }
  const meta = COUNTRIES.find((c) => c.id === sel);
  const c = state.countries[sel];
  const st = status(c, meId);
  card.hidden = false;
  setHtml(card, `
    <div class="sc-head">${flagHtml(sel, 'flag-lg')}<div><h3>${esc(meta.name)}</h3><div class="muted">${esc(st.text)}</div></div></div>
    <div class="stats">
      <div class="stat"><b>${c.provinces}</b><span>провинций</span></div>
      <div class="stat"><b>${fmt(c.troops)}</b><span>войск</span></div>
    </div>
    ${st.busy ? `<div class="busy-note">${c.eliminated ? 'Эта страна уничтожена и недоступна.' : 'Эта страна уже занята другим игроком.'}</div>` : ''}
    <button type="button" class="btn btn-primary btn-block" id="select-go" ${st.busy ? 'aria-disabled="true"' : ''}>
      ${st.busy ? 'Недоступно' : `Играть за: ${esc(meta.name)}`}
    </button>`);
}

export function bindSelect(app) {
  $('#select-list').addEventListener('click', (e) => {
    const b = e.target.closest('[data-country]');
    if (!b) return;
    app.pickCountry(b.dataset.country, { focus: true });
  });
  $('#select-card').addEventListener('click', (e) => {
    if (e.target.closest('#select-go')) app.confirmCountry(app.ctx.selectedCountry);
  });
  $('#select-back').addEventListener('click', () => app.goMenu());
}
