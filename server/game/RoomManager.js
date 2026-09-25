import { GameRoom } from './GameRoom.js';

export const DEFAULT_ROOM = 'global';
const ROOM_RE = /^[a-z0-9_-]{1,24}$/;

export function normalizeRoomId(id) {
  const s = String(id ?? '').trim().toLowerCase();
  return ROOM_RE.test(s) ? s : DEFAULT_ROOM;
}

/** Keeps independent game sessions (rooms) in memory. */
export class RoomManager {
  constructor(map, { emitFactory, idleMs = 30 * 60_000, roomOptions = {} } = {}) {
    this.map = map;
    this.emitFactory = emitFactory;
    this.rooms = new Map();
    this.idleMs = idleMs;
    this.roomOptions = roomOptions;
    this._gc = setInterval(() => this.collect(), 60_000);
    this._gc.unref?.();
  }

  get(id) {
    const roomId = normalizeRoomId(id);
    let room = this.rooms.get(roomId);
    if (!room) {
      room = new GameRoom(roomId, this.map, { ...this.roomOptions, emit: this.emitFactory(roomId) });
      this.rooms.set(roomId, room);
    }
    return room;
  }

  collect() {
    for (const [id, room] of this.rooms) {
      if (id !== DEFAULT_ROOM && room.isIdle(this.idleMs)) {
        room.dispose();
        this.rooms.delete(id);
      }
    }
  }

  stats() {
    return [...this.rooms.values()].map((r) => ({ id: r.id, players: r.players.size, battles: r.battles.size }));
  }

  dispose() {
    clearInterval(this._gc);
    for (const r of this.rooms.values()) r.dispose();
    this.rooms.clear();
  }
}
