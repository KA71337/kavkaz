import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { loadMap } from '../server/mapData.js';
import { GameRoom, GameError } from '../server/game/GameRoom.js';

const map = loadMap();
let room;
let events;
let nextRoll;

beforeEach(() => {
  events = [];
  nextRoll = 0;
  room = new GameRoom('t', map, {
    emit: (event, payload, target) => events.push({ event, payload, target }),
    battleDurationMs: 60_000, // resolved manually in tests
    tickMs: 1e9,
    random: () => nextRoll,
  });
});
afterEach(() => room.dispose());

const join = (name) => room.join({ name }, `sock-${name}`);
const provincesOf = (c) => [...room.provinces.values()].filter((p) => p.owner === c).map((p) => p.id);

test('provinces have id, owner, original owner and symmetric neighbours', () => {
  assert.equal(room.provinces.size, map.provinces.size);
  for (const p of room.provinces.values()) {
    assert.equal(p.owner, p.originalOwner);
    for (const n of map.provinces.get(p.id).neighbors) assert.ok(map.provinces.get(n).neighbors.has(p.id));
  }
});

test('a country taken by one player cannot be selected by another', () => {
  const a = join('A');
  const b = join('B');
  room.selectCountry(a.id, 'georgia');
  assert.throws(() => room.selectCountry(b.id, 'georgia'), (e) => e instanceof GameError && e.message === 'Эта страна уже занята');
  assert.equal(room.countries.get('georgia').player, a.id);
  room.selectCountry(b.id, 'abkhazia');
  assert.equal(room.snapshot().countries.abkhazia.player, b.id);
});

test('country is released after disconnect grace period and on leave', () => {
  const a = join('A');
  room.selectCountry(a.id, 'armenia');
  room.leaveCountry(a.id);
  assert.equal(room.countries.get('armenia').player, null);
  room.selectCountry(a.id, 'armenia');
  room.removePlayer(a.id);
  assert.equal(room.countries.get('armenia').player, null);
});

test('war only with neighbours; attack only on bordering provinces', () => {
  const a = join('A');
  room.selectCountry(a.id, 'abkhazia');
  assert.throws(() => room.declareWar(a.id, 'nakhchivan'), /только с соседями/);
  assert.throws(() => room.startBattle(a.id, 'georgia-03'), /объявите войну/);
  room.declareWar(a.id, 'georgia');
  const border = room.frontline('abkhazia', 'georgia');
  assert.ok(border.length > 0);
  const far = provincesOf('georgia').find((id) => !border.includes(id));
  assert.throws(() => room.startBattle(a.id, far), /соседнюю/);
});

test('battle chance is computed on the server; successful roll captures a single province', () => {
  const a = join('A');
  room.selectCountry(a.id, 'abkhazia');
  room.countries.get('abkhazia').troops = 2000;
  room.countries.get('georgia').troops = 10000;
  room.declareWar(a.id, 'georgia');
  const target = room.frontline('abkhazia', 'georgia')[0];
  const before = provincesOf('georgia').length;
  const battle = room.startBattle(a.id, target);
  assert.equal(battle.chance, 16.67); // 2000 / (2000 + 10000) × 100
  assert.equal(battle.endsAt - battle.startedAt, 60_000);
  assert.throws(() => room.startBattle(a.id, target), /уже в бою/);

  nextRoll = 1667; // 16.67 <= 16.67 -> win
  const r = room.resolveBattle(battle.id);
  assert.equal(r.success, true);
  assert.equal(room.provinces.get(target).owner, 'abkhazia');
  assert.equal(room.provinces.get(target).originalOwner, 'georgia');
  assert.equal(provincesOf('georgia').length, before - 1, 'only one province changes owner');
  assert.equal(room.captures[0].province, target);
  assert.ok(events.some((e) => e.event === 'battle:result' && e.payload.success));
});

test('failed roll keeps the province with the defender', () => {
  const a = join('A');
  room.selectCountry(a.id, 'abkhazia');
  room.countries.get('abkhazia').troops = 2000;
  room.countries.get('georgia').troops = 10000;
  room.declareWar(a.id, 'georgia');
  const target = room.frontline('abkhazia', 'georgia')[0];
  const battle = room.startBattle(a.id, target);
  nextRoll = 1668; // 16.68 > 16.67 -> loss
  const r = room.resolveBattle(battle.id);
  assert.equal(r.success, false);
  assert.equal(room.provinces.get(target).owner, 'georgia');
  assert.equal(room.results[0].id, battle.id);
});

test('roll distribution matches the chance (no 95% cap for a big advantage)', () => {
  const real = new GameRoom('d', map, { emit: () => {}, battleDurationMs: 60_000, tickMs: 1e9 });
  const p = real.join({ name: 'X' }, 's');
  real.selectCountry(p.id, 'abkhazia');
  real.declareWar(p.id, 'georgia');
  const target = real.frontline('abkhazia', 'georgia')[0];
  const N = 4000;
  for (const [att, def, expected] of [[2000, 10000, 16.67], [15000, 10000, 60]]) {
    let wins = 0;
    for (let i = 0; i < N; i++) {
      real.countries.get('abkhazia').troops = att;
      real.countries.get('georgia').troops = def;
      real.provinces.get(target).owner = 'georgia';
      const b = real.startBattle(p.id, target);
      assert.equal(b.chance, expected);
      if (real.resolveBattle(b.id).success) wins++;
    }
    const rate = (wins / N) * 100;
    assert.ok(Math.abs(rate - expected) < 3, `${att} vs ${def}: win rate ${rate}% (expected ≈${expected}%)`);
  }
  real.dispose();
});

