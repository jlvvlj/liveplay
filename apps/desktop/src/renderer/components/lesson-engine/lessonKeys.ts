// The keys a lesson's lanes get by default, the top lane first: the home row
// a r s t g k n e i, then o, the row above, the row below and the numbers
// (for lessons with more lanes than letters)
export const LESSON_DEFAULT_KEYS = [
  'a', 'r', 's', 't', 'g', 'k', 'n', 'e', 'i', 'o',
  'q', 'w', 'f', 'p', 'b', 'j', 'l', 'u', 'y',
  'z', 'x', 'c', 'd', 'v', 'm', 'h',
  '1', '2', '3', '4', '5', '6', '7', '8', '9', '0',
];

// Each lane's default key, by lane note: `lanes` top to bottom as the
// highway draws them
export function defaultLessonKeys(lanes: number[]): { [key: string]: number } {
  const mapping: { [key: string]: number } = {};
  lanes.forEach((note, index) => {
    if (index < LESSON_DEFAULT_KEYS.length) mapping[LESSON_DEFAULT_KEYS[index]] = note;
  });
  return mapping;
}
