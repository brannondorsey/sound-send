import { AudioIO, AudioPhy } from './audio.js';
import { Link, estimate } from './link.js';
import { pack, unpack, peek, KIND, utf8, text, parseVCard, parseWifi } from './message.js';
import { Orb, Waterfall } from './viz.js';
import { crc32 } from './crc.js';

const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const icon = (id, cls = 'ico') => `<svg class="${cls}"><use href="#i-${id}"/></svg>`;

const store = {
  get(k, d) {
    try {
      const v = localStorage.getItem(`ss.${k}`);
      return v == null ? d : JSON.parse(v);
    } catch {
      return d;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem(`ss.${k}`, JSON.stringify(v));
    } catch {
      /* private mode */
    }
  },
};

const MAX_BYTES = 2 * 1024 * 1024;
const DEBUG = new URLSearchParams(location.search).get('phone');
const KIND_ICON = { [KIND.TEXT]: 'text', [KIND.CONTACT]: 'me', [KIND.FILE]: 'file', [KIND.WIFI]: 'wifi' };

const state = {
  profile: store.get('profile', 'fast'),
  io: null,
  link: null,
  view: null, // what the stage is showing: { dir: 'tx' | 'rx', id }
  hiddenRx: 0, // an incoming transfer the user dismissed from the screen
  inbox: [],
  draft: '',
};

const orb = new Orb($('#orb'));
const waterfall = new Waterfall($('#waterfall'));

// ------------------------------------------------------------- helpers --

