// Application controller: screens, session, routing of map clicks, server events.
import { socket, request, on } from './net.js';
import { store } from './store.js';
import { MapView } from './map/MapView.js';
import { frontline, warBetween } from './logic.js';
import { $, countryName } from './ui/dom.js';
import { toast } from './ui/toast.js';
import { openModal, closeModal } from './ui/modal.js';
import { renderSelect, bindSelect } from './ui/select.js';
import { renderHud, bindHud, renderProvincePopup, tickCountdowns } from './ui/hud.js';
import { openDeclareDialog, renderTargetBanner, bindTargetBanner, openAttackConfirm } from './ui/war.js';
import { renderBattleOverlay, tickBattleOverlay, showBattleResult } from './ui/battle.js';
import { showConquest } from './ui/conquest.js';
import { bindFullscreen } from './ui/fullscreen.js';
import { bindVoice, setVoiceRoster, voiceSuspend, voiceResume, voiceLeave } from './ui/voice.js';
import { unlockAudio } from './ui/sound.js';

const app = {
  store,
  view: null,
  screen: 'menu',
  joined: false,
  ctx: { mode: 'select', hoverCountry: null, selectedCountry: null, hoverProvince: null, picked: null, targets: new Set(), targetCountry: null },
  pnames: new Map(),

  pname(id) {
    return this.pnames.get(id) || id;
  },

  // ------------------------------------------------------------------ screens
  setScreen(name) {
    this.screen = name;
    $('#screen-menu').classList.toggle('is-active', name === 'menu');
    $('#screen-game').classList.toggle('is-active', name !== 'menu');
    $('#select-ui').hidden = name !== 'select';
    $('#game-ui').hidden = name !== 'game';
    document.body.classList.toggle('in-game', name === 'game');
    if (name === 'select') this.ctx.mode = 'select';
    if (name === 'game') this.ctx.mode = 'game';
    this.ctx.picked = null;
    this.ctx.hoverCountry = null;
    this.ctx.hoverProvince = null;
    this.renderAll();
    if (name !== 'menu') requestAnimationFrame(() => this.view.pz.apply());
  },

  goMenu() {
    closeModal();
    voiceLeave(); // frees peer connections and the microphone
    this.exitTargetMode(false);
    this.setScreen('menu');
  },

  goSelect() {
    this.exitTargetMode(false);
    this.ctx.selectedCountry = null;
    this.setScreen('select');
    this.view.pz.reset();
  },

  goGame() {
    this.setScreen('game');
    const me = store.myCountry;
    const own = Object.keys(store.state.provinces).filter((id) => store.state.provinces[id] === me);
    this.view.focusProvinces(own, 0.6);
  },

  // ------------------------------------------------------------------ session
  async join() {
    const btn = $('#menu-play');
    const name = $('#menu-name').value.trim();
    const room = $('#menu-room').value.trim().toLowerCase() || 'global';
    store.savedName = name;
    unlockAudio(); // user gesture: allows the conquest sound / voice playback later
    btn.disabled = true;
    btn.textContent = 'Подключение…';
    const res = await request('session:join', { roomId: room, playerId: store.me.room === room ? store.me.playerId : null, token: store.me.token, name });
    btn.disabled = false;
    btn.textContent = 'Играть';
    if (!res.ok) return toast(res.error, 'error');
    store.me = { playerId: res.playerId, token: res.token, room: res.room };
    store.saveIdentity();
    this.joined = true;
    store.replaceState(res.state);
    setVoiceRoster(res.voice);
    if (store.myCountry) this.goGame();
    else this.goSelect();
  },

  async rejoin() {
    if (!this.joined) return;
    const res = await request('session:join', { roomId: store.me.room, playerId: store.me.playerId, token: store.me.token, name: store.savedName });
    if (!res.ok) return;
    const changedId = res.playerId !== store.me.playerId;
    store.me = { playerId: res.playerId, token: res.token, room: res.room };
    store.saveIdentity();
    // full replace: after a server restart versions start from zero again
    store.replaceState(res.state);
    setVoiceRoster(res.voice);
    if (changedId && this.screen === 'game') {
      toast('Сессия истекла — выберите страну заново', 'warn');
      this.goSelect();
    }
    return res;
  },

  /** A patch could not be applied (missed versions): fetch one full snapshot. */
  async resync() {
    if (this._resyncing) return;
    this._resyncing = true;
    const res = await request('state:get');
    this._resyncing = false;
    if (res.ok) store.replaceState(res.state);
  },

  // ------------------------------------------------------------------ selection
  pickCountry(countryId, { focus } = {}) {
    const c = store.state?.countries[countryId];
    if (!c) return;
    this.ctx.selectedCountry = countryId;
    if (c.player && c.player !== store.me.playerId) toast('Эта страна уже занята', 'error');
    else if (c.eliminated) toast('Эта страна уничтожена', 'error');
    if (focus) {
      const own = Object.keys(store.state.provinces).filter((id) => store.state.provinces[id] === countryId);
      this.view.focusProvinces(own, 0.35);
    }
    this.renderAll();
  },

  async confirmCountry(countryId) {
    const c = store.state?.countries[countryId];
    if (!c) return;
    if (c.player && c.player !== store.me.playerId) return toast('Эта страна уже занята', 'error');
    if (c.eliminated) return toast('Эта страна уничтожена', 'error');
    const res = await request('country:select', { countryId });
    if (!res.ok) {
      toast(res.error, 'error');
      return;
    }
    // the patch with the change arrives before the ack (same socket, ordered delivery)
    if (!store.myCountry) await this.resync();
    toast(`Вы играете за: ${countryName(countryId)}`, 'ok');
    this.goGame();
  },

  // ------------------------------------------------------------------ war
  openDeclare() {
    openDeclareDialog(this);
  },

  async declareWar(countryId) {
    const res = await request('war:declare', { countryId });
    if (!res.ok) return toast(res.error, 'error');
    toast(`Война объявлена: ${countryName(countryId)}`, 'war');
    this.enterTargetMode(countryId);
  },

  async makePeace(countryId) {
    const res = await request('war:peace', { countryId });
    if (!res.ok) return toast(res.error, 'error');
    toast(`Мир с ${countryName(countryId)}`, 'ok');
  },

  enterTargetMode(countryId) {
    const { state, map } = store;
    const me = store.myCountry;
    if (!warBetween(state, me, countryId)) return toast('Сначала объявите войну', 'warn');
    const targets = new Set(frontline(state, map, me, countryId).filter((pid) => !state.battles.some((b) => b.province === pid)));
    if (!targets.size) return toast('Нет доступных пограничных провинций для атаки', 'warn');
    closeModal();
    this.ctx.mode = 'target';
    this.ctx.targetCountry = countryId;
    this.ctx.targets = targets;
    this.ctx.picked = null;
    this.view.focusProvinces([...targets, ...[...targets].flatMap((id) => map.provinces.find((p) => p.id === id).neighbors.filter((n) => state.provinces[n] === me))], 0.25);
    this.renderAll();
  },

  exitTargetMode(render = true) {
    if (this.ctx.mode !== 'target') return;
    this.ctx.mode = this.screen === 'game' ? 'game' : 'select';
    this.ctx.targetCountry = null;
    this.ctx.targets = new Set();
    if (render) this.renderAll();
  },

  confirmAttack(pid) {
    const { state, map } = store;
    const me = store.myCountry;
    const owner = state.provinces[pid];
    if (!warBetween(state, me, owner)) return toast('Сначала объявите войну', 'warn');
    if (!frontline(state, map, me, owner).includes(pid)) return toast('Провинция не граничит с вашей территорией', 'warn');
    openAttackConfirm(this, pid);
  },

  async startBattle(pid) {
    const res = await request('battle:start', { provinceId: pid });
    if (!res.ok) {
      toast(res.error, 'error');
      return false;
    }
    this.exitTargetMode(false);
    this.ctx.picked = null;
    this.renderAll();
    return true;
  },

  showProvince(pid) {
    this.ctx.picked = pid;
    this.view.focusProvinces([pid], 1.2);
    $('#side').classList.remove('is-open');
    document.body.classList.remove('sheet-open');
    this.renderAll();
  },

  openGameMenu() {
    const m = openModal(`
      <div class="modal-head"><h3>Меню</h3><button type="button" class="btn btn-ghost btn-sm" data-close aria-label="Закрыть">✕</button></div>
      <button type="button" class="btn btn-block" data-m="change">Сменить страну</button>
      <button type="button" class="btn btn-block" data-m="exit">Выйти в главное меню</button>
      <p class="hint">Если вы покинете страну, она станет свободной для других игроков. Захваченные территории сохранятся.</p>`);
    m.modal.addEventListener('click', async (e) => {
      const b = e.target.closest('[data-m]');
      if (!b) return;
      m.close();
      if (b.dataset.m === 'change') {
        const res = await request('country:leave');
        if (!res.ok) return toast(res.error, 'error');
        this.goSelect();
      } else {
        this.goMenu();
      }
    });
  },

  // ------------------------------------------------------------------ map events
  onProvinceClick(pid) {
    if (!store.state) return;
    if (this.ctx.mode === 'select') {
      if (!pid) return;
      this.pickCountry(store.state.provinces[pid]);
    } else if (this.ctx.mode === 'target') {
      if (!pid) return;
      if (this.ctx.targets.has(pid)) this.confirmAttack(pid);
      else toast('Выберите подсвеченную провинцию противника', 'warn', 2000);
    } else if (this.ctx.mode === 'game') {
      this.ctx.picked = pid;
      this.renderAll();
    }
  },

  onProvinceHover(pid) {
    if (!store.state) return;
    if (this.ctx.mode === 'select') {
      const c = pid ? store.state.provinces[pid] : null;
      if (c === this.ctx.hoverCountry) return;
      this.ctx.hoverCountry = c;
    } else {
      if (pid === this.ctx.hoverProvince) return;
      this.ctx.hoverProvince = pid;
    }
    this.renderMap();
  },

  // ------------------------------------------------------------------ rendering
  renderMap() {
    if (!this.view || !store.state) return;
    this.view.render(store.state, { ...this.ctx, me: store.myCountry, playerId: store.me.playerId, now: store.now() });
  },

  renderAll() {
    if (!store.state) return;
    this.renderMap();
    if (this.screen === 'select') renderSelect(this);
    if (this.screen === 'game') {
      renderHud(this);
      renderProvincePopup(this);
    }
    renderTargetBanner(this);
    renderBattleOverlay(this);
  },

  onState(prev) {
    const { state } = store;
    // flash provinces that changed owner
    if (prev) {
      for (const [pid, owner] of Object.entries(state.provinces)) {
        if (prev.provinces[pid] !== owner) this.view.flash(pid);
      }
    }
    if (this.screen === 'game' && !store.myCountry) {
      this.goSelect();
      return;
    }
    if (this.ctx.mode === 'target') {
      const me = store.myCountry;
      const t = this.ctx.targetCountry;
      if (!warBetween(state, me, t)) {
        this.exitTargetMode(false);
      } else {
        this.ctx.targets = new Set(frontline(state, store.map, me, t).filter((pid) => !state.battles.some((b) => b.province === pid)));
        if (!this.ctx.targets.size) this.exitTargetMode(false);
      }
    }
    this.renderAll();
  },
};

