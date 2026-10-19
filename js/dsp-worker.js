// Runs the demodulator off the main thread. Samples arrive on a MessagePort
// from the capture worklet; events go back to the page.
import { Demodulator } from './modem.js';

let demod = null;
let anchor = { t: 0, n: 0 };
let busy = false;

const toIndex = (t) => anchor.n + Math.round((t - anchor.t) * demod.sr);

function reportBusy() {
  const b = demod.busy();
  if (b !== busy) {
    busy = b;
    postMessage({ type: 'busy', busy });
  }
}

function init(sr, port) {
  demod = new Demodulator(sr);
  demod.onDetect = (info) => postMessage({ type: 'detect', info });
  demod.onProgress = (info) => postMessage({ type: 'progress', info });
  demod.onFrame = (payload, info) => postMessage({ type: 'frame', payload, info }, [payload.buffer]);
  demod.onFail = (info) => postMessage({ type: 'fail', info });
  let tick = 0;
  port.onmessage = (e) => {
    const { t, s } = e.data;
    anchor = { t, n: demod.n };
    demod.push(s);
    reportBusy();
    if (++tick % 4 === 0) postMessage({ type: 'level', level: demod.level, time: t });
  };
}

onmessage = (e) => {
  const m = e.data;
  if (m.type === 'init') init(m.sr, m.port);
  else if (m.type === 'deaf' && demod) demod.addDeaf(toIndex(m.from), toIndex(m.to));
};
