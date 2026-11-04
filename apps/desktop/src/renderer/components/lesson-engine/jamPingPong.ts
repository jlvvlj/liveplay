import * as Tone from 'tone';

// The Jam tab's echo, a stereo ping-pong as in Plink: both channels of the
// input feed the left delay, and each side's echo feeds the other side's
// delay, so the echoes alternate left and right, each `feedback` quieter. The
// input passes through at full level and the echoes are added at `wet`.
export class JamPingPong {
  readonly input = new Tone.Gain();
  readonly output = new Tone.Gain();
  private readonly split = new Tone.Split();
  private readonly left = new Tone.Delay(0.5, 4);
  private readonly right = new Tone.Delay(0.5, 4);
  private readonly leftToRight = new Tone.Gain(0.5);
  private readonly rightToLeft = new Tone.Gain(0.5);
  private readonly merge = new Tone.Merge();
  private readonly wetGain = new Tone.Gain(0.25);

  constructor() {
    this.input.connect(this.output);
    this.input.connect(this.split);
    this.split.connect(this.left, 0, 0);
    this.split.connect(this.left, 1, 0);
    this.left.connect(this.merge, 0, 0);
    this.left.connect(this.leftToRight);
    this.leftToRight.connect(this.right);
    this.right.connect(this.merge, 0, 1);
    this.right.connect(this.rightToLeft);
    this.rightToLeft.connect(this.left);
    this.merge.connect(this.wetGain);
    this.wetGain.connect(this.output);
  }

  set delayTime(seconds: number) {
    this.left.delayTime.value = seconds;
    this.right.delayTime.value = seconds;
  }

  set feedback(gain: number) {
    this.leftToRight.gain.value = gain;
    this.rightToLeft.gain.value = gain;
  }

  set wet(gain: number) {
    this.wetGain.gain.value = gain;
  }

  dispose() {
    for (const node of [this.input, this.output, this.split, this.left, this.right, this.leftToRight, this.rightToLeft, this.merge, this.wetGain])
      node.dispose();
  }
}
