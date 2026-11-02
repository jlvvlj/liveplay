import { DrumVoice, drumPatch } from "./drums.mjs";
import { Voice, patchData } from "./synth.mjs";
class InstrumentProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.voices = [];
    this.patch = patchData();
    this.tables = [];
    this.port.onmessage = ({ data: d }) => {
      if (d.type === "patch") {
        if (d.patch.engine === "drum") {
          this.patch = drumPatch(d.patch);
          this.drum = d.drum;
          this.tables = [];
          return;
        }
        this.drum = null;
        this.patch = patchData(d.patch);
        this.tables = d.tables;
        for (const v of this.voices) {
          v.voice.patch = this.patch;
          v.voice.table = this.tables[v.voice.pitch];
        }
      }
      if (d.type === "on" && this.drum) {
        if (this.patch.chokeGroup)
          for (const v of this.voices)
            if (v.voice instanceof DrumVoice) v.voice.choke();
        if (this.voices.length >= 48) this.voices.shift();
        this.voices.push({
          id: d.id,
          voice: new DrumVoice(this.drum, d.velocity ?? 100),
        });
      }
      if (d.type === "on" && this.tables[d.pitch]) {
        if (this.voices.length >= 48) this.voices.shift();
        this.voices.push({
          id: d.id,
          voice: new Voice(
            this.patch,
            d.pitch,
            d.velocity ?? 100,
            sampleRate,
            Infinity,
            this.tables[d.pitch],
          ),
        });
      }
      if (d.type === "off")
        for (const v of this.voices) if (v.id === d.id) v.voice.off();
      if (d.type === "panic") this.voices = [];
    };
  }
  process(inputs, outputs) {
    const out = outputs[0];
    for (let i = 0; i < out[0].length; i++) {
      let left = 0,
        right = 0;
      for (const v of this.voices) {
        const value = v.voice.sample();
        if (Array.isArray(value)) {
          left += value[0];
          right += value[1];
        } else {
          left += value;
          right += value;
        }
      }
      out[0][i] = Math.max(-1, Math.min(1, left));
      if (out[1]) out[1][i] = Math.max(-1, Math.min(1, right));
    }
    this.voices = this.voices.filter((v) => !v.voice.done);
    return true;
  }
}
registerProcessor("melodics-instrument", InstrumentProcessor);
