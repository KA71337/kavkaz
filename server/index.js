import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import compression from 'compression';
import { Server } from 'socket.io';
import { loadMap, MAP_FILE } from './mapData.js';
import { RoomManager } from './game/RoomManager.js';
import { registerSocketHandlers, channel } from './net/socketHandlers.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');
const PORT = Number(process.env.PORT) || 3000;

/** @param {{roomOptions?: object}} [opts] roomOptions are forwarded to every GameRoom (used by tests). */
export function createServer({ roomOptions } = {}) {
  const map = loadMap();
  const app = express();
  app.disable('x-powered-by');
  const server = http.createServer(app);
  const io = new Server(server, { pingInterval: 20_000, pingTimeout: 25_000 });

  const rooms = new RoomManager(map, {
    roomOptions,
    emitFactory: (roomId) => (event, payload, target) => {
      (target ? io.to(target) : io.to(channel(roomId))).emit(event, payload);
    },
  });
  registerSocketHandlers(io, rooms);

  const staticOpts = { maxAge: process.env.NODE_ENV === 'production' ? '1h' : 0 };
  app.use(compression({ threshold: 1024 })); // map.json / JS / CSS are text: ~3× smaller over the wire
  app.get('/healthz', (_req, res) => res.json({ ok: true, rooms: rooms.stats() }));
  // WebRTC ICE servers for the voice chat. A TURN server (optional, via env) is needed only for players
  // behind strict NATs; credentials come from the environment and are never stored in the repository.
  app.get('/api/ice', (_req, res) => {
    const iceServers = [{ urls: (process.env.STUN_URLS || 'stun:stun.l.google.com:19302,stun:stun1.l.google.com:19302').split(',') }];
    if (process.env.TURN_URL) {
      iceServers.push({ urls: process.env.TURN_URL.split(','), username: process.env.TURN_USERNAME || '', credential: process.env.TURN_CREDENTIAL || '' });
    }
    res.set('Cache-Control', 'no-store').json({ iceServers });
  });
  // The original map from the repository root is the game's visual base layer.
  app.get('/assets/map.png', (_req, res) => res.sendFile(path.join(ROOT, 'image.png'), staticOpts));
  // Flag of Polgonustan (shown for the country with internal id 'armenia'), taken from the repository root.
  app.get('/assets/flags/polgonustan.jpeg', (_req, res) => res.sendFile(path.join(ROOT, 'полгонустан.jpeg'), staticOpts));
  app.get('/data/map.json', (_req, res) => res.sendFile(MAP_FILE, staticOpts));
  app.use('/shared', express.static(path.join(ROOT, 'shared'), staticOpts));
  app.use(express.static(path.join(ROOT, 'public'), staticOpts));

  return { app, server, io, rooms };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const { server, rooms, io } = createServer();
  server.listen(PORT, () => console.log(`Кавказский фронт запущен: http://localhost:${PORT}`));
  const shutdown = () => {
    rooms.dispose();
    io.close();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
