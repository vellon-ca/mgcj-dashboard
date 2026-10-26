import { useEffect, useState } from "react";
import type React from "react";
import { useTranslation } from "react-i18next";

// Vellon AI: a "coming soon" placeholder for the dispatch assistant. Nothing
// here reads data or calls a model. The example questions are illustrations,
// not answers, so the page cannot be mistaken for a working feature.

interface Props {
  // Hidden pages stay mounted (display: none). The typing loop only runs while
  // this one is on screen.
  visible: boolean;
}

const EXAMPLE_KEYS = ["ai.example1", "ai.example2", "ai.example3", "ai.example4"];

const TYPE_MS = 38;
const HOLD_MS = 2200;
const ERASE_MS = 16;

function prefersReducedMotion() {
  // i18n-ok — a media query, not copy.
  return typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
}

// Six nodes around the core, plus the edges a pulse travels along.
const NODES = Array.from({ length: 6 }, (_, i) => {
  const a = (Math.PI / 3) * i - Math.PI / 2;
  return { x: 120 + Math.cos(a) * 56, y: 120 + Math.sin(a) * 56 };
});
const EDGES: [number, number][] = [
  [0, 1], [1, 2], [2, 3], [3, 4], [4, 5], [5, 0], [0, 3], [1, 4], [2, 5],
];

export function AiEmblem({ size = 240 }: { size?: number }) {
  return (
    <svg
      className="ai-emblem"
      width={size}
      height={size}
      viewBox="0 0 240 240"
      aria-hidden="true"
    >
      <defs>
        <radialGradient id="ai-glow" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="#E8500A" stopOpacity="0.32" />
          <stop offset="55%" stopColor="#E8500A" stopOpacity="0.08" />
          <stop offset="100%" stopColor="#E8500A" stopOpacity="0" />
        </radialGradient>
        <linearGradient id="ai-core" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#FF7A3D" />
          <stop offset="100%" stopColor="#C2410C" />
        </linearGradient>
        <linearGradient id="ai-sweep" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor="#E8500A" stopOpacity="0" />
          <stop offset="100%" stopColor="#E8500A" stopOpacity="0.28" />
        </linearGradient>
      </defs>

      <circle className="ai-glow" cx="120" cy="120" r="118" fill="url(#ai-glow)" />

      {/* Radar sweep */}
      <g className="ai-spin ai-sweep">
        <path d="M120 120 L120 14 A106 106 0 0 1 211.8 67 Z" fill="url(#ai-sweep)" />
      </g>

      {/* Outer ring: fine ticks */}
      <g className="ai-spin ai-ring-1">
        <circle cx="120" cy="120" r="106" fill="none" stroke="#E8500A" strokeOpacity="0.35"
          strokeWidth="1" strokeDasharray="1.5 7" />
      </g>
      {/* Middle ring: two bright arcs over a faint track */}
      <circle cx="120" cy="120" r="90" fill="none" stroke="#FFFFFF" strokeOpacity="0.06" strokeWidth="1" />
      <g className="ai-spin ai-ring-2">
        <circle cx="120" cy="120" r="90" fill="none" stroke="#E8500A" strokeWidth="1.5"
          strokeLinecap="round" pathLength="100" strokeDasharray="18 32" />
      </g>
      {/* Inner ring: dotted, counter-rotating */}
      <g className="ai-spin ai-ring-3">
        <circle cx="120" cy="120" r="72" fill="none" stroke="#FDBA74" strokeOpacity="0.45"
          strokeWidth="2" strokeLinecap="round" strokeDasharray="0.1 9" />
      </g>

      {/* Orbiting satellites */}
      <g className="ai-spin ai-orbit-1">
        <circle cx="120" cy="30" r="3.2" fill="#FF7A3D" />
      </g>
      <g className="ai-spin ai-orbit-2">
        <circle cx="120" cy="48" r="2.2" fill="#FDBA74" />
      </g>
      <g className="ai-spin ai-orbit-3">
        <circle cx="120" cy="14" r="1.8" fill="#FFFFFF" fillOpacity="0.7" />
      </g>

      {/* Network: faint edges, a pulse travelling along each, glowing nodes */}
      <g className="ai-net">
        {EDGES.map(([a, b], i) => (
          <path
            key={`e${i}`}
            d={`M${NODES[a].x} ${NODES[a].y} L${NODES[b].x} ${NODES[b].y}`}
            stroke="#E8500A"
            strokeOpacity="0.18"
            strokeWidth="1"
          />
        ))}
        {EDGES.map(([a, b], i) => (
          <path
            key={`p${i}`}
            className="ai-pulse"
            style={{ animationDelay: `${(i * 0.37).toFixed(2)}s` }}
            d={`M${NODES[a].x} ${NODES[a].y} L${NODES[b].x} ${NODES[b].y}`}
            stroke="#FFB27A"
            strokeWidth="1.6"
            strokeLinecap="round"
            pathLength="100"
            strokeDasharray="14 86"
            fill="none"
          />
        ))}
        {NODES.map((n, i) => (
          <circle
            key={`n${i}`}
            className="ai-node"
            style={{ animationDelay: `${(i * 0.4).toFixed(1)}s` }}
            cx={n.x}
            cy={n.y}
            r="3"
            fill="#FF7A3D"
          />
        ))}
      </g>

      {/* Core */}
      <g className="ai-core">
        <rect x="92" y="92" width="56" height="56" rx="16" fill="url(#ai-core)" />
        <rect x="92.5" y="92.5" width="55" height="55" rx="15.5" fill="none" stroke="#FFFFFF" strokeOpacity="0.25" />
        <text x="120" y="128.5" textAnchor="middle" fontSize="23" fontWeight="800"
          fill="#FFFFFF" letterSpacing="0.5" fontFamily="inherit">
          {/* i18n-ok — the mark itself, not a label. */}
          AI
        </text>
      </g>
    </svg>
  );
}

