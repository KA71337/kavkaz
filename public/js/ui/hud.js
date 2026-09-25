// In-game HUD: player card, action button, side panel (neighbours, wars, captures, players, log), province popup.
import { troopIncome, BATTLE_DURATION_MS } from '/shared/rules.js';
import { $, esc, flagHtml, fmt, countryName, chanceHtml, timeHtml, setHtml } from './dom.js';
import { neighborCountries, warBetween, warsOf, chanceAgainst, frontline, myBattle } from '../logic.js';

const TABS = [
  { id: 'neighbors', title: 'Соседи' },
  { id: 'wars', title: 'Войны' },
  { id: 'captures', title: 'Захваты' },
  { id: 'players', title: 'Игроки' },
  { id: 'log', title: 'Журнал' },
];
let activeTab = 'neighbors';

export function renderHud(app) {
  const { state } = app.store;
  const me = app.store.myCountry;
  if (!state || !me) return;
  const c = state.countries[me];
  const map = app.store.map;
  const captured = map.provinces.filter((p) => state.provinces[p.id] === me && p.country !== me).length;
  const income = troopIncome(c.provinces);

  setHtml($('#hud-player'), `
    <div class="hp-head">
      ${flagHtml(me, 'flag-lg')}
      <div><h2>${esc(countryName(me))}</h2><div class="muted">${esc(app.store.player?.name || '')} · комната «${esc(state.room)}»</div></div>
      <button type="button" class="btn btn-ghost btn-sm hp-menu" data-act="menu" aria-label="Меню">☰</button>
    </div>
    <div class="hp-stats">
      <div class="stat"><b>${fmt(c.troops)}</b><span>войск</span></div>
      <div class="stat"><b>${c.provinces}</b><span>провинций</span></div>
      <div class="stat"><b>${captured}</b><span>захвачено</span></div>
    </div>
    <div class="hp-detail muted" style="font-size:12px">Прирост: <span class="troops-up">+${income}</span> войск каждые 5 с</div>`);

  const battle = state.battles.find((b) => b.attacker === me || b.defender === me);
  let actions = '';
  if (app.ctx.mode === 'target') {
    actions = '';
  } else if (battle) {
    // countdown text is filled by tickCountdowns(), keeping this markup stable between renders
    actions = `<div class="battle-chip panel">⚔ <span>${battle.attacker === me ? 'Идёт сражение' : 'Вас атакуют'}: <b>${esc(app.pname(battle.province))}</b></span><b style="margin-left:auto" data-cd="${battle.id}"></b></div>`;
  }
  if (app.ctx.mode !== 'target') {
    actions += `<button type="button" class="btn btn-danger btn-block" data-act="declare" ${myBattle(state, me) ? 'disabled' : ''}>⚔ Объявить войну</button>`;
  }
  if (setHtml($('#hud-actions'), actions)) tickCountdowns(app);

  renderTabs(app);
}

function renderTabs(app) {
  const { state } = app.store;
  const me = app.store.myCountry;
  const wars = warsOf(state, me);
  setHtml($('#side-tabs'), TABS.map((t) => {
    const count = t.id === 'wars' && wars.length ? `<span class="count">${wars.length}</span>` : '';
    return `<button type="button" role="tab" class="tab ${activeTab === t.id ? 'is-active' : ''}" data-tab="${t.id}">${t.title}${count}</button>`;
  }).join(''));
  const body = $('#side-body');
  const scroll = body.scrollTop;
  if (setHtml(body, TAB_RENDER[activeTab](app))) {
    body.scrollTop = scroll;
    tickCountdowns(app);
  }
}