test('Karabakh is split into separate provinces with their own ids, geometry and neighbours', () => {
  const nk = [...map.provinces.values()].filter((p) => p.country === 'artsakh');
  assert.deepEqual(nk.map((p) => p.id).sort(), ['NK_01', 'NK_02', 'NK_03', 'NK_04', 'NK_05', 'NK_06']);
  for (const p of nk) {
    assert.ok(p.area > 1000, `${p.id} has its own geometry`);
    assert.ok([...p.neighbors].some((n) => n.startsWith('NK_')), `${p.id} borders another Karabakh province`);
    assert.equal(room.provinces.get(p.id).owner, 'artsakh');
    assert.equal(room.provinces.get(p.id).originalOwner, 'artsakh');
  }
  // not every Karabakh province touches Azerbaijan: the interior must be reached province by province
  const frontline = room.frontline('azerbaijan', 'artsakh');
  assert.ok(frontline.length > 0 && frontline.length < nk.length, `frontline ${frontline}`);
});

test('Karabakh is captured one province at a time; full conquest only after the last one', () => {
  const a = join('A');
  room.selectCountry(a.id, 'azerbaijan');
  room.declareWar(a.id, 'artsakh');
  const nk = [...map.provinces.values()].filter((p) => p.country === 'artsakh').map((p) => p.id);
  const conquests = () => events.filter((e) => e.event === 'conquest');
  const captured = [];
  while (captured.length < nk.length) {
    const front = room.frontline('azerbaijan', 'artsakh');
    // only provinces adjacent to Azerbaijani territory are attackable
    for (const pid of nk.filter((id) => !front.includes(id) && !captured.includes(id))) {
      assert.throws(() => room.startBattle(a.id, pid), /соседнюю/);
    }
    const target = front[0];
    room.countries.get('azerbaijan').troops = 20000;
    const battle = room.startBattle(a.id, target);
    nextRoll = 1; // win
    room.resolveBattle(battle.id);
    captured.push(target);
    // exactly the attacked province changed owner, the rest stayed with Karabakh
    for (const id of nk) assert.equal(room.provinces.get(id).owner, captured.includes(id) ? 'azerbaijan' : 'artsakh', id);
    if (captured.length < nk.length) {
      assert.equal(conquests().length, 0, `no conquest notification after ${captured.length}/${nk.length}`);
      assert.equal(room.countries.get('artsakh').eliminated, false);
    }
  }
  assert.equal(room.countries.get('artsakh').eliminated, true);
  assert.deepEqual(conquests().map((e) => e.payload.type), ['eliminated']);
  assert.equal(conquests()[0].payload.country, 'artsakh');
  assert.equal(conquests()[0].payload.by, 'azerbaijan');
  assert.equal(conquests()[0].target, undefined, 'broadcast to every player of the room');
});

test('region event when a surviving country loses its whole original territory', () => {
  const a = join('A');
  room.selectCountry(a.id, 'azerbaijan');
  room.declareWar(a.id, 'artsakh');
  const nk = [...map.provinces.values()].filter((p) => p.country === 'artsakh').map((p) => p.id);
  // Karabakh still owns an Armenian province elsewhere, so it is not eliminated
  room.provinces.get('armenia-13').owner = 'artsakh';
  for (const id of nk.slice(1)) room.provinces.get(id).owner = 'azerbaijan';
  const last = nk[0];
  const battle = room.startBattle(a.id, last);
  nextRoll = 1;
  room.resolveBattle(battle.id);
  const c = events.filter((e) => e.event === 'conquest').map((e) => e.payload);
  assert.deepEqual(c.map((x) => [x.type, x.country, x.by]), [['region', 'artsakh', 'azerbaijan']]);
  assert.equal(room.countries.get('artsakh').eliminated, false);
});

test('broadcasts are incremental patches that rebuild the exact server state', async () => {
  const { applyPatch } = await import('../shared/sync.js');
  const a = join('A');
  let client = room.snapshot();
  room.flush();
  const patches = () => events.filter((e) => e.event === 'patch').map((e) => e.payload);
  room.selectCountry(a.id, 'abkhazia');
  room.declareWar(a.id, 'georgia');
  const target = room.frontline('abkhazia', 'georgia')[0];
  const battle = room.startBattle(a.id, target);
  nextRoll = 1;
  room.resolveBattle(battle.id);
  room.flush();
  const last = patches().at(-1);
  assert.deepEqual(Object.keys(last.provinces), [target], 'only the changed province is sent');
  for (const p of patches()) client = applyPatch(client, p) ?? client;
  const server = room.snapshot();
  for (const k of ['provinces', 'countries', 'players', 'wars', 'battles', 'results', 'captures', 'log']) {
    assert.deepEqual(client[k], server[k], k);
  }
  // a gap in versions is detected -> the client asks for a full snapshot
  assert.equal(applyPatch({ ...client, version: 1 }, { ...last, base: last.version + 5, version: last.version + 6 }), null);
});

test('country with no provinces left is eliminated and its player freed', () => {
  const a = join('A');
  const b = join('B');
  room.selectCountry(a.id, 'georgia');
  room.selectCountry(b.id, 'abkhazia');
  room.declareWar(a.id, 'abkhazia');
  const battle = room.startBattle(a.id, 'abkhazia-01');
  nextRoll = 0;
  room.resolveBattle(battle.id);
  assert.equal(room.countries.get('abkhazia').eliminated, true);
  assert.equal(room.players.get(b.id).country, null);
  assert.equal(room.wars.length, 0);
  const c = events.filter((e) => e.event === 'conquest');
  assert.equal(c.length, 1);
  assert.deepEqual([c[0].payload.type, c[0].payload.country, c[0].payload.by], ['eliminated', 'abkhazia', 'georgia']);
});