// The page backdrop: a dark street map at the edges, with taxis driving it and
// ride requests appearing, being matched and routed. Decoration only — the map
// is invented, and nothing on it stands for a real ride or driver. Masked out
// toward the centre so it never sits under the text.
const ROADS = [
  "M-40 90 H1480", "M-40 270 H1480", "M-40 630 H1480", "M-40 810 H1480",
  "M150 -40 V940", "M330 -40 V940", "M1110 -40 V940", "M1290 -40 V940",
  "M600 -40 V90", "M840 -40 V90", "M600 810 V940", "M840 810 V940",
  "M-40 450 C 60 450, 110 400, 150 360", "M1290 540 C 1340 480, 1400 450, 1480 450",
];

// Each taxi starts and ends off screen, so a repeat is seamless.
const TAXIS = [
  { d: "M-40 270 H330 V810 H1110 V940", dur: 26, begin: 0 },
  { d: "M1480 90 H1110 V630 H1290 V-40", dur: 22, begin: -6 },
  { d: "M150 940 V630 H330 V90 H1110 V-40", dur: 30, begin: -14 },
  { d: "M1480 810 H1290 V270 H1480", dur: 16, begin: -3 },
  { d: "M-40 630 H150 V-40", dur: 13, begin: -9 },
  { d: "M840 -40 V90 H1290 V940", dur: 24, begin: -18 },
];

// A request appears (pin + ping), a route draws to the drop-off, then it clears.
const RIDES = [
  { x: 330, y: 630, route: "M330 630 V810 H600", to: [600, 810], delay: 0 },
  { x: 1110, y: 270, route: "M1110 270 H1290 V90", to: [1290, 90], delay: 2.6 },
  { x: 150, y: 270, route: "M150 270 V90 H330", to: [330, 90], delay: 5.2 },
  { x: 1290, y: 630, route: "M1290 630 V810 H1000", to: [1000, 810], delay: 7.8 },
];

function Taxi() {
  // Drawn pointing along +x so animateMotion's rotate="auto" faces it forward.
  return (
    <g transform="scale(1.25)">
      <ellipse cx="22" cy="0" rx="20" ry="9" fill="url(#aib-beam)" />
      <rect x="-12" y="-7" width="24" height="14" rx="4" fill="#F59E0B" />
      <rect x="2" y="-5.5" width="6" height="11" rx="2" fill="#111827" fillOpacity="0.75" />
      <rect x="-9" y="-5" width="4" height="10" rx="1.5" fill="#111827" fillOpacity="0.55" />
      <rect x="-3" y="-3" width="4" height="6" rx="1" fill="#FFFBEB" />
    </g>
  );
}

