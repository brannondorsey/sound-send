// Acoustic modem: chirp-synchronised, multi-group FSK.
//
// A frame is a linear chirp (for timing), a header symbol (frame length) and a
// run of data symbols. Each data symbol plays one tone in each of G groups of
// M adjacent tones, so it carries G * log2(M) bits. Tones sit on exact
// multiples of 1/Twin, and every symbol is a guard interval longer than the
// analysis window, so any window inside the symbol (after the echo of the
// previous one has settled) sees them as orthogonal. The payload is protected
// by a CRC-16 and a Reed-Solomon code; byte confidences from the detector feed
// erasure decoding when plain error correction is not enough.
//
// "fast" sweeps up, "slow" sweeps down, so a receiver hears both at once and
// replies in whichever the sender used.

import { rsEncode, rsDecode } from './rs.js';
import { crc16 } from './crc.js';
import { fft, nextPow2 } from './fft.js';

export const PROFILES = {
  fast: {
    id: 'fast',
    df: 50, // tone spacing (Hz); analysis window = 1/df
    guard: 1 / 150, // seconds of guard before each window
    groups: 16,
    bits: 3, // 8 tones per group
    baseBin: 24, // 1200 Hz .. 7550 Hz
    chirp: [1200, 7600, 0.1],
    // [data bytes incl. CRC-16, parity bytes]; codeword sizes fill whole symbols
    classes: [[24, 12], [60, 18], [110, 28], [160, 38], [204, 48]],
    burst: 8,
  },
  slow: {
    id: 'slow',
    df: 25,
    guard: 0.02,
    groups: 8,
    bits: 4, // 16 tones per group
    baseBin: 48, // 1200 Hz .. 4375 Hz
    chirp: [4400, 1200, 0.15],
    classes: [[24, 16], [60, 32], [100, 48]],
    burst: 3,
  },
};

const PAD = 0.01; // silence between chirp and header (s)
const LEAD = 0.01; // silence before the chirp in a rendered frame (s)

// Codewords are XORed with a fixed pseudo-random sequence so that runs of
// identical bytes (padding, mostly) still hop between tones.
const WHITEN = new Uint8Array(255);
for (let i = 0, x = 0x9e3779b9; i < 255; i++) {
  x ^= x << 13;
  x ^= x >>> 17;
  x ^= x << 5;
  WHITEN[i] = x & 0xff;
}

const gray = (v) => v ^ (v >> 1);
function grayInv(g) {
  let v = 0;
  for (; g; g >>= 1) v ^= g;
  return v;
}

const derived = new Map();

/** Sample-rate specific constants for a profile. */
export function derive(id, sr) {
  const key = `${id}@${sr}`;
  let d = derived.get(key);
  if (d) return d;
  const p = PROFILES[id];
  const M = 1 << p.bits;
  const nBins = p.groups * M;
  const Twin = 1 / p.df;
  const Tsym = Twin + p.guard;
  const freqs = Float64Array.from({ length: nBins }, (_, i) => (p.baseBin + i) * p.df);
  const [f0, f1, Tc] = p.chirp;
  const nChirp = Math.round(Tc * sr);
  const chirp = new Float32Array(nChirp);
  const taper = Math.round(0.005 * sr);
  for (let i = 0; i < nChirp; i++) {
    const t = i / sr;
    const ph = 2 * Math.PI * (f0 * t + ((f1 - f0) * t * t) / (2 * Tc));
    const w = Math.min(1, i / taper, (nChirp - 1 - i) / taper);
    chirp[i] = Math.sin(ph) * (0.5 - 0.5 * Math.cos(Math.PI * Math.max(0, w)));
  }
  const bitsPerSym = p.groups * p.bits;
  d = {
    ...p,
    sr,
    M,
    nBins,
    Twin,
    Tsym,
    freqs,
    nWin: Math.round(Twin * sr),
    winOff: Math.round(0.75 * p.guard * sr),
    nChirp,
    chirp,
    bitsPerSym,
    coef: freqs.map((f) => 2 * Math.cos((2 * Math.PI * f) / sr)),
    phase: Float64Array.from({ length: nBins }, (_, i) => (Math.PI * i * i) / nBins),
    classes: p.classes.map(([k, nsym]) => ({ k, nsym, n: k + nsym, syms: Math.ceil(((k + nsym) * 8) / bitsPerSym) })),
    // sample offset (from chirp start) of symbol j; symbol 0 is the header
    symStart: (j) => Math.round((Tc + PAD + j * Tsym) * sr),
  };
  d.maxPayload = d.classes[d.classes.length - 1].k - 2;
  derived.set(key, d);
  return d;
}