function fmtBytes(n) {
  if (n < 1000) return `${n} B`;
  if (n < 1e6) return `${(n / 1024).toFixed(n < 1e4 ? 1 : 0)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
}

function fmtTime(s) {
  s = Math.max(1, Math.round(s));
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  return `${Math.floor(s / 3600)} h ${Math.round((s % 3600) / 60)} min`;
}

const eta = (bytes) => `${fmtBytes(bytes)} · ~${fmtTime(estimate(state.profile, bytes))}`;

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 1800);
}

function buzz(p) {
  try {
    navigator.vibrate && navigator.vibrate(p);
  } catch {
    /* no haptics */
  }
}

async function copy(str) {
  try {
    await navigator.clipboard.writeText(str);
  } catch {
    const ta = Object.assign(document.createElement('textarea'), { value: str });
    document.body.append(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
  toast('Copied');
}

function download(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

async function share(data) {
  try {
    await navigator.share(data);
  } catch (e) {
    if (e.name !== 'AbortError') toast("Can't share that here");
  }
}

const canShareFiles = (files) => !!(navigator.canShare && navigator.canShare({ files }));

const URL_RE = /\b(?:https?:\/\/|www\.)[^\s<>"']+[^\s<>"'.,;:!?)\]]/gi;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_RE = /^\+?[\d\s().-]{7,}$/;

function linkify(str) {
  return esc(str).replace(URL_RE, (u) => `<a href="${/^www\./i.test(u) ? 'https://' : ''}${u}" target="_blank" rel="noopener">${u}</a>`);
}

// -------------------------------------------------------------- sheets --

const sheet = $('#sheet');

// Each sheet gets a fresh container so listeners never outlive their sheet.
function openSheet(html) {
  const old = $('#sheet-body');
  const body = old.cloneNode(false);
  body.innerHTML = html;
  old.replaceWith(body);
  sheet.hidden = false;
  return body;
}

function closeSheet() {
  sheet.hidden = true;
  $('#sheet-body').innerHTML = '';
}

sheet.addEventListener('click', (e) => {
  if (e.target === sheet || e.target.closest('[data-close]')) closeSheet();
});

// Wire up [data-do] buttons inside a sheet to handlers.
function bind(root, handlers) {
  root.addEventListener('click', (e) => {
    const b = e.target.closest('[data-do]');
    if (b && handlers[b.dataset.do]) handlers[b.dataset.do](b);
  });
}

function sendButton(label = 'Send') {
  return `<div class="meta" id="est"></div><button class="primary" data-do="send" type="button">${icon('send')}${label}</button>`;
}

// ------------------------------------------------------------ composing --

function composeText(initial = state.draft, title = 'Text') {
  const root = openSheet(`
    <h2>${icon('text')}${esc(title)}</h2>
    <textarea id="t" rows="6" placeholder="Type or paste…" autocomplete="off"></textarea>
    ${sendButton()}`);
  const t = $('#t', root);
  t.value = initial;
  const upd = () => {
    state.draft = t.value;
    $('#est', root).textContent = t.value ? eta(utf8(t.value).length) : '';
    $('[data-do=send]', root).disabled = !t.value.trim();
  };
  t.addEventListener('input', upd);
  upd();
  if (!initial) setTimeout(() => t.focus(), 50);
  bind(root, {
    send: () => {
      const v = t.value;
      state.draft = '';
      send({ kind: KIND.TEXT, body: utf8(v) }, v.length > 40 ? `${v.slice(0, 40)}…` : v);
    },
  });
}

function cardHtml(c) {
  const rows = [
    ...c.tel.map((v) => [icon('phone'), v]),
    ...c.email.map((v) => [icon('mail'), v]),
    ...c.url.map((v) => [icon('open'), v]),
  ];
  return `<div class="card"><div class="name">${esc(c.name || 'No name')}</div>${c.org ? `<div class="line">${esc(c.org)}</div>` : ''}${rows.map(([i, v]) => `<div class="line">${i}${esc(v)}</div>`).join('')}${c.note ? `<div class="line">${esc(c.note)}</div>` : ''}</div>`;
}

async function shrinkImage(file, budget = 10000) {
  const bmp = await createImageBitmap(file);
  const canvas = document.createElement('canvas');
  const g = canvas.getContext('2d');
  let type = 'image/webp';
  let best = null;
  for (const max of [800, 640, 480, 360, 280, 200]) {
    const s = Math.min(1, max / Math.max(bmp.width, bmp.height));
    canvas.width = Math.max(1, Math.round(bmp.width * s));
    canvas.height = Math.max(1, Math.round(bmp.height * s));
    g.drawImage(bmp, 0, 0, canvas.width, canvas.height);
    for (const q of [0.7, 0.5, 0.35]) {
      let blob = await new Promise((r) => canvas.toBlob(r, type, q));
      if (blob && blob.type !== type) {
        type = 'image/jpeg';
        blob = await new Promise((r) => canvas.toBlob(r, type, q));
      }
      if (blob && (!best || blob.size < best.size)) best = blob;
      if (blob && blob.size <= budget) return blob;
    }
  }
  return best;
}

async function composeFile(file) {
  if (!file) return;
  const isImage = /^image\//.test(file.type);
  const url = isImage ? URL.createObjectURL(file) : null;
  const root = openSheet(`<h2>${icon(isImage ? 'image' : 'file')}${isImage ? 'Photo' : 'File'}</h2>
    <div class="preview">${url ? `<img src="${url}" alt="">` : `<div class="fi">${icon('file')}</div>`}
      <div><div class="nm">${esc(file.name || 'file')}</div><div class="sz">${fmtBytes(file.size)}</div></div></div>
    <div id="sizes"></div>
    ${sendButton()}`);
  let chosen = file;
  const upd = () => {
    const est = estimate(state.profile, chosen.size);
    const m = $('#est', root);
    m.textContent = chosen.size > MAX_BYTES ? 'Too big to send by sound' : eta(chosen.size);
    m.classList.toggle('warn', est > 300 || chosen.size > MAX_BYTES);
    $('[data-do=send]', root).disabled = chosen.size > MAX_BYTES;
  };
  upd();
  if (isImage && file.size > 20000) {
    try {
      const small = await shrinkImage(file);
      if (small && small.size < file.size) {
        const ext = small.type === 'image/webp' ? 'webp' : 'jpg';
        const smallFile = new File([small], `${(file.name || 'photo').replace(/\.[^.]+$/, '')}.${ext}`, { type: small.type });
        chosen = smallFile;
        const seg = $('#sizes', root);
        const label = (f) => `${fmtBytes(f.size)} · ${fmtTime(estimate(state.profile, f.size))}`;
        seg.innerHTML = `<div class="seg"><button type="button" class="on" data-do="small">Small · ${label(smallFile)}</button><button type="button" data-do="orig">Original · ${label(file)}</button></div>`;
        const pick = (f, which) => {
          chosen = f;
          seg.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.do === which));
          upd();
        };
        bind(seg, { small: () => pick(smallFile, 'small'), orig: () => pick(file, 'orig') });
        upd();
        $('#est', root).hidden = true;
      }
    } catch {
      /* can't decode it here (HEIC on some browsers); send the original */
    }
  }
  bind(root, {
    send: async () => {
      const body = new Uint8Array(await chosen.arrayBuffer());
      if (url) URL.revokeObjectURL(url);
      send({ kind: KIND.FILE, name: chosen.name || 'file', mime: chosen.type || 'application/octet-stream', body }, chosen.name || 'file');
    },
  });
}

async function pasteFlow() {
  try {
    if (navigator.clipboard && navigator.clipboard.read) {
      const items = await navigator.clipboard.read();
      for (const it of items) {
        const img = it.types.find((t) => t.startsWith('image/'));
        if (img) {
          const blob = await it.getType(img);
          return composeFile(new File([blob], `pasted.${img.split('/')[1] || 'png'}`, { type: img }));
        }
        if (it.types.includes('text/plain')) {
          const t = await (await it.getType('text/plain')).text();
          if (t) return composeText(t, 'Paste');
        }
      }
    }
    const t = await navigator.clipboard.readText();
    if (t) return composeText(t, 'Paste');
    toast('Clipboard is empty');
  } catch {
    composeText('', 'Paste');
  }
}

// --------------------------------------------------------------- stage --

const stageIcon = $('#stage-icon');

function setIcon(id, cls = '') {
  stageIcon.innerHTML = `<use href="#i-${id}"/>`;
  stageIcon.setAttribute('class', `ico big ${cls}`);
  stageIcon.style.display = id ? '' : 'none';
}

function idleStage() {
  const cold = !state.io; // audio hasn't started yet: the orb is the call to action
  const off = state.io && !state.io.mic;
  document.body.classList.remove('busy');
  state.view = null;
  orb.set(cold || off ? 'off' : 'idle');
  setIcon(cold ? 'mic' : off ? 'micoff' : 'ear', cold ? 'cta' : off ? 'off' : '');
  $('#stage').classList.toggle('cold', cold);
  $('#stage-cta').hidden = !cold;
  $('#pct').textContent = '';
  $('#sub').textContent = cold ? 'Tap to enable microphone' : off ? 'mic off · send only' : 'listening';
  $('#what').innerHTML = '';
}

function showStage(dir, id, total, what) {
  closeSheet();
  state.view = { dir, id };
  document.body.classList.add('busy');
  orb.set(dir, total, true);
  setIcon('', '');
  stageIcon.style.display = 'none';
  $('#pct').textContent = '0%';
  $('#sub').textContent = dir === 'tx' ? 'sending' : 'receiving';
  live.frame = null;
  $('#what').innerHTML = what;
  $('#stage-close').setAttribute('aria-label', dir === 'tx' ? 'Cancel' : 'Hide');
}

function endStage(ok, sub, after = 1600) {
  if (state.view) state.view.final = true;
  orb.done(ok);
  $('#pct').textContent = '';
  setIcon(ok ? 'check' : 'x', ok ? 'ok' : 'bad');
  $('#sub').textContent = sub;
  const view = state.view;
  setTimeout(() => {
    if (state.view === view) idleStage();
  }, after);
}

$('#stage-close').addEventListener('click', () => {
  const v = state.view;
  if (v && v.dir === 'tx' && state.link.tx) state.link.tx.cancel();
  else {
    if (v && v.dir === 'rx') state.hiddenRx = v.id;
    idleStage();
  }
});

// ------------------------------------------------------------- sending --

async function send(msg, label) {
  if (!(await ensureStarted())) return;
  if (state.link.tx) return toast('Already sending');
  closeSheet();
  const bytes = await pack(msg);
  if (bytes.length > MAX_BYTES) return toast('Too big to send by sound');
  const tx = state.link.send(bytes, { profile: state.profile });
  showStage('tx', tx, tx.total, `${icon(KIND_ICON[msg.kind])}<span>${esc(label)}</span>`);
  if (!store.get('hinted', false)) {
    store.set('hinted', true);
    toast('Volume up · phones close together');
  }
  wakeLock();
  const result = await tx.promise;
  if (result === 'done') {
    buzz(40);
    endStage(true, `delivered · ${fmtTime((tx.finished - tx.started))}`, 2200);
  } else if (result === 'unconfirmed') endStage(true, 'sent · no reply heard', 2600);
  else if (result === 'lost') endStage(false, 'lost the other phone', 2600);
  else endStage(false, 'cancelled', 1200);
}

const live = { frame: null, rxFrac: 0, rxAt: 0 }; // the frame on air right now

function onTx(tx) {
  const v = state.view;
  if (!v || v.dir !== 'tx' || v.id !== tx) return;
  if (orb.total !== tx.total) orb.set('tx', tx.total, true); // restarted in slow mode
  let sent = 0;
  for (let i = 0; i < tx.total; i++) {
    orb.states[i] = tx.acked[i] ? 3 : i === tx.current ? 1 : tx.sends[i] ? 2 : 0;
    if ((tx.sends[i] || tx.acked[i]) && i !== tx.current) sent++;
  }
  v.base = sent;
  if (tx.state === 'done' || tx.state === 'unconfirmed' || tx.state === 'lost' || tx.state === 'cancelled') return;
  const label = { sending: tx.fellBack ? 'sending slowly' : 'sending', waiting: 'listening for reply', polling: 'asking for reply', yielding: 'waiting for quiet', slower: 'no luck · trying slow' }[tx.state] || tx.state;
  const left = tx.bytes * (1 - sent / tx.total);
  $('#sub').textContent = tx.state === 'sending' && left > 0 ? `${label} · ${fmtTime(estimate(tx.profile, left))} left` : label;
}

// Smooth percentages: interpolate through the frame currently on the air.
function tick() {
  requestAnimationFrame(tick);
  const v = state.view;
  if (!v || v.final || !state.io) return;
  let p = null;
  if (v.dir === 'tx' && typeof v.id === 'object') {
    const tx = v.id;
    let frac = 0;
    const f = live.frame;
    if (tx.state === 'sending' && tx.current >= 0 && f) frac = Math.max(0, Math.min(1, (state.io.ctx.currentTime - f.t0) / (f.t1 - f.t0)));
    p = ((v.base || 0) + frac) / tx.total;
  } else if (v.dir === 'rx') {
    const recent = performance.now() - live.rxAt < 400 && live.rxFrac < 1;
    p = ((v.got || 0) + (recent ? live.rxFrac : 0)) / (v.total || 1);
  }
  if (p != null) {
    orb.progress = p;
    $('#pct').textContent = `${Math.min(99, Math.floor(p * 100))}%`;
  }
}
requestAnimationFrame(tick);

// ----------------------------------------------------------- receiving --

function rxWhat(rx) {
  const first = rx.chunks[0];
  const h = first && peek(first);
  if (!h) return `${icon('ear')}<span>incoming</span>`;
  const label = h.kind === KIND.FILE ? h.name : { [KIND.TEXT]: 'Text', [KIND.CONTACT]: h.name || 'Contact', [KIND.WIFI]: 'Wi‑Fi' }[h.kind] || 'Something';
  return `${icon(KIND_ICON[h.kind] || 'file')}<span>${esc(label)}</span>`;
}

function onRx(rx) {
  if (state.link.tx) return; // our own send owns the screen; results still pop up
  const v = state.view;
  if (v && v.dir === 'rx' && v.id === 'heard') {
    // the frame we started showing turned out to be the start of this transfer
    v.id = rx.sid;
    orb.set('rx', rx.total, true);
  } else if (!v || v.dir !== 'rx' || v.id !== rx.sid) {
    if (state.hiddenRx === rx.sid) return;
    showStage('rx', rx.sid, rx.total, rxWhat(rx));
    wakeLock();
  }
  const view = state.view;
  view.got = rx.got;
  view.total = rx.total;
  for (let i = 0; i < rx.total; i++) orb.states[i] = rx.have[i] ? 3 : 0;
  orb.spark(18);
  $('#what').innerHTML = rxWhat(rx);
  if (!rx.done) $('#sub').textContent = rx.total > 1 ? `${rx.got} / ${rx.total}` : 'receiving';
}

// A frame header was heard. If nothing else is going on, start showing it
// right away; the first DATA frame will tell us what it is.
let heardTimer;
function onHeard(info) {
  const v = state.view;
  if (state.link.tx || (v && v.dir === 'tx')) return;
  if (!v) {
    orb.spark(10);
    if (info.bytes < 50) {
      $('#sub').textContent = 'hearing something…';
      clearTimeout(heardTimer);
      heardTimer = setTimeout(() => !state.view && idleStage(), 2500);
      return;
    }
    showStage('rx', 'heard', 1, `${icon('ear')}<span>incoming</span>`);
    state.view.total = 1;
  }
  if (state.view.id === 'heard') {
    const view = state.view;
    clearTimeout(heardTimer);
    heardTimer = setTimeout(() => state.view === view && idleStage(), (info.end - info.pos) / state.io.ctx.sampleRate * 1000 + 2500);
  }
}

const seen = new Map(); // content key -> time, so a resend isn't shown twice

async function onRxDone(rx) {
  const key = `${rx.bytes.length}:${crc32(rx.bytes)}`;
  const mine = state.view && state.view.dir === 'rx' && state.view.id === rx.sid;
  if (Date.now() - (seen.get(key) || 0) < 5 * 60000) {
    if (mine) endStage(true, 'already received', 900);
    return;
  }
  seen.set(key, Date.now());
  let msg;
  try {
    msg = await unpack(rx.bytes);
  } catch {
    return;
  }
  const item = { ...msg, at: Date.now(), id: `${rx.sid}-${Date.now()}` };
  buzz([30, 50, 30]);
  if (mine) {
    endStage(true, 'received · verified', 700);
    setTimeout(() => showItem(item), 650);
  } else if (!state.link.tx) showItem(item);
  else toast('Received something');
  addToInbox(item);
}

function onRxFail(rx) {
  const v = state.view;
  if (v && v.dir === 'rx' && v.id === rx.sid) endStage(false, rx.state === 'cancelled' ? 'sender cancelled' : 'lost the signal', 1800);
}

// ---------------------------------------------------------- showing items --

function itemTitle(it) {
  if (it.kind === KIND.TEXT) return text(it.body).slice(0, 80);
  if (it.kind === KIND.CONTACT) return parseVCard(text(it.body)).name || 'Contact';
  if (it.kind === KIND.WIFI) return (parseWifi(text(it.body)) || {}).ssid || 'Wi‑Fi';
  return it.name || 'File';
}

function showItem(it) {
  if (it.kind === KIND.TEXT) {
    const t = text(it.body);
    const url = (t.match(URL_RE) || [])[0];
    const trimmed = t.trim();
    const root = openSheet(`<h2>${icon('text')}Text</h2><div class="textbox">${linkify(t)}</div>
      <div class="btns"><button class="main" type="button" data-do="copy">${icon('copy')}Copy</button>
      ${url ? `<button type="button" data-do="open">${icon('open')}Open</button>` : ''}
      ${PHONE_RE.test(trimmed) ? `<button type="button" data-do="call">${icon('phone')}Call</button>` : ''}
      ${EMAIL_RE.test(trimmed) ? `<button type="button" data-do="mail">${icon('mail')}Email</button>` : ''}
      ${navigator.share ? `<button type="button" data-do="share">${icon('share')}Share</button>` : ''}</div>`);
    bind(root, {
      copy: () => copy(t),
      open: () => window.open(/^www\./i.test(url) ? `https://${url}` : url, '_blank', 'noopener'),
      call: () => (location.href = `tel:${trimmed.replace(/[^\d+]/g, '')}`),
      mail: () => (location.href = `mailto:${trimmed}`),
      share: () => share({ text: t }),
    });
  } else if (it.kind === KIND.CONTACT) {
    const vcf = text(it.body);
    const c = parseVCard(vcf);
    const file = new File([vcf], `${(c.name || 'contact').replace(/[^\w -]+/g, '')}.vcf`, { type: 'text/vcard' });
    const root = openSheet(`<h2>${icon('me')}Contact</h2>${cardHtml(c)}
      <div class="btns"><button class="main" type="button" data-do="save">${icon('addcontact')}Save</button>
      ${c.tel[0] ? `<button type="button" data-do="call">${icon('phone')}Call</button>` : ''}
      ${c.email[0] ? `<button type="button" data-do="mail">${icon('mail')}Email</button>` : ''}
      ${canShareFiles([file]) ? `<button type="button" data-do="share">${icon('share')}Share</button>` : ''}
      <button type="button" data-do="copy">${icon('copy')}Copy</button></div>`);
    bind(root, {
      save: () => download(file, file.name),
      call: () => (location.href = `tel:${c.tel[0].replace(/[^\d+]/g, '')}`),
      mail: () => (location.href = `mailto:${c.email[0]}`),
      share: () => share({ files: [file] }),
      copy: () => copy([c.name, ...c.tel, ...c.email, ...c.url].filter(Boolean).join('\n')),
    });
  } else if (it.kind === KIND.WIFI) {
    const w = parseWifi(text(it.body)) || { ssid: '', password: '' };
    const root = openSheet(`<h2>${icon('wifi')}Wi‑Fi</h2><div class="card">
      <div class="label">Network</div><div class="name">${esc(w.ssid)}</div>
      ${w.password ? `<div class="label">Password</div><div class="secret">${esc(w.password)}</div>` : '<div class="label">Open network</div>'}</div>
      <div class="btns">${w.password ? `<button class="main" type="button" data-do="pass">${icon('copy')}Copy password</button>` : ''}
      <button type="button" data-do="ssid">${icon('copy')}Copy name</button></div>`);
    bind(root, { pass: () => copy(w.password), ssid: () => copy(w.ssid) });
  } else {
    const file = new File([it.body], it.name || 'file', { type: it.mime || 'application/octet-stream' });
    const url = URL.createObjectURL(file);
    const isImage = /^image\//.test(file.type);
    const root = openSheet(`<h2>${icon(isImage ? 'image' : 'file')}${isImage ? 'Photo' : 'File'}</h2>
      ${isImage ? `<img class="full-img" src="${url}" alt="">` : ''}
      <div class="preview" style="margin-top:12px">${isImage ? '' : `<div class="fi">${icon('file')}</div>`}
        <div><div class="nm">${esc(file.name)}</div><div class="sz">${fmtBytes(file.size)}</div></div></div>
      <div class="btns"><button class="main" type="button" data-do="save">${icon('save')}Save</button>
      ${canShareFiles([file]) ? `<button type="button" data-do="share">${icon('share')}Share</button>` : ''}
      <button type="button" data-do="open">${icon('open')}Open</button></div>`);
    bind(root, {
      save: () => download(file, file.name),
      share: () => share({ files: [file] }),
      open: () => window.open(url, '_blank', 'noopener'),
    });
  }
}

