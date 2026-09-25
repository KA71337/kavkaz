// End-to-end: real HTTP + Socket.IO server with several clients.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { io as connect } from 'socket.io-client';
import { createServer } from '../server/index.js';
import { applyPatch } from '../shared/sync.js';

let srv;
let url;
const clients = [];

before(async () => {
  srv = createServer({ roomOptions: { battleDurationMs: 300, disconnectGraceMs: 200, tickMs: 1e9 } });
  await new Promise((r) => srv.server.listen(0, r));
  url = `http://localhost:${srv.server.address().port}`;
});

after(async () => {
  clients.forEach((c) => c.close());
  srv.rooms.dispose();
  srv.io.close();
  await new Promise((r) => srv.server.close(r));
});

async function client() {
  const c = connect(url, { transports: ['websocket'], forceNew: true });
  clients.push(c);
  // client-side copy of the state, kept up to date exactly like the browser does (join snapshot + patches)
  c.state = null;
  c.patchBytes = 0;
  c.on('patch', (p) => {
    c.patchBytes += JSON.stringify(p).length;
    const next = applyPatch(c.state, p);
    if (next) c.state = next;
  });
  await new Promise((r) => c.on('connect', r));
  return c;
}
const req = async (c, ev, payload = {}) => {
  const res = await c.timeout(3000).emitWithAck(ev, payload);
  if (res?.state) c.state = res.state;
  return res;
};
const waitFor = (c, ev, pred = () => true) =>
  new Promise((resolve) => {
    const h = (p) => {
      if (pred(p)) {
        c.off(ev, h);
        resolve(p);
      }
    };
    c.on(ev, h);
  });

test('two players, occupied countries, synced war and capture', async () => {
  const a = await client();
  const b = await client();
  const ja = await req(a, 'session:join', { roomId: 'e2e', name: 'Alice' });
  const jb = await req(b, 'session:join', { roomId: 'e2e', name: 'Bob' });
  assert.ok(ja.ok && jb.ok);
  assert.notEqual(ja.playerId, jb.playerId);

  // simultaneous requests for the same country: exactly one wins
  const [ra, rb] = await Promise.all([req(a, 'country:select', { countryId: 'georgia' }), req(b, 'country:select', { countryId: 'georgia' })]);
  assert.equal([ra, rb].filter((r) => r.ok).length, 1);
  const loser = ra.ok ? b : a;
  const winner = ra.ok ? a : b;
  assert.equal((ra.ok ? rb : ra).error, 'Эта страна уже занята');
  assert.ok((await req(loser, 'country:select', { countryId: 'abkhazia' })).ok);

  // the other player sees who owns what
  const seen = await req(winner, 'state:get');
  assert.ok(seen.state.countries.abkhazia.player);
  assert.ok(seen.state.countries.georgia.player);
  assert.equal(seen.state.players.length, 2);

  // war -> battle -> result is broadcast to everyone
  const declared = await req(loser, 'war:declare', { countryId: 'georgia' });
  assert.ok(declared.ok);
  assert.equal(declared.state, undefined, 'acks no longer carry the whole state');
  // the patch with the war is flushed before the ack, so the client can pick a target at once
  assert.ok(loser.state.wars.some((w) => w.defender === 'georgia'));
  const frontline = Object.keys(seen.state.provinces).filter((id) => id.startsWith('georgia-'));
  let started = null;
  for (const pid of frontline) {
    const r = await req(loser, 'battle:start', { provinceId: pid });
    if (r.ok) {
      started = { pid, ...r };
      break;
    }
    assert.match(r.error, /соседнюю/);
  }
  assert.ok(started, 'some Georgian province borders Abkhazia');
  assert.ok(started.endsAt > Date.now());

  const [resA, resB] = await Promise.all([waitFor(a, 'battle:result'), waitFor(b, 'battle:result')]);
  assert.deepEqual(resA, resB);
  assert.equal(resA.province, started.pid);
  assert.equal(typeof resA.roll, 'number');

  await new Promise((r) => setTimeout(r, 100));
  const after = (await c2s(winner)).state;
  assert.equal(after.provinces[started.pid], resA.success ? 'abkhazia' : 'georgia');
  assert.equal(after.results[0].id, resA.id);
  // both players' patched copies match the authoritative snapshot
  for (const c of [a, b]) {
    assert.deepEqual(c.state.provinces, after.provinces);
    assert.deepEqual(c.state.countries, after.countries);
    assert.deepEqual(c.state.results, after.results);
  }
});

const c2s = (c) => c.timeout(3000).emitWithAck('state:get', {});

