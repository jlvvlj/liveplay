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
