import { randomInt, randomBytes } from 'node:crypto';
import { COUNTRIES, COUNTRY_BY_ID } from '../../shared/countries.js';
import {
  BATTLE_DURATION_MS,
  LOSSES,
  MAX_TROOPS,
  MIN_ATTACK_TROOPS,
  TICK_MS,
  troopIncome,
  winChance,
  attackSucceeds,
  SNAPSHOT_LIMITS,
} from '../../shared/rules.js';
import { shadowOf, diffSnapshot } from '../../shared/sync.js';

export class GameError extends Error {}

const MAX_LOG = SNAPSHOT_LIMITS.log;
const MAX_RESULTS = SNAPSHOT_LIMITS.results;
const MAX_CAPTURES = SNAPSHOT_LIMITS.captures;
const MAX_VOICE = 12; // full-mesh WebRTC: keep the voice room small

let seq = 0;
const nextId = (prefix) => `${prefix}${Date.now().toString(36)}${(seq++).toString(36)}`;

/**
 * One independent game session. All game rules are enforced here; clients only
 * send intentions (select country, declare war, attack province) and receive
 * the authoritative state.
 */
export class GameRoom {
  /**
   * @param {string} id room id
   * @param {{provinces: Map}} map province graph
   * @param {object} opts
   * @param {(event: string, payload: any, target?: string) => void} opts.emit transport callback
   * @param {number} [opts.disconnectGraceMs]
   * @param {number} [opts.battleDurationMs]
   * @param {number} [opts.tickMs]
   * @param {() => number} [opts.random] returns an integer in [1, 10000] (roll ×100)
   */
  constructor(id, map, opts) {
    this.id = id;
    this.map = map;
    this.emit = opts.emit;
    this.disconnectGraceMs = opts.disconnectGraceMs ?? 90_000;
    this.battleDurationMs = opts.battleDurationMs ?? BATTLE_DURATION_MS;
    this.random = opts.random ?? (() => randomInt(1, 10_001));
    this.createdAt = Date.now();
    this.lastActivity = Date.now();
    this.version = 0;

    this.players = new Map(); // playerId -> player
    this.countries = new Map();
    for (const c of COUNTRIES) {
      this.countries.set(c.id, { id: c.id, troops: c.troops, player: null, eliminated: false });
    }
    this.provinces = new Map();
    for (const p of map.provinces.values()) {
      this.provinces.set(p.id, { id: p.id, owner: p.country, originalOwner: p.country });
    }
    this.wars = []; // { id, attacker, defender, since }
    this.battles = new Map(); // id -> battle
    this.results = [];
    this.captures = [];
    this.log = [];
    this.voice = new Map(); // socketId -> { id, playerId, mic }

    this._stateTimer = null;
    this._sent = null; // shadow of the last broadcast snapshot (base of the next patch)
    this._tick = setInterval(() => this.tick(), opts.tickMs ?? TICK_MS);
    this._tick.unref?.();
  }

  // ------------------------------------------------------------ players
  join({ playerId, token, name }, socketId) {
    this.lastActivity = Date.now();
    let player = playerId ? this.players.get(playerId) : null;
    if (player && player.token !== token) player = null; // foreign id -> new identity
    if (!player) {
      player = {
        id: randomBytes(8).toString('hex'),
        token: randomBytes(16).toString('hex'),
        name: cleanName(name),
        country: null,
        sockets: new Set(),
        online: true,
        releaseTimer: null,
        joinedAt: Date.now(),
      };
      this.players.set(player.id, player);
      this.addLog(`${player.name} вошёл в игру`, 'join');
    } else if (name) {
      player.name = cleanName(name);
    }
    if (player.releaseTimer) {
      clearTimeout(player.releaseTimer);
      player.releaseTimer = null;
    }
    player.sockets.add(socketId);
    player.online = true;
    this.changed();
    return player;
  }

  disconnect(playerId, socketId) {
    const player = this.players.get(playerId);
    if (!player) return;
    player.sockets.delete(socketId);
    if (player.sockets.size > 0) return;
    player.online = false;
    player.lastSeen = Date.now();
    player.releaseTimer = setTimeout(() => this.removePlayer(player.id), this.disconnectGraceMs);
    player.releaseTimer.unref?.();
    this.changed();
  }

