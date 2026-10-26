// Small line icons for inline UI: badges, chips, buttons.
//
// They replace emoji and symbol glyphs (⏳ ◷ ⚑ ⚠ 🔔) that rendered differently
// on every OS, could not take the theme's colours, and read as decoration.
// Each draws in `currentColor`, so the colour is set by the text around it.
// The nav icons stay where they are (DashboardPage.tsx `Icon*`); this is the
// set for content.

import type { CSSProperties, ReactNode } from "react";

export type IconName =
  | "clock"
  | "flag"
  | "alert"
  | "bell"
  | "bellOff"
  | "close"
  | "calendar"
  | "signal"
  | "hourglass";

const PATHS: Record<IconName, ReactNode> = {
  clock: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </>
  ),
  flag: <path d="M5 21V4h11l-2 4 2 4H5" />,
  alert: (
    <>
      <path d="M10.3 4.2 2.6 18a2 2 0 0 0 1.7 3h15.4a2 2 0 0 0 1.7-3L13.7 4.2a2 2 0 0 0-3.4 0z" />
      <path d="M12 9v4M12 17h.01" />
    </>
  ),
  bell: (
    <>
      <path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15z" />
      <path d="M10 21h4" />
    </>
  ),
  bellOff: (
    <>
      <path d="M8.7 4.4A6 6 0 0 1 18 11v4M6 11v5l-1.5 2H17" />
      <path d="M10 21h4M3 3l18 18" />
    </>
  ),
  close: <path d="M6 6l12 12M18 6 6 18" />,
  calendar: (
    <>
      <rect x="3" y="5" width="18" height="16" rx="2" />
      <path d="M3 10h18M8 3v4M16 3v4" />
    </>
  ),
  // "Out of contact": a signal with a break in it.
  signal: (
    <>
      <path d="M2 8.8a15 15 0 0 1 5-3.2M22 8.8A15 15 0 0 0 12 5" />
      <path d="M5.5 12.4a10 10 0 0 1 3-1.9M18.5 12.4A10 10 0 0 0 14 10.2" />
      <path d="M12 19h.01M3 3l18 18" />
    </>
  ),
  hourglass: <path d="M7 3h10M7 21h10M8 3c0 5 8 5 8 9s-8 4-8 9M16 3c0 5-8 5-8 9s8 4 8 9" />,
};

export default function Icon({
  name,
  size = 12,
  style,
}: {
  name: IconName;
  size?: number;
  style?: CSSProperties;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={{ flexShrink: 0, verticalAlign: "-0.125em", ...style }}
    >
      {PATHS[name]}
    </svg>
  );
}
