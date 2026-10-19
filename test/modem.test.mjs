import test from 'node:test';
import assert from 'node:assert/strict';
import { modulate, Demodulator, PROFILES, airtime, maxPayload } from '../js/modem.js';
import { channel, listen, rng } from './channel.mjs';

function payload(len, seed) {
  const r = rng(seed);
  return Uint8Array.from({ length: len }, () => Math.floor(r() * 256));
}

function concat(parts, sr, gap = 0.05) {
  const g = Math.round(gap * sr);
  const out = new Float32Array(parts.reduce((s, p) => s + p.length + g, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length + g;
  }
  return out;
}

for (const id of Object.keys(PROFILES)) {
  test(`${id}: every frame size round-trips over a clean line`, () => {
    const sr = 48000;
    const sizes = [0, 1, 7, ...PROFILES[id].classes.map(([k]) => k - 2)];
    const sent = sizes.map((n, i) => payload(n, 10 + i));
    const audio = concat(sent.map((p) => modulate(id, p, sr)), sr);
    const { frames, fails } = listen(new Demodulator(sr), concat([new Float32Array(sr / 2), audio], sr));
    assert.equal(fails.length, 0);
    assert.equal(frames.length, sent.length);
    frames.forEach((f, i) => {
      assert.equal(f.info.profile, id);
      assert.deepEqual(f.payload.subarray(0, sent[i].length), sent[i]);
      assert.equal(f.info.corrected, 0);
    });
  });

  test(`${id}: airtime matches the rendered audio`, () => {
    const sr = 44100;
    const len = maxPayload(id);
    const samples = modulate(id, payload(len, 1), sr);
    assert.ok(Math.abs(samples.length / sr - (airtime(id, len) + 0.015)) < 0.003);
  });
}

// Realistic-ish conditions, each run many times with different noise/reverb.
const CONDITIONS = [
  { name: 'close, quiet room', opts: { snrDb: 35, wet: 0.03 } },
  { name: '44.1k sender, 48k receiver, 120 ppm', opts: { srTx: 44100, srRx: 48000, ppm: 120, snrDb: 30 } },
  { name: '48k sender, 44.1k receiver', opts: { srTx: 48000, srRx: 44100, ppm: -80, snrDb: 30 } },
  { name: 'echoey room', opts: { snrDb: 30, wet: 0.25, rt60: 0.7 } },
  { name: 'noisy cafe', opts: { snrDb: 14, wet: 0.08 } },
  { name: 'hum and a whistle', opts: { snrDb: 28, hum: 3, whistle: 1.5 } },
];

for (const id of Object.keys(PROFILES)) {
  for (const { name, opts } of CONDITIONS) {
    test(`${id}: ${name}`, () => {
      const srTx = opts.srTx || 48000;
      const srRx = opts.srRx || 48000;
      const len = maxPayload(id);
      let ok = 0;
      let corrected = 0;
      const trials = 8;
      for (let t = 0; t < trials; t++) {
        const sent = [payload(len, 100 + t), payload(15, 200 + t)];
        const tx = concat(sent.map((p) => modulate(id, p, srTx)), srTx, 0.03);
        const rx = channel(tx, { ...opts, seed: 7 + t * 13 });
        const { frames } = listen(new Demodulator(srRx), rx);
        for (const [i, s] of sent.entries()) {
          const f = frames.find((f) => s.every((b, j) => f.payload[j] === b));
          if (f) {
            ok++;
            corrected += f.info.corrected;
          }
          else if (process.env.DEBUG) console.log(id, name, 'trial', t, 'frame', i, 'lost', frames.map((f) => f.info));
        }
      }
      if (process.env.DEBUG) console.log(`${id} / ${name}: ${ok}/${trials * 2} frames, ${corrected} bytes corrected`);
      assert.ok(ok >= trials * 2 - 1, `${ok}/${trials * 2} frames decoded`);
    });
  }
}

test('noise alone does not produce frames', () => {
  const sr = 48000;
  const rx = channel(new Float32Array(sr * 5), { gain: 0, snrDb: 0, lead: 0, tail: 0 });
  // channel() scales noise to the (zero) signal, so add some explicitly
  const r = rng(5);
  for (let i = 0; i < rx.length; i++) rx[i] = (r() - 0.5) * 0.2;
  const { frames } = listen(new Demodulator(sr), rx);
  assert.equal(frames.length, 0);
});
