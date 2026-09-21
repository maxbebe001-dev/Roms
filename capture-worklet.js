/* Spectator audio tap: mixes game output to mono, box-filters it down to the
 * stream rate and posts fixed-size Float32 blocks to the page. */
class GemuCaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const opts = (options && options.processorOptions) || {};
    this.rate = opts.rate || 11025;
    this.block = opts.block || 1024;
    this.step = sampleRate / this.rate;
    this.out = new Float32Array(this.block);
    this.count = 0;
    this.sum = 0;
    this.taken = 0;
    this.phase = 0;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || !input.length) return true;
    const left = input[0];
    const right = input.length > 1 ? input[1] : left;
    for (let i = 0; i < left.length; i++) {
      this.sum += (left[i] + right[i]) * 0.5;
      this.taken++;
      this.phase++;
      if (this.phase < this.step) continue;
      this.phase -= this.step;
      this.out[this.count++] = this.sum / this.taken;
      this.sum = 0;
      this.taken = 0;
      if (this.count === this.block) {
        const block = this.out;
        this.out = new Float32Array(this.block);
        this.count = 0;
        this.port.postMessage(block, [block.buffer]);
      }
    }
    return true;
  }
}

registerProcessor('gemu-capture', GemuCaptureProcessor);
