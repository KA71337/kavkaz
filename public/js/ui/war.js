// War declaration dialog, target selection banner and attack confirmation.
import { $, esc, flagHtml, fmt, countryName, chanceHtml, setHtml } from './dom.js';
import { openModal } from './modal.js';
import { neighborCountries, warBetween, chanceAgainst } from '../logic.js';

export function openDeclareDialog(app) {
  const { state, map } = app.store;
  const me = app.store.myCountry;
  const list = neighborCountries(state, map, me);
  const rows = list
    .map(({ id, frontline }) => {
      const c = state.countries[id];
      const war = warBetween(state, me, id);
      return `<div class="row">${flagHtml(id)}
        <div><div class="r-title">${esc(countryName(id))}</div>
        <div class="r-meta">${fmt(c.troops)} войск · граница: ${frontline.length} пров. · шанс ${chanceHtml(chanceAgainst(state, me, id))}</div></div>
        <div class="r-actions">${war
          ? `<button type="button" class="btn btn-danger btn-sm" data-war-attack="${id}">Атаковать</button>`
          : `<button type="button" class="btn btn-danger btn-sm" data-war-declare="${id}">Война</button>`}</div></div>`;
    })
    .join('');
  const m = openModal(`
    <div class="modal-head"><h3>⚔ Объявить войну</h3><button type="button" class="btn btn-ghost btn-sm" data-close aria-label="Закрыть">✕</button></div>
    <p class="muted" style="margin:0;font-size:13px">Выберите соседнюю страну. Затем выберите её провинцию, граничащую с вашей территорией.</p>
    <div class="formula">Шанс победы = ваши войска / (ваши войска + войска противника) × 100%<br/>Ваши войска: <b>${fmt(state.countries[me].troops)}</b></div>
    <div style="display:grid;gap:8px">${rows || '<div class="empty">У вас нет соседей</div>'}</div>`);
  m.modal.addEventListener('click', (e) => {
    const d = e.target.closest('[data-war-declare]');
    const a = e.target.closest('[data-war-attack]');
    if (d) {
      m.close();
      app.declareWar(d.dataset.warDeclare);
    } else if (a) {
      m.close();
      app.enterTargetMode(a.dataset.warAttack);
    }
  });
}

export function renderTargetBanner(app) {
  const banner = $('#target-banner');
  const target = app.ctx.targetCountry;
  if (app.ctx.mode !== 'target' || !target) {
    banner.hidden = true;
    return;
  }
  const { state } = app.store;
  const me = app.store.myCountry;
  banner.hidden = false;
  setHtml(banner, `
    ${flagHtml(target)}
    <div class="tb-text">Выберите провинцию: <b>${esc(countryName(target))}</b> · доступно ${app.ctx.targets.size} · шанс ${chanceHtml(chanceAgainst(state, me, target))}</div>
    <button type="button" class="btn btn-sm" data-target-cancel>Отмена</button>`);
}

export function bindTargetBanner(app) {
  $('#target-banner').addEventListener('click', (e) => {
    if (e.target.closest('[data-target-cancel]')) app.exitTargetMode();
  });
}

export function openAttackConfirm(app, pid) {
  const { state, map } = app.store;
  const me = app.store.myCountry;
  const p = map.provinces.find((x) => x.id === pid);
  const enemy = state.provinces[pid];
  const att = state.countries[me].troops;
  const def = state.countries[enemy].troops;
  const chance = chanceAgainst(state, me, enemy);
  const m = openModal(`
    <div class="modal-head">${flagHtml(enemy)}<h3>Атаковать «${esc(p.name)}»?</h3></div>
    <div class="stats">
      <div class="stat"><b>${fmt(att)}</b><span>ваши войска</span></div>
      <div class="stat"><b>${fmt(def)}</b><span>войска: ${esc(countryName(enemy))}</span></div>
    </div>
    <div class="formula">Шанс победы: <b>${chanceHtml(chance)}</b><br/>${fmt(att)} / (${fmt(att)} + ${fmt(def)}) × 100 = ${chance}%<br/>Сражение длится 10 секунд, затем сервер бросает случайное число 0–100: если оно ≤ ${chance} — победа.</div>
    <div class="modal-actions">
      <button type="button" class="btn" data-close>Отмена</button>
      <button type="button" class="btn btn-danger" data-go>⚔ В атаку!</button>
    </div>`);
  m.modal.querySelector('[data-go]').addEventListener('click', async (e) => {
    e.currentTarget.disabled = true;
    const ok = await app.startBattle(pid);
    if (ok) m.close();
    else e.currentTarget.disabled = false;
  });
}