/** Largest payload a single frame can carry. */
export const maxPayload = (id) => PROFILES[id].classes.at(-1)[0] - 2;

function classFor(d, len) {
  const c = d.classes.findIndex((c) => c.k - 2 >= len);
  if (c < 0) throw new RangeError(`payload of ${len} bytes is too big for one ${d.id} frame`);
  return c;
}

/** Seconds of air a payload of `len` bytes takes (excluding lead silence). */
export function airtime(id, len) {
  const p = PROFILES[id];
  const c = p.classes.findIndex(([k]) => k - 2 >= len);
  const [k, nsym] = p.classes[c < 0 ? p.classes.length - 1 : c];
  const syms = Math.ceil(((k + nsym) * 8) / (p.groups * p.bits));
  return p.chirp[2] + PAD + (1 + syms) * (1 / p.df + p.guard);
}

/** Render one frame carrying `payload` as audio samples at `sr`. */
export function modulate(id, payload, sr) {
  const d = derive(id, sr);
  const ci = classFor(d, payload.length);
  const { k, nsym, n, syms } = d.classes[ci];
  const data = new Uint8Array(k);
  data.set(payload);
  const c = crc16(data, 0, k - 2);
  data[k - 2] = c >> 8;
  data[k - 1] = c & 0xff;
  const cw = rsEncode(data, nsym);
  for (let i = 0; i < n; i++) cw[i] ^= WHITEN[i];

  // tone index per (symbol, group); symbol 0 repeats the class in every group
  const G = d.groups;
  const tones = new Uint8Array((1 + syms) * G);
  for (let g = 0; g < G; g++) tones[g] = gray(ci);
  let bit = 0;
  for (let s = 1; s <= syms; s++) {
    for (let g = 0; g < G; g++) {
      let v = 0;
      for (let b = 0; b < d.bits; b++, bit++) {
        const on = bit < n * 8 ? (cw[bit >> 3] >> (7 - (bit & 7))) & 1 : 0;
        v = (v << 1) | on;
      }
      tones[s * G + g] = gray(v);
    }
  }

  const lead = Math.round(LEAD * sr);
  const end = d.symStart(1 + syms);
  const out = new Float32Array(lead + end + Math.round(0.005 * sr));
  for (let i = 0; i < d.nChirp; i++) out[lead + i] = 0.7 * d.chirp[i];
  const ramp = Math.max(1, Math.round(0.001 * sr));
  let peak = 0;
  for (let s = 0; s <= syms; s++) {
    const a = d.symStart(s);
    const b = d.symStart(s + 1);
    const len = b - a;
    for (let g = 0; g < G; g++) {
      const bin = g * d.M + tones[s * G + g];
      const w = (2 * Math.PI * d.freqs[bin]) / sr;
      const ph = d.phase[bin];
      for (let i = 0; i < len; i++) out[lead + a + i] += Math.cos(w * i + ph);
    }
    for (let i = 0; i < len; i++) {
      const e = Math.min(1, i / ramp, (len - 1 - i) / ramp);
      const v = (out[lead + a + i] *= e < 1 ? 0.5 - 0.5 * Math.cos(Math.PI * e) : 1);
      if (Math.abs(v) > peak) peak = Math.abs(v);
    }
  }
  const scale = 0.9 / (peak || 1);
  for (let i = lead + d.symStart(0); i < lead + end; i++) out[i] *= scale;
  return out;
}

/**
 * Streaming demodulator. Feed it microphone samples with push(); it calls
 * onDetect(info) when a frame header is heard, onProgress(info) per symbol,
 * onFrame(payload, info) for each frame that decodes and passes its CRC, and
 * onFail(info) for frames that were heard but could not be repaired.
 */
