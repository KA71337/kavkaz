/* global io */
// Thin promise-based wrapper around the Socket.IO connection.

const listeners = new Map();
export const socket = io({ transports: ['websocket', 'polling'], reconnectionDelayMax: 4000 });

export function request(event, payload = {}, timeoutMs = 8000) {
  return new Promise((resolve) => {
    if (!socket.connected) {
      resolve({ ok: false, error: 'Нет соединения с сервером' });
      return;
    }
    socket.timeout(timeoutMs).emit(event, payload, (err, res) => {
      if (err) resolve({ ok: false, error: 'Сервер не ответил, попробуйте ещё раз' });
      else resolve(res || { ok: false, error: 'Пустой ответ сервера' });
    });
  });
}

export function on(event, fn) {
  if (!listeners.has(event)) {
    listeners.set(event, new Set());
    socket.on(event, (payload) => listeners.get(event).forEach((f) => f(payload)));
  }
  listeners.get(event).add(fn);
  return () => listeners.get(event).delete(fn);
}
