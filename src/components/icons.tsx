import type { SVGProps } from "react";

type P = SVGProps<SVGSVGElement>;
const base = { width: 24, height: 24, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true } as const;

export const MicIcon = (p: P) => (
  <svg {...base} {...p}>
    <rect x="9" y="3" width="6" height="11" rx="3" />
    <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
  </svg>
);
export const MicOffIcon = (p: P) => (
  <svg {...base} {...p}>
    <path d="M15 9.3V6a3 3 0 0 0-5.7-1.3M9 9v2a3 3 0 0 0 4.9 2.3M5 11a7 7 0 0 0 11.4 5.4M19 11a7 7 0 0 1-.6 2.8M12 18v3M3 3l18 18" />
  </svg>
);
export const CaptionsIcon = (p: P) => (
  <svg {...base} {...p}>
    <rect x="3" y="5" width="18" height="14" rx="3" />
    <path d="M7 12h4M13 12h4M7 15.5h7" />
  </svg>
);
export const GroupsIcon = (p: P) => (
  <svg {...base} {...p}>
    <circle cx="9" cy="8" r="3.2" />
    <path d="M3 19c.6-3.2 3-5 6-5s5.4 1.8 6 5" />
    <circle cx="17.5" cy="9" r="2.5" />
    <path d="M16.5 14.1c2.3.2 4 1.7 4.5 4.4" />
  </svg>
);
export const QrIcon = (p: P) => (
  <svg {...base} {...p}>
    <rect x="3" y="3" width="7" height="7" rx="1.5" />
    <rect x="14" y="3" width="7" height="7" rx="1.5" />
    <rect x="3" y="14" width="7" height="7" rx="1.5" />
    <path d="M14 14h3v3M21 14v.01M14 21h3M21 18v3h-1" />
  </svg>
);
export const SettingsIcon = (p: P) => (
  <svg {...base} {...p}>
    <path d="M4 7h10M18 7h2M4 17h4M12 17h8" />
    <circle cx="16" cy="7" r="2" />
    <circle cx="10" cy="17" r="2" />
  </svg>
);
export const CloseIcon = (p: P) => (
  <svg {...base} {...p}>
    <path d="M6 6l12 12M18 6L6 18" />
  </svg>
);
export const ChevronDown = (p: P) => (
  <svg {...base} {...p}>
    <path d="M6 9l6 6 6-6" />
  </svg>
);
export const HeadsetIcon = (p: P) => (
  <svg {...base} {...p}>
    <path d="M4 14v-2a8 8 0 0 1 16 0v2" />
    <rect x="3" y="14" width="4" height="6" rx="1.5" />
    <rect x="17" y="14" width="4" height="6" rx="1.5" />
    <path d="M19 20c0 1-1 1.5-2 1.5h-3" />
  </svg>
);
export const SpeakerIcon = (p: P) => (
  <svg {...base} {...p}>
    <path d="M4 10v4h3l5 4V6L7 10H4Z" />
    <path d="M16 9a4 4 0 0 1 0 6M18.5 6.5a8 8 0 0 1 0 11" />
  </svg>
);
export const SpeakerOffIcon = (p: P) => (
  <svg {...base} {...p}>
    <path d="M4 10v4h3l5 4V6L7 10H4ZM16 9l5 6M21 9l-5 6" />
  </svg>
);
export const GlobeIcon = (p: P) => (
  <svg {...base} {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3Z" />
  </svg>
);
export const LockIcon = (p: P) => (
  <svg {...base} {...p}>
    <rect x="5" y="11" width="14" height="9" rx="2" />
    <path d="M8 11V8a4 4 0 0 1 8 0v3" />
  </svg>
);
export const WaveIcon = (p: P) => (
  <svg {...base} {...p}>
    <path d="M3 12h2M7 8v8M11 5v14M15 9v6M19 7v10M21 12h0" />
  </svg>
);
export const PlusIcon = (p: P) => (
  <svg {...base} {...p}>
    <path d="M12 5v14M5 12h14" />
  </svg>
);
export const ArrowBackIcon = (p: P) => (
  <svg {...base} {...p}>
    <path d="M15 6l-6 6 6 6" />
  </svg>
);
export const FocusIcon = (p: P) => (
  <svg {...base} {...p}>
    <circle cx="12" cy="12" r="3" />
    <path d="M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3" />
  </svg>
);
export const ShareIcon = (p: P) => (
  <svg {...base} {...p}>
    <path d="M12 3v12M7 8l5-5 5 5" />
    <path d="M5 13v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6" />
  </svg>
);
export const SparkIcon = (p: P) => (
  <svg {...base} {...p}>
    <path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3ZM19 16l.8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8L19 16Z" />
  </svg>
);