function addToInbox(item) {
  state.inbox.unshift(item);
  state.inbox = state.inbox.slice(0, 40);
  const keep = state.inbox
    .filter((i) => i.kind !== KIND.FILE && i.body.length < 20000)
    .slice(0, 30)
    .map((i) => ({ kind: i.kind, name: i.name, at: i.at, body: text(i.body) }));
  store.set('inbox', keep);
  renderInbox();
}

function renderInbox() {
  const box = $('#inbox');
  if (!state.inbox.length) {
    box.innerHTML = '';
    return;
  }
  const when = (t) => {
    const d = new Date(t);
    return Date.now() - t < 86400000 ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  };
  box.innerHTML = `<h3>Received</h3>${state.inbox
    .map((it, i) => `<button type="button" class="item" data-i="${i}">${icon(KIND_ICON[it.kind] || 'file')}<span class="t">${esc(itemTitle(it))}</span><span class="when">${when(it.at)}</span></button>`)
    .join('')}`;
}

$('#inbox').addEventListener('click', (e) => {
  const b = e.target.closest('[data-i]');
  if (b) showItem(state.inbox[+b.dataset.i]);
});

// ------------------------------------------------------------- settings --

function renderSpeed() {
  const fast = state.profile === 'fast';
  const chip = $('#speed');
  chip.classList.toggle('slow', !fast);
  chip.innerHTML = `${icon(fast ? 'fast' : 'slow')}<span>${fast ? 'Fast' : 'Slow'}</span>`;
}

