// Generative ambient soundtrack (WebAudio, nothing downloaded): 96 BPM, Am–F–C–G, two-bar phrases.

export const BEAT = 60 / 96;
const STEP = BEAT / 2;
export const PHR = BEAT * 8; // one phrase = 2 bars = 5 s
const CHORDS = [
  [57, 60, 64, 69],
  [53, 57, 60, 65],
  [48, 55, 60, 64],
  [55, 59, 62, 67],
];
const ARP = [0, 2, 1, 3, 2, 1, 3, 2];
const mtof = (m: number) => 440 * Math.pow(2, (m - 69) / 12);

export const M = {
  ctx: null as AudioContext | null,
  on: false,
  t0: 0,
  next: 0,
  step: 0,
  timer: 0 as ReturnType<typeof setInterval> | 0,
  out: null as GainNode | null,
  dly: null as DelayNode | null,
  noise: null as AudioBuffer | null,
};

function init() {
  const c = new AudioContext();
  M.ctx = c;
  M.out = c.createGain();
  M.out.gain.value = 0;
  const comp = c.createDynamicsCompressor();
  M.out.connect(comp);
  comp.connect(c.destination);
  M.dly = c.createDelay(1);
  M.dly.delayTime.value = BEAT * 0.75;
  const fb = c.createGain(),
    wet = c.createGain();
  fb.gain.value = 0.4;
  wet.gain.value = 0.3;
  M.dly.connect(fb);
  fb.connect(M.dly);
  M.dly.connect(wet);
  wet.connect(M.out);
  const len = (c.sampleRate * 0.4) | 0,
    buf = c.createBuffer(1, len, c.sampleRate),
    d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  M.noise = buf;
}

function blip(type: OscillatorType, f: number, t: number, a: number, peak: number, rel: number, dest: AudioNode) {
  const c = M.ctx!,
    o = c.createOscillator(),
    g = c.createGain();
  o.type = type;
  o.frequency.value = f;
  g.gain.setValueAtTime(0.0001, t);
  g.gain.linearRampToValueAtTime(peak, t + a);
  g.gain.exponentialRampToValueAtTime(0.0001, t + a + rel);
  o.connect(g);
  g.connect(dest);
  o.start(t);
  o.stop(t + a + rel + 0.05);
  return { o, g };
}

function sched() {
  const c = M.ctx!;
  while (M.next < c.currentTime + 0.3) {
    const s = M.step,
      t = M.next,
      ch = CHORDS[Math.floor(s / 16) % 4];
    if (s % 16 === 0) {
      const f = c.createBiquadFilter();
      f.type = "lowpass";
      f.Q.value = 0.8;
      f.frequency.setValueAtTime(400, t);
      f.frequency.linearRampToValueAtTime(1600, t + PHR * 0.45);
      f.frequency.linearRampToValueAtTime(500, t + PHR);
      f.connect(M.out!);
      ch.forEach((m) =>
        [-8, 8].forEach((dt) => {
          const o = c.createOscillator(),
            g = c.createGain();
          o.type = "sawtooth";
          o.frequency.value = mtof(m - 12);
          o.detune.value = dt;
          g.gain.setValueAtTime(0, t);
          g.gain.linearRampToValueAtTime(0.032, t + 1.4);
          g.gain.setValueAtTime(0.032, t + PHR - 0.4);
          g.gain.linearRampToValueAtTime(0, t + PHR + 1.4);
          o.connect(g);
          g.connect(f);
          o.start(t);
          o.stop(t + PHR + 1.5);
        }),
      );
      blip("sine", mtof(ch[0] - 24), t, 0.04, 0.34, PHR - 0.3, M.out!);
    }
    if (s % 4 === 0) {
      const { o } = blip("sine", 130, t, 0.004, 0.6, 0.3, M.out!);
      o.frequency.setValueAtTime(130, t);
      o.frequency.exponentialRampToValueAtTime(42, t + 0.14);
    }
    if (s % 2 === 1) {
      const b = c.createBufferSource(),
        hp = c.createBiquadFilter(),
        g = c.createGain();
      b.buffer = M.noise;
      hp.type = "highpass";
      hp.frequency.value = 7500;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.linearRampToValueAtTime(s % 4 === 3 ? 0.07 : 0.04, t + 0.002);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.06);
      b.connect(hp);
      hp.connect(g);
      g.connect(M.out!);
      b.start(t);
      b.stop(t + 0.1);
    }
    if (s % 16 > 1) {
      const { g } = blip("triangle", mtof(ch[ARP[s % 8]] + 12), t, 0.006, 0.075, 0.32, M.out!);
      g.connect(M.dly!);
    }
    M.next += STEP;
    M.step++;
  }
}

export function musicStart(): boolean {
  try {
    if (!M.ctx) init();
  } catch {
    return false;
  }
  const c = M.ctx!;
  c.resume();
  M.on = true;
  M.out!.gain.cancelScheduledValues(c.currentTime);
  M.out!.gain.setValueAtTime(M.out!.gain.value, c.currentTime);
  M.out!.gain.linearRampToValueAtTime(0.75, c.currentTime + 0.8);
  M.t0 = M.next = c.currentTime + 0.05;
  M.step = 0;
  if (M.timer) clearInterval(M.timer);
  M.timer = setInterval(sched, 50);
  sched();
  return true;
}

export function musicStop() {
  if (!M.on || !M.ctx) return;
  M.on = false;
  const c = M.ctx;
  if (M.timer) clearInterval(M.timer);
  M.out!.gain.cancelScheduledValues(c.currentTime);
  M.out!.gain.setValueAtTime(M.out!.gain.value, c.currentTime);
  M.out!.gain.linearRampToValueAtTime(0, c.currentTime + 0.4);
  setTimeout(() => {
    if (!M.on) c.suspend();
  }, 600);
}

/** 0..1 pulse that peaks on every beat. */
export function beatPulse() {
  if (!M.on || !M.ctx) return 0;
  return Math.pow(1 - ((Math.max(0, M.ctx.currentTime - M.t0) / BEAT) % 1), 2.5);
}
