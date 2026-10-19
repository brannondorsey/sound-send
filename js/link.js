// Transfer protocol on top of the modem: chunking, a CRC-32 over the whole
// transfer, and selective-repeat ARQ.
//
// The sender plays a burst of DATA frames, the last one flagged ACK-request,
// then listens. The receiver answers with an ACK: everything below `next` has
// arrived, plus a bitmap of the 64 chunks after it. Missing chunks go out in
// the next burst. A lost ACK is recovered with a short POLL. If no ACK ever
// comes back (say the other phone's speaker is muted) the sender keeps
// cycling through the chunks a few times so a listen-only phone still gets
// everything. The final ACK carries DONE only once the receiver has checked
// the CRC-32, so the sender's "delivered" tick means verified.

import { crc32 } from './crc.js';
import { airtime, maxPayload, PROFILES } from './modem.js';

export const T_DATA = 1;
export const T_ACK = 2;
export const T_POLL = 3;
export const T_CANCEL = 4;
const F_ACKREQ = 0x10;
const F_DONE = 0x10;
const F_FAIL = 0x20;
const DATA_HDR = 8;
const ACK_LEN = 15;
const BITMAP = 64;

export const chunkSize = (profile) => maxPayload(profile) - DATA_HDR;

export function encodePacket(p) {
  const u16 = (v) => [(v >> 8) & 0xff, v & 0xff];
  switch (p.type) {
    case T_DATA:
      return Uint8Array.from([T_DATA | (p.ackReq ? F_ACKREQ : 0), ...u16(p.sid), ...u16(p.seq), ...u16(p.total), p.data.length, ...p.data]);
    case T_ACK: {
      const out = new Uint8Array(ACK_LEN);
      out.set([T_ACK | (p.done ? F_DONE : 0) | (p.fail ? F_FAIL : 0), ...u16(p.sid), ...u16(p.next), ...u16(p.got)]);
      out.set(p.bitmap, 7);
      return out;
    }
    case T_POLL:
      return Uint8Array.from([T_POLL, ...u16(p.sid), ...u16(p.total)]);
    case T_CANCEL:
      return Uint8Array.from([T_CANCEL, ...u16(p.sid)]);
  }
  throw new Error('unknown packet type');
}

export function decodePacket(b) {
  if (b.length < 3) return null;
  const type = b[0] & 0x0f;
  const flags = b[0] & 0xf0;
  const u16 = (i) => (b[i] << 8) | b[i + 1];
  const sid = u16(1);
  if (!sid) return null;
  switch (type) {
    case T_DATA: {
      if (b.length < DATA_HDR) return null;
      const seq = u16(3);
      const total = u16(5);
      const len = b[7];
      if (!total || seq >= total || DATA_HDR + len > b.length) return null;
      return { type, sid, seq, total, ackReq: !!(flags & F_ACKREQ), data: b.slice(DATA_HDR, DATA_HDR + len) };
    }
    case T_ACK:
      if (b.length < ACK_LEN) return null;
      return { type, sid, next: u16(3), got: u16(5), bitmap: b.slice(7, 7 + BITMAP / 8), done: !!(flags & F_DONE), fail: !!(flags & F_FAIL) };
    case T_POLL:
      if (b.length < 5) return null;
      return { type, sid, total: u16(3) };
    case T_CANCEL:
      return { type, sid };
  }
  return null;
}

/** Rough seconds to deliver `bytes` (one clean pass, including ACK turnarounds). */
export function estimate(profile, bytes) {
  const size = chunkSize(profile);
  const total = Math.max(1, Math.ceil((bytes + 4) / size));
  const frame = airtime(profile, maxPayload(profile)) + 0.03;
  const bursts = Math.ceil(total / PROFILES[profile].burst);
  const last = airtime(profile, DATA_HDR + ((bytes + 4) % size || size));
  return (total - 1) * frame + last + bursts * (0.9 + airtime(profile, ACK_LEN));
}

