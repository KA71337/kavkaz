// Incremental state sync. The server broadcasts only what changed since its previous broadcast
// ("patch"); clients merge it into their copy. Shared by the server (diff), client and tests (apply).
import { SNAPSHOT_LIMITS } from './rules.js';

const LIST_KEYS = {
  log: (e) => `${e.at}|${e.text}`,
  results: (e) => e.id,
  captures: (e) => `${e.at}|${e.province}|${e.to}`,
};
const WHOLE_KEYS = ['players', 'wars', 'battles'];

/** Compact memo of a broadcast snapshot, used to compute the next diff. */
export function shadowOf(snap) {
  const countries = {};
  for (const [id, c] of Object.entries(snap.countries)) countries[id] = JSON.stringify(c);
  const whole = {};
  for (const k of WHOLE_KEYS) whole[k] = JSON.stringify(snap[k]);
  const heads = {};
  for (const k of Object.keys(LIST_KEYS)) heads[k] = snap[k][0] ? LIST_KEYS[k](snap[k][0]) : null;
  return { version: snap.version, provinces: { ...snap.provinces }, countries, whole, heads };
}

/** Patch from the previous broadcast (`prev` = shadowOf(...)) to `snap`. */
export function diffSnapshot(prev, snap) {
  const patch = { room: snap.room, version: snap.version, base: prev ? prev.version : 0, serverTime: snap.serverTime };
  if (!prev) {
    patch.full = snap;
    return patch;
  }
  const provinces = {};
  let nProv = 0;
  for (const [pid, owner] of Object.entries(snap.provinces)) {
    if (prev.provinces[pid] !== owner) {
      provinces[pid] = owner;
      nProv++;
    }
  }
  if (nProv) patch.provinces = provinces;
  const countries = {};
  let nC = 0;
  for (const [id, c] of Object.entries(snap.countries)) {
    if (prev.countries[id] !== JSON.stringify(c)) {
      countries[id] = c;
      nC++;
    }
  }
  if (nC) patch.countries = countries;
  for (const k of WHOLE_KEYS) if (prev.whole[k] !== JSON.stringify(snap[k])) patch[k] = snap[k];
  for (const [k, keyOf] of Object.entries(LIST_KEYS)) {
    const list = snap[k];
    if (!list.length || prev.heads[k] === keyOf(list[0])) continue;
    const idx = prev.heads[k] == null ? list.length : list.findIndex((e) => keyOf(e) === prev.heads[k]);
    if (idx === -1) patch[`${k}Reset`] = list;
    else patch[k] = list.slice(0, idx);
  }
  return patch;
}

/**
 * Merges a patch into `state` and returns the new state object (the input is not mutated), or:
 *  - `state` itself when the patch is stale / for another room,
 *  - null when the patch cannot be applied (gap in versions) and a full resync is needed.
 */
export function applyPatch(state, patch) {
  if (patch.full) {
    if (state && state.room === patch.room && patch.version <= state.version) return state;
    return patch.full;
  }
  if (!state || state.room !== patch.room) return state;
  if (patch.version <= state.version) return state;
  if (patch.base > state.version) return null;
  const next = { ...state, version: patch.version, serverTime: patch.serverTime };
  if (patch.provinces) next.provinces = { ...state.provinces, ...patch.provinces };
  if (patch.countries) next.countries = { ...state.countries, ...patch.countries };
  for (const k of WHOLE_KEYS) if (patch[k]) next[k] = patch[k];
  for (const [k, keyOf] of Object.entries(LIST_KEYS)) {
    if (patch[`${k}Reset`]) next[k] = patch[`${k}Reset`];
    else if (patch[k]?.length) {
      // the client may already hold some of these entries (full snapshot taken after `base`)
      const known = new Set(state[k].map(keyOf));
      const fresh = patch[k].filter((e) => !known.has(keyOf(e)));
      next[k] = [...fresh, ...state[k]].slice(0, SNAPSHOT_LIMITS[k]);
    }
  }
  return next;
}
