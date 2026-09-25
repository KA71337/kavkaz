// Game rules shared by the server (authoritative) and the client (previews only).

export const BATTLE_DURATION_MS = 10_000;
export const MIN_ATTACK_TROOPS = 100;

// How many recent entries of each list the server keeps in the state (client trims patches the same way)
export const SNAPSHOT_LIMITS = { log: 40, results: 20, captures: 60 };

// Troop economy
export const TICK_MS = 5_000;
export const TROOPS_BASE_PER_TICK = 20;
export const TROOPS_PER_PROVINCE_PER_TICK = 12;
export const MAX_TROOPS = 60_000;

// Losses after a battle (share of the side's current troops)
export const LOSSES = {
  win: { attacker: 0.1, defender: 0.15 },
  loss: { attacker: 0.2, defender: 0.05 },
};

/**
 * Chance (in percent, 2 decimals) that an attack succeeds:
 *   attacker / (attacker + defender) × 100
 * 2000 vs 10000 -> 16.67%, 15000 vs 10000 -> 60%, 10000 vs 10000 -> 50%.
 * No artificial cap: while the defender has troops the chance stays below 100%.
 */
export function winChance(attackerTroops, defenderTroops) {
  const att = Math.max(0, Number(attackerTroops) || 0);
  const def = Math.max(0, Number(defenderTroops) || 0);
  if (att + def === 0) return 0;
  const rounded = Math.round((att / (att + def)) * 10_000) / 100;
  // rounding must not turn a huge-but-finite advantage into a guaranteed win
  if (def > 0 && rounded >= 100) return 99.99;
  return rounded;
}

/**
 * Battle outcome: `roll` is a uniform random number in (0, 100];
 * the attacker wins when roll <= chance, otherwise the defender wins.
 */
export function attackSucceeds(roll, chance) {
  return roll <= chance;
}

export function troopIncome(provinceCount) {
  return provinceCount > 0 ? TROOPS_BASE_PER_TICK + TROOPS_PER_PROVINCE_PER_TICK * provinceCount : 0;
}