test('full conquest is announced to every player; only changed provinces travel over the wire', async () => {
  const a = await client();
  const b = await client();
  const w = await client();
  await req(a, 'session:join', { roomId: 'e2e-nk', name: 'Aze' });
  await req(b, 'session:join', { roomId: 'e2e-nk', name: 'Nk' });
  await req(w, 'session:join', { roomId: 'e2e-nk', name: 'Watcher' });
  assert.ok((await req(a, 'country:select', { countryId: 'azerbaijan' })).ok);
  assert.ok((await req(b, 'country:select', { countryId: 'artsakh' })).ok);
  assert.ok((await req(a, 'war:declare', { countryId: 'artsakh' })).ok);
  const room = srv.rooms.get('e2e-nk');
  room.random = () => 1; // every attack wins
  const all = [a, b, w];
  for (const c of all) {
    c.conquests = [];
    c.on('conquest', (e) => c.conquests.push(e));
  }
  const nk = Object.keys(a.state.provinces).filter((id) => id.startsWith('NK_'));
  assert.equal(nk.length, 6);
  for (let i = 0; i < nk.length; i++) {
    room.countries.get('azerbaijan').troops = 30000;
    const front = nk.filter((id) => a.state.provinces[id] === 'artsakh' && room.bordersProvince('azerbaijan', id));
    const before = a.patchBytes;
    const r = await req(a, 'battle:start', { provinceId: front[0] });
    assert.ok(r.ok, r.error);
    const res = await waitFor(w, 'battle:result', (x) => x.province === front[0]);
    assert.equal(res.success, true);
    await new Promise((r2) => setTimeout(r2, 80));
    // every client sees the new owner of just that province
    for (const c of all) assert.equal(c.state.provinces[front[0]], 'azerbaijan');
    assert.ok(a.patchBytes - before < 8000, `patch traffic per capture: ${a.patchBytes - before} bytes`);
    if (i < nk.length - 1) for (const c of all) assert.equal(c.conquests.length, 0, 'no notification before the last province');
  }
  for (const c of all) {
    assert.equal(c.conquests.length, 1);
    assert.equal(c.conquests[0].type, 'eliminated');
    assert.equal(c.conquests[0].country, 'artsakh');
    assert.equal(c.conquests[0].by, 'azerbaijan');
  }
  assert.ok(w.state.countries.artsakh.eliminated);
});

test('voice chat: membership, mic state and signalling relay between room members only', async () => {
  const a = await client();
  const b = await client();
  const x = await client();
  await req(a, 'session:join', { roomId: 'e2e-voice', name: 'A' });
  await req(b, 'session:join', { roomId: 'e2e-voice', name: 'B' });
  await req(x, 'session:join', { roomId: 'e2e-other', name: 'X' });
  const ja = await req(a, 'voice:join');
  assert.ok(ja.ok);
  const peersSeen = waitFor(a, 'voice:peers', (list) => list.length === 2);
  const jb = await req(b, 'voice:join');
  assert.equal(jb.peers.length, 2);
  await peersSeen;
  const micOn = waitFor(b, 'voice:peers', (list) => list.find((p) => p.id === ja.self)?.mic === true);
  assert.ok((await req(a, 'voice:mic', { on: true })).ok);
  await micOn;
  const got = waitFor(b, 'voice:signal');
  a.emit('voice:signal', { to: jb.self, data: { type: 'offer', sdp: 'v=0' } });
  const sig = await got;
  assert.equal(sig.from, ja.self);
  assert.equal(sig.data.type, 'offer');
  // a socket outside the voice room cannot inject signals
  let leaked = false;
  b.on('voice:signal', (s) => { if (s.from === x.id) leaked = true; });
  x.emit('voice:signal', { to: jb.self, data: { type: 'offer', sdp: 'evil' } });
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(leaked, false);
  const left = waitFor(b, 'voice:peers', (list) => list.length === 1);
  a.close();
  await left;
});

test('client cannot forge results or attack without war', async () => {
  const c = await client();
  await req(c, 'session:join', { roomId: 'e2e-2', name: 'Eve' });
  assert.equal((await req(c, 'battle:start', { provinceId: 'georgia-01' })).error, 'Сначала выберите страну');
  await req(c, 'country:select', { countryId: 'armenia' });
  const r = await req(c, 'battle:start', { provinceId: 'azerbaijan-01', success: true });
  assert.equal(r.ok, false);
  const s = (await req(c, 'state:get')).state;
  assert.equal(s.provinces['azerbaijan-01'], 'azerbaijan');
});

test('country is released after disconnect; reconnect with token restores identity', async () => {
  const a = await client();
  const j = await req(a, 'session:join', { roomId: 'e2e-3', name: 'Ann' });
  await req(a, 'country:select', { countryId: 'nakhchivan' });
  a.close();

  const a2 = await client();
  const back = await req(a2, 'session:join', { roomId: 'e2e-3', playerId: j.playerId, token: j.token });
  assert.equal(back.playerId, j.playerId);
  assert.equal(back.state.countries.nakhchivan.player, j.playerId);
  a2.close();

  await new Promise((r) => setTimeout(r, 400));
  const b = await client();
  const jb = await req(b, 'session:join', { roomId: 'e2e-3', name: 'Ben' });
  assert.equal(jb.state.countries.nakhchivan.player, null);
  assert.ok((await req(b, 'country:select', { countryId: 'nakhchivan' })).ok);
});
