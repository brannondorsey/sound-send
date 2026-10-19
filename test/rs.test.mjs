import test from 'node:test';
import assert from 'node:assert/strict';
import { rsEncode, rsDecode } from '../js/rs.js';
import { crc16, crc32 } from '../js/crc.js';

function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

function corrupt(cw, positions, rand) {
  const out = Uint8Array.from(cw);
  for (const p of positions) out[p] ^= 1 + Math.floor(rand() * 255);
  return out;
}

function pick(n, count, rand) {
  const all = Array.from({ length: n }, (_, i) => i);
  for (let i = all.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [all[i], all[j]] = [all[j], all[i]];
  }
  return all.slice(0, count);
}

test('crc reference values', () => {
  const s = new TextEncoder().encode('123456789');
  assert.equal(crc16(s), 0x29b1);
  assert.equal(crc32(s), 0xcbf43926);
});

test('clean codewords decode unchanged', () => {
  const rand = rng(1);
  for (const [k, nsym] of [[24, 12], [204, 48], [100, 48]]) {
    const msg = Uint8Array.from({ length: k }, () => Math.floor(rand() * 256));
    const cw = rsEncode(msg, nsym);
    const r = rsDecode(cw, nsym);
    assert.deepEqual(r.data, msg);
    assert.equal(r.corrected, 0);
  }
});

test('corrects up to nsym/2 random errors', () => {
  const rand = rng(2);
  for (let trial = 0; trial < 300; trial++) {
    const nsym = [8, 12, 18, 28, 48][trial % 5];
    const k = 10 + Math.floor(rand() * (255 - nsym - 10));
    const msg = Uint8Array.from({ length: k }, () => Math.floor(rand() * 256));
    const cw = rsEncode(msg, nsym);
    const errs = Math.floor(rand() * (nsym / 2 + 1));
    const bad = corrupt(cw, pick(cw.length, errs, rand), rand);
    const r = rsDecode(bad, nsym);
    assert.ok(r, `trial ${trial}: ${errs} errors, nsym ${nsym}`);
    assert.deepEqual(r.data, msg);
  }
});

test('corrects errors plus erasures within 2e + E <= nsym', () => {
  const rand = rng(3);
  for (let trial = 0; trial < 300; trial++) {
    const nsym = [12, 18, 28, 48][trial % 4];
    const k = 20 + Math.floor(rand() * (255 - nsym - 20));
    const msg = Uint8Array.from({ length: k }, () => Math.floor(rand() * 256));
    const cw = rsEncode(msg, nsym);
    const E = Math.floor(rand() * (nsym + 1));
    const e = Math.floor((nsym - E) / 2);
    const pos = pick(cw.length, E + e, rand);
    const erasures = pos.slice(0, E);
    const bad = corrupt(cw, pos, rand);
    // Some erased bytes are left intact, as happens on air.
    for (const p of erasures) if (rand() < 0.3) bad[p] = cw[p];
    const r = rsDecode(bad, nsym, erasures);
    assert.ok(r, `trial ${trial}: E=${E} e=${e} nsym=${nsym}`);
    assert.deepEqual(r.data, msg);
  }
});

test('reports failure (or a detectable miscorrection) beyond capacity', () => {
  const rand = rng(4);
  let failures = 0;
  for (let trial = 0; trial < 100; trial++) {
    const nsym = 16;
    const msg = Uint8Array.from({ length: 100 }, () => Math.floor(rand() * 256));
    const cw = rsEncode(msg, nsym);
    const bad = corrupt(cw, pick(cw.length, 20, rand), rand);
    const r = rsDecode(bad, nsym);
    if (!r) failures++;
    else assert.notDeepEqual(r.data, msg);
  }
  assert.ok(failures > 90);
});
