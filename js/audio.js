// Web Audio glue: microphone capture into the DSP worker, frame playback, and
// the "phy" the link layer talks to.
import { modulate, Demodulator, PROFILES, LEAD_SECONDS } from './modem.js';

// The two-phone test page wires phones together through virtual air.
const harness = (() => {
  try {
    return window.parent !== window ? window.parent.SS_HARNESS || null : null;
  } catch {
    return null;
  }
})();
const phoneId = new URLSearchParams(location.search).get('phone');

export class AudioIO {
  constructor() {
    this.ctx = null;
    this.mic = false;
    this.micError = null;
    this.playingUntil = 0;
    this.rxBusy = false;
    this.handlers = {};
  }

  on(type, fn) {
    (this.handlers[type] ||= []).push(fn);
    return this;
  }

  emit(type, ...args) {
    for (const fn of this.handlers[type] || []) fn(...args);
  }

  /** Call from a user gesture. Resolves once audio runs (mic or not). */
  async start() {
    const AC = window.AudioContext || window.webkitAudioContext;
    const ctx = (this.ctx = new AC({ latencyHint: 'interactive' }));
    const resumed = ctx.resume();
    this.out = ctx.createGain();
    this.out.connect(ctx.destination);
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 2048;
    this.analyser.smoothingTimeConstant = 0.55;
    if (harness) harness.tap(phoneId, ctx, this.out);
    try {
      const stream = harness
        ? await harness.getUserMedia(phoneId)
        : await navigator.mediaDevices.getUserMedia({
            audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 },
          });
      const src = ctx.createMediaStreamSource(stream);
      src.connect(this.analyser);
      await this.capture(src);
      this.mic = true;
    } catch (e) {
      this.micError = e;
      this.out.connect(this.analyser);
    }
    await resumed;
    document.addEventListener('visibilitychange', () => !document.hidden && this.resume());
  }

  async capture(src) {
    const ctx = this.ctx;
    const sink = ctx.createGain();
    sink.gain.value = 0;
    sink.connect(ctx.destination);
    try {
      await ctx.audioWorklet.addModule(new URL('./capture-worklet.js', import.meta.url));
      const node = new AudioWorkletNode(ctx, 'ss-capture', {
        numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1], channelCount: 1, channelCountMode: 'explicit',
      });
      const worker = new Worker(new URL('./dsp-worker.js', import.meta.url), { type: 'module' });
      const ch = new MessageChannel();
      node.port.postMessage({ port: ch.port1 }, [ch.port1]);
      worker.postMessage({ type: 'init', sr: ctx.sampleRate, port: ch.port2 }, [ch.port2]);
      worker.onmessage = (e) => this.dsp(e.data);
      this.deafen = (from, to) => worker.postMessage({ type: 'deaf', from, to });
      src.connect(node);
      node.connect(sink);
    } catch (e) {
      // Old browsers: ScriptProcessor and the demodulator on this thread.
      console.warn('Sound Send: demodulating on the main thread', e);
      const demod = new Demodulator(ctx.sampleRate);
      let anchor = { t: 0, n: 0 };
      demod.onDetect = (info) => this.dsp({ type: 'detect', info });
      demod.onProgress = (info) => this.dsp({ type: 'progress', info });
      demod.onFrame = (payload, info) => this.dsp({ type: 'frame', payload, info });
      demod.onFail = (info) => this.dsp({ type: 'fail', info });
      const node = ctx.createScriptProcessor(2048, 1, 1);
      node.onaudioprocess = (ev) => {
        anchor = { t: ev.playbackTime, n: demod.n };
        demod.push(ev.inputBuffer.getChannelData(0));
        this.rxBusy = demod.busy();
      };
      const idx = (t) => anchor.n + Math.round((t - anchor.t) * ctx.sampleRate);
      this.deafen = (from, to) => demod.addDeaf(idx(from), idx(to));
      src.connect(node);
      node.connect(sink);
    }
  }

  dsp(m) {
    if (m.type === 'busy') this.rxBusy = m.busy;
    else if (m.type === 'frame') this.emit('frame', m.info.profile, m.payload, m.info);
    else this.emit(m.type, m.info || m);
  }

  deafen() {}

  async resume() {
    if (this.ctx && this.ctx.state !== 'running') {
      try {
        await this.ctx.resume();
      } catch {
        /* needs a gesture; the next tap will do it */
      }
    }
  }

  outputLatency() {
    return this.ctx.outputLatency || this.ctx.baseLatency || 0.02;
  }

  play(samples) {
    const ctx = this.ctx;
    const buf = ctx.createBuffer(1, samples.length, ctx.sampleRate);
    buf.copyToChannel(samples, 0);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(this.out);
    const t0 = Math.max(ctx.currentTime + 0.04, this.playingUntil + 0.02);
    const t1 = t0 + samples.length / ctx.sampleRate;
    src.start(t0);
    src.onended = () => src.disconnect();
    this.playingUntil = t1;
    return { t0, t1 };
  }

  /** Resolve once the audio clock reaches t. */
  until(t) {
    return new Promise((resolve) => {
      const check = () => {
        const left = t - this.ctx.currentTime;
        if (left <= 0) return resolve();
        if (this.ctx.state !== 'running') this.resume();
        setTimeout(check, Math.max(20, Math.min(250, left * 1000)));
      };
      check();
    });
  }
}

/** What Link needs from the outside world. */
export class AudioPhy {
  constructor(io) {
    this.io = io;
    this.latency = 0.6;
    this.onFrame = null;
    io.on('frame', (profile, bytes, info) => this.onFrame && this.onFrame(profile, bytes, info));
  }

  async send(profile, bytes) {
    const io = this.io;
    await io.resume();
    const { t0, t1 } = io.play(modulate(profile, bytes, io.ctx.sampleRate));
    const lat = io.outputLatency();
    // Only a chirp can start a frame, so ignore syncs around our own chirp
    // (plus its echo); the other phone may answer right after we stop.
    io.deafen(t0 - 0.05, t0 + LEAD_SECONDS + PROFILES[profile].chirp[2] + lat + 0.25);
    io.emit('tx', { profile, t0, t1, bytes: bytes.length });
    await io.until(t1 + lat);
  }

  busy() {
    return this.io.rxBusy || this.io.ctx.currentTime < this.io.playingUntil;
  }
}