// ------------------------------------------------------------------ bootstrap
async function main() {
  store.loadIdentity();
  $('#menu-name').value = store.savedName;
  if (store.me.room && store.me.room !== 'global') $('#menu-room').value = store.me.room;

  const res = await fetch('/data/map.json');
  store.map = await res.json();
  for (const p of store.map.provinces) app.pnames.set(p.id, p.name);

  app.view = new MapView($('#map-wrap'), store.map, {
    onProvinceClick: (pid) => app.onProvinceClick(pid),
    onProvinceHover: (pid) => app.onProvinceHover(pid),
  });

  bindSelect(app);
  bindHud(app);
  bindTargetBanner(app);
  bindFullscreen();
  bindVoice({ socket, request, on });
  // iOS Safari ignores user-scalable=no: block page pinch-zoom so two fingers always zoom the map
  for (const t of ['gesturestart', 'gesturechange']) document.addEventListener(t, (e) => e.preventDefault(), { passive: false });
  document.querySelector('.zoom-ctrl').addEventListener('click', (e) => {
    const z = e.target.closest('[data-zoom]')?.dataset.zoom;
    if (z === 'in') app.view.pz.zoomCenter(0.6);
    if (z === 'out') app.view.pz.zoomCenter(1.6);
    if (z === 'reset') app.view.pz.reset();
  });

  $('#menu-play').addEventListener('click', () => app.join());
  $('#menu-name').addEventListener('keydown', (e) => e.key === 'Enter' && app.join());

  let prev = null;
  store.subscribe(() => {
    app.onState(prev);
    prev = store.state;
  });

  const setConn = (okState, text) => {
    $('#conn-dot').className = `dot ${okState ? 'on' : 'off'}`;
    $('#conn-text').textContent = text;
  };
  let voiceWas = null; // voice chat state to restore after a reconnect
  socket.on('connect', async () => {
    setConn(true, 'Сервер онлайн');
    const res = await app.rejoin();
    if (res?.ok && voiceWas && app.screen !== 'menu') voiceResume(voiceWas);
    voiceWas = null;
  });
  socket.on('disconnect', () => {
    setConn(false, 'Нет связи с сервером…');
    voiceWas = voiceSuspend() || voiceWas; // the server dropped us from the voice room; close peers now
    if (app.joined) toast('Соединение потеряно, переподключаемся…', 'warn');
  });
  if (socket.connected) setConn(true, 'Сервер онлайн');

  // incremental state: only what changed since the previous broadcast
  on('patch', (p) => {
    if (!store.applyPatch(p)) app.resync();
  });
  on('conquest', (ev) => {
    if (app.joined && app.screen !== 'menu') showConquest(ev);
  });
  on('notify', (n) => toast(n.text, n.type === 'eliminated' ? 'error' : n.type === 'peace' ? 'ok' : 'war', 4500));
  on('battle:started', (b) => {
    const me = store.myCountry;
    if (app.screen === 'game' && b.attacker !== me && b.defender !== me) {
      toast(`${countryName(b.attacker)} атакует «${app.pname(b.province)}» (${countryName(b.defender)})`, 'info', 2500);
    }
  });
  on('battle:result', (r) => {
    const me = store.myCountry;
    if (app.screen === 'game' && (r.attacker === me || r.defender === me)) {
      showBattleResult(app, r);
    } else if (app.screen !== 'menu' && !r.cancelled) {
      toast(r.success ? `${countryName(r.attacker)} захватила «${app.pname(r.province)}»` : `${countryName(r.defender)} отбила атаку на «${app.pname(r.province)}»`, 'info', 3000);
    }
  });

  // countdown ticker (cheap DOM updates only)
  // one ticker for every countdown; idle (no DOM work) while there are no battles
  setInterval(() => {
    if (!store.state?.battles.length || app.screen === 'menu' || document.hidden) return;
    tickCountdowns(app);
    tickBattleOverlay(app);
    if (store.state.battles.length) app.view.renderBattles(store.state, store.now());
  }, 250);
}

main().catch((err) => {
  console.error(err);
  toast('Не удалось загрузить игру. Обновите страницу.', 'error', 10000);
});

// expose for debugging in devtools
window.__app = app;
