// Client-side copy of the authoritative server state plus local session info.
import { applyPatch } from '/shared/sync.js';

const ID_KEY = 'kf:identity';
const NAME_KEY = 'kf:name';

export const store = {
  map: null, // static geometry from /data/map.json
  state: null, // latest server snapshot
  clockOffset: 0, // serverTime - Date.now()
  me: { playerId: null, token: null, room: 'global' },
  screen: 'menu', // menu | select | game
  listeners: new Set(),

  setState(state) {
    if (!state) return;
    if (this.state && state.version < this.state.version && state.room === this.state.room) return;
    this.replaceState(state);
  },
  /** Unconditional replace: full snapshots from session:join / state:get (the server may have restarted). */
  replaceState(state) {
    if (!state) return;
    this.state = state;
    this.clockOffset = state.serverTime - Date.now();
    this.emit();
  },
  /**
   * Merges an incremental server patch (see shared/sync.js).
   * @returns {boolean} false when a version gap was detected and a full snapshot is required
   */
  applyPatch(patch) {
    if (!this.state || this.state.room !== patch.room) return true; // the join reply brings the full state
    const next = applyPatch(this.state, patch);
    if (next === null) return false;
    if (next !== this.state) {
      this.state = next;
      this.clockOffset = next.serverTime - Date.now();
      this.emit();
    }
    return true;
  },
  emit() {
    this.listeners.forEach((fn) => fn(this));
  },
  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  },
  now() {
    return Date.now() + this.clockOffset;
  },
  get player() {
    return this.state?.players.find((p) => p.id === this.me.playerId) || null;
  },
  get myCountry() {
    return this.player?.country || null;
  },

  loadIdentity() {
    try {
      Object.assign(this.me, JSON.parse(localStorage.getItem(ID_KEY) || '{}'));
    } catch {
      /* ignore corrupted storage */
    }
    return this.me;
  },
  saveIdentity() {
    localStorage.setItem(ID_KEY, JSON.stringify(this.me));
  },
  get savedName() {
    return localStorage.getItem(NAME_KEY) || '';
  },
  set savedName(v) {
    localStorage.setItem(NAME_KEY, v);
  },
};
