// What a transfer carries: a small header (kind, name, MIME type) and a body
// that is deflated when that makes it smaller.
//
//   [version][kind][flags][nameLen][name…][mimeLen][mime…][body…]

export const KIND = { TEXT: 1, CONTACT: 2, FILE: 3, WIFI: 4 };
const VERSION = 1;
const F_DEFLATE = 1;

const enc = new TextEncoder();
const dec = new TextDecoder();

async function pipe(bytes, stream) {
  const out = new Response(new Blob([bytes]).stream().pipeThrough(stream));
  return new Uint8Array(await out.arrayBuffer());
}

const canDeflate = () => typeof CompressionStream === 'function' && typeof DecompressionStream === 'function';

function clip(str, max = 200) {
  let b = enc.encode(str);
  while (b.length > max) {
    str = str.slice(0, -1);
    b = enc.encode(str);
  }
  return b;
}

export async function pack({ kind, name = '', mime = '', body }) {
  let flags = 0;
  let payload = body;
  if (body.length > 48 && canDeflate()) {
    try {
      const z = await pipe(body, new CompressionStream('deflate'));
      if (z.length < body.length - 8) {
        payload = z;
        flags |= F_DEFLATE;
      }
    } catch {
      /* send it as is */
    }
  }
  const n = clip(name);
  const m = clip(mime, 100);
  const out = new Uint8Array(5 + n.length + m.length + payload.length);
  out.set([VERSION, kind, flags, n.length]);
  out.set(n, 4);
  out[4 + n.length] = m.length;
  out.set(m, 5 + n.length);
  out.set(payload, 5 + n.length + m.length);
  return out;
}

/** Read the header only; works on a partial transfer (its first chunk). */
export function peek(bytes) {
  if (bytes.length < 5 || bytes[0] !== VERSION) return null;
  const nl = bytes[3];
  if (bytes.length < 5 + nl) return null;
  const ml = bytes[4 + nl];
  if (bytes.length < 5 + nl + ml) return null;
  return {
    kind: bytes[1],
    deflated: !!(bytes[2] & F_DEFLATE),
    name: dec.decode(bytes.subarray(4, 4 + nl)),
    mime: dec.decode(bytes.subarray(5 + nl, 5 + nl + ml)),
    offset: 5 + nl + ml,
  };
}

export async function unpack(bytes) {
  const h = peek(bytes);
  if (!h) throw new Error('not a sound.send message');
  let body = bytes.slice(h.offset);
  if (h.deflated) body = await pipe(body, new DecompressionStream('deflate'));
  return { kind: h.kind, name: h.name, mime: h.mime, body };
}

export const text = (bytes) => dec.decode(bytes);
export const utf8 = (str) => enc.encode(str);

// ------------------------------------------------------------- vCard --

const vEsc = (s) => String(s).replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/([,;])/g, '\\$1');
const vUnesc = (s) => s.replace(/\\n/gi, '\n').replace(/\\([,;\\])/g, '$1');

export function buildVCard({ name = '', tel = [], email = [], url = [], org = '', note = '' }) {
  const lines = ['BEGIN:VCARD', 'VERSION:3.0'];
  const parts = name.trim().split(/\s+/);
  const last = parts.length > 1 ? parts.pop() : '';
  lines.push(`N:${vEsc(last)};${vEsc(parts.join(' '))};;;`, `FN:${vEsc(name.trim())}`);
  if (org) lines.push(`ORG:${vEsc(org)}`);
  for (const t of [].concat(tel).filter(Boolean)) lines.push(`TEL;TYPE=CELL:${vEsc(t)}`);
  for (const e of [].concat(email).filter(Boolean)) lines.push(`EMAIL:${vEsc(e)}`);
  for (const u of [].concat(url).filter(Boolean)) lines.push(`URL:${vEsc(u)}`);
  if (note) lines.push(`NOTE:${vEsc(note)}`);
  lines.push('END:VCARD');
  return lines.join('\r\n') + '\r\n';
}

export function parseVCard(str) {
  const card = { name: '', tel: [], email: [], url: [], org: '', note: '' };
  const unfolded = str.replace(/\r?\n[ \t]/g, '');
  for (const line of unfolded.split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i < 0) continue;
    const key = line.slice(0, i).split(';')[0].toUpperCase().replace(/^ITEM\d+\./, '');
    const val = vUnesc(line.slice(i + 1));
    if (key === 'FN') card.name = val;
    else if (key === 'N' && !card.name) card.name = val.split(';').slice(0, 2).reverse().join(' ').trim();
    else if (key === 'TEL') card.tel.push(val);
    else if (key === 'EMAIL') card.email.push(val);
    else if (key === 'URL') card.url.push(val);
    else if (key === 'ORG') card.org = val.replace(/;+$/, '');
    else if (key === 'NOTE') card.note = val;
  }
  return card;
}

// ------------------------------------------------------------- Wi-Fi --

const wEsc = (s) => String(s).replace(/([\\;,:"])/g, '\\$1');

export function buildWifi({ ssid, password = '', hidden = false }) {
  const type = password ? 'WPA' : 'nopass';
  return `WIFI:T:${type};S:${wEsc(ssid)};${password ? `P:${wEsc(password)};` : ''}${hidden ? 'H:true;' : ''};`;
}

export function parseWifi(str) {
  if (!/^WIFI:/i.test(str)) return null;
  const out = { ssid: '', password: '', type: '' };
  const re = /([TSPH]):((?:\\.|[^;\\])*);/gi;
  let m;
  while ((m = re.exec(str.slice(5)))) {
    const v = m[2].replace(/\\(.)/g, '$1');
    const k = m[1].toUpperCase();
    if (k === 'S') out.ssid = v;
    else if (k === 'P') out.password = v;
    else if (k === 'T') out.type = v;
  }
  return out;
}