$('#speed').addEventListener('click', () => {
  state.profile = state.profile === 'fast' ? 'slow' : 'fast';
  store.set('profile', state.profile);
  renderSpeed();
  toast(state.profile === 'fast' ? 'Fast · phones side by side' : 'Slow · more range, noisy rooms');
});

// ---------------------------------------------------------------- start --

let lock = null;
async function wakeLock() {
  try {
    if ('wakeLock' in navigator && !lock && document.visibilityState === 'visible') {
      lock = await navigator.wakeLock.request('screen');
      lock.addEventListener('release', () => (lock = null));
    }
  } catch {
    /* not allowed right now */
  }
}
document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && wakeLock());

// Audio (and the mic prompt) starts on the first action, not on page load, so
// nobody is asked for the microphone before they know what the page is.
let starting = null;
function ensureStarted() {
  if (state.link) return Promise.resolve(true);
  return (starting ||= start().then((ok) => {
    if (!ok) starting = null;
    return ok;
  }));
}

async function start() {
  const io = new AudioIO();
  try {
    await io.start();
  } catch (e) {
    toast(`Audio unavailable: ${e.message}`);
    return false;
  }
  state.io = io;
  orb.analyser = waterfall.analyser = io.analyser;
  const link = (state.link = new Link(new AudioPhy(io)));
  link.on('tx', onTx);
  link.on('rx-start', onRx);
  link.on('rx-progress', onRx);
  link.on('rx-done', (rx) => {
    onRx(rx);
    onRxDone(rx);
  });
  link.on('rx-fail', onRxFail);
  io.on('tx', (f) => {
    live.frame = f;
    orb.spark();
  });
  io.on('detect', onHeard);
  io.on('progress', (info) => {
    live.rxFrac = info.symbols / info.totalSymbols;
    live.rxAt = performance.now();
  });
  if (DEBUG) {
    // the two-phone harness: narrate what each phone does in the console
    const log = (...a) => console.log(`[${DEBUG}]`, ...a);
    for (const t of ['detect', 'fail']) io.on(t, (i) => log(t, i.profile, i.bytes, i.why || ''));
    io.on('frame', (p, b, i) => log('frame', p, b.length, 'fixed', i.corrected));
    io.on('tx', (t) => log('play', t.profile, t.bytes));
    link.on('tx', (tx) => log('tx', tx.state, tx.profile, `${tx.ackedCount}/${tx.total}`));
    link.on('rx-progress', (rx) => log('rx', `${rx.got}/${rx.total}`));
    log('sample rate', io.ctx.sampleRate, 'mic', io.mic);
  }
  idleStage();
  if (!io.mic) toast('Microphone blocked · you can still send');
  wakeLock();
  return true;
}

