// One shared AudioContext (created lazily on a user gesture, as required by autoplay policies).
// Used for the synthesized conquest fanfare and by the voice chat's speaking detection.

let ctx = null;

export function audioCtx() {
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
  }
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  return ctx;
}

/** Call from a click/tap handler so that later sounds are allowed to play. */
export function unlockAudio() {
  audioCtx();
}

/** Short "victory" fanfare, synthesized (no audio file to download). */
export function playConquestSound() {
  const ac = audioCtx();
  if (!ac || ac.state !== 'running') return;
  const t0 = ac.currentTime + 0.02;
  const master = ac.createGain();
  master.gain.setValueAtTime(0.0001, t0);
  master.gain.exponentialRampToValueAtTime(0.22, t0 + 0.03);
  master.gain.exponentialRampToValueAtTime(0.0001, t0 + 1.5);
  master.connect(ac.destination);
  // G4 C5 E5 G5 - rising brass-like arpeggio, the last note held
  const notes = [392, 523.25, 659.25, 783.99];
  notes.forEach((f, i) => {
    const osc = ac.createOscillator();
    const g = ac.createGain();
    osc.type = 'sawtooth';
    osc.frequency.value = f;
    const s = t0 + i * 0.12;
    const e = i === notes.length - 1 ? t0 + 1.45 : s + 0.16;
    g.gain.setValueAtTime(0.0001, s);
    g.gain.exponentialRampToValueAtTime(0.5, s + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, e);
    osc.connect(g).connect(master);
    osc.start(s);
    osc.stop(e + 0.05);
  });
  // low drum hit
  const drum = ac.createOscillator();
  const dg = ac.createGain();
  drum.type = 'sine';
  drum.frequency.setValueAtTime(140, t0);
  drum.frequency.exponentialRampToValueAtTime(45, t0 + 0.35);
  dg.gain.setValueAtTime(0.9, t0);
  dg.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.4);
  drum.connect(dg).connect(master);
  drum.start(t0);
  drum.stop(t0 + 0.45);
}
