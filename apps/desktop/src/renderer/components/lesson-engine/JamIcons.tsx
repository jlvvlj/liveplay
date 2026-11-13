import { useId, type ReactNode } from 'react';

// Icons for the Jam tab's toolbar buttons, drawn in the button's text color

const icon = (children: ReactNode) => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {children}
  </svg>
);

// A folder holding a note: shows or hides the sidebar
export const SidebarIcon = () => {
  const cut = useId();
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
      <mask id={cut}>
        <rect width="24" height="24" fill="#fff" />
        <circle cx="10.6" cy="16.3" r="1.9" fill="#000" />
        <path d="M11.6 16.3V10.6l4.2-1.2v2.1l-2.7.8" fill="none" stroke="#000" strokeWidth="1.6" strokeLinejoin="round" />
      </mask>
      <path
        mask={`url(#${cut})`}
        fill="currentColor"
        d="M2.5 6.5A2.5 2.5 0 0 1 5 4h4.2l2.3 2.3H19a2.5 2.5 0 0 1 2.5 2.5v9.7A2.5 2.5 0 0 1 19 21H5a2.5 2.5 0 0 1-2.5-2.5z"
      />
    </svg>
  );
};

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

// A folder with a plus: imports an Ableton project's folder
export const ImportIcon = () =>
  icon(
    <>
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
      <path d="M12 10v6M9 13h6" />
    </>
  );

// An arrow down into a tray: exports the song (to Ableton Live)
export const ExportIcon = () => icon(<path d="M12 4v11M7 10l5 5 5-5M4 17v2a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-2" />);

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

// A metronome: the song's tempo
export const TempoIcon = () => small(<path d="M9.5 3.5h5L19 20H5zM12 15l4.5-8.5M7.5 15.5h9" />);

// A speaker: the song's volume
export const VolumeIcon = () => small(<path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4zM15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11" />);

// Two people: shows or hides who plays together, and inviting more
export const TogetherIcon = () =>
  icon(
    <>
      <circle cx="9" cy="8.5" r="3" />
      <path d="M3.5 19a5.5 5.5 0 0 1 11 0" />
      <path d="M15.5 5.8a3 3 0 0 1 0 5.4M17.5 14a5.5 5.5 0 0 1 3 5" />
    </>
  );

export const CloseIcon = () => icon(<path d="M6 6l12 12M18 6L6 18" />);

// Small icons for the sidebar's buttons
const small = (children: ReactNode) => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {children}
  </svg>
);
export const PlayIcon = () => small(<path d="M7 4.5v15l12.5-7.5z" fill="currentColor" />);
export const PauseIcon = () => small(<path d="M8 5v14M16 5v14" strokeWidth="3" />);
export const RestartIcon = () => small(<path d="M4 12a8 8 0 1 0 2.4-5.7M4 4v4.5h4.5" />);
export const LinkIcon = () =>
  small(
    <>
      <path d="M10 14a4.5 4.5 0 0 0 6.4 0l3-3a4.5 4.5 0 0 0-6.4-6.4l-1.2 1.2" />
      <path d="M14 10a4.5 4.5 0 0 0-6.4 0l-3 3a4.5 4.5 0 0 0 6.4 6.4l1.2-1.2" />
    </>
  );
export const SendIcon = () => small(<path d="M20 4L9.5 14.5M20 4l-6.5 16-4-5.5L4 10.5z" />);
export const CalendarIcon = () =>
  small(
    <>
      <rect x="3.5" y="5" width="17" height="15" rx="2" />
      <path d="M3.5 10h17M8 3v4M16 3v4" />
    </>
  );
export const ShareIcon = () => small(<path d="M12 15V4M8 8l4-4 4 4M5 12v7a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-7" />);
export const MailIcon = () =>
  small(
    <>
      <rect x="3.5" y="5.5" width="17" height="13" rx="2" />
      <path d="M4 7l8 6 8-6" />
    </>
  );
export const CheckIcon = () => small(<path d="M5 12.5l4.5 4.5L19 7.5" />);

// A star, filled for a favourite
export const StarIcon = ({ filled = false }: { filled?: boolean }) =>
  small(
    <path
      d="M12 3.5l2.6 5.4 5.9.8-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8L3.5 9.7l5.9-.8z"
      fill={filled ? 'currentColor' : 'none'}
      strokeWidth="1.8"
    />
  );

// A funnel: narrows a list to one kind
export const FilterIcon = () => small(<path d="M4 5h16l-6.2 7.4V18l-3.6 1.8v-7.4z" strokeWidth="1.8" />);
export const ChevronLeftIcon = () => icon(<path d="M15 6l-6 6 6 6" />);
export const ChevronRightIcon = () => icon(<path d="M9 6l6 6-6 6" />);

// Synth sound types, drawn larger on their cards
const large = (children: ReactNode) => (
  <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {children}
  </svg>
);

// Each drawn around the middle of its box, so it sits centered on its card
export const SYNTH_TAG_ICONS: Record<string, () => ReactNode> = {
  // A sawtooth wave: the bright, buzzing wave leads are made of
  Lead: () => large(<path d="M3 16.5l6-9v9l6-9v9l6-9v9" />),
  Pad: () => large(<path d="M7.5 18h9.5a4 4 0 0 0 .6-7.95 6 6 0 0 0-11.4-.75A4.4 4.4 0 0 0 7.5 18z" />),
  // A bass clef
  Bass: () =>
    large(
      <>
        <circle cx="5.5" cy="9" r="1.6" fill="currentColor" stroke="none" />
        <path d="M4.9 9C4.9 5.8 7.6 4 10.4 4c3.6 0 6 2.5 6 5.8 0 4.9-4.7 8.6-11.4 10.2" />
        <circle cx="19.6" cy="7.6" r="1" fill="currentColor" stroke="none" />
        <circle cx="19.6" cy="12.2" r="1" fill="currentColor" stroke="none" />
      </>
    ),
  'Mallets & Keys': () =>
    large(
      <>
        <rect x="3" y="5" width="18" height="14" rx="1.5" />
        <path d="M7.5 5v14M12 5v14M16.5 5v14" />
        <path d="M6 5v7h3V5M10.5 5v7h3V5M15 5v7h3V5" fill="currentColor" />
      </>
    ),
  // A guitar pick
  'Pluck & Stab': () => large(<path d="M12 20.5C8.2 17.2 5 12.6 5 8.6 5 5.6 8 4 12 4s7 1.6 7 4.6c0 4-3.2 8.6-7 11.9z" />),
  Bell: () =>
    large(
      <>
        <path d="M6 14.5v-5a6 6 0 0 1 12 0v5l1.5 2h-15z" />
        <path d="M10 18.5a2 2 0 0 0 4 0" />
      </>
    ),
};

// A waveform: a track's own recorded sound
export const TrackSoundIcon = () => large(<path d="M4.5 10v4M7.5 7v10M10.5 4v16M13.5 8v8M16.5 5.5v13M19.5 9.5v5" />);
