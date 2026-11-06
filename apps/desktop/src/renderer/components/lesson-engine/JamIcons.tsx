import type { ReactNode } from 'react';

// Icons for the Jam tab's toolbar buttons, drawn in the button's text color

const icon = (children: ReactNode) => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {children}
  </svg>
);

// A window with a panel down its left side: shows or hides the settings sidebar
export const SidebarIcon = () =>
  icon(
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M9 4v16" />
    </>
  );

// Three faders: shows or hides the grid's track headers (name, solo, mute, level)
export const LanesIcon = () =>
  icon(
    <>
      <path d="M4 6h16M4 12h16M4 18h16" />
      <circle cx="9" cy="6" r="2" fill="currentColor" />
      <circle cx="15" cy="12" r="2" fill="currentColor" />
      <circle cx="7" cy="18" r="2" fill="currentColor" />
    </>
  );

export const BackIcon = () => icon(<path d="M19 12H5M11 6l-6 6 6 6" />);

// Arrows out to the corners: the editor takes the whole height
export const ExpandIcon = () => icon(<path d="M14 4h6v6M10 20H4v-6M20 4l-7 7M4 20l7-7" />);

// Arrows in from the corners: the editor goes back to its size
export const CollapseIcon = () => icon(<path d="M20 10h-6V4M4 14h6v6M14 10l7-7M10 14l-7 7" />);

// A keyboard with a wave over it: opens the instruments panel
export const InstrumentsIcon = () =>
  icon(
    <>
      <rect x="3" y="11" width="18" height="10" rx="1.5" />
      <path d="M8 11v6M12 11v6M16 11v6" />
      <path d="M3 6c2-3 4-3 6 0s4 3 6 0 4-3 6 0" />
    </>
  );

export const SearchIcon = () =>
  icon(
    <>
      <circle cx="11" cy="11" r="7" />
      <path d="M20 20l-4-4" />
    </>
  );

export const CloseIcon = () => icon(<path d="M6 6l12 12M18 6L6 18" />);
export const ChevronLeftIcon = () => icon(<path d="M15 6l-6 6 6 6" />);
export const ChevronRightIcon = () => icon(<path d="M9 6l6 6-6 6" />);

// Synth sound types, drawn larger on their cards
const large = (children: ReactNode) => (
  <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {children}
  </svg>
);

export const SYNTH_TAG_ICONS: Record<string, () => ReactNode> = {
  // Arcs leaving a point: a lead cutting through
  Lead: () =>
    large(
      <>
        <circle cx="6" cy="18" r="1.2" fill="currentColor" />
        <path d="M6 13a5 5 0 0 1 5 5M6 8a10 10 0 0 1 10 10M6 3a15 15 0 0 1 15 15" />
      </>
    ),
  Pad: () => large(<path d="M7 18h10a4 4 0 0 0 .6-7.95A6 6 0 0 0 6.2 9.3 4.4 4.4 0 0 0 7 18z" />),
  Bass: () => large(<path d="M2 12c2.5-6 5-6 7.5 0s5 6 7.5 0 3.5-4 5-3" />),
  'Mallets & Keys': () =>
    large(
      <>
        <rect x="3" y="5" width="18" height="14" rx="1.5" />
        <path d="M7.5 5v14M12 5v14M16.5 5v14" />
        <path d="M6 5v7h3V5M10.5 5v7h3V5M15 5v7h3V5" fill="currentColor" />
      </>
    ),
  'Pluck & Stab': () =>
    large(
      <>
        <path d="M3 12h4l2-7 3 14 2-7h7" />
      </>
    ),
  Bell: () =>
    large(
      <>
        <path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15z" />
        <path d="M10 20a2 2 0 0 0 4 0" />
      </>
    ),
};