  removePlayer(playerId) {
    const player = this.players.get(playerId);
    if (!player) return;
    if (player.releaseTimer) clearTimeout(player.releaseTimer);
    if (player.country) this._releaseCountry(player, `${player.name} покинул игру`);
    this.players.delete(playerId);
    this.changed();
  }

  setName(playerId, name) {
    const player = this.requirePlayer(playerId);
    player.name = cleanName(name);
    this.changed();
  }

  // ------------------------------------------------------------ countries
  /** Atomic: Node handles one message at a time, so the first request wins. */
  selectCountry(playerId, countryId) {
    const player = this.requirePlayer(playerId);
    const country = this.countries.get(countryId);
    if (!country) throw new GameError('Такой страны нет');
    if (country.eliminated) throw new GameError('Эта страна уничтожена');
    if (country.player && country.player !== player.id) throw new GameError('Эта страна уже занята');
    if (player.country === countryId) return country;
    if (player.country) this._releaseCountry(player, null);
    country.player = player.id;
    player.country = countryId;
    this.addLog(`${player.name} играет за: ${COUNTRY_BY_ID[countryId].name}`, 'select');
    this.changed();
    return country;
  }

  leaveCountry(playerId) {
    const player = this.requirePlayer(playerId);
    if (!player.country) return;
    this._releaseCountry(player, `${player.name} отказался от страны ${COUNTRY_BY_ID[player.country].name}`);
    this.changed();
  }

  _releaseCountry(player, message) {
    const country = this.countries.get(player.country);
    if (country && country.player === player.id) country.player = null;
    player.country = null;
    if (message) this.addLog(message, 'leave');
  }

  // ------------------------------------------------------------ war
  declareWar(playerId, targetId) {
    const { country } = this.requireCountry(playerId);
    const target = this.countries.get(targetId);
    if (!target || target.eliminated) throw new GameError('Цель недоступна');
    if (target.id === country.id) throw new GameError('Нельзя объявить войну самому себе');
    if (!this.areNeighbors(country.id, target.id)) throw new GameError('Можно воевать только с соседями');
    if (this.findWar(country.id, target.id)) throw new GameError('Вы уже воюете с этой страной');
    const war = { id: nextId('w'), attacker: country.id, defender: target.id, since: Date.now() };
    this.wars.push(war);
    this.addLog(`${cname(country.id)} объявляет войну: ${cname(target.id)}`, 'war');
    if (target.player) {
      this.notifyPlayer(target.player, { type: 'war', text: `${cname(country.id)} объявила вам войну!` });
    }
    this.changed();
    return war;
  }

  makePeace(playerId, targetId) {
    const { country } = this.requireCountry(playerId);
    const war = this.wars.find((w) => w.attacker === country.id && w.defender === targetId);
    if (!war) throw new GameError('Мир может заключить только сторона, начавшая войну');
    for (const b of this.battles.values()) {
      if ((b.attacker === country.id && b.defender === targetId) || (b.attacker === targetId && b.defender === country.id)) {
        throw new GameError('Дождитесь окончания сражения');
      }
    }
    this.wars = this.wars.filter((w) => w !== war);
    this.addLog(`${cname(country.id)} и ${cname(targetId)} заключили мир`, 'peace');
    const target = this.countries.get(targetId);
    if (target?.player) this.notifyPlayer(target.player, { type: 'peace', text: `${cname(country.id)} заключила с вами мир` });
    this.changed();
  }