export class Demodulator {
  constructor(sr, { profiles = Object.keys(PROFILES), threshold = 0.3 } = {}) {
    this.sr = sr;
    this.threshold = threshold;
    this.profiles = profiles.map((id) => derive(id, sr));
    this.R = 1 << 19;
    this.ring = new Float32Array(this.R);
    this.n = 0;

    // high-pass at 700 Hz keeps rumble and voices' low end out of the sync
    const w0 = (2 * Math.PI * 700) / sr;
    const al = Math.sin(w0) / (2 * Math.SQRT1_2);
    const cw = Math.cos(w0);
    const a0 = 1 + al;
    this.hp = { b0: (1 + cw) / 2 / a0, b1: -(1 + cw) / a0, b2: (1 + cw) / 2 / a0, a1: (-2 * cw) / a0, a2: (1 - al) / a0 };
    this.hs = [0, 0, 0, 0];

    const Lmax = Math.max(...this.profiles.map((d) => d.nChirp));
    this.N = nextPow2(Math.ceil(Lmax * 1.6));
    this.H = this.N - Lmax + 1;
    this.corrPos = 0;
    this.re = new Float64Array(this.N);
    this.im = new Float64Array(this.N);
    this.yr = new Float64Array(this.N);
    this.yi = new Float64Array(this.N);
    this.cum = new Float64Array(this.N + 1);
    this.ps = this.profiles.map((d) => {
      const re = new Float64Array(this.N);
      const im = new Float64Array(this.N);
      let energy = 0;
      for (let i = 0; i < d.nChirp; i++) {
        re[i] = d.chirp[i];
        energy += d.chirp[i] * d.chirp[i];
      }
      fft(re, im);
      return { d, re, im, energy, cand: null, maxAdj: Math.round((d.id === 'slow' ? 0.004 : 0.002) * sr), adjStep: Math.max(1, Math.round(0.00025 * sr)) };
    });
    this.scratch = new Float32Array(Math.max(...this.profiles.map((d) => d.nWin)));
    this.frames = [];
    this.deaf = [];
    this.level = 0;
    this.stats = { detections: 0, frames: 0, failures: 0, ignored: 0 };
    this.onDetect = this.onProgress = this.onFrame = this.onFail = null;
  }

  /** Ignore frames whose chirp starts in [from, to) (absolute sample index). */
  addDeaf(from, to) {
    this.deaf = this.deaf.filter((w) => w[1] > this.n - this.R);
    this.deaf.push([from, to]);
  }

  /** True while a frame is being received (or a sync is being confirmed). */
  busy() {
    return this.frames.length > 0 || this.ps.some((p) => p.cand);
  }

  push(input) {
    const { ring, hp, hs } = this;
    const mask = this.R - 1;
    let sum = 0;
    for (let i = 0; i < input.length; i++) {
      const x = input[i];
      const y = hp.b0 * x + hp.b1 * hs[0] + hp.b2 * hs[1] - hp.a1 * hs[2] - hp.a2 * hs[3];
      hs[1] = hs[0];
      hs[0] = x;
      hs[3] = hs[2];
      hs[2] = y;
      ring[this.n & mask] = y;
      this.n++;
      sum += y * y;
    }
    if (input.length) this.level = Math.sqrt(sum / input.length);
    while (this.n >= this.corrPos + this.N) this.correlate();
    this.service();
  }

  correlate() {
    const { N, H, re, im, yr, yi, cum, ring } = this;
    const mask = this.R - 1;
    const base = this.corrPos;
    cum[0] = 0;
    for (let i = 0; i < N; i++) {
      const x = ring[(base + i) & mask];
      re[i] = x;
      im[i] = 0;
      cum[i + 1] = cum[i] + x * x;
    }
    fft(re, im);
    for (const p of this.ps) {
      // cross-correlate with the chirp; keeping only positive frequencies
      // gives the analytic signal, whose magnitude is the correlation envelope
      for (let k = 0; k < N; k++) {
        if (k > N / 2) {
          yr[k] = yi[k] = 0;
          continue;
        }
        const s = k === 0 || k === N / 2 ? 1 : 2;
        yr[k] = s * (re[k] * p.re[k] + im[k] * p.im[k]);
        yi[k] = s * (im[k] * p.re[k] - re[k] * p.im[k]);
      }
      fft(yr, yi, true);
      const L = p.d.nChirp;
      const floor = L * 1e-10;
      const deaf = this.deaf.filter(([a, b]) => b > base && a < base + H);
      for (let m = 0; m < H; m++) {
        const pos = base + m;
        if (p.cand && pos - p.cand.pos > L) {
          this.detected(p, p.cand);
          p.cand = null;
        }
        const e = cum[m + L] - cum[m];
        if (e < floor || (deaf.length && deaf.some(([a, b]) => pos >= a && pos < b))) continue;
        const v = Math.hypot(yr[m], yi[m]) / N / Math.sqrt(e * p.energy);
        if (v >= this.threshold && (!p.cand || v > p.cand.val)) p.cand = { pos, val: v };
      }
    }
    this.corrPos += H;
  }

