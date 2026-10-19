import test from 'node:test';
import assert from 'node:assert/strict';
import { pack, unpack, peek, KIND, utf8, text, buildVCard, parseVCard, buildWifi, parseWifi } from '../js/message.js';

test('text round-trips, compressed when that helps', async () => {
  const short = await pack({ kind: KIND.TEXT, body: utf8('hi 👋') });
  assert.equal(text((await unpack(short)).body), 'hi 👋');
  const long = 'the quick brown fox '.repeat(50);
  const packed = await pack({ kind: KIND.TEXT, body: utf8(long) });
  assert.ok(packed.length < long.length / 4);
  assert.equal(text((await unpack(packed)).body), long);
});

test('file header can be read from the first bytes alone', async () => {
  const body = Uint8Array.from({ length: 5000 }, (_, i) => (i * 7919) & 255);
  const packed = await pack({ kind: KIND.FILE, name: 'photo.jpg', mime: 'image/jpeg', body });
  const h = peek(packed.subarray(0, 60));
  assert.equal(h.kind, KIND.FILE);
  assert.equal(h.name, 'photo.jpg');
  assert.equal(h.mime, 'image/jpeg');
  assert.deepEqual((await unpack(packed)).body, body);
});

test('vCard build/parse', () => {
  const v = buildVCard({ name: 'Ada King Lovelace', tel: '+1 555 0100', email: 'ada@example.com', url: 'https://ada.dev', note: 'met at; the café' });
  const c = parseVCard(v);
  assert.equal(c.name, 'Ada King Lovelace');
  assert.deepEqual(c.tel, ['+1 555 0100']);
  assert.deepEqual(c.email, ['ada@example.com']);
  assert.deepEqual(c.url, ['https://ada.dev']);
  assert.equal(c.note, 'met at; the café');
  assert.match(v, /N:Lovelace;Ada King;;;/);
});

test('Wi-Fi build/parse with awkward characters', () => {
  const w = buildWifi({ ssid: 'Cafe;Guest', password: 'p:a\\ss;"1"' });
  assert.deepEqual(parseWifi(w), { ssid: 'Cafe;Guest', password: 'p:a\\ss;"1"', type: 'WPA' });
  assert.deepEqual(parseWifi(buildWifi({ ssid: 'Open' })), { ssid: 'Open', password: '', type: 'nopass' });
  assert.equal(parseWifi('hello'), null);
});
