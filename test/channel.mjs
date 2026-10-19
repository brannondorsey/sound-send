// A rough phone-to-phone acoustic channel for tests: small-speaker frequency
// response, resampling between unrelated clocks, a room impulse response,
// gain, noise, a mains-ish hum and an optional whistle.

import { fft, nextPow2 } from '../js/fft.js';

export function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

function gauss(rand) {
  const u = Math.max(1e-12, rand());
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
}

function biquad(x, { b0, b1, b2, a1, a2 }) {
  const y = new Float32Array(x.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const v = b0 * x[i] + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1; x1 = x[i]; y2 = y1; y1 = v;
    y[i] = v;
  }
  return y;
}

function rbj(type, f0, sr, q, gainDb = 0) {
  const w0 = (2 * Math.PI * f0) / sr;
  const cw = Math.cos(w0);
  const al = Math.sin(w0) / (2 * q);
  const A = 10 ** (gainDb / 40);
  let b0, b1, b2, a0, a1, a2;
  if (type === 'hp') { b0 = (1 + cw) / 2; b1 = -(1 + cw); b2 = (1 + cw) / 2; a0 = 1 + al; a1 = -2 * cw; a2 = 1 - al; }
  if (type === 'lp') { b0 = (1 - cw) / 2; b1 = 1 - cw; b2 = (1 - cw) / 2; a0 = 1 + al; a1 = -2 * cw; a2 = 1 - al; }
  if (type === 'peak') { b0 = 1 + al * A; b1 = -2 * cw; b2 = 1 - al * A; a0 = 1 + al / A; a1 = -2 * cw; a2 = 1 - al / A; }
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
}

function resample(x, ratio) {
  // ratio = output rate / input rate; Catmull-Rom interpolation
  const n = Math.floor((x.length - 3) * ratio);
  const y = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / ratio;
    const k = Math.floor(t);
    const f = t - k;
    const p0 = x[Math.max(0, k - 1)], p1 = x[k], p2 = x[k + 1], p3 = x[k + 2];
    y[i] = p1 + 0.5 * f * (p2 - p0 + f * (2 * p0 - 5 * p1 + 4 * p2 - p3 + f * (3 * (p1 - p2) + p3 - p0)));
  }
  return y;
}

function convolve(x, h) {
  const N = nextPow2(x.length + h.length);
  const ar = new Float64Array(N), ai = new Float64Array(N);
  const br = new Float64Array(N), bi = new Float64Array(N);
  ar.set(x);
  br.set(h);
  fft(ar, ai);
  fft(br, bi);
  for (let k = 0; k < N; k++) {
    const r = ar[k] * br[k] - ai[k] * bi[k];
    ai[k] = ar[k] * bi[k] + ai[k] * br[k];
    ar[k] = r;
  }
  fft(ar, ai, true);
  const y = new Float32Array(x.length + h.length - 1);
  for (let i = 0; i < y.length; i++) y[i] = ar[i] / N;
  return y;
}

export function roomIR(sr, rand, { rt60 = 0.4, wet = 0.05, distance = 0.15 } = {}) {
  const len = Math.round(rt60 * sr);
  const h = new Float32Array(len);
  const delay = Math.round((distance / 343) * sr);
  h[delay] = 1;
  // table bounce and a few early reflections
  for (const [ms, a] of [[0.4, 0.5], [2.1, 0.25], [4.7, 0.18], [7.9, 0.12], [11.3, 0.08]]) {
    h[delay + Math.round((ms / 1000) * sr)] += a * (rand() < 0.5 ? -1 : 1);
  }
  // diffuse tail: decaying noise, scaled so its energy is `wet` of the direct path
  let e = 0;
  const tail = new Float32Array(len);
  const start = delay + Math.round(0.005 * sr);
  for (let i = start; i < len; i++) {
    tail[i] = gauss(rand) * Math.exp((-6.9 * (i - start)) / sr / rt60);
    e += tail[i] * tail[i];
  }
  const s = Math.sqrt(wet / e);
  for (let i = 0; i < len; i++) h[i] += tail[i] * s;
  return h;
}

export function channel(tx, {
  srTx = 48000, srRx = 48000, ppm = 0, gain = 0.2, snrDb = 30, response = true,
  rt60 = 0.4, wet = 0.05, hum = 0, whistle = 0, whistleHz = 3010, lead = 0.4, tail = 0.6, seed = 1,
} = {}) {
  const rand = rng(seed);
  let x = tx;
  if (response) {
    x = biquad(x, rbj('hp', 650, srTx, 0.9));
    x = biquad(x, rbj('hp', 650, srTx, 0.9));
    x = biquad(x, rbj('peak', 2400, srTx, 1.4, 6));
    x = biquad(x, rbj('peak', 4900, srTx, 2.5, -9));
    x = biquad(x, rbj('peak', 6900, srTx, 3, 5));
    x = biquad(x, rbj('lp', 8500, srTx, 0.7));
  }
  x = resample(x, (srRx * (1 + ppm * 1e-6)) / srTx);
  if (wet > 0) x = convolve(x, roomIR(srRx, rand, { rt60, wet }));
  const pre = Math.round(lead * srRx);
  const out = new Float32Array(pre + x.length + Math.round(tail * srRx));
  let p = 0;
  for (let i = 0; i < x.length; i++) {
    out[pre + i] = x[i] * gain;
    p += out[pre + i] ** 2;
  }
  const rms = Math.sqrt(p / x.length);
  const sigma = rms / 10 ** (snrDb / 20);
  let pink = 0;
  for (let i = 0; i < out.length; i++) {
    pink = 0.97 * pink + gauss(rand) * 0.25;
    out[i] += sigma * (0.6 * gauss(rand) + 0.6 * pink);
    if (hum) out[i] += hum * rms * Math.sin((2 * Math.PI * 120 * i) / srRx);
    if (whistle) out[i] += whistle * rms * Math.sin((2 * Math.PI * whistleHz * i) / srRx);
  }
  return out;
}

/** Run samples through a demodulator in mic-sized chunks, collecting events. */
export function listen(demod, samples, chunk = 2048) {
  const frames = [];
  const fails = [];
  demod.onFrame = (payload, info) => frames.push({ payload, info });
  demod.onFail = (info) => fails.push(info);
  for (let i = 0; i < samples.length; i += chunk) demod.push(samples.subarray(i, i + chunk));
  // flush: a little silence so the correlator finishes its last block
  const z = new Float32Array(chunk);
  for (let i = 0; i < 40; i++) demod.push(z);
  return { frames, fails };
}