const TURNAROUND = 0.25;
const RX_TIMEOUT = 45;
const RX_KEEP = 120;

/**
 * One end of a link. `phy` provides send(profile, bytes) -> Promise (resolves
 * once the frame has been played), busy() -> bool (a frame is on the air),
 * latency (seconds from the end of a frame on air to its decode) and receives
 * frames through phy.onFrame(profile, bytes, info).
 */
export class Link {
  constructor(phy, { timeScale = 1, random = Math.random } = {}) {
    this.phy = phy;
    this.scale = timeScale;
    this.random = random;
    this.rx = new Map();
    this.tx = null;
    this.handlers = {};
    this.waiter = null;
    phy.onFrame = (profile, bytes, info) => this.frame(profile, bytes, info);
    this.sweep = setInterval(() => this.expire(), 2000 * timeScale);
    if (this.sweep.unref) this.sweep.unref();
  }

  on(type, fn) {
    (this.handlers[type] ||= []).push(fn);
    return this;
  }

  emit(type, data) {
    for (const fn of this.handlers[type] || []) fn(data);
  }

  now() {
    return performance.now() / 1000 / this.scale;
  }

  sleep(s) {
    return new Promise((r) => setTimeout(r, s * 1000 * this.scale));
  }

  // Wait for a quiet channel (carrier sense), with a little random backoff.
  async idle(maxWait = 4) {
    const until = this.now() + maxWait;
    while (this.phy.busy() && this.now() < until) await this.sleep(0.05 + this.random() * 0.1);
  }

  destroy() {
    clearInterval(this.sweep);
    if (this.tx) this.tx.cancelled = true;
  }

  // ---------------------------------------------------------------- send --

  send(bytes, { profile = 'fast', fallback = true } = {}) {
    if (this.tx) throw new Error('already sending');
    const body = new Uint8Array(bytes.length + 4);
    body.set(bytes);
    new DataView(body.buffer).setUint32(bytes.length, crc32(bytes));
    const tx = {
      body, bytes: bytes.length, fallback, fellBack: false,
      state: 'sending', current: -1, peer: false, done: false, cancelled: false,
      resent: 0, started: this.now(), finished: 0,
    };
    this.chunk(tx, profile);
    tx.cancel = () => {
      if (tx.finished) return;
      tx.cancelled = true;
      if (this.waiter) this.waiter(null);
    };
    this.tx = tx;
    tx.promise = this.runSender(tx).finally(() => {
      if (this.tx === tx) this.tx = null;
    });
    return tx;
  }

  // (Re)split a transfer for a profile, under a fresh session id.
  chunk(tx, profile) {
    const size = chunkSize(profile);
    const total = Math.max(1, Math.ceil(tx.body.length / size));
    if (total > 0xffff) throw new RangeError('too big');
    let sid;
    do sid = 1 + Math.floor(this.random() * 0xfffe);
    while (this.rx.has(sid) || sid === tx.sid);
    Object.assign(tx, { sid, profile, size, total, acked: new Uint8Array(total), sends: new Uint16Array(total) });
  }

  progress(tx, state) {
    if (state) tx.state = state;
    tx.ackedCount = tx.acked.reduce((s, v) => s + v, 0);
    this.emit('tx', tx);
  }

