const invalid = (message) => Object.assign(new Error(message), { status: 400 });
const ordered = (notes) =>
  notes.sort((a, b) => a.start - b.start || a.pitch - b.pitch);

// Revision checking in the route makes note indexes stable for this transaction.
export function applyAssignment(result, partId, assignment) {
  const source = result.parts.find((p) => p.id === partId);
  if (!source) throw invalid("Choose an existing source instrument.");
  if (!assignment || !["split", "move", "merge"].includes(assignment.action))
    throw invalid("Choose split, move, or merge.");
  const { action } = assignment;
  const isDrum = result.engine === "drum";
  if (isDrum && action !== "merge")
    throw invalid("Drum tracks support whole-track merging only.");
  let target;
  if (action !== "split") {
    target = result.parts.find(
      (p) => p.id === assignment.targetId && p !== source,
    );
    if (!target) throw invalid("Choose a different destination instrument.");
  }
  const indexes =
    action === "merge" ? source.notes.map((_, i) => i) : assignment.indexes;
  if (
    !Array.isArray(indexes) ||
    (!indexes.length && action !== "merge") ||
    indexes.some(
      (i) => !Number.isInteger(i) || i < 0 || i >= source.notes.length,
    )
  )
    throw invalid("Select at least one existing note.");
  const chosen = new Set(indexes);
  if (action === "split" && chosen.size === source.notes.length)
    throw invalid(
      "Leave at least one note in the original instrument when splitting.",
    );
  if (action === "split") {
    const number =
      Math.max(
        0,
        ...result.parts.map(
          (p) => Number(p.id.replace("instrument-", "")) || 0,
        ),
      ) + 1;
    target = {
      id: "instrument-" + number,
      name: (
        (typeof assignment.name === "string" && assignment.name.trim()) ||
        source.name + " · split"
      ).slice(0, 80),
      patch: { ...source.patch },
      automaticPatch: { ...(source.automaticPatch || source.patch) },
      referencePatch: {
        ...(source.referencePatch || source.automaticPatch || source.patch),
      },
      notes: [],
      locked: [],
      splitFrom: source.id,
    };
    result.parts.push(target);
  }
  const transferred = source.notes.filter((_, i) => chosen.has(i));
  // Exact duplicate detections should not become two simultaneous synth voices.
  const identities = new Set(
    target.notes.map((n) => `${n.pitch}:${n.start}:${n.end}`),
  );
  for (const original of transferred) {
    const note = isDrum
      ? {
          ...original,
          pitch: target.notes[0]?.pitch ?? source.notes[0]?.pitch ?? 36,
        }
      : original;
    const key = `${note.pitch}:${note.start}:${note.end}`;
    if (!identities.has(key)) target.notes.push({ ...note, edited: true });
    identities.add(key);
  }
  ordered(target.notes);
  source.notes = source.notes.filter((_, i) => !chosen.has(i));
  if (!source.notes.length)
    result.parts = result.parts.filter((p) => p !== source);
  result.analysis = {
    ...result.analysis,
    notes: result.parts.reduce((sum, p) => sum + p.notes.length, 0),
  };
  return target.id;
}