  startBattle(playerId, provinceId) {
    const { player, country } = this.requireCountry(playerId);
    const province = this.provinces.get(provinceId);
    if (!province) throw new GameError('Провинция не найдена');
    const defenderId = province.owner;
    if (defenderId === country.id) throw new GameError('Это ваша провинция');
    if (!this.findWar(country.id, defenderId)) throw new GameError('Сначала объявите войну владельцу провинции');
    if (!this.bordersProvince(country.id, provinceId)) throw new GameError('Атаковать можно только соседнюю с вами провинцию');
    for (const b of this.battles.values()) {
      if (b.attacker === country.id) throw new GameError('Ваша армия уже в бою');
      if (b.province === provinceId) throw new GameError('За эту провинцию уже идёт сражение');
    }
    if (country.troops < MIN_ATTACK_TROOPS) throw new GameError(`Нужно минимум ${MIN_ATTACK_TROOPS} войск`);
    const defender = this.countries.get(defenderId);
    const chance = winChance(country.troops, defender.troops);
    const now = Date.now();
    const battle = {
      id: nextId('b'),
      attacker: country.id,
      defender: defenderId,
      province: provinceId,
      attackerTroops: country.troops,
      defenderTroops: defender.troops,
      chance,
      startedAt: now,
      endsAt: now + this.battleDurationMs,
      by: player.id,
    };
    battle.timer = setTimeout(() => this.resolveBattle(battle.id), this.battleDurationMs);
    battle.timer.unref?.();
    this.battles.set(battle.id, battle);
    this.addLog(`${cname(country.id)} атакует провинцию ${this.pname(provinceId)} (${cname(defenderId)}), шанс ${chance}%`, 'battle');
    this.emit('battle:started', publicBattle(battle));
    if (defender.player) {
      this.notifyPlayer(defender.player, { type: 'attack', text: `${cname(country.id)} атакует вашу провинцию ${this.pname(provinceId)}!` });
    }
    this.changed();
    return battle;
  }

  resolveBattle(battleId) {
    const battle = this.battles.get(battleId);
    if (!battle) return null;
    clearTimeout(battle.timer);
    this.battles.delete(battleId);
    const province = this.provinces.get(battle.province);
    const attacker = this.countries.get(battle.attacker);
    const defender = this.countries.get(battle.defender);
    const base = { id: battle.id, attacker: battle.attacker, defender: battle.defender, province: battle.province, chance: battle.chance, at: Date.now() };

    if (!province || province.owner !== battle.defender || attacker.eliminated) {
      const result = { ...base, cancelled: true, success: false, roll: null };
      this.addLog(`Сражение за ${this.pname(battle.province)} отменено`, 'battle');
      this.emit('battle:result', result);
      this.changed();
      return result;
    }

    // Server-side roll: 0.01 .. 100.00 (uniform); attacker wins when roll <= chance,
    // so exactly `chance` percent of rolls are wins.
    const roll = this.random() / 100;
    const success = attackSucceeds(roll, battle.chance);
    const losses = success ? LOSSES.win : LOSSES.loss;
    const attackerLoss = Math.round(attacker.troops * losses.attacker);
    const defenderLoss = Math.round(defender.troops * losses.defender);
    attacker.troops = Math.max(0, attacker.troops - attackerLoss);
    defender.troops = Math.max(0, defender.troops - defenderLoss);

    if (success) {
      province.owner = battle.attacker;
      this.captures.unshift({ province: province.id, from: battle.defender, to: battle.attacker, at: base.at });
      this.captures.length = Math.min(this.captures.length, MAX_CAPTURES);
      this.addLog(`${cname(battle.attacker)} захватила провинцию ${this.pname(province.id)}`, 'capture');
    } else {
      this.addLog(`${cname(battle.defender)} отбила атаку на ${this.pname(province.id)}`, 'defense');
    }

    const result = { ...base, success, roll: Math.round(roll * 100) / 100, attackerLoss, defenderLoss, cancelled: false };
    this.results.unshift(result);
    this.results.length = Math.min(this.results.length, MAX_RESULTS);
    this.emit('battle:result', result);
    if (success) this.checkConquest(province, battle.defender, battle.attacker);
    this.changed();
    return result;
  }