  async runSender(tx) {
    let cursor = 0;
    let silent = 0;
    let stall = 0;
    let rounds = 0;
    while (!tx.cancelled) {
      const pending = [];
      for (let i = 0; i < tx.total; i++) if (!tx.acked[i]) pending.push(i);
      if (!pending.length) break;
      let start = pending.findIndex((i) => i >= cursor);
      if (start < 0) {
        start = 0;
        rounds++;
      }
      const burst = [];
      const B = PROFILES[tx.profile].burst;
      for (let j = 0; j < Math.min(B, pending.length); j++) burst.push(pending[(start + j) % pending.length]);
      cursor = burst[burst.length - 1] + 1;

      // Let an incoming transfer finish first, and back off at random after
      // unanswered bursts in case both phones started talking at once.
      while (this.incomingActive() && !tx.cancelled) {
        this.progress(tx, 'yielding');
        await this.sleep(0.25);
      }
      if (silent) await this.sleep(this.random() * Math.min(4, 0.75 * 2 ** silent));
      await this.idle();
      for (const [j, i] of burst.entries()) {
        if (tx.cancelled) break;
        tx.current = i;
        this.progress(tx, 'sending');
        const data = tx.body.subarray(i * tx.size, (i + 1) * tx.size);
        await this.phy.send(tx.profile, encodePacket({ type: T_DATA, sid: tx.sid, seq: i, total: tx.total, data, ackReq: j === burst.length - 1 }));
        if (tx.sends[i]++) tx.resent++;
      }
      tx.current = -1;
      if (tx.cancelled) break;

      const before = tx.acked.reduce((n, v) => n + v, 0);
      this.progress(tx, 'waiting');
      let ack = await this.waitAck(tx);
      const polls = tx.peer ? 2 : rounds === 0 && cursor <= B ? 1 : 0;
      for (let p = 0; !ack && p < polls && !tx.cancelled; p++) {
        await this.idle();
        this.progress(tx, 'polling');
        await this.phy.send(tx.profile, encodePacket({ type: T_POLL, sid: tx.sid, total: tx.total }));
        ack = await this.waitAck(tx);
      }
      if (tx.done) break;
      const moved = tx.acked.reduce((n, v) => n + v, 0) > before;
      if (ack && moved) {
        silent = stall = 0;
        continue;
      }
      if (ack) stall++;
      else silent++;
      // Not a word back after the first burst, or answers that show nothing
      // arriving: probably too echoey or noisy for fast. Start over in slow.
      if (tx.profile === 'fast' && tx.fallback && !tx.fellBack && ((!ack && !tx.peer) || stall >= 2)) {
        tx.fellBack = true;
        this.chunk(tx, 'slow');
        cursor = rounds = silent = stall = 0;
        this.progress(tx, 'slower');
        continue;
      }
      if (stall >= 6) break;
      if (ack) continue;
      let least = Infinity;
      for (let i = 0; i < tx.total; i++) if (!tx.acked[i]) least = Math.min(least, tx.sends[i]);
      if (!tx.peer && least >= 3) break;
      if (tx.peer && silent >= 4) break;
    }
    tx.finished = this.now();
    if (tx.cancelled) {
      this.progress(tx, 'cancelled');
      await this.idle(1);
      await this.phy.send(tx.profile, encodePacket({ type: T_CANCEL, sid: tx.sid }));
    } else {
      this.progress(tx, tx.done ? 'done' : tx.peer ? 'lost' : 'unconfirmed');
    }
    return tx.state;
  }

  incomingActive() {
    const t = this.now();
    for (const rx of this.rx.values()) if (!rx.done && t - rx.last < 4) return true;
    return false;
  }

  waitAck(tx) {
    const timeout = TURNAROUND + 2 * this.phy.latency + airtime(tx.profile, ACK_LEN) + 0.5;
    const hardStop = timeout + airtime(tx.profile, maxPayload(tx.profile)) + 1.5;
    return new Promise((resolve) => {
      const t0 = this.now();
      let timer;
      const done = (ack) => {
        clearTimeout(timer);
        if (this.waiter === done) this.waiter = null;
        resolve(ack);
      };
      const check = () => {
        const age = this.now() - t0;
        // Someone is mid-frame: that is probably our ACK, so hear it out.
        if (age < hardStop && (age < timeout || this.phy.busy())) timer = setTimeout(check, 100 * this.scale);
        else done(null);
      };
      this.waiter = done;
      timer = setTimeout(check, timeout * 1000 * this.scale);
    });
  }

