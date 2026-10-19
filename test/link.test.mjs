import test from 'node:test';
import assert from 'node:assert/strict';
import { Link, encodePacket, decodePacket, T_DATA, T_ACK, T_POLL, T_CANCEL, chunkSize, estimate } from '../js/link.js';
import { airtime } from '../js/modem.js';
import { rng } from './channel.mjs';

const SCALE = 0.01; // run the protocol 100x faster than real time

// Frame-level air: every endpoint hears every other one after the frame's
// airtime. Overlapping transmissions collide and nobody hears either.
class SimAir {
  constructor({ loss = () => false } = {}) {
    this.loss = loss;
    this.eps = [];
    this.onAir = [];
  }

  endpoint(name) {
    const air = this;
    const ep = {
      name,
      latency: 0.6,
      onFrame: null,
      sent: [],
      send(profile, bytes) {
        const dur = airtime(profile, bytes.length);
        const t = { from: ep, start: performance.now(), end: performance.now() + dur * 1000 * SCALE, collided: false };
        for (const o of air.onAir) if (o.end > t.start) o.collided = t.collided = true;
        air.onAir.push(t);
        ep.sent.push(decodePacket(bytes));
        return new Promise((resolve) => setTimeout(() => {
          air.onAir.splice(air.onAir.indexOf(t), 1);
          for (const other of air.eps) {
            if (other === ep || t.collided || air.loss(ep, other, bytes)) continue;
            setTimeout(() => other.onFrame && other.onFrame(profile, bytes, {}), 0.3 * 1000 * SCALE);
          }
          resolve();
        }, dur * 1000 * SCALE));
      },
      busy() {
        return air.onAir.some((o) => o.from !== ep);
      },
    };
    this.eps.push(ep);
    return ep;
  }
}

function setup(opts) {
  const air = new SimAir(opts);
  const a = new Link(air.endpoint('a'), { timeScale: SCALE, random: rng(11) });
  const b = new Link(air.endpoint('b'), { timeScale: SCALE, random: rng(22) });
  return { air, a, b };
}

function received(link) {
  return new Promise((resolve) => link.on('rx-done', (rx) => resolve(rx)));
}

const blob = (n, seed = 1) => {
  const r = rng(seed);
  return Uint8Array.from({ length: n }, () => Math.floor(r() * 256));
};

test('packets round-trip', () => {
  const data = blob(30);
  const d = decodePacket(encodePacket({ type: T_DATA, sid: 513, seq: 3, total: 9, data, ackReq: true }));
  assert.deepEqual({ ...d, data: [...d.data] }, { type: T_DATA, sid: 513, seq: 3, total: 9, ackReq: true, data: [...data] });
  const bitmap = Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8]);
  const a = decodePacket(encodePacket({ type: T_ACK, sid: 7, next: 4, got: 6, bitmap, done: true, fail: false }));
  assert.deepEqual({ ...a, bitmap: [...a.bitmap] }, { type: T_ACK, sid: 7, next: 4, got: 6, bitmap: [...bitmap], done: true, fail: false });
  assert.deepEqual(decodePacket(encodePacket({ type: T_POLL, sid: 9, total: 12 })), { type: T_POLL, sid: 9, total: 12 });
  assert.deepEqual(decodePacket(encodePacket({ type: T_CANCEL, sid: 9 })), { type: T_CANCEL, sid: 9 });
  assert.equal(decodePacket(Uint8Array.from([1, 0, 0, 0, 0, 0, 1, 0])), null); // sid 0
  assert.equal(decodePacket(Uint8Array.from([1, 0, 5, 0, 4, 0, 4, 0])), null); // seq >= total
});

test('clean transfer is delivered and verified', async () => {
  const { a, b } = setup();
  const data = blob(3000);
  const got = received(b);
  const tx = a.send(data);
  assert.equal(await tx.promise, 'done');
  const rx = await got;
  assert.deepEqual(rx.bytes, data);
  assert.equal(tx.resent, 0);
  a.destroy();
  b.destroy();
});

test('30% frame loss both ways still delivers', async () => {
  const r = rng(3);
  const { a, b } = setup({ loss: () => r() < 0.3 });
  const data = blob(5000, 2);
  const got = received(b);
  const tx = a.send(data, { profile: 'fast' });
  assert.equal(await tx.promise, 'done');
  assert.deepEqual((await got).bytes, data);
  assert.ok(tx.resent > 0);
  a.destroy();
  b.destroy();
});

test('slow profile delivers too', async () => {
  const r = rng(4);
  const { a, b } = setup({ loss: () => r() < 0.15 });
  const data = blob(600, 3);
  const got = received(b);
  const tx = a.send(data, { profile: 'slow' });
  assert.equal(await tx.promise, 'done');
  assert.deepEqual((await got).bytes, data);
  a.destroy();
  b.destroy();
});

test('one-way (receiver cannot be heard) still gets everything', async () => {
  const r = rng(5);
  const { a, b } = setup({ loss: (from) => from.name === 'b' || r() < 0.1 });
  const data = blob(2500, 4);
  const got = received(b);
  const tx = a.send(data, { fallback: false });
  assert.equal(await tx.promise, 'unconfirmed');
  assert.deepEqual((await got).bytes, data);
  a.destroy();
  b.destroy();
});

test('falls back to slow when fast frames do not get through', async () => {
  const air = new SimAir({ loss: (from, to, bytes) => bytes.length > 30 && from.name === 'a' && air.lastProfile === 'fast' });
  const epA = air.endpoint('a');
  const send = epA.send;
  epA.send = (profile, bytes) => {
    air.lastProfile = profile;
    return send(profile, bytes);
  };
  const a = new Link(epA, { timeScale: SCALE, random: rng(12) });
  const b = new Link(air.endpoint('b'), { timeScale: SCALE, random: rng(23) });
  const data = blob(400, 8);
  const got = received(b);
  const tx = a.send(data);
  assert.equal(await tx.promise, 'done');
  assert.equal(tx.profile, 'slow');
  assert.ok(tx.fellBack);
  assert.deepEqual((await got).bytes, data);
  a.destroy();
  b.destroy();
});

test('cancel tells the receiver', async () => {
  const { a, b } = setup();
  const failed = new Promise((resolve) => b.on('rx-fail', resolve));
  const tx = a.send(blob(8000));
  b.on('rx-progress', (rx) => rx.got >= 3 && tx.cancel());
  assert.equal(await tx.promise, 'cancelled');
  assert.equal((await failed).state, 'cancelled');
  a.destroy();
  b.destroy();
});

test('both sides sending at once sort themselves out', async () => {
  const { a, b } = setup();
  const da = blob(1200, 6);
  const db = blob(900, 7);
  const gotA = received(a);
  const gotB = received(b);
  const ta = a.send(da);
  const tb = b.send(db);
  assert.equal(await ta.promise, 'done');
  assert.equal(await tb.promise, 'done');
  assert.deepEqual((await gotB).bytes, da);
  assert.deepEqual((await gotA).bytes, db);
  a.destroy();
  b.destroy();
});

test('estimate is in the right ballpark', () => {
  assert.equal(chunkSize('fast'), 194);
  const s = estimate('fast', 10000);
  assert.ok(s > 55 && s < 85, `fast 10 KB: ${s.toFixed(1)} s`);
  const t = estimate('slow', 200);
  assert.ok(t > 5 && t < 15, `slow 200 B: ${t.toFixed(1)} s`);
});