const TAB_RENDER = {
  neighbors(app) {
    const { state, map } = app.store;
    const me = app.store.myCountry;
    const list = neighborCountries(state, map, me);
    if (!list.length) return '<div class="empty">Нет соседей</div>';
    return list
      .sort((a, b) => b.frontline.length - a.frontline.length)
      .map(({ id, frontline: fl }) => {
        const c = state.countries[id];
        const war = warBetween(state, me, id);
        const chance = chanceAgainst(state, me, id);
        return `<div class="row">
          ${flagHtml(id)}
          <div><div class="r-title">${esc(countryName(id))} ${war ? '<span class="badge war">война</span>' : ''}</div>
          <div class="r-meta">${fmt(c.troops)} войск · ${fl.length} пограничн. пров. · ${c.player ? `игрок ${esc(c.playerName)}` : 'без игрока'} · шанс ${chanceHtml(chance)}</div></div>
          <div class="r-actions">${war
            ? `<button type="button" class="btn btn-danger btn-sm" data-act="attack" data-country="${id}">Атаковать</button>`
            : `<button type="button" class="btn btn-sm" data-act="declare-one" data-country="${id}">Объявить войну</button>`}</div>
        </div>`;
      })
      .join('');
  },

  wars(app) {
    const { state } = app.store;
    const me = app.store.myCountry;
    const wars = warsOf(state, me);
    let html = '<div class="section-title">Ваши войны</div>';
    html += wars.length
      ? wars.map((w) => {
          const enemy = w.attacker === me ? w.defender : w.attacker;
          const canPeace = w.attacker === me;
          return `<div class="row">${flagHtml(enemy)}
            <div><div class="r-title">${esc(countryName(enemy))}</div>
            <div class="r-meta">${w.attacker === me ? 'Вы объявили войну' : 'Вам объявили войну'} · шанс ${chanceHtml(chanceAgainst(state, me, enemy))}</div></div>
            <div class="r-actions"><button type="button" class="btn btn-danger btn-sm" data-act="attack" data-country="${enemy}">Атаковать</button>
            ${canPeace ? `<button type="button" class="btn btn-sm" data-act="peace" data-country="${enemy}">Мир</button>` : ''}</div></div>`;
        }).join('')
      : '<div class="empty">Вы ни с кем не воюете</div>';
    html += '<div class="section-title">Все войны</div>';
    html += state.wars.length
      ? state.wars.map((w) => `<div class="log-item war">${flagHtml(w.attacker, 'flag-sm')} ${esc(countryName(w.attacker))} ⚔ ${flagHtml(w.defender, 'flag-sm')} ${esc(countryName(w.defender))}</div>`).join('')
      : '<div class="empty">Мир на всём Кавказе</div>';
    html += '<div class="section-title">Сражения сейчас</div>';
    html += state.battles.length
      ? state.battles.map((b) => `<div class="log-item battle">${esc(countryName(b.attacker))} → ${esc(app.pname(b.province))} (${esc(countryName(b.defender))}), шанс ${chanceHtml(b.chance)} · <b data-cd="${b.id}"></b></div>`).join('')
      : '<div class="empty">Сражений нет</div>';
    html += '<div class="section-title">Последние сражения</div>';
    html += state.results.length
      ? state.results.slice(0, 10).map((r) => `<div class="log-item ${r.success ? 'capture' : 'defense'}">${timeHtml(r.at)}${esc(countryName(r.attacker))} → ${esc(app.pname(r.province))}: ${r.success ? 'захват' : 'атака отбита'} (шанс ${r.chance}%, бросок ${r.roll})</div>`).join('')
      : '<div class="empty">Пока не было сражений</div>';
    return html;
  },

  captures(app) {
    const { state, map } = app.store;
    const me = app.store.myCountry;
    const mine = map.provinces.filter((p) => state.provinces[p.id] === me && p.country !== me);
    const lost = map.provinces.filter((p) => p.country === me && state.provinces[p.id] !== me);
    let html = `<div class="section-title">Захвачено вами (${mine.length})</div>`;
    html += mine.length
      ? mine.map((p) => `<div class="row">${flagHtml(p.country)}<div><div class="r-title">${esc(p.name)}</div><div class="r-meta">бывшая территория: ${esc(countryName(p.country))}</div></div><div class="r-actions"><button type="button" class="btn btn-sm" data-act="show" data-province="${p.id}">Показать</button></div></div>`).join('')
      : '<div class="empty">Вы ещё ничего не захватили</div>';
    html += `<div class="section-title">Потеряно (${lost.length})</div>`;
    html += lost.length
      ? lost.map((p) => `<div class="row">${flagHtml(state.provinces[p.id])}<div><div class="r-title">${esc(p.name)}</div><div class="r-meta">сейчас: ${esc(countryName(state.provinces[p.id]))}</div></div><div class="r-actions"><button type="button" class="btn btn-sm" data-act="show" data-province="${p.id}">Показать</button></div></div>`).join('')
      : '<div class="empty">Потерь нет</div>';
    html += '<div class="section-title">Все захваты</div>';
    html += state.captures.length
      ? state.captures.slice(0, 25).map((c) => `<div class="log-item capture">${timeHtml(c.at)}${flagHtml(c.to, 'flag-sm')} ${esc(countryName(c.to))} захватила «${esc(app.pname(c.province))}» у ${esc(countryName(c.from))}</div>`).join('')
      : '<div class="empty">Захватов пока нет</div>';
    return html;
  },

  players(app) {
    const { state } = app.store;
    const list = [...state.players].sort((a, b) => Number(b.online) - Number(a.online));
    return list
      .map((p) => `<div class="row">${p.country ? flagHtml(p.country) : '<span class="flag"></span>'}
        <div><div class="r-title">${esc(p.name)}${p.id === app.store.me.playerId ? ' (вы)' : ''}</div>
        <div class="r-meta">${p.country ? esc(countryName(p.country)) : 'выбирает страну'}</div></div>
        <span class="dot ${p.online ? 'on' : 'off'}" title="${p.online ? 'онлайн' : 'не в сети'}"></span></div>`)
      .join('') || '<div class="empty">Нет игроков</div>';
  },

  log(app) {
    const { state } = app.store;
    return state.log.length ? state.log.map((l) => `<div class="log-item ${l.type}">${timeHtml(l.at)}${esc(l.text)}</div>`).join('') : '<div class="empty">Журнал пуст</div>';
  },
};