  handleAck(tx, a) {
    tx.peer = true;
    if (a.fail) tx.acked.fill(0);
    for (let i = 0; i < Math.min(a.next, tx.total); i++) tx.acked[i] = 1;
    for (let j = 0; j < BITMAP; j++) {
      const i = a.next + j;
      if (i < tx.total && (a.bitmap[j >> 3] >> (7 - (j & 7))) & 1) tx.acked[i] = 1;
    }
    if (a.done) {
      tx.done = true;
      tx.acked.fill(1);
    }
    this.progress(tx);
    if (this.waiter) this.waiter(a);
  }

  // ------------------------------------------------------------- receive --

  frame(profile, bytes, info) {
    const p = decodePacket(bytes);
    if (!p) return;
    const tx = this.tx;
    if (tx && p.sid === tx.sid) {
      if (p.type === T_ACK) this.handleAck(tx, p);
      return; // anything else with our id is our own echo
    }
    if (p.type === T_DATA) this.data(profile, p, info);
    else if (p.type === T_POLL) {
      const rx = this.rx.get(p.sid);
      if (rx && rx.total === p.total) this.ack(rx, profile);
    } else if (p.type === T_CANCEL) {
      const rx = this.rx.get(p.sid);
      if (rx && !rx.done) {
        this.rx.delete(p.sid);
        rx.state = 'cancelled';
        this.emit('rx-fail', rx);
      }
    }
  }

  data(profile, p, info) {
    let rx = this.rx.get(p.sid);
    if (rx && rx.total !== p.total) return;
    if (!rx) {
      rx = {
        sid: p.sid, total: p.total, profile, chunks: new Array(p.total), have: new Uint8Array(p.total),
        got: 0, done: false, failed: false, state: 'receiving', started: this.now(), last: this.now(), current: p.seq,
      };
      this.rx.set(p.sid, rx);
      this.emit('rx-start', rx);
    }
    rx.last = this.now();
    rx.profile = profile;
    rx.current = p.seq;
    rx.snr = info && info.snr;
    if (!rx.have[p.seq]) {
      rx.have[p.seq] = 1;
      rx.chunks[p.seq] = p.data;
      rx.got++;
    }
    if (rx.got === rx.total && !rx.done) {
      const len = rx.chunks.reduce((s, c) => s + c.length, 0);
      const body = new Uint8Array(len);
      let o = 0;
      for (const c of rx.chunks) {
        body.set(c, o);
        o += c.length;
      }
      const bytes = body.subarray(0, len - 4);
      if (len >= 4 && new DataView(body.buffer).getUint32(len - 4) === crc32(bytes)) {
        rx.done = true;
        rx.state = 'done';
        rx.bytes = bytes;
        rx.finished = this.now();
      } else {
        rx.failed = true;
        rx.have.fill(0);
        rx.chunks = new Array(rx.total);
        rx.got = 0;
      }
    }
    this.emit(rx.done && rx.state === 'done' && !rx.announced ? 'rx-done' : 'rx-progress', rx);
    if (rx.done) rx.announced = true;
    if (p.ackReq) this.ack(rx, profile);
  }

  async ack(rx, profile) {
    if (rx.acking) return;
    rx.acking = true;
    try {
      await this.sleep(TURNAROUND);
      await this.idle(3);
      let next = 0;
      while (next < rx.total && rx.have[next]) next++;
      const bitmap = new Uint8Array(BITMAP / 8);
      for (let j = 0; j < BITMAP; j++) if (next + j < rx.total && rx.have[next + j]) bitmap[j >> 3] |= 0x80 >> (j & 7);
      const pkt = encodePacket({ type: T_ACK, sid: rx.sid, next, got: rx.got, bitmap, done: rx.done, fail: rx.failed });
      rx.failed = false;
      await this.phy.send(profile, pkt);
    } finally {
      rx.acking = false;
    }
  }

  expire() {
    const t = this.now();
    for (const [sid, rx] of this.rx) {
      if (!rx.done && t - rx.last > RX_TIMEOUT) {
        this.rx.delete(sid);
        rx.state = 'timeout';
        this.emit('rx-fail', rx);
      } else if (rx.done && t - rx.last > RX_KEEP) this.rx.delete(sid);
    }
  }
}
