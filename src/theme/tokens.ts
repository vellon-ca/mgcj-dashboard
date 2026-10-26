// The dashboard palette, by ROLE. Read this before adding a colour anywhere.
//
// Rebuilt 2026-10-26 to match mgcj-app's 2026-10-23 palette
// (mgcj-app/src/theme/colors.ts — same neutrals and status values, so the two
// products read as one). The rules, carried over from the app:
//
//   1. NEUTRALS carry the interface. True greys with no hue; no navy.
//   2. ONE action colour (`brand*`, cobalt; Victor 2026-10-26, "okay for now")
//      marks what you can act on: the primary button, a selected card's
//      border, links, focus rings, the route line on the map.
//   3. STATUS colours (green / amber / blue / red) carry meaning. They appear
//      as a dot or an icon beside ordinary text, never as a tinted pill with
//      coloured text inside it.
//   4. NO WASHES. Never `rgba(<accent>, 0.1)` in a stylesheet and never
//      `color + "18"` in JSX. A raised panel is `surfaceAlt`; a selected row
//      keeps its neutral background and gets a brand border.
//   5. Purple appears in ONE place: the calendar icon and time on a scheduled
//      ride (Victor 2026-10-26, "not in an overwhelming way"). Not a status,
//      not a background.
//
// HOW IT IS WIRED. These objects are the single source. `applyTheme()` writes
// each one onto <html> as a CSS custom property (`surfaceAlt` -> --c-surface-alt,
// `text2` -> --c-text-2),
// so every page's <style> block reads `var(--c-…)`. JS that needs a real hex
// (Google Maps markers and styles, SVG built as a string) reads `palette()`.
// The one other copy is the two page backgrounds in index.html's first-paint
// script, which runs before this module can.

export type Theme = "dark" | "light";

export interface Palette {
  bg: string;
  surface: string;
  surfaceAlt: string;
  surfaceSel: string;
  // Floating panels over the map (ride card, attention panel). Near-opaque,
  // so map detail does not bleed through text.
  surfaceFloat: string;
  input: string;
  text: string;
  text2: string;
  // Placeholders and disabled labels only. Never body text.
  text3: string;
  border: string;
  borderSubtle: string;
  borderStrong: string;
  hover: string;
  hoverStrong: string;
  scrim: string;
  shadow: string;

  brand: string;
  brandFill: string;
  brandFillHover: string;
  onBrand: string;

  green: string;
  amber: string;
  amberText: string;
  blue: string;
  red: string;
  // Solid fill under WHITE text (a destructive confirm). Separate from `red`,
  // which is tuned as text on a surface and is too light under white in dark.
  redFill: string;
  purple: string;
}

const dark: Palette = {
  bg: "#111113",
  surface: "#1B1C1F",
  surfaceAlt: "#25262A",
  surfaceSel: "#25262A",
  surfaceFloat: "rgba(27,28,31,0.97)",
  input: "#111113",
  text: "#EDEDEF",
  text2: "#9A9BA1",
  text3: "#6E6F75",
  border: "rgba(255,255,255,0.09)",
  borderSubtle: "rgba(255,255,255,0.05)",
  borderStrong: "rgba(255,255,255,0.14)",
  hover: "rgba(255,255,255,0.05)",
  hoverStrong: "rgba(255,255,255,0.09)",
  scrim: "rgba(0,0,0,0.72)",
  shadow: "rgba(0,0,0,0.5)",

  brand: "#7096FF",
  brandFill: "#3D6BF5",
  brandFillHover: "#3560E6",
  onBrand: "#FFFFFF",

  green: "#1EA379",
  amber: "#F59E0B",
  amberText: "#F5A524",
  blue: "#4A9EFF",
  red: "#F87171",
  redFill: "#D42A2A",
  purple: "#B18CFF",
};

const light: Palette = {
  bg: "#F5F5F4",
  surface: "#FFFFFF",
  surfaceAlt: "#F0F0EE",
  surfaceSel: "#F0F0EE",
  surfaceFloat: "rgba(255,255,255,0.98)",
  input: "#FFFFFF",
  text: "#17181A",
  text2: "#55575C",
  text3: "#85878C",
  border: "rgba(0,0,0,0.10)",
  borderSubtle: "rgba(0,0,0,0.06)",
  borderStrong: "rgba(0,0,0,0.16)",
  hover: "rgba(0,0,0,0.04)",
  hoverStrong: "rgba(0,0,0,0.07)",
  scrim: "rgba(0,0,0,0.40)",
  shadow: "rgba(0,0,0,0.12)",

  brand: "#2F5BE0",
  brandFill: "#2F5BE0",
  brandFillHover: "#2850C8",
  onBrand: "#FFFFFF",

  green: "#177C5D",
  amber: "#BE7A08",
  amberText: "#B15209",
  blue: "#0068E1",
  red: "#DB0B0B",
  redFill: "#D42A2A",
  purple: "#7A3FD6",
};

const PALETTES: Record<Theme, Palette> = { dark, light };

export function palette(theme: Theme): Palette {
  return PALETTES[theme];
}

function cssName(key: string): string {
  return "--c-" + key.replace(/[A-Z0-9]/g, (m) => "-" + m.toLowerCase());
}

/** Writes the palette onto <html>. Idempotent; safe to call on every change. */
export function applyTheme(theme: Theme): void {
  const root = document.documentElement;
  const p = PALETTES[theme];
  for (const [key, value] of Object.entries(p)) {
    root.style.setProperty(cssName(key), value);
  }
  root.dataset.theme = theme;
  // Native controls (date pickers, selects, scrollbars) follow this.
  root.style.colorScheme = theme;
  // index.html's first-paint script set an inline background; an inline
  // style beats the stylesheet's var(), so it has to be kept in step here.
  root.style.background = p.bg;
}

/** Google Maps styles. Dark is mgcj-app's src/theme/mapStyle.ts verbatim, so
 *  the dashboard's map and the apps' maps are the same greys. Light keeps
 *  Google's default map, which is already neutral, minus POIs and transit,
 *  which the board has always hidden. */
const HIDE_CLUTTER: google.maps.MapTypeStyle[] = [
  { featureType: "poi", stylers: [{ visibility: "off" }] },
  { featureType: "transit", stylers: [{ visibility: "off" }] },
];

const DARK_MAP: google.maps.MapTypeStyle[] = [
  { elementType: "geometry", stylers: [{ color: "#1A1B1E" }] },
  { elementType: "labels.text.fill", stylers: [{ color: "#8E9096" }] },
  { elementType: "labels.text.stroke", stylers: [{ color: "#141416" }] },
  { featureType: "administrative", elementType: "geometry.stroke", stylers: [{ color: "#34353A" }] },
  { featureType: "landscape.natural", elementType: "geometry", stylers: [{ color: "#1C1E1D" }] },
  { featureType: "road", elementType: "geometry", stylers: [{ color: "#2C2D32" }] },
  { featureType: "road", elementType: "geometry.stroke", stylers: [{ color: "#202125" }] },
  { featureType: "road.highway", elementType: "geometry", stylers: [{ color: "#3A3B41" }] },
  { featureType: "road.highway", elementType: "labels.text.fill", stylers: [{ color: "#A4A6AC" }] },
  { featureType: "water", elementType: "geometry", stylers: [{ color: "#0E0F12" }] },
  { featureType: "water", elementType: "labels.text.fill", stylers: [{ color: "#5C5E64" }] },
  ...HIDE_CLUTTER,
];

export function mapStyle(theme: Theme): google.maps.MapTypeStyle[] {
  return theme === "dark" ? DARK_MAP : HIDE_CLUTTER;
}