  /**
   * After a capture: a country that has no province left is eliminated ("АРМЕНИЯ ЗАХВАЧЕНА" for everyone).
   * Independently, when the attacker now holds every province of a region (the original territory of a
   * country, e.g. all NK_* provinces) while that country still survives elsewhere, a region event is sent.
   */
  checkConquest(province, defenderId, attackerId) {
    const eliminated = this.checkElimination(defenderId, attackerId);
    const at = Date.now();
    if (eliminated) {
      this.emit('conquest', { type: 'eliminated', country: defenderId, by: attackerId, province: province.id, at });
    }
    const region = province.originalOwner;
    if (region === attackerId || (eliminated && region === defenderId)) return;
    for (const p of this.provinces.values()) {
      if (p.originalOwner === region && p.owner !== attackerId) return;
    }
    this.addLog(`${cname(attackerId)} полностью захватила территорию: ${cname(region)}`, 'capture');
    this.emit('conquest', { type: 'region', country: region, by: attackerId, province: province.id, at });
  }

  /** @returns {boolean} true when the country has just been eliminated */
  checkElimination(countryId, byId) {
    if (this.provinceCount(countryId) > 0) return false;
    if (this.countries.get(countryId).eliminated) return false;
    const country = this.countries.get(countryId);
    country.eliminated = true;
    country.troops = 0;
    this.wars = this.wars.filter((w) => w.attacker !== countryId && w.defender !== countryId);
    for (const b of [...this.battles.values()]) {
      if (b.attacker === countryId) {
        clearTimeout(b.timer);
        this.battles.delete(b.id);
      }
    }
    this.addLog(`${cname(countryId)} уничтожена. Победитель: ${cname(byId)}`, 'eliminated');
    if (country.player) {
      const player = this.players.get(country.player);
      this.notifyPlayer(country.player, { type: 'eliminated', text: `Ваша страна ${cname(countryId)} уничтожена. Выберите другую страну.` });
      if (player) player.country = null;
      country.player = null;
    }
    return true;
  }

  // ------------------------------------------------------------ economy
  tick() {
    const counts = this.provinceCounts();
    let dirty = false;
    for (const c of this.countries.values()) {
      if (c.eliminated) continue;
      const add = troopIncome(counts[c.id] || 0);
      const next = Math.min(MAX_TROOPS, c.troops + add);
      if (next !== c.troops) {
        c.troops = next;
        dirty = true;
      }
    }
    if (dirty) this.changed();
  }

  // ------------------------------------------------------------ queries
  requirePlayer(playerId) {
    const player = this.players.get(playerId);
    if (!player) throw new GameError('Сессия не найдена, обновите страницу');
    return player;
  }

  requireCountry(playerId) {
    const player = this.requirePlayer(playerId);
    const country = player.country ? this.countries.get(player.country) : null;
    if (!country || country.player !== player.id) throw new GameError('Сначала выберите страну');
    if (country.eliminated) throw new GameError('Ваша страна уничтожена');
    return { player, country };
  }

  findWar(a, b) {
    return this.wars.find((w) => (w.attacker === a && w.defender === b) || (w.attacker === b && w.defender === a)) || null;
  }

  provinceCount(countryId) {
    let n = 0;
    for (const p of this.provinces.values()) if (p.owner === countryId) n++;
    return n;
  }

  provinceCounts() {
    const counts = {};
    for (const p of this.provinces.values()) counts[p.owner] = (counts[p.owner] || 0) + 1;
    return counts;
  }

  /** Does `countryId` own a province adjacent to `provinceId`? */
  bordersProvince(countryId, provinceId) {
    const geo = this.map.provinces.get(provinceId);
    if (!geo) return false;
    for (const n of geo.neighbors) if (this.provinces.get(n).owner === countryId) return true;
    return false;
  }

  /** Provinces of `targetId` that border territory of `countryId`. */
  frontline(countryId, targetId) {
    const out = [];
    for (const p of this.provinces.values()) {
      if (p.owner === targetId && this.bordersProvince(countryId, p.id)) out.push(p.id);
    }
    return out;
  }

  areNeighbors(a, b) {
    return this.frontline(a, b).length > 0;
  }

  pname(provinceId) {
    return this.map.provinces.get(provinceId)?.name ?? provinceId;
  }

  // ------------------------------------------------------------ sync
  addLog(text, type) {
    this.log.unshift({ at: Date.now(), text, type });
    this.log.length = Math.min(this.log.length, MAX_LOG);
  }

  notifyPlayer(playerId, payload) {
    const player = this.players.get(playerId);
    if (!player) return;
    for (const sid of player.sockets) this.emit('notify', payload, sid);
  }

