// Real-time voice chat: full-mesh WebRTC audio between the players of a room. The server only relays
// signalling (voice:join / voice:signal / voice:mic) - audio goes peer-to-peer.
//
// Two independent switches:
//   mic   - "я говорю": getUserMedia track is attached to every sender. When turned off the track is
//           detached (replaceTrack(null)) AND stopped, so nothing is captured or transmitted.
//   deaf  - "я не слышу игроков": every remote <audio> element is muted; own mic is not affected.
//
// This module is loaded lazily (dynamic import) the first time the player opens the voice chat.
import { audioCtx } from '../ui/sound.js';

const SPEAK_THRESHOLD = 0.035; // RMS of the waveform, 0..1
const SPEAK_POLL_MS = 150;
const SPEAK_HOLD_MS = 450;

export const MIC_DENIED = 'Доступ к микрофону запрещён. Разрешите доступ в настройках браузера.';

export class VoiceChat {
  /**
   * @param {object} o
   * @param {import('socket.io-client').Socket} o.socket
   * @param {(ev: string, payload?: object) => Promise<any>} o.request
   * @param {(ev: string, fn: Function) => () => void} o.on
   * @param {() => void} o.onChange  UI refresh
   */
  constructor({ socket, request, on, onChange }) {
    this.socket = socket;
    this.request = request;
    this.subscribe = on;
    this.onChange = onChange;
    this.joined = false;
    this.mic = false;
    this.deaf = false;
    this.peers = []; // from the server: { id, playerId, name, country, mic }
    this.pcs = new Map(); // socketId -> { pc, audio, pendingIce, initiator, meter }
    this.stream = null; // local mic stream (only while mic is on)
    this.localMeter = null;
    this.speaking = new Set(); // socket ids (own id included) currently talking
    this.needsUnlock = false; // autoplay blocked: the UI shows a "turn sound on" button
    this.iceServers = null;
    this._offs = [];
    this._meterTimer = null;
    this._audioRoot = null;
  }

  get self() {
    return this.socket.id;
  }

  // ------------------------------------------------------------------ membership
  async join() {
    if (this.joined) return { ok: true };
    if (!this.iceServers) {
      try {
        this.iceServers = (await (await fetch('/api/ice', { cache: 'no-store' })).json()).iceServers;
      } catch {
        this.iceServers = [{ urls: ['stun:stun.l.google.com:19302'] }];
      }
    }
    this._offs.push(this.subscribe('voice:peers', (list) => this.joined && this.syncPeers(list)));
    this._offs.push(this.subscribe('voice:signal', (msg) => this.joined && this.onSignal(msg)));
    this.joined = true; // before the request: the server broadcasts voice:peers before it replies
    const res = await this.request('voice:join');
    if (!res.ok) {
      this.leave(false);
      return res;
    }
    this.syncPeers(res.peers);
    if (this.mic) await this.request('voice:mic', { on: true });
    this.startMeters();
    this.onChange();
    return res;
  }

  /** Releases every resource: peer connections, audio elements, mic tracks, timers. */
  leave(notify = true) {
    if (notify && this.joined) this.request('voice:leave');
    this.joined = false;
    this._offs.forEach((off) => off());
    this._offs = [];
    for (const id of [...this.pcs.keys()]) this.closePeer(id);
    this.stopMic();
    this.mic = false;
    this.stopMeters();
    this.peers = [];
    this.speaking.clear();
    this.needsUnlock = false;
    this.onChange();
  }

  /** Socket dropped: the server already removed us; connections are dead. Keep the intent (mic state). */
  suspend() {
    if (!this.joined) return false;
    const wasMic = this.mic;
    this.leave(false);
    return { mic: wasMic };
  }

  async resume(prev) {
    const res = await this.join();
    if (res.ok && prev?.mic) await this.setMic(true);
    return res;
  }

  syncPeers(list) {
    if (!Array.isArray(list)) return;
    this.peers = list;
    const ids = new Set(list.map((p) => p.id));
    for (const id of [...this.pcs.keys()]) if (!ids.has(id)) this.closePeer(id);
    for (const p of list) {
      if (p.id === this.self || this.pcs.has(p.id)) continue;
      // deterministic roles avoid offer glare: the smaller socket id makes the offer
      if (this.self < p.id) this.createPeer(p.id, true);
    }
    this.onChange();
  }