$('#stage-cta').addEventListener('click', ensureStarted);

$('#actions').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-act]');
  if (!b) return;
  const act = b.dataset.act;
  if (!(await ensureStarted())) return;
  if (act === 'text') composeText();
  else if (act === 'paste') pasteFlow();
  else if (act === 'file') $('#file').click();
});

$('#file').addEventListener('change', (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  composeFile(f);
});

// Android share sheet → Sound Send (see manifest share_target and sw.js).
async function handleIncomingShare() {
  const q = new URLSearchParams(location.search);
  if (q.has('share') && 'caches' in window) {
    try {
      const cache = await caches.open('ss-share');
      const meta = await cache.match('meta');
      if (meta) {
        const { files = [], text: t = '' } = await meta.json();
        if (files.length) {
          const r = await cache.match('file-0');
          const blob = await r.blob();
          composeFile(new File([blob], files[0].name, { type: files[0].type }));
        } else if (t) composeText(t);
        await caches.delete('ss-share');
      }
    } catch {
      /* nothing shared */
    }
  }
  const shared = [q.get('title'), q.get('text'), q.get('url')].filter(Boolean).join('\n');
  if (shared) composeText(shared);
  if (q.toString()) history.replaceState(null, '', location.pathname + (q.get('phone') ? `?phone=${q.get('phone')}` : ''));
}

state.inbox = store.get('inbox', []).map((i) => ({ ...i, body: utf8(i.body) }));
renderInbox();
renderSpeed();
idleStage();
handleIncomingShare();

const inHarness = window.parent !== window;
if ('serviceWorker' in navigator && !inHarness && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
