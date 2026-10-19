// Canvas visuals: the orb (live spectrum ring, chunk ring, particles) and a
// scrolling spectrogram strip that shows the actual tones on the air.

const TAU = Math.PI * 2;
const ACCENT = [62, 240, 255];
const VIOLET = [139, 92, 255];
const PINK = [255, 79, 216];
const GREEN = [61, 255, 162];

const rgba = (c, a) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;
const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));
function hue(t) {
  // cyan -> violet -> pink -> cyan around the ring
  t = ((t % 1) + 1) % 1;
  return t < 1 / 3 ? mix(ACCENT, VIOLET, t * 3) : t < 2 / 3 ? mix(VIOLET, PINK, t * 3 - 1) : mix(PINK, ACCENT, t * 3 - 2);
}

function fit(canvas) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  return { w, h, dpr };
}

export class Orb {
  constructor(canvas) {
    this.c = canvas;
    this.g = canvas.getContext('2d');
    this.analyser = null;
    this.mode = 'idle'; // idle | off | tx | rx
    this.total = 0;
    this.states = null; // per chunk: 0 waiting, 1 on air, 2 sent, 3 confirmed
    this.progress = 0;
    this.shown = 0;
    this.particles = [];
    this.flash = 0;
    this.success = 0;
    this.heat = 0;
    this.t = 0;
    this.loop = this.loop.bind(this);
    requestAnimationFrame(this.loop);
  }

  set(mode, total = 0, fresh = false) {
    if (fresh || mode !== this.mode || total !== this.total) {
      this.mode = mode;
      this.total = total;
      this.states = total ? new Uint8Array(total) : null;
      this.progress = this.shown = 0;
      this.success = 0;
    }
  }

  // A frame went out (tx) or came in (rx): throw some sparks.
  spark(n = 26) {
    const out = this.mode !== 'rx';
    for (let i = 0; i < n; i++) {
      const a = Math.random() * TAU;
      this.particles.push({ a, r: out ? 0.92 : 1.75, v: (out ? 1 : -1) * (0.006 + Math.random() * 0.012), life: 1, col: hue(a / TAU + this.t * 0.02), size: 1 + Math.random() * 2 });
    }
    this.heat = 1;
  }

  done(ok = true) {
    this.flash = 1;
    this.success = ok ? 1 : -1;
    this.progress = ok ? 1 : this.progress;
  }

  loop(ts) {
    requestAnimationFrame(this.loop);
    if (this.c.offsetParent === null) return;
    this.t = ts / 1000;
    this.draw();
  }

  spectrum(bars) {
    const out = new Float32Array(bars);
    const a = this.analyser;
    if (!a) return out;
    const data = (this.freq ||= new Uint8Array(a.frequencyBinCount));
    a.getByteFrequencyData(data);
    const binHz = a.context.sampleRate / a.fftSize;
    const lo = 900 / binHz;
    const hi = 8000 / binHz;
    for (let i = 0; i < bars; i++) {
      const s = Math.floor(lo + ((hi - lo) * i) / bars);
      const e = Math.max(s + 1, Math.floor(lo + ((hi - lo) * (i + 1)) / bars));
      let m = 0;
      for (let k = s; k < e; k++) m = Math.max(m, data[k]);
      out[i] = Math.max(0, (m - 60) / 195);
    }
    return out;
  }

