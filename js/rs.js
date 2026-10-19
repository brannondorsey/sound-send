// Reed-Solomon over GF(256) (primitive polynomial 0x11d, first root alpha^0),
// with errors-and-erasures decoding. Polynomials are plain arrays, highest
// degree first. Adapted from the "Reed-Solomon codes for coders" reference.

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
}

const mul = (a, b) => (a && b ? EXP[LOG[a] + LOG[b]] : 0);
const div = (a, b) => (a ? EXP[(LOG[a] + 255 - LOG[b]) % 255] : 0);
const alpha = (p) => EXP[((p % 255) + 255) % 255];
const inverse = (a) => EXP[255 - LOG[a]];

const polyScale = (p, s) => p.map((c) => mul(c, s));

function polyAdd(p, q) {
  const r = new Array(Math.max(p.length, q.length)).fill(0);
  for (let i = 0; i < p.length; i++) r[i + r.length - p.length] = p[i];
  for (let i = 0; i < q.length; i++) r[i + r.length - q.length] ^= q[i];
  return r;
}

function polyMul(p, q) {
  const r = new Array(p.length + q.length - 1).fill(0);
  for (let j = 0; j < q.length; j++) {
    if (!q[j]) continue;
    for (let i = 0; i < p.length; i++) r[i + j] ^= mul(p[i], q[j]);
  }
  return r;
}

function polyEval(p, x) {
  let y = p[0];
  for (let i = 1; i < p.length; i++) y = mul(y, x) ^ p[i];
  return y;
}

const generators = new Map();
function generator(nsym) {
  let g = generators.get(nsym);
  if (!g) {
    g = [1];
    for (let i = 0; i < nsym; i++) g = polyMul(g, [1, EXP[i]]);
    generators.set(nsym, g);
  }
  return g;
}

/** Systematic encode: returns msg followed by nsym parity bytes. */
export function rsEncode(msg, nsym) {
  if (msg.length + nsym > 255) throw new RangeError('codeword longer than 255');
  const gen = generator(nsym);
  const out = new Uint8Array(msg.length + nsym);
  out.set(msg);
  for (let i = 0; i < msg.length; i++) {
    const coef = out[i];
    if (coef) for (let j = 1; j < gen.length; j++) out[i + j] ^= mul(gen[j], coef);
  }
  out.set(msg);
  return out;
}

function syndromes(msg, nsym) {
  const s = [0];
  for (let i = 0; i < nsym; i++) s.push(polyEval(msg, EXP[i]));
  return s;
}

function errataLocator(coefPos) {
  let loc = [1];
  for (const p of coefPos) loc = polyMul(loc, polyAdd([1], [alpha(p), 0]));
  return loc;
}

function errorEvaluator(synd, errLoc, nsym) {
  const prod = polyMul(synd, errLoc);
  return prod.slice(prod.length - (nsym + 1));
}

function correctErrata(msg, synd, errPos) {
  const coefPos = errPos.map((p) => msg.length - 1 - p);
  const errLoc = errataLocator(coefPos);
  const errEval = errorEvaluator(synd.slice().reverse(), errLoc, errLoc.length - 1).reverse();
  const X = coefPos.map((c) => alpha(c));
  const E = new Array(msg.length).fill(0);
  for (let i = 0; i < X.length; i++) {
    const xiInv = inverse(X[i]);
    let prime = 1;
    for (let j = 0; j < X.length; j++) if (j !== i) prime = mul(prime, 1 ^ mul(xiInv, X[j]));
    if (prime === 0) return null;
    const y = mul(X[i], polyEval(errEval.slice().reverse(), xiInv));
    E[errPos[i]] = div(y, prime);
  }
  return polyAdd(msg, E);
}

function errorLocator(synd, nsym, eraseCount) {
  let errLoc = [1];
  let oldLoc = [1];
  for (let i = 0; i < nsym - eraseCount; i++) {
    const K = i;
    let delta = synd[K];
    for (let j = 1; j < errLoc.length; j++) delta ^= mul(errLoc[errLoc.length - 1 - j], synd[K - j]);
    oldLoc = oldLoc.concat([0]);
    if (delta) {
      if (oldLoc.length > errLoc.length) {
        const newLoc = polyScale(oldLoc, delta);
        oldLoc = polyScale(errLoc, inverse(delta));
        errLoc = newLoc;
      }
      errLoc = polyAdd(errLoc, polyScale(oldLoc, delta));
    }
  }
  while (errLoc.length && errLoc[0] === 0) errLoc.shift();
  const errs = errLoc.length - 1;
  if ((errs - eraseCount) * 2 + eraseCount > nsym) return null;
  return errLoc;
}

function findErrors(errLoc, n) {
  const errs = errLoc.length - 1;
  const pos = [];
  for (let i = 0; i < n; i++) if (polyEval(errLoc, alpha(i)) === 0) pos.push(n - 1 - i);
  return pos.length === errs ? pos : null;
}

function forneySyndromes(synd, erasePos, n) {
  const f = synd.slice(1);
  for (const p of erasePos) {
    const x = alpha(n - 1 - p);
    for (let j = 0; j < f.length - 1; j++) f[j] = mul(f[j], x) ^ f[j + 1];
  }
  return f;
}

/**
 * Decode a codeword in place of errors and erasures. Returns
 * { data, corrected } or null when the codeword is beyond repair.
 */
export function rsDecode(codeword, nsym, erasePos = []) {
  const n = codeword.length;
  if (n > 255 || erasePos.length > nsym) return null;
  let msg = Array.from(codeword);
  for (const p of erasePos) msg[p] = 0;
  let synd = syndromes(msg, nsym);
  let corrected = 0;
  if (synd.some((s) => s !== 0)) {
    const fsynd = forneySyndromes(synd, erasePos, n);
    const errLoc = errorLocator(fsynd, nsym, erasePos.length);
    if (!errLoc) return null;
    const errPos = findErrors(errLoc.slice().reverse(), n);
    if (!errPos) return null;
    const all = erasePos.concat(errPos);
    const fixed = correctErrata(msg, synd, all);
    if (!fixed) return null;
    msg = fixed;
    synd = syndromes(msg, nsym);
    if (synd.some((s) => s !== 0)) return null;
    for (let i = 0; i < n; i++) if (msg[i] !== codeword[i]) corrected++;
  }
  return { data: Uint8Array.from(msg.slice(0, n - nsym)), corrected };
}