export function renderProvincePopup(app) {
  const pop = $('#province-pop');
  const pid = app.ctx.picked;
  const { state } = app.store;
  if (!pid || !state || app.ctx.mode !== 'game') {
    pop.hidden = true;
    return;
  }
  const p = app.store.map.provinces.find((x) => x.id === pid);
  const me = app.store.myCountry;
  const owner = state.provinces[pid];
  const war = owner !== me ? warBetween(state, me, owner) : null;
  const bordering = owner !== me && frontline(state, app.store.map, me, owner).includes(pid);
  const chance = chanceAgainst(state, me, owner);
  let action = '';
  if (owner === me) action = '<div class="muted" style="font-size:13px">Ваша провинция</div>';
  else if (!bordering) action = '<div class="muted" style="font-size:13px">Не граничит с вашей территорией — атаковать нельзя</div>';
  else if (!war) action = `<button type="button" class="btn btn-sm btn-block" data-act="declare-one" data-country="${owner}">Объявить войну: ${esc(countryName(owner))}</button>`;
  else action = `<button type="button" class="btn btn-danger btn-block" data-act="attack-province" data-province="${pid}">Атаковать · шанс ${chance}%</button>`;
  pop.hidden = false;
  setHtml(pop, `
    <div class="pp-head">${flagHtml(owner)}<div><h3>${esc(p.name)}</h3><div class="muted" style="font-size:12px">Владелец: ${esc(countryName(owner))}${owner !== p.country ? ` · исходно: ${esc(countryName(p.country))}` : ''}</div></div>
    <button type="button" class="btn btn-ghost btn-sm pp-close" data-act="close-pop" aria-label="Закрыть">✕</button></div>
    <div class="muted" style="font-size:12px">ID: ${esc(p.id)} · соседних провинций: ${p.neighbors.length}</div>
    ${action}`);
}

export function bindHud(app) {
  const root = $('#game-ui');
  root.addEventListener('click', (e) => {
    const tab = e.target.closest('[data-tab]');
    if (tab) {
      const side = $('#side');
      // phones: a second tap on the active tab folds the sheet back so the map is free again
      const open = !(side.classList.contains('is-open') && activeTab === tab.dataset.tab);
      activeTab = tab.dataset.tab;
      side.classList.toggle('is-open', open);
      document.body.classList.toggle('sheet-open', open);
      renderTabs(app);
      return;
    }
    const act = e.target.closest('[data-act]');
    if (!act) return;
    const { country, province } = act.dataset;
    switch (act.dataset.act) {
      case 'declare': app.openDeclare(); break;
      case 'declare-one': app.declareWar(country); break;
      case 'attack': app.enterTargetMode(country); break;
      case 'attack-province': app.confirmAttack(province); break;
      case 'peace': app.makePeace(country); break;
      case 'show': app.showProvince(province); break;
      case 'close-pop': app.ctx.picked = null; app.renderAll(); break;
      case 'menu': app.openGameMenu(); break;
      default:
    }
  });
  $('#side-toggle').addEventListener('click', () => {
    const open = $('#side').classList.toggle('is-open');
    document.body.classList.toggle('sheet-open', open);
  });
}

/** Cheap per-frame update for countdown labels. */
export function tickCountdowns(app) {
  const { state } = app.store;
  if (!state) return;
  for (const node of document.querySelectorAll('[data-cd]')) {
    const b = state.battles.find((x) => x.id === node.dataset.cd);
    if (b) node.textContent = `${Math.max(0, Math.ceil((b.endsAt - app.store.now()) / 1000))}с`;
  }
}

export { BATTLE_DURATION_MS };
