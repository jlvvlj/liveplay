import { useId } from 'react';

// The artwork on a sampled category's or instrument's card: a bold two-colour
// pattern

const COLOURS: [string, string][] = [
  ['#f07a2e', '#3f6df2'],
  ['#f3d6d2', '#e2575f'],
  ['#b8342c', '#1a0d0c'],
  ['#f7d65c', '#ec5f9b'],
  ['#e35b5b', '#fbe3df'],
  ['#ad2f2a', '#1b1213'],
  ['#5038d8', '#f2c14e'],
  ['#2fa58a', '#f1efe2'],
  ['#1f2c5c', '#f08a4b'],
  ['#c6e05a', '#2b4a2f'],
];

const PATTERNS = ['stripes', 'dots', 'waves', 'rings', 'zigzag', 'bars', 'grid'] as const;

// `seed` picks the colours and the pattern: cards next to each other (seeds
// one apart) never share either
export function CategoryArt({ seed }: { seed: number }) {
  const id = useId().replace(/:/g, '');
  const [back, fore] = COLOURS[seed % COLOURS.length];
  const pattern = PATTERNS[(seed * 3) % PATTERNS.length];
  const turn = (seed % 4) * 15 - 30;
  const shape = (() => {
    switch (pattern) {
      case 'stripes':
        return <path d="M0 0L0 12M6 0L6 12" stroke={fore} strokeWidth="2.6" />;
      case 'dots':
        return <circle cx="6" cy="6" r="3.1" fill={fore} />;
      case 'waves':
        return <path d="M0 6Q3 1 6 6T12 6" stroke={fore} strokeWidth="1.6" fill="none" />;
      case 'rings':
        return <circle cx="6" cy="6" r="3.6" stroke={fore} strokeWidth="1.4" fill="none" />;
      case 'zigzag':
        return <path d="M0 9L3 3L6 9L9 3L12 9" stroke={fore} strokeWidth="1.6" fill="none" />;
      case 'bars':
        return <rect x="1" y="0" width="4" height="8" fill={fore} />;
      case 'grid':
        return <path d="M0 6H12M6 0V12" stroke={fore} strokeWidth="1.2" />;
    }
  })();
  return (
    <svg className="instrument-art" viewBox="0 0 120 120" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
      <defs>
        <pattern id={id} width="12" height="12" patternUnits="userSpaceOnUse" patternTransform={`rotate(${turn})`}>
          {shape}
        </pattern>
      </defs>
      <rect width="120" height="120" fill={back} />
      <rect width="120" height="120" fill={`url(#${id})`} />
    </svg>
  );
}
