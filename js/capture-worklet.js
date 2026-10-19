// Batches microphone samples and ships them, timestamped with the audio
// clock, straight to the DSP worker over a MessagePort.
class Capture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.size = 2048;
    this.buf = new Float32Array(this.size);
    this.n = 0;
    this.t = 0;
    this.out = null;
    this.port.onmessage = (e) => {
      if (e.data && e.data.port) this.out = e.data.port;
    };
  }

  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch && this.out) {
      let i = 0;
      while (i < ch.length) {
        if (this.n === 0) this.t = currentTime + i / sampleRate;
        const take = Math.min(ch.length - i, this.size - this.n);
        this.buf.set(ch.subarray(i, i + take), this.n);
        this.n += take;
        i += take;
        if (this.n === this.size) {
          this.out.postMessage({ t: this.t, s: this.buf }, [this.buf.buffer]);
          this.buf = new Float32Array(this.size);
          this.n = 0;
        }
      }
    }
    return true;
  }
}

registerProcessor('ss-capture', Capture);