  changed() {
    this.version++;
    this.lastActivity = Date.now();
    if (this._stateTimer) return;
    // coalesce bursts of changes into one broadcast
    this._stateTimer = setTimeout(() => {
      this._stateTimer = null;
      this.broadcast();
    }, 30);
    this._stateTimer.unref?.();
  }

  /** Sends only what changed since the previous broadcast (see shared/sync.js). */
  broadcast() {
    const snap = this.snapshot();
    const patch = diffSnapshot(this._sent, snap);
    this._sent = shadowOf(snap);
    this.emit('patch', patch);
  }

  /** Broadcasts pending changes right now (before replying to the player who caused them). */
  flush() {
    if (!this._stateTimer) return;
    clearTimeout(this._stateTimer);
    this._stateTimer = null;
    this.broadcast();
  }

  // ------------------------------------------------------------ voice chat (signalling only; audio is P2P)
  voiceJoin(socketId, playerId) {
    this.requirePlayer(playerId);
    if (!this.voice.has(socketId) && this.voice.size >= MAX_VOICE) throw new GameError('Голосовой чат заполнен');
    const prev = this.voice.get(socketId);
    this.voice.set(socketId, { id: socketId, playerId, mic: prev?.mic ?? false });
    this.emitVoice();
    return this.voicePeers();
  }

  voiceLeave(socketId) {
    if (this.voice.delete(socketId)) this.emitVoice();
  }

  voiceMic(socketId, on) {
    const v = this.voice.get(socketId);
    if (!v) throw new GameError('Вы не в голосовом чате');
    if (v.mic === !!on) return;
    v.mic = !!on;
    this.emitVoice();
  }

  inVoice(socketId) {
    return this.voice.has(socketId);
  }

  voicePeers() {
    return [...this.voice.values()].map((v) => {
      const p = this.players.get(v.playerId);
      return { id: v.id, playerId: v.playerId, name: p?.name ?? '?', country: p?.country ?? null, mic: v.mic };
    });
  }

  emitVoice() {
    this.emit('voice:peers', this.voicePeers());
  }

  snapshot() {
    const counts = this.provinceCounts();
    const countries = {};
    for (const c of this.countries.values()) {
      const p = c.player ? this.players.get(c.player) : null;
      countries[c.id] = {
        id: c.id,
        troops: c.troops,
        player: c.player,
        playerName: p ? p.name : null,
        playerOnline: p ? p.online : false,
        eliminated: c.eliminated,
        provinces: counts[c.id] || 0,
      };
    }
    const provinces = {};
    for (const p of this.provinces.values()) provinces[p.id] = p.owner;
    return {
      room: this.id,
      version: this.version,
      serverTime: Date.now(),
      players: [...this.players.values()].map((p) => ({ id: p.id, name: p.name, country: p.country, online: p.online })),
      countries,
      provinces,
      wars: this.wars.map((w) => ({ ...w })),
      battles: [...this.battles.values()].map(publicBattle),
      results: this.results,
      captures: this.captures,
      log: this.log,
    };
  }

  isIdle(ms) {
    return this.players.size === 0 && Date.now() - this.lastActivity > ms;
  }

  dispose() {
    clearInterval(this._tick);
    clearTimeout(this._stateTimer);
    for (const b of this.battles.values()) clearTimeout(b.timer);
    for (const p of this.players.values()) if (p.releaseTimer) clearTimeout(p.releaseTimer);
  }
}

function publicBattle(b) {
  return {
    id: b.id,
    attacker: b.attacker,
    defender: b.defender,
    province: b.province,
    chance: b.chance,
    attackerTroops: b.attackerTroops,
    defenderTroops: b.defenderTroops,
    startedAt: b.startedAt,
    endsAt: b.endsAt,
  };
}

function cname(id) {
  return COUNTRY_BY_ID[id]?.name ?? id;
}

function cleanName(name) {
  const s = String(name ?? '')
    .replace(/[<>&"'`]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 20);
  return s || `Игрок-${Math.floor(1000 + Math.random() * 9000)}`;
}