function AiBackdrop({ animate }: { animate: boolean }) {
  return (
    <div className="aib" aria-hidden="true">
      <svg className="aib-map" viewBox="0 0 1440 900" preserveAspectRatio="xMidYMid slice">
        <defs>
          <pattern id="aib-grid" width="45" height="45" patternUnits="userSpaceOnUse">
            <path d="M45 0 H0 V45" fill="none" stroke="#FFFFFF" strokeOpacity="0.025" strokeWidth="1" />
          </pattern>
          <radialGradient id="aib-beam" cx="0%" cy="50%" r="100%">
            <stop offset="0%" stopColor="#FEF3C7" stopOpacity="0.35" />
            <stop offset="100%" stopColor="#FEF3C7" stopOpacity="0" />
          </radialGradient>
        </defs>

        <g className="aib-pan">
          <rect x="-200" y="-200" width="1840" height="1300" fill="url(#aib-grid)" />
          {ROADS.map((d, i) => (
            <path key={`r${i}`} d={d} fill="none" stroke="#1F2937" strokeOpacity="0.75" strokeWidth="16" strokeLinecap="round" />
          ))}
          {ROADS.map((d, i) => (
            <path key={`c${i}`} d={d} fill="none" stroke="#FFFFFF" strokeOpacity="0.06" strokeWidth="1"
              strokeDasharray="8 12" />
          ))}

          {RIDES.map((r, i) => (
            // i18n-ok — keys, CSS variables and SVG transforms, not copy.
            <g key={`ride${i}`} className="aib-ride" style={{ "--d": `${r.delay}s` } as React.CSSProperties}>
              <path className="aib-route" d={r.route} pathLength="100" fill="none" stroke="#E8500A"
                strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
              <circle className="aib-ping" cx={r.x} cy={r.y} r="14" fill="none" stroke="#E8500A" strokeWidth="1.5" />
              {/* i18n-ok — an SVG transform, not copy. */}
              <g transform={`translate(${r.to[0]} ${r.to[1]})`}>
                <g className="aib-drop">
                  <rect x="-5" y="-5" width="10" height="10" rx="2" fill="#111827" stroke="#FDBA74" strokeWidth="2" />
                </g>
              </g>
              {/* i18n-ok — an SVG transform, not copy. */}
              <g transform={`translate(${r.x} ${r.y})`}>
                <g className="aib-pin">
                  <path d="M0 0 C -2 -6 -10 -11 -10 -19 A 10 10 0 1 1 10 -19 C 10 -11 2 -6 0 0 Z" fill="#E8500A" />
                  <circle cx="0" cy="-19" r="3.5" fill="#111827" />
                </g>
              </g>
            </g>
          ))}

          {animate && TAXIS.map((t, i) => (
            <g key={`t${i}`}>
              <Taxi />
              <animateMotion dur={`${t.dur}s`} begin={`${t.begin}s`} repeatCount="indefinite"
                rotate="auto" path={t.d} />
            </g>
          ))}
        </g>
      </svg>
    </div>
  );
}

// The nav glyph: a four-point spark with a smaller one that twinkles.
export function IconAi() {
  return (
    <svg className="ai-nav-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        className="ai-nav-main"
        d="M10 3.5c.6 3.6 2.4 5.4 6 6-3.6.6-5.4 2.4-6 6-.6-3.6-2.4-5.4-6-6 3.6-.6 5.4-2.4 6-6z"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinejoin="round"
      />
      <path
        className="ai-nav-spark"
        d="M18.5 13.5c.3 1.6 1 2.3 2.5 2.5-1.5.3-2.2 1-2.5 2.5-.3-1.5-1-2.2-2.5-2.5 1.5-.2 2.2-.9 2.5-2.5z"
        fill="#E8500A"
      />
    </svg>
  );
}

