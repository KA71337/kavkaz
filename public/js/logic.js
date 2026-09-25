// Read-only helpers over the server snapshot + static map (UI only; the server re-validates everything).
import { winChance } from '/shared/rules.js';

export function ownerOf(state, pid) {
  return state.provinces[pid];
}

export function provincesOf(state, countryId) {
  return Object.keys(state.provinces).filter((pid) => state.provinces[pid] === countryId);
}

/** Provinces of `targetId` adjacent to territory of `countryId`. */
export function frontline(state, map, countryId, targetId) {
  const res = [];
  for (const p of map.provinces) {
    if (state.provinces[p.id] !== targetId) continue;
    if (p.neighbors.some((n) => state.provinces[n] === countryId)) res.push(p.id);
  }
  return res;
}

export function neighborCountries(state, map, countryId) {
  const set = new Map();
  for (const p of map.provinces) {
    if (state.provinces[p.id] !== countryId) continue;
    for (const n of p.neighbors) {
      const o = state.provinces[n];
      if (o !== countryId) {
        if (!set.has(o)) set.set(o, new Set());
        set.get(o).add(n);
      }
    }
  }
  return [...set.entries()].map(([id, pids]) => ({ id, frontline: [...pids] }));
}

export function warBetween(state, a, b) {
  return state.wars.find((w) => (w.attacker === a && w.defender === b) || (w.attacker === b && w.defender === a)) || null;
}

export function warsOf(state, countryId) {
  return state.wars.filter((w) => w.attacker === countryId || w.defender === countryId);
}

export function chanceAgainst(state, a, b) {
  return winChance(state.countries[a]?.troops, state.countries[b]?.troops);
}

export function myBattle(state, countryId) {
  return state.battles.find((b) => b.attacker === countryId) || null;
}

/** "Capital" = province with the largest label radius, used to place country labels. */
export function countryAnchor(state, map, countryId) {
  let best = null;
  for (const p of map.provinces) {
    if (state.provinces[p.id] !== countryId) continue;
    if (!best || p.labelRadius > best.labelRadius) best = p;
  }
  return best;
}
