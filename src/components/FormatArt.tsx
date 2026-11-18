import { cn } from "@/lib/utils";

export type FormatTone = "primary" | "lavender" | "lime" | "butter" | "muted";

const TONE_COLOR: Record<FormatTone, string> = {
  primary: "hsl(var(--primary))",
  lavender: "hsl(var(--accent-foreground))",
  lime: "hsl(var(--success))",
  butter: "hsl(var(--warning))",
  muted: "hsl(var(--muted-foreground))",
};

/**
 * Format poster — a stylized "screen" drawn in the real aspect ratio:
 * dark frame, dashed safe-area inset, play glyph, tone stripe. Used in
 * the /create format picker and the VersionsPanel preset flyout so the
 * aspect is recognisable before reading the label.
 *
 * The screen itself is always dark (a canvas is dark in both themes);
 * only the frame stroke follows the theme border.
 */
export function FormatArt({
  w,
  h,
  tone = "primary",
  safe = true,
  dashed = false,
  height = 56,
  className,
}: {
  w: number;
  h: number;
  tone?: FormatTone;
  /** Draw the platform safe-area inset (chrome eats into the canvas). */
  safe?: boolean;
  /** Dashed frame — for the "custom size" pseudo-format. */
  dashed?: boolean;
  /** Rendered height in px; width follows the real aspect ratio. */
  height?: number;
  className?: string;
}) {
  const W = 160;
  const H = Math.round((W * h) / w);
  const portrait = h > w;
  const cx = W / 2;
  const cy = H / 2;
  const play = Math.min(W, H) * 0.24;
  const safeInset = portrait ? { x: W * 0.06, y: H * 0.09 } : { x: W * 0.05, y: H * 0.08 };
  const stroke = TONE_COLOR[tone];

  return (
    <svg
      width={Math.round((height * W) / H)}
      height={height}
      viewBox={`0 0 ${W} ${H}`}
      className={cn("shrink-0", className)}
      role="img"
      aria-label={`${w}×${h}`}
    >
      <defs>
        <linearGradient id={`fa-bg-${w}x${h}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#26252E" />
          <stop offset="1" stopColor="#15151B" />
        </linearGradient>
      </defs>
      <rect
        width={W}
        height={H}
        rx={Math.min(W, H) * 0.08}
        fill={`url(#fa-bg-${w}x${h})`}
        stroke={dashed ? "hsl(var(--muted-foreground))" : "hsl(var(--border))"}
        strokeWidth={3}
        strokeDasharray={dashed ? "10 7" : undefined}
      />
      {safe && !dashed && (
        <rect
          x={safeInset.x}
          y={safeInset.y}
          width={W - safeInset.x * 2}
          height={H - safeInset.y * 2}
          rx={Math.min(W, H) * 0.05}
          fill="none"
          stroke="#8E8A99"
          strokeOpacity={0.55}
          strokeWidth={1.6}
          strokeDasharray="6 5"
        />
      )}
      {dashed ? (
        // custom-size motif — sliders
        <g stroke="#8E8A99" strokeWidth={4} strokeLinecap="round">
          <line x1={W * 0.28} y1={H * 0.4} x2={W * 0.72} y2={H * 0.4} />
          <line x1={W * 0.28} y1={H * 0.62} x2={W * 0.72} y2={H * 0.62} />
          <circle cx={W * 0.58} cy={H * 0.4} r={5.5} fill="#8E8A99" />
          <circle cx={W * 0.4} cy={H * 0.62} r={5.5} fill="#8E8A99" />
        </g>
      ) : (
        <path
          d={`M ${cx - play * 0.55} ${cy - play * 0.72} L ${cx - play * 0.55} ${cy + play * 0.72} L ${cx + play * 0.75} ${cy} Z`}
          fill="#F4F0E8"
          stroke="#F4F0E8"
          strokeWidth={6}
          strokeLinejoin="round"
        />
      )}
      {portrait && !dashed && (
        // platform chrome hints — top status dots + bottom interaction pill
        <g fill="#8E8A99" opacity={0.5}>
          <circle cx={W * 0.2} cy={H * 0.045} r={2.4} />
          <circle cx={W * 0.28} cy={H * 0.045} r={2.4} />
          <circle cx={W * 0.36} cy={H * 0.045} r={2.4} />
          <rect x={W * 0.3} y={H * 0.945} width={W * 0.4} height={4} rx={2} />
        </g>
      )}
      {!dashed && (
        <rect x={8} y={H - 11} width={W * 0.3} height={4.5} rx={2.2} fill={stroke} />
      )}
    </svg>
  );
}