  draw() {
    const { w, h, dpr } = fit(this.c);
    const g = this.g;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    const S = Math.min(w, h);
    const cx = w / 2;
    const cy = h / 2;
    const R = S * 0.3;
    const off = this.mode === 'off';
    this.shown += (this.progress - this.shown) * 0.08;
    this.heat *= 0.96;
    this.flash *= 0.94;

    // glow core
    const core = g.createRadialGradient(cx, cy, 0, cx, cy, R * 1.25);
    const busy = this.mode === 'tx' || this.mode === 'rx';
    const glowCol = this.success > 0 ? GREEN : this.success < 0 ? PINK : ACCENT;
    core.addColorStop(0, rgba(glowCol, off ? 0.02 : 0.1 + 0.18 * this.heat + 0.3 * this.flash));
    core.addColorStop(1, rgba(glowCol, 0));
    g.fillStyle = core;
    g.fillRect(0, 0, w, h);

    // live spectrum, mirrored left/right
    const half = 64;
    const spec = this.spectrum(half);
    const spin = this.t * (busy ? 0.25 : 0.06);
    g.lineCap = 'round';
    g.lineWidth = Math.max(2, S * 0.008);
    for (let side = 0; side < 2; side++) {
      for (let i = 0; i < half; i++) {
        const frac = (i + 0.5) / half / 2;
        const a = -Math.PI / 2 + (side ? -1 : 1) * frac * TAU + spin;
        const v = spec[i];
        const len = S * (0.012 + 0.15 * v ** 1.4);
        const r0 = R + S * 0.03;
        const col = off ? [90, 96, 110] : hue(frac + this.t * 0.03);
        g.strokeStyle = rgba(col, off ? 0.35 : 0.35 + 0.65 * Math.min(1, v * 1.5));
        g.beginPath();
        g.moveTo(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0);
        g.lineTo(cx + Math.cos(a) * (r0 + len), cy + Math.sin(a) * (r0 + len));
        g.stroke();
      }
    }

    // base ring
    g.lineWidth = Math.max(1, S * 0.004);
    g.strokeStyle = `rgba(255,255,255,${off ? 0.06 : 0.1})`;
    g.beginPath();
    g.arc(cx, cy, R, 0, TAU);
    g.stroke();

    // chunk ring
    if (this.total) {
      const ringW = Math.max(5, S * 0.03);
      const r = R - ringW * 1.2;
      const n = this.total;
      const gap = n > 1 ? Math.min(0.04, (TAU / n) * 0.25) : 0;
      const seg = TAU / n;
      g.lineWidth = ringW;
      g.lineCap = n > 40 ? 'butt' : 'round';
      const pulse = 0.55 + 0.45 * Math.sin(this.t * 10);
      for (let i = 0; i < n; i++) {
        const st = this.states[i];
        const a0 = -Math.PI / 2 + i * seg + gap / 2;
        const a1 = a0 + seg - gap;
        let col;
        if (this.success > 0) col = rgba(mix(GREEN, ACCENT, i / n), 0.95);
        else if (st === 3) col = rgba(hue(i / n * 0.66), 0.95);
        else if (st === 2) col = rgba(ACCENT, 0.35);
        else if (st === 1) col = `rgba(255,255,255,${pulse})`;
        else col = 'rgba(255,255,255,0.08)';
        g.strokeStyle = col;
        g.beginPath();
        g.arc(cx, cy, r, a0, Math.max(a0 + 0.001, a1));
        g.stroke();
      }
      // smooth progress hairline inside
      g.lineWidth = Math.max(1.5, S * 0.006);
      g.lineCap = 'round';
      g.strokeStyle = rgba(this.success > 0 ? GREEN : PINK, 0.9);
      g.beginPath();
      g.arc(cx, cy, r - ringW, -Math.PI / 2, -Math.PI / 2 + TAU * Math.min(1, this.shown));
      g.stroke();
    }

    // sparks
    g.globalCompositeOperation = 'lighter';
    this.particles = this.particles.filter((p) => (p.life -= 0.012) > 0 && p.r > 0.85 && p.r < 1.9);
    for (const p of this.particles) {
      p.r += p.v;
      p.a += 0.004;
      const x = cx + Math.cos(p.a) * R * p.r;
      const y = cy + Math.sin(p.a) * R * p.r;
      g.fillStyle = rgba(p.col, p.life);
      g.beginPath();
      g.arc(x, y, p.size * (S / 400), 0, TAU);
      g.fill();
    }
    g.globalCompositeOperation = 'source-over';

    // success / failure ripple
    if (this.flash > 0.02) {
      g.strokeStyle = rgba(this.success < 0 ? PINK : GREEN, this.flash);
      g.lineWidth = 3;
      g.beginPath();
      g.arc(cx, cy, R * (1 + (1 - this.flash) * 0.9), 0, TAU);
      g.stroke();
    }
  }
}

/** Scrolling spectrogram, 900 Hz at the bottom to 8 kHz at the top. */
export class Waterfall {
  constructor(canvas) {
    this.c = canvas;
    this.g = canvas.getContext('2d');
    this.analyser = null;
    this.lut = [];
    for (let i = 0; i < 256; i++) {
      const t = i / 255;
      const c = t < 0.5 ? mix([7, 8, 13], VIOLET, t * 2) : mix(VIOLET, t < 0.8 ? ACCENT : [255, 255, 255], (t - 0.5) * 2);
      this.lut.push(`rgb(${c[0]},${c[1]},${c[2]})`);
    }
    this.loop = this.loop.bind(this);
    requestAnimationFrame(this.loop);
  }

  loop() {
    requestAnimationFrame(this.loop);
    const a = this.analyser;
    if (!a || this.c.offsetParent === null) return;
    const { dpr } = fit(this.c);
    const W = this.c.width;
    const H = this.c.height;
    const g = this.g;
    const step = Math.max(1, Math.round(2 * dpr));
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.globalCompositeOperation = 'copy';
    g.drawImage(this.c, -step, 0);
    g.globalCompositeOperation = 'source-over';
    const data = (this.freq ||= new Uint8Array(a.frequencyBinCount));
    a.getByteFrequencyData(data);
    const binHz = a.context.sampleRate / a.fftSize;
    const rows = Math.min(H, 160);
    const rh = H / rows;
    for (let y = 0; y < rows; y++) {
      const f = 900 + ((8000 - 900) * (rows - 1 - y)) / (rows - 1);
      const v = data[Math.round(f / binHz)];
      g.fillStyle = this.lut[Math.max(0, Math.min(255, Math.round((v - 70) * 1.4)))];
      g.fillRect(W - step, y * rh, step, Math.ceil(rh));
    }
  }
}
