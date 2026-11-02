// Compare in song time, then report timing in real milliseconds at any tempo.
export function matchPracticeNote(
  notes,
  pitch,
  songTime,
  matched,
  range,
  speed,
) {
  if (
    !Number.isFinite(songTime) ||
    !Number.isFinite(speed) ||
    speed <= 0 ||
    songTime >= range[1]
  )
    return { kind: "ignored" };
  let index = -1,
    distance = 0.15 * speed;
  notes.forEach((note, i) => {
    const delta = Math.abs(note.start - songTime);
    if (
      note.pitch === pitch &&
      !matched.has(i) &&
      note.start >= range[0] &&
      note.start < range[1] &&
      delta <= distance
    ) {
      index = i;
      distance = delta;
    }
  });
  if (index < 0) return { kind: songTime < range[0] ? "ignored" : "extra" };
  const offsetMs = ((songTime - notes[index].start) / speed) * 1000;
  return {
    kind: "hit",
    index,
    offsetMs,
    feedback:
      Math.abs(offsetMs) < 45
        ? "On time"
        : offsetMs < 0
          ? "A little early"
          : "A little late",
  };
}