  detected(p, cand) {
    if (this.deaf.some(([a, b]) => cand.pos >= a && cand.pos < b)) {
      this.stats.ignored++;
      return;
    }
    this.stats.detections++;
    this.frames.push({ p, d: p.d, pos: cand.pos, sync: cand.val, cls: -1, adj: 0, E: [] });
  }

  // Energy of every tone over the window starting at absolute sample `at`.
  energies(d, at) {
    const x = this.scratch;
    const mask = this.R - 1;
    const N = d.nWin;
    for (let i = 0; i < N; i++) x[i] = this.ring[(at + i) & mask];
    const e = new Float64Array(d.nBins);
    for (let b = 0; b < d.nBins; b++) {
      const c = d.coef[b];
      let s1 = 0;
      let s2 = 0;
      for (let i = 0; i < N; i++) {
        const s0 = x[i] + c * s1 - s2;
        s2 = s1;
        s1 = s0;
      }
      e[b] = Math.max(0, s1 * s1 + s2 * s2 - c * s1 * s2);
    }
    return e;
  }

  service() {
    for (const f of this.frames.slice()) {
      const { d } = f;
      if (this.n - f.pos > this.R - this.sr) {
        this.drop(f);
        continue;
      }
      if (f.cls < 0) {
        if (this.n < f.pos + d.symStart(0) + d.winOff + d.nWin + f.p.maxAdj) continue;
        if (!this.header(f)) continue;
      }
      const c = d.classes[f.cls];
      while (f.E.length < c.syms) {
        const at = f.pos + d.symStart(f.E.length + 1) + d.winOff + f.adj;
        if (this.n < at + d.nWin) break;
        f.E.push(this.energies(d, at));
        if (this.onProgress) this.onProgress(this.info(f));
      }
      if (f.E.length === c.syms) this.finish(f);
    }
  }

  info(f, extra) {
    const c = f.d.classes[f.cls] || null;
    return {
      profile: f.d.id,
      pos: f.pos,
      end: c ? f.pos + f.d.symStart(1 + c.syms) : f.pos,
      sync: f.sync,
      symbols: f.E.length,
      totalSymbols: c ? c.syms : 0,
      bytes: c ? c.k - 2 : 0,
      ...extra,
    };
  }

  drop(f, why) {
    this.frames.splice(this.frames.indexOf(f), 1);
    if (why) {
      this.stats.failures++;
      if (this.onFail) this.onFail(this.info(f, { why }));
    }
  }

  // Read the header symbol, fine-tuning symbol timing on the way.
  header(f) {
    const { d, p } = f;
    const G = d.groups;
    const M = d.M;
    let best = { score: -1, adj: 0, v: 0 };
    for (let adj = -p.maxAdj; adj <= p.maxAdj; adj += p.adjStep) {
      const e = this.energies(d, f.pos + d.symStart(0) + d.winOff + adj);
      const votes = new Float64Array(M);
      for (let g = 0; g < G; g++) {
        let tot = 1e-30;
        for (let v = 0; v < M; v++) tot += e[g * M + v];
        for (let v = 0; v < M; v++) votes[v] += e[g * M + v] / tot;
      }
      let v = 0;
      for (let i = 1; i < M; i++) if (votes[i] > votes[v]) v = i;
      const score = votes[v];
      if (score > best.score + 1e-9 || (Math.abs(score - best.score) <= 1e-9 && Math.abs(adj) < Math.abs(best.adj))) {
        best = { score, adj, v };
      }
    }
    const cls = grayInv(best.v);
    if (best.score < 0.45 * G || cls >= d.classes.length) {
      this.drop(f, f.sync > 0.5 ? 'header' : null);
      return false;
    }
    f.cls = cls;
    f.adj = best.adj;
    if (this.onDetect) this.onDetect(this.info(f));
    return true;
  }

