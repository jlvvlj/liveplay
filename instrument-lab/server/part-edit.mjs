import { patchData } from "../engine/synth.mjs";
import { drumPatch } from "../engine/drums.mjs";

export const noteIdentity = (notes) =>
  JSON.stringify(
    notes.map(({ pitch, start, end, velocity }) => ({
      pitch,
      start,
      end,
      velocity,
    })),
  );

// Validate both sides before publishing a merge, including local destination edits.
export function applyPartEdit(result, part, edit) {
  const invalid = (message) =>
    Object.assign(new Error(message), { status: 400 });
  if (!edit || typeof edit !== "object" || Array.isArray(edit))
    throw invalid("Supply an instrument edit.");
  if (edit.notes !== undefined && !Array.isArray(edit.notes))
    throw invalid("Notes must be a list.");
  if (edit.patch)
    part.patch =
      (part.engine === "drum" || result.engine === "drum")
        ? drumPatch({ ...edit.patch, model: part.patch.model })
        : patchData(edit.patch);
  if (typeof edit.name === "string") {
    if (!edit.name.trim())
      throw invalid("Enter an instrument name before saving.");
    part.name = edit.name.trim().slice(0, 80);
  }
  if (Array.isArray(edit.locked))
    part.locked = edit.locked.filter((x) => typeof x === "string");
  if (Array.isArray(edit.notes)) {
    if (edit.notes.length > 20000) throw invalid("Too many notes");
    part.notes = edit.notes.map((n) => {
      if (
        !n ||
        !Number.isInteger(n.pitch) ||
        n.pitch < 0 ||
        n.pitch > 127 ||
        !Number.isFinite(n.start) ||
        !Number.isFinite(n.end) ||
        n.start < 0 ||
        n.end <= n.start ||
        n.end > result.duration + 0.01
      )
        throw invalid("Invalid note");
      return {
        pitch: n.pitch,
        start: n.start,
        end: n.end,
        velocity: Math.max(1, Math.min(127, Number(n.velocity) || 100)),
        confidence: 1,
        edited: true,
      };
    });
  }
}
