// Web Audio API subtle two-tone transit arrival chime (zero external audio files needed)
let audioCtx = null;

function ensureContext() {
  if (!audioCtx && typeof window !== 'undefined') {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (Ctx) audioCtx = new Ctx();
  }
  if (audioCtx && audioCtx.state === 'suspended') {
    audioCtx.resume().catch(() => {});
  }
  return audioCtx;
}

export function playArrivalChime() {
  const ctx = ensureContext();
  if (!ctx) return;

  const now = ctx.currentTime;
  const notes = [587.33, 880.0]; // D5 -> A5 gentle civic chime

  notes.forEach((freq, i) => {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(freq, now + i * 0.14);

    gain.gain.setValueAtTime(0.001, now + i * 0.14);
    gain.gain.exponentialRampToValueAtTime(0.14, now + i * 0.14 + 0.03);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + i * 0.14 + 0.42);

    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(now + i * 0.14);
    osc.stop(now + i * 0.14 + 0.45);
  });
}

export function playSubtleTick() {
  const ctx = ensureContext();
  if (!ctx) return;
  const now = ctx.currentTime;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = 'triangle';
  osc.frequency.setValueAtTime(660, now);
  gain.gain.setValueAtTime(0.001, now);
  gain.gain.exponentialRampToValueAtTime(0.05, now + 0.015);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.12);
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.start(now);
  osc.stop(now + 0.13);
}