  finish(f) {
    const { d } = f;
    const { k, nsym, n, syms } = d.classes[f.cls];
    const G = d.groups;
    const M = d.M;
    const nb = d.nBins;
    // Per-tone background (lower quartile over the frame) cancels steady hums
    // and whistles that would otherwise win the same tone in every symbol.
    // Whitened data keeps any one tone from being on most of the time.
    const bg = new Float64Array(nb);
    if (syms >= 8) {
      const col = new Float64Array(syms);
      for (let b = 0; b < nb; b++) {
        for (let s = 0; s < syms; s++) col[s] = f.E[s][b];
        col.sort();
        bg[b] = col[syms >> 2];
      }
    }
    const X = f.E.map((e) => e.map((v, b) => Math.max(0, v - bg[b])));
    const winners = (Y) => Y.map((e) => {
      const w = new Uint8Array(G);
      for (let g = 0; g < G; g++) {
        let bi = 0;
        for (let v = 1; v < M; v++) if (e[g * M + v] > e[g * M + bi]) bi = v;
        w[g] = bi;
      }
      return w;
    });
    // Echo of the previous symbols lingers in this one. Estimate how much of
    // a tone's energy carries over (from tones that just switched off) and
    // take it back out before the final decisions.
    let Y = X;
    if (syms >= 4 && !Demodulator.noEcho) {
      const w = winners(X);
      const beta = [];
      for (const lag of [1, 2]) {
        let num = 0;
        let den = 0;
        for (let s = lag; s < syms; s++) {
          for (let g = 0; g < G; g++) {
            const b = g * M + w[s - lag][g];
            if (w[s][g] === w[s - lag][g]) continue;
            num += X[s][b] * X[s - lag][b];
            den += X[s - lag][b] * X[s - lag][b];
          }
        }
        beta.push(den > 0 ? Math.min(0.9, Math.max(0, num / den)) : 0);
      }
      Y = X.map((e, s) => e.map((v, b) => Math.max(0, v - (s >= 1 ? beta[0] * X[s - 1][b] : 0) - (s >= 2 ? beta[1] * X[s - 2][b] : 0))));
      f.echo = beta;
    }
    const bytes = new Uint8Array(Math.ceil((syms * G * d.bits) / 8));
    const conf = new Float64Array(bytes.length).fill(1);
    let bit = 0;
    let snr = 0;
    for (let s = 0; s < syms; s++) {
      const e = Y[s];
      for (let g = 0; g < G; g++) {
        let bi = 0;
        let be = -1;
        let se = -1;
        let sum = 0;
        for (let v = 0; v < M; v++) {
          const x = e[g * M + v];
          sum += x;
          if (x > be) {
            se = be;
            be = x;
            bi = v;
          } else if (x > se) se = x;
        }
        const q = be > 0 ? (be - se) / be : 0;
        snr += be / ((sum - be) / (M - 1) + be * 1e-6 + 1e-30);
        const val = grayInv(bi);
        for (let b = d.bits - 1; b >= 0; b--, bit++) {
          if ((val >> b) & 1) bytes[bit >> 3] |= 0x80 >> (bit & 7);
          if (q < conf[bit >> 3]) conf[bit >> 3] = q;
        }
      }
    }
    snr = 10 * Math.log10(snr / (syms * G));
    const cw = bytes.subarray(0, n);
    for (let i = 0; i < n; i++) cw[i] ^= WHITEN[i];
    const crcOk = (data) => crc16(data, 0, k - 2) === ((data[k - 2] << 8) | data[k - 1]);

    let r = rsDecode(cw, nsym);
    let erasures = 0;
    if (!r || !crcOk(r.data)) {
      r = null;
      const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => conf[a] - conf[b]);
      for (const E of [nsym >> 1, Math.round(nsym * 0.75), nsym - 2]) {
        const t = rsDecode(cw, nsym, order.slice(0, E));
        if (t && crcOk(t.data)) {
          r = t;
          erasures = E;
          break;
        }
      }
    }
    this.frames.splice(this.frames.indexOf(f), 1);
    if (!r) {
      this.stats.failures++;
      if (this.onFail) this.onFail(this.info(f, { why: 'fec', snr }));
      return;
    }
    this.stats.frames++;
    if (this.onFrame) this.onFrame(r.data.slice(0, k - 2), this.info(f, { snr, corrected: r.corrected, erasures }));
  }
}

export const LEAD_SECONDS = LEAD;
