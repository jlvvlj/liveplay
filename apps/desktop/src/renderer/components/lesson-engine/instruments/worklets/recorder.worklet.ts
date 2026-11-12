// Records what comes into it: its input's two channels, sent on in blocks
// with the frame each block starts at, so a recording can be lined up with
// the notes played into it.

declare const currentFrame: number;
declare function registerProcessor(name: string, processor: unknown): void;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
}

const BLOCK = 4096;

class RecorderProcessor extends AudioWorkletProcessor {
  private left = new Float32Array(BLOCK);
  private right = new Float32Array(BLOCK);
  private filled = 0;
  private start = 0;

  process(inputs: Float32Array[][]): boolean {
    const input = inputs[0];
    const frames = input[0]?.length ?? 128;
    if (this.filled === 0) this.start = currentFrame;
    for (let i = 0; i < frames; i++) {
      this.left[this.filled + i] = input[0]?.[i] ?? 0;
      this.right[this.filled + i] = input[1]?.[i] ?? input[0]?.[i] ?? 0;
    }
    this.filled += frames;
    if (this.filled + frames > BLOCK) {
      this.port.postMessage({ start: this.start, channels: [this.left.slice(0, this.filled), this.right.slice(0, this.filled)] });
      this.filled = 0;
    }
    return true;
  }
}

registerProcessor('jam-recorder', RecorderProcessor);