  // ------------------------------------------------------------------ peer connections
  createPeer(id, initiator) {
    const pc = new RTCPeerConnection({ iceServers: this.iceServers });
    const entry = { pc, audio: null, pendingIce: [], initiator, meter: null, sender: null };
    this.pcs.set(id, entry);
    if (initiator) {
      // one audio transceiver per connection; toggling the mic only swaps its track (no renegotiation)
      const tr = pc.addTransceiver('audio', { direction: 'sendrecv' });
      entry.sender = tr.sender;
      const track = this.stream?.getAudioTracks()[0];
      if (track) tr.sender.replaceTrack(track);
    }
    pc.onicecandidate = (e) => {
      if (e.candidate) this.signal(id, { type: 'ice', candidate: e.candidate.toJSON() });
    };
    pc.ontrack = (e) => this.attachRemote(id, e.streams[0] || new MediaStream([e.track]));
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed' && entry.initiator) {
        pc.restartIce?.();
        this.makeOffer(id, true);
      }
      this.onChange();
    };
    if (initiator) this.makeOffer(id);
    return entry;
  }

  async makeOffer(id, iceRestart = false) {
    const entry = this.pcs.get(id);
    if (!entry) return;
    try {
      const offer = await entry.pc.createOffer({ iceRestart });
      await entry.pc.setLocalDescription(offer);
      this.signal(id, { type: 'offer', sdp: entry.pc.localDescription.sdp });
    } catch (err) {
      console.warn('[voice] offer failed', err);
    }
  }

  async onSignal({ from, data }) {
    if (!from || !data || from === this.self) return;
    let entry = this.pcs.get(from);
    try {
      if (data.type === 'offer') {
        if (!entry) entry = this.createPeer(from, false);
        await entry.pc.setRemoteDescription({ type: 'offer', sdp: data.sdp });
        const tr = entry.pc.getTransceivers()[0];
        if (tr) {
          tr.direction = 'sendrecv';
          entry.sender = tr.sender;
          const track = this.stream?.getAudioTracks()[0];
          await tr.sender.replaceTrack(track || null);
        }
        await entry.pc.setLocalDescription(await entry.pc.createAnswer());
        this.signal(from, { type: 'answer', sdp: entry.pc.localDescription.sdp });
        await this.flushIce(entry);
      } else if (data.type === 'answer' && entry) {
        await entry.pc.setRemoteDescription({ type: 'answer', sdp: data.sdp });
        await this.flushIce(entry);
      } else if (data.type === 'ice' && entry) {
        if (entry.pc.remoteDescription) await entry.pc.addIceCandidate(data.candidate);
        else entry.pendingIce.push(data.candidate);
      }
    } catch (err) {
      console.warn('[voice] signalling error', err);
    }
  }

  async flushIce(entry) {
    const list = entry.pendingIce.splice(0);
    for (const c of list) {
      try {
        await entry.pc.addIceCandidate(c);
      } catch {
        /* stale candidate */
      }
    }
  }

  signal(to, data) {
    this.socket.emit('voice:signal', { to, data });
  }

  closePeer(id) {
    const entry = this.pcs.get(id);
    if (!entry) return;
    this.pcs.delete(id);
    entry.pc.onicecandidate = entry.pc.ontrack = entry.pc.onconnectionstatechange = null;
    try {
      entry.pc.close();
    } catch {
      /* already closed */
    }
    this.disposeMeter(entry.meter);
    if (entry.audio) {
      entry.audio.srcObject = null;
      entry.audio.remove();
    }
    this.speaking.delete(id);
  }

  attachRemote(id, stream) {
    const entry = this.pcs.get(id);
    if (!entry) return;
    if (!this._audioRoot) {
      this._audioRoot = document.createElement('div');
      this._audioRoot.hidden = true;
      document.body.appendChild(this._audioRoot);
    }
    if (!entry.audio) {
      entry.audio = document.createElement('audio');
      entry.audio.autoplay = true;
      entry.audio.setAttribute('playsinline', '');
      this._audioRoot.appendChild(entry.audio);
    }
    entry.audio.muted = this.deaf;
    entry.audio.srcObject = stream;
    entry.audio.play?.().catch(() => {
      this.needsUnlock = true;
      this.onChange();
    });
    this.disposeMeter(entry.meter);
    entry.meter = this.createMeter(stream);
  }

  /** After a user gesture: retry playback blocked by the autoplay policy. */
  unlockPlayback() {
    this.needsUnlock = false;
    audioCtx();
    for (const e of this.pcs.values()) e.audio?.play?.().catch(() => {});
    this.onChange();
  }

  // ------------------------------------------------------------------ switches
  /** @returns {Promise<{ok: boolean, error?: string}>} */
  async setMic(on) {
    if (on === this.mic) return { ok: true };
    if (on) {
      if (!navigator.mediaDevices?.getUserMedia) {
        return { ok: false, error: 'Микрофон недоступен: браузер не поддерживает запись звука или страница открыта не по HTTPS.' };
      }
      try {
        this.stream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
          video: false,
        });
      } catch (err) {
        this.stream = null;
        const denied = err?.name === 'NotAllowedError' || err?.name === 'SecurityError' || err?.name === 'PermissionDeniedError';
        return { ok: false, error: denied ? MIC_DENIED : 'Не удалось включить микрофон: устройство не найдено или занято.' };
      }
      const track = this.stream.getAudioTracks()[0];
      for (const e of this.pcs.values()) await e.sender?.replaceTrack(track).catch(() => {});
      this.localMeter = this.createMeter(this.stream);
      this.mic = true;
    } else {
      this.mic = false;
      for (const e of this.pcs.values()) await e.sender?.replaceTrack(null).catch(() => {});
      this.stopMic();
    }
    if (this.joined) await this.request('voice:mic', { on: this.mic });
    this.onChange();
    return { ok: true };
  }

  stopMic() {
    this.disposeMeter(this.localMeter);
    this.localMeter = null;
    this.stream?.getTracks().forEach((t) => t.stop()); // releases the device (mic indicator turns off)
    this.stream = null;
    this.speaking.delete(this.self);
  }

  setDeaf(deaf) {
    this.deaf = !!deaf;
    for (const e of this.pcs.values()) if (e.audio) e.audio.muted = this.deaf;
    this.onChange();
  }

  // ------------------------------------------------------------------ speaking indicators
  createMeter(stream) {
    const ac = audioCtx();
    if (!ac) return null;
    try {
      const src = ac.createMediaStreamSource(stream);
      const an = ac.createAnalyser();
      an.fftSize = 512;
      src.connect(an); // not connected to the destination: analysis only, no double playback
      return { src, an, buf: new Uint8Array(an.fftSize), last: 0 };
    } catch {
      return null;
    }
  }

  disposeMeter(m) {
    if (!m) return;
    try {
      m.src.disconnect();
    } catch {
      /* ignore */
    }
  }

  level(m) {
    if (!m) return 0;
    m.an.getByteTimeDomainData(m.buf);
    let sum = 0;
    for (let i = 0; i < m.buf.length; i++) {
      const v = (m.buf[i] - 128) / 128;
      sum += v * v;
    }
    return Math.sqrt(sum / m.buf.length);
  }

  startMeters() {
    if (this._meterTimer) return;
    // one timer for all meters, only while in the voice chat
    this._meterTimer = setInterval(() => {
      const now = performance.now();
      let changed = false;
      const check = (id, m, active) => {
        if (m && active && this.level(m) > SPEAK_THRESHOLD) m.last = now;
        const talking = !!m && active && now - m.last < SPEAK_HOLD_MS;
        if (talking !== this.speaking.has(id)) {
          if (talking) this.speaking.add(id);
          else this.speaking.delete(id);
          changed = true;
        }
      };
      check(this.self, this.localMeter, this.mic);
      for (const [id, e] of this.pcs) check(id, e.meter, this.peers.find((p) => p.id === id)?.mic);
      if (changed) this.onChange();
    }, SPEAK_POLL_MS);
  }

  stopMeters() {
    clearInterval(this._meterTimer);
    this._meterTimer = null;
  }
}