export default function AiPage({ visible }: Props) {
  const { t } = useTranslation();
  const examples = EXAMPLE_KEYS.map((k) => t(k));
  const [index, setIndex] = useState(0);
  const [shown, setShown] = useState(0);
  const [phase, setPhase] = useState<"type" | "hold" | "erase">("type");

  const full = examples[index % examples.length];
  // Reduced motion: no typing, the first question just sits there.
  const [reduced] = useState(prefersReducedMotion);

  useEffect(() => {
    if (!visible || reduced) return;
    let timer: number;
    if (phase === "type") {
      if (shown < full.length) timer = window.setTimeout(() => setShown(shown + 1), TYPE_MS);
      else timer = window.setTimeout(() => setPhase("hold"), 0);
    } else if (phase === "hold") {
      timer = window.setTimeout(() => setPhase("erase"), HOLD_MS);
    } else if (shown > 0) {
      timer = window.setTimeout(() => setShown(shown - 1), ERASE_MS);
    } else {
      timer = window.setTimeout(() => {
        setIndex((i) => (i + 1) % examples.length);
        setPhase("type");
      }, 300);
    }
    return () => window.clearTimeout(timer);
  }, [visible, reduced, phase, shown, full.length, examples.length]);

  return (
    <div className="ai-page">
      <AiBackdrop animate={visible && !reduced} />
      <style>{`
        .ai-page { position: relative; flex: 1; overflow: auto; display: flex; align-items: center; justify-content: center; padding: 40px 24px; background:
          radial-gradient(ellipse 60% 50% at 50% 38%, rgba(232,80,10,0.07), transparent 70%), #111827; }
        .ai-inner { position: relative; z-index: 1; display: flex; flex-direction: column; align-items: center; text-align: center; max-width: 560px; width: 100%; }

        .ai-emblem { display: block; overflow: visible; }
        .ai-emblem .ai-spin { transform-box: view-box; transform-origin: 120px 120px; animation: ai-rotate linear infinite; }
        .ai-emblem .ai-sweep { animation-duration: 7s; }
        .ai-emblem .ai-ring-1 { animation-duration: 60s; }
        .ai-emblem .ai-ring-2 { animation-duration: 11s; }
        .ai-emblem .ai-ring-3 { animation-duration: 28s; animation-direction: reverse; }
        .ai-emblem .ai-orbit-1 { animation-duration: 9s; }
        .ai-emblem .ai-orbit-2 { animation-duration: 6s; animation-direction: reverse; }
        .ai-emblem .ai-orbit-3 { animation-duration: 19s; }
        .ai-emblem .ai-pulse { animation: ai-travel 3.3s cubic-bezier(0.45,0,0.55,1) infinite; stroke-dashoffset: 100; }
        .ai-emblem .ai-node { transform-box: fill-box; transform-origin: center; animation: ai-blink 2.4s ease-in-out infinite; }
        .ai-emblem .ai-core { transform-box: view-box; transform-origin: 120px 120px; animation: ai-breathe 3.6s ease-in-out infinite; }
        .ai-emblem .ai-glow { transform-box: view-box; transform-origin: 120px 120px; animation: ai-glow 3.6s ease-in-out infinite; }
        .ai-emblem .ai-net { transform-box: view-box; transform-origin: 120px 120px; animation: ai-rotate 90s linear infinite; }

        @keyframes ai-rotate { to { transform: rotate(360deg); } }
        @keyframes ai-travel { 0% { stroke-dashoffset: 100; opacity: 0; } 15% { opacity: 1; } 85% { opacity: 1; } 100% { stroke-dashoffset: 0; opacity: 0; } }
        @keyframes ai-blink { 0%, 100% { opacity: 0.45; transform: scale(0.8); } 50% { opacity: 1; transform: scale(1.25); } }
        @keyframes ai-breathe { 0%, 100% { transform: scale(1); } 50% { transform: scale(1.06); } }
        @keyframes ai-glow { 0%, 100% { opacity: 0.7; transform: scale(0.96); } 50% { opacity: 1; transform: scale(1.04); } }

        .ai-badge { margin-top: 28px; display: inline-flex; align-items: center; gap: 7px; padding: 4px 11px; border-radius: 999px;
          border: 1px solid rgba(232,80,10,0.35); color: #FDBA74; font-size: 11px; font-weight: 700; letter-spacing: 0.9px; text-transform: uppercase; }
        .ai-badge-dot { width: 6px; height: 6px; border-radius: 50%; background: #E8500A; animation: ai-ping 1.8s ease-out infinite; }
        @keyframes ai-ping { 0% { box-shadow: 0 0 0 0 rgba(232,80,10,0.6); } 100% { box-shadow: 0 0 0 7px rgba(232,80,10,0); } }

        .ai-title { margin: 14px 0 0; font-size: 28px; font-weight: 700; letter-spacing: -0.6px; color: #F3F4F6; }
        .ai-sub { margin: 10px 0 0; font-size: 14px; line-height: 1.55; color: #9CA3AF; max-width: 440px; }

        .ai-prompt { margin-top: 28px; width: 100%; display: flex; align-items: center; gap: 10px; padding: 12px 14px; border-radius: 12px;
          background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.08); text-align: left; color: #9CA3AF; }
        .ai-prompt-text { flex: 1; min-width: 0; font-size: 14px; color: #E5E7EB; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .ai-caret { display: inline-block; width: 2px; height: 1em; margin-left: 2px; vertical-align: -2px; background: #E8500A; animation: ai-caret 1s steps(1) infinite; }
        @keyframes ai-caret { 50% { opacity: 0; } }
        .ai-send { flex-shrink: 0; width: 28px; height: 28px; border-radius: 8px; display: flex; align-items: center; justify-content: center;
          background: rgba(255,255,255,0.05); color: #6B7280; }

        .ai-points { margin-top: 22px; display: flex; flex-wrap: wrap; justify-content: center; gap: 8px 18px; font-size: 12px; color: #6B7280; }
        .ai-points span { display: inline-flex; align-items: center; gap: 6px; }
        .ai-points span::before { content: ""; width: 4px; height: 4px; border-radius: 50%; background: #E8500A; opacity: 0.8; }

        .aib { position: absolute; inset: 0; overflow: hidden; pointer-events: none;
          -webkit-mask-image: radial-gradient(ellipse 40% 46% at 50% 46%, transparent 0%, rgba(0,0,0,0.15) 55%, #000 100%);
          mask-image: radial-gradient(ellipse 40% 46% at 50% 46%, transparent 0%, rgba(0,0,0,0.15) 55%, #000 100%); }
        .aib-map { width: 100%; height: 100%; display: block; }
        .aib-pan { animation: aib-pan 48s ease-in-out infinite alternate; }
        @keyframes aib-pan { from { transform: translate(-18px, -10px); } to { transform: translate(18px, 10px); } }

        .aib-route, .aib-ping, .aib-pin, .aib-drop { animation-duration: 10.4s; animation-iteration-count: infinite; animation-delay: var(--d); animation-fill-mode: both; }
        .aib-route { stroke-dasharray: 100; stroke-dashoffset: 100; opacity: 0; animation-name: aib-route; animation-timing-function: ease-in-out; }
        .aib-ping { transform-box: fill-box; transform-origin: center; opacity: 0; animation-name: aib-ping; animation-timing-function: ease-out; }
        .aib-pin { transform-box: fill-box; transform-origin: 50% 100%; opacity: 0; animation-name: aib-pin; }
        .aib-drop { transform-box: fill-box; transform-origin: center; opacity: 0; animation-name: aib-drop; }

        @keyframes aib-pin { 0% { opacity: 0; transform: translateY(-16px) scale(0.6); } 6% { opacity: 1; transform: translateY(0) scale(1.08); }
          9% { transform: translateY(0) scale(1); } 62% { opacity: 1; transform: translateY(0) scale(1); } 72%, 100% { opacity: 0; transform: translateY(0) scale(0.8); } }
        @keyframes aib-ping { 0%, 5% { opacity: 0; transform: scale(0.4); } 7% { opacity: 0.7; } 26% { opacity: 0; transform: scale(2.6); }
          27% { opacity: 0; transform: scale(0.4); } 29% { opacity: 0.5; } 46%, 100% { opacity: 0; transform: scale(2.6); } }
        @keyframes aib-route { 0%, 14% { stroke-dashoffset: 100; opacity: 0.9; } 40% { stroke-dashoffset: 0; opacity: 0.9; }
          62% { stroke-dashoffset: 0; opacity: 0.9; } 72%, 100% { stroke-dashoffset: 0; opacity: 0; } }
        @keyframes aib-drop { 0%, 38% { opacity: 0; transform: scale(0.3); } 43% { opacity: 1; transform: scale(1.2); }
          47% { transform: scale(1); } 62% { opacity: 1; transform: scale(1); } 72%, 100% { opacity: 0; transform: scale(0.8); } }

        @media (prefers-reduced-motion: reduce) {
          .ai-emblem *, .ai-badge-dot, .ai-caret { animation: none !important; }
          .ai-emblem .ai-pulse { display: none; }
          .aib-pan { animation: none; }
          .aib-ride { display: none; }
        }
      `}</style>

      <div className="ai-inner">
        <AiEmblem />
        <span className="ai-badge">
          <span className="ai-badge-dot" />
          {t("ai.badge")}
        </span>
        <h1 className="ai-title">{t("ai.title")}</h1>
        <p className="ai-sub">{t("ai.subtitle")}</p>

        <div className="ai-prompt" aria-label={t("ai.promptLabel")}>
          <IconAi />
          <span className="ai-prompt-text">
            {reduced ? full : full.slice(0, shown)}
            <span className="ai-caret" />
          </span>
          <span className="ai-send" aria-hidden="true">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M5 12h14M13 6l6 6-6 6" />
            </svg>
          </span>
        </div>

        <div className="ai-points">
          <span>{t("ai.point1")}</span>
          <span>{t("ai.point2")}</span>
          <span>{t("ai.point3")}</span>
        </div>
      </div>
    </div>
  );
}
