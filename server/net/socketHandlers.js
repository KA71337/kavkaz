import { GameError } from '../game/GameRoom.js';
import { normalizeRoomId } from '../game/RoomManager.js';

const RATE_WINDOW_MS = 2_000;
const RATE_MAX = 20;
// WebRTC negotiation sends bursts of ICE candidates: separate, larger budget
const SIGNAL_MAX = 300;
const SIGNAL_MAX_BYTES = 16_000;

function rateLimiter(max) {
  let bucket = { start: Date.now(), count: 0 };
  return () => {
    const now = Date.now();
    if (now - bucket.start > RATE_WINDOW_MS) bucket = { start: now, count: 0 };
    bucket.count++;
    return bucket.count > max;
  };
}

/** Wires Socket.IO events to room actions. Every action is validated on the server. */
export function registerSocketHandlers(io, rooms) {
  io.on('connection', (socket) => {
    let room = null;
    let playerId = null;
    const limited = rateLimiter(RATE_MAX);
    const signalLimited = rateLimiter(SIGNAL_MAX);

    const action = (event, fn) => {
      socket.on(event, (payload, ack) => {
        const reply = typeof ack === 'function' ? ack : () => {};
        if (limited()) return reply({ ok: false, error: 'Слишком много действий, подождите' });
        if (event !== 'session:join' && (!room || !playerId)) {
          return reply({ ok: false, error: 'Нет активной сессии' });
        }
        try {
          const data = fn(payload && typeof payload === 'object' ? payload : {});
          // The room broadcast is debounced; send the resulting patch now so it reaches this client
          // before the reply (same socket = ordered delivery) instead of shipping a full snapshot.
          room?.flush();
          reply({ ok: true, ...(data || {}) });
        } catch (err) {
          if (err instanceof GameError) return reply({ ok: false, error: err.message });
          console.error(`[${event}]`, err);
          reply({ ok: false, error: 'Внутренняя ошибка сервера' });
        }
      });
    };

    action('session:join', ({ roomId, playerId: pid, token, name }) => {
      if (room && playerId) {
        room.voiceLeave(socket.id);
        room.disconnect(playerId, socket.id);
        socket.leave(channel(room.id));
      }
      room = rooms.get(normalizeRoomId(roomId));
      const player = room.join({ playerId: str(pid), token: str(token), name: str(name) }, socket.id);
      playerId = player.id;
      socket.join(channel(room.id));
      room.flush(); // everybody else learns about the new player; this client gets the full snapshot below
      return { playerId: player.id, token: player.token, room: room.id, state: room.snapshot(), voice: room.voicePeers() };
    });

    // Mutating actions reply without a snapshot: the patch with the change is flushed right before the reply.
    action('player:rename', ({ name }) => room.setName(playerId, str(name)));
    action('country:select', ({ countryId }) => {
      room.selectCountry(playerId, str(countryId));
    });
    action('country:leave', () => room.leaveCountry(playerId));
    action('war:declare', ({ countryId }) => ({ war: room.declareWar(playerId, str(countryId)) }));
    action('war:peace', ({ countryId }) => {
      room.makePeace(playerId, str(countryId));
    });
    action('battle:start', ({ provinceId }) => {
      const b = room.startBattle(playerId, str(provinceId));
      return { battleId: b.id, chance: b.chance, endsAt: b.endsAt };
    });
    action('state:get', () => ({ state: room.snapshot() }));

    // ---------------------------------------------------------------- voice chat signalling
    action('voice:join', () => ({ self: socket.id, peers: room.voiceJoin(socket.id, playerId) }));
    action('voice:leave', () => room.voiceLeave(socket.id));
    action('voice:mic', ({ on }) => room.voiceMic(socket.id, on === true));
    // SDP offers/answers and ICE candidates are relayed only between members of the same voice room.
    socket.on('voice:signal', (payload) => {
      if (!room || signalLimited() || !payload || typeof payload !== 'object') return;
      const { to, data } = payload;
      if (typeof to !== 'string' || !data || typeof data !== 'object') return;
      if (!room.inVoice(socket.id) || !room.inVoice(to)) return;
      if (JSON.stringify(data).length > SIGNAL_MAX_BYTES) return;
      io.to(to).emit('voice:signal', { from: socket.id, data });
    });

    socket.on('disconnect', () => {
      if (!room) return;
      room.voiceLeave(socket.id);
      if (playerId) room.disconnect(playerId, socket.id);
    });
  });
}

export function channel(roomId) {
  return `room:${roomId}`;
}

function str(v) {
  return typeof v === 'string' ? v.slice(0, 64) : '';
}
